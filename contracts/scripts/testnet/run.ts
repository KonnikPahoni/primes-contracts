/**
 * TON PRIMES — the run driver (`TESTNET_MASTER_PLAN.md` §2 `run.ts`).
 *
 * Ten phases, each a list of steps, each step an existing script invoked as a
 * child process with its output teed to the console. Two things it adds that no
 * hand-run sequence ever did:
 *
 *  1. **`txAudit.ts` after every phase, over THAT PHASE'S window.** A phase is
 *     not done when its get-methods read right — it is done when its own
 *     TRANSACTIONS are also green (see `audit()` for why the window matters).
 *     Three separate bugs in this project's history reconciled perfectly and
 *     were only ever visible as a red row in an explorer (`MISTAKES.md`).
 *  2. **A journal, and a report generated from it.** `docs/audit/testnet-run-
 *     <date>.md` is a deliverable the plan calls "generated, never hand-written";
 *     the 2026-09-17 record was typed out of scrollback, and one of its claims
 *     was measured from a transaction that never reached the pool.
 *
 * It is deliberately a PROCESS RUNNER and not a library: every step below is a
 * script that must stay runnable on its own, because a run that fails at step 14
 * is resumed by running step 14, not by re-running the driver from the top.
 *
 *   npx tsx contracts/scripts/testnet/run.ts list
 *   npx tsx contracts/scripts/testnet/run.ts phase 1
 *   npx tsx contracts/scripts/testnet/run.ts all --until 4
 *   npx tsx contracts/scripts/testnet/run.ts report > docs/audit/testnet-run-<date>.md
 */
import { spawnSync } from 'child_process';
import path from 'path';
import { REPO, assertTestnetOnly } from './sender';
import { render } from './journal';

type Step = { what: string; script: string; args?: string[]; optional?: boolean };
type Phase = { id: string; title: string; steps: Step[] };

const S = (what: string, script: string, args: string[] = [], optional = false): Step => ({
    what,
    script,
    args,
    optional,
});

/**
 * The phases, in clock order, and numbered to match `TESTNET_MASTER_PLAN.md` §3
 * — phase 8 there is the browser walkthrough, which has no script and is why the
 * ids below run 0..7, then 9, then 10.
 *
 * `0` opens the auction timers AND queues the venue change, because both are
 * waits: on a D-139 set a lot closes an hour later and a venue change matures
 * ~4.3 hours later, so phase 7 collects both. On a fresh genesis the queue step
 * adopts the identity record genesis already queued. Phase 7 casts D-194's LP
 * vote that confirms it — proposed no earlier than `eta − noticeDuration − voteDuration`
 * (audit H1 + R2-H1: the vote opens a notice after the propose) — so its
 * `execute` has both keys. The LP withdrawal cooldown
 * requested in phase 5 lands in the same place.
 *
 * **PHASE 10 IS LAST.** Since D-153 the reason is mild — its `flush` competes
 * with the pool price phase 5 stages — but on a set deployed WITHOUT that
 * decision's `stakeDivisor` it is absolute: `stake` then needs `pending` above
 * 62.5 GRAM, the only permissionless route in is `donate_floor`, and a donation
 * that size raises `p_f = T/S` by roughly two orders of magnitude, invalidating
 * every price relationship phases 3, 5 and 9 stage against the DeDust pool.
 * See `TESTNET_MASTER_PLAN.md` §4c.
 */
export const PHASES: Phase[] = [
    {
        id: '0',
        title: 'the clocks — auction lots opened, the venue change queued',
        steps: [
            S('open both ascending lots', 'phase0OpenLotsLive.ts'),
            S('queue a venue change (matures in phase 7)', 'testnet/timelock.ts', ['queue']),
        ],
    },
    {
        id: '1',
        title: 'core loop — mint, split, referral, tribute, dividend, invites',
        steps: [
            // FIRST, and read-only: every `get fun` the deployed bytecode
            // publishes, called once. 50 of the set's 174 get-methods had never
            // been read at a live node and 27 of those are rendered by the app
            // (§9.1). It sends nothing, so it is free to run before the money.
            S('the whole get-method surface answers', 'testnet/surface.ts'),
            S('smoke mint n=4 (D-95)', 'smokeMintLive.ts', [], true),
            S('composite split, five ways', 'proveCompositeSplitLive.ts'),
            S('referral: every exclusion the chain offers', 'testnet/money.ts', ['referral', 'K']),
            S('tribute accrual on a sold factor + dividend accrual', 'testnet/money.ts', ['tribute', 'K']),
            // D-202: the invite line is plain text transfers to addresses the minter names.
            // `proveInviteMintLive.ts <addr1> [addr2] [addr3]` takes real addresses, so it is
            // run by hand (TELEGRAM_INVITES_PLAN.md Phase 4's smoke mint), not from the cast.
            S('item top-up, permissionless (X9)', 'proveItemTopUpLive.ts', [], true),
            // THE INDEXER ECHO. `assert.ts` has carried the predicate since
            // 2026-09-19 and NOTHING called it, so the one invariant about the
            // backend agreeing with the chain was never evaluated in a run.
            S('the indexer echoes the chain (INDEX_ECHO)', 'testnet/assert.ts', ['--index']),
        ],
    },
    {
        id: '2',
        title: 'recruits, the ladder, the era ceremony and its bounty',
        steps: [
            S('six gift mints + the sybil guard (D-106)', 'phase2RecruitCohortLive.ts'),
            S('walk the head onto the primorial (plain mints from K)', 'testnet/money.ts', ['walk-to', '30', 'K']),
            S('era ceremony at the primorial: bounty + trophy', 'phase3EraCeremonyLive.ts'),
            S('vault book after the ceremony', 'testnet/bounty.ts', ['status']),
            // THE REBATE SCHEDULE, READ PER KIND. Kind 0 fires on essentially
            // every head composite (LEN alone scores >= 2 under nine digits), so
            // the vault has been paying special-number rebates on every mint
            // since phase 1 and no run has ever read `getRebateSchedule` or
            // checked `paidSpecials` flipped exactly once.
            S('the special-number rebate, per kind', 'testnet/bounty.ts', ['rebate', '-']),
            S('the indexer echoes the chain (INDEX_ECHO)', 'testnet/assert.ts', ['--index']),
        ],
    },
    {
        id: '3',
        title: 'the head walk and the descending lane',
        steps: [
            S('the permissionless repair ops, on a healthy set', 'testnet/ops.ts', ['all', 'F']),
            // THE HEAD WALK — §3 phase 3's first sentence, and no step ever did
            // it. Without it the sequential line never passes a prime, so the
            // descending lane opens no lot and `proveDutchBuyLive.ts` has nothing
            // to buy: the Dutch step below was structurally dead on every run.
            S('walk the head with plain composite mints', 'testnet/money.ts', ['walk', '20', 'K']),
            S('buy a parked Dutch prime', 'proveDutchBuyLive.ts', [], true),
        ],
    },
    {
        id: '4',
        title: 'registrar, naming rights and the vault',
        steps: [
            S('who names what, so far', 'testnet/annotate.ts', ['who', 'A']),
            S('the gas-&-ops sweep spares every liability', 'testnet/ops.ts', ['sweep-ops', 'F']),
        ],
    },
    {
        // TESTNET_MASTER_PLAN.md §3 phase 4b: the surfaces G93's genesis adds. Every arm
        // reads first; `unsold` journals a read when D-198's block is not yet due.
        id: '4b',
        title: 'the G93 surfaces — minter cards, the item-confirmed mint, advance_head, lot blocks',
        steps: [
            S('minter cards (D-191): the ledger names the derived card', 'testnet/g93.ts', ['cards', 'K', 'A', 'B', 'R1', 'R2']),
            S('V28/D-199: every mint_confirmed came FROM the item', 'testnet/g93.ts', ['confirm-sender', '200']),
            S('advance_head (D-189): permissionless, refunded', 'testnet/g93.ts', ['advance-head', 'F']),
            S('flush_unsold (D-198): sent only once due', 'testnet/g93.ts', ['unsold', 'F']),
            S('far lots mark their lot block (D-196)', 'testnet/g93.ts', ['lot-blocks', '123456792', '899809363']),
            S('the retry_item lane is empty (V28)', 'testnet/g93.ts', ['retry-lane']),
        ],
    },
    {
        id: '5',
        title: 'DeDust — both flush branches, LP, governance, and the way back out',
        steps: [
            S('pool report: headroom against p_f', 'testnet/pool.ts', ['report']),
            // `L` CANNOT GET PRIMES ANY OTHER WAY, so the lever below is dead
            // without this step — wave 5 stopped here on `get_wallet_data` exit
            // -13, "account not initialised": `L` had no PRIMES jetton wallet at
            // all. PRIMES reach a wallet only by §4.1 EMISSION, the rebate is paid
            // to whoever PAID for the mint, and `L` never mints — `cast.ts fund`
            // gives it GRAM and nothing gives it PRIMES. A wallet-level TEP-74
            // transfer from the funder is the only route in, the same reason
            // phase 7 moves PRIMES to the namer.
            //
            // THE FIGURE. The two sells below are literals: 2,000,000 + 1,000,000
            // = 3,000,000. The `deposit` step's PRIMES leg is not a literal —
            // `lpGovernance.ts deposit` sizes it off the pool's live ratio as
            // `5 GRAM x primesRes/tonRes`. D-140/D-154 open the pair AT `p_f`
            // (1.2045e-05 GRAM/PRIMES since D-166, `shared/params.json`), so that leg is
            // ~415,000 PRIMES at the open and larger afterwards, because every
            // step before it pushes the price DOWN, i.e. more PRIMES per GRAM.
            // 1,500,000 covers it several times over. Total 4,500,000, against
            // the ~7.5M `K` holds from phase 3's head-walk rebates. The `buy`
            // step hands PRIMES back to `L` mid-phase, but nothing here may
            // depend on that: the first sell runs before it.
            //
            // `ensure`, NOT `send`: this is a PRECONDITION on `L`'s balance, not a
            // transfer worth making for its own sake, so a re-run where `L` is still
            // holding from the last one must send nothing rather than fail on a `K`
            // that phases 5-7 have since drained.
            //
            // RESIZED 2026-09-24 for a 132.50 GRAM genesis (D-154). The figures above were measured
            // on 75 GRAM sets: at the full donation `p_f` opens ~1.7x higher, every rebate is ~half
            // the PRIMES, and the 20-mint walk left `K` ~430,000, not 7.5M. The pool also opens AT
            // the floor now (G67), so a 300,000 sell already puts it under. Hence 400,000 here,
            // sells of 300,000 and 600,000 (the second out of the 15 GRAM buy's proceeds), and a
            // 2 GRAM deposit. The three flush branches are unchanged.
            S('fund the lever: K -> L, the only route PRIMES take here', 'testnet/primes.ts', [
                'ensure',
                'K',
                'L',
                // 900,000 since 20261121: on a shallow pool (1.44 GRAM seeded) the 15 GRAM buy
                // takes it to ~110x the floor and returns only ~215k PRIMES, so the second sell
                // (500,000) needs ~585k more than 400,000 leaves. K held ~1.4M after the walk.
                '900000',
            ]),
            // THE SWAP LEVER, AND WHY THE ORDER IS NOT NEGOTIABLE. A fresh
            // genesis opens the pool ~287x ABOVE `p_f` (S carries the 12M-PRIMES
            // bounty vault against one 4.2 GRAM donation), so the FIRST flush can
            // only ever REFUSE. Until 2026-09-20 this phase ran `report` and one
            // flush and called it covered: the FILL branch — the only branch that
            // moves `swapped`, burns PRIMES and advances the floor through the
            // venue — had never been driven on purpose on any set.
            S('sell PRIMES into the pool: price DOWN, under p_f', 'testnet/pool.ts', ['sell', 'L', '300000']),
            S('flush #1 — FILLS (permissionless)', 'proveFlushPermissionlessLive.ts'),
            S('buy PRIMES with GRAM: price UP, over the floor guard', 'testnet/pool.ts', ['buy', 'L', '15']),
            // The assert is the `payout#474f86cf` ARRIVING, not `lastOutcome`.
            // Every flush this project sent before 2026-09-17 was rejected by the
            // vault on forward-fee arithmetic and read as a floor-guard refusal.
            S('flush #2 — REFUSES, and the payout comes home', 'proveFlushPermissionlessLive.ts'),
            // 500,000, not 600,000: on the G93 set the 15 GRAM buy returned ~442,000 PRIMES, so L held
            // 541,919 at this step and the larger literal stopped the phase.
            S('sell again: price back under the floor', 'testnet/pool.ts', ['sell', 'L', '500000']),
            S('flush #3 — FILLS again (a refusal does not brick the ratchet)', 'proveFlushPermissionlessLive.ts'),
            S('treasury + distribution', 'testnet/lpGovernance.ts', ['status']),
            // THE EXIT PATH. LP has gone into the treasury on testnet and no route
            // back out was ever demonstrated — the worst shape a governed pot can
            // have on an audit. `withdraw` waits out the tier term, so it is
            // phase 7's; everything that can run now runs now.
            S('deposit two-sided into the treasury', 'testnet/lpGovernance.ts', ['deposit', 'L', '1', '0'], true),
            // OPTIONAL, and deliberately: with no position there is no address with code
            // to read, and a run that never got the deposit in should still reach the
            // governance and flush steps rather than stopping on a derived address.
            S('position + vote weight', 'testnet/lpGovernance.ts', ['position', 'L'], true),
            // R15: a position PROPOSES, VOTES and the proposal EXECUTES. Nothing
            // in any wave had ever put LP into custody, so every one of these arms
            // was structurally dead and `/treasury` rendered fixtures. D-139's divisor
            // makes `noticeDuration` and `voteDuration` ~514s each: `vote` waits out the
            // notice on the row's own `opens` (1206 before it — D-173 amendment, audit
            // R2-H1) and `execute` waits out the vote on the row's own `closes`, so each
            // proposal in this run costs ~17 minutes of wall-clock. The execute cannot be
            // deferred to a later phase, because the execute window lapses one vote
            // duration after the close (1204, D-188 point 7).
            // `last` resolves the seq off chain: a literal id is wrong on any set that
            // has seen a proposal before. (This step read `['propose', 'L', '0']` until
            // 2026-09-28 and failed the 4-argument usage check on every run.)
            S('propose within the cap (R15): 0.1 GRAM to F', 'testnet/lpGovernance.ts', ['propose', 'L', '0', '0.1', 'F'], true),
            S('vote the position', 'testnet/lpGovernance.ts', ['vote', 'L', 'last'], true),
            S('execute once the vote closes', 'testnet/lpGovernance.ts', ['execute', 'L', 'last'], true),
        ],
    },
    {
        id: '6',
        title: 'PRIMES staking paid from the treasury (D-168)',
        steps: [
            // `S` holds no PRIMES and nothing gives it any — `ensure` from `R2`, a
            // phase-2 gift beneficiary whose rebate no later step spends (the
            // 2026-09-21 run's lesson: a satisfied precondition sends nothing).
            S('fund the staker: S holds no PRIMES either', 'testnet/primes.ts', ['ensure', 'B', 'S', '150000']),
            S('stake 100k PRIMES at the 30-day tier (STKL)', 'testnet/stake.ts', ['stake', 'S', '100000', '0'], true),
            // `distribute()` reads its own interval first and refuses to send early;
            // the first one after genesis is due at once.
            S("the treasury's monthly budget to the stake master", 'testnet/stake.ts', ['distribute'], true),
            S('read the stream, the position and ST-1/ST-2', 'testnet/stake.ts', ['status', 'S']),
            S('claim what has streamed so far', 'testnet/stake.ts', ['claim', 'S', '0'], true),
        ],
    },
    {
        id: '7',
        title: 'the closes, the owner ops, and the matured venue change',
        steps: [
            // D-200: a descending lot rests an hour after it opens on this clock. `park-lots`
            // reads getParkScan first and refuses when nothing rests — optional for that reason.
            S('fold resting Dutch lots into the parked bit (D-200)', 'testnet/ops.ts', ['park-lots', '0', 'F'], true),
            S('close the composite lot', 'testnet/lot.ts', ['close', '123456792', 'F']),
            // The prime lot closes here too — winning MINTS it (D-90), which is what
            // grants `A` the §4.7.1 naming right the next step exercises.
            S('close the prime lot — the close Miller-Rabins it', 'testnet/lot.ts', ['close', '899809363', 'F']),
            // THE TWO CLAIMS, from the one wallet that provably owns a prime. Both
            // were named in §3 phase 7 and neither had a step: the only driver was
            // `proveTributeClaimLive.ts`, optional, hardcoded to the keeper key and
            // to a prime nobody owns on a fresh set, and journalling nothing.
            // An auction-won prime is AHEAD of the head and accrues no flat dividend (§3.2,
            // getClaimableDividend), so on testnet this step records that reading and sends nothing.
            S('claim_dividend, from a wallet that owns nothing', 'testnet/money.ts', ['dividend', '899809363', 'F']),
            S('claim_tribute, from the owner (throw 300 for anyone else)', 'testnet/money.ts', [
                'claim',
                '899809363',
                'A',
            ]),
            // The literal, not `-`: an auction mints off-head, so `annotate.ts who`'s walk over
            // the sequential line cannot see the prime the step above just won.
            // D-212: the OWNER names it for GRAM through the collection (`nameFee` the first
            // time). The fee goes to the floor; no PRIMES are needed.
            S('name the prime just won, for GRAM — the fee goes to the floor (§4.7.1, D-212)', 'testnet/annotate.ts', [
                'name',
                '899809363',
                'A',
                'named on the run record',
            ]),
            // D-194 — THE VENUE CHANGE'S SECOND KEY, cast HERE and not in phase 5 (audit
            // H1, 2026-11-19): the timelock confirms only a vote that closes at or after
            // the record's eta (808), i.e. its vote opens no earlier than `eta −
            // voteDuration`, so holders get the whole notice to lock LP and vote no. Since
            // audit R2-H1 the vote opens `noticeDuration` after the propose, so the propose
            // goes no earlier than `eta − noticeDuration − voteDuration` — on a D-139 set
            // ~1028 s before the phase-0 record matures; `propose` reads all three off
            // chain and waits or refuses. L's tier-0 position from phase 5 must still be
            // running when the vote OPENS (it matures one scaled 30 days after its deposit,
            // later than the eta); `vote` waits out the notice on the row's `opens` and
            // `execute` waits out the vote on the row's own `closes`.
            S('D-194: propose confirming the queued venue record', 'testnet/lpGovernance.ts', ['propose', 'L', '3', 'queued', 'timelock'], true),
            S('D-194: vote it', 'testnet/lpGovernance.ts', ['vote', 'L', 'last'], true),
            S('D-194: execute — the treasury confirms the timelock record', 'testnet/lpGovernance.ts', ['execute', 'L', 'last'], true),
            // Needs BOTH keys (D-194): the record queued in phase 0 (or by genesis) and
            // confirmed by the LP vote just above. `timelock.ts execute` reads `confirmed`
            // first and prints the missing vote steps instead of sending.
            S('execute the queued, LP-confirmed venue change (permissionless)', 'testnet/timelock.ts', ['execute', 'F']),
            S('redeliver it — idempotent by construction', 'testnet/timelock.ts', ['retry', 'F']),
            // The third arm of the only admin surface in the protocol. `execute`
            // consumes the queued record, so proving `cancel` needs a second one:
            // queue, then cancel, then read that nothing is queued.
            S('queue a second change, then cancel it', 'testnet/timelock.ts', ['queue']),
            S('cancel — the proposer can withdraw a queued change', 'testnet/timelock.ts', ['cancel']),
            S('the vault deferred book, scanned', 'testnet/bounty.ts', ['retry-scan', 'F']),
            // VESTING. A permissionless money path over the treasury's PRIMES
            // allocation (D-166: the only lock) that nothing in this repo has ever sent, on any
            // set, while the app renders `releasableNow` as a fill.
            S('release the treasury vesting lock (permissionless)', 'testnet/ops.ts', ['vest', 'F']),
            S('take the LP back out', 'testnet/lpGovernance.ts', ['withdraw', 'L', '0'], true),
            S('relock what came back', 'testnet/lpGovernance.ts', ['relock', 'L', '0', '0'], true),
            // `expire` is the ONE arm on either treasury contract with no sender
            // check at all, so "anyone may send it" is a property worth proving
            // from a wallet that owns nothing rather than only in the sandbox.
            S('expire a matured term — from a stranger', 'testnet/lpGovernance.ts', ['expire', 'L', '0', 'F'], true),
            S('send a position to the sink', 'testnet/lpGovernance.ts', ['to-sink', 'L', '0'], true),
            S('the indexer echoes the chain (INDEX_ECHO)', 'testnet/assert.ts', ['--index']),
        ],
    },
    {
        id: '9',
        title: 'the standards — royalties, the resale, the second number line',
        steps: [
            S('royalty destination on the collection', 'testnet/collections.ts', ['royalty']),
            S('ask each collection the standard question', 'testnet/collections.ts', ['ask', 'F']),
            S('a real GetGems resale (H18)', 'proveResaleLive.ts', [], true),
            S('the whole get-method surface, once more, with items on chain', 'testnet/surface.ts'),
        ],
    },
    {
        id: '10',
        title: 'the staked reserve — tsTON, the three arms and the three exit legs (D-151)',
        steps: [
            // READ FIRST, and the reads are not ceremony: `refusals` decides from
            // get-methods what each arm WOULD answer, so the run records all four
            // named guards (225/226/227/229) without firing a red transaction to
            // prove a refusal the sandbox already covers (§2.5 rule 1).
            S('the whole §4.3.2 read surface, and the mock behind it', 'testnet/tston.ts', ['status']),
            S('the four named refusals, computed and not fired', 'testnet/tston.ts', ['refusals']),
            // The counterparty's flat 1 GRAM deposit fee comes out of the GAS
            // BUFFER and never out of `pending` — a fee taken from the staked
            // amount would drop `T` on every stake and `p_f` with it. The buffer
            // accrues at RATCHET_HOP_GAS (0.005 GRAM/mint) and a run does not mint
            // enough to fill it, so it is topped up explicitly.
            S('top up the ratchet gas buffer (never `pending`)', 'testnet/tston.ts', ['buffer', '4', 'K']),
            // No donation step. It ran `donateFloor.ts` with NO amount, i.e. the full 132.50 GRAM
            // genesis donation (D-154), on every set whether or not D-153's divisor made it
            // pointless; on 20260929 it was stopped only by `K` being unable to afford it. A set
            // deployed WITHOUT the divisor needs a deliberate, sized `donateFloor.ts` run by hand
            // (TESTNET_MASTER_PLAN.md §4c), and `tston.ts stake` refuses with the arithmetic printed.
            S('stake — the contract sizes it, the caller names nothing', 'testnet/tston.ts', ['stake', 'F']),
            // A second stake is below the minimum by construction (the reserve was
            // just restored), so this re-reads rather than re-fires.
            S('re-read: the reserve is intact and a second stake refuses 226', 'testnet/tston.ts', ['refusals']),
            // HARVEST. tsTON does not rebase, so accrual is staged through the
            // contract's own zero-cost donation branch rather than by staking a
            // second time across a rate rise, which would cost the donation twice.
            S('donate tsTON — credited at zero cost, so it is yield', 'testnet/tston.ts', ['yield', '0.02', 'F']),
            S('harvest to the governed treasury — no term of T moves', 'testnet/tston.ts', ['harvest', 'F']),
            S('a second harvest refuses 228, and the interval is D-139-divided', 'testnet/tston.ts', ['refusals']),
            // THE EXIT MACHINE. `unstake` is callable only with the reserve short,
            // and one flush of any size is enough to make it so: the target falls
            // more slowly than `pending` does.
            // The spend must FILL, and by phase 10 arbitrage/keeper flushes have often taken the
            // pool back over p_f (1.54x on 20261121), so pull phase 5's lever again first.
            S('fund the lever again: K -> L', 'testnet/primes.ts', ['ensure', 'K', 'L', '300000']),
            S('sell PRIMES in: price under p_f so the spend FILLS', 'testnet/pool.ts', ['sell', 'L', '240000']),
            S('spend `pending` so the reserve runs short', 'proveFlushPermissionlessLive.ts'),
            S('LEG 1 — the pool fills out of its own buffer', 'testnet/tston.ts', ['exit', 'leg1', 'F']),
            // OPTIONAL: on a real-DeDust set leg 2's FILL is unreachable by construction and
            // `tston.ts exit leg2` refuses before sending (TESTNET_MASTER_PLAN.md §3 phase 10 step 7);
            // leg 3 drives the same EXIT_LEG_DEDUST -> EXIT_LEG_BILL transition.
            S('LEG 2 — fill_or_kill re-mints, the guarded swap fills', 'testnet/tston.ts', ['exit', 'leg2', 'F'], true),
            S('LEG 3 — no quote clears cost, so a bill is minted', 'testnet/tston.ts', ['exit', 'leg3', 'F']),
            S('the bill settles at round end and `pending` comes home', 'testnet/tston.ts', ['settle', 'F']),
            // §5's ONE external risk, and the only place a live run sees it: the
            // counterparty pays under cost and the shortfall is PUBLISHED rather
            // than absorbed. No path the contract chooses can produce it.
            S('a slashed rate — realizedLoss published, not hidden', 'testnet/tston.ts', ['exit', 'loss', 'F'], true),
            S('settle the slashed bill', 'testnet/tston.ts', ['settle', 'F'], true),
            // Both payout arms accept an UNAUTHENTICATED sender, because the bill
            // collection's address is salted with random() and cannot be
            // whitelisted. The defence is arithmetic; this is what proves it live,
            // and the transactions must be GREEN (the 2026-09-17 class).
            S('forge both payout arms from a stranger — a donation, not a hole', 'testnet/tston.ts', ['forge', 'F']),
            // tsTON is a proposable treasury asset (ASSET_TSTON = 2 since D-167). The harvest
            // above is the only thing that ever puts it there, so this is the one
            // window in the whole plan where the proposal has a balance to move.
            // 0.004, under proposal_cap_bps (25%) of the 0.02 tsTON one harvest of 'yield 0.02' leaves: the
            // G93 run proposed 0.01 and execute refused 1161 (cap 0.005) after the vote.
            S('propose the harvested tsTON (asset 2)', 'testnet/lpGovernance.ts', ['propose', 'L', '2', '0.004', 'F'], true),
            S('vote it', 'testnet/lpGovernance.ts', ['vote', 'L', 'last'], true),
            S('execute it — tsTON leaves the treasury', 'testnet/lpGovernance.ts', ['execute', 'L', 'last'], true),
            S('the whole get-method surface, with a staked position on chain', 'testnet/surface.ts'),
            S('the indexer echoes the chain (INDEX_ECHO)', 'testnet/assert.ts', ['--index']),
        ],
    },
];

function run(step: Step): boolean {
    const script = path.join(REPO, 'contracts', 'scripts', step.script);
    console.log(`\n=== ${step.what}\n    ${step.script} ${(step.args ?? []).join(' ')}`);
    const r = spawnSync('npx', ['tsx', script, ...(step.args ?? [])], {
        cwd: REPO,
        stdio: 'inherit',
        shell: process.platform === 'win32',
    });
    const ok = r.status === 0;
    if (!ok && step.optional) {
        console.log(`    (optional step failed with ${r.status} — continuing, the journal records it)`);
    }
    return ok;
}

/**
 * A transaction can be committed a little after the step that sent it, so the
 * bound is deliberately not exact-to-the-second — it is pulled back two minutes.
 * Wide enough to catch a late commit, far too narrow to reach the previous phase.
 */
const AUDIT_LEAD_SECS = 120;

/**
 * THE PHASE'S OWN WINDOW — §2's "clean over the window the phase ran in".
 *
 * This used to pass a FIXED `--since 2h`/`--since 6h`, which is not that window:
 * once any phase produced one red transaction, every later phase re-reported the
 * same transaction by hash and failed for it, so a ten-phase run could never
 * return to green until the fixed window rolled past. Wave 5 is where that bit —
 * phase 3 was clean and exited 1 on phase 2's two keeper `flush()` aborts.
 *
 * `--since-utime` is absolute, so the bound is the instant this phase started
 * (less the lead above) and nothing before it is in scope. The standalone
 * `txAudit.ts --since 12h` form is untouched and is still the whole-run sweep.
 */
function audit(sinceUtime: number): boolean {
    console.log(`\n--- txAudit since ${new Date(sinceUtime * 1000).toISOString()} — every transaction, not every figure`);
    const r = spawnSync(
        'npx',
        ['tsx', path.join(REPO, 'contracts', 'scripts', 'testnet', 'txAudit.ts'), '--since-utime', `${sinceUtime}`],
        { cwd: REPO, stdio: 'inherit', shell: process.platform === 'win32' }
    );
    return r.status === 0;
}

/** `from` resumes a stopped phase at that step (1-based, as `list` numbers them). */
function runPhase(p: Phase, from = 1): boolean {
    console.log(`\n\n########## PHASE ${p.id} — ${p.title}${from > 1 ? ` (from step ${from})` : ''}`);
    const startedAt = Math.floor(Date.now() / 1000) - AUDIT_LEAD_SECS;
    let ok = true;
    for (const step of p.steps.slice(from - 1)) {
        const stepOk = run(step);
        if (!stepOk && !step.optional) {
            console.error(`\nPHASE ${p.id} STOPPED at "${step.what}". Fix it, then re-run that script alone.`);
            return false;
        }
        ok = ok && (stepOk || !!step.optional);
    }
    const clean = audit(startedAt);
    if (!clean) {
        console.error(
            `\nPHASE ${p.id}'s get-methods passed and its TRANSACTIONS did not. That is a finding, not a ` +
                `flake — read the tonviewer links above before continuing.`
        );
        return false;
    }
    return ok;
}

function main() {
    assertTestnetOnly();
    const [cmd, ...rest] = process.argv.slice(2);
    if (cmd === 'report') {
        process.stdout.write(render());
        return;
    }
    if (!cmd || cmd === 'list') {
        for (const p of PHASES) {
            console.log(`${p.id.padStart(2)}  ${p.title}`);
            for (const [i, s] of p.steps.entries()) {
                console.log(`  ${String(i + 1).padStart(4)}. ${s.optional ? '(optional) ' : ''}${s.what}  [${s.script}]`);
            }
        }
        return;
    }
    if (cmd === 'phase') {
        const p = PHASES.find((x) => x.id === rest[0]);
        if (!p) throw new Error(`no phase "${rest[0]}" — run "run.ts list"`);
        const fromIdx = rest.indexOf('--from');
        process.exitCode = runPhase(p, fromIdx >= 0 ? Number(rest[fromIdx + 1]) : 1) ? 0 : 1;
        return;
    }
    if (cmd === 'all') {
        const untilIdx = rest.indexOf('--until');
        const until = untilIdx >= 0 ? rest[untilIdx + 1] : PHASES[PHASES.length - 1].id;
        for (const p of PHASES) {
            if (!runPhase(p)) {
                process.exitCode = 1;
                return;
            }
            if (p.id === until) break;
        }
        console.log('\nrun complete. Generate the record with:');
        console.log('  npx tsx contracts/scripts/testnet/run.ts report > docs/audit/testnet-run-<date>.md');
        return;
    }
    console.log('usage: run.ts list | phase <id> [--from <step>] | all [--until <id>] | report');
}

if (require.main === module) {
    try {
        main();
    } catch (e: any) {
        console.error(e?.message ?? e);
        process.exit(1);
    }
}
