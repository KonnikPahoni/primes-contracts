/**
 * TON PRIMES — opcode registry. Single source of truth (IMPLEMENTATION_PLAN.md §2.3).
 *
 * Every inbound/outbound message opcode used anywhere in the system is declared here,
 * exactly once, and nowhere else — on the TypeScript side (wrappers, backend, webapp;
 * contracts/tests/OpcodeRegistryRule.spec.ts enforces it). TL-B schemas in
 * /shared/schemas/*.tlb reference these names and values by comment. The Tolk contracts
 * are NOT generated from this file: each re-types its hex literals in its message
 * structs, and the sandbox suites catch a mismatch because every wrapper builds its
 * bodies from these values.
 *
 * Numbering scheme: each contract owns a fixed high byte so opcodes are visually
 * distinguishable in a debugger/explorer even though TVM opcode spaces are technically
 * per-contract. Standard TEP-62/TEP-74 opcodes are reused verbatim (not reassigned) so
 * off-the-shelf wallets/explorers/indexers that already special-case them keep working.
 *
 * Full message field layouts: /shared/schemas/*.tlb, and the generated tables in
 * /docs/audit/wire-format.md and /docs/audit/contract-surface.md.
 */

// ---------------------------------------------------------------------------
// Standard TEP-62 (NFT) opcodes — reused, not reassigned.
// ---------------------------------------------------------------------------
export const TEP62 = {
  transfer: 0x5fcc3d14,
  ownership_assigned: 0x05138d91,
  get_static_data: 0x2fcb26a2,
  report_static_data: 0x8b771735,
  excesses: 0xd53276db,
} as const;

// ---------------------------------------------------------------------------
// Standard TEP-74 (Jetton) opcodes — reused, not reassigned.
//
// EXPORTED, like TEP62 above, and for one reason: `contracts/wrappers/
// PrimesJettonWallet.ts` IS a TEP-74 wallet, so its own three opcodes have no
// protocol namespace to borrow. Routing them through a peer that happens to
// share the value (`SINK.jetton_burn`, say) would attribute a wallet's opcode
// to the burn sink, and `internal_transfer` (0x178d4519) is not re-exposed by
// any namespace at all. Every OTHER consumer keeps citing the namespace of the
// contract that sends or receives the message — `SINK.jetton_burn`,
// `VESTING.jetton_transfer`, `RATCHET.dedust_burn` — because that is what says
// which contract a wire value belongs to.
// ---------------------------------------------------------------------------
export const TEP74 = {
  transfer: 0xf8a7ea5,
  transfer_notification: 0x7362d09c,
  internal_transfer: 0x178d4519,
  excesses: 0xd53276db,
  burn: 0x595f07bc,
  burn_notification: 0x7bdd97de,
  // TEP-89, the on-chain wallet-address discovery pair. Sits in the TEP74
  // namespace for the same reason the six above do: the jetton master IS the
  // standard contract here, so there is no protocol namespace to borrow.
  // Added 2026-09-16 (R19) after DeDust's jetton vault failed to initialise
  // against this master — see primes_jetton_master.tolk's TEP-89 block.
  provide_wallet_address: 0x2c76b973,
  take_wallet_address: 0xd1735400,
} as const;

// ---------------------------------------------------------------------------
// DeDust v2 — SOMEBODY ELSE'S PROTOCOL, so no high byte and no namespace of ours.
//
// The ratchet's own leg is `RATCHET.dedust_swap` / `RATCHET.dedust_payout` above;
// those stay where the contract that sends and receives them is documented. This
// block is for the legs a PLAYER sends from the swap form (`components/SwapCard`),
// which the ratchet has no opcode for because it never trades a jetton in.
//
// Provenance for the value: `@dedust/sdk`'s own `VaultJetton.createSwapPayload`,
// cross-checked the same way `contracts/scripts/dedust.ts` cross-checked the rest
// of this wire format against mainnet traces on 2026-09-16.
// ---------------------------------------------------------------------------
export const DEDUST = {
  // outbound, in the `forward_payload` of a TEP-74 transfer to the JETTON vault.
  // NOT the native vault's opcode and NOT interchangeable with it: the native
  // swap declares its own `amount` because GRAM arrives as message value, while
  // this one takes the amount from the transfer that carries it.
  swap_jetton: 0xe3a0d482,
  // The two halves of a PLAYER's liquidity deposit (`shared/messages.ts`'s
  // "DEDUST VENUE, PART TWO"). They share a NAME on DeDust's side —
  // `deposit_liquidity` — and nothing else: one is sent to the native vault as
  // a message in its own right, the other rides in a TEP-74 forward payload to
  // the jetton vault, and swapping them loses the deposit to a refusal exactly
  // as swapping the two swap opcodes loses the trade.
  deposit_native: 0xd55e4686,
  deposit_jetton: 0x40e108d6,
  // The POOL's own external-out events (docs.dedust.io/reference/tlb-schemes,
  // "Pool > Events") — what the event poller reads to put a player's swap and
  // LP mint/burn on their `/me` ledger tape. Not messages anyone sends: a pool
  // logs one per swap/deposit/withdrawal, naming the wallet that did it. The
  // swap layout was decoded against live mainnet pool traffic on 2026-11-20.
  event_swap: 0x9c610de3,
  event_deposit: 0xb544f4a4,
  event_withdrawal: 0x3aa870a6,
} as const;

// ---------------------------------------------------------------------------
// Venue timelock — high byte 0xA0. THE ENTIRE ADMIN SURFACE OF THE PROTOCOL
// (primes_venue_timelock.tolk header): a 30-day public queue+execute over the
// three DeDust venue addresses `primes_ratchet.tolk`'s `flush()` targets.
//
// `retry_update_venue` (0xa0000004, D10, GAUNTLET.md A2.2): a permissionless
// re-send for when `execute`'s outbound `update_venue` bounces. Its layout is in
// `shared/schemas/venue_timelock.tlb`.
// ---------------------------------------------------------------------------
export const VENUE_TIMELOCK = {
  queue: 0xa0000001,
  cancel: 0xa0000002,
  execute: 0xa0000003,
  retry_update_venue: 0xa0000004,
  // D11: one-shot, from the
  // genesis script only — same circular-address bootstrap as COLLECTION's
  // `set_ledger` (D7): the ratchet's own address cannot be known until after
  // this contract deploys, so it is set post-deploy rather than baked in.
  set_ratchet: 0xa0000005,
  // D-194: from the governed treasury ONLY, on a passed venue-confirm vote. Sets
  // `confirmed` on the queued record whose `seq` it names; `execute` refuses without it.
  confirm_venue: 0xa0000006,
} as const;

// ---------------------------------------------------------------------------
// Splitter + Ledger — high byte 0xB0.
//
// UPGRADE_PLAN_V5.md §4 B1 / CONCEPT v5 §3.4: the monolith formerly called the
// "bank" is decomposed into LEDGER (this table), RATCHET (below) and the
// REGISTRAR (below) — the reservation shard's escrow was a fourth until D-90
// deleted it. The
// 0xB0 high byte is retained across the split — the opcodes did not move, the
// state did, and renumbering them would break every deployed indexer for no
// gain. The `BANK` compatibility alias that survived that split is now DELETED;
// its tombstone, and why, is at the bottom of this file.
// ---------------------------------------------------------------------------

// D-109: the margin `mint` keeps above MINT_PRICE before refunding the rest
// (`primes_ledger.tolk`'s `MINT_MARGIN`). A wire constant of RES_GAS's kind —
// not a params.json economic parameter (CLAUDE.md rule 3 is not engaged) —
// sized so it never partial-refunds an intentionally padded send: the webapp
// pads to MINT_PRICE + 0.01 GRAM (`webapp/src/chain/values.ts`
// FEE_MARGIN_NANOTON) and `smokeMintLive.ts` to +0.05 GRAM. Pinned to the
// ledger's literal by `SimCrossCheck.spec.ts`'s constant sweep (GAUNTLET.md G60).
export const MINT_MARGIN_NANOTON = 500000000n; // 0.5 GRAM

export const LEDGER = {
  // inbound, from any wallet.
  //
  // THE mint: one message, one signature, 1 GRAM attached (primes_ledger.tolk D8).
  // D-191 point 1: SENT TO THE BENEFICIARY'S MINTER CARD, not to the ledger — the
  // card forwards it inside `MINTER_CARD.card_mint`; the ledger no longer accepts it
  // from a wallet.
  // 0xb0000001 and 0xb0000003 are RETIRED. Do not reuse: they are deliberately
  // left unassigned so a stale sender hits `wrong_opcode` instead of an
  // unrelated handler.
  mint: 0xb0000002,
  // inbound, one-shot, from the genesis script ONLY (CONCEPT §6 point 0).
  //
  // THE LAUNCH. Mints Unity — number 1 — to the founder as a plain TEP-62 item
  // carrying `RARITY_UNITY`, flips the ledger's `launched` flag, and sends
  // `launch_open` to THE ONE peer that must not accept player money before the
  // game exists: the market (D-3 folded the reservation book, the trophy
  // auction and the genesis auction into it). Until it lands, `mint` and
  // `mint_won_lot` throw `ledger_not_launched` (212).
  //
  // Unity is economically inert BY CONSTRUCTION, not by a special case in the
  // split: `n = 1` is not marked in the prime bitmap, is not counted in π(n),
  // moves neither T nor S nor the head, is below the referral key's `>= 2` floor
  // and can never appear in a factorization (every cited factor must be a MARKED
  // prime). It is an NFT and nothing else.
  ignite: 0xb000000a,
  // inbound, PERMISSIONLESS. Re-sends `ignite`'s `launch_open` message.
  // The counterpart to `sync_head`, and for the same reason: the fan-out is
  // NoBounce, this system has no admin key, and a peer that missed its opener
  // would otherwise stay closed forever. Idempotent — every receiver's handler
  // is one-shot — and it can only open, never close.
  sync_launch: 0xb000000b,
  claim_tribute: 0xb0000004, // inbound from an NFT item (item-trusted edge), forwards owner's claim
  retry_credit: 0xb0000005, // permissionless retry of a bounced credit_tribute (see unrouted_credits)
  // D-52: permissionless retry of a bounced jetton MINT — the emission-side
  // twin of retry_credit. `S` counts emission the moment it is sent, so a
  // bounced JettonMint parks the amount in `unminted_mints` keyed by the
  // recipient rather than decrementing `S` (which §3.3/§5 forbid, and which
  // would make `p_f` OVERSTATE backing — the wrong direction). This op pays
  // it out. Cannot fabricate emission: it only replays an entry a bounce
  // already recorded, and only to the address that entry is keyed on.
  retry_mint: 0xb000000d,
  // §3.2: permissionless — converts prime p's accrued flat dividend
  // (div_acc − entry[p]) into its item's `owed`. D-188 point 4: `entry[p]` is on
  // the item, so this sends `credit_dividend` there and the item re-stamps.
  // Zero claimable is a cheap no-op on the item, not an error.
  claim_dividend: 0xb0000008,
  // inbound, from item(p) only (D-188 point 4): the amount `credit_dividend`
  // moved into `owed`; the ledger moves it from div_outstanding to tribute_owed.
  dividend_credited: 0xb000000e,
  // 0xb0000081 (`prime_deployed`, V32) is RETIRED by V28: item(n)'s own
  // `mint_confirmed` now says "populated", for a prime and a composite alike, and
  // clears the in-flight row. Do not reuse it.
  // permissionless sweep of the gas-&-ops SURPLUS into the RATCHET POOL (D-117:
  // `pending` and `T` rise together, no emission; there is no operations
  // address any more) (CONCEPT §4.1, §8). Contract-computed amount, one fixed destination, no
  // argument that names a sum. The two protected pools (`pending`, `owed`)
  // are not on this contract, by the §3.4 decomposition — that is what
  // makes this greppably not a withdraw path.
  sweep_ops: 0xb0000007,
  // inbound, from the MARKET only: a sold lot's premium above MINT_PRICE (D-20).
  // `amount` is added to T and forwarded to the ratchet as `pending` (S
  // untouched, so a premium is a pure floor step). Nothing is minted or emitted;
  // a prime's forfeit entry is cleared by `SettlePrimeClearing`, not here.
  clearing_cleared: 0xb0000009,
  // inbound, PERMISSIONLESS (D-91 point 4). The permissionless floor donation:
  // `amount` GRAM in, added to BOTH `T` and `seedT` (D-26 keeps closing) and
  // forwarded to the ratchet as `pending`; `S` rises by `amount * L` and those
  // PRIMES are minted to the sender, who pairs and burns them on DeDust
  // themselves. This is where the pool's PRIMES side comes from.
  donate_floor: 0xb000000c,

  // inbound, from the TWO ROYALTY-BEARING COLLECTIONS ONLY (DECISIONS.md D-128).
  // A marketplace forwards a TEP-66 secondary royalty to the collection, which
  // splits it and sends the ratchet's half here: `T += amount`, `S` UNTOUCHED,
  // and the GRAM forwarded to the ratchet as `pending` — `clearing_cleared`'s
  // body without the market's door, so a royalty is a pure floor step exactly
  // as a clearing is.
  //
  // It is NOT `donate_floor`, and the difference is load-bearing: `donate_floor`
  // also MINTS PRIMES to its sender and inflates `S`, which on this path would
  // mean a marketplace's royalty emitting supply to a collection contract.
  //
  // Sender-restricted to `ConfigA.collectionAddr`, deploy data, and permissionless
  // within that: no key, no amount anyone else can name, nothing that leaves.
  // (The generators collection was a second sender until D-202 deleted it.)
  royalty_to_ratchet: 0xb0000079,
  // inbound, from item(n) only (D-117, V28): the receipt the item sends from its
  // `populate`, carrying the held split lines back with their value. The ledger
  // authenticates it from `n`, pays the lines on arrival, and (V32) drops a prime
  // from its in-flight set. A refused mint parks the lines instead.
  mint_confirmed: 0xb000007a,
  // inbound, from the collection only (V28): a `populate` item(n) refused, relayed
  // with all the bounced value. Carries the original `mint_item`; parked for
  // `retry_item` exactly as a bounced `mint_item` is.
  mint_item_refused: 0xb0000084,
  // inbound, permissionless (D-117): re-send a bounced `mint_item` parked in the
  // ledger's `unroutedItems` lane — same n, owner and held lines; caller pays the deploy.
  retry_item: 0xb000007b,
  // inbound, from the market only
  mint_won_lot: 0xb0000020,
  // inbound, one-shot from the genesis script (§3.4 B1): the ratchet and
  // registrar addresses. Cannot be fixed at deploy — their init data embeds the
  // ledger's own address, the same circular dependency as set_peers.
  set_sinks: 0xb0000042,
  // 0xb0000045 (`set_stake_sink`) and 0xb0000044 (`set_stake_uplift`) are
  // RETIRED by D-168 with the ledger's stake leg.
  // 0xb0000046 (`set_invite_config`) is RETIRED by D-202 with the invite signer
  // and the generators collection. Do not reuse.
  // 0xb0000047 (`quote_floor`) is RETIRED by D-212 with the burn sink that asked
  // it (and 0x92000002, its `floor_quote` reply). Do not reuse.
  // 0xb0000085 (`set_invite_text`) is RETIRED by D-215: `set_invite_terms` carries
  // the words with the count and value. Do not reuse.
  // inbound, from `FeeDests.operatorAddr` only (D-211, D-215): §4.1's invite count,
  // value and words, inside INVITE_COUNT_CEILING and INVITE_LINE_CAP. Moves no value;
  // the ledger still writes the link and `n` after the words.
  set_invite_terms: 0xb0000086,
  // 0x98000001 (`deploy_generator`) is RETIRED by D-202: an invite slot is now a
  // plain text-comment transfer (op 0), which needs no opcode. Do not reuse.
  // 0xb0000043 (`record_patron_link`) is RETIRED by D-106 along with patron
  // mode. Do not reuse: a stale claim from a pre-D-106 item would decode as
  // whatever takes the number.
  // outbound, to an NFT item
  credit_tribute: 0xb0000030,
  // outbound, to an NFT item (D-188 point 4): the flat dividend, settled on the
  // item against its own bookmark. Carries div_acc and, once, a parked stamp.
  credit_dividend: 0xb0000036,
  // 0xc1000005 (`release_purse`) is RETIRED by D-106. Same rule.
  // outbound, to the bounty vault, on a primorial-boundary mint (concept §7).
  // 0xb0000031 is RETIRED. Do not reuse: it is the pre-DENOMINATION_PLAN body
  // (query_id, era_boundary, beneficiary) whose amount came from a
  // PRIMES-denominated schedule. P4 floor-indexes the schedule, so the body now
  // carries the ledger's post-mint (T, S) and the vault converts GRAM -> PRIMES
  // itself. A stale sender must be REJECTED, not silently mis-parsed, so the
  // opcode moves rather than the body changing under a fixed number.
  pay_era_bounty: 0xb0000032,
  // outbound, to the bounty vault, on any mint settling a SPECIAL_NUMBERS_PLAN.md
  // category match (Phase 2). Tier only; the vault's own genesis-fixed schedule
  // decides the GRAM value (D22 trust shape, mirrored for special numbers).
  pay_special_number_rebate: 0xb0000072,
  // D-88 point 2 DELETES `settle_special_composite` (0xb0000073) along with
  // SS3's 1-day composite decay lane, its only sender. A special composite is
  // now bought ahead of the head on the ordinary ascending lane and mints at
  // the head like any other composite once its turn comes. Not reused.
  // settle_special_composite: 0xb0000073 — RETIRED, do not reuse.
  // outbound, ledger -> registrar. D-36's era trophy; see REGISTRAR below.
  award_era_trophy: 0xb000006b,
  // outbound, to the ratchet — the pool backing plus the (T, S) snapshot the
  // floor guard prices against. ONE hop per mint; this is the whole cost the
  // §3.4 decomposition adds to the common path (§4 B5 measures it).
  pool_inject: 0xb0000050,
  // 0xb0000061 (`record_mint`) is RETIRED by D-202: its one reader was the
  // registrar's build clock. Do not reuse.
  // outbound, ONE send, made once by `ignite` (and re-sent by `sync_launch`).
  // P2.A7: three sends collapsed to one with their three receivers. The opcode
  // lives in the RECEIVER's high byte, the same convention `head_update`
  // already follows (0xe0000031 on the market) — the receiver owns its own
  // number space, and the market inherited the whole 0xE0 reservation lane
  // verbatim, so this keeps the book's old value rather than taking a fresh
  // number on 0xF2. 0xf1000005 and 0xf0000004 retired with their contracts and
  // are NOT reused.
  launch_open_market: 0xe0000034,
  // permissionless. Re-sends the head to a peer that missed it (same NoBounce
  // liveness pattern as `sync_launch`).
  sync_head: 0xb0000023,
  // D-189, permissionless: continues a head-advance walk a mint stopped early
  // (`get_walk_pending` = 1). No-op otherwise; unspent value returns.
  advance_head: 0xb000007c,
  // D-196, permissionless and caller-funded (IMPORT_LOT_BLOCK_VALUE, 0.05 GRAM): pulls
  // the frontier block's auction marks in from its lot block once the block starts
  // below `head + window` (`getLotBlockState().dueNow`). Refused 225 when not due;
  // while one is in flight it re-sends the same request (the lot block keeps its words).
  import_lot_block: 0xb000007e,
  // D-196, lot block -> ledger: the import's answer (the lot block keeps its words).
  lot_block_words: 0xb000007f,
  // D-198, PERMISSIONLESS, caller-funded (0.15 GRAM): move block `unsoldFlushed`'s unsold
  // rows (bookmark + forfeit counter per prime) to its lot block once the head has left
  // it (`getUnsoldFlush().dueNow`). Refused 225 while the head is still in the block. The
  // head-advance walk stops LOT_BLOCK_WINDOW_BLOCKS past the cursor.
  flush_unsold: 0xb0000082,
  // D-198, lot block -> ledger: a flushed prime sold; its bookmark, which the ledger
  // forwards to the item as `credit_dividend` (LOW-3).
  lot_block_bookmark: 0xb0000083,
  // D-196, lot block -> ledger: a claim on an already-claimed n; relayed to the
  // market as `mark_rejected`.
  lot_block_refused: 0xb0000080,
  // 0xb0000074 (`open_build`) is RETIRED by D-202 with the built line. Do not reuse.
  // one-shot, from the genesis script only (CONCEPT §6 point 3): seeds T, S and
  // the head that opens minting.
  genesis_seed: 0xb0000040,
  // one-shot, from the genesis script only (§3.4 B1): the market and bounty
  // vault addresses. Cannot be fixed at deploy — the same circular-dependency
  // reason as `set_sinks`.
  set_peers: 0xb0000041,
} as const;

// ---------------------------------------------------------------------------
// Ratchet — shares the 0xB0 high byte with the ledger it split from.
//
// This contract's outbound set was ONE message, the DeDust swap, until D-151
// added §4.3.2's staked reserve: a Tonstakers deposit, a tsTON burn, and one
// tsTON transfer to the LP-governed treasury. There is still no withdraw, no
// sweep and no owner — every destination is a venue address or the treasury,
// every amount is computed by the contract, and no message names a recipient a
// caller chose. That is the §3.4 property, and it survives the addition.
// ---------------------------------------------------------------------------
export const RATCHET = {
  // inbound, from the ledger only
  pool_inject: LEDGER.pool_inject,
  // inbound, permissionless. Cannot be aimed: the destination is the venue.
  flush: 0xb0000006,
  // inbound, from the venue timelock only — the entire admin surface here
  update_venue: 0xb0000010,
  // inbound, one-shot from the genesis script
  set_ledger: 0xb0000051,
  // inbound, one-shot from the genesis script: this contract's OWN PRIMES jetton
  // wallet, so the burn counter (§3.3 / §11.21) can tell a genuine proceeds
  // notification from a forged one. Arms `getBurnStats`; grants no authority and
  // touches no GRAM path. Same circular-address bootstrap as set_ledger.
  set_jetton_wallet: 0xb0000052,
  // outbound, to the DeDust native vault. The swap body's third field is
  // §4.3.1's floor guard `min_out = amount * S / T * (1 + FLOOR_GUARD)`,
  // replacing the pre-v5 `storeCoins(1)` that accepted any fill at any price.
  dedust_swap: 0xea06185d,
  // inbound, from the DeDust native vault: a refused swap's GRAM, handed back.
  // NOT A BOUNCE, and that distinction is load-bearing. DeDust checks `limit`
  // in the POOL, one hop past the vault; the pool commits its refund and then
  // throws (exit 304), so the vault's own transaction SUCCEEDS and a TON bounce
  // — which travels exactly one hop — has nothing to travel from. Verified on
  // mainnet: 6,000 consecutive native-vault transactions, 3,052 inbound swaps,
  // zero bounced inbound messages (GAUNTLET.md R18). The ratchet handled only
  // the bounce until 2026-09-16, so a refused flush left `inFlightFlush` set
  // and error 223 then blocked every later flush permanently.
  //   payout#474f86cf query_id:uint64 payload:(Maybe ^Cell)
  // `payload` is the sender's own `reject_payload` echoed back verbatim.
  dedust_payout: 0x474f86cf,
  // inbound: the ratchet's PRIMES jetton wallet notifying it of swap proceeds
  transfer_notification: TEP74.transfer_notification,
  // outbound, to the notifying PRIMES jetton wallet: burn exactly what arrived
  // (§4.3's proceeds leg; S is never decremented — §3.3). This IS the TEP-74
  // burn opcode — the earlier 0xb0000033 placeholder value here never matched
  // what a real jetton wallet accepts and was corrected with WS1's burn leg.
  dedust_burn: TEP74.burn,

  // -------------------------------------------------------------------------
  // §4.3.2 — THE STAKED RESERVE (D-151). Idle `pending` above a sim-sized
  // liquid reserve is deposited into the GRAM liquid-staking pool Tonstakers
  // runs, held as tsTON and counted in `T` AT COST. Every value below was read
  // from `ton-blockchain/liquid-staking-contract` @ main on 2026-09-20 — file
  // and line are on each entry — and NOT from the GitBook, which publishes no
  // opcodes at all. What that repo's SOURCE says is not proof of what the live
  // pool RUNS: its economic behaviour is governor-settable storage, so
  // `optimistic_deposit_withdrawals` and `deposits_open?` must be read from the
  // live pool's `get_pool_full_data` before mainnet. The WIRE values here are
  // baked into deployed code and do not move.
  // -------------------------------------------------------------------------

  // inbound, permissionless — exactly as `flush` is. Sizes itself from
  // `pending - reserveTarget` and throws if that is below the stake minimum;
  // no caller names an amount, on this or either of the two below.
  stake: 0xb0000053,
  // inbound, permissionless. Callable ONLY when liquid `pending` is under the
  // reserve, i.e. when the floor's standing bid needs the GRAM back.
  unstake: 0xb0000054,
  // inbound, permissionless, ≥ 30 days apart: sends accrued tsTON (held above
  // cost at `lastRate`) to the LP-governed treasury. Realizes, never marks.
  harvest: 0xb0000055,
  // inbound, permissionless — D-155's liveness backstop on the exit state
  // machine. Legal only while an exit is open AND `now() - exitStartedAt` has
  // passed the 72-hour recovery window (2x leg 3's ~36 h round, so it can never
  // abort a leg that is merely waiting its turn). It RESTORES the tranche and
  // credits nothing: `T` is unchanged and there is nothing for a caller to aim.
  recover_exit: 0xb0000057,
  // inbound, one-shot from the genesis script: this contract's own tsTON jetton
  // wallet. Second slot of the circular-address bootstrap `set_jetton_wallet`
  // does for PRIMES, and for the same reason — a jetton wallet is addressed by
  // its owner, so it cannot sit in its owner's deploy data.
  set_tston_wallet: 0xb0000056,

  // outbound, to the Tonstakers pool. Body is the header and nothing else:
  //   deposit#47d54391 query_id:uint64 = InternalMsgBody
  // (`contracts/op-codes.func:41`, `contracts/interaction.tlb:52`). The pool
  // skims a FLAT `DEPOSIT_FEE = 1 GRAM` off the message value and credits the
  // remainder (`contracts/pool.func:79`, `:288-290`), which is why the stake
  // minimum is an economic parameter and not a dust guard.
  tonstakers_deposit: 0x47d54391,
  // outbound, to the ratchet's own tsTON wallet: the TEP-74 burn that IS the
  // withdrawal request. The two flags ride in `custom_payload` as two bare
  // bits, in this order: bit 0 `wait_till_round_end`, bit 1 `fill_or_kill`
  // (`wrappers/JettonWallet.ts:17-19`). An absent or short payload is not a
  // no-op: the pool's `load_bool` underflows inside its own try/catch and the
  // burn is reverted by re-minting the jettons (`contracts/pool.func:190-240`).
  tston_burn: TEP74.burn,
  // inbound, from the Tonstakers pool: an immediate withdrawal that FILLED.
  //   withdrawal#0a77535c query_id:uint64 = InternalMsgBody
  // (`contracts/op-codes.func:43`). Non-bounceable, `CARRY_ALL_BALANCE`. The
  // body carries NO amount, and the value is the filled GRAM plus whatever is
  // left of our own attached gas — the two cannot be separated, which is why
  // the tsTON rate is learned from a DEPOSIT and never from a withdrawal
  // (D-151; it is the finding that deleted the probe-burn design).
  tonstakers_withdrawal: 0x0a77535c,
  // inbound, from a freshly minted payout bill NFT when an immediate withdrawal
  // could NOT be filled and `fill_or_kill` was 0 — leg 3, the ~36 h exit.
  // Non-bounceable, `CARRY_ALL_BALANCE | IGNORE_ERRORS`
  // (`contracts/payout_nft/nft-item.func:193-197`). The bill collection's
  // address is SALTED with `random()` at deploy
  // (`contracts/address_calculations.func:67`) and therefore cannot be
  // precomputed or whitelisted; the ratchet accepts this message from any
  // sender and takes NO accounting action on it, which is what makes accepting
  // it from any sender safe.
  payout_ownership_assigned: TEP62.ownership_assigned,
  // inbound, from the payout collection at round end: the bill's GRAM share.
  // Non-bounceable, `CARRY_ALL_REMAINING_MESSAGE_VALUE`
  // (`contracts/payout_nft/nft-collection.func:262-268`). Same unverifiable
  // sender as above, so the handler is written to be SAFE UNDER FORGERY rather
  // than to authenticate: it credits `pending` and draws down `exiting`, both
  // terms of `T`, so a forged one is arithmetically a donation (D-151).
  payout_distributed_asset: 0xdb3b8abd,
  // inbound, from either jetton wallet after a mint or a mint-back. Arrives
  // non-bounceable with `CARRY_ALL_BALANCE | IGNORE_ERRORS`, so the catch-all
  // `throw 101` would eat it and paint the trace red while the balance looked
  // right — the 2026-09-17 failure class in `MISTAKES.md`, exactly.
  excesses: TEP74.excesses,
} as const;

// ---------------------------------------------------------------------------
// Registrar — high byte 0xB0. Holds no protocol GRAM at all.
//
// Its only outbound messages are a trophy re-engraving's fee to the main collection
// (`naming_paid`, D-212) and the payer's change, so §3.4's declared-liability-is-zero
// property holds. D-202 deleted the built number line and everything it sent.
// ---------------------------------------------------------------------------
export const REGISTRAR = {
  // inbound, one-shot from the genesis script
  set_ledger: 0xb0000060,
  // D-202 DELETED THE BUILT NUMBER LINE and these opcodes with it. THE NUMBERS
  // ARE NOT RECYCLED:
  //   record_mint:      0xb0000061   prove_ownership:  0xb0000063
  //   ownership_proof:  0xb0000064   open_build:       0xb000007d
  //   prove_input:      0xb0000075   close_build:      0xb0000076
  //   expire_build:     0xb0000077   set_generators_collection: 0xb0000078
  //   set_constellation_collection: 0xb0000071
  //   constellation_built: 0x94000001
  //   receive_generator (TEP-62 ownership_assigned, no longer accepted here)
  // and, retired earlier by D-102/D-107: 0xb0000062, 0xb0000065, 0xb0000066,
  // 0xb0000068, 0xb0000069, 0xb000006f, 0xb000006a.
  //
  // inbound, one-shot from the genesis script: the MAIN collection's address,
  // which a trophy re-engraving's fee is sent through (D-212). Kept its opcode when
  // D-202 dropped the item code and the bounty vault from the body.
  set_collection: 0xb0000067,
  // inbound, from the LEDGER only. D-36 (§4.7, §7): the ERA TROPHY — permanent
  // naming rights over an era's primorial, to that era's single highest
  // recruiter. Fired inside the primorial mint, beside `pay_era_bounty` and
  // never out of it: the bounty still pays 100% to the primorial's MINTER.
  //
  // The winner is decided on the ledger (that is where §4.6's activation edge
  // is) and delivered here; the registrar authenticates on the sender and does
  // not recompute it.
  award_era_trophy: LEDGER.award_era_trophy,

  // D-212 RETIRED the burn sink's door — `set_sink` 0xb000006c and 0xb000006e
  // (`sink_annotate`). Do not reuse.
  //
  // inbound, from the holder of an ERA TROPHY `n`: its engraving (§4.7.1). The
  // FIRST is free (D-179); every later one carries `renameFee` plus gas and the
  // registrar sends the fee to the floor through the collection (`naming_paid`,
  // D-212). Every refusal refunds rather than throws.
  annotate: 0xb000006d,
  // 0xb000006f (`credit_bond`) is RETIRED with the registration bond (D-102).
  // Do not reuse.
  // inbound, PERMISSIONLESS in shape — only the CURRENT HOLDER passes the check.
  // D-14 (§4.7, §11.13 closed 2026-08-16): the era trophy is TRANSFERABLE.
  //
  // TROPHIES ONLY. `primorial` must be one of §7's eight primorials or it throws
  // `reg_not_primorial` (914). Ordinary prime naming rights stay "immediately and
  // permanently" fixed (§4.7.1, §5.1) — D-14's carve-out is for era trophies and
  // nothing else, and the gate is the SAME closed eight-element `isPrimorial`
  // predicate that `isNamedPrime` excludes on, so "transferable" and "not a prime
  // for predicate purposes" cannot drift apart.
  //
  // No admin path, no operator override, no ledger arm: the ledger ISSUES a
  // trophy and has no say in where it goes afterwards. And no GRAM moves — the
  // registrar holds none (§3.4), so this is one dictionary write and the price,
  // if there was one, was settled somewhere else entirely.
  transfer_trophy: 0xb0000070,

  // outbound, to the MAIN collection (D-212): a paid trophy re-engraving's fee,
  // which the collection forwards to the ledger as a pure floor step.
  // (0xc0000008, `relay_annotation`, is RETIRED by D-212. Do not reuse.)
  naming_paid: 0xc000000a,
} as const;

/**
 * The MINT's structural bound, read off `primes_ledger.tolk` rather than retyped where it
 * is drawn: `/me`'s personal-best ladder (`DESIGN.md` U153) draws ω(n) against it.
 */
export const MINT_LIMITS = {
  /** `OMEGA_MAX` — the most factor entries one mint may submit (37# is the largest primorial
   *  under the reservable cap, so ω = 12 is the bound). Consensus-enforced, not economic. */
  OMEGA_MAX: 12,
} as const;

/**
 * The MARKET's bound on `n`, read off `primes_market.tolk` (D-11/D-18, asserted on every entry
 * point that takes an `n`). The head advances one per mint, so this is also the largest number
 * anyone can hold in practice — which is why the number pages' search titles (SEO_PLAN 4.1,
 * `shared/numberMeta.ts`) factor up to it and no further.
 */
export const MARKET_LIMITS = {
  /** `AUCTIONABLE_MAX` = 10000 · 2³² − 1 ≈ 4.29·10¹³ (14 digits). */
  AUCTIONABLE_MAX: 42949672959999n,
} as const;

// ---------------------------------------------------------------------------
// THE STAKE MASTER AND ITS POSITION CHILDREN — high byte 0x91. CONCEPT §5.3,
// DECISIONS D-168. Declared in `shared/schemas/stake.tlb`, implemented by
// `contracts/contracts/primes_stake.tolk` (global state: the stream, the
// accumulator, the totals) and `contracts/contracts/primes_stake_position.tolk`
// (one child per staking wallet, config 43's reason — the treasury/LP-child split).
//
// A wallet locks PRIMES for a term (30 d / 3 m / 6 m / 1 y, `staking.tier_term_seconds`)
// and earns PRIMES while it runs, pro rata to `amount × tierWeight`
// (`staking.tier_weights`). The rewards are the treasury's PRIMES, sent once per
// epoch by its permissionless `distribute()` (TREASURY below) and streamed over the
// next epoch. Earning stops at `maturesAt`; principal returns only at or after it
// (ST-3). Nothing here touches `k`, `S`, `T` or GRAM: the master owes PRIMES only.
//
// THE CHILD'S ADDRESS IS THE AUTHENTICATION, as on the treasury: the master
// re-derives `positionAddress(owner)` for every `settle`. Every settle is a round
// trip owner → child → master → child (+ PRIMES to the owner), and the child's
// `inFlight` flag, cleared only by the master's reply, is what makes a double
// payout impossible.
//
// 0x90 is the bounty vault's; 0x91 is this family's ALONE (the voucher program
// moved to 0x9a under GAUNTLET.md X15).
// ---------------------------------------------------------------------------
export const STAKE = {
  // --- the master ---
  // inbound, one-shot from the genesis script: the master's OWN PRIMES wallet
  // (D21-family bootstrap) and THE TREASURY — the one sender whose `SBGT` budget is
  // accepted. The treasury is bootstrapped here, not deploy data, because the
  // treasury's own deploy data names the master (`distribute()`'s recipient).
  set_wallet: 0x91000001,
  // inbound, from this contract's own PRIMES wallet: a STAKE (`STKL` + tier), a
  // BUDGET (`SBGT`, sender = the treasury), or anything else — which is REFUNDED to
  // the sender, never kept (D-168: a stake with no tier has no term).
  transfer_notification: TEP74.transfer_notification,
  // inbound, from the owner's OWN child: settle one position. `mode` 0 CLAIM, 1
  // RELOCK (`new_tier`), 2 WITHDRAW (principal + reward in one transfer), 3 EXPIRE
  // (bank the prorated tail on the child; no transfer).
  settle: 0x91000002,
  // outbound, to the owner's own jetton wallet via the master's: rewards, a matured
  // principal, or a refund.
  jetton_transfer: TEP74.transfer,

  // --- master → child ---
  // credit a new position. Deploys the child on a first stake. Carries the
  // `reward_debt` pinned at the accumulator AFTER the stake's own accrue.
  stake_credit: 0x91000010,
  // the reply half of `settle`: new debt, settle time, expiry and banked, and the
  // clearing of `inFlight` — or the deletion, on a withdraw.
  stake_settled: 0x91000011,
  // BOUNCE RECOVERY: a withdraw transfer bounced. The position comes back MATURED
  // and EXPIRED with the reward BANKED separately from the principal.
  restore_stake: 0x91000012,

  // --- inbound, on the child, from the OWNER (expire: from ANYONE) ---
  // pay one position's accrued PRIMES (plus anything banked). No maturity gate.
  claim: 0x91000021,
  // restart one position's term at `now` under a new tier, paying out on the way.
  // Refused as a DOWNGRADE while the term runs (`stake_relock_downgrade`).
  relock: 0x91000022,
  // at or after `matures_at` only: principal + final reward in ONE transfer.
  withdraw: 0x91000023,
  // PERMISSIONLESS, at or after `matures_at`: settle without a transfer — the
  // prorated tail is banked on the child and the weight leaves `total_weight`.
  // Idempotent (an already-expired position returns). The keeper's poke.
  expire: 0x91000024,
} as const;

/**
 * The `forwardPayload` tag a stake carries, followed by `tier:uint8` (0..3). Four ASCII
 * bytes so a raw body dump reads. A transfer without it (or with a tier above 3) is
 * REFUNDED (D-168).
 */
export const STAKE_ACTION_LOCK = 0x53544b4c; // "STKL"
/**
 * The `forwardPayload` tag `distribute()` writes into the treasury's budget transfer
 * (D-168, §5.5.3). The master streams a transfer as a budget ONLY when it carries this
 * tag AND the notification's `sender` is the treasury; anything else from the treasury
 * is refunded.
 */
export const STAKE_ACTION_BUDGET = 0x53424754; // "SBGT"

/**
 * The four stake tiers, index = the `tier:uint8` a stake payload carries.
 * `termSeconds` is `staking.tier_term_seconds` and `weight` is `staking.tier_weights`
 * (D-168). The master's `getTierTerms` / `getTierWeights` are the §9.1 authority; this
 * is the convenience copy (SimCrossCheck asserts they agree).
 */
export const STAKE_TIERS = [
  { label: '30 days', termSeconds: 2592000, weight: 5 },
  { label: '3 months', termSeconds: 7776000, weight: 6 },
  { label: '6 months', termSeconds: 15552000, weight: 7 },
  { label: '1 year', termSeconds: 31536000, weight: 8 },
] as const;

/** `staking.acc_scale` = 2^64 — the stake master's accumulator scale. */
export const STAKE_ACC_SCALE = 18446744073709551616n; // 2^64

/** Nominal `forward_ton_amount` a STAKE's transfer must carry (`getStakeMinForward`):
 *  a child deploy or a refund transfer, whichever the payload decides. */
export const STAKE_MIN_FORWARD_NANOTON = 150000000n; // 0.15 GRAM
/** Nominal GRAM a claim / relock / withdraw to the CHILD must carry
 *  (`getPositionMinForward().ownerMinForward`). */
export const STAKE_POSITION_MIN_FORWARD_NANOTON = 200000000n; // 0.20 GRAM
/** Nominal GRAM an `expire` poke must carry — no transfer behind it
 *  (`getPositionMinForward().expireMinForward`). */
export const STAKE_EXPIRE_MIN_FORWARD_NANOTON = 100000000n; // 0.10 GRAM

// ---------------------------------------------------------------------------
// THE BURN SINK (high byte 0x92) is DELETED by D-212 (CONCEPT §5.2): a naming is
// paid in GRAM on the collection now, and the sink's one action went with it.
// Retired, not recycled — `set_wallet` 0x92000001, `floor_quote` 0x92000002,
// and the action tags SINK_ACTION_ANNOTATE 0x414e4e54 ("ANNT"), BOND 0x424f4e44
// and CERM 0x4345524d.
// ---------------------------------------------------------------------------

// D-202 DELETED the constellations collection (0x93), the constellation item
// (0x94), the prime generators collection (0x98) and the generator item (0x99),
// with the "CONS" discovery program tag (0x434f4e53), GENERATOR_FORWARD_TAG
// (0x544f4f4c), GENERATOR_REFUSAL_TAG (0x52454655) and the invite signer's
// INVITE_LIST_TAG (0x494e5654). None of these values is reused.

// ---------------------------------------------------------------------------
// THE TREASURY VESTING LOCK — high byte 0x95. CONCEPT §2 point 4 / §3.3 / §6
// point 3; DECISIONS D-77 (amends D-46 points 1 and 3), D-100 point 6, D-166.
//
// D-166 DELETED the operator's instance: the operator holds no genesis PRIMES.
// The one deployed instance pays the governed treasury contract. The history
// below is how the contract came to exist.
//
// D-46 gave the operator a one-time, disclosed genesis PRIMES allocation
// (`T0_nominal · L`) and minted it straight to their own wallet, fully liquid.
// D-77 keeps the allocation and its exact size and removes the liquidity: the
// same mint lands on this contract, and leaves in NINE equal tranches — one at
// genesis, then one every 90 days, the last at day 720 (24 months).
//
// The ninth unlock is the one at t = 0, and it is mechanical rather than
// generous: D-46 point 3 premises the whole allocation on being the PRIMES side
// of the DeDust pool `flush()` trades against (§4.3.1), so a vest with no
// genesis tranche leaves `flush()` nothing to buy against for the first quarter.
//
// NO ADMIN SURFACE: no owner, no cancel, no pause, no re-schedule, no
// beneficiary change. `release` is permissionless and can only ever pay the
// deploy-fixed beneficiary, which is what makes the absence of a withdraw path
// greppable rather than asserted (§8's standard).
//
// It moves no GRAM and touches neither `T` nor `S` — the allocation was already
// counted into `S` at genesis (§3.3) — so `p_f` is identical with and without
// it. Zero GRAM liability, absent from the §3.4 solvency check.
//
// 0x91/0x92 are the staking and burn sinks', 0x93/0x94 the retired constellations pair;
// 0x95 is the next free byte and the right neighbourhood — like the sinks, this
// is a PRIMES-custody contract with no GRAM path.
// ---------------------------------------------------------------------------
export const VESTING = {
  // inbound, one-shot from the genesis script: this contract's OWN PRIMES jetton
  // wallet, the same circular-address bootstrap as the vault's `set_wallet`
  // (D21) and the staking sink's. It ALSO stamps `start_time`, so the vest clock
  // dates from custody rather than from a deploy-data timestamp that could
  // precede funding — and no timestamp has to survive testnet clock skew in
  // init data. Delaying it only delays the operator's own money.
  set_wallet: 0x95000001,
  // inbound, PERMISSIONLESS — the venue timelock's `execute` precedent: the
  // beneficiary cannot withhold execution of an already-public, already-matured
  // schedule. Harmless because no field here names a recipient. Transfers every
  // matured-but-unreleased tranche in ONE message, since `unlocked` is derived
  // from the clock rather than counted up per call.
  release: 0x95000002,
  // outbound, to the lock's own jetton wallet, on `release` only.
  jetton_transfer: TEP74.transfer,
} as const;

// ---------------------------------------------------------------------------
// THE GOVERNED TREASURY — high byte 0x96. CONCEPT §5.5; DECISIONS D-100, as
// amended by D-147, D-167 and D-168. Declared in `shared/schemas/treasury.tlb`,
// implemented by `contracts/contracts/primes_treasury.tolk` (global state) and
// `contracts/contracts/primes_lp_position.tolk` (one child per owner).
//
// TWO CONTRACTS, ONE MECHANISM, AND THE SPLIT IS A PROTOCOL LIMIT: config 43's
// 65,536-cell account ceiling kills a positions dictionary around 20,000 entries,
// so the treasury holds GLOBAL state (the proposal book, the balances, the
// electorate's size) and one child per wallet holds that wallet's LP positions.
// The child's address is the authentication: the treasury re-derives
// `positionAddress(owner)` and compares it to the sender.
//
// LP CUSTODY BUYS A VOTE AND NOTHING ELSE (D-168 deleted the miner). Four lock
// terms, every one of which votes while it runs.
//
// THERE IS NO ADMIN INBOUND (D-100 point 7). The treasury spends by exactly two
// routes (TR-2): a PASSED PROPOSAL (`execute`, permissionless, capped at
// `treasury.proposal_cap_bps` of that asset's balance AT EXECUTE TIME) and
// `distribute()` (D-168 — PRIMES to the stake master only, at most once per
// interval, `budget = primesBalance * rateBps * interval / (10000 * 86400)`).
// NOTHING HERE MINTS (TR-4).
// ---------------------------------------------------------------------------
export const TREASURY = {
  // --- inbound, genesis ---
  // one-shot from the genesis script: this contract's OWN LP, PRIMES and tsTON
  // jetton wallets, in one message (D21-family bootstrap).
  set_wallets: 0x96000001,

  // --- inbound, jettons ---
  // from the LP wallet (a deposit, `TDEP` + tier) or the PRIMES / tsTON wallet
  // (the vest, a donation, `harvest()`). An absent or unrecognised LP tag REFUNDS.
  transfer_notification: TEP74.transfer_notification,

  // --- inbound, from the sender's OWN child only ---
  // D-147 / D-168: a relock restarted one position's term under `new_tier`; move
  // its vote weight in `eligible_weight`. Pays nothing and awaits no reply.
  relock_vote: 0x96000002,
  // move a position's LP out — to the owner (`to_sink = 0`, once matured) or to
  // the LP sink (`to_sink = 1`, any time, D-100 point 4). `expired` says whether an
  // `expire_vote` already took its vote weight out of `eligible_weight`.
  withdraw_lp: 0x96000003,
  // cast ONE position's vote weight on one proposal (D-147). The child computes
  // the weight — `amount x voteMultiplier(tier)` while the term runs, else it
  // refuses — and RECORDS the vote on itself before sending (D-188 point 7): the
  // treasury keeps only the totals. `record_until` is when the child forgets it;
  // the treasury refuses a proposal that closes later (1203).
  vote: 0x96000004,
  // open a proposal. Refused below `treasury.propose_min_bps` of `eligible_weight`
  // and while the proposer has another open proposal (D-100 point 8).
  propose: 0x96000005,
  // D-147, forwarded from the child's permissionless `expire`: take a matured
  // position's vote weight out of `eligible_weight`. It changes NO rule.
  expire_vote: 0x96000007,

  // --- inbound, permissionless ---
  // execute a passed proposal after `closes` and before `closes + vote duration`
  // (D-188 point 7). A BOUNCED execute resets `executed`.
  execute: 0x96000006,
  // D-168 / §5.5.3: send one epoch's budget to the stake master. At most once per
  // `staking.epoch_seconds` (clock-divided); `treasury_distribute_early` before
  // that, `treasury_distribute_dust` on an empty treasury. The caller funds the
  // hop (`getTreasuryMinForward().distributeMinForward`) and gets the change back.
  // A bounce restores the balance AND the previous `last_distribute_time`.
  distribute: 0x96000008,
  // D-188 point 7: delete a proposal nothing can happen to any more — failed and
  // closed, or past its execute window (`closes + vote duration`). Moves no asset.
  // `getPrunable(seq)` answers it without the throw.
  prune: 0x96000009,

  // --- outbound, treasury -> the owner's child ---
  // credit a new position. Deploys the child on a first deposit.
  lp_credit: 0x96000010,
  // 0x96000011 was `set_reward_debt`, the miner's settle reply — deleted with the
  // miner by D-168. Retired, not recycled.
  // the reply half of `withdraw_lp`: the LP has been sent, delete the position.
  confirm_withdraw: 0x96000012,
  // BOUNCE RECOVERY, treasury -> child: an LP transfer bounced, so the position is
  // put back MATURED and EXPIRED and the owner can retry.
  restore_position: 0x96000013,

  // --- inbound, from the OWNER, on the child ---
  // 0x96000020 (`request_withdraw`, D-147) and 0x96000022 (`claim`, the miner's
  // payout, D-168) are RETIRED rather than recycled.
  //
  // take the LP back. One message, allowed from the instant the term matures.
  withdraw: 0x96000021,
  // forward one position's LP to the LP sink — locked depth, forever, no wait.
  to_sink: 0x96000023,
  // cast ONE named position's vote; forwarded to the treasury as `vote` above.
  // A second vote from the same position on the same proposal is refused HERE
  // (1155) against the child's own record (D-188 point 7).
  position_vote: 0x96000024,
  // open a proposal on ONE named position's weight; forwarded as `propose`.
  position_propose: 0x96000025,
  // D-147. Restart one position's term at `now` under a new tier. Refused as a
  // downgrade before maturity (`new_tier >= tier || now >= matures_at`).
  // Forwarded to the treasury as `relock_vote`.
  relock: 0x96000026,
  // D-147, and THE ONE MESSAGE ON EITHER CONTRACT WITH NO SENDER CHECK. Mark a
  // matured position's vote weight gone, here and (via `expire_vote`) in the
  // treasury's `eligible_weight`. It moves no asset and changes no rule.
  expire: 0x96000027,

  // --- outbound, TEP-74 ---
  // every asset this contract can move — PRIMES on a proposal or `distribute()`,
  // LP on a withdrawal or a sink-forward, tsTON on a proposal — moves as a plain
  // TEP-74 transfer from the treasury's own wallet.
  jetton_transfer: TEP74.transfer,
  // outbound, GRAM only, on `execute` of an asset-0 proposal. It carries a body so
  // the bounce handler gets the proposal sequence back to reset `executed`.
  ton_payout: 0x96000014,
  // outbound, D-194, on `execute` of a venue-confirm proposal (asset 3): to the venue
  // timelock, `seq` = the timelock record the vote confirmed. Moves no value; a bounce
  // (stale seq) resets `executed` like a GRAM payout's.
  confirm_venue: 0xa0000006,
} as const;

/**
 * The `forward_payload` tag an LP transfer to the treasury must carry. Permanent: it
 * ends up in transfers already on chain. Four ASCII bytes, so a raw body dump reads.
 */
// "TDEP" — a custody deposit. Followed by `tier:uint3` (0..3 since D-168).
export const TREASURY_ACTION_DEPOSIT = 0x54444550;
// D-167 deleted the second tag, "TDON" (0x54444f4e, an LP donation to the
// treasury itself), with the treasury's own LP. It now refunds like any
// unrecognised tag; do not reuse the value.

/**
 * The four custody tiers, in order, index = the `tier:uint3` a deposit payload carries.
 *
 * `termSeconds` is `treasury.tier_term_seconds` — a LOCK TERM measured from the deposit
 * (D-147). The position votes with `amount x voteMultiplier` (`treasury.vote_multipliers`)
 * while the term runs, and earns nothing (D-168). The treasury's `getVoteMultipliers` /
 * `getTierTerms` are the §9.1 authority; these are the convenience copy.
 */
export const TREASURY_TIERS = [
  { label: '30 days', termSeconds: 2592000, voteMultiplier: 1 },
  { label: '3 months', termSeconds: 7776000, voteMultiplier: 3 },
  { label: '6 months', termSeconds: 15552000, voteMultiplier: 10 },
  { label: '1 year', termSeconds: 31536000, voteMultiplier: 30 },
] as const;

/**
 * D-214: LP locked forever through a position's `to_sink` keeps voting, as ONE per-wallet
 * total on the child (`getForever()`), weighted `amount x FOREVER_VOTE_MULTIPLIER`
 * (`treasury.forever_vote_multiplier`) and never maturing. Not a tier — it has no term,
 * no deposit and no relock — so it is not in `TREASURY_TIERS`. It votes and proposes under
 * the reserved position id `FOREVER_POSITION_ID`. The treasury's
 * `getForeverVoteMultiplier()` is the §9.1 authority; this is the convenience copy.
 */
export const FOREVER_VOTE_MULTIPLIER = 100;
export const FOREVER_POSITION_ID = 0xffffffff;

/**
 * The three proposable assets, `asset:uint8` on the wire. LP is not one (D-167): the only
 * LP the treasury holds is the depositors', and TR-5 says a vote never moves it.
 *
 * `TSTON` is D-151 / CONCEPT.md §4.3.2's harvested staking yield: the ratchet stakes the
 * idle part of `pending` into Tonstakers and `harvest()` sends the ACCRUED tsTON — never
 * the cost basis, which stays a term of `T` — to this treasury as a plain TEP-74 transfer.
 */
export const TREASURY_ASSET = { GRAM: 0, PRIMES: 1, TSTON: 2, VENUE: 3 } as const;
// `VENUE` (D-194) is not an asset: a venue-confirm proposal. `amount` is the venue
// timelock's queued-record `seq`, `dest` is the timelock, and it moves no value.

/** D-194: what an `execute` of a venue-confirm proposal must attach (the contract's
 *  `VENUE_CONFIRM_GAS`). Nominal; a real sender adds a margin. */
export const TREASURY_VENUE_CONFIRM_GAS_NANOTON = 30000000n;

/**
 * Nominal GRAM a caller must forward with a treasury-bound message: enough for the most
 * expensive outcome (a jetton transfer that may deploy the recipient's wallet, plus a
 * hop to the child). Per CLAUDE.md a real sender adds a margin.
 */
export const TREASURY_MIN_FORWARD_NANOTON = 150000000n;
/** Nominal GRAM a `distribute()` caller must attach: the transfer hop (0.1) plus the
 *  0.05 GRAM forwarded so the stake master's wallet raises the notification. */
export const TREASURY_DISTRIBUTE_MIN_FORWARD_NANOTON = 150000000n;

// ---------------------------------------------------------------------------
// THE LP SINK — high byte 0x97. CONCEPT §5.5; DECISIONS D-100 points 4 and 9.
//
// LOCKED DEPTH. DeDust PRIMES/GRAM LP receipts go in and NOTHING comes out —
// this contract declares no outbound message type at all, which is a stronger
// statement than "no withdraw path" and is checkable by grepping the compiled
// cell for SENDRAWMSG (`contracts/tests/LpSink.spec.ts` does exactly that).
//
// WHY A SINK AND NOT A TEP-74 BURN (D-100, "options not taken"): a burn needs a
// counter somebody maintains off-chain to be readable, whereas a sink's locked
// depth IS its jetton wallet balance and `getLocked()` is the same number twice.
//
// LOCKED DEPTH IS NEVER SUMMED INTO `T` (D-100 point 4). A pool's GRAM/PRIMES
// composition moves with every trade, so an LP-derived term is non-monotonic and
// would void §5's ratchet theorem. The floor and the liquidity are two separate
// guarantees on two separate panels, and every surface that shows locked depth
// must say which of the two it is showing.
//
// 0x91/0x92 are the staking and burn sinks', 0x93/0x94 the retired constellations pair,
// 0x95 the vesting lock, 0x96 the treasury; 0x97 is the next free byte.
// ---------------------------------------------------------------------------
export const LP_SINK = {
  // inbound, one-shot from the genesis script: this contract's OWN DeDust LP
  // jetton wallet. The same circular-address bootstrap as the burn sink's and
  // the vesting lock's `set_wallet` — a TEP-74 wallet is addressed by its owner,
  // so the sink cannot embed its own wallet in its own address-determining data.
  set_wallet: 0x97000001,
  // inbound, from that wallet ONLY: LP arriving, forever. No payload is needed
  // or read — this contract has exactly one thing it can do with a deposit.
  transfer_notification: TEP74.transfer_notification,
  // THERE IS NO OUTBOUND OPCODE, AND ITS ABSENCE IS THE POINT.
} as const;

// ---------------------------------------------------------------------------
// `BANK` IS DELETED. This paragraph is its tombstone; do not re-add the export.
//
// It was `{...LEDGER, flush: RATCHET.flush}` — a compatibility re-export left over
// from the v5 decomposition, and the last live code carrying the retired "bank"
// vocabulary (CONCEPT.md §3.4; the `/bank/*` route namespace went in P2.C2). Its
// four read names mapped by VALUE, across two different contracts:
//
//     BANK.mint           0xb0000002  ->  LEDGER.mint
//     BANK.claim_tribute  0xb0000004  ->  LEDGER.claim_tribute
//     BANK.sync_head      0xb0000023  ->  LEDGER.sync_head
//     BANK.flush          0xb0000006  ->  RATCHET.flush      <- NOT a LEDGER opcode
//
// That last row is why the alias existed and why it had to go: `flush` belongs to
// the RATCHET and was folded in beside the ledger's ops, so `BANK.*` told a reader
// nothing about which contract a message was addressed to. The split is not
// cosmetic — `pending` (the ratchet's, nobody's money) and `owed` (the ledger's,
// the prime owners') are deliberately two pools in two contracts so that
// `balance ≈ declared liability` is checkable per contract in one get-call (§3.4).
// A name spanning both defeats exactly that reading.
//
// The namespaces do not overlap, so a mis-swap is caught by `tsc` and never reaches
// the wire: LEDGER has no `flush`, RATCHET has no `sync_head`. Verify by value
// anyway when touching an opcode.
//
// Callers repointed at deletion: `webapp/src/chain/messages.ts` (the production
// mint/flush message builder), `backend/event-poller/src/decode.ts` (the wire
// decoder, 9 sites), `backend/keeper/src/chain.ts` (2 sites) and two tests.
//
// It was trimmed before it was cut. `update_venue`, `dedust_swap` and `dedust_burn`
// were removed from this alias (GAUNTLET.md A2, iteration #45): all three had zero
// callers, and `dedust_swap` carried 0xb0000032 — a value that is not the DeDust
// swap (0xea06185d, `RATCHET.dedust_swap`) but IS `BOUNTY_VAULT.pay_era_bounty`.
// A stale alias that resolves to a live, unrelated opcode is the worst kind, and
// that finding is the reasoning that finished the job here.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Collection — high byte 0xC0. `contracts/wrappers/PrimesCollection.ts` reads
// its `CollectionOpcodes` table from here — as every wrapper in that directory
// now does, so the header's "exactly once, and nowhere else" is true of the
// TypeScript surface.
// ---------------------------------------------------------------------------
export const COLLECTION = {
  // inbound, from the LEDGER only, on every mint.
  mint_item: 0xc0000001,
  // outbound, collection to item, on `mint_item`: the item's own deploy of
  // itself, carrying the original `mint_item` whole (V28). Received (and
  // re-declared byte-for-byte) by ITEM below.
  populate: 0xc0000002,
  // outbound, to the ledger, from the bounce of a refused `populate` (V28).
  mint_item_refused: LEDGER.mint_item_refused,
  // one-shot, from the genesis script only: the ledger address. Cannot be
  // fixed at deploy — the collection's own init data determines the ledger's
  // computed item addresses, a circular dependency (D7).
  set_ledger: 0xc0000003,
  // 0xc0000004 (`set_auction`) is RETIRED by D-20, and this file was the last
  // place it was still a live key anyone could import and send (GAUNTLET.md X16).
  // It was D-17's genesis-auction bootstrap, the same one-shot pattern as
  // `set_ledger` above; D-20 deleted the genesis lot and the market's own direct
  // `mint_item` send, which left the collection with a SECOND minting authority
  // that nothing ever used. `primes_collection.tolk` has had no arm for it since,
  // and `docs/audit/wire-format.md` listed it as sent-never-handled — a value with
  // no sender and no receiver, exported anyway. Do not reuse it.
  //
  // 0xc0000005 (`claim`) and 0xc0000007 (`reclaim`) are RETIRED by D-106: with
  // patron mode gone no item is ever ownerless, so there is nothing to claim
  // and nothing to reclaim. Do not reuse either.
  // TEP-66 royalty request/response — standard opcodes, reused verbatim, and
  // handled by `primes_collection.tolk`. Backfilled here from
  // `contracts/wrappers/PrimesCollection.ts`'s local table, which carried the
  // only declaration of the pair for this contract.
  get_royalty_params: 0x693d3950,
  report_royalty_params: 0xa8cb00ad,
  // D-212 (§4.7.1). inbound, PERMISSIONLESS: name number `n` with the fee attached
  // (`getNaming()`). Relayed to item(n) as `item_name`, bounceable; a bounce (no
  // item at that address) refunds the sender. 0xc0000008 (`relay_annotation`) and
  // 0xc1000007 (`item_annotate`) are RETIRED by D-212. Do not reuse.
  name_number: 0xc0000009,
  // outbound, collection -> item. Declared on ITEM below under the same name.
  item_name: 0xc1000008,
  // inbound, from item(n) or the registrar only: a naming's fee, forwarded to the
  // ledger as `royalty_to_ratchet` (T rises, S does not).
  naming_paid: REGISTRAR.naming_paid,
} as const;

// ---------------------------------------------------------------------------
// NFT item — high byte 0xC1 (standard TEP62.transfer etc. also apply)
// ---------------------------------------------------------------------------
export const ITEM = {
  // inbound, from the COLLECTION only, on deploy. High byte 0xC0, not 0xC1 —
  // it is the collection's own outbound opcode; declared here too because the
  // item is the one that decodes and acts on it.
  populate: COLLECTION.populate,
  // inbound, standard TEP-62 — declared rather than merely implied.
  transfer: TEP62.transfer,
  // inbound, from the ledger only (deploy-time state init carries the initial fields;
  // this op is used for post-deploy credits only)
  credit_tribute: LEDGER.credit_tribute, // same wire opcode as the ledger's outbound send
  // inbound, from the ledger only (D-188 point 4)
  credit_dividend: LEDGER.credit_dividend,
  // outbound, to the ledger: the reply to credit_dividend
  dividend_credited: LEDGER.dividend_credited,
  // outbound, to the ledger, from Populate whenever a held split rode in (V28)
  mint_confirmed: LEDGER.mint_confirmed,
  // inbound, from the owner (current NFT holder) only
  claim_tribute: 0xc1000001,
  // outbound, to the ledger
  claim_tribute_relay: LEDGER.claim_tribute,
  // ---- RETIRED BY D-106 ----
  // 0xc1000003 (`grant_claim`), 0xc1000004 (`grant_reclaim`),
  // 0xc1000005 (`release_purse`) and 0xb0000043 (`record_patron_link`) were the
  // ownerless-item lifecycle. D-106 deleted patron mode, so a gifted number is
  // owned from block one and none of the four has anything to act on. Do not
  // reuse the values.
  // inbound, from the LEDGER only, on a referral payout: the ledger cannot read
  // an item's owner synchronously mid-mint, so it forwards the referral GRAM to
  // `ItemAddress(key)` and the item — which knows its own owner — relays it on.
  forward_to_owner: 0xc1000002,
  // inbound, permissionless (D-62/GAUNTLET.md D9.1): a composite item is
  // endowed once at deploy and never topped up, giving it a multi-year but
  // finite rent runway. Named so the affordance ("keep this number alive")
  // is discoverable, though the mechanism — the value landing in the
  // contract's balance — is the same one any incoming message already uses.
  top_up: 0xc1000006,
  // inbound, from the COLLECTION only (D-212): a naming. The item checks the payer
  // is its CURRENT OWNER and the value covers `nameFee` (first) or `renameFee`
  // (after), keeps the text (one cell, no refs), and refunds the whole value on any
  // refusal.
  item_name: COLLECTION.item_name,
  // outbound, to the collection: the fee, on its way to the floor.
  naming_paid: COLLECTION.naming_paid,
} as const;

// ---------------------------------------------------------------------------
// PRIMES jetton master — high byte 0xD0 (TEP-74; mint authority = ledger).
// GAUNTLET.md A2.2: contract-local bootstrap opcodes, undeclared until now.
// ---------------------------------------------------------------------------
export const JETTON_MASTER = {
  // inbound, from the LEDGER only: an ordinary mint (referral/dividend etc.).
  mint_op: 0xd0000001,
  // inbound, from the genesis script only, pre-seal: the founder allocation.
  mint_genesis: 0xd0000002,
  // one-shot, from the genesis script only: closes `mint_genesis` for good.
  seal_authority: 0xd0000003,
  // one-shot, from the genesis script only, same circular-address bootstrap
  // as COLLECTION.set_ledger (D7).
  set_ledger: 0xd0000004,
} as const;

// ---------------------------------------------------------------------------
// THE MARKET — high byte 0xF2 for the lot lanes, 0xE0 for what the ledger
// sends it.
//
// DECISIONS.md D-3 folds three price-discovery contracts into one. The 0xE0
// family was the reservation lane; D-90 deleted the escrow and every claim
// opcode in it (tombstones below), and only the ledger -> market signals
// (`head_update`, `launch_open_market`) still live there. The LOT lanes are 0xF2.
//
// NUMBERING NOTE — READ BEFORE "FIXING" THIS. 0xF0 (genesis auction) and 0xF1
// (trophy auction) are DELIBERATELY NOT REUSED. Both retire with their
// contracts, and their values are left unassigned so a stale sender — a wallet
// with a queued `take`, an old indexer replaying history — hits `wrong_opcode`
// instead of landing on an unrelated handler in the market. The unified
// mechanism takes 0xF2, which was free and is adjacent to the family it
// replaces.
// ---------------------------------------------------------------------------
export const MARKET = {
  // ---- the lot lanes (0xF2), all permissionless ----
  // Opens an ASCENDING lot AND places the opener's own bid, which must be
  // >= P0(n). You cannot open a lot you are unwilling to buy, which deletes the
  // no-bid, expiry, reserve-not-met and refund-the-opener states outright.
  // Carries the proof `kind` selects (a factorization for a composite, nothing
  // for a prime the contract checks itself), verified at open; winning MINTS
  // the number in the closing transaction (D-90 — no reservation, no claim).
  //
  // D-30/D-88: ANY `n <= AUCTIONABLE_MAX` ahead of the head that is not a
  // primorial may be opened, prime or composite, at any distance. The `D_MIN` score gate is
  // deleted (D-30) and the `MIN_AUCTION_DISTANCE` liveness gate is deleted
  // (D-45) — this is the only route to a composite ahead of the head, so a
  // gate is a refusal to sell rather than a redirect. D-45: this send also
  // fires `mark_off_head` to the ledger in the same transaction, taking `n`
  // off the sequential line for the rest of this lot's life.
  open_lot: 0xf2000001,
  // D-4/D-4a/D-88: opens the DESCENDING lot for a prime WHOSE TURN HAS PASSED.
  // No bid and no value beyond gas — a Dutch lot has no opening bid to place,
  // and requiring one would put the opener in front of the clock they started.
  //
  // D-88 point 3 REINSTATES the `n < headHint` gate D-31 lifted. Ahead of the
  // head a prime is bought on the ASCENDING lane (`open_lot` with `kind = 1`)
  // at this same P0(p), so the two lanes are exhaustive and disjoint and there
  // is no "opened early, standing flat at P0" state left. PERMISSIONLESS and
  // with no on-chain sender, so the keeper (`backend/keeper`, `runPrimeLane`)
  // is what actually gets a passed prime listed.
  open_head_lot: 0xf2000002,
  // D-88 point 2 DELETES SS3's separate composite lane: `open_head_lot_composite`
  // (#f2000006) and `buy_special_composite` (#f2000007). Specialness is price,
  // not mechanism — a curated composite is bought ahead of the head on the
  // ordinary ascending lane at its tier's price_max, and mints at the head for
  // MINT_PRICE once its turn comes, like every other composite.
  // open_head_lot_composite: #f2000006 — RETIRED, do not reuse.
  // buy_special_composite:   #f2000007 — RETIRED, do not reuse.
  //
  // D-88 point 3 DELETES `start_prime_decay` (#f2000005). It started the clock
  // on a prime lot opened before its turn; no such lot can exist now, so a
  // descending lot's clock always starts at open.
  // start_prime_decay: #f2000005 — RETIRED, do not reuse.
  // One message, two meanings, resolved by the lot's mode. On
  // MODE_DUTCH_BUYNOW it IS the purchase and settles in the same transaction: a
  // bid that opened a 7-day clock would stall the head for that clock on top of
  // the decay.
  bid: 0xf2000003,
  // Legal once the clock has run — D-45 DELETES the early-close-on-head-
  // arrival disjunct: `n` came off the sequential line at open, so the head
  // reaching (or passing) it is no longer an event this lot reacts to.
  close: 0xf2000004,
  // Re-send ONE bounced premium forward, named by `n`. O(1) by construction.
  retry_premium_forward: 0xf2000012,
  // D-200: fold resting descending rows (decay window over) into their `parked`
  // bit, at most PARK_SCAN_MAX rows at or above `from`. Permissionless; the
  // change rides back. A parked lot stays open and sells at its resting price.
  park_lots: 0xf2000013,
  // D-88 DELETES `sweep_expired_head_lot` (#f2000008) and dissolves D-50 with
  // it. The sweep deleted an unbought descending lot after two decay windows;
  // D-88 point 1 has such a lot PARK at its resting price until somebody buys
  // it, which is the opposite rule. The storage-griefing vector D-50 existed to
  // bound is closed instead by point 3: opening a pre-turn lot is a PAID first
  // bid at P0(n) off the D-99 score ladder, so nobody buys a permanent dict entry for the
  // price of gas, and no deposit or per-opener cap needs sizing.
  // sweep_expired_head_lot: #f2000008 — RETIRED, do not reuse.
  // D-20: `bootstrap_genesis` (0xf2000041) is DELETED — there is no genesis-set
  // lot-seeding step. Every prime, from 2 onward, opens the same uniform
  // MODE_DUTCH_BUYNOW lane via `open_head_lot` once the head has passed it.
  // This contract's admin surface is now empty: no message here is
  // authenticated by a privileged sender.

  // ---- outbound from the lot lanes ----
  // to the LEDGER: the premium above MINT_PRICE, on EVERY lane uniformly
  // (D-20 deletes the `lane` bit — see the struct). Credited to `T` and
  // forwarded to the ratchet as `pending` AT CLOSE; `S` untouched. The
  // ratchet's own `pool_inject` is NOT reachable from here and must not be:
  // every injection in this system routes through the ledger by construction.
  clearing_cleared: LEDGER.clearing_cleared,
  // D-20 — outbound, to the LEDGER, ONLY on a MODE_DUTCH_BUYNOW close. Reports
  // a prime sale directly (primes never occupy the head, so there is no
  // reservation for the head to settle later): the ledger runs the ordinary
  // §4.1 five-way split on the nominal MINT_PRICE and clears the prime's
  // `unsoldPrimes` entry in the same transaction. Replaces the old direct
  // `mint_item` send — the market no longer mints an item for ANY lane; the
  // ledger does it for every mint, primes included.
  settle_prime_clearing: 0xb0000024,

  // ---- the escrowed-claim lane (0xE0) is DELETED ENTIRELY (D-90) ----
  //
  // D-30 had already deleted `reserve` (0xe0000001) and D-32 `cancel`
  // (0xe0000002). D-90 deletes the rest of the lane: a won lot MINTS AT CLOSE
  // (both kinds), so there is no claim to settle later, no escrow to custody and
  // no release right to exercise. `primes_market_shard.tolk` is deleted with it.
  //
  // EVERY ONE OF THESE IS RETIRED, NOT REUSED — a stale sender must land on
  // `wrong_opcode`, never on a live handler that means something else now:
  //
  //   0xe0000003  settle                  permissionless settle of a claim
  //   0xe0000004  release                 D-32's release right (D-90.2)
  //   0xe0000011  shard_reserve           router -> shard escrow leg
  //   0xe0000013  shard_settle
  //   0xe0000015  shard_unsettle
  //   0xe0000016  shard_settle_confirmed
  //   0xe0000017  shard_release
  //   0xe0000021  shard_settle_ack
  //   0xe0000022  shard_reserved_notify
  //   0xe0000024  shard_release_done
  //
  // (0xe0000012, 0xe0000014 and 0xe0000023 were already unassigned.)
  //
  // What replaces the whole family is one send the market already had:
  // `mint_won_lot` (0xb0000020), now sent by `closeLot` straight to
  // the ledger. Its shape is unchanged, so the ledger's parser and handler are
  // unchanged too.
  //
  // inbound, from the LEDGER. D-45: `mark_rejected` now answers an OPEN-time
  // `mark_off_head`, not a close-time one — see `mark_off_head`'s own comment
  // and `primes_market.tolk`'s `MarkRejected` handler.
  head_update: 0xe0000031,
  mark_rejected: 0xe0000032,
  settle_confirmed: 0xe0000033,
  // inbound, from the LEDGER only, one-shot (CONCEPT §6 point 0). Until it
  // lands, every money-taking entry point throws `mkt_not_launched` (1022).
  launch_open: LEDGER.launch_open_market,
  // outbound, to the LEDGER. D-45: sent from `open_lot`, not from a won lot's
  // close — see `open_lot`'s own comment. `mark_unreserved` (0xb0000022) is
  // DELETED with this decision: the bit it cleared is now permanent, so there
  // is nothing left for an "unreserve" message to do. Not reused.
  mark_off_head: 0xb0000021,
  mint_won_lot: LEDGER.mint_won_lot,
  // D-88 point 2: `settle_special_composite` is retired here too — see the
  // LEDGER block above.
  // ---- DELETED WITH THE CONTRACTS THEY CONNECTED. Do not reuse. ----
  // trophy_reserve      0xe0000010  auction -> book hop to create the won
  //                                 reservation; now an internal call.
  // set_trophy_auction  0xe0000041  the book<->auction circular-address
  //                                 one-shot; there is no circle left.
  // Every 0xF0 (genesis auction) and 0xF1 (trophy auction) value likewise.
} as const;

// D-90 DELETES the escrow-counter event list that stood here. §3.4's
// decomposition is two pools now — `pending` (ratchet) and `owed` (ledger) —
// and the market holds neither, so there is no aggregate for an arbitrary
// sender to inflate and no list to audit.
// ---------------------------------------------------------------------------
// Bounty vault — high byte 0x90
// ---------------------------------------------------------------------------
export const BOUNTY_VAULT = {
  // inbound, from the ledger only (v1: era bounties)
  pay_era_bounty: LEDGER.pay_era_bounty,
  // inbound, from the ledger only (SPECIAL_NUMBERS_PLAN.md Phase 2)
  pay_special_number_rebate: LEDGER.pay_special_number_rebate,
  // inbound, from allow-listed program contracts (the vouchers; genesis-fixed list)
  pay_program_bounty: 0x90000002,
  // one-shot, from the genesis script only: the vault's own PRIMES jetton wallet
  // address (D21). Cannot be fixed at deploy — the same circular-dependency
  // reason as the ledger's `set_sinks`/`set_peers`.
  set_wallet: 0x90000003,
  // inbound, permissionless (D-53/B12.1). Replays a payout that genuinely
  // bounced, from `retryJournal` — the amount and beneficiary were already
  // decided when the original `pay_era_bounty`/`pay_special_number_rebate`
  // ran, so this can only ever resend exactly that, never a new decision.
  retry_bounty_payout: 0x90000004,
  // 0x90000005 (`accrue_discovery`), 0x90000006 (`claim_discovery`) and the
  // `credit_discovery` relay (0x93000005) are RETIRED by D-202 with the
  // constellation discovery bounty. Do not reuse.
} as const;

// ---------------------------------------------------------------------------
// Voucher claim — high byte 0x9a. CONCEPT §9.5 / EARN_PLAN E2.
//
// IT WAS 0x91, WHICH IS THE STAKING SINK'S (GAUNTLET.md X15). Two blocks in this
// file claimed the same byte and each said it was free: `STAKE.set_wallet` and
// `VOUCHER.claim_voucher` were both 0x91000001, `STAKE.unstake` and
// `VOUCHER.burn_signer` both 0x91000002. Harmless ON CHAIN — an opcode space is
// per-contract and the two contracts never exchange messages — but it broke this
// file's own numbering scheme and every value-keyed decoder built from it, and
// `contracts/scripts/testnet/txAudit.ts` builds exactly such a table. The voucher
// is the side that moved because nothing has deployed it: it is not in
// `genesisPipeline.ts`, so no address on any network answers these values. 0x9a
// was the first byte free everywhere in the repo at the time (0x93/0x94 and
// 0x98/0x99 were the constellation and generator families D-202 later deleted).
//
// The off-chain-scored half of §9.4. The backend signs "this wallet has earned T
// in total"; the wallet redeems it and pays its own gas; the contract pays the
// delta over what it already paid that wallet, so a replay pays ZERO by
// arithmetic rather than by a nonce check. PRIMES only, from the bounty vault's
// genesis-fixed `quests` bucket, so no emission path is created and `p_f` cannot
// move (§3.3/§5).
//
// On-chain-checkable rewards do NOT come through here — recruit and prime
// quests are contract facts and are verified in the claim
// transaction.
// ---------------------------------------------------------------------------
export const VOUCHER = {
  // inbound, permissionless — but the signature covers the SENDER, so it can
  // only ever pay whoever sent it. A voucher is not bearer paper.
  claim_voucher: 0x9a000001,
  // inbound, permissionless to send, authenticated by the signing key's own
  // signature. There is no owner field on the voucher contract; whoever holds
  // the key may retire it, and holding it is already more power than that.
  burn_signer: 0x9a000002,
  // outbound, to the bounty vault
  pay_program_bounty: BOUNTY_VAULT.pay_program_bounty,
  // one-shot, from the genesis script only (D22): points this program at the
  // vault whose allow-list names it.
  set_vault: 0x9a000003,
  // D-191 point 2 (V26.3): the per-claimant CLAIM RECEIPT (primes_claim_receipt.tolk),
  // whose address is derived from (voucher, claimant) and which holds the high-water mark.
  // voucher -> receipt: the signed total; deploys the receipt if absent.
  receipt_advance: 0x9a000004,
  // receipt -> voucher: the mark moved; pay `delta` to `claimant`. The voucher
  // re-derives the sender's address from `claimant` (100 otherwise).
  receipt_delta: 0x9a000005,
  // voucher -> receipt, from the vault-refusal bounce: take `amount` back off the mark.
  receipt_restore: 0x9a000006,
} as const;

// ---------------------------------------------------------------------------
// Minter card — high byte 0x9B. DECISIONS.md D-191 point 1 (GAUNTLET.md V26.4):
// `primes_minter_card.tolk`, one per (ledger, wallet), holds the wallet's rebate
// standing (prime rank, the §5.1 and §4.5 windows, §4.7's recruits, the era tally).
// A player's `LEDGER.mint` is sent to the BENEFICIARY's card, which forwards it here.
// Every arm authenticates by derived address: the ledger re-derives the card from
// `owner`, the card compares its stored ledger. Layouts: /shared/schemas/minter_card.tlb.
// ---------------------------------------------------------------------------
/**
 * D-196: THE LOT BLOCK (`primes_lot_block.tolk`), one per (ledger, 256-number block)
 * beyond the ledger's import frontier. Only the ledger ever sends to one; every send
 * carries its state init (deploy-if-absent). Its two replies are in LEDGER above.
 */
export const LOT_BLOCK = {
  // ledger -> lot block: a lot opened on n (either kind). Refused if already set.
  lot_block_claim: 0x9c000001,
  // ledger -> lot block: prime n was sold ahead of the head.
  lot_block_sold_prime: 0x9c000002,
  // ledger -> lot block: hand the words over (`lot_block_words`); idempotent.
  lot_block_import: 0x9c000003,
  // D-198, ledger -> lot block: a passed block's unsold rows (query_id = the block).
  lot_block_bookmarks: 0x9c000004,
  // D-198, ledger -> lot block: prime n sold; answer `lot_block_bookmark`.
  lot_block_release: 0x9c000005,
  lot_block_bookmark: LEDGER.lot_block_bookmark,
  lot_block_words: LEDGER.lot_block_words,
  lot_block_refused: LEDGER.lot_block_refused,
} as const;

export const MINTER_CARD = {
  // inbound to the card, from ANY wallet (the payer): the ledger's own mint body,
  // less `beneficiary` — the card is the beneficiary's. Same opcode as before D-191.
  mint: LEDGER.mint,
  // card -> ledger: the mint, with the standing it is priced off and `fresh`.
  card_mint: 0x9b000001,
  // ledger -> the PAYER's card on a recruit edge: +1 recruit, +1 era tally under `eraSeq`.
  card_add_recruit: 0x9b000002,
  // card -> ledger: the era tally after that credit, for the running max.
  card_recruit_counted: 0x9b000003,
  // ledger -> the beneficiary's card on every prime sale: +1 rank, window reset.
  card_prime_minted: 0x9b000004,
  // ledger -> card on a lost race: give the mint's units back, pass the refund on.
  card_mint_refunded: 0x9b000005,
} as const;

/** §9.4's vault track this program draws on — "QSTS". The AMOUNT lives in the vault. */
export const PROGRAM_TAG_QUESTS = 0x51535453;

/** D-170's one security prize — "SECU". A second voucher instance; the AMOUNT lives in the vault. */
export const PROGRAM_TAG_SECURITY = 0x53454355;

/** G78 / D-171 — "PQST": the third voucher instance, paying §9.4's contract-fact quests. */
export const PROGRAM_TAG_PRIME_QUESTS = 0x50515354;

/**
 * Domain separators for the two signed payloads (primes_voucher.tolk). A burn
 * authorisation can never be replayed as a payout authorisation: the signed cells
 * differ in shape AND in their first 32 bits.
 */
export const VOUCHER_CLAIM_TAG = 0x434c414d; // "CLAM"
export const VOUCHER_BURN_TAG = 0x4255524e; // "BURN"

/**
 * EARN_PLAN §3: the minimum notice a program shutdown must give, in seconds
 * (90 days). Asserted on-chain, so "ends the program without stranding anyone's
 * earned balance" is checkable rather than editorial. It is a FLOOR: the burner
 * may give more notice and cannot give less.
 */
export const VOUCHER_BURN_MIN_GRACE = 7776000;

// ---------------------------------------------------------------------------
// Error codes — shared across contracts where the condition is the same
// (e.g. "not the expected sender"). Contract-specific codes start at each
// contract's reserved base to keep them disjoint for easier debugging.
// ---------------------------------------------------------------------------
export const ERRORS = {
  // common, 100-199
  wrong_sender: 100,
  wrong_opcode: 101,
  malformed_body: 102,
  insufficient_value: 103,
  already_processed: 104,
  // ledger, 200-299 (the range was "bank" until §3.4 retired the word)
  // `mint_won_lot` names an `n` the market never marked off the head's line —
  // no open lot put it there, so there is nothing for the ledger to mint.
  ledger_not_auctioned: 200,
  // CONCEPT §3.4: the word "bank" is retired. These two are renamed to the
  // component that actually throws them — `primes_ledger.tolk` verifies both the
  // submitted factorization and the Miller-Rabin primality claim. The NUMBERS are
  // unchanged (201, 202), so no decoder breaks; only the names move.
  ledger_bad_factorization: 201,
  ledger_bad_primality_claim: 202,
  // 203-206 are RETIRED (primes_ledger.tolk D8). Do not recycle: an old decoder
  // that still maps them must not be able to mislabel a live error.
  // GAUNTLET.md G60: 207-209 renamed from `bank_*` to the component that throws them
  // (CONCEPT §3.4); numbers unchanged. 210 (`bank_prime_bitmap_shard_missing`) is
  // RETIRED with the shard D-90 deleted — thrown by nothing. Do not recycle.
  ratchet_flush_cooldown: 207,
  ratchet_flush_below_min: 208,
  ledger_number_off_head: 209,
  // v5 §4 B1/B3. The ratchet throws 211 when the floor guard's fixed-point
  // multiply would exceed its 2^120 operand bound (see computeMinOut). The
  // ledger's "a mint would strand pool backing with no ratchet configured"
  // shared 211 until the pre-launch dedup moved it to 233 (with 225/226 ->
  // 234/235 below): one number, one meaning, whichever contract a decoder reads.
  ratchet_guard_overflow: 211,
  // CONCEPT §6 point 0: `ignite` has not run, so Unity does not exist and the
  // game has not started. Thrown by `mint` and `mint_won_lot`.
  ledger_not_launched: 212,
  // 213-215 are RETIRED by D-106 (patron mode's three refusals). Left as a gap
  // rather than reused: a code is a promise about what a failure MEANT, and a
  // recycled number makes an old bounce report the wrong cause.
  /** B-1: a `claim_tribute` relay arrived for more GRAM than the ledger holds.
   *  §3.2's tribute is credited to items as a NUMBER and custodied here, so
   *  this is the ledger admitting it cannot cover an obligation it declared —
   *  the failure `tributeOwed` in the solvency liability exists to prevent.
   *  The transaction aborts and the relay bounces, so the item restores `owed`
   *  and the claim is retryable; the code exists so the cause is diagnosable
   *  rather than reading as TVM's generic action-phase "not enough GRAM" (37). */
  ledger_tribute_insolvent: 216,
  /** 217 IS RETIRED AND MUST NOT BE REUSED. It was `ledger_donation_would_dilute`:
   *  under D-91 point 4 `donate_floor` emitted at the fixed `L = 10,000`
   *  PRIMES/GRAM, which only raises `p_f` while `p_f <= 1/L`, so a late donation
   *  had to be REFUSED to keep §5's ratchet theorem. D-100 point 1 replaces the
   *  refusal with a clamp — `emitted = min(X·L, X·S/T)` — so the dilution case
   *  is unreachable by construction and there is nothing left to throw. The code
   *  is left named here rather than deleted because it appears in past testnet
   *  transactions and a reused number would misread them. */
  /** `ignite` on a ledger whose floor has no backing. The genesis seed writes
   *  `T = 0` (D-46 point 2 — no founder GRAM is deposited), so `p_f = T/S` is
   *  zero until D-92's `donate_floor` lands. Opening minting first is not a
   *  cosmetic ordering slip: the rebate is `R = k*I*S/T`, so the mint after the
   *  first one emits ~20% of the genesis supply for 1 GRAM (measured in
   *  `contracts/tests/UnbackedFloorLaunch.spec.ts`). The donation is
   *  incremental and permissionless, so any positive `T` — one tranche or ten,
   *  a testnet-sized donation or the full 240 — satisfies this. */
  ledger_floor_unbacked: 218,
  /** `claim_dividend` for a prime whose Dutch lot is still open. Under D-20 a
   *  prime is marked, counted into pi(n) and div-stamped the moment the head
   *  crosses it, so it accrues the §3.2 flat dividend long before it sells —
   *  but its item is not deployed until the lot closes (D-90 mints in the
   *  closing transaction). Its stamp sits on its `unsoldPrimes` row until the
   *  sale hands it to the item (D-188 point 4), so there is nothing to credit.
   *  Refused, not deferred silently — the accrual is untouched and the eventual
   *  owner claims the whole of it. */
  ledger_dividend_prime_unsold: 219,
  // §4.1's invite line, 220-222. 220 (`invite_bad_sig`) and 222
  // (`ledger_invite_unset`) are RETIRED by D-202 with the invite signer. Do not reuse.
  /** `invite_count` above the ledger's live `Config.inviteCount` (D-215; genesis 3). The
   *  field is `uint7`; this is the check that makes every count over the live terms
   *  unreachable. Malformed or stale input from the minter, not an unresolvable line. */
  invite_count_over_max: 221,
  /** Audit R2-L1 (2026-11-19): a named invite slot is not on workchain 0. Refused in the
   *  compute phase so the mint bounces through the minter card and refunds; the send
   *  itself would have failed in the action phase (36) and kept the payer's 1 GRAM. */
  invite_bad_workchain: 236,
  /** D-211: `set_invite_terms` carried words with refs, a partial byte, or more than
   *  INVITE_TEXT_MAX_BYTES (86) — words that would overflow the comment cell. */
  invite_text_bad: 237,
  /** D-215: invite terms outside the fixed bounds — value 0, count over
   *  INVITE_COUNT_CEILING (100), or count × (value + INVITE_SEND_FEE) over INVITE_LINE_CAP
   *  (0.31 GRAM). Thrown by `set_invite_terms`, and by a mint whose spend would exceed the cap. */
  invite_terms_bad: 238,
  /** GAUNTLET V15: `flush()` was called while a DeDust round trip is still
   *  open (`inFlightFlush != 0`). `handleFlush` used to OVERWRITE that field
   *  rather than refuse, so a bounce from the first swap would restore the
   *  SECOND swap's amount into `pending`/`swapped` — the §5 identity
   *  `T = seeded + swapped + pending` silently wrong, in a contract whose whole
   *  claim is that the identity is checkable in one get-call (§3.4).
   *
   *  Fails CLOSED on purpose. `FLUSH_COOLDOWN` (1 day) against the swap's own
   *  `DEDUST_SWAP_DEADLINE_WINDOW` (600s) means a legal flush normally finds
   *  `inFlightFlush == 0` already — 143x the deadline has passed — so this only
   *  ever fires when a round trip has hung unresolved for a full day, which is
   *  exactly when stacking a second swap on top is the wrong move. Refusing
   *  loudly with a diagnosable code beats corrupting the identity silently,
   *  which is what the overwrite did. */
  ratchet_flush_in_flight: 223,
  /** GAUNTLET V17 point 3: a mint named an `n` at or above Miller-Rabin's
   *  13-base determinism bound (3.317e24, CONCEPT.md §3.1), where the witness
   *  set {2..41} stops being exact. Asserted once in `executeMint`, so it covers
   *  the direct head mint, a won lot's `mint_won_lot` and prime clearing alike.
   *
   *  Unreachable in normal play and meant to be: `primes_market.tolk`'s
   *  AUCTIONABLE_MAX (4.29e13) already keeps the largest argument near 8.6e13,
   *  eleven orders below. The code exists so the guarantee is LOCAL — §8 asks
   *  for properties checkable by reading one contract, and before this the
   *  ledger's primality correctness was a property of a peer. */
  ledger_mr_bound_exceeded: 224,
  /** D-196: `import_lot_block` before the frontier block starts below
   *  `head + window` (`getLotBlockState().dueNow` is 0). Importing early would put
   *  a word the opener of a far lot chose on the ledger — the storage-fill D-196
   *  closes. */
  ledger_lot_block_not_due: 234,
  /** D-196: a prime sale for a prime the head has passed that has no unsold row —
   *  it was already sold (ahead of the head). The market keeps no sold bit for a
   *  sale ahead of its `headHint`, so this is where a second sale is refused; its
   *  lot's listing is refused earlier, by `mark_off_head`. */
  ledger_prime_already_owned: 235,
  /** D-146 (signed 2026-09-22): the CALLER of a permissionless ratchet leg attached
   *  less than that leg's venue gas plus 0.01 GRAM of compute — flush 0.26 (DeDust's
   *  0.25), stake 1.02 (Tonstakers' 1 GRAM gas reserve, ~0.89 refunded, + 0.01 credit margin), unstake 1.96 (all three exit
   *  legs, prepaid), harvest 0.11 (`shared/messages.ts`' `*_CALLER_GAS_NANOTON`).
   *  The caller pays and gets the change back, so no call can move the ratchet's
   *  balance above `pending`. Until D-146 this code meant the opposite — the
   *  ratchet's own gas buffer was short — and that buffer was drainable (G39).
   *
   *  MEASURED 2026-09-17, and the reason the gas exists at all: `handleFlush`
   *  used to attach `value: amount` to a swap that DECLARED `amount` as its
   *  input, so the forward fee guaranteed `msg_value < amount` at the vault,
   *  which throws its own exit 263 and bounces. Every flush the project ever sent
   *  took that path, and `onBouncedMessage` stamped FLUSH_BOUNCED — the same code
   *  the floor guard's legitimate refusal produces — so a wire-format defect read
   *  as an economic outcome on the dashboard for the whole of the project's life.
   *
   *  It refuses BY NAME rather than letting the send fail: an unaffordable
   *  outbound message dies in the ACTION phase, which raises no compute error,
   *  sends nothing, and shows up in no get-method. */
  ratchet_flush_gas: 225,
  /** A `stake` whose computed size is at or below `STAKE_MIN` (§4.3.2). Not a
   *  dust guard: the Tonstakers pool charges a FLAT 1 GRAM `DEPOSIT_FEE` per
   *  deposit regardless of size (`pool.func:79`, `:288-290`), so a small stake
   *  is a guaranteed loss. The minimum is sized by the sim against the modelled
   *  APR, not picked. */
  ratchet_stake_below_min: 226,
  /** `unstake` called while liquid `pending` still covers `reserveTarget`. The
   *  exit exists to refill the floor's standing bid; with the bid already
   *  funded there is nothing to refill, and letting anyone unstake on demand
   *  would be the discretionary surface §11.14 refused. */
  ratchet_reserve_sufficient: 227,
  /** `harvest` inside the 30-day interval. Permissionless and therefore
   *  rate-limited the way `flush` is — by the clock, in the contract. */
  ratchet_harvest_too_soon: 228,
  /** `harvest` whose accrued tsTON is below the dust threshold. Refuses BY NAME
   *  rather than sending nothing: a jetton transfer costs more gas than a few
   *  nano-tsTON is worth, and a silent no-op reads as a filled harvest. */
  ratchet_harvest_dust: 229,
  /** A second `stake`, `unstake` or `harvest` while one is still in flight.
   *  Same fail-closed rule as `ratchet_flush_in_flight` (223), for the same
   *  reason: each of these moves a term of `T` optimistically before the send,
   *  and two open round trips would restore the wrong amount. */
  ratchet_stake_in_flight: 230,
  /** `stake`, `unstake` or `harvest` before the genesis script has wired this
   *  contract's tsTON jetton wallet (`set_tston_wallet`). Refuses by name so a
   *  half-wired genesis is visible instead of silently staking nothing. */
  ratchet_tston_wallet_unset: 231,
  /** `recover_exit` with nothing stranded to recover: no stake past the window
   *  (a stake whose mint never landed is written off first), and either no exit is open, or
   *  the open one is still inside D-155's 72-hour window, in which the three
   *  legs are entitled to answer — leg 3's bill pays at ROUND END (~36 h), so a
   *  shorter window would abort a leg that is merely waiting its turn. One code
   *  for one meaning; the arm's whole job is to undo a machine no reply can
   *  reach any more, and both refusals say it has not become that yet. */
  ratchet_exit_not_stranded: 232,
  // Ledger codes deduplicated off the ratchet's 211/225/226 (see 211 above).
  ledger_sinks_unset: 233,
  // item, 300-399
  item_not_owner: 300,
  // 301 (`item_nothing_owed`) is RETIRED (G60): thrown by no contract. Do not recycle.
  // 302-305 are RETIRED by D-106 (the ownerless-item lifecycle's four
  // refusals). Left as a gap, same rule as 213-215 above.
  // 306 (`item_not_namer`) is RETIRED by D-212: a refused naming refunds, it
  // does not throw. Do not recycle.
  /** A `credit_tribute`/`credit_dividend` to an item that exists but was never
   *  populated: anyone can deploy the canonical empty state at `ItemAddress(p)`,
   *  so existence is not ownership. The ledger's bounce arm reads this code as
   *  "no owner" and forfeits the share (§6 point 2) instead of parking it. */
  item_not_populated: 307,
  // jetton, 400-499
  jetton_authority_sealed: 400,
  jetton_not_minter: 401,
  /** `seal_authority` before `set_ledger`: sealing with the genesis placeholder still
   *  in `ledgerAddr` would leave mint authority with the genesis key. */
  jetton_ledger_unset: 402,
  // reservation, 500-599 — THE WHOLE BAND IS RETIRED BY D-90.
  //
  // Every code here was thrown by a shard handler, and there is no shard: a won
  // lot mints at close, so there is no record to be missing (502), no route to
  // mismatch (505), no head to wait for (500/504) and no claim to hold or
  // release (503/510). Nothing in this band is reused — a stale decoder must not
  // be able to mislabel a live error.
  //
  //   res_number_below_head             500 — RETIRED (D-90)
  //   res_already_reserved              501 — RETIRED (D-90); the market's own
  //                                           1001/1002 answer "taken" now
  //   res_not_found                     502 — RETIRED (D-90)
  //   res_not_beneficiary_or_reserver   503 — RETIRED (D-90)
  //   res_not_yet_at_head               504 — RETIRED (D-90)
  //   res_shard_route_mismatch          505 — RETIRED (D-90)
  //   res_not_claim_holder              510 — RETIRED (D-90.2, with the release)
  // CONCEPT §4.4 point 1a / §7: the number is an era boundary. Primorials are
  // public ceremonies and mint only at the head — they are not reservable at any
  // price, so this is a refusal to sell rather than a pricing failure, and it is
  // deliberately distinct from `res_number_below_head` and from `insufficient_value`.
  // D-30 RETIRES this code with the `reserve` entry point that threw it — the
  // primorial refusal now throws `mkt_primorial_not_auctionable` (1008) on
  // `open_lot` / `open_head_lot`, which is the same refusal on the lane that
  // survives. Left unassigned; do not reuse.
  // res_number_not_reservable: 506 — RETIRED, do not reuse.
  //
  // D-30 RETIRES 507 outright. It named "this number is on the auction lane, so
  // it is not reservable at a flat price" — and under D-30 EVERY number ahead of
  // the head is on an auction lane, so the condition it described cannot arise.
  // The whole 507 cluster in the old test baseline is resolved by deletion.
  // res_auction_lane_only: 507 — RETIRED, do not reuse.
  // 508 `res_trophy_not_linked` / `res_trophy_auction_unset` is DELETED with
  // the book<->auction bootstrap it guarded (layout §1.1). 509
  // `res_not_launched` and 600-606 (`auction_*`) are DELETED too: the three
  // launch gates and the whole genesis-auction error band retired with their
  // contracts, replaced by `mkt_not_launched` 1022. None of these values is
  // reused — a stale decoder must not be able to mislabel a live error.
  // bounty vault, 700-799
  vault_not_allowlisted: 700,
  vault_insufficient_balance: 701,
  // D-53/B12.1: `retry_bounty_payout` guards.
  vault_no_retry_journalled: 702,
  vault_already_paid: 703,
  // 704 (`vault_nothing_owed`) is RETIRED by D-202 with the discovery bounty.
  // TEP-74's reference wallet gas check (`throw_unless(709, ...)`), kept at the
  // standard's own number so explorers and wallets decode it: a `transfer` whose
  // value cannot cover its forward hop(s). Thrown by `primes_jetton_wallet.tolk`
  // (GAUNTLET V4); it sits in the vault band only because the standard put it there.
  jetton_insufficient_fwd_gas: 709,
  // voucher claim, 710-719 (§9.5 / EARN_PLAN E2). Note there is deliberately NO
  // "already claimed" code: a replayed voucher is a no-op that pays zero, not an
  // error, so it settles quietly instead of bouncing.
  voucher_program_closed: 710,
  voucher_expired: 711,
  voucher_bad_signature: 712,
  voucher_already_burned: 713,
  voucher_grace_too_short: 714,
  voucher_vault_unset: 715,
  // Audit 2026-11-19 R2-M2: a signed `cumulative_total` above the instance's deploy-time
  // `maxPerWallet`. Thrown before the receipt is messaged, so no mark moves.
  voucher_total_above_cap: 716,
  // venue timelock, 800-899
  timelock_not_proposer: 800,
  timelock_not_matured: 801,
  timelock_nothing_queued: 802,
  timelock_already_queued: 803,
  // D-194: `execute` on a record the LP electorate has not confirmed.
  timelock_not_confirmed: 804,
  // D-194: `confirm_venue` from anyone but the governed treasury.
  timelock_not_governance: 805,
  // D-194: `confirm_venue` naming a seq that is not the queued, unfired record's.
  timelock_confirm_stale: 806,
  // `confirm_venue` from a vote that opened before the record was queued: it
  // voted on a predictable seq, not on these addresses.
  timelock_vote_predates_queue: 807,
  // Audit H1 (2026-11-19, D-194 amendment): `confirm_venue` from a vote that
  // closed before the record's `eta` — i.e. opened before `eta − voteDuration`.
  // Only LP locked before a vote opens counts (treasury 1202), so an early vote
  // denied holders the 30-day notice to lock and vote no.
  timelock_vote_before_notice_end: 808,
  // registrar, 900-999.
  //
  // D-102 and D-202 deleted the predicate registry and then the built number
  // line, and every 9xx code but the five below with them. THE NUMBERS ARE NOT
  // RECYCLED: 900-910, 912, 913, 917, 919-934 are retired, and D-212 retired
  // 911, 916 and 918 with the burn sink.
  //
  // 911 (`reg_collection_unset`) is RETIRED by D-212 with `sink_annotate`.
  // D-36: an `award_era_trophy` naming a number that is not one of §7's eight
  // primorials. The ledger is trusted for WHO won the era, never for WHAT is
  // being named.
  reg_not_primorial: 914,
  // THE MARKET's lot lane, 1000-1099. 1000-1008 were `trophy_*` until the
  // pre-launch rename to the `mkt_*` names `primes_market.tolk` and
  // `market.tlb` already used; the NUMBERS are unchanged.
  mkt_lot_not_found: 1000, // no lot has been opened for n
  mkt_lot_already_open: 1001,
  mkt_lot_already_closed: 1002, // also: a bid arriving after `closesAt`
  mkt_open_below_p0: 1003, // opening bid < P0(n) — you cannot open a lot you will not buy
  mkt_bid_below_minimum: 1004, // < high + max(MIN_INCREMENT_FLOOR, bps[D/10] · high / 10000) — D-33's ladder
  mkt_close_too_early: 1005, // `now < closesAt`, no bid to fill, or a Dutch buy-now lot (D-45: the head never reaches an auctioned n)
  // WRONG LANE FOR THIS NUMBER. D-88 narrows it to ONE throw site, about class
  // rather than score: `open_head_lot` on a composite, because the descending
  // lane is the PRIME lane and a composite mints at the head instead. The old
  // "composite scoring below D_MIN" meaning went with `D_MIN` (D-30); the
  // `start_prime_decay` site went with that message (D-88 point 3).
  mkt_not_on_auction_lane: 1006,
  // RENAMED (D-45, was `trophy_too_close_to_head`): the LIVENESS gate this
  // code used to name — refuse an open closer than `MIN_AUCTION_DISTANCE` to
  // the head, so a 7-day clock could not be truncated by the head's arrival —
  // is deleted along with `MIN_AUCTION_DISTANCE` itself (D-45: the head skips
  // a reserved composite forever instead of ever truncating a lot). What
  // throws 1007 now is a much cheaper pre-filter in `open_lot`: `n` must be
  // strictly ahead of this contract's own lagging `headHint`, so an open on a
  // number that hint already knows is behind fails fast, before the
  // authoritative (and more expensive) round trip to the ledger. A `headHint`
  // that has simply lagged behind the true head can still pass here and be
  // caught later by `mark_rejected` instead — see that opcode's comment.
  mkt_at_or_behind_head: 1007,
  mkt_primorial_not_auctionable: 1008, // §7 era boundary: neither lane, mints at the head only
  // 1009 (`trophy_wrong_sender`) is DELETED: the market authenticates
  // `head_update` with the shared `wrong_sender` 100 like every other gated
  // handler, so 1009 had no throw site left. 1010 (`trophy_not_launched`) is
  // DELETED with the third of the three launch gates `mkt_not_launched`
  // replaces. Neither value is reused.
  //
  // ---- NEW WITH THE CONSOLIDATION, 1020-1099 (DECISIONS.md D-3) ----
  //
  // D-11/D-18's reservable cap, now a contract-level check on every entry point
  // that accepts an `n` rather than an emergent property of a `uint32` multiply.
  // It is also what makes Miller-Rabin overflow-safe here: at n < 2^46 the
  // `modpow` intermediate is under 2^92, where the old `uint256` shape could be
  // handed a 78-digit argument whose square needs ~2^518 and throws exit 4
  // (GAUNTLET P2.C1, closed structurally by the cap).
  mkt_n_above_cap: 1020,
  // D-20 RETIRES this code and deliberately leaves 1021 unassigned — do not
  // reuse. `open_head_lot`'s old lookahead-window gate (`(head, head + H]`) is
  // gone; eligibility is now the plain `n < headHint` comparison and its
  // failure throws `mkt_decay_not_due` 1024 (D-88 point 3, below). A stale
  // caller that still expects 1021 here should see `wrong_opcode`-shaped
  // silence rather than land on an unrelated meaning if this number is ever
  // reassigned.
  // mkt_outside_lookahead: 1021 — RETIRED, do not reuse.
  // CONCEPT §6 point 0: the ledger's `launch_open` has not arrived. ONE code for
  // the whole market, where the three separate contracts needed three
  // (`res_not_launched` 509, `auction_not_launched` 606, `trophy_not_launched`
  // 1010) — all three deleted above with their receivers.
  mkt_not_launched: 1022,
  // D-88 point 3 RETIRES 1023 and deliberately leaves it unassigned — do not
  // reuse. D-22's `open_lot` refusal of `kind = 1` is deleted: the ascending
  // lane is now the route to EVERY number ahead of the head, prime included,
  // because a won prime mints at close instead of becoming a reservation the
  // head would have to reach (D-88 point 4). A prime that fails Miller-Rabin on
  // that lane throws `bad_factorization` 201 like any other failed proof.
  // mkt_prime_not_on_ascending_lane: 1023 — RETIRED, do not reuse.
  //
  // D-88 point 3 REPURPOSES this one rather than retiring it, because the
  // condition it names is unchanged: the prime's turn has not come
  // (`n >= headHint`). What changed is which message asks. It used to be
  // `start_prime_decay`, refusing to start a parked clock early; it is now
  // `open_head_lot` itself, refusing to open the descending lane before the
  // turn — ahead of the head, the ascending lane is the route.
  mkt_decay_not_due: 1024,
  // D-88 point 3 RETIRES 1025 with `start_prime_decay` itself. A descending lot
  // can only be opened after the turn, so its clock always starts at open and
  // there is no second message that could try to start it again.
  // mkt_decay_already_started: 1025 — RETIRED, do not reuse.
  // D-88 RETIRES 1027 with `sweep_expired_head_lot`, and dissolves D-50 with
  // it: an unbought descending lot now parks at its resting price until bought
  // (D-88 point 1), and a pre-turn lot costs a paid opening bid to create
  // (point 3), so there is neither an expiry to time nor a griefing vector to
  // bound.
  // mkt_sweep_not_due: 1027 — RETIRED, do not reuse.
  // mkt_release_head_arrived: 1026 — RETIRED by D-90.2 (the release right is
  // deleted), do not reuse.
  // D-88 point 1 — `open_head_lot` computed a resting price ABOVE the opening
  // price, which would make the "descending" lane ascend. Unreachable by
  // construction (D-218: `restingPriceOf` clamps its table entry to
  // `openingPriceOf`) and asserted anyway, because editing either table is exactly
  // the change that would break it silently.
  mkt_floor_above_p0: 1028,
  // THE STAKE MASTER AND ITS POSITION CHILDREN, 1100-1109 (CONCEPT §5.3,
  // DECISIONS D-168). 1100-1103 for `primes_stake.tolk`, 1104-1108 for
  // `primes_stake_position.tolk`, so a failing transaction says which HOP refused.
  //
  // -- the master --
  // a notification or settle before the one-shot `set_wallet`: the master does not
  // know its own wallet (or the treasury) yet. Checked FIRST, before the address.
  stake_wallet_unset: 1100,
  // a `settle` whose sender is not `positionAddress(owner)`. THE WHOLE
  // AUTHENTICATION of the child edge, the treasury's `treasury_not_position`.
  stake_not_position: 1101,
  // a `transfer_notification` from an address that is NOT the master's own jetton
  // wallet. The master RECORDS A LIABILITY, so a forged notification would mint a
  // position out of nothing. Our wallet or nothing.
  stake_wrong_wallet: 1102,
  // an accumulator or weight operand crossed 2^120 (`MUL_OPERAND_BOUND`, the
  // treasury's and the ratchet's bound). Unreachable at PRIMES's supply; thrown
  // rather than wrapped.
  stake_overflow: 1103,
  // -- the position child --
  // a claim / relock / withdraw from anyone but the owner in this child's init data.
  stake_position_not_owner: 1104,
  // an operation naming a position id this child does not hold.
  stake_position_missing: 1105,
  // `withdraw` or `expire` before `matures_at` (ST-3: no early exit).
  // `getPosition` reports `matures_at`, so a UI never has to provoke this.
  stake_term_running: 1106,
  // `relock` to a SHORTER tier while the term runs. Allowed once it has matured.
  stake_relock_downgrade: 1107,
  // any settle on a position with one already in flight to the master. THE FLAG
  // THAT MAKES A DOUBLE PAYOUT IMPOSSIBLE — see `primes_stake.tolk`'s header.
  stake_in_flight: 1108,

  // 1110-1119 (the BURN SINK) are RETIRED by D-212 with the contract. Do not reuse.

  // 1120-1139 (the constellations collection and item) are RETIRED by D-202.
  // Do not reuse.

  // THE TREASURY VESTING LOCK, 1140-1149 (CONCEPT §2 point 4 / §3.3 / §6 point
  // 3, DECISIONS D-77, D-166). Two codes, because the contract has two ways to refuse
  // and no third.
  //
  // `release` before the one-shot `set_wallet` has run: the lock does not know
  // its own PRIMES wallet yet, so it has nothing to transfer from. Checked
  // FIRST, before the clock, so an unbootstrapped placeholder address can never
  // be sent a transfer — the same ordering the staking sink and the registrar
  // use for their own bootstrap flags.
  vest_wallet_unset: 1140,
  // `release` when no NEW tranche has matured since the last one. Deliberately
  // one code for two states — "the clock has not started" (`start_time == 0`,
  // i.e. `set_wallet` ran but somehow left it unstamped) and "nothing new since
  // last time" — because from a caller's point of view they are the same fact:
  // there is nothing to push right now. `getVestingSchedule().releasableNow`
  // returns 0 in both, so a UI never has to provoke the throw to find out.
  vest_nothing_due: 1141,

  // THE GOVERNED TREASURY AND ITS POSITION CHILDREN, 1150-1169 (CONCEPT §5.5,
  // DECISIONS D-100). Twenty codes for two contracts, split 1150-1163 for
  // `primes_treasury.tolk` and 1164-1169 for `primes_lp_position.tolk`, so a
  // failing transaction says which HOP refused without reading either file.
  //
  // -- the treasury --
  // a jetton notification (either wallet) before the one-shot `set_wallets` has
  // run. Checked FIRST, before the address, so an unbootstrapped placeholder can
  // never be impersonated into authority — the ordering the burn sink, the
  // vesting lock and the registrar all use for their own bootstraps.
  treasury_wallets_unset: 1150,
  // a jetton notification from a wallet that is neither the LP wallet nor the
  // PRIMES wallet. Unlike the burn sink there is no refund here, because a
  // forged notification names a jetton this contract has no wallet for and so
  // has nothing to send it back with.
  treasury_wrong_wallet: 1151,
  // a `settle` / `withdraw_lp` / `vote` / `propose` / `expire_vote` whose sender is not
  // `positionAddress(msg.owner)`. THE WHOLE AUTHENTICATION of the child edge —
  // see the TREASURY block above for why re-deriving the address is sufficient.
  treasury_not_position: 1152,
  // `vote` or `execute` naming a sequence number that was never opened.
  treasury_no_proposal: 1153,
  // `vote` after `closes`. The vote runs one day (D-100 point 8); there is no
  // grace and no extension, because an extension is a governance lever and this
  // contract deliberately has none.
  treasury_vote_closed: 1154,
  // a second `vote` from the same POSITION on the same proposal. Thrown by the
  // POSITION CHILD since D-188 point 7 — the record lives on the voter's own
  // account and the treasury keeps only totals; the name keeps its band. D-147 keys the
  // record by (seq, position) rather than by wallet, because a term
  // belongs to a position: a wallet holding three live terms casts three votes,
  // each its position's full weight. There is still no partial or split vote.
  // It is not a weaker rule than one-vote-per-wallet was — to vote twice with
  // the same LP a holder would have to withdraw and re-deposit inside the
  // one-day vote window, and the shortest tier that votes at all is 30 days.
  treasury_already_voted: 1155,
  // `propose` from an owner whose weight is below `treasury.propose_min_bps` of
  // `eligible_weight`. A FRACTION, never a fixed PRIMES count — D-100 "options
  // not taken": 10M PRIMES is 3.5 GRAM at genesis and 3.2M GRAM at the modelled
  // year-3 floor, so a fixed threshold is two different rules over time.
  treasury_propose_below_threshold: 1156,
  // `propose` from an owner who already has an open proposal (D-100 point 8).
  // One at a time, so the board cannot be flooded by a single weight.
  treasury_proposal_open: 1157,
  // `execute` before `closes`. Permissionless does not mean early.
  treasury_not_closed: 1158,
  // `execute` on a proposal already executed. Cleared by the bounce handler when
  // the send failed, which is what makes a bounced execute retryable rather than
  // a permanent loss of the proposal.
  treasury_already_executed: 1159,
  // `execute` on a proposal that did not pass: simple majority of votes cast,
  // `yes > no`, no quorum (D-100 point 8). A tie fails — the incumbent state
  // keeps the money, the same "strictly greater" tiebreak the ceremony lot uses.
  treasury_vote_failed: 1160,
  // `execute` whose amount exceeds `treasury.proposal_cap_bps` of the named
  // asset's balance AT EXECUTE TIME (TR-3). Deliberately not checked at open
  // time: a treasury that shrank between the vote and the execution is
  // respected, and a proposal written against a richer treasury simply fails
  // rather than draining a poorer one.
  treasury_cap_exceeded: 1161,
  // `execute` for more of an asset than the treasury holds.
  treasury_insufficient_asset: 1162,
  // 1163 was `treasury_overflow`, the miner accumulator's bound — deleted with the
  // miner by D-168. Retired, not recycled.

  // -- the position child --
  // an owner-facing message from anyone but the owner fixed in this child's
  // init data. The child's address is a hash of (position code, owner), so this
  // is a second, independent check on top of that derivation.
  position_not_owner: 1164,
  // an operation naming a position id this child does not hold.
  position_no_position: 1165,
  // `withdraw` or `expire` on a position whose LOCK TERM is still running
  // (D-147, renamed from `position_cooldown_active` with the mechanism). There
  // is no request step to have skipped and no cooldown to be in: the term is the
  // whole gate. `getPosition` reports `maturesAt`, so a UI never has to provoke
  // the throw to find out.
  position_term_running: 1166,
  // D-147: `relock` to a SHORTER tier while the current term is still running.
  // Allowed once the term has matured — the old commitment is then fully served
  // — and refused before, because a freely shortenable tier is a way to collect
  // the 1-year weight and leave on the 1-day clock. (1167 was
  // `position_already_requested`, retired with the withdrawal request itself.)
  position_relock_downgrade: 1167,
  // a withdraw, sink-forward or relock on a position whose LP move is already in
  // flight to the treasury: the flag that stops the same LP being moved twice
  // before the first move's reply lands.
  position_in_flight: 1168,
  // `vote` or `propose` naming a position with no live vote weight: a term that
  // has already matured (D-147; since D-168 every tier votes while it runs). It is checked
  // against the POSITION'S OWN CLOCK and not against either aggregate, which is
  // what makes "a matured term does not vote" true whether or not anyone has
  // sent the `expire` that would have taken it out of them.
  //
  // `expire` on a position that is already expired does NOT throw: it returns,
  // the `restore_position` precedent for "there is nothing to repair". A
  // permissionless poke a keeper may double-send is better idempotent than
  // loud.
  position_no_vote_weight: 1169,

  // THE TREASURY'S `distribute()`, 1200-1201 (CONCEPT §5.5.3, D-168). Its own band
  // because 1150-1169 is full.
  //
  // `distribute()` before `staking.epoch_seconds` (clock-divided) has passed since
  // the last one. TR-2's "at most once per interval". `getDistribution()` publishes
  // `last_distribute_time` and `interval`, so a keeper never provokes it.
  treasury_distribute_early: 1200,
  // `distribute()` whose formula comes to less than `DISTRIBUTE_MIN_BUDGET` (one
  // nano-PRIMES) — the empty treasury. `getDistribution().nextBudgetEstimate`
  // reads 0 in exactly that state.
  treasury_distribute_dust: 1201,
  // a `vote` from a position whose current weight appeared at or after the
  // proposal's VOTE opened (CONCEPT §5.5.5): no locking or upgrading LP during
  // the vote window to swing it. LP locked during the NOTICE before `opens`
  // does vote (2026-11-19 amendment). Measured from the position's `weightSince`, which a
  // same-tier relock does not restamp, so extending mid-vote never costs a voter
  // the proposal. Here and not in 1150-1169 because that band is full.
  treasury_vote_locked_late: 1202,
  // D-188 point 7. A `vote` whose proposal closes after the child's record of it
  // lapses — i.e. the proposal opened after the child wrote the record. The
  // refusal bounces and the child forgets the record; the voter simply re-sends.
  // It is what makes the child's record provably cover the whole vote window.
  treasury_vote_record_short: 1203,
  // D-188 point 7. `execute` more than one vote duration after `closes`. A passed
  // proposal is executable for one further window and then prunable, so the book
  // stays bounded; the window reuses `treasury.vote_duration_seconds`.
  treasury_execute_lapsed: 1204,
  // D-188 point 7. `prune` on a proposal something can still happen to: its vote
  // is running, or it passed and its execute window is still open.
  treasury_not_prunable: 1205,
  // D-173 as amended 2026-11-19 (audit R2-H1). A `vote` before the proposal's
  // `opens` — the proposal is still in its NOTICE (`getGov().noticeDuration`
  // after it was proposed). The refusal bounces, the child forgets the record,
  // and the same position votes once `opens` arrives. `getVotable(seq)` answers
  // without the throw, against the block's clock.
  treasury_vote_not_open: 1206,

  // THE LP SINK, 1170-1179 (CONCEPT §5.5, DECISIONS D-100 points 4/9). Two
  // codes, the same two the burn sink needs and for the same reasons — this
  // contract has two ways to refuse and no third, because it has one inbound
  // message and no outbound one at all.
  //
  // a transfer notification before the one-shot `set_wallet` has run: the sink
  // does not know its own LP wallet yet, so it cannot tell a real deposit from a
  // forged one. Checked FIRST, before the address, so an unbootstrapped
  // placeholder can never be impersonated into authority.
  lp_sink_wallet_unset: 1170,
  // a transfer notification from any wallet that is not this contract's own LP
  // wallet. Unlike the burn sink there is nothing to refund and no right being
  // granted, so this simply throws: whatever jetton was sent stays in whatever
  // wallet sent it, and locked depth is unchanged. Sending the WRONG jetton to
  // this address is the one way to lose tokens here, and it is the same way it
  // is on every jetton-custody contract in this repo.
  lp_sink_wrong_wallet: 1171,

  // the REGISTRAR's trophy transfer: the sender does not hold trophy `n`.
  reg_not_namer: 915,
  // 916 (`reg_annotation_not_free`) and 918 (`reg_sink_unset`) are RETIRED by
  // D-212: a paid re-engraving takes GRAM, and every engraving refusal refunds.
  // 917 (`reg_bond_unpaid`) is RETIRED with the registration bond (D-102). Do
  // not reuse.

  // 919-934 (the built number line), 1180-1183 (the generators collection) and
  // 1190-1193 (the generator item) are RETIRED by D-202. Do not reuse.
} as const;


// ---------------------------------------------------------------------------
// D-99 — the score's category bits (PRICING_MODEL_PLAN.md §1.3).
//
// A bit number is a PERMANENT identifier. It keys three things at once: the
// contract's `flags` word (`getLotPrice(n).flags` / `getScoreBreakdown(n)`),
// the published weight table's stack position (`getScoreWeights()`), and the
// orb's fixed satellite angle (§8.2: `angle = (360° / SCORE_BITS.length) · bit`,
// so the same angle means the same thing on every number). NEVER renumber one —
// only append. Phase 3 took 33..38, N6 took 39..47 and D-162 appended 48..53,
// re-pitching the ring from 48 slots (7.5°) to 54 (6.67°) once, pre-launch.
// `flags` travels as a uint64 (`class_flags:uint64`), so 54 bits fit on the wire.
//
// The weights here are OWNER-DECLARED (D-99), not sim-derived: they are the
// game designer's guess at demand, which is why they live in this file and in
// `shared/params.json` under `_provenance: "owner-declared (D-99)"` rather than
// being fitted by `sim/scripts/run_phase1.py`. `SimCrossCheck.spec.ts` asserts
// they equal what `getScoreWeights()` returns.
// ---------------------------------------------------------------------------

/** Groups exist for the orb's colour coding (§8.2), not for the arithmetic. */
export type ScoreGroup = 'DIGIT' | 'LIFE' | 'FORM' | 'CULTURE' | 'POSITION';

export const SCORE_BITS = [
  { bit: 0, key: 'repdigit', group: 'DIGIT', points: 40 },
  { bit: 1, key: 'pow10', group: 'DIGIT', points: 40 },
  { bit: 2, key: 'palindrome', group: 'DIGIT', points: 25 },
  { bit: 3, key: 'run', group: 'DIGIT', points: 25 },
  { bit: 4, key: 'abab', group: 'DIGIT', points: 12 },
  // PER trailing zero, capped at SCORE_TERMS.TZ_CAP zeros — the one bit whose
  // contribution is not simply `points`.
  { bit: 5, key: 'trailing_zeros', group: 'DIGIT', points: 8 },
  { bit: 6, key: 'yyyymmdd', group: 'LIFE', points: 30 },
  { bit: 7, key: 'ddmmyyyy', group: 'LIFE', points: 25 },
  { bit: 8, key: 'year', group: 'LIFE', points: 25 },
  { bit: 9, key: 'yymmdd', group: 'LIFE', points: 12 },
  { bit: 10, key: 'mmdd', group: 'LIFE', points: 5 },
  { bit: 11, key: 'mersenne', group: 'FORM', points: 40 },
  { bit: 12, key: 'fermat', group: 'FORM', points: 40 },
  { bit: 13, key: 'perfect', group: 'FORM', points: 40 },
  { bit: 14, key: 'primorial', group: 'FORM', points: 30 },
  { bit: 15, key: 'factorial', group: 'FORM', points: 25 },
  { bit: 16, key: 'prime', group: 'FORM', points: 15 },
  { bit: 17, key: 'pow2', group: 'FORM', points: 15 },
  { bit: 18, key: 'fibonacci', group: 'FORM', points: 15 },
  { bit: 19, key: 'cube', group: 'FORM', points: 8 },
  { bit: 20, key: 'twin', group: 'FORM', points: 6 },
  { bit: 21, key: 'sophie_germain', group: 'FORM', points: 6 },
  { bit: 22, key: 'safe_prime', group: 'FORM', points: 6 },
  { bit: 23, key: 'emirp', group: 'FORM', points: 5 },
  { bit: 24, key: 'square', group: 'FORM', points: 4 },
  { bit: 25, key: 'triangular', group: 'FORM', points: 2 },
  { bit: 26, key: 'harshad', group: 'FORM', points: 2 },
  { bit: 27, key: 'happy', group: 'FORM', points: 2 },
  { bit: 28, key: 'digitsum_prime', group: 'FORM', points: 2 },
  { bit: 29, key: 'iconic', group: 'CULTURE', points: 30 },
  { bit: 30, key: 'listed', group: 'CULTURE', points: 20 },
  { bit: 31, key: 'landmark', group: 'POSITION', points: 30 },
  { bit: 32, key: 'constant', group: 'POSITION', points: 20 },
  // PHASE 3 (PRICING_MODEL_PLAN.md §4) — the five categories `n` alone cannot
  // decide. Set only by `getLotPriceFrom` / `getScoreBreakdownFrom`, from the
  // factorization a composite already submits at `open_lot` and at head mint;
  // `getLotPrice(n)` returns them clear and is therefore a LOWER BOUND on the
  // price, not a different answer. Grouped FORM because that is the colour a
  // fact about `n`'s shape already wears — §8.2's groups are the orb's colour
  // coding and nothing in the arithmetic reads them.
  { bit: 33, key: 'semiprime', group: 'FORM', points: 3 },
  { bit: 34, key: 'prime_power', group: 'FORM', points: 5 },
  { bit: 35, key: 'squarefree', group: 'FORM', points: 2 },
  { bit: 36, key: 'smooth', group: 'FORM', points: 3 },
  // ABUNDANT and DEFICIENT partition every non-perfect number, so this pair is
  // a near-constant +1 on any composite priced with its factors rather than a
  // discriminator. That is what §4 means by "density filler" (owner answer 6),
  // and it is why a factored quote is always at least one point above the
  // unfactored one for a composite.
  { bit: 37, key: 'abundant', group: 'FORM', points: 1 },
  { bit: 38, key: 'deficient', group: 'FORM', points: 1 },
  // N6 (GAUNTLET.md N6) — nine bits, 39..47, the last of the original 48-slot
  // ring. The batch is COMPOSITE-FIRST because the
  // taxonomy's hole was: `shared/prime_tags.json` already names 78 prime
  // families, while the core loop mints composites.
  //
  // Eight of the nine are decided from `n` alone, so they are set by BOTH
  // entry points and run on the mint path. Only `carmichael` needs the
  // factorization, which puts it with 33..38 in every respect but its number.
  { bit: 39, key: 'carmichael', group: 'FORM', points: 30 },
  { bit: 40, key: 'pandigital', group: 'DIGIT', points: 40 },
  { bit: 41, key: 'narcissistic', group: 'DIGIT', points: 30 },
  { bit: 42, key: 'automorphic', group: 'DIGIT', points: 25 },
  { bit: 43, key: 'square_triangular', group: 'FORM', points: 25 },
  { bit: 44, key: 'kaprekar', group: 'DIGIT', points: 20 },
  { bit: 45, key: 'highly_composite', group: 'FORM', points: 20 },
  { bit: 46, key: 'keith', group: 'DIGIT', points: 20 },
  { bit: 47, key: 'catalan', group: 'FORM', points: 15 },
  // D-162 — six of numbersaplenty.com's families, chosen for being cheap on chain.
  // 48..51 need the factorization (set by `getLotPriceFrom` / `getScoreBreakdownFrom`
  // only, like 33..39); 52 and 53 are decided from `n` and ride square roots the
  // from-`n` walk already takes, so they cost the head mint no extra root.
  { bit: 48, key: 'smith', group: 'DIGIT', points: 3 },
  { bit: 49, key: 'sphenic', group: 'FORM', points: 2 },
  { bit: 50, key: 'powerful', group: 'FORM', points: 4 },
  { bit: 51, key: 'achilles', group: 'FORM', points: 6 },
  { bit: 52, key: 'lucas', group: 'FORM', points: 15 },
  { bit: 53, key: 'pronic', group: 'FORM', points: 3 },
] as const satisfies readonly { bit: number; key: string; group: ScoreGroup; points: number }[];

export type ScoreBitKey = (typeof SCORE_BITS)[number]['key'];

/** The three continuous terms and the clamp, the tail of `getScoreWeights()`. */
export const SCORE_TERMS = {
  /** LEN pays `LEN_W · (LEN_REF − digits)` while digits < LEN_REF. */
  LEN_REF: 9,
  LEN_W: 2,
  TZ_CAP: 3,
  /**
   * The ONE clamp on the sum, and the ceiling with it: `MINT_PRICE · 2^(87/10)`
   * is 415.87 GRAM, just under owner answer 9's 420. 88 points would reach 445.7,
   * which is why the clamp is here and not one point higher.
   */
  SCORE_MAX: 87,
} as const;

/** D-99 §1.5 — who gets PRIMES back from the bounty vault, and nothing else does. */
export const REBATE_KIND = {
  /** A composite minted AT THE HEAD, per point of D(n). An auction win pays none. */
  COMPOSITE_PER_POINT: 0,
  /** A prime of D-96's family (p > 100,000, p ≡ 1 mod 101), flat, any route. */
  PRIME_FAMILY: 1,
} as const;
