tolk 1.4

// ============================================================================
// TON PRIMES — Ratchet.
//
// UPGRADE_PLAN_V5.md §4 B1 / CONCEPT v5 §3.4: `pending`, `flush()`, the DeDust
// leg and the burn, split out of the retired `primes_bank.tolk` into their own
// contract so that CONCEPT.md's central governance claim — **there is no admin
// withdraw path** — is verifiable by reading ONE contract's outbound set.
//
// That is the whole reason this file exists, so the outbound set is stated here
// and is short enough to check by eye:
//
//   1. the DeDust native-vault swap (0xea06185d), destination = the venue
//      address, changeable ONLY by primes_venue_timelock.tolk, and only
//      with BOTH its proposer key and a passed LP vote (D-194) — because a
//      re-pointed vault receives every flush tranche, this is the one route
//      by which anyone other than the protocol could ever steer `pending`;
//   2. the TEP-74 `burn` (0x595f07bc) of every PRIMES amount a
//      `transfer_notification` reports as received — the swap's proceeds leg
//      (§4.3): bought PRIMES are burned, never held, never forwarded. `S` is
//      untouched by burns (§3.3: S is cumulative emission, never decremented);
//   3. nothing else.
//
// ---- The burn ledger (§3.3, §9.1, §11.21) ----
// §3.3 requires the two things that move circulating supply without moving
// `p_f` — vault payouts and burns — to be reported as TWO dashboard numbers
// rather than netted into one, and §9.1 requires every number the UI shows to
// map to a public get-method. Burning was previously a *pass-through*: the
// handler below sent the burn and stored nothing, so "how much has been burned"
// had no get-method anywhere and the dashboard could only have asserted it.
// `getBurnStats` closes that. It counts what THIS contract ordered burned —
// the flush leg of §4.3 and nothing else — which is exactly the number §11.21
// wants kept separate from the vault's payouts.
//
// There is no `withdraw`, no `sweep`, no owner field, and no message any sender
// can send that moves GRAM to an address of the sender's choosing. The `Flush`
// message is permissionless precisely because it cannot be aimed.
//
// ---- What arrives here ----
// `PoolInject` (0xb0000050) from primes_ledger.tolk, on every mint and every
// other credit to `pending` (a lot's clearing share, `donate_floor`,
// `sweep_ops`, the royalty's ratchet half). It carries the pool backing as
// message value and an authoritative (T, S) snapshot as payload. TVM has no synchronous
// cross-contract read, so the floor this contract's guard prices against is a
// PUSHED cache maintained by the ledger, never a pull. `T`/`S` remain
// authoritative on the ledger; `tCache`/`sCache` here are read-only mirrors,
// exposed via `getFloorCache` so the two can be reconciled off-chain and the
// staleness made visible rather than assumed away.
//
// ---- B3: the floor guard (§4.3.1) ----
// `min_out = amount * S / T * (1 + FLOOR_GUARD)`, replacing `primes_bank.tolk`'s
// `storeCoins(1)` — a swap that accepted any fill at any price. See
// `computeMinOut` below for the arithmetic, the widening order, and the
// overflow bound.
//
// When the venue cannot fill at or above `min_out`, the GRAM comes back and
// `pending` is restored unchanged, leaving the protocol in exactly the state it
// was in before the attempt. It comes back by TWO different routes and the
// contract implements both: a POOL refusal (slippage or expiry, the normal
// case) arrives as a non-bounced `payout#474f86cf` handled by `DedustPayout`,
// while a VAULT refusal (too little gas, unrecognised op) bounces and is
// handled by `onBouncedMessage`. This paragraph used to claim the first case
// bounced too; it does not, and the mainnet evidence is at the "A REFUSED DEDUST SWAP DOES NOT BOUNCE" note. A would-be-above-floor flush and a sandwiched one are
// therefore indistinguishable at contract level — which is deliberate, and is
// also precisely why `get_flush_status` below is not optional (§12: without it
// "a dead venue hides behind months of legitimate-looking non-execution", and
// "the venue is gone" vs "the market is above the floor" look identical from
// outside).
// ============================================================================

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

const K_SCALE: int = 1000000000; // fixed-point scale, 1.0 == 1e9

const FLUSH_PCT: int = 200000000;      // 0.2, fixed-point
const FLUSH_COOLDOWN: int = 86400;      // 1 day
const FLUSH_MIN: coins = 5000000000;   // 5 GRAM (owner-set, down from the 50 GRAM Phase 1 input)

// ============================ PHASE A: SETTLED ==============================
// CALIBRATED. `FLOOR_GUARD` is a Phase A output and Phase A has run: it is
// `flush.FLOOR_GUARD` in shared/params.json, and it came out at 0. The value is
// unchanged from the pre-Phase-A placeholder, so it is worth being explicit that
// this is a measured result and not a placeholder that nobody got round to —
// 0 is the *neutral element* of the formula, and the measurement says the
// neutral element is enough.
//
// What sized it: `flush.sandwich_profitability_check` re-measures the sandwich
// attack WITH the guard live. At 0 the guard is `min_out = amount * S / T`,
// i.e. "refuse to buy above the floor" with no premium on top, and that alone
// declines ALL 1317 sandwich attempts as unprofitable: 0 events, 0.00 GRAM of
// attacker PnL. The unguarded control in the same file is the contrast:
// 4883 GRAM of attacker PnL over the same horizon.
//
// RE-MEASURED AFTER D-143 (GAUNTLET.md G40, 2026-09-20), and the re-run is why
// these numbers no longer read as they did. Under venue-depth sizing the guard
// refuses the SIZE far less often, so the fill rate went from 3/1089 (0.3%) to
// **895/1317 (68.0%)** and refusal fell from the 99.4% case to 32.0%. The
// question that mattered was whether 0 survives a guard that now actually
// fills, and it does — with 27x the swap volume through it (31,835 GRAM against
// 20,462), the attacker's net PnL is still exactly 0.00 over 0 events. A
// positive premium would buy margin on events that do not occur and pay for it
// with fills that now do.
//
// SUPERSEDED BY D-190 (2026-09-26): the 0.00 above came from an attacker that
// sized the flush BEFORE its pump and never pumped more than 0.5x the flush.
// A caller-attacker (D-143 lets it pick `amount`) pumps, sizes the tranche to
// the pumped pool, and sells back: 3.0% of swapped GRAM over the base run, as
// burn efficiency lost below the floor — `T`, `S` and `p_f` never move. The
// owner accepted it; a margin here only shrinks it, so 0 stands.
//
// If you change this line, re-run `sim/scripts/run_phase1.py` and change
// `flush.FLOOR_GUARD` with it — the two are cross-checked, and everything
// downstream (computeMinOut, the flush path, get_flush_status) reads this one.
const FLOOR_GUARD: int = 0;            // fixed-point, e.g. 0.01 would be 10000000
// ===========================================================================

// Overflow bound for the guard's fixed-point arithmetic — see computeMinOut.
// TVM integers are 257-bit signed, so products must stay under 2^256.
// 2^120 nano-units is ~1.3e36, roughly 1e27 GRAM / 1e27 PRIMES: unreachable by
// nineteen orders of magnitude against GRAM's ~5e9 total supply, and still
// leaving 2^120 * 2^120 = 2^240 of headroom under the 2^256 ceiling.
const MUL_OPERAND_BOUND: int = 1329227995784915872903807060280344576; // 2^120

// Flush outcome codes for get_flush_status (§9.1 / §12).
const FLUSH_NEVER: int = 0;
const FLUSH_FILLED: int = 1;
const FLUSH_BOUNCED: int = 2;

const DEDUST_SWAP_OP: int = 0xea06185d;
// GAUNTLET V2: how long the swap has to land before DeDust's own pool refuses
// it as stale — `SwapParams.deadline`, a wall-clock cutoff the vault enforces
// on its side, independent of and in addition to `limit` (the floor guard).
// 10 minutes is generous against GRAM's ~5s blocks and mirrors the kind of
// window every DEX aggregator on TON defaults to; there is nothing sim-derived
// about it (it bounds a liveness failure, not an economic quantity).
const DEDUST_SWAP_DEADLINE_WINDOW: int = 600;
// How long an open flush round trip may stay unanswered before `flushIsStale`
// closes it AS FILLED. Six deadline windows: the pool refuses anything past
// `deadline`, so after it only a message already queued can still answer, and
// TON delivers those in seconds. A liveness bound, like the deadline itself —
// nothing economic. NOT scaled by D-139's `clockDivisor`: the thing it waits
// out is DeDust's deadline, which the divisor does not shorten.
//
// It used to reuse D-155's 72 h exit timeout, and that was the lock window: a
// round trip whose fill notification never came (DeDust forwarding no GRAM with
// the payout, or too little for this contract's compute) held 223 and 230 —
// flush, stake AND unstake — shut for three days per 0.26 GRAM flush. Measured on
// testnet 2026-09-24 the forward is ~0.1566 GRAM on every fill (traces
// `1b0646d7…`, `9675a5a1…`, `1848ca88…`, `fe60a0cb…`), so this is a backstop, not
// the normal path.
const FLUSH_STALE_TIMEOUT: int = 3600;       // 1 h = 6x DEDUST_SWAP_DEADLINE_WINDOW

// THE GAS THE VAULT ITSELF NEEDS, ON TOP OF THE SWAP INPUT — and the single
// reason no `flush()` this project has ever sent reached a pool.
//
// MEASURED, 2026-09-17. This function used to build `value: amount` alongside
// `storeCoins(amount)`: the message declared the whole of its own value as the
// swap input, so by the time it arrived the forward fee had already been taken
// out of `value` and DeDust's native vault saw `msg_value < amount`. It throws
// exit 263 on exactly that, aborts, and bounces the GRAM home — where
// `onBouncedMessage` below restores `pending` and stamps `FLUSH_BOUNCED`, which
// is indistinguishable on the dashboard from the floor guard legitimately
// refusing a fill (§4.3.1). So every flush read as "refused above the floor"
// and none of them was: the pool never saw the message.
//
// Isolated on testnet rather than argued from the schema: the same wallet, the
// same vault, the same pool and `limit = 0` — so slippage cannot be the cause —
// sent one swap with `value == amount` and one with `value == amount + 0.25`.
//   value == amount        -> compute exit 263, aborted, bounced
//   value == amount + 0.25 -> compute exit 0, filled
// 0.25 GRAM is what DeDust's own SDK attaches for a native-vault swap.
//
// WHO PAYS IT: THE CALLER (D-146, signed 2026-09-22). The owner's rule is the
// specification: "calling flush from any wallet should not affect the gas and
// fees reserve in any way." Until D-146 this contract's own gas buffer paid it,
// and that was the drain G39/D-146 measured — the cooldown rate-limits GRAM while
// the cost is per CALL, so a one-nanoton tranche burned 0.20 GRAM of buffer for
// ~0.05 GRAM of the caller's value, with no bounce and no cooldown.
//
// So every permissionless leg that pays a venue — `flush`, `stake`, `unstake`,
// `harvest` — asserts `valueCoins >= <its venue gas> + CALLER_COMPUTE_GAS` and
// refuses by name (225) below it, sends the venue's gas out of that value, and
// hands the change back (`returnCallerChange`). The balance above `pending` is
// therefore reserved at exactly what it was before the call, less only the
// amount that leaves `pending` itself: no caller can move it down, whatever
// they attach. The buffer now pays storage rent and nothing else.
//
// This ends "the caller risks only ~0.01 GRAM" (CONCEPT.md §4.3 point 2), and
// that was the point: permissionless still means ANYONE MAY call it, not that
// someone else pays. The keeper attaches it like any other caller.
const DEDUST_SWAP_GAS: int = 250000000;   // 0.25 GRAM
// The caller's share of THIS contract's own compute on a leg, on top of the
// venue's gas. Measured in `contracts/gas-baseline.json`: the four legs run
// 9,472-11,006 gas, ~0.0008 GRAM at basechain config 21; 0.01 is the same
// single-hop guard scale the ledger's `CLAIM_DIVIDEND_MIN_VALUE`/`SWEEP_GAS`
// use. Whatever the compute does not spend goes back with the change.
const CALLER_COMPUTE_GAS: int = 10000000;   // 0.01 GRAM

// A REFUSED DEDUST SWAP DOES NOT BOUNCE. It pays the GRAM back, and this is the
// opcode it pays it back with. Verified against mainnet on 2026-09-16, not
// inferred: trace 0vgUx3EUXuoH3l9kfjvHfxkO8khDq5qw1iTE58hdV5M= is a 50.28 GRAM
// native-vault swap whose `limit` the pool could not meet, and the chain is
//
//   swap#ea06185d      -> native vault   exit 0
//   swap_external#61ee542d -> pool        exit 304 (SLIPPAGE_EXCEEDED), aborted FALSE
//   pay_out_from_pool#ad4eb6f5 -> vault   exit 0
//   payout#474f86cf    -> ORIGINAL SENDER, 50.2759 GRAM, bounce flag FALSE
//
// with `bounced` false on every hop. 6,000 consecutive native-vault
// transactions were scanned: 3,052 inbound `ea06185d`, ALL exit 0, and ZERO
// bounced inbound messages. The structural reason is not a DeDust choice we
// might see reversed: the slippage check runs in the POOL, one hop past the
// vault, the vault's own transaction succeeds, and a TON bounce travels
// exactly one hop — so there is nothing for our `swap` message to bounce from.
//
// This is why `onBouncedMessage` alone was not enough, and why its absence was
// not a cosmetic gap. Without the handler below, a refused flush left
// `inFlightFlush` non-zero forever, which `handleFlush`'s own
// `assert (inFlightFlush == 0) throw 223` then reads as "a round trip is still
// open" — permanently blocking EVERY future flush after the first refusal. And
// refusal is a routine outcome, not an exotic one: 422 of 1317 attempts (32.0%)
// since D-143's venue-depth sizing, and 1086 of 1089 (99.4%) before it, which
// is the figure this comment used to carry. Either way the buyback leg bricked
// itself on its first normal outcome. `tests/RatchetDedustRefund.spec.ts` is
// the regression.
//
// The GRAM was never at risk: `payout` is sent NON-bounceable, so the old
// `assert (in.body.isEmpty()) throw 101` fallback threw AFTER the credit phase
// had already added the refund to this contract's balance. What was lost was
// the accounting — `pending` short, `swapped` inflated, `lastOutcome` stuck on
// FILLED, and `getSolvency`'s liability understated by exactly the stuck
// amount, breaking the one-get-call check §3.4 promises.

// ===========================================================================
// §4.3.2 — THE STAKED RESERVE (D-151)
// ===========================================================================
//
// Idle `pending` above a liquid reserve is deposited into Tonstakers, held as
// tsTON, and counted in `T` AT COST. Three permissionless arms, none of which
// carries an amount: `Stake`, `Unstake`, `Harvest`. The wire format is
// shared/schemas/ratchet.tlb's §4.3.2 block; every opcode is in
// shared/opcodes.ts's RATCHET namespace with upstream file:line provenance.
//
// THE ONE NAMING TRAP, and it is worth two readings. In sim/primes_sim/engine.py
// `pending` is the WHOLE obligation and `liquid` is derived from it. HERE
// `storage.pending` is ONLY the liquid GRAM actually on this contract's balance,
// because `getSolvency().liability` must keep equalling `pending` exactly and
// `balance >= liability` must stay true. So the contract's obligation is
//
//     pending + stakedCost + exiting
//
// and `reserveTarget` is RESERVE_BPS of THAT, not of `pending`.
//
// ---- the economic constants, all from shared/params.json `staked_reserve` ----
// CLAUDE.md rule 3: these are the sim's numbers, cited by key, never re-derived.

// `staked_reserve.reserve_fraction_of_pending` = 0.20 — the LIQUID share of the
// obligation. Its complement `staked_fraction` = 0.80 is what ends up in tsTON.
const RESERVE_BPS: int = 2000;
const BPS_DEN: int = 10000;

// `staked_reserve.stake_min_ton` = 50. NOT a dust guard: every stake costs its
// caller a FLAT ~0.113 GRAM (the 1 GRAM reserve minus the ~0.89 excess that
// comes back, `staked_reserve.deposit_fee_ton`), so the stake size decides
// whether staking earns anything at all — the sim sizes it so flat fees stay
// under a tenth of the yield they buy. It was 500 while the sim charged the
// whole 1 GRAM reserve as a fee (MISTAKES.md 2026-11-23). (A second constraint, that stakes be rare enough for the
// ratchet's own gas accrual to fund the fees, was retired by D-146: the caller
// pays them now.)
//
// Read through `RatchetConfig.stakeMinTon()`, never directly: D-153's
// `stakeDivisor` scales it at deploy time the way `clockDivisor` scales the
// cooldown, and 1 is the identity.
const STAKE_MIN: coins = 50000000000;          // 50 GRAM

// `staked_reserve.harvest_interval_seconds` = 2592000 (30 days). Divided by the
// same D-139 deploy-time clock divisor `FLUSH_COOLDOWN` is, for the same reason:
// a 30-day gate is unreachable inside a testnet run.
const HARVEST_INTERVAL: int = 2592000;

// `staked_reserve.harvest_dust_tston` = 0.01595068119659424 tsTON, floored to
// nano-tsTON. Below this a harvest refuses BY NAME (229) rather than sending a
// jetton transfer that costs more gas than it moves, and an `unstake` tranche
// refuses as 227 for the same reason (2026-11-21, `handleUnstake`). (It read 14756014 — the
// figure before the sim re-derived it from today's gas baseline — until audit
// H2's follow-up; `SimCrossCheck.spec.ts` now binds the two.)
const HARVEST_DUST_TSTON: coins = 15950681;

// `staked_reserve.exit_slippage_bps` = 50 (owner, 2026-09-20). Leg 2's fill may
// land at most this far under `max(lastRate, this tranche's cost basis)`.
const EXIT_SLIPPAGE_BPS: int = 50;

// ---- the counterparty's own fees. NOT OURS, and not sim-derived ------------
// Read from ton-blockchain/liquid-staking-contract @ main, 2026-09-20 (D-151),
// with the file and line on each. They are governor-settable storage upstream,
// so treat the FIGURES as "as at the fetch date" and the OPCODES as fixed.
//
// WHO PAYS THEM: THE CALLER, exactly as DEDUST_SWAP_GAS is paid (D-146). NEVER
// `pending`: a fee taken out of the staked amount would drop `T` by 1 GRAM on
// every stake and `p_f = T/S` with it, which is the ratchet theorem (§5) broken
// by an accounting choice. And no longer the gas buffer either — each arm asserts
// the caller attached its venue's fees and refuses by name (225) if not.

// `pool.func:79`. A GAS RESERVE, not a fee the pool keeps: `:288-289` credits
// `msg_value - DEPOSIT_FEE` and reserves the rest, then mints with
// CARRY_ALL_BALANCE (`pool_mint_helpers.func:19-23`), so the ~0.89 GRAM the mint
// chain does not burn comes back from our tsTON wallet as `excesses` carrying
// the deposit's own query id (measured on mainnet, 2026-11-23: 0.9987 leaves the
// pool, 0.1 notification + 0.887-0.897 excesses arrive). The CALLER fronted it,
// so `handleStakeRefund` sends that excess on to the caller (MISTAKES.md
// 2026-11-23).
const TONSTAKERS_DEPOSIT_FEE: coins = 1000000000;   // 1 GRAM

// NOT GAS. The pool's compute, its `transfer_notification` (0.1 GRAM) and the
// `excesses` are all paid out of TONSTAKERS_DEPOSIT_FEE above. This only has to
// beat the deposit's own forward fee, which SEND_MODE_REGULAR takes off the value:
// the pool credits `value - DEPOSIT_FEE` = X + this − fwd_fee, and that must stay
// AT OR ABOVE the X we book, or every learned pair over-states GRAM per tsTON —
// the side where B37's keep-the-higher rule, the late-mint restore and leg 2's
// floor stop being conservative (GAUNTLET.md B37's adversarial review). The
// forward fee of a 96-bit body is well under 0.001 GRAM; `RatchetStaking.spec.ts`
// pins the direction. What the pool does not spend of it is credited as deposit:
// gas-buffer GRAM, never `pending`, so `stakedCost` does not count it. It was
// 0.3 GRAM, sized when the 1 GRAM was mistaken for a fee, and cost every caller
// 0.3 for nothing (MISTAKES.md 2026-11-23).
const STAKE_CREDIT_MARGIN: coins = 10000000;        // 0.01 GRAM

// The least a stake's own `excesses` can carry (GAUNTLET.md B38). The query id
// alone does not tell the pool's excess from one a stranger provokes: a 1-nano
// tsTON transfer to this contract naming it as `response_destination`, with the
// keeper's public query id, makes OUR wallet send a genuine `excesses` — which
// used to consume the refund row and leave the real ~0.89 GRAM excess with no row
// to match. Half the reserve sits well under the measured 0.887-0.897 and far
// above anything a griefer would pay; an excess below it is ignored and the row
// stays for the real one. Forcing past it costs the griefer more than the caller
// loses, and pays the caller most of it.
const STAKE_REFUND_MIN: coins = 500000000;          // 0.5 GRAM = TONSTAKERS_DEPOSIT_FEE / 2

// The TEP-74 burn leg that IS a withdrawal request needs `msg_value > fwd_fee +
// 2*gas_consumption + burn_notification` with `burn_notification = 0.75 GRAM`
// (`jetton-wallet.func:19`, `:221`), and the pool then gates the withdrawal on
// `WITHDRAWAL_FEE = ONE_TON / 2` (`pool.func:80`, `:189`). 0.8 GRAM clears both
// and is what the caller attaches. A RESERVE, NOT A FEE (measured on mainnet,
// 2026-11-23: a 1.05 GRAM burn gets 1.047 back inside the `withdrawal` payout),
// so `refundExitPrepay` returns its change; `staked_reserve.exit_fee_ton` is
// what an exit actually costs, not this.
const TSTON_EXIT_GAS: coins = 800000000;            // 0.8 GRAM

// Audit M1 (2026-11-19): harvest's transfer MUST forward GRAM, or a TEP-74 wallet
// sends the treasury no `transfer_notification` (`jetton-wallet.func:169`) and its
// `tstonBalance +=` never runs — the tsTON lands uncounted and no proposal can
// spend it. 0.05 GRAM is a gas figure, the same as vesting's `NOTIFY_GAS`
// (`primes_vesting.tolk:115`): it pays only the treasury's tsTON branch, which
// returns before its 0.15 GRAM `TREASURY_MIN_FORWARD` check (gas-baseline
// `treasury.tston_in`).
const HARVEST_FORWARD_TON: coins = 50000000;        // 0.05 GRAM
// The wallet hop plus that forward, ON TOP of the old 0.1 GRAM hop rather than
// carved out of it: the wallet needs `value > forward + 2·fwd_fee +
// 2·gas_consumption + min_tons_for_storage` (`jetton-wallet.func:115-121`;
// `gas_consumption` = 19M + using_libs·7.5M with using_libs = −1, i.e. 0.0115
// GRAM, `jetton_dao/external_params.func:6`; storage 0.01, `:10`), about 0.09
// GRAM with forward fees — 0.15 leaves room for a wallet that does not use libs
// (0.019 each).
const HARVEST_GAS: coins = 150000000;               // 0.15 GRAM

// Leg 2 is a jetton-side DeDust swap, so the vault's 0.25 GRAM rides as
// `forward_ton_amount` inside the transfer instead of as message value — the
// same figure and the same reason as DEDUST_SWAP_GAS above, moved to where a
// jetton transfer carries it (see shared/messages.ts's
// `buildDedustSwapPrimesMessage`, which sends the identical shape for PRIMES).
const DEDUST_JETTON_FORWARD_TON: coins = 250000000; // 0.25 GRAM
const DEDUST_JETTON_SWAP_GAS: coins = 350000000;    // 0.25 forward + 0.1 wallet hop
// D-146: what `unstake`'s caller prepays for the legs a REPLY sends — leg 2's
// swap and leg 3's bill burn — because nobody is there to pay when they fire.
const EXIT_LATER_LEGS_GAS: coins = DEDUST_JETTON_SWAP_GAS + TSTON_EXIT_GAS;  // 1.15 GRAM

// Upstream opcodes, all from shared/opcodes.ts's RATCHET namespace.
const TONSTAKERS_DEPOSIT_OP: int = 0x47d54391;
const TSTON_BURN_OP: int = 0x595f07bc;              // TEP-74 burn; = JettonBurn's prefix
const TEP74_TRANSFER_OP: int = 0x0f8a7ea5;
const DEDUST_SWAP_JETTON_OP: int = 0xe3a0d482;

// The exit state machine's three legs (D-151, "the three legs, in order").
// It advances ACROSS TRANSACTIONS: each leg is refused by a message arriving
// later, and the arrival of that refusal is what sends the next leg. `exitLeg`
// is the whole of the machine's memory.
//
//   EXIT_IDLE -> EXIT_LEG_BURN_FOK   `unstake` burns with fill_or_kill = 1
//     filled  -> tonstakers_withdrawal arrives          -> EXIT_IDLE
//     refused -> transfer_notification (the re-mint)    -> EXIT_LEG_DEDUST
//   EXIT_LEG_DEDUST                  a guarded tsTON -> GRAM swap
//     filled  -> dedust payout arrives                  -> EXIT_IDLE
//     refused -> transfer_notification (the tsTON back) -> EXIT_LEG_BILL
//   EXIT_LEG_BILL                    burn with wait_till_round_end = 1
//     minted  -> payout_ownership_assigned (no action)
//     paid    -> payout_distributed_asset at round end  -> EXIT_IDLE
const EXIT_IDLE: int = 0;
const EXIT_LEG_BURN_FOK: int = 1;
const EXIT_LEG_DEDUST: int = 2;
const EXIT_LEG_BILL: int = 3;

// D-155 — THE STRANDED-EXIT TIMEOUT, and it guards the WHOLE contract rather
// than the staking arms alone. Every transition above is driven by an inbound
// message, so until D-155 the only way out of a non-idle `exitLeg` was a reply
// that may never arrive: a payout sent by an address the guard rejects, a reply
// lost, malformed, or under-gassed in a way that does not bounce. While the
// tranche is outstanding `stake`, `unstake` AND `flush` all refuse (230), and
// `flush()` is what converts `pending` into `swapped` (§4.3.1) — so one lost
// reply bricked the ratchet with no recovery short of a redeploy. It happened on
// testnet on 2026-09-21: a leg 2 payout arrived from an address that was not
// `venue.dedustNativeVault`, the `DedustPayout` arm threw 100, the message was
// non-bounceable so the GRAM was credited while no accounting ran, and the
// machine sat at `exitLeg == 2` forever.
//
// 72 HOURS, and the floor is set by leg 3, not by leg 1 or 2. Leg 3 is a
// Tonstakers `wait_till_round_end = 1` bill that pays at ROUND END — ~36 hours
// (`staked_reserve.leg3_latency_days` = 1.5). A timeout at or under that would
// abort a leg that is merely waiting its turn, which is not a defect but the
// design. 72 h is 2× the round, so the arm can only ever fire on a reply that
// has genuinely stopped coming; it is a liveness backstop, never a competitor to
// the legs. Scaled by the same D-139 `clockDivisor` as `FLUSH_COOLDOWN` and
// `HARVEST_INTERVAL`, so a testnet run reaches it in ~26 minutes at 168.
const EXIT_RECOVERY_TIMEOUT: int = 259200;  // 72 h = 2x leg 3's round

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

// §4.3.2's addresses, in their own ref cell off `Venue` because SEVEN
// addresses is 1,869 bits and a cell holds 1,023. The chain is
// Venue -> VenueStaking -> VenueTreasury, one hop per 801 bits.
//
// D-194: DEPLOY DATA, AND NOTHING WRITES IT AGAIN. `stake()` sends
// `pending - reserve` to `tonstakersPool` in one message, so an address that
// can be re-pointed here is a withdraw path over `pending`. D-151 had routed
// this cell through the venue timelock; `UpdateVenue` now carries the three
// DeDust addresses only and copies `staking` forward unchanged. A Tonstakers
// migration stops staking (every leg fails closed, `pending` stays liquid).
struct VenueTreasury {
    treasuryAddr: address          // the LP-governed treasury — harvest's only destination
    // The NATIVE vault of the factory `dedustTstonPool` lives on: it pays leg 2's
    // GRAM output with `payout#474f86cf`. Its own field, not `Venue.dedustNativeVault`,
    // because `UpdateVenue` re-points that one and leaves the tsTON pool where it is:
    // checked against the flush venue's vault, every leg-2 fill after a venue
    // migration threw 100 and stranded uncounted (2026-11-08 audit). Here and not
    // in `VenueStaking` because that cell is three addresses and a ref already.
    dedustTstonNativeVault: address
}

struct VenueStaking {
    tonstakersPool: address        // deposit#47d54391 goes here
    dedustTstonVault: address      // leg 2's TEP-74 transfer DESTINATION (the jetton vault)
    dedustTstonPool: address       // leg 2's `SwapStep.pool_addr`
    treasury: Cell<VenueTreasury>
}

// THE TWO ADDRESSES AN OPEN FLUSH IS ANSWERED FROM (audit R2-M1, 2026-11-19): the
// native vault that refunds a refusal and the PRIMES vault that pays a fill.
struct FlushTrip {
    dedustNativeVault: address
    primesJettonVault: address
}

struct Venue {
    dedustNativeVault: address
    dedustPool: address
    primesJettonVault: address
    staking: Cell<VenueStaking>
    // A FLUSH IS ANSWERED BY THE VENUE IT WAS SENT TO. Null except from an
    // `UpdateVenue` that landed while a flush was in flight until the next flush
    // is sent: that trip's reply addresses, kept so the OLD vault's refund or
    // fill still settles it. Authenticated against the new venue instead, the
    // refund threw 100 on a non-bounceable message, the GRAM stayed in the gas
    // buffer, and the stale close booked the tranche as filled — and anyone
    // could force it by sending `Flush` and the timelock's permissionless
    // `Execute` back to back. `UpdateVenue` itself is never refused or delayed
    // (a refusal while a flush is open could be held open: a 1-nanoton flush
    // costs no cooldown, and a silent venue holds each one for the full stale
    // window). Read through `flushReplyVenue`, never directly.
    openTrip: Cell<FlushTrip>?
}

// Who may answer the open flush. The pin applies only while that trip is open;
// with nothing in flight it is inert and the current venue is read, exactly as
// before the pin existed.
fun flushReplyVenue(venue: Venue, inFlightFlush: coins): FlushTrip {
    val pinned = venue.openTrip;
    if (pinned != null && inFlightFlush > 0) {
        return pinned.load();
    }
    return FlushTrip {
        dedustNativeVault: venue.dedustNativeVault,
        primesJettonVault: venue.primesJettonVault,
    };
}

struct RatchetConfig {
    ledgerAddr: address
    venueTimelockAddr: address
    genesisScriptAddr: address
    // D-139 — THE TEST CLOCK, the same deploy-time divisor `primes_market.tolk`
    // carries, applied to the one wall-clock constant this contract enforces:
    // `FLUSH_COOLDOWN`. 1 IS MAINNET AND THE IDENTITY; 168 turns the one-day
    // cooldown into ~8.5 minutes so a testnet run can prove both flush branches
    // (fill and refuse) in an afternoon. Deploy-time and unreachable by any
    // message — there is no path that shortens a cooldown already running — and
    // `getFlushStatus` publishes the DIVIDED remaining seconds, so the keeper
    // and the UI read the clock this deploy actually enforces.
    clockDivisor: uint16
    // D-153 — THE SAME IDEA ON THE OTHER AXIS. `clockDivisor` scales the gates
    // this contract enforces in SECONDS; `stakeDivisor` scales the one it
    // enforces in GRAM. 1 IS MAINNET AND THE IDENTITY.
    //
    // WHY IT HAS TO EXIST. `STAKE_MIN` was 500 GRAM (50 since 2026-11-23) and the
    // liquid reserve is 20% of the obligation, so `amount = pending - target =
    // 0.8 * pending > 500` made the first `stake` illegal until `pending`
    // exceeded **625 GRAM** (62.5 now). On
    // mainnet that arrives in the ordinary course of the game. On testnet the
    // only permissionless route into `pending` is `donate_floor`, and §8
    // guarantees no key can ever take that GRAM back — so proving §4.3.2 at a
    // live node cost 600 unrecoverable GRAM per wave, every wave, for a
    // threshold whose economic correctness is a sim output and whose
    // enforcement is already proved in `RatchetStaking.spec.ts`.
    //
    // WHY A DIVISOR AND NOT AN OVERRIDE. The same reason D-139 divides instead
    // of re-declaring: `STAKE_MIN` keeps its declared value, so
    // `SimCrossCheck.spec.ts` still binds `shared/params.json`'s
    // `staked_reserve.stake_min_ton` to the source text and CLAUDE.md rule 3
    // ("never invent an economic parameter") is untouched. A deploy chooses a
    // SCALE; it cannot choose a different economics.
    //
    // WHY IT IS SEPARATE FROM `clockDivisor` rather than reusing it. The two
    // axes are independent: a wave that wants realistic clocks (divisor 1) to
    // watch a real cooldown still needs a reachable stake minimum, and a wave
    // that wants fast clocks may want the real 625 GRAM gate. Folding them would
    // make one choice impossible for no saving — the field is one `uint16` in a
    // cell that already carries three addresses.
    //
    // Deploy-time and unreachable by any message, exactly as `clockDivisor` is:
    // there is no path that lowers a threshold on a running set, so this adds
    // no admin surface (§8). `getStakeMin()` publishes the DIVIDED figure, so a
    // reader checks the gate this deploy actually enforces (§9.1).
    stakeDivisor: uint16
}

// `0` is read as `1`: a config cell written before this field existed runs at
// mainnet speed rather than dividing by zero.
fun RatchetConfig.clockDiv(self): int {
    return self.clockDivisor == 0 ? 1 : self.clockDivisor;
}
// D-153, and `0` is read as `1` for the same reason.
fun RatchetConfig.stakeDiv(self): int {
    return self.stakeDivisor == 0 ? 1 : self.stakeDivisor;
}
// The stake minimum this deploy enforces. At divisor 1 it is STAKE_MIN exactly.
fun RatchetConfig.stakeMinTon(self): int {
    return STAKE_MIN / self.stakeDiv();
}
fun RatchetConfig.flushCooldownSec(self): int {
    return FLUSH_COOLDOWN / self.clockDiv();
}
// §4.3.2's 30-day harvest gate, on the same deploy-time divisor and for the same
// reason: at divisor 1 (mainnet, the identity) it is the full 30 days, and at
// 168 a testnet run can reach a second harvest in ~4.3 hours.
fun RatchetConfig.harvestIntervalSec(self): int {
    return HARVEST_INTERVAL / self.clockDiv();
}
// D-155's stranded-exit timeout, on the same deploy-time divisor and for the
// same reason: a 72-hour backstop is unreachable inside a testnet run, and the
// defect it recovers from is exactly the one a testnet run is there to find.
fun RatchetConfig.exitRecoverySec(self): int {
    return EXIT_RECOVERY_TIMEOUT / self.clockDiv();
}

// The burn ledger, in its own ref cell for two reasons: the inline part of
// Storage is already ~1012 bits of a 1023-bit cell, and these fields are read
// by a get-method far more often than the flush path writes them.
//
// `jettonWalletAddr` is what makes the counter mean something. The burn itself
// deliberately has NO sender check (see the TransferNotification handler), but a
// *counter* without one is a different object: any address could send a forged
// `transfer_notification` and inflate a number the dashboard presents as
// audited. So the wallet address is bootstrapped one-shot by the genesis script
// — the same circular-address resolution the vault uses for its own wallet
// (primes_bounty_vault.tolk D21) — and only a notification from it counts.
// Behaviour is unchanged either way: forged or genuine, the answer is a burn
// order back to the sender; only the tally is discriminating.
struct BurnStats {
    burnedPrimes: coins       // cumulative nano-PRIMES this contract has ordered burned
    burnEvents: uint32        // how many burn orders that took
    jettonWalletAddr: address // this contract's own PRIMES wallet; the only counted sender
    walletSet: uint8          // 0 until the genesis script wires it; counter is idle at 0
    // Who sent the last `flush`. DeDust's unspent swap gas comes home on the fill as two
    // excesses — our PRIMES wallet's, and the jetton master's after the proceeds burn —
    // and both are the caller's change (D-146: the caller pays the venue's gas), so both
    // go back here (2026-11-23). Overwritten by the next flush, never cleared: a stale
    // payee can only receive gas change, which is not a term of `T`.
    flushCaller: address?
    // The payee of the wallet excess that FOLLOWS a fill (GAUNTLET B40). The fill's
    // notification lifts the flush lock one transaction before our wallet's excess
    // lands, so a flush in between used to overwrite `flushCaller` and take the first
    // caller's change. The fill copies `flushCaller` here; the excess pays this and
    // clears it; `handleFlush` never writes it. Our wallet sends the notification and
    // the excess in that order to the same address, so no other excess from it can
    // arrive between them.
    changeTo: address?
}

// §4.3.2's rate, clock, wallet and state machine. Split off `Staking` below for
// the same reason `Venue` splits: seven `coins` is 868 bits at the compiler's
// worst case and adding an address plus two uint64s to them overflows 1023.
//
// WHY THE tsTON WALLET SLOT LIVES HERE AND NOT IN `BurnStats` beside the PRIMES
// one: the two wallets have opposite jobs. `BurnStats.jettonWalletAddr` exists
// so a burn TALLY can discriminate a genuine notification from a forged one —
// the burn itself is unchecked. `tstonWalletAddr` is a DESTINATION this contract
// sends its own withdrawal requests to, and the sender check on it is the branch
// that stops the reserve being burned as fast as it is staked. Keeping them in
// separate cells keeps the reader from assuming the two flags mean the same
// thing, and keeps the burn get-methods off the staking path's cell loads.
struct StakeMeta {
    // The tsTON rate, as the PAIR it was learned as: `lastRateNum` nanotons of
    // deposit minted `lastRateDen` nano-tsTON. GRAM per tsTON is num/den; tsTON
    // per GRAM is den/num. Published unrounded by `getStaking` so a reader checks
    // the ratio rather than a quotient we chose (§9.1).
    lastRateNum: uint64
    lastRateDen: uint64
    lastHarvestTime: uint32
    exitLeg: uint8             // EXIT_IDLE | EXIT_LEG_BURN_FOK | EXIT_LEG_DEDUST | EXIT_LEG_BILL
    // D-155 — when the CURRENT exit left `EXIT_IDLE`, and 0 whenever it is idle.
    // The whole of the timeout's memory: written once by `unstake`, never
    // refreshed by a leg transition (a machine that re-armed its own clock on
    // every hop could be kept alive forever by a counterparty that keeps
    // replying), and cleared wherever `exitLeg` returns to `EXIT_IDLE`.
    exitStartedAt: uint32
    // When the open stake was sent; 0 when no stake was ever stranded and none is
    // open. The stake's own timeout clock: `recover_exit` writes off a stake whose
    // mint notification has not landed inside the same window an exit gets, and
    // KEEPS this stamp, which then times the hold below.
    stakeStartedAt: uint32
    // Cumulative cost `recover_exit` has written off and no arrival has restored
    // yet. ACCUMULATES across write-offs and is never forgotten (audit H2): tsTON
    // that lands later — a late mint, a late non-optimistic bill, a stranger's
    // transfer — restores at most its value at the last learned rate
    // (`creditStakeArrival`) instead of reading as zero-cost yield `harvest()`
    // would pay out, and the next authenticated fill restores it from the value
    // of the tsTON already held at the rate that fill teaches (audit H2 B1).
    writtenOff: coins
    // Audit H2: the part of the OPEN stake (`inFlightStake`, which stays the
    // original X) already matched by tsTON that could not be authenticated as the
    // pool's mint — a non-optimistic bill payout, or a stranger's transfer —
    // valued at the last learned rate. `recover_exit` writes off only
    // `inFlightStake - stakeCredited`. 0 whenever no stake is open.
    stakeCredited: coins
    // Audit H2 nit 3: the tranche `recover_exit` put back into `tstonHeld` when it
    // aborted a leg 1 or leg 2 exit. That leg's own reply (the pool's re-mint, or
    // DeDust's refund) may still land, and it is the SAME tsTON: counting it again
    // would invent tsTON for `harvest()` and, against a write-off, cost for `T`.
    // Cleared when that reply is recognised; 0 otherwise.
    recoveredExit: coins
    tstonWalletAddr: address   // this contract's OWN tsTON wallet; one-shot from genesis
    tstonWalletSet: uint8      // 0 until SetTstonWallet lands; the three arms refuse at 0
    // Who fronted the open stake's 1 GRAM pool reserve, and that stake's query id.
    // A ref: StakeMeta's own cell has no room for a second address.
    stakeRefund: Cell<StakeRefund>
}

// The one `excesses` that is the CALLER's money: from our tsTON wallet, echoing
// the stake's query id, carrying at least STAKE_REFUND_MIN. Written by every
// stake, cleared when paid, and cleared wherever a stake ends without its excess
// (a bounce, a write-off) or unstake starts — the one other arm whose wallet
// excess comes home here: query ids are caller-chosen and the wrappers default
// them to 0, so a stale row must never meet a later arm's excess. NOT cleared by
// harvest (GAUNTLET.md B39): harvest's transfer names its CALLER as
// `response_destination`, so its excess never reaches this contract, and harvest
// can run while a stake is open — clearing there lost that stake's refund.
//
// THE SAME ROW IS THE OPEN EXIT'S (2026-11-23, the withdrawal side of the same
// finding). A stake and an exit are never open together (230 both ways), so while
// `exitLeg != EXIT_IDLE` the row names the `unstake` caller and `held` is the part
// of its prepay no leg has sent yet: EXIT_LATER_LEGS_GAS at the start, less each
// later leg's gas as a reply sends it. Whichever arm ENDS the exit pays it back
// (`refundExitPrepay`), with the answering leg's own change. Nothing pays out while
// an exit is open. Two arrivals can ADD to `held`, each once and under the same B38
// floor: the refused leg 1's wallet excess (`handleStakeRefund`) and leg 3's bill
// `ownership_assigned` (its arm), which is where those legs' change comes home.
struct StakeRefund {
    to: address?
    queryId: uint64
    held: coins                // the exit's unspent prepay; 0 on a stake's row
    changeIn: bool             // the refused leg 1's excess is already in `held`
    billIn: bool               // leg 3's `ownership_assigned` change is already in `held`
}

fun noStakeRefund(): Cell<StakeRefund> {
    return (StakeRefund { to: null, queryId: 0, held: 0, changeIn: false, billIn: false }).toCell();
}

// A leg the exit machine is about to send spends that much of the caller's prepay.
fun spendExitPrepay(mutate meta: StakeMeta, gas: int) {
    var row = meta.stakeRefund.load();
    row.held = (row.held > gas ? row.held - gas : 0) as coins;
    meta.stakeRefund = row.toCell();
}

// THE EXIT'S UNSPENT PREPAY GOES BACK TO WHOEVER FRONTED IT (2026-11-23). Measured
// on mainnet: a Tonstakers burn carrying 1.05 GRAM gets 1.047 back inside the
// `withdrawal` payout, so TSTON_EXIT_GAS is a reserve, not a fee — the deposit
// side's finding again — and until this fix that change, and the never-sent
// EXIT_LATER_LEGS_GAS, stayed in the gas buffer, which nothing spends.
//
// `bonus` is the answering leg's change: the part of its arrival above what was
// credited to `pending`, capped by `exitPayoutChangeCap`, or a bounce's value,
// capped by `exitLegGas`. The caps are load-bearing: a tranche is sized at COST
// and redeems at the pool's rate, so an arrival mixes returned gas with yield, and
// without them this would pay yield to a wallet. A bounce carries no yield, and
// under either cap the caller never gets back more than it attached. Forged arrivals cannot abuse it: the bonus comes out of the
// arrival's own value, so a forger funds it, and an exit ends only on an
// authenticated leg-1 payout, a fully-funded partial close, our own bounce, or
// `recover_exit`. Change that comes home on an unauthenticated path (a refused
// leg's re-mint excess beyond the first, a second `ownership_assigned`, leg 2's
// wallet-hop excess) stays in the buffer.
//
// CALLER_COMPUTE_GAS stays behind: it pays this transaction's compute, so the
// buffer ends no lower than it began (D-146). `room` is the balance above
// `pending`, so this can never pay out backing.
fun refundExitPrepay(mutate meta: StakeMeta, bonus: int, pending: int) {
    val row = meta.stakeRefund.load();
    meta.stakeRefund = noStakeRefund();
    if (row.to == null) { return; }
    var value = row.held + bonus - CALLER_COMPUTE_GAS;
    val room = contract.getOriginalBalance() - pending - CALLER_COMPUTE_GAS;
    if (value > room) { value = room; }
    if (value <= 0) { return; }
    createMessage({
        bounce: BounceMode.NoBounce,
        value: value,
        dest: row.to!,
        body: (Excesses { queryId: row.queryId }).toCell(),
    }).send(SEND_MODE_REGULAR | SEND_MODE_IGNORE_ERRORS);
}

// What a leg's BOUNCE can bring home: the gas we sent with it, and nothing else.
fun exitLegGas(leg: int): int {
    return leg == EXIT_LEG_DEDUST ? DEDUST_JETTON_SWAP_GAS : TSTON_EXIT_GAS;
}

// What a leg's PAYOUT can carry home as change, as opposed to yield. Leg 1: the
// burn's remaining value rides on `withdrawal` (mainnet: 1.047 of 1.05). Leg 2:
// only the vault's forward rides on `payout`; the wallet hop's change comes back as
// an `excesses`. Leg 3: nothing — its change arrived earlier, on the bill's
// `ownership_assigned` (counted there), and the bill pays the pool's round-end
// amount, so a surplus on it is the tranche's yield; refunding it would pay yield
// to a wallet. Each cap is the most yield its leg can leak: the gap between the gas
// attached and the change that really comes back (≈0.003 GRAM on leg 1).
fun exitPayoutChangeCap(leg: int): int {
    if (leg == EXIT_LEG_BURN_FOK) { return TSTON_EXIT_GAS; }
    if (leg == EXIT_LEG_DEDUST) { return DEDUST_JETTON_FORWARD_TON; }
    return 0;
}

struct Staking {
    stakedCost: coins      // GRAM deposited into the pool, AT COST. A term of `T`.
    exiting: coins         // GRAM on its way back out of the pool, at cost. A term of `T`.
    tstonHeld: coins       // nano-tsTON this contract owns, EXCLUDING `inFlightExit`
    inFlightStake: coins   // GRAM awaiting a deposit's mint notification; 0 if none
    inFlightExit: coins    // nano-tsTON inside the exit state machine; 0 if none
    exitCostBasis: coins   // the `exiting` slice this one exit is responsible for
    realizedLoss: coins    // cumulative GRAM that left `T` and did not come back (§5, §8)
    meta: Cell<StakeMeta>
}

struct Storage {
    pending: coins           // GRAM held here, not yet swapped. §5's `T = swapped + pending`.
    swapped: coins           // cumulative GRAM that has left through the venue leg
    inFlightFlush: coins     // awaiting the DeDust round trip; 0 if none
    // Read-only mirrors of the ledger's authoritative T and S, pushed on every
    // PoolInject. Used ONLY to price the floor guard. Never a source of truth.
    tCache: coins
    sCache: coins
    lastFlushTime: uint64     // last SUCCESSFUL-so-far attempt; drives the cooldown
    // §12 flush-status trio, exposed by get_flush_status.
    lastAttemptTime: uint64
    lastAttemptAmount: coins
    lastOutcome: uint8        // FLUSH_NEVER | FLUSH_FILLED | FLUSH_BOUNCED
    lastMinOut: coins         // the guard price the last attempt demanded
    linked: uint8             // one-shot SetLedger done
    cfg: Cell<RatchetConfig>
    venue: Cell<Venue>
    burn: Cell<BurnStats>     // §3.3 / §11.21: the burn half of the two-number report
    staking: Cell<Staking>    // §4.3.2 / D-151: the staked reserve, the fourth and last ref
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

// inbound, from primes_ledger.tolk ONLY
struct (0xb0000050) PoolInject {
    queryId: uint64
    amount: coins
    tSnapshot: coins
    sSnapshot: coins
}

// inbound, PERMISSIONLESS. Cannot be aimed: the destination is the venue.
//
// `amount` is a CEILING THE CALLER MAY LOWER, never one they may raise: the
// handler takes `min(amount, autoSize)` and reads 0 as "size it yourself".
// See `handleFlush`'s VENUE-DEPTH SIZING note for why a caller-chosen size is
// the only way a fixed fraction of `pending` can ever meet a guard priced off
// the pool, and why letting a stranger pick it is safe.
struct (0xb0000006) Flush {
    queryId: uint64
    amount: coins
}

// inbound, from primes_venue_timelock.tolk ONLY — the entire admin surface of
// this contract. It re-points the flush swap destination, never the amount, the
// recipient of the proceeds, the guard, or §4.3.2's staking addresses (D-194).
// The timelock sends it only after 30 days AND a passed LP vote.
struct (0xb0000010) UpdateVenue {
    queryId: uint64
    dedustNativeVault: address
    dedustPool: address
    primesJettonVault: address
}

// inbound, one-shot from the genesis script. Same circular-address problem as
// the ledger's SetPeers/SetSinks: the ledger's own address is not known when
// this contract's init data is built, or vice versa.
struct (0xb0000051) SetLedger {
    queryId: uint64
    ledgerAddr: address
}

// inbound, one-shot from the genesis script. This contract's own PRIMES wallet
// address derives from this contract's address (TEP-74 wallets are addressed by
// owner), so it cannot be embedded in this contract's own address-determining
// data — same circular-address family as SetLedger and the vault's SetWallet.
// It arms `getBurnStats`; it grants no authority and changes no GRAM path.
struct (0xb0000052) SetJettonWallet {
    queryId: uint64
    jettonWalletAddr: address
}

// inbound, TEP-74: the ratchet's own PRIMES jetton wallet notifying it of the
// swap proceeds arriving. Answered with a `burn` of exactly the notified
// amount, back to the notifying wallet.
struct (0x7362d09c) TransferNotification {
    queryId: uint64
    amount: coins
    // `address?`, NOT `address`: Tonstakers mints with `from = addr_none`
    // (`jetton-minter.func:123-131`), which an `address` field refuses to parse.
    sender: address?
    // TEP-74 `forward_payload:(Either Cell ^Cell)`, R20. Parsed as a raw tail and
    // normalised at the read site, NOT as `cell`. A bare `cell` field reads a REF
    // with no discriminator bit, which is not what the standard says and not what
    // any third-party wallet sends: a real TEP-74 wallet writes the Either bit
    // first, so parsing it as `cell` consumes the discriminator as if it were the
    // start of a ref and then underflows (exit 9). This contract is notified by
    // wallets it does not control, so it reads the standard shape.
    forwardPayload: RemainingBitsAndRefs
}

// outbound, TEP-74 burn. One constructor, two destinations: aimed at the PRIMES
// wallet it is §4.3's proceeds burn (`customPayload` null); aimed at the tsTON
// wallet with the payload present it is §4.3.2's withdrawal request.
//
// `customPayload` IS TEP-74's `custom_payload:(Maybe ^Cell)` and it was missing
// here until D-151 P2 — the same defect GAUNTLET V4 fixed on `Transfer` and
// `transfer_notification` in primes_jetton_wallet.tolk (see its header at
// :62-74) and missed on `Burn`, because nothing external ever burned PRIMES.
// Both sides parsed three fields and stopped, so the pair was self-consistent
// and the PRIMES burn worked. §4.3.2 is what makes it bite: the tsTON wallet is
// somebody else's contract, its `load_dict()` underflows on the missing Maybe
// bit, and the burn dies in the ACTION phase.
struct (0x595f07bc) JettonBurn {
    queryId: uint64
    amount: coins
    responseAddr: address
    customPayload: cell?
}

// inbound, from the DeDust native GRAM vault: our own swap's GRAM, handed back
// because the pool could not meet `limit`. See the "A REFUSED DEDUST SWAP DOES NOT BOUNCE" note above for the
// mainnet evidence that this, and not a bounce, is how a refusal arrives.
//
//   payout#474f86cf query_id:uint64 payload:(Maybe ^Cell) = InMsgBody;
//
// `payload` is our own `reject_payload` handed back verbatim (the pool copies
// it into `pay_out_from_pool`, the vault copies it into `payout`). We send
// `reject_payload = none`, so there is nothing of ours to read back, and it is
// consumed as an opaque remainder for the same reason primes_lp_sink.tolk
// consumes its forward payload that way: a `(Maybe ^Cell)` we never branch on
// must not be able to fail to parse and throw, because throwing here is
// precisely the failure this struct exists to fix.
struct (0x474f86cf) DedustPayout {
    queryId: uint64
    payload: RemainingBitsAndRefs
}

// ---- §4.3.2's arms (D-151) -------------------------------------------------

// inbound, PERMISSIONLESS, and — unlike `Flush` above — with no number at all to
// lower. Each leg's size is computed here from `reserveTarget`, so a caller can
// TRIGGER the rule and cannot AIM it. That absence is §11.14's constraint made
// structural rather than asserted.
struct (0xb0000053) Stake {
    queryId: uint64
}

struct (0xb0000054) Unstake {
    queryId: uint64
}

struct (0xb0000055) Harvest {
    queryId: uint64
}

// inbound, PERMISSIONLESS, and with no number either — D-155's liveness
// backstop. It aims nothing and credits nothing: its whole effect is to run
// `abortExit`, which puts the tranche back exactly where `unstake` found it.
struct (0xb0000057) RecoverExit {
    queryId: uint64
}

// inbound, one-shot from the genesis script. Exactly `SetJettonWallet`'s shape
// and exactly its reason: a TEP-74 wallet is addressed by its OWNER, so this
// contract's tsTON wallet cannot sit in this contract's own address-determining
// data. A used-up bootstrap credential, not an admin key.
struct (0xb0000056) SetTstonWallet {
    queryId: uint64
    tstonWalletAddr: address
}

// outbound, to the Tonstakers pool. THE BODY HAS NO AMOUNT — the staked amount
// is the message value, less the pool's flat fee (`interaction.tlb:52`).
struct (0x47d54391) TonstakersDeposit {
    queryId: uint64
}

// inbound, from the Tonstakers pool: an immediate withdrawal that FILLED
// (`op-codes.func:43`). Non-bounceable, CARRY_ALL_BALANCE, and THE BODY CARRIES
// NO AMOUNT — the filled GRAM is the message value, arriving mixed with whatever
// is left of the gas we attached to our own burn. The two are not separable,
// which is why the rate is learned from a DEPOSIT and never from this.
struct (0x0a77535c) TonstakersWithdrawal {
    queryId: uint64
}

// inbound, from a freshly minted payout bill when leg 3's withdrawal could not
// be filled (`payout_nft/nft-item.func:193-197`). ACCEPTED AND IGNORED: the
// outstanding exit is tracked by the `exiting` our own `unstake` credited, not
// by the arrival of an NFT anyone can send us, so a forged one changes no
// number. See `creditExitArrival` for the full unauthenticatable-sender
// argument.
struct (0x05138d91) PayoutOwnershipAssigned {
    queryId: uint64
    prevOwner: any_address
    forwardPayload: RemainingBitsAndRefs
}

// inbound, from the payout collection at round end: the bill's GRAM share
// (`payout_nft/nft-collection.func:262-268`). Non-bounceable, and again no
// amount field — the money IS the message.
struct (0xdb3b8abd) PayoutDistributedAsset {
    queryId: uint64
}

// inbound, from EITHER jetton wallet, after a burn or a transfer whose
// `response_destination` this contract set to itself. Accepted and ignored, the
// way a bare top-up is. It needs an arm at all because the catch-all
// `else => assert (in.body.isEmpty()) throw 101` would otherwise abort it and
// paint the trace red while the money looked right (MISTAKES.md, 2026-09-17).
struct (0xd53276db) Excesses {
    queryId: uint64
}

type AllowedMessage = PoolInject | Flush | UpdateVenue | SetLedger | SetJettonWallet | TransferNotification | DedustPayout
                    | Stake | Unstake | Harvest | RecoverExit | SetTstonWallet | TonstakersWithdrawal
                    | PayoutOwnershipAssigned | PayoutDistributedAsset | Excesses;

// ---------------------------------------------------------------------------
// B3 — the floor guard
// ---------------------------------------------------------------------------

// min_out = amount * S / T * (1 + FLOOR_GUARD)
//
// UNITS (§10 flags this explicitly, and getting it wrong silently misprices the
// guard rather than failing loudly):
//   amount : nanotons                     (GRAM leaving for the venue)
//   T      : nanotons                     (pool backing)
//   S      : nano-PRIMES                  (jetton supply, 9 decimals)
//   T / S  : nanotons per nano-PRIMES     — the floor price p_f
//   amount / p_f = amount * S / T : nano-PRIMES the venue must return
// so the result is in nano-PRIMES, which is what the DeDust swap's `min_out`
// field is denominated in. The two nano-scales cancel; there is no 1e9 factor
// to insert, and inserting one would misprice by a billion.
//
// ORDER AND WIDENING: multiply BEFORE dividing. `amount * S` is computed first
// so the division by `T` happens once, at full precision, on the widened
// product — the naive `(amount / T) * S` truncates to zero for every realistic
// flush (amount << T at any point after genesis) and would set min_out to 0,
// i.e. silently reproduce the `storeCoins(1)` bug this function exists to fix.
// The FLOOR_GUARD premium is applied to the already-divided base for the same
// reason, on a value bounded by the same 2^120 operand bound.
//
// OVERFLOW: TVM integers are 257-bit signed; the largest intermediate is
// `amount * S`. Both operands are asserted below `2^120`, so the product is
// below `2^240` and the premium multiply `base * FLOOR_GUARD` (base < 2^120,
// FLOOR_GUARD < 2^30 for any sane fixed-point fraction) is below `2^150`. Both
// are two orders of binary magnitude clear of 2^256. The asserts are real
// runtime checks, not comments: a state that violates them throws 211 and
// leaves `pending` untouched rather than wrapping and underpricing the guard.
//
// DEGENERATE CASE: before genesis seeding, S = 0 and/or T = 0 and there is no
// floor to defend — min_out is 0 and the swap is unguarded. This is the same
// window in which `pending` is 0 and no flush can pass its own minimum, so it
// is unreachable in practice; it is written explicitly rather than left to
// division-by-zero.
fun computeMinOut(amount: coins, tCache: coins, sCache: coins): coins {
    if (amount <= 0 || tCache <= 0 || sCache <= 0) { return 0; }
    assert (amount < MUL_OPERAND_BOUND) throw 211;  // ratchet_guard_overflow
    assert (sCache < MUL_OPERAND_BOUND) throw 211;  // ratchet_guard_overflow
    val base = amount * sCache / tCache;            // multiply first, divide once
    assert (base < MUL_OPERAND_BOUND) throw 211;    // ratchet_guard_overflow
    return base + base * FLOOR_GUARD / K_SCALE;
}

// ---------------------------------------------------------------------------
// §4.3.2 — the staked reserve's arithmetic and its outbound legs (D-151)
// ---------------------------------------------------------------------------

// THE RESERVE IS A FRACTION OF THE WHOLE OBLIGATION, not of the liquid part.
// `pending` here is only the GRAM physically on this balance (see the header
// note on the sim's opposite convention), so the obligation `flush()` may one
// day have to meet is `pending + stakedCost + exiting` and the reserve is
// RESERVE_BPS of that. Written as a function rather than stored because a
// stored copy would go stale on every `PoolInject` — and a stale reserve is a
// reserve that is wrong exactly when the mint rate is highest.
//
// It is INVARIANT ACROSS A STAKE OR AN EXIT: both only move GRAM between the
// three terms, so the sum, and therefore the target, does not move. That is
// what makes `unstake` sizeable in one step.
fun reserveTargetOf(pending: coins, stk: Staking): int {
    return (pending + stk.stakedCost + stk.exiting) * RESERVE_BPS / BPS_DEN;
}

// The TEP-74 burn that IS a Tonstakers withdrawal request, with the two flags as
// TWO BARE BITS in `custom_payload`, bit 0 `wait_till_round_end` then bit 1
// `fill_or_kill` (`wrappers/JettonWallet.ts:17-19`).
//
// THE PAYLOAD IS MANDATORY AND ITS ABSENCE IS NOT A DEFAULT. The pool reads the
// flags with `load_bool` inside its own try/catch; an absent or short payload
// underflows, the catch fires, and the pool RE-MINTS the jettons
// (`pool.func:190`, `:232-240`). A burn with no payload is a round trip that
// costs the fee and does nothing — which is why `JettonBurn` gained the field.
fun sendTstonWithdraw(walletAddr: address, queryId: int, amount: coins,
                      waitTillRoundEnd: int, fillOrKill: int) {
    createMessage({
        bounce: BounceMode.RichBounce,
        value: TSTON_EXIT_GAS,
        dest: walletAddr,
        body: (JettonBurn {
            queryId: queryId,
            amount: amount,
            responseAddr: contract.getAddress(),
            customPayload: beginCell()
                .storeUint(waitTillRoundEnd, 1)
                .storeUint(fillOrKill, 1)
                .endCell(),
        }).toCell(),
    }).send(SEND_MODE_REGULAR);
}

// A plain TEP-74 transfer out of this contract's own tsTON wallet. Two callers:
// `harvest()` (destination = the governed treasury, no forward payload) and
// leg 2 (destination = DeDust's tsTON jetton vault, carrying the swap).
//
// `forward_payload` is written as the EITHER-REF variant (bit 1 + a ref) for the
// reason shared/messages.ts gives at `buildDedustSwapPrimesMessage`: the vault
// reads it back out of `transfer_notification` as its own cell, and an inline
// payload does not survive that re-serialisation.
fun sendTstonTransfer(walletAddr: address, queryId: int, amount: coins,
                      dest: address, forwardTon: coins, forwardPayload: cell?, value: coins,
                      responseAddr: address) {
    var b = beginCell()
        .storeUint(TEP74_TRANSFER_OP, 32)
        .storeUint(queryId, 64)
        .storeCoins(amount)
        .storeAddress(dest)
        .storeAddress(responseAddr)            // response_destination — who the wallet's change goes to
        .storeUint(0, 1)                       // custom_payload = none
        .storeCoins(forwardTon);
    if (forwardPayload != null) {
        b = b.storeUint(1, 1).storeRef(forwardPayload);
    } else {
        b = b.storeUint(0, 1);                 // Either-left, empty inline
    }
    createMessage({
        bounce: BounceMode.RichBounce,
        value: value,
        dest: walletAddr,
        body: b.endCell(),
    }).send(SEND_MODE_REGULAR);
}

// D-146 — THE CALLER'S CHANGE. Called LAST by each permissionless leg, after
// its venue send. `keep` is the balance this contract must still hold when the
// transaction ends — the pre-call balance, less whatever left `pending` for the
// venue, plus any gas the leg must hold for a later hop — and everything above
// it goes back to the caller as a TEP-74 `excesses`.
//
// That reservation IS the owner's rule written as arithmetic: the balance above
// `pending` ends the call exactly where it began, so no caller can move the gas
// buffer, and attaching too much costs nothing. `getOriginalBalance()` includes
// the caller's value, so the pre-call balance is it minus `valueCoins`.
// AT_MOST, the same shape the retired generator item's transfer used: the
// assert on `valueCoins` has already made the full reservation affordable, and
// IGNORE_ERRORS drops a change too small to pay its own forward fee rather than
// failing the leg — that dust stays in the buffer, the only direction left.
fun returnCallerChange(keep: int, caller: address, queryId: int) {
    reserveToncoinsOnBalance(keep, RESERVE_MODE_AT_MOST);
    createMessage({
        bounce: BounceMode.NoBounce,
        value: 0,
        dest: caller,
        body: (Excesses { queryId: queryId }).toCell(),
    }).send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_IGNORE_ERRORS);
}

// LEG 2 — the guarded tsTON -> GRAM swap on DeDust.
//
//     min_out = amount * max(costBasis, lastRate * (1 - EXIT_SLIPPAGE_BPS))
//
// WHERE THE HAIRCUT GOES IS THE WHOLE DECISION, and putting it in the wrong
// place is a licence to sell the backing under what it cost. Applied to
// `max(lastRate, costBasis)` — which is how this read until the owner corrected
// it — the bound sits 50 bps BELOW cost whenever the two are close, which is
// exactly the window just after a stake, and a fill in that band realizes a
// loss. Applied to `lastRate` alone and then FLOORED at `costBasis`, the 50 bps
// governs only how far under the OBSERVED RATE we will fill, and the floor is
// what we paid.
//
// The owner's sentence is the specification (D-151): "There should be no loss —
// i can tolerate slight devaluation due to direct tsTON to GRAM swap, but it
// should be guarded. If exchange rate is bad — activate manual withdrawal and
// when it lands flush." The second sentence IS leg 3. A book that will not pay
// our cost is "exchange rate is bad", so the right answer is to refuse and fall
// through to the ~36 h bill, which pays at the pool's own exact rate. The 50 bps
// is a tolerance against a thin book, not a haircut we are willing to take.
//
// WHAT IT COSTS: leg 2 refuses more often in the narrow window just after a
// stake, where `lastRate` and `costBasis` are nearly equal — at exactly one
// stake they are equal by construction, since the rate is learned from that
// deposit. Once the pool has appreciated more than 50 bps past our average cost,
// which is most of the life of any position absent slashing, the floor is not
// binding and nothing changes.
//
// `costBasis` is `exitCostBasis`, not `stakedCost / tstonHeld` recomputed here:
// `unstake` booked it as `tstonAmount * stakedCost / tstonHeld`, which is
// `amount * costBasis` for this tranche, at the ratio that stood when the
// tranche left. Reading it back is both cheaper and exactly right.
//
// UNITS: `inFlightExit` is nano-tsTON; `lastRateNum / lastRateDen` is nanotons
// per nano-tsTON; `exitCostBasis` is the nanotons this tranche cost. Both
// candidates are therefore nanotons, which is what `limit` is denominated in on
// a jetton -> native swap. Multiply before dividing, same rule and the same
// 2^120 operand bound as `computeMinOut`.
fun sendExitDedustSwap(stk: Staking, meta: StakeMeta, vs: VenueStaking, queryId: int) {
    assert (stk.inFlightExit < MUL_OPERAND_BOUND) throw 211;  // ratchet_guard_overflow
    assert (meta.lastRateNum < MUL_OPERAND_BOUND) throw 211;  // ratchet_guard_overflow
    val rateFloor = stk.inFlightExit * meta.lastRateNum / meta.lastRateDen
                    * (BPS_DEN - EXIT_SLIPPAGE_BPS) / BPS_DEN;
    var minOut = stk.exitCostBasis;
    if (rateFloor > minOut) { minOut = rateFloor; }

    val payload = beginCell()
        .storeUint(DEDUST_SWAP_JETTON_OP, 32)
        .storeAddress(vs.dedustTstonPool)   // SwapStep: pool_addr
        .storeUint(0, 1)                    // SwapStepParams: kind = given_in$0
        .storeCoins(minOut)                 // SwapStepParams: limit
        .storeUint(0, 1)                    // SwapStepParams: next = none (single hop)
        .storeRef(
            beginCell()
                .storeUint(blockchain.now() + DEDUST_SWAP_DEADLINE_WINDOW, 32) // deadline
                .storeAddress(contract.getAddress())                           // recipient_addr
                .storeUint(0, 2)                                               // referral_addr = none
                .storeUint(0, 1)                                               // fulfill_payload = none
                .storeUint(0, 1)                                               // reject_payload = none
                .endCell()
        )
        .endCell();

    sendTstonTransfer(meta.tstonWalletAddr, queryId, stk.inFlightExit,
                      vs.dedustTstonVault, DEDUST_JETTON_FORWARD_TON, payload,
                      DEDUST_JETTON_SWAP_GAS, contract.getAddress());
}

// THE EXIT'S ARRIVAL, whichever leg paid it, and the one place `exiting` is
// drawn back down into `pending`.
//
// WHY THE CREDIT IS CAPPED AT `exitCostBasis` AND THE SURPLUS IS NOT BACKING.
// Every one of the three legs pays non-bounceably with the GRAM mixed into the
// message value — leg 1 arrives CARRY_ALL_BALANCE on top of our own leftover
// gas, and legs 2 and 3 the same. So the value is a payout PLUS change and the
// two are not separable at arrival. Crediting the whole of it would put returned
// gas into `pending`, and `pending` is a term of the ledger's `T`, which this
// contract cannot move: the identity would break by exactly the change. The cap
// keeps every credit matched by an equal debit of `exiting`, and the surplus
// (returned gas, and any rate gain above cost) stays off `T`: when the arrival
// ends the exit, up to the answering leg's attached gas of it goes back to the
// `unstake` caller (`refundExitPrepay`, 2026-11-23) and the rest stays where
// unattributable GRAM always stays here — the gas buffer, not a term of `T`.
//
// THE SHORTFALL, when there is one, is the realized loss and it leaves `T`
// overstated by exactly that much. It is recorded rather than hidden:
// `realizedLoss` is published by `getStaking()` beside `stakedCost` and never
// netted into it, the same separation `getBurnStats` draws. §5's one external
// risk and §8's "one counterparty, valued at cost, loss published" are this
// number.
//
// AND NO PATH THIS CONTRACT CHOOSES CAN MAKE IT NON-ZERO. Leg 2 is the only leg
// where the ratchet names a price, and since the owner's correction its
// `min_out` is FLOORED AT COST (`sendExitDedustSwap`): a book that will not pay
// what the tranche cost is refused and the exit falls through to leg 3. Legs 1
// and 3 redeem at the pool's own exact rate and name no price at all, so the
// only way a shortfall can arrive is the pool itself paying under our cost —
// i.e. a slashing event, which is §5's one external risk to the ratchet theorem
// and precisely what this number exists to publish rather than absorb.
//
// So the term is DEFENCE IN DEPTH and not a live path: it is here so that a
// future change to leg 2's bound cannot silently break the identity, and so an
// external loss has somewhere honest to land. A reader who finds it non-zero is
// looking at the counterparty, not at a decision made here.
//
// TWO MODES, and which one a caller gets is decided by whether its sender can
// be authenticated.
//
//   `partial == false` — LEG 1 only. `withdrawal#0a77535c` comes straight from
//   the Tonstakers pool, whose address the venue names, so the arm checks it and
//   the arrival is known to be the exit's whole answer: a shortfall is real and
//   is booked as `realizedLoss` here, in the one place it can be. It cannot be
//   provoked by someone else's burn either: the pool pays the burning wallet's
//   owner (`from_address`), never the burn's `response_address` (see the
//   `TonstakersWithdrawal` arm).
//
//   `partial == true` — LEGS 2 AND 3, whose arrival cannot be told from a
//   forgery. Leg 3's `payout_distributed_asset` comes from a bill collection
//   whose address is SALTED with `random()` at deploy
//   (`address_calculations.func:67-68`) and so cannot be whitelisted without a
//   new admin surface. Leg 2's `payout#474f86cf` does come from the native vault
//   we check — but ANYONE can make that vault pay us, by swapping jetton -> GRAM
//   with `recipient_addr` = this contract. So these arrivals are made SAFE UNDER
//   FORGERY instead: each credits `c = min(value, exitCostBasis)` to `pending`
//   and draws `exiting` and `exitCostBasis` down by the SAME `c` — both terms of
//   `T`, and the GRAM backing `c` is on this balance because it is the message
//   value itself. The exit closes only when `exitCostBasis` reaches 0. A forged
//   arrival is therefore a donation that costs the forger exactly what it
//   credits, and the genuine payout that follows closes the residual, its
//   surplus joining the gas buffer. `inFlightExit` is NOT touched: the tsTON is
//   still the tranche a refusal notification will return, and leg 3's pay-out
//   at the pool's round-end rate covers any residual basis. When it does NOT —
//   a bill that pays under cost, i.e. the pool's rate fell — the residual can
//   never be paid and the exit stays open until `recover_exit` writes it off as
//   `realizedLoss` (D-197). Leg 3 does not hold `flush()` shut meanwhile.
//
// (Until 2026-09-26 this function closed the exit on ANY arrival and booked
// `exitCostBasis - value` as loss, while this comment claimed the same-figure
// arithmetic above. A 0.02 GRAM forged `payout_distributed_asset` closed a whole
// tranche and stranded its GRAM in the gas buffer.)
fun creditExitArrival(valueCoins: int, partial: bool) {
    var storage = lazy Storage.load();
    var stk = storage.staking.load();
    if (stk.inFlightExit == 0 && stk.exitCostBasis == 0) {
        // Nothing outstanding: the GRAM has already been credited to the balance
        // by the time compute runs, and throwing would abort while keeping it —
        // the exact half-state the DedustPayout handler exists to prevent.
        // Unattributable GRAM stays as this account's gas buffer.
        return;
    }
    var meta = stk.meta.load();
    var credited = valueCoins;
    if (credited > stk.exitCostBasis) { credited = stk.exitCostBasis; }
    storage.pending += credited;
    if (partial) {
        stk.exiting -= credited;
        stk.exitCostBasis -= credited;
        if (stk.exitCostBasis > 0) {
            storage.staking = stk.toCell();
            storage.save();
            return;
        }
    } else {
        stk.realizedLoss += stk.exitCostBasis - credited;
        stk.exiting -= stk.exitCostBasis;
        stk.exitCostBasis = 0;
    }
    // The exit is over: the answering leg's change, up to its own gas, plus every
    // later leg's gas it never needed, back to the caller.
    var change = valueCoins - credited;
    val cap = exitPayoutChangeCap(meta.exitLeg);
    if (change > cap) { change = cap; }
    refundExitPrepay(mutate meta, change, storage.pending);
    stk.inFlightExit = 0;
    meta.exitLeg = EXIT_IDLE as uint8;
    meta.exitStartedAt = 0;        // D-155: the timeout's clock is per-exit
    stk.meta = meta.toCell();
    storage.staking = stk.toCell();
    storage.save();
}

// The exit gave up: put the tranche back exactly where `unstake` found it. Used
// by the bounce arms and by a leg 3 the pool re-minted, which is the one outcome
// `wait_till_round_end = 1, fill_or_kill = 0` is not supposed to produce.
// `bounced` is the value a bounce brought home (0 elsewhere); up to the refused
// leg's gas it is the caller's change, refunded with the unspent prepay.
fun abortExit(storage: Storage, stk: Staking, meta: StakeMeta, bounced: int) {
    var s = storage;
    var k = stk;
    var m = meta;
    var change = bounced;
    val legGas = exitLegGas(m.exitLeg);
    if (change > legGas) { change = legGas; }
    refundExitPrepay(mutate m, change, s.pending);
    k.tstonHeld += k.inFlightExit;
    k.stakedCost += k.exitCostBasis;
    k.exiting -= k.exitCostBasis;
    k.inFlightExit = 0;
    k.exitCostBasis = 0;
    m.exitLeg = EXIT_IDLE as uint8;
    m.exitStartedAt = 0;           // D-155
    k.meta = m.toCell();
    s.staking = k.toCell();
    s.save();
}

// THE tsTON WALLET'S NOTIFICATION — the deposit's mint, and every refusal the
// exit machine advances on. It must NEVER fall through to §4.3's burn-back arm:
// burning tsTON without the withdrawal payload is the round trip above, and
// burning it with one is a withdrawal nobody asked for. A handler that forgets
// this branch burns the reserve as fast as it is staked.
//
// THE WALLET IS NOT THE AUTHENTICATION — `from` IS. The arm's sender check only
// proves the notification came from OUR tsTON wallet, and anyone holding tsTON
// makes our wallet send one by transferring us a single nano-tsTON. Until
// 2026-09-26 that was enough: landing while a stake was in flight it was read as
// the mint and set `lastRateDen = 1`, so `harvest()` counted the whole reserve
// as yield and sent it to the treasury; landing mid-exit it was read as a leg's
// refusal and started the next leg on tsTON the current one was still spending.
// A `query_id` nonce would not have helped — ours is public in the outbound
// message blocks before the reply lands, and a forger writes his own.
//
// TEP-74's `from` is what a trusted hop vouches for. Our wallet copies it from
// the `internal_transfer` it accepted (`jetton-wallet.func:157, 172-177`), and
// it accepts one only from the master or from `from`'s own wallet
// (`:159-163`). Tonstakers' minter writes `addr_none` on every mint and every
// re-mint (`jetton-minter.func:123-131`), and no wallet is owned by `addr_none`,
// so `from == null` means THE POOL MINTED THIS and nobody else can say it.
// Leg 2's refund comes home from DeDust's tsTON vault, so there `from` is that
// vault. A refusal must also return the WHOLE tranche. Anything else — any
// stranger's transfer, whatever it is timed against — falls to
// `creditStakeArrival` at the bottom, which never learns a rate and never
// closes a round trip.
//
// AND `from == null` IS ONLY THE OPTIMISTIC FILL (audit H2, 2026-11-19). With
// Tonstakers' optimistic deposits off (`pool.func:291-301`, governor-settable)
// our own deposit becomes a payout bill, and its tsTON arrives at round end as
// a jetton TRANSFER from the bill collection's wallet
// (`payout_nft/nft-collection.func:239-258`): `from` is that collection, whose
// address is salted (`address_calculations.func:65-68`) and shared by the whole
// round. Nothing authenticates it. Until this fix it fell to a zero-cost
// donation branch, `recover_exit` wrote the stake off, and the next `harvest()`
// sent the whole fill — tsTON still backing `T` — to the treasury.
fun handleTstonNotification(amount: coins, queryId: int, from: address?) {
    var storage = lazy Storage.load();
    var stk = storage.staking.load();
    var meta = stk.meta.load();
    val minted = from == null;

    // (A late `from == null` mint after `recover_exit` used to be matched here,
    // restoring the WHOLE `writtenOff` and learning `writtenOff / amount` as the
    // rate. Deleted with audit H2: `writtenOff` now accumulates across
    // write-offs, so one late mint would restore all of them at a rate too high
    // for `harvest()` to be safe. It falls through to `creditStakeArrival`.)

    if (stk.inFlightStake > 0 && minted) {
        // A DEPOSIT FILLED, and this is the ONLY place the tsTON rate is ever
        // learned (D-151: the finding that deleted the probe-burn design). Both
        // sides are known exactly here — the GRAM we chose to stake and the tsTON
        // the pool minted — where a withdrawal's body carries no amount at all.
        //
        // `lastRateNum` is `inFlightStake`, i.e. the amount charged to
        // `stakedCost`, and NOT the message value: the pool credits
        // `value - DEPOSIT_FEE`, which includes what STAKE_CREDIT_MARGIN leaves,
        // so `amount` is minted against slightly more GRAM than we counted. That
        // makes the learned tsTON-per-GRAM slightly HIGH, and every use of it is
        // conservative in that direction: `harvest()` computes LESS accrued
        // yield and leg 2 demands a marginally lower floor, inside a band of
        // STAKE_CREDIT_MARGIN/STAKE_MIN — 2 bps at the minimum stake, against a
        // 50 bps tolerance. The alternative would be pretending to know a
        // forward fee the contract cannot read.
        //
        // `lastRateNum` is the ORIGINAL X even when unauthenticated tsTON was
        // credited against it first (`stakeCredited`): this mint covers X whole.
        //
        // AUDIT H2 B1 — THE WRITE-OFF IS RESTORED HERE, BEFORE ANY HARVEST CAN SEE
        // IT. Everything held BEFORE this fill (the position, a credited
        // non-optimistic fill valued at a stale or seed rate, a bill that landed
        // while this stake was open) is now valued at the rate this fill
        // authenticates. Whatever that value exceeds the cost it carries is, up to
        // `writtenOff`, cost we wrote off on tsTON we still hold: it goes back
        // into `stakedCost` and out of `realizedLoss`. Without this, `harvest()`
        // at the new rate reads that tsTON as yield and sends it to the treasury.
        // The fill itself is excluded from both sides: `pre` is read before it is
        // added, and its cost X is taken off `stakedCost`. Direction: X nanotons
        // bought `amount` nano-tsTON, so GRAM per tsTON is X / amount.
        val pre = stk.tstonHeld;
        val preCost = stk.stakedCost - stk.inFlightStake;
        if (meta.writtenOff > 0 && amount > 0) {
            var restore = pre * stk.inFlightStake / amount - preCost;
            if (restore > meta.writtenOff) { restore = meta.writtenOff; }
            if (restore > 0) {
                stk.stakedCost += restore;
                stk.realizedLoss -= restore;
                meta.writtenOff -= restore;
            }
        }
        stk.tstonHeld += amount;
        // B37 — KEEP THE HIGHER GRAM-PER-tsTON, never just the latest. Every learned
        // pair under-states it (the pool minted against X + what STAKE_CREDIT_MARGIN
        // leaves, the pair books X), by that over X: a SMALL stake under-states it most. And
        // `harvest()` values ALL of `stakedCost` at the one pair, so a small stake
        // after a large one dragged the rate down, priced the earlier tranches'
        // gas surplus out, and read accrued < 0 on real yield (20261121 testnet:
        // −0.18 tsTON, 229 on a 0.02 yield). The max of two under-estimates is
        // still an under-estimate — tsTON only appreciates, the same assumption
        // `harvest()` states below — so every reader stays conservative; under a
        // constant pool rate accrued is now ≥ 0. The 1/1 seed is no estimate at
        // all and is always replaced. uint64 × uint64 fits in 257 bits.
        if (rateIsSeed(meta) || stk.inFlightStake * meta.lastRateDen > meta.lastRateNum * amount) {
            meta.lastRateNum = stk.inFlightStake as uint64;
            meta.lastRateDen = amount as uint64;
        }
        stk.inFlightStake = 0;
        meta.stakeCredited = 0;
        meta.stakeStartedAt = 0;
        stk.meta = meta.toCell();
        storage.staking = stk.toCell();
        storage.save();
        return;
    }

    if (stk.inFlightExit > 0 && amount == stk.inFlightExit) {
        // The venue cell is read only here: a bill payout carries 0.01 GRAM of
        // gas (`nft-collection.func:19`), and the path it takes must not pay for
        // a load it does not use.
        val vs = storage.venue.load().staking.load();
        val fromDedust = from != null && from == vs.dedustTstonVault;
        if (meta.exitLeg == EXIT_LEG_BURN_FOK && minted) {
            // Leg 1 was refused: the pool could not fill out of its free GRAM and
            // `fill_or_kill = 1` told it to re-mint rather than queue. Nothing
            // was sold, so the tranche is untouched and the machine moves to the
            // guarded swap. `tstonHeld` is deliberately NOT credited — the
            // re-minted tsTON is still the tranche `inFlightExit` is tracking.
            //
            // AUDIT H2 B1(b): NOT WHILE THE RATE IS THE SEED. Leg 2's floor is
            // `max(costBasis, lastRate·(1 − 50 bps))`; on the 1/1 seed both can sit
            // well under the pool's real rate (a non-optimistic stake is credited at
            // the seed), and a swap that fills there gives the gap to the book. With
            // no learned rate, go straight to leg 3 — the pool's own exact-rate
            // bill. The gas leg 2 would have spent stays in the buffer.
            if (rateIsSeed(meta)) {
                meta.exitLeg = EXIT_LEG_BILL as uint8;
                spendExitPrepay(mutate meta, TSTON_EXIT_GAS);
                stk.meta = meta.toCell();
                storage.staking = stk.toCell();
                storage.save();
                sendTstonWithdraw(meta.tstonWalletAddr, queryId, stk.inFlightExit, 1, 0);
                return;
            }
            meta.exitLeg = EXIT_LEG_DEDUST as uint8;
            spendExitPrepay(mutate meta, DEDUST_JETTON_SWAP_GAS);
            stk.meta = meta.toCell();
            storage.staking = stk.toCell();
            storage.save();
            sendExitDedustSwap(stk, meta, vs, queryId);
            return;
        }
        if (meta.exitLeg == EXIT_LEG_DEDUST && fromDedust) {
            // Leg 2 was refused — the pool could not meet `limit`, so it paid the
            // INPUT back, which on a jetton side is this very notification. Fall
            // to leg 3: the pessimistic bill, at the pool's own exact rate,
            // ~36 h. Waiting is precisely the right answer to a quote that could
            // not clear our cost basis.
            meta.exitLeg = EXIT_LEG_BILL as uint8;
            spendExitPrepay(mutate meta, TSTON_EXIT_GAS);
            stk.meta = meta.toCell();
            storage.staking = stk.toCell();
            storage.save();
            sendTstonWithdraw(meta.tstonWalletAddr, queryId, stk.inFlightExit, 1, 0);
            return;
        }
        if (meta.exitLeg == EXIT_LEG_BILL && minted) {
            // Leg 3 re-minted. `wait_till_round_end = 1, fill_or_kill = 0` still
            // re-mints when the pool is halted or its round-end solvency check
            // fails (`pool.func:193`, `:230-231`). There is no fourth leg, so the
            // tranche goes back where it came from and `unstake` is callable
            // again.
            abortExit(storage, stk, meta, 0);
            return;
        }
    }

    if (meta.recoveredExit > 0 && amount == meta.recoveredExit && stk.inFlightExit == 0) {
        // AUDIT H2 nit 3: the late reply of an exit `recover_exit` aborted. Only the
        // two senders that answer a leg are recognised — the pool's re-mint
        // (`from == null`) and DeDust's refund — so a stranger's equal transfer
        // still counts. The tranche is already in `tstonHeld`; this is that tsTON,
        // not more of it.
        var answers = minted;
        if (!answers) {
            val vs = storage.venue.load().staking.load();
            answers = from != null && from == vs.dedustTstonVault;
        }
        if (answers) {
            meta.recoveredExit = 0;
            stk.meta = meta.toCell();
            storage.staking = stk.toCell();
            storage.save();
            return;
        }
    }

    creditStakeArrival(storage, stk, meta, amount);
}

// AUDIT H2 B1(b): the 1/1 pair the wrapper seeds at deploy, before any
// authenticated fill. No fill can write it back: a learned pair is (X, amount)
// with X above the stake minimum (at least 50 GRAM / 65535 = 0.76 million nanotons).
fun rateIsSeed(meta: StakeMeta): bool {
    return meta.lastRateNum == 1 && meta.lastRateDen == 1;
}

// AUDIT H2 — tsTON that is not the authenticated answer to our own round trip:
// a non-optimistic bill payout (our own stake's fill, or a write-off's late
// one), a late mint, or a stranger's transfer. It cannot be told apart, so it
// is VALUED, never trusted: at the last learned rate `r`, credited first
// against the open stake (`stakeCredited`; the cost is already in `stakedCost`)
// and the remainder against a past write-off, which it restores. With neither
// open it is a plain zero-cost donation, as before.
//
// WHY THIS IS SAFE UNDER FORGERY. A credit of `c` needs `c / r` tsTON to land
// in `tstonHeld` beside it, so a stranger restores cost only by donating tsTON
// worth that cost at `r` — and `r` is learned ONLY from an authenticated fill
// (above), so no arrival here can raise it. It never closes the stake and never
// teaches the rate: closing on dust would let `unstake` load cost X onto the
// dust and the real fill arrive at zero cost (`costPortion`, `handleUnstake`).
//
// WHY THE REMAINDER SPILLS. A write-off's bill can land while a LATER stake is
// open (the round stalled past the two-window hold). Credited against the open
// stake alone, the surplus would sit at zero cost and `harvest()` would send it.
//
// NEVER THROWS: it runs on a non-bounceable notification whose tsTON is
// credited to the wallet whatever happens here (MISTAKES.md 2026-09-17).
// `amount` is a `coins` (< 2^120) and `lastRateNum` a uint64, so the product
// fits in 257 bits with no guard; a zero `lastRateDen` (no deploy writes one)
// values the arrival at 0 rather than throwing.
fun creditStakeArrival(storage: Storage, stk: Staking, meta: StakeMeta, amount: int) {
    var s = storage;
    var k = stk;
    var m = meta;
    var c = 0;
    if (m.lastRateDen != 0) { c = amount * m.lastRateNum / m.lastRateDen; }
    if (k.inFlightStake > 0) {
        var toStake = k.inFlightStake - m.stakeCredited;
        if (toStake > c) { toStake = c; }
        m.stakeCredited += toStake;
        c -= toStake;
    }
    if (c > m.writtenOff) { c = m.writtenOff; }
    k.stakedCost += c;
    k.realizedLoss -= c;
    m.writtenOff -= c;
    k.tstonHeld += amount;
    k.meta = m.toCell();
    s.staking = k.toCell();
    s.save();
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

fun onInternalMessage(in: InMessage) {
    val msg = lazy AllowedMessage.fromSlice(in.body);

    match (msg) {
        PoolInject => {
            var storage = lazy Storage.load();
            val cfg = storage.cfg.load();
            assert (storage.linked == 1) throw 101;                  // wrong_opcode (no ledger configured)
            assert (in.senderAddress == cfg.ledgerAddr) throw 100;   // wrong_sender
            // Credit the NOMINAL amount only. The message deliberately carries
            // `amount + RATCHET_HOP_GAS`; the surplus stays as this contract's
            // own gas buffer and is NOT counted as pool backing, so
            // getSolvency's delta stays non-negative by construction.
            assert (in.valueCoins >= msg.amount) throw 103;          // insufficient_value
            storage.pending += msg.amount;
            storage.tCache = msg.tSnapshot;
            storage.sCache = msg.sSnapshot;
            storage.save();
        }

        Flush => {
            handleFlush(msg, in.valueCoins, in.senderAddress);
        }

        UpdateVenue => {
            var storage = lazy Storage.load();
            val cfg = storage.cfg.load();
            assert (in.senderAddress == cfg.venueTimelockAddr) throw 800; // timelock_not_proposer
            val old = storage.venue.load();
            // Audit R2-M1: a flush in flight keeps the venue it was sent to (see
            // `Venue.openTrip`). A trip already pinned by an earlier change keeps
            // THAT pin — `old` is not where it went.
            var openTrip: Cell<FlushTrip>? = null;
            if (storage.inFlightFlush > 0) {
                openTrip = old.openTrip != null ? old.openTrip : (FlushTrip {
                    dedustNativeVault: old.dedustNativeVault,
                    primesJettonVault: old.primesJettonVault,
                }).toCell();
            }
            storage.venue = (Venue {
                dedustNativeVault: msg.dedustNativeVault,
                dedustPool: msg.dedustPool,
                primesJettonVault: msg.primesJettonVault,
                // D-194: copied forward, never taken from the message — §4.3.2's
                // staking addresses are deploy data.
                staking: old.staking,
                openTrip: openTrip,
            }).toCell();
            storage.save();
        }

        TransferNotification => {
            // §4.3.2 FIRST, and the branch is the whole of the safety here: this
            // message now arrives from TWO wallets, and the tsTON one must never
            // reach the burn-back below. See `handleTstonNotification`.
            val metaPeek = lazy Storage.load().staking.load().meta.load();
            if (metaPeek.tstonWalletSet == 1 && in.senderAddress == metaPeek.tstonWalletAddr) {
                handleTstonNotification(msg.amount, msg.queryId, msg.sender);
                return;
            }

            // §4.3's proceeds leg: burn what just arrived. DELIBERATELY no
            // sender check — this contract cannot know its own jetton-wallet
            // address without another bootstrap hop, and it does not need to:
            // burning is the ONLY thing it ever does with jettons, so the
            // worst a forged notification can do is ask us to send a burn
            // order to the forger's own contract for tokens the forger says
            // we own there — which burns the forger's tokens or bounces off a
            // non-wallet, and moves no GRAM either way (the burn rides the
            // notification's own attached gas, never this contract's balance,
            // which is pool backing). `S` is untouched: it is cumulative
            // emission on the ledger and never decremented (§3.3).
            //
            // The TALLY, unlike the burn, is discriminating: only a
            // notification from this contract's own wallet counts, so a forger
            // can still make us send a burn order for tokens it claims we own
            // (harmless, as above) but cannot move a number the dashboard
            // publishes as measured. Until the genesis script wires the wallet
            // (`walletSet == 0`) nothing is counted — an under-count, which is
            // the same conservative direction §3.3 takes everywhere else, and
            // it is visible in `getBurnStats`'s third return value rather than
            // silently indistinguishable from "no burns yet".
            var storage = lazy Storage.load();
            var burn = storage.burn.load();
            // The burn's change: the flush caller's on swap proceeds (see
            // `BurnStats.flushCaller`), this contract's on anything else.
            var respondTo = contract.getAddress();
            // GAUNTLET B2.1: this is also the FILL signal `handleFlush`'s own comment says
            // does not exist — a notification from the wallet arrives only because the swap
            // that emptied `inFlightFlush` really landed. Gated on the SAME authentication
            // the burn tally above already requires, and for the same reason: an
            // unauthenticated notification must not be able to clear it, or a forger could
            // flip a still-open round trip to "closed" ahead of the real fill — the opposite
            // failure from the one being fixed. Before the genesis script wires the wallet
            // (`walletSet == 0`) this simply never fires, same as the tally's own under-count
            // until then.
            //
            // The wallet check authenticates the WALLET, not the swap: anyone can
            // transfer PRIMES to our wallet and it will notify us honestly. So the
            // clear also needs the jetton-level sender to be DeDust's PRIMES vault
            // (the only party that pays a swap's proceeds) and the amount to meet
            // the swap's own `limit` (DeDust never fills below it). A stranger's
            // 1-nanoPRIMES transfer used to clear the tracker here, so a refusal
            // arriving afterwards found nothing in flight and its GRAM — one
            // `FLUSH_PCT` tranche of `pending` a day — was stranded in the gas
            // buffer. A forger must now hand over `lastMinOut` PRIMES, worth at
            // least the GRAM he strands at the floor, and those PRIMES are burned.
            if (burn.walletSet == 1 && in.senderAddress == burn.jettonWalletAddr) {
                val jettonFrom = msg.sender;
                // The vault of the venue the open flush was SENT to (audit R2-M1).
                val trip = flushReplyVenue(storage.venue.load(), storage.inFlightFlush);
                if (jettonFrom != null && jettonFrom == trip.primesJettonVault) {
                    if (burn.flushCaller != null) {
                        respondTo = burn.flushCaller!;
                        burn.changeTo = burn.flushCaller; // B40: pinned before the lock lifts
                    }
                    // THE TALLY COUNTS SWAP PROCEEDS ONLY. A holder's own transfer to
                    // our wallet also notifies honestly, but it chooses the GRAM the
                    // burn rides on: at ~0.006 it paid this handler and not the burn,
                    // which IGNORE_ERRORS below then dropped, and `getBurnStats` (§3.3's
                    // "measured" burn) counted PRIMES that were never burned
                    // (2026-11-08 audit). A stranger's PRIMES are still burned when
                    // they pay for it, uncounted — the under-count direction.
                    burn.burnedPrimes += msg.amount;
                    burn.burnEvents += 1;
                    storage.burn = burn.toCell();
                    if (msg.amount >= storage.lastMinOut) {
                        storage.inFlightFlush = 0;
                    }
                    storage.save();
                }
            }
            createMessage({
                bounce: BounceMode.NoBounce,
                value: 0,
                dest: in.senderAddress,
                body: (JettonBurn {
                    queryId: msg.queryId,
                    amount: msg.amount,
                    responseAddr: respondTo,
                    // TEP-74's `custom_payload:(Maybe ^Cell)`, absent on THIS
                    // leg. The bit is written either way; §4.3.2's tsTON burn is
                    // the leg that fills it.
                    customPayload: null,
                }).toCell(),
            // IGNORE_ERRORS: the burn rides only the GRAM DeDust forwarded, and if
            // that is too little to pay its forward fee the action phase would fail
            // and roll back the `inFlightFlush` clear above with it — the flush lock
            // this fill exists to lift. An unpaid burn is dropped instead; the PRIMES
            // stay on this contract's wallet, which moves neither `T` nor `S`.
            }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE | SEND_MODE_IGNORE_ERRORS);
        }

        SetLedger => {
            var storage = lazy Storage.load();
            var cfg = storage.cfg.load();
            assert (in.senderAddress == cfg.genesisScriptAddr) throw 100; // wrong_sender
            assert (storage.linked == 0) throw 104;                       // already_processed
            cfg.ledgerAddr = msg.ledgerAddr;
            storage.cfg = cfg.toCell();
            storage.linked = 1;
            storage.save();
        }

        SetJettonWallet => {
            var storage = lazy Storage.load();
            val cfg = storage.cfg.load();
            assert (in.senderAddress == cfg.genesisScriptAddr) throw 100; // wrong_sender
            var burn = storage.burn.load();
            assert (burn.walletSet == 0) throw 104;                       // already_processed
            burn.jettonWalletAddr = msg.jettonWalletAddr;
            burn.walletSet = 1;
            storage.burn = burn.toCell();
            storage.save();
        }

        DedustPayout => {
            // THE REFUND PATH. Restores exactly what `onBouncedMessage` restores,
            // because it is the same event reaching us by the only route DeDust
            // actually uses. The two handlers are kept separate rather than merged:
            // this one covers the POOL refusing (slippage, expiry — 32.0% of
            // attempts since D-143, and 99.4% before it), the bounce handler
            // still covers the VAULT refusing outright
            // (gas too low, unknown op), which bounces normally because it fails
            // one hop closer. Neither subsumes the other.
            var storage = lazy Storage.load();
            val venue = storage.venue.load();

            // §4.3.2 LEG 2 FILLED. The tsTON pool's native vault pays a jetton -> GRAM
            // swap's OUTPUT with the same `payout#474f86cf` the flush venue's vault
            // pays a refusal with, so state decides which this is. It cannot be
            // ambiguous: `handleFlush` refuses while an exit is on leg 1 or 2 and
            // `unstake` refuses while a flush is (both throw 230), so at most one of
            // the two round trips exists at a time. That serialisation is the price
            // of sharing a vault, and it is the same fail-closed discipline
            // `ratchet_flush_in_flight` (223) already imposes on flushes against
            // each other. The sender is the tsTON pool's OWN native vault, deploy
            // data, so a venue migration cannot strand leg 2's output.
            val metaPeek = lazy storage.staking.load().meta.load();
            if (metaPeek.exitLeg == EXIT_LEG_DEDUST) {
                val dedustTstonNativeVault = venue.staking.load().treasury.load().dedustTstonNativeVault;
                if (in.senderAddress == dedustTstonNativeVault) {
                    creditExitArrival(in.valueCoins, true);
                    return;
                }
            }

            // A payout from the native vault can only be our own swap's GRAM coming
            // back: this contract swaps GRAM -> PRIMES and never the other way, so
            // it can never be the SUCCESSFUL output of a jetton -> GRAM swap, which
            // is the other thing this opcode carries. That makes the sender check
            // the whole correlation — no `queryId` bookkeeping is needed, and
            // `Flush.queryId` is caller-supplied and therefore not a correlator we
            // could trust anyway. `inFlightFlush` is the amount, and there is only
            // ever one open round trip (throw 223 in `handleFlush` enforces that).
            //
            // Audit R2-M1: "the native vault" is the one the open flush was SENT to.
            // Checked against the current venue, a refund that crossed an
            // `UpdateVenue` threw here and stranded the tranche.
            val trip = flushReplyVenue(venue, storage.inFlightFlush);
            assert (in.senderAddress == trip.dedustNativeVault) throw 100; // wrong_sender

            // THE VALUE IS THE CORRELATION. The sender check above does NOT make
            // this payout ours: anyone can make the native vault pay this address
            // by swapping jetton -> GRAM with `recipient_addr` = us, timed while
            // our own swap is in flight and about to FILL. Read as a refusal, that
            // put `inFlightFlush` back into `pending` after the GRAM had really left
            // — `pending` overstated against the balance. A genuine refusal pays
            // back the whole input, so `value >= inFlightFlush`; anything smaller
            // is not our round trip and joins the gas buffer. A forger who pays
            // the whole amount has donated exactly the GRAM he restored.
            if (storage.inFlightFlush > 0 && in.valueCoins >= storage.inFlightFlush) {
                storage.pending += storage.inFlightFlush;
                storage.swapped -= storage.inFlightFlush;
                storage.inFlightFlush = 0;
                storage.lastOutcome = FLUSH_BOUNCED as uint8;
                // Same reasoning as GAUNTLET V11 in `onBouncedMessage`: the
                // cooldown was written optimistically before the send, so a
                // refusal must give it back or one refused attempt burns 24h
                // with no swap having landed. 0 is more permissive than exact
                // restoration, never less.
                storage.lastFlushTime = 0;
                storage.save();
            }
            // `inFlightFlush == 0` is NOT an error and must not throw: the GRAM has
            // already been credited by the time compute runs, and throwing would
            // abort the transaction while keeping it, which is the exact
            // half-state this handler exists to prevent. Nothing is credited to
            // `pending` in that case either — `pending` is mirrored by `T` on the
            // ledger (§5's identity), and this contract cannot move `T`, so
            // inventing backing here would break the identity rather than restore
            // it. Unattributable GRAM stays as this account's gas buffer, exactly
            // like the swap's own change.
        }

        // ---- §4.3.2's three permissionless triggers (D-151) ----------------

        Stake => {
            handleStake(msg.queryId, in.valueCoins, in.senderAddress);
        }

        Unstake => {
            handleUnstake(msg.queryId, in.valueCoins, in.senderAddress);
        }

        Harvest => {
            handleHarvest(msg.queryId, in.valueCoins, in.senderAddress);
        }

        RecoverExit => {
            handleRecoverExit();
        }

        SetTstonWallet => {
            var storage = lazy Storage.load();
            val cfg = storage.cfg.load();
            assert (in.senderAddress == cfg.genesisScriptAddr) throw 100; // wrong_sender
            var stk = storage.staking.load();
            var meta = stk.meta.load();
            assert (meta.tstonWalletSet == 0) throw 104;                  // already_processed
            meta.tstonWalletAddr = msg.tstonWalletAddr;
            meta.tstonWalletSet = 1;
            stk.meta = meta.toCell();
            storage.staking = stk.toCell();
            storage.save();
        }

        // ---- §4.3.2's replies, ALL OF WHICH ARRIVE NON-BOUNCEABLE ----------
        // Which is why each needs an arm at all: the catch-all below would abort
        // on them and paint the trace red while the balance looked right — the
        // 2026-09-17 failure class in MISTAKES.md, exactly.

        TonstakersWithdrawal => {
            // LEG 1 FILLED. The pool sends this itself (`pool.func:206-212`), and its
            // address is in the venue, so the sender is checked here. This arrival
            // closes the exit whole and books any shortfall as loss, so a stranger
            // must not be able to trigger it with 0.02 GRAM.
            //
            // A STRANGER'S OWN BURN CANNOT REACH THIS ARM. The pool pays
            // `from_address`, the OWNER of the burning wallet, and ignores the
            // burn's `response_address` ("response will be ignored",
            // `pool::withdraw`). It also takes the request only from its jetton
            // minter (`assert_sender!(sender_address, jetton_minter)`), and the
            // minter takes it only from the owner's own wallet. So naming this
            // contract as the response address on your own tsTON burn pays YOU.
            // The only burn that pays us is our own leg 1. (Checked against
            // `ton-blockchain/liquid-staking-contract` @ main, 2026-09-29.
            // Partial credit here would be no safer, and it would lose the one
            // place a slashing shortfall is booked.) Anything else
            // is unattributable GRAM and joins the gas buffer — never a throw, the
            // message is non-bounceable (MISTAKES.md 2026-09-17).
            val peek = lazy Storage.load();
            val vs = peek.venue.load().staking.load();
            if (in.senderAddress == vs.tonstakersPool
                    && peek.staking.load().meta.load().exitLeg == EXIT_LEG_BURN_FOK) {
                creditExitArrival(in.valueCoins, false);
            }
        }

        PayoutOwnershipAssigned => {
            // LEG 3's BILL MINTED. NO ACCOUNTING ACTION ON ANY TERM — nothing is
            // credited, nothing unlocked. The outstanding exit is tracked by the
            // `exiting` our own `unstake` credited, not by the arrival of an NFT
            // anybody can send us, so a forged one changes no number of `T`.
            //
            // BUT IT CARRIES THE BURN'S CHANGE (mainnet, 2026-11-23: the bill item
            // sends this to the owner with 0.955 of a 1.05 burn). That is the
            // caller's leg-3 gas, so it is counted into the exit's refund row once,
            // capped at the 0.8 attached and floored like a stake refund (B38): a
            // forger who lands first pays the caller at least STAKE_REFUND_MIN to
            // displace it, out of the forger's own value. The floor is checked
            // before any storage loads, so a dust forgery costs only itself.
            if (in.valueCoins >= STAKE_REFUND_MIN) {
                var storage = lazy Storage.load();
                var stk = storage.staking.load();
                var meta = stk.meta.load();
                if (meta.exitLeg == EXIT_LEG_BILL) {
                    var row = meta.stakeRefund.load();
                    if (row.to != null && !row.billIn) {
                        row.held += (in.valueCoins > TSTON_EXIT_GAS ? TSTON_EXIT_GAS : in.valueCoins) as coins;
                        row.billIn = true;
                        meta.stakeRefund = row.toCell();
                        stk.meta = meta.toCell();
                        storage.staking = stk.toCell();
                        storage.save();
                    }
                }
            }
        }

        PayoutDistributedAsset => {
            // LEG 3 PAID, at round end. See `creditExitArrival` for why the
            // sender is not, and cannot be, authenticated, and why the partial
            // credit makes a forgery a donation.
            val metaPeek = lazy Storage.load().staking.load().meta.load();
            if (metaPeek.exitLeg == EXIT_LEG_BILL) {
                creditExitArrival(in.valueCoins, true);
            }
        }

        Excesses => {
            // From either jetton wallet. The stake's own reply goes back to the
            // caller who fronted it, and our PRIMES wallet's goes to the last flush
            // caller: on a fill it is DeDust's unspent swap gas, which that caller
            // paid (D-146). Anything else is accepted and ignored: the value is
            // already on the balance by the time compute runs, where it joins the
            // gas buffer, which is what paid for the message that earned it.
            var storage = lazy Storage.load();
            var burn = storage.burn.load();
            if (burn.walletSet == 1 && in.senderAddress == burn.jettonWalletAddr
                    && (burn.changeTo != null || burn.flushCaller != null)) {
                // B40: the caller the fill pinned, not whoever flushed since. Without a
                // pin (an excess no fill preceded) it is the last caller, as before.
                val caller: address = burn.changeTo != null ? burn.changeTo! : burn.flushCaller!;
                if (burn.changeTo != null) {
                    burn.changeTo = null;
                    storage.burn = burn.toCell();
                    storage.save();
                }
                // Mode 64: the reply's own value only — never this balance, which is `pending`.
                createMessage({
                    bounce: BounceMode.NoBounce,
                    value: 0,
                    dest: caller,
                    body: (Excesses { queryId: msg.queryId }).toCell(),
                }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE | SEND_MODE_IGNORE_ERRORS);
            } else {
                handleStakeRefund(msg.queryId, in.senderAddress, in.valueCoins);
            }
        }

        else => {
            assert (in.body.isEmpty()) throw 101; // wrong_opcode
        }
    }
}

// ---------------------------------------------------------------------------
// §4.3.2 — the three arms (D-151)
// ---------------------------------------------------------------------------

// STAKE. Deposits everything above the reserve into the Tonstakers pool and
// counts it in `T` AT COST. Permissionless, and with no amount for the caller to
// name: `amount = pending - reserveTarget` is computed here from the three terms
// of the obligation.
fun handleStake(queryId: int, valueCoins: int, caller: address) {
    var storage = lazy Storage.load();
    var stk = storage.staking.load();
    var meta = stk.meta.load();
    val venue = storage.venue.load();
    val vs = venue.staking.load();

    assert (meta.tstonWalletSet == 1) throw 231;   // ratchet_tston_wallet_unset
    // Fail closed while ANY round trip is open — a stake, an exit, or a flush.
    // Each of them moves a term of `T` optimistically before its send and is
    // reversed on arrival, so two open at once would restore the wrong amount,
    // and the flush shares leg 2's payout opcode besides.
    if (flushIsStale(storage)) { storage.inFlightFlush = 0; }
    assert (stk.inFlightStake == 0 && stk.inFlightExit == 0
            && storage.inFlightFlush == 0) throw 230;  // ratchet_stake_in_flight
    // A written-off stake's mint may still land: hold new stakes for a second
    // window so it is not read as the new stake's fill. `writtenOff` is NOT
    // cleared when the hold passes (audit H2): a bill can pay later still — the
    // pool will not finalise a round until every loan is repaid
    // (`pool.func:139-143`) — and must then restore cost, not read as yield.
    // The hold keys on the STAMP, not on `writtenOff` (audit H2 nit 2): a
    // stranded stake whose cost a donation fully covered writes off nothing, and
    // its late mint must still not be read as the next stake's fill.
    // `recover_exit` keeps `stakeStartedAt`; a fill or a bounce resets it to 0,
    // and `inFlightStake == 0` is asserted above, so a non-zero stamp here means
    // a stake that was recovered.
    if (meta.stakeStartedAt != 0) {
        assert (blockchain.now() - meta.stakeStartedAt >= 2 * storage.cfg.load().exitRecoverySec())
            throw 230;                                 // ratchet_stake_in_flight
    }

    val target = reserveTargetOf(storage.pending, stk);
    val amount = storage.pending - target;
    // D-153: the DIVIDED minimum. `stakeDivisor` is 1 on mainnet, so this reads
    // as `amount > STAKE_MIN` there and the constant is unchanged.
    assert (amount > storage.cfg.load().stakeMinTon()) throw 226;  // ratchet_stake_below_min

    // THE POOL'S FEES COME OUT OF THE CALLER'S VALUE (D-146), never out of
    // `pending` (D-151: a 1 GRAM fee taken from the staked amount would drop `T`
    // on every stake and `p_f = T/S` with it) and no longer out of the gas
    // buffer. Asserted by name rather than left to die in the ACTION phase.
    assert (valueCoins >= TONSTAKERS_DEPOSIT_FEE + STAKE_CREDIT_MARGIN + CALLER_COMPUTE_GAS) throw 225; // ratchet_flush_gas
    val keep = contract.getOriginalBalance() - valueCoins - amount;

    // Two-phase optimistic write, exactly as `handleFlush` does it: the term
    // that gains is credited in the same step the term that loses is debited, so
    // `pending + stakedCost + exiting` is conserved and D-151's five-term
    // identity holds at every point. `onBouncedMessage` reverses both.
    storage.pending -= amount;
    stk.stakedCost += amount;
    stk.inFlightStake = amount;
    meta.stakeStartedAt = blockchain.now() as uint32;
    meta.stakeRefund = (StakeRefund { to: caller, queryId: queryId, held: 0, changeIn: false, billIn: false }).toCell();
    stk.meta = meta.toCell();
    storage.staking = stk.toCell();
    storage.save();

    createMessage({
        bounce: BounceMode.RichBounce,
        // The deposit is the VALUE, less the pool's flat fee — the body has no
        // amount field at all.
        value: amount + TONSTAKERS_DEPOSIT_FEE + STAKE_CREDIT_MARGIN,
        dest: vs.tonstakersPool,
        body: (TonstakersDeposit { queryId: queryId }).toCell(),
    }).send(SEND_MODE_REGULAR);
    returnCallerChange(keep, caller, queryId);
}

// The pool's `excesses` for the open stake: the unspent part of the 1 GRAM
// reserve the caller attached (TONSTAKERS_DEPOSIT_FEE). Forwarded with the
// INBOUND value only (CARRY_ALL_REMAINING_MESSAGE_VALUE, which also pays this
// compute out of it), so the balance above `pending` ends where it began — D-146
// holds and this is no withdraw path. Authenticated on the sender AND the query
// id, and floored on the value (STAKE_REFUND_MIN, B38); anything else falls
// through to the plain ignore and leaves the row standing. The 0.1 notification
// before it stays here: it pays the fill's own compute.
fun handleStakeRefund(queryId: int, sender: address, valueCoins: int) {
    var storage = lazy Storage.load();
    var stk = storage.staking.load();
    var meta = stk.meta.load();
    var refund = meta.stakeRefund.load();
    if (refund.to == null || refund.queryId != queryId || sender != meta.tstonWalletAddr
            || valueCoins < STAKE_REFUND_MIN) {
        return;
    }
    if (meta.exitLeg != EXIT_IDLE) {
        // AN OPEN EXIT'S ROW IS NEVER PAID FROM HERE; it is paid when the exit ends.
        // What this can do is count the refused leg 1's change: the pool re-mints
        // with the burn's remaining value, and our wallet sends the notification
        // (which moved the machine off leg 1) and then this excess. Once per exit,
        // capped at the 0.8 the caller attached, and floored like the stake's (B38):
        // a stranger who provokes an earlier one pays the caller at least
        // STAKE_REFUND_MIN to displace a ~0.75 change. On leg 1 itself nothing has
        // been refused, so nothing is counted.
        if (meta.exitLeg == EXIT_LEG_BURN_FOK || refund.changeIn) { return; }
        refund.held += (valueCoins > TSTON_EXIT_GAS ? TSTON_EXIT_GAS : valueCoins) as coins;
        refund.changeIn = true;
        meta.stakeRefund = refund.toCell();
        stk.meta = meta.toCell();
        storage.staking = stk.toCell();
        storage.save();
        return;
    }
    // The caller who fronted the reserve: `player` in withdraw-surface's terms.
    val caller = refund.to!;
    meta.stakeRefund = noStakeRefund();
    stk.meta = meta.toCell();
    storage.staking = stk.toCell();
    storage.save();
    createMessage({
        bounce: BounceMode.NoBounce,
        value: 0,
        dest: caller,
        body: (Excesses { queryId: queryId }).toCell(),
    }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE | SEND_MODE_IGNORE_ERRORS);
}

// UNSTAKE. Callable ONLY when the liquid reserve is short — with the floor's
// standing bid already funded there is nothing to refill, and letting anyone
// unstake on demand would be the discretionary surface §11.14 refused.
//
// The exit is sized to restore the reserve, landing on the target or at most a
// rounding step above it, never under, then handed to leg 1. A shortfall whose
// tranche is under `HARVEST_DUST_TSTON` is refused as sufficient (227). `reserveTargetOf` does not move as the tranche crosses from
// `stakedCost` to `exiting`, so one computation is enough.
fun handleUnstake(queryId: int, valueCoins: int, caller: address) {
    var storage = lazy Storage.load();
    var stk = storage.staking.load();
    var meta = stk.meta.load();

    assert (meta.tstonWalletSet == 1) throw 231;   // ratchet_tston_wallet_unset
    if (flushIsStale(storage)) { storage.inFlightFlush = 0; }
    assert (stk.inFlightStake == 0 && stk.inFlightExit == 0
            && storage.inFlightFlush == 0) throw 230;  // ratchet_stake_in_flight
    assert (stk.stakedCost > 0 && stk.tstonHeld > 0) throw 227; // ratchet_reserve_sufficient

    val target = reserveTargetOf(storage.pending, stk);
    assert (storage.pending < target) throw 227;   // ratchet_reserve_sufficient

    var needTon = target - storage.pending;
    if (needTon > stk.stakedCost) { needTon = stk.stakedCost; }

    // SIZED AT COST BASIS, not at `lastRate`. `tstonHeld / stakedCost` is this
    // contract's own average tsTON-per-GRAM and is the one ratio it knows without
    // trusting a learned number; because the pool's rate only ever rises, a
    // tranche sized at cost redeems AT LEAST `needTon` and never less, which is
    // the direction that matters when the point of the call is to refill a
    // reserve that has run short.
    assert (needTon < MUL_OPERAND_BOUND) throw 211;      // ratchet_guard_overflow
    assert (stk.tstonHeld < MUL_OPERAND_BOUND) throw 211; // ratchet_guard_overflow
    // ROUNDED UP. `costPortion` below is floored back out of this, and two floors
    // in a row returned 1-2 nano LESS than `needTon` (2026-11-21, testnet: pending
    // 14.630241649 against a 14.630241650 target after a clean leg-1 refill). That
    // left every refill a hair short, so the reserve read short for ever and
    // `unstake` stayed callable on a dust tranche. With the ceiling,
    // `floor(ceil(x)·C/H) >= floor(x·C/H) = needTon`: the refill lands at or a
    // nano above the target, never under it.
    var tstonAmount = (needTon * stk.tstonHeld + stk.stakedCost - 1) / stk.stakedCost;
    if (tstonAmount > stk.tstonHeld) { tstonAmount = stk.tstonHeld; }
    // A DUST TRANCHE IS NOT AN EXIT (the G93 keeper finding, now enforced here).
    // A 1-nano tranche redeems to 0 GRAM, parks the machine on leg 3 with nothing
    // to settle, and holds `stake`/`unstake` shut for `exitRecoverySec`, so any
    // stranger could freeze the reserve's refill for 72 h with one dust call.
    // The floor is the sim's `staked_reserve.harvest_dust_tston`, the same
    // threshold `harvest()` uses for the same reason: below it, moving tsTON costs
    // more gas than the tsTON is worth. Same unit (nano-tsTON), already published
    // by `getStakingGates()`, and NOT divided by `stakeDivisor`, so a reader
    // checks this gate against `shared/params.json` directly. Under it the
    // reserve counts as sufficient, which is the name 227 already carries.
    assert (tstonAmount >= HARVEST_DUST_TSTON) throw 227; // ratchet_reserve_sufficient
    // and the cost the tranche actually carries, recomputed from the tsTON so
    // the two can never drift apart by a rounding step.
    var costPortion = tstonAmount * stk.stakedCost / stk.tstonHeld;
    if (costPortion > stk.stakedCost) { costPortion = stk.stakedCost; }

    // D-146: THE CALLER PREPAYS THE WHOLE EXIT, not only leg 1. Legs 2 and 3
    // are sent later, by the replies that refuse the leg before them, and no
    // caller is present to pay then — so their gas is taken now and HELD (it is
    // in `keep` below), and spent only if the machine gets that far. Prepaying
    // pessimistically is what keeps a refused leg 1 off the buffer, which the
    // owner's rule forbids. It is no longer an overpay (2026-11-23): what no leg
    // sends, and the answering leg's change, go back to this caller when the exit
    // ends (`refundExitPrepay`), so a leg-1 fill costs it compute and the pool's
    // ~0.003 GRAM, not 1.95.
    assert (valueCoins >= TSTON_EXIT_GAS + EXIT_LATER_LEGS_GAS + CALLER_COMPUTE_GAS) throw 225; // ratchet_flush_gas
    val keep = contract.getOriginalBalance() - valueCoins + EXIT_LATER_LEGS_GAS;

    stk.stakedCost -= costPortion;
    stk.exiting += costPortion;
    stk.exitCostBasis = costPortion;
    stk.tstonHeld -= tstonAmount;
    stk.inFlightExit = tstonAmount;
    meta.exitLeg = EXIT_LEG_BURN_FOK as uint8;
    // D-155 — the ONLY write of the timeout's clock. Every later leg inherits
    // it, so the 72 hours are counted from the exit, not from the last hop.
    meta.exitStartedAt = blockchain.now() as uint32;
    // The caller's row: whoever fronts the prepay gets back what the exit never
    // spends, on whichever arm ends it (`refundExitPrepay`).
    meta.stakeRefund = (StakeRefund { to: caller, queryId: queryId, held: EXIT_LATER_LEGS_GAS, changeIn: false, billIn: false }).toCell();
    stk.meta = meta.toCell();
    storage.staking = stk.toCell();
    storage.save();

    // LEG 1 — Tonstakers' own immediate withdrawal, at the pool's exact rate.
    // `wait_till_round_end = 0, fill_or_kill = 1`: GRAM at `total_balance/supply`
    // or the pool re-mints and nothing was sold. No DEX, no price impact, no
    // partial state (`pool.func:197-218`, `:232-240`).
    sendTstonWithdraw(meta.tstonWalletAddr, queryId, tstonAmount, 0, 1);
    returnCallerChange(keep, caller, queryId);
}

// HARVEST. REALIZE, NEVER MARK: the accrued tsTON is sent to the LP-governed
// treasury AS tsTON, by a plain TEP-74 transfer, at most once per
// HARVEST_INTERVAL and skipped below dust. No DEX leg — the treasury can hold
// tsTON, so converting it would be a proposal governance has not made.
//
// IT TOUCHES NO TERM OF `T`. `tstonHeld` is not in the identity; `stakedCost`,
// `exiting` and `pending` are not written here at all. That is what "realize,
// never mark" means when it is written as arithmetic, and it is why unrealized
// yield never enters the floor price.
fun handleHarvest(queryId: int, valueCoins: int, caller: address) {
    var storage = lazy Storage.load();
    var stk = storage.staking.load();
    var meta = stk.meta.load();
    val venue = storage.venue.load();
    val treasury = venue.staking.load().treasury.load();

    assert (meta.tstonWalletSet == 1) throw 231;   // ratchet_tston_wallet_unset
    // D-197: never while an exit is open. Mid-exit `tstonHeld` and `stakedCost`
    // are both mid-move, and a leg 2 transfer bounce is told from a harvest
    // bounce only by `exitLeg` — so the two must not overlap.
    assert (meta.exitLeg == EXIT_IDLE) throw 230;  // ratchet_stake_in_flight
    assert (blockchain.now() - meta.lastHarvestTime >= storage.cfg.load().harvestIntervalSec())
        throw 228;                                 // ratchet_harvest_too_soon

    // WHICH WAY ROUND THE RATE GOES, and it is the one line in this file where
    // getting it backwards is silently profitable-looking rather than loud.
    // `lastRateNum` nanotons of deposit minted `lastRateDen` nano-tsTON, so
    // tsTON per GRAM is den/num and the tsTON our cost is WORTH AT THE RATE WE
    // PAID is `stakedCost * lastRateDen / lastRateNum`. Anything above that is
    // tsTON the pool's own appreciation added, denominated in tsTON, which is
    // what we send. Sanity check with numbers: stake 100 GRAM at 1 tsTON = 1.05
    // GRAM (num = 105, den = 100) and the pool mints 95.238 tsTON; a year later
    // the rate is unchanged and `100 * 100 / 105 = 95.238`, accrued 0 — the
    // inverted reading would give `100 * 105 / 100 = 105` and a negative
    // accrual that underflows into a colossal one.
    //
    // A STALE RATE IS SAFE IN THE ONLY DIRECTION THAT MATTERS: tsTON only
    // appreciates, so an old rate has a HIGHER den/num, subtracts more, and
    // computes LESS accrued yield — never more (D-151).
    assert (stk.stakedCost < MUL_OPERAND_BOUND) throw 211;  // ratchet_guard_overflow
    val costInTston = stk.stakedCost * meta.lastRateDen / meta.lastRateNum;
    assert (stk.tstonHeld > costInTston) throw 229;         // ratchet_harvest_dust
    val accrued = stk.tstonHeld - costInTston;
    assert (accrued >= HARVEST_DUST_TSTON) throw 229;       // ratchet_harvest_dust

    assert (valueCoins >= HARVEST_GAS + CALLER_COMPUTE_GAS) throw 225; // ratchet_flush_gas (D-146: caller pays)
    val keep = contract.getOriginalBalance() - valueCoins;

    stk.tstonHeld -= accrued;
    meta.lastHarvestTime = blockchain.now() as uint32;
    // The stake refund row is NOT cleared here (B39): see StakeRefund.
    stk.meta = meta.toCell();
    storage.staking = stk.toCell();
    storage.save();

    // `response_destination` is the CALLER: the tsTON wallet's own change goes
    // straight back to whoever paid for the transfer. The forward is what makes
    // the treasury COUNT it (audit M1, see HARVEST_FORWARD_TON).
    sendTstonTransfer(meta.tstonWalletAddr, queryId, accrued as coins,
                      treasury.treasuryAddr, HARVEST_FORWARD_TON, null, HARVEST_GAS, caller);
    returnCallerChange(keep, caller, queryId);
}

// RECOVER_EXIT (D-155). The liveness backstop on the exit state machine, and
// the ONLY arm in this contract whose job is to undo rather than to do.
//
// WHY IT HAS TO EXIST. Every transition in the machine is driven by an inbound
// reply, and a reply is not a guarantee: the 2026-09-21 testnet failure was a
// leg 2 payout from an address `DedustPayout`'s sender gate rejects, which threw
// 100 on a NON-BOUNCEABLE message — the GRAM was credited to the balance, no
// accounting ran, and `exitLeg` stayed at 2 with nothing left to move it. That
// is not a staking outage: `flush()` refused while any exit was open (230), and
// `flush()` is how `pending` becomes `swapped` (§4.3.1). One lost reply bricked
// the ratchet.
//
// WHAT IT MAY AND MAY NOT DO, and this is the whole safety argument.
//   - It RESTORES and never CREDITS. `abortExit` moves `exitCostBasis` from
//     `exiting` back to `stakedCost` — both terms of `T` — and returns the tsTON
//     claim to `tstonHeld`. `pending` is not written, `T` is unchanged, and no
//     caller gains anything by sending it. There is nothing to aim, so it is
//     permissionless in exactly the sense the other three arms are (§11.14).
//   - It cannot DOUBLE-CREDIT a payout that arrives late. Once it has run,
//     `inFlightExit` and `exitCostBasis` are both 0, and `creditExitArrival`'s
//     first branch returns on exactly that state: the late GRAM joins the gas
//     buffer instead of being counted twice.
//   - It may leave `tstonHeld` OVERSTATED on legs 1 and 2 — if the tranche
//     really was sold and the proceeds landed unattributed, this contract now
//     believes it holds tsTON it does not. That is harmless to `harvest()`:
//     the restored tsTON comes back WITH its whole cost basis, so `accrued`
//     does not move, and the shortfall surfaces as `realizedLoss` at the next
//     real exit.
//
// LEG 3 IS WRITTEN OFF, NOT RESTORED (D-197). Leg 3 is entered only after its
// burn was sent, and both ways that burn can fail to take — our wallet's
// bounce and the pool's re-mint — already run `abortExit` on arrival. So an
// exit still sitting on leg 3 at the window has PROVABLY burned its tsTON, and
// putting `inFlightExit` back into `tstonHeld` invents tsTON. Worse, a bill
// that paid UNDER cost has already drawn `exitCostBasis` down by what it paid
// (`creditExitArrival`'s partial branch), so the restore brought the whole
// tsTON back against only the residual cost — and the gap read as accrued
// yield, which `harvest()` would send to the treasury out of the tsTON that
// backs `stakedCost`. The residual is the realized loss, and is booked as one,
// exactly as leg 1 books a shortfall. A bill that pays after this joins the gas
// buffer (the first branch of `creditExitArrival`), so the error is one way: a
// loss over-published, never backing given away.
//
// A STRANDED STAKE IS WRITTEN OFF THE SAME WAY. `stake()` refuses (230) while
// `inFlightStake` is set, and only the pool's mint notification or the deposit's
// bounce clears it, so a mint that landed without its notification (or never
// landed) locked staking — and with it `unstake`, the reserve's refill — for
// ever. Past the window the deposit was accepted (no bounce came) and nothing
// will still answer, so its UNMATCHED cost leaves `stakedCost` as
// `realizedLoss`: `inFlightStake - stakeCredited`, the part no arrived tsTON was
// credited against (audit H2 — under non-optimistic deposits the fill DID land,
// unauthenticated, and this residual is only the drift between the last learned
// rate and the pool's). Not restored to `pending`: that GRAM is gone from this
// balance, and crediting it would overstate `T`. Not credited as tsTON at
// `lastRate`: the mint may never have happened, and invented tsTON reads as
// yield `harvest()` pays out. tsTON that lands afterwards restores at most its
// value at `lastRate` (`creditStakeArrival`), against `writtenOff`, which
// ACCUMULATES. Same direction as leg 3 until then: a loss over-published.
fun handleRecoverExit() {
    var storage = lazy Storage.load();
    var stk = storage.staking.load();
    var meta = stk.meta.load();

    if (stk.inFlightStake > 0
        && blockchain.now() - meta.stakeStartedAt >= storage.cfg.load().exitRecoverySec()) {
        val residual = stk.inFlightStake - meta.stakeCredited;
        stk.realizedLoss += residual;
        stk.stakedCost -= residual;
        meta.writtenOff += residual;
        meta.stakeCredited = 0;
        stk.inFlightStake = 0;
        // `stakeStartedAt` is kept: it times the hold on the next stake.
        meta.stakeRefund = noStakeRefund();
        stk.meta = meta.toCell();
        storage.staking = stk.toCell();
        storage.save();
        return;
    }

    // One refusal for one meaning: there is nothing stranded here. Either no
    // exit is open, or the open one is still inside the window in which the legs
    // are entitled to answer — leg 3's bill pays at ROUND END, ~36 h, so a
    // shorter timeout would abort a leg that is merely waiting its turn.
    assert (meta.exitLeg != EXIT_IDLE
            && blockchain.now() - meta.exitStartedAt >= storage.cfg.load().exitRecoverySec())
        throw 232;                                 // ratchet_exit_not_stranded

    if (meta.exitLeg == EXIT_LEG_BILL) {
        stk.realizedLoss += stk.exitCostBasis;
        stk.exiting -= stk.exitCostBasis;
        stk.exitCostBasis = 0;
        stk.inFlightExit = 0;
        meta.exitLeg = EXIT_IDLE as uint8;
        meta.exitStartedAt = 0;
        refundExitPrepay(mutate meta, 0, storage.pending);  // the exit is over; its unsent gas goes home
        stk.meta = meta.toCell();
        storage.staking = stk.toCell();
        storage.save();
        return;
    }
    // Legs 1 and 2: the tranche goes back into `tstonHeld`. Remember it, so the
    // leg's own late reply is not counted a second time (audit H2 nit 3).
    meta.recoveredExit = stk.inFlightExit;
    abortExit(storage, stk, meta, 0);
}

// A FLUSH THAT NEVER SETTLES EXPIRES. The round trip clears only on a fill
// notification or a refund from the venue it was sent to (`flushReplyVenue` — a
// venue change mid-flight no longer orphans it, audit R2-M1), so one the venue
// DROPPED, or filled with too
// little forwarded GRAM to run the notification, would hold 223 and 230 closed —
// the ratchet's buyback and its staked reserve both wedged. Past
// `FLUSH_STALE_TIMEOUT` (1 h; the swap's own deadline is ten minutes) nothing can
// still answer, so the trip is closed AS FILLED: `swapped` keeps the amount and
// `pending` gets nothing back. That is the direction that can never overstate
// `pending`: if the swap was in fact refused, its GRAM sits in the gas buffer and
// `getSolvency`'s delta is higher, never negative.
fun flushIsStale(storage: Storage): bool {
    return storage.inFlightFlush > 0
        && blockchain.now() - storage.lastAttemptTime >= FLUSH_STALE_TIMEOUT;
}

fun handleFlush(msg: Flush, valueCoins: int, caller: address) {
    var storage = lazy Storage.load();
    val venue = storage.venue.load();
    val cooldownSec = storage.cfg.load().flushCooldownSec();
    assert (blockchain.now() - storage.lastFlushTime >= cooldownSec) throw 207; // ratchet_flush_cooldown
    // D-146: THE VENUE'S GAS COMES OUT OF THE CALLER'S VALUE — never out of
    // `pending`, and no longer out of the gas buffer (see DEDUST_SWAP_GAS).
    // Checked before anything moves, so an under-funded call is a named refusal
    // and not a message this contract would have paid for.
    assert (valueCoins >= DEDUST_SWAP_GAS + CALLER_COMPUTE_GAS) throw 225; // ratchet_flush_gas
    // GAUNTLET V15: refuse while a round trip is still open. The line below used to
    // OVERWRITE `inFlightFlush` with the new amount, so if swap A were still in flight
    // when swap B started, A's bounce would restore B's amount into `pending`/`swapped`
    // — corrupting §5's `T = seeded + swapped + pending` identity, which §3.4 promises is
    // checkable in one get-call. `FLUSH_COOLDOWN` (1 day) against the swap's own
    // `DEDUST_SWAP_DEADLINE_WINDOW` (600s) means a legal flush normally finds this already
    // 0, so the guard only bites when a round trip has hung unresolved for a whole day —
    // precisely when stacking a second swap on it is wrong. It fails CLOSED: a wedged
    // round trip blocks flushing rather than silently mis-stating the identity, and the
    // clear arrives from either the wallet's `TransferNotification` or the bounce handler —
    // or, for a trip nothing will ever answer, from `flushIsStale` (V25).
    if (flushIsStale(storage)) { storage.inFlightFlush = 0; }
    assert (storage.inFlightFlush == 0) throw 223; // ratchet_flush_in_flight
    // Audit R2-M1: the trip a venue change pinned is closed (223 just passed), and
    // the one opened below goes to the CURRENT venue — drop the pin, or the old
    // vault could answer for it.
    if (venue.openTrip != null) {
        var unpinned = venue;
        unpinned.openTrip = null;
        storage.venue = unpinned.toCell();
    }
    // §4.3.2: and refuse while an exit is on LEG 1 OR 2, for the reason the
    // DedustPayout handler gives — leg 2 is paid with the same `payout#474f86cf`
    // a refused flush is, from the same native vault, so two open round trips
    // could not be told apart on arrival, and leg 1's refusal moves straight on
    // to leg 2. Serialising them is fail-closed in the same way 223 is. LEG 3
    // DOES NOT BLOCK (D-197): it is paid by `payout_distributed_asset`, an
    // opcode no flush reply shares, and it never goes back to leg 2 — so a
    // ~36 h bill no longer holds the core loop (§4.3.1) shut while it waits.
    val exitStk = storage.staking.load();
    assert (exitStk.inFlightExit == 0 || exitStk.meta.load().exitLeg == EXIT_LEG_BILL) throw 230; // ratchet_stake_in_flight
    assert (storage.pending > 0) throw 208; // ratchet_flush_below_min (nothing to flush)

    // `min(pending, max(pending * FLUSH_PCT, FLUSH_MIN))` — the sim's own rule,
    // `sim/primes_sim/engine.py:824`, which is the parameter authority for this
    // sizing (CLAUDE.md rule 3). The middle line used to read
    // `{ amount = storage.pending; }`, which is the OPPOSITE rule: it turned
    // "too small to bother with" into "then spend everything". The two agree
    // outside `FLUSH_MIN <= pending <= FLUSH_MIN / FLUSH_PCT` (50..250 GRAM) and
    // inside it the contract spent up to 250 GRAM where the sim spends 50 — the
    // maximum-slippage choice, at exactly the depth where slippage decides
    // whether `min_out` is reachable at all. Nothing downstream was calibrated
    // against the old reading; `SimCrossCheck.spec.ts` now pins the two together.
    var autoSize = storage.pending * FLUSH_PCT / K_SCALE;
    if (autoSize < FLUSH_MIN) { autoSize = FLUSH_MIN; }
    if (autoSize > storage.pending) { autoSize = storage.pending; }
    assert (autoSize >= FLUSH_MIN || autoSize == storage.pending) throw 208; // ratchet_flush_below_min

    // ---- VENUE-DEPTH SIZING (2026-09-19) ----
    //
    // `autoSize` is computed from `pending` and knows nothing about the pool.
    // `computeMinOut` below prices the guard off the pool. Nothing connected
    // the two, so a tranche larger than the venue could absorb bounced against
    // a guard working exactly as designed: the swap's AVERAGE execution price
    // ran above `p_f` while the SPOT price sat well below it, and §4.3.1's
    // promise — that a market under the floor gets bought — silently did not
    // hold. Measured on testnet: pool 1.2826 GRAM / 479,142 PRIMES, spot 2.1x
    // BELOW the floor, and a 19.733 GRAM tranche demanding 3,469,538 PRIMES
    // from a pool holding 479,142 in total. Refused, correctly, and
    // indistinguishable on the dashboard from "the market is above the floor".
    //
    // NO FIXED FRACTION FIXES THIS. 1/10, 1/20 and 1/50 of that same `pending`
    // all still bounce; 1/100 clears the curve and is then raised straight
    // back to `FLUSH_MIN` by the line above; and whatever fraction is chosen
    // breaks again as `pending` grows (the sim reaches 210,833 GRAM). The size
    // has to come from the VENUE, and this contract cannot read the venue:
    // TVM has no synchronous cross-contract call, and DeDust publishes its
    // reserves as a get-method, not as a message it will answer.
    //
    // So the CALLER supplies the size and the contract clamps it. The caller
    // computes it from `get_reserves` and this contract's own `getFloorCache`
    // with the closed form in `shared/dedustQuote.ts`:
    //
    //     a_max = T·R_p/(S·(1+G)) − R_t/(1−f)
    //
    // which is positive exactly when the market is below the floor net of the
    // pool's fee. Below the floor, some flush now always fills.
    //
    // WHY A STRANGER MAY PICK IT. `min_out = amount·S/T` is LINEAR in
    // `amount`, so the guard is a PER-UNIT price and no choice of `amount`
    // can buy a single nanoton above `p_f`. The clamp is one-directional —
    // `min(msg.amount, autoSize)` — so a caller may only ask for LESS than the
    // contract would have sent, never more, and `FLUSH_MIN` therefore binds
    // the auto path only (a venue whose `a_max` is under 5 GRAM is exactly the
    // case this exists for). The two things a bad `amount` can do are
    // underspend, which leaves the GRAM in `pending` backing `T` either way,
    // and bounce, which the refund path already reverses in full.
    // 0 means "size it yourself" and keeps every existing caller correct.
    var amount = autoSize;
    if (msg.amount > 0 && msg.amount < autoSize) { amount = msg.amount; }
    assert (amount > 0) throw 208;  // ratchet_flush_below_min

    // B3: the guard price, computed before any state moves so a throw here
    // leaves `pending` untouched.
    val minOut = computeMinOut(amount, storage.tCache, storage.sCache);

    storage.pending -= amount;
    storage.inFlightFlush = amount;
    // §5 / D3 render `T = swapped + pending` as an identity, so `swapped` has to
    // move in the same step `pending` does. It is credited at send time and
    // reversed by the bounce handler, exactly mirroring `pending`. (The retired
    // primes_bank.tolk declared `swapped` and never incremented it — the
    // identity the dashboard is asked to display did not hold there.)
    storage.swapped += amount;

    // THE COOLDOWN IS CHARGED PRO RATA, and it has to be, because the caller
    // now picks the size. `FLUSH_COOLDOWN` rate-limits GRAM THROUGHPUT — how
    // fast the ratchet may spend `pending` into the venue — and keying it to
    // the call instead of the amount is what would turn caller-sizing into a
    // denial of service: a stranger asking for one nanoton would spend the
    // whole day's allowance and the real flush would wait 24h behind it. A
    // tranche of a tenth the auto size therefore locks a tenth of the day, and
    // a full-size tranche locks the full day exactly as before.
    //
    // Written as a backdated `lastFlushTime` rather than a second storage
    // field: the gate is `now - lastFlushTime >= cooldownSec`, so starting the
    // clock `cooldownSec - incurred` in the past is the same statement with
    // nothing new to keep consistent. Clamped at 0 because `lastFlushTime` is
    // unsigned and a sandbox clock can legitimately sit below one cooldown.
    val incurred = cooldownSec * amount / autoSize;
    val backdate = cooldownSec - incurred;
    storage.lastFlushTime = (blockchain.now() > backdate ? blockchain.now() - backdate : 0) as uint64;

    // §12 flush status. `lastOutcome` is set OPTIMISTICALLY to FILLED at send
    // time and demoted to BOUNCED by onBouncedMessage. That is not sloppiness:
    // this leg has no dedicated fill callback, so "the swap did not bounce" is
    // the fastest positive signal, and the alternative — a fourth `pending`
    // state — would leave a permanently-ambiguous value on the dashboard,
    // which is the exact failure §12 names. A reader who wants certainty
    // checks `inFlightFlush`: non-zero means the round trip is still open and
    // FILLED is provisional. It clears (GAUNTLET B2.1) in the
    // `TransferNotification` handler above — the swap's real proceeds arriving
    // IS the fill callback, once the genesis script has wired the wallet that
    // authenticates it.
    storage.lastAttemptTime = blockchain.now();
    storage.lastAttemptAmount = amount;
    storage.lastMinOut = minOut;
    storage.lastOutcome = FLUSH_FILLED as uint8;
    var burnRow = storage.burn.load();
    burnRow.flushCaller = caller;
    storage.burn = burnRow.toCell();
    storage.save();

    // GAUNTLET V2 (2026-09-09): the payload this replaced — op, query_id,
    // coins(minOut) and nothing else, inherited from primes_bank.tolk D6 as
    // "the real wire format could not be verified" — was not merely unverified,
    // it was checkably wrong: it had no `pool_addr` at all (a vault cannot know
    // WHICH pool to swap through without one) and no `swap_params` ref cell.
    // Rebuilt field-for-field against DeDust v2's own published schema
    // (docs.dedust.io/reference/tlb-schemes, fetched 2026-09-09):
    //
    //   swap#ea06185d query_id:uint64 amount:Coins _:SwapStep swap_params:^SwapParams
    //   step#_ pool_addr:MsgAddressInt params:SwapStepParams = SwapStep
    //   step_params#_ kind:SwapKind limit:Coins next:(Maybe ^SwapStep) = SwapStepParams
    //   given_in$0 = SwapKind   -- the only kind DeDust implements; given_out$1 is not live
    //   swap_params#_ deadline:Timestamp recipient_addr:MsgAddressInt referral_addr:MsgAddress
    //                 fulfill_payload:(Maybe ^Cell) reject_payload:(Maybe ^Cell) = SwapParams
    //
    // `venue.dedustPool` was already stored (SetVenue / getVenue) and simply
    // never read by this function before now. `recipient_addr` is this
    // contract's own address: the swap's PRIMES proceeds land back here, where
    // the `TransferNotification` handler above is the fill callback that clears
    // `inFlightFlush` (GAUNTLET B2.1). `referral_addr` is `addr_none` — nobody
    // is owed a referral fee on this leg — and neither payload cell is used.
    //
    // STILL NOT ROUND-TRIP PROVEN AGAINST A LIVE OR SCHEMA-FAITHFUL COUNTERPARTY
    // (GAUNTLET V2's closing note): every sandbox test that exercises `flush()`
    // stands a plain treasury in for the vault, which accepts any payload
    // unconditionally — that proves this contract's OWN bookkeeping (pending,
    // swapped, the bounce reversal) round-trips, not that a real DeDust pool
    // would accept this exact cell. `WireFormatDeDustSwap.spec.ts` parses the
    // real outbound cell field-by-field against the schema above instead, which
    // is the strongest proof available without either a live testnet pool or a
    // new schema-faithful mock vault contract (filed as V2.1 if a stronger
    // proof is ever wanted).
    createMessage({
        bounce: BounceMode.RichBounce,
        // `amount` is the swap INPUT and `DEDUST_SWAP_GAS` is the vault's own
        // fee — declaring the first and attaching only the first is the bug
        // that exit 263 was.
        value: amount + DEDUST_SWAP_GAS,
        dest: venue.dedustNativeVault,
        body: beginCell()
            .storeUint(DEDUST_SWAP_OP, 32)
            .storeUint(msg.queryId, 64)
            .storeCoins(amount)              // swap#: amount — the GRAM side of the swap
            .storeAddress(venue.dedustPool)  // SwapStep: pool_addr
            .storeUint(0, 1)                 // SwapStepParams: kind = given_in$0
            .storeCoins(minOut)              // SwapStepParams: limit
            .storeUint(0, 1)                 // SwapStepParams: next = none (single-hop)
            .storeRef(
                beginCell()
                    .storeUint(blockchain.now() + DEDUST_SWAP_DEADLINE_WINDOW, 32) // SwapParams: deadline
                    .storeAddress(contract.getAddress())                          // SwapParams: recipient_addr
                    .storeUint(0, 2)                                              // SwapParams: referral_addr = addr_none
                    .storeUint(0, 1)                                              // SwapParams: fulfill_payload = none
                    .storeUint(0, 1)                                              // SwapParams: reject_payload = none
                    .endCell()
            )
            .endCell(),
    }).send(SEND_MODE_REGULAR);
    // Everything but `amount` — which left `pending` — stays exactly where it
    // was; the caller's change goes home.
    returnCallerChange(contract.getOriginalBalance() - valueCoins - amount, caller, msg.queryId);
}

fun onBouncedMessage(in: InMessageBounced) {
    var storage = lazy Storage.load();
    val rich = lazy RichBounceBody.fromSlice(in.bouncedBody);
    val opcode = rich.originalBody.beginParse().loadUint(32);

    if (opcode == DEDUST_SWAP_OP) {
        // Audit R2-L3 (closed for this arm by the security audit of 2026-11-20): the
        // bounce names its own trip. `RichBounce` returns the whole original swap body,
        // so its `amount` is the trip that bounced — readable, not guessed, like the
        // harvest arm below. A late bounce of a trip `flushIsStale` already closed as
        // filled, landing while a NEWER trip is open, used to restore the newer trip's
        // `inFlightFlush`: `pending` then overstated its backing by the difference once
        // that trip filled. A bounce that is not the open trip's credits nothing; its GRAM
        // joins the gas buffer, exactly as a late refund after the stale close does.
        var sw = rich.originalBody.beginParse();
        sw.loadUint(32);                 // op
        sw.loadUint(64);                 // query_id
        if (sw.loadCoins() != storage.inFlightFlush) {
            return;
        }
        // Restore `pending` exactly. The floor guard rides this path and adds
        // nothing to it — that is what makes a refused-above-floor flush and a
        // sandwiched flush indistinguishable at contract level (§4.3.1).
        storage.pending += storage.inFlightFlush;
        storage.swapped -= storage.inFlightFlush;
        storage.inFlightFlush = 0;
        storage.lastOutcome = FLUSH_BOUNCED as uint8;
        // GAUNTLET V11: `lastFlushTime` is the cooldown gate (`handleFlush`'s
        // own `assert`), and `handleFlush` writes it BEFORE the send — same
        // optimistic-then-reverse pattern as the three fields above — so a
        // bounce must undo it too, or `FLUSH_COOLDOWN` (24h) is burned by a
        // single bounced attempt with no swap ever landing, permissionlessly
        // repeatable by anyone since flush has no sender gate. The field's
        // own comment calls it "last SUCCESSFUL-so-far attempt"; a bounce
        // makes this one neither, so the true restoration is whatever it held
        // before this attempt overwrote it — a value not recoverable here,
        // since the overwrite already landed and saved in the earlier,
        // now-bounced transaction, and DeDust's real swap wire format has no
        // room to carry it back. Resetting to 0 is therefore MORE permissive
        // than exact restoration would be, never less: it can only make the
        // next flush available sooner than the true prior cooldown would
        // have, never later, so it never blocks a legitimate flush and never
        // touches `pending`/`T`/`S` — only when the next flush is callable.
        storage.lastFlushTime = 0;
        storage.save();
        return;
    }

    // ---- §4.3.2's bounce arms (D-151) --------------------------------------
    // Each restores in-flight state exactly as the DeDust one above does, and for
    // the same reason: every staking leg credits its destination term BEFORE the
    // send, so a refusal that left the credit standing would break the five-term
    // identity by exactly the amount that never left.

    if (opcode == TONSTAKERS_DEPOSIT_OP) {
        // The pool refused the deposit outright (deposits closed, value below the
        // fee, unrecognised op). The GRAM is home; put it back in `pending`.
        var stk = storage.staking.load();
        var meta = stk.meta.load();
        storage.pending += stk.inFlightStake;
        stk.stakedCost -= stk.inFlightStake;
        stk.inFlightStake = 0;
        // Anything credited against the refused deposit was not its fill. Up to
        // `writtenOff`, it restores a past write-off at the value it was credited
        // at — the spill `creditStakeArrival` would have made with no stake open
        // (audit H2 nit 1); the rest stays in `tstonHeld` as a zero-cost donation.
        var back = meta.stakeCredited;
        if (back > meta.writtenOff) { back = meta.writtenOff; }
        stk.stakedCost += back;
        stk.realizedLoss -= back;
        meta.writtenOff -= back;
        meta.stakeCredited = 0;
        meta.stakeStartedAt = 0;
        meta.stakeRefund = noStakeRefund();
        stk.meta = meta.toCell();
        storage.staking = stk.toCell();
        storage.save();
        return;
    }

    if (opcode == TSTON_BURN_OP) {
        // A withdrawal request our own tsTON wallet refused — legs 1 and 3 both
        // send this opcode, and both abort the same way. §4.3's PRIMES burn shares
        // the opcode but is sent NoBounce and rides the notification's own gas, so
        // it can never arrive here.
        var stk = storage.staking.load();
        if (stk.inFlightExit > 0) {
            abortExit(storage, stk, stk.meta.load(), in.valueCoins);
        }
        return;
    }

    if (opcode == TEP74_TRANSFER_OP) {
        // Two senders share this opcode: leg 2's swap and `harvest()`. `exitLeg`
        // tells them apart — nothing else can, and guessing wrong would either
        // strand a tranche or invent tsTON.
        var stk = storage.staking.load();
        var meta = stk.meta.load();
        if (meta.exitLeg == EXIT_LEG_DEDUST && stk.inFlightExit > 0) {
            abortExit(storage, stk, meta, in.valueCoins);
            return;
        }
        // A bounced harvest. The tsTON never left, so give `tstonHeld` back the
        // amount the bounced body still carries — `RichBounceBody` returns the
        // whole original body, so the amount is readable rather than guessed
        // (D-53's correction, the same route primes_voucher.tolk takes).
        var s = rich.originalBody.beginParse();
        s.loadUint(32);                  // op
        s.loadUint(64);                  // query_id
        stk.tstonHeld += s.loadCoins();
        // GAUNTLET V11's reasoning, applied to harvest: `handleHarvest` writes
        // `lastHarvestTime` before the send, so a refused harvest would otherwise
        // start the 30-day gate (228) with nothing harvested. The prior value is
        // gone and the bounced TEP-74 body has no room for it; 0 is the more
        // permissive restoration — it only lets the next harvest come sooner.
        meta.lastHarvestTime = 0;
        stk.meta = meta.toCell();
        storage.staking = stk.toCell();
        storage.save();
        return;
    }
}

// ---------------------------------------------------------------------------
// Get-methods
// ---------------------------------------------------------------------------

get fun getPending(): int {
    val storage = lazy Storage.load();
    return storage.pending;
}

get fun getSwapped(): int {
    val storage = lazy Storage.load();
    return storage.swapped;
}

get fun getInFlightFlush(): int {
    val storage = lazy Storage.load();
    return storage.inFlightFlush;
}

// The window after which an unanswered flush round trip expires (`flushIsStale`),
// so a caller reads the deploy's own figure instead of mirroring the constant.
get fun getFlushStaleSec(): int {
    return FLUSH_STALE_TIMEOUT;
}

// §3.3 / §9.1 / §11.21 — the burn half of the two-number circulating-supply
// report, measured rather than asserted:
//
//   burnedPrimes — cumulative nano-PRIMES this contract has ordered burned
//   burnEvents   — how many burn orders that took (0 with a non-zero total is
//                  impossible; the pair is a cheap internal consistency check)
//   counting     — 1 once the genesis script has wired this contract's own
//                  jetton wallet, 0 before. **At 0 the total is a floor, not a
//                  measurement**, and a UI that renders it as measured is
//                  wrong. This is returned rather than inferred precisely so
//                  that "nothing burned yet" and "not counting yet" cannot be
//                  confused — the same distinction getFlushStatus draws
//                  between `never` and an undeployed get-method.
//
// What this deliberately does NOT return: circulating supply. That is
// `get_jetton_data().total_supply` on the jetton master, which is the only
// contract that actually knows it, and `S` is on the ledger. The dashboard
// reads three contracts for three numbers and nets none of them (§11.21, §11.22).
get fun getBurnStats(): (int, int, int) {
    val storage = lazy Storage.load();
    val burn = storage.burn.load();
    return (burn.burnedPrimes, burn.burnEvents, burn.walletSet);
}

// The wallet whose notifications are counted, so the claim above is checkable
// against the jetton master's `get_wallet_address(ratchet)` from outside.
get fun getBurnWallet(): (slice, int) {
    val storage = lazy Storage.load();
    val burn = storage.burn.load();
    return (beginCell().storeAddress(burn.jettonWalletAddr).endCell().beginParse(), burn.walletSet);
}

// §12 / §9.1, and NOT optional: without it a dead venue hides behind months of
// legitimate-looking non-execution, and "the venue is gone" is indistinguishable
// from "the market is above the floor".
//   outcome: 0 = never, 1 = filled, 2 = bounced
//   cooldownRemaining: seconds until `flush` can be called again, 0 if now
get fun getFlushStatus(): (int, int, int, int) {
    val storage = lazy Storage.load();
    val elapsed = blockchain.now() - storage.lastFlushTime;
    var cooldownRemaining = storage.cfg.load().flushCooldownSec() - elapsed;   // D-139
    if (cooldownRemaining < 0 || storage.lastOutcome == FLUSH_NEVER) { cooldownRemaining = 0; }
    return (
        storage.lastAttemptTime,
        storage.lastOutcome,
        storage.lastAttemptAmount,
        cooldownRemaining,
    );
}

// ---------------------------------------------------------------------------
// The collateral oracle (SINKS_PLAN.md §5 S4; CONCEPT.md §5.4 and
// docs/floor-as-collateral.md — was LATE_GAME_PLAN.md §5 L4)
// ---------------------------------------------------------------------------
//
// Everything a risk engine needs to reconstruct the floor claim itself, in ONE
// call to ONE address. Not because six calls would be expensive, but because an
// underwriter reading six get-methods across two contracts is an underwriter who
// will read five of them: `p_f` without `pending` overstates deployed backing,
// and `p_f` without `last_flush_outcome` cannot distinguish a bid that is idle
// by design (§4.3.1: the market is above the floor) from a venue that is gone.
// Bundling them is what makes the honest reading the default one.
//
//   tCache, sCache           — T and S. `p_f = T / S`. NOTE: mirrors, see below.
//   pending                  — GRAM held here, not yet swapped. `T = swapped + pending`.
//   swapped                  — cumulative GRAM that has left through the venue leg.
//   lastOutcome              — 0 never, 1 filled, 2 bounced (§12: a long gap is normal).
//   lastAttemptTime          — when that outcome was recorded; 0 if never.
//
// **Why this is on the ratchet and not on the ledger**, where SINKS_PLAN.md §5
// names it: `pending` and the flush outcome are here and TVM has no synchronous
// cross-contract read, so a ledger-side version would have to mirror THIS
// contract's state to answer — inverting the existing, deliberate direction of
// the mirror (§3.4: T and S are authoritative on the ledger, and this contract's
// copies exist only to price the floor guard). One contract has all six numbers
// natively, and it is this one.
//
// The mirror caveat is the one thing an underwriter must be told and is the
// reason it is written here rather than only in the note: `tCache`/`sCache`
// update on every `PoolInject`, which is every mint, but they are **not** the
// authoritative counters. A reader pricing a position against a stale mirror
// should read `getFloorNum`/`getFloorDen` on the ledger and compare; the two
// agreeing is itself a check, and docs/floor-as-collateral.md asks for it.
//
// What this get-method deliberately does NOT return: a price. The AMM price is
// not protocol state and this contract has no oracle (§5). `x*` — the ceiling a
// lender should price the band against — is a formula over `k_max(n)` and the
// head, both on the ledger, both public, and is stated in the note rather than
// implied by a number here that would look more authoritative than it is.
get fun getFloorOracle(): (int, int, int, int, int, int) {
    val storage = lazy Storage.load();
    return (
        storage.tCache,
        storage.sCache,
        storage.pending,
        storage.swapped,
        storage.lastOutcome,
        storage.lastAttemptTime,
    );
}

// The guard price the last attempt actually demanded, so §4.3.1's claim is
// checkable from outside rather than inferred from a bounce.
get fun getLastMinOut(): int {
    val storage = lazy Storage.load();
    return storage.lastMinOut;
}

// The pushed (T, S) mirror the guard prices against. Exposed so its staleness
// against the ledger's authoritative values is visible rather than assumed.
get fun getFloorCache(): (int, int) {
    val storage = lazy Storage.load();
    return (storage.tCache, storage.sCache);
}

// §3.4's load-bearing property, in ONE get-call: (balance, declared liability,
// delta). The ratchet's declared liability is every GRAM it is holding as pool
// backing and could still owe the pool: `pending`, and only `pending`.
// `inFlightFlush` is deliberately NOT part of the liability — that GRAM has
// physically left this contract's balance for the venue, and either fills or
// comes back through the bounce handler (which restores it to `pending` in the
// same step). Counting it here would make `delta` transiently negative for the
// entire round trip and turn the dashboard's most auditor-pleasing block into
// a false alarm once a day. `delta` is the accumulated gas surplus from the hop
// margins and must never be negative. Phase D renders this per contract (D7).
get fun getSolvency(): (int, int, int) {
    val storage = lazy Storage.load();
    val balance = contract.getOriginalBalance();
    val liability = storage.pending;
    return (balance, liability, balance - liability);
}

get fun getVenue(): (slice, slice, slice) {
    val storage = lazy Storage.load();
    val venue = storage.venue.load();
    return (
        beginCell().storeAddress(venue.dedustNativeVault).endCell().beginParse(),
        beginCell().storeAddress(venue.dedustPool).endCell().beginParse(),
        beginCell().storeAddress(venue.primesJettonVault).endCell().beginParse(),
    );
}

// §9.1 / audit R2-M1: WHO SETTLES THE OPEN FLUSH — (native vault, PRIMES jetton
// vault, pinned). `getVenue` is where the NEXT flush goes; after a venue change
// that landed mid-flight the open trip is still answered by the venue it was
// sent to, and without this a reader could not recompute which. `pinned` is 1
// exactly while that is the case; at 0 the pair is `getVenue`'s own.
get fun getFlushReplyVenue(): (slice, slice, int) {
    val storage = lazy Storage.load();
    val venue = storage.venue.load();
    val trip = flushReplyVenue(venue, storage.inFlightFlush);
    return (
        beginCell().storeAddress(trip.dedustNativeVault).endCell().beginParse(),
        beginCell().storeAddress(trip.primesJettonVault).endCell().beginParse(),
        (venue.openTrip != null && storage.inFlightFlush > 0) ? 1 : 0,
    );
}

get fun getLastFlushTs(): int {
    val storage = lazy Storage.load();
    return storage.lastFlushTime;
}

// §4.3.2's whole surface, in ONE call (§9.1: every number the dashboard shows
// about the staked reserve must be recomputable from chain state, and it shows
// all of these).
//
//   stakedCost       — GRAM in the pool, AT COST. A term of `T`.
//   tstonHeld        — nano-tsTON owned, EXCLUDING a tranche inside the exit
//                      machine; `exiting` is where that one is counted.
//   exiting          — GRAM on its way back, at cost. A term of `T`.
//   lastRateNum/Den  — the rate as the PAIR it was learned as, so a reader can
//                      check the ratio rather than a quotient we rounded.
//   reserveTarget    — DERIVED, never stored: RESERVE_BPS of the whole
//                      obligation `pending + stakedCost + exiting`.
//   lastHarvestTime  — 0 until the first harvest; the 30-day gate reads it.
//   realizedLoss     — cumulative GRAM that left `T` and did not come back.
//                      Reported NEXT TO `stakedCost` and never netted into it,
//                      the same separation getBurnStats draws. §5's one external
//                      risk and §8's "loss published" are this number.
get fun getStaking(): (int, int, int, int, int, int, int, int) {
    val storage = lazy Storage.load();
    val stk = storage.staking.load();
    val meta = stk.meta.load();
    return (
        stk.stakedCost,
        stk.tstonHeld,
        stk.exiting,
        meta.lastRateNum,
        meta.lastRateDen,
        reserveTargetOf(storage.pending, stk),
        meta.lastHarvestTime,
        stk.realizedLoss,
    );
}

// D-153 — the stake minimum THIS DEPLOY enforces, after `stakeDivisor`.
// §9.1: `tston.ts`, the read-proxy and the panel all decide "is a stake legal
// yet" from `getPending` minus `getStaking().reserveTarget` against this figure,
// and a reader who could not fetch the right-hand side would be checking one of
// the two halves against a constant this deploy may not use. A separate call
// rather than a ninth field on `getStaking()`, for the reason the next comment
// gives about `getVenue`.
get fun getStakeMin(): int {
    val storage = lazy Storage.load();
    return storage.cfg.load().stakeMinTon();
}

// G68 — the three preconditions of the §4.3.2 arms no other get-method answers:
// `inFlightStake` (stake/unstake throw 230 while it is non-zero), and the harvest
// gate THIS DEPLOY enforces, after `clockDivisor` — (inFlightStake,
// harvestIntervalSec, HARVEST_DUST_TSTON). With `getStaking`, `getStakeMin`,
// `getTstonWallet`, `getExitLeg` and `getInFlightFlush` it lets a caller decide
// every arm on a read instead of provoking the throw (CLAUDE.md's driver rule).
// Appended: `stakeStartedAt` — `recover_exit` writes an open stake off once
// `now - stakeStartedAt >= getExitLeg().recoverAfter` — and `writtenOff`, while
// non-zero of which nothing is held any more: since audit H2 nit 2 `stake` refuses
// while `stakeStartedAt` is non-zero (a recovered stake) until `2 * recoverAfter`.
// Appended (audit H2): `stakeCredited`, the part of the open stake already
// matched by unauthenticated tsTON at the last learned rate — `recover_exit`
// writes off `inFlightStake - stakeCredited`, not the whole stake.
get fun getStakingGates(): (int, int, int, int, int, int) {
    val storage = lazy Storage.load();
    val stk = storage.staking.load();
    val meta = stk.meta.load();
    return (stk.inFlightStake, storage.cfg.load().harvestIntervalSec(), HARVEST_DUST_TSTON,
            meta.stakeStartedAt, meta.writtenOff, meta.stakeCredited);
}

// §4.3.2's three venue addresses. A SEPARATE call from `getVenue` on purpose:
// `getVenue` is read by the backend, the agent SDK and four test suites as a
// fixed 3-tuple, and widening a published shape to add a field is a break for
// every one of them where a second method is a break for none.
get fun getStakingVenue(): (slice, slice, slice) {
    val storage = lazy Storage.load();
    val vs = storage.venue.load().staking.load();
    return (
        beginCell().storeAddress(vs.tonstakersPool).endCell().beginParse(),
        beginCell().storeAddress(vs.dedustTstonVault).endCell().beginParse(),
        beginCell().storeAddress(vs.dedustTstonPool).endCell().beginParse(),
    );
}

// The tsTON wallet whose notifications are the staking path, and the flag that
// says whether the genesis script has wired it. Same shape and same reason as
// `getBurnWallet`: checkable from outside against the Tonstakers master's own
// `get_wallet_address(ratchet)`.
get fun getTstonWallet(): (slice, int) {
    val storage = lazy Storage.load();
    val meta = storage.staking.load().meta.load();
    return (beginCell().storeAddress(meta.tstonWalletAddr).endCell().beginParse(), meta.tstonWalletSet);
}

// The harvest destination, published separately from `getStakingVenue` because
// it is the only address in this contract that receives protocol VALUE rather
// than trading with it — a reader checking §8 wants it on its own line.
get fun getHarvestDest(): slice {
    val storage = lazy Storage.load();
    val t = storage.venue.load().staking.load().treasury.load();
    return beginCell().storeAddress(t.treasuryAddr).endCell().beginParse();
}

// The vault leg 2's GRAM output is accepted from — the tsTON pool's own factory's
// native vault, deploy data like the rest of §4.3.2's staking addresses.
get fun getTstonPayoutVault(): slice {
    val storage = lazy Storage.load();
    val t = storage.venue.load().staking.load().treasury.load();
    return beginCell().storeAddress(t.dedustTstonNativeVault).endCell().beginParse();
}

// The exit state machine's current leg: 0 idle, 1 fill-or-kill burn, 2 the
// guarded DeDust swap, 3 the round-end bill. Non-zero means a tranche is out and
// `flush`, `stake` and `unstake` all refuse (230).
//
// D-155 adds the two numbers a reader needs to answer "is this stranded, and
// when can anyone fix it": `exitStartedAt` (0 while idle) and the recovery
// window THIS DEPLOY enforces, after `clockDivisor` — published divided for the
// same §9.1 reason `getFlushStatus` and `getStakeMin` publish theirs divided.
// `recover_exit#b0000057` is legal once `now() - exitStartedAt >= recoverAfter`.
// Appended rather than inserted, so the existing (leg, inFlightExit) readers are
// untouched.
get fun getExitLeg(): (int, int, int, int) {
    val storage = lazy Storage.load();
    val stk = storage.staking.load();
    val meta = stk.meta.load();
    return (meta.exitLeg, stk.inFlightExit, meta.exitStartedAt,
            storage.cfg.load().exitRecoverySec());
}
