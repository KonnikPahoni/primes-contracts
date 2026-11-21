# Invariant coverage (I3)

Which invariants from `CLAUDE.md`'s "must never be broken" list have a named test
proving them, and which don't. This is measurement only — no code or test was changed
to produce this document.

**Re-derived 2026-09-04 (readiness sweep, GAUNTLET.md A19)** for the two rows the
2026-09-01 D-90 note above had left unresolved. Rows 9 and 10 below now reflect current
`CLAUDE.md` wording and current code/tests; nothing else in the table changed.

**Re-derived 2026-09-13 (GAUNTLET.md I9, filed at readiness sweep #13/iter #873).** This
pass had gone three days stale against `DECISIONS.md` D-106 (2026-09-07, which deleted
patron mode whole): row 8 still documented the deleted `PATRON_CAP` invariant as **Tested**,
and rows 1/4/7 cited `PrimesRankPatron.spec.ts`, a spec file that no longer exists
(confirmed: `ls contracts/tests/PatronCap.spec.ts contracts/tests/PrimesRankPatron.spec.ts`
— neither exists). Fixed: (1) row 8 now states `CLAUDE.md`'s current invariant — **THE
RECRUIT EDGE**, "recruiting pays no TON, and §4.1's referral line is the only thing that
does" — citing `primes_ledger.tolk:3871`'s own "§4.5 / §4.7 / D-106: THE RECRUIT EDGE"
comment and `:3888`'s `isRecruit` guard, tested by `contracts/tests/EraTrophy.spec.ts`
(confirmed live: "D-106: an ordinary self-mint is not a recruit — only a GIFT is" and
"D-106 THE SYBIL GUARD: gifting the SAME wallet again counts once"); (2) rows 1 and 7's
dead `PrimesRankPatron.spec.ts` citations are repointed at `contracts/tests/
UpliftStackStake.spec.ts`, confirmed live and covering the same `kMaxEffective`/K_CEIL-
clamp claim (`getUpliftLine`'s "returns seven values, with the stake leg between
recruitRank and summed", "when the sum overflows the ceiling the total stops at K_CEIL
exactly — once", "k < 1 holds with five legs, at every n and at the maximum stackable
line"); row 4's dead citation is dropped rather than repointed — `UpliftStackStake.spec.ts`
does not test split closure, and `SplitClosure.spec.ts`'s own citations already prove the
invariant in full without a patron-specific case, so row 4's invariant wording also drops
its now-nonexistent "no patron" clause (there is no patron line left to be unresolvable);
(3) every `:line` citation across all ten rows was re-walked against HEAD, since two
redeploys and Track V/T's worth of contract edits have landed since the 2026-09-04 pass:
row 1's `kMaxEffective` (`:1331` → `:2051`), row 3's `storage.T = msg.seedT` (`:2246` →
`:3018`) and `storage.T += poolInjectionFinal + premium` (`:3119` → `:4014`), row 7's
`PRIME_UPLIFT`/`PRIME_WINDOW` (`:205-206` → `:241-242`), row 9's `getLotLane` (`:2178` →
`:2786`) and `MINT_PRICE` (`primes_market.tolk:149` → `:156`), row 10's `getSolvency` on
the ledger (`:3778` → `:4745`), ratchet (`:627` → `:703`) and registrar (`:1628` →
`:2396`). Row 9's two `PrimesMarket.spec.ts` test-name citations were also found stale
while re-walking that row (not a patron-drift, but caught in the same pass and cheap to
fix in place): "gives every NON-SPECIAL number exactly one route, and the route is its
primality" is now "gives EVERY number exactly one route, and its SCORE never changes it
(D-88/D-99)", and D-99's price-lift change means "C6: an ordinary prime lot decays to
EXACTLY 1 TON, and parks there forever" is now "C6: an ordinary prime lot decays to
EXACTLY its resting price, and parks there forever". **Not re-walked**: row 6's
`NoAdminWithdraw.spec.ts` citation ("exactly FOUR sends... reach an operator address")
is also now stale — D-90.2 removed one of the four and the file's own tests say "exactly
THREE" — but that drift is unrelated to D-106/patron and outside this item's scope; filed
separately as `GAUNTLET.md` I10 rather than fixed here.

**Re-derived 2026-09-13 (GAUNTLET.md I10).** Row 6's `NoAdminWithdraw.spec.ts` citation
quoted two test names that no longer exist in `contracts/tests/NoAdminWithdraw.spec.ts`:
"§8: exactly FOUR sends… reach an operator address" and "the release forfeit is relayed
from a peer, not computed for an operator on demand" — both from before D-90.2 deleted
the market's 10% release forfeit, one of the four operator-reaching sends. The file's
current `it()` blocks (confirmed live, `:119`–`:247`) are "§8: exactly THREE sends in the
entire protocol reach an operator address", "§8: not one of those three takes its amount
from the caller", "§8: the sweep pays only the surplus ABOVE declared liability, and is
permissionless", "§8: the market knows no operator address at all (D-90.2)", "§8: no
contract sends to an address a privileged role supplies", and "§8: the ONE governed send
is a voted destination, not a role-supplied one (D-100 point 8)" — the last two are new
tests the previous citation list never named at all. Row 6's citation list is rewritten to
the current six, in file order, plus the untouched `FuzzInvariants.spec.ts` citation.
Checked the row's own prose (invariant/enforced-in columns) for "four" per I10's own
instruction: neither mentions a count, so no other text in the row needed correction.

**Line citations re-verified 2026-09-04 (readiness sweep, GAUNTLET.md Sweep #31).** A19's
pass fixed rows 9/10's wording but never re-walked the other eight rows' `:line` citations
against HEAD, and six had drifted — code added above them since the doc was last written
moved every downstream line number, the same class of drift `contract-surface.md`/
`wire-format.md` exist as scripts to prevent for the opcode census. Fixed by reading each
citation and confirming or correcting it against HEAD, not by re-running a generator (this
doc has none — "hand-written and hand-maintained" per its own methodology note): row 1's
`kMaxEffective` (`:1270` → `:1331`), row 3's `storage.T = msg.seedT` (`:2112-2113` →
`:2246`) and `storage.T += poolInjectionFinal + premium` (`:2938` → `:3119`), row 8's
`PatronData` struct (`:237-240` → `:894-900`), and row 9's `getLotLane` (`:2639` → `:2178`)
and `MINT_PRICE` (`primes_market.tolk:117` → `:149`). Row 6 was a sharper miss than a stale
line number: it cited `primes_market_shard.tolk`'s header comment as live evidence that no
contract has a withdraw path — but D-90 (2026-09-01) deleted that entire contract along
with the escrow it custodied, so the doc was citing a comment in a file that no longer
exists in the repo. Reworded to state the deletion directly rather than pointing at a dead
citation. Every test-name citation across all ten rows was independently re-grepped against
its cited spec file this pass and all matched (either an exact `it(...)` string or, for
`MarkRejectedRace.spec.ts`'s paraphrased row-10 citation, a real test covering the same
claim) — the drift was confined to source line numbers and the one deleted-file citation,
not to which tests actually prove which invariant. No code or test changed; this file only.

**Regenerated 2026-08-29 (GAUNTLET.md I3).** The previous version (P0.6, 2026-08-18) was
stale on three counts, found while re-deriving this table rather than trusting its
citations: it listed nine invariants, but `CLAUDE.md` has grown a tenth (the one-route
auction/Dutch-lane rule, added with D-30/D-31); its `T` identity was the pre-D-26
two-term form (`T = swapped + pending`), missing the `seeded` term genesis credits
straight into `T`; and two of its test citations (`FeeLines.spec.ts` for the split
closure, `PatronageEndToEnd.spec.ts` for the patron cap) point at files that still exist
but have moved on to testing something else (TEP-66 royalty/ops-sweep, and nothing
patron-shaped at all) — the tests that actually prove those two claims today live
elsewhere. Hand-written and hand-maintained, same as before: the ten invariants are a
fixed list from `CLAUDE.md`, not something a script can enumerate.

**Extended 2026-09-16 (the `/verify` page).** Row 6 now also carries the *immutability*
half of §8. The withdraw surface bounds where money may go **given the code that is
running**; without a no-upgrade property that bound says nothing about tomorrow, so the two
belong in one row rather than being left as an unstated premise. The assertion is new —
`NoAdminWithdraw.spec.ts`'s "has no code-upgrade primitive in any contract" — and it scans
the whole `contracts/contracts/` directory rather than a fixed list. The property itself was
already true (the scan passed on first run); what changed is that it is now guarded. The
webapp route `/verify` publishes this row, rows 1 and 2, and the generated
`withdraw-surface.md` table, parsed from these documents rather than re-typed.

## The ten invariants

| # | Invariant (`CLAUDE.md` wording) | Enforced in | Tested by | Status |
|---|---|---|---|---|
| 1 | `k < 1` always, via the single `K_CEIL` clamp on the summed uplifts | `primes_ledger.tolk:2051` (`kMaxEffective` sums tier + window uplifts, clamps once) | `KMaxCurve.spec.ts` — "never exceeds the K_CEIL-bearing cap, for any n on the line"; `KMaxCurve.spec.ts` — "k < 1 is NOT what breaks here — K_CEIL is a separate and still-intact guard"; `UpliftStackStake.spec.ts` — "returns seven values, with the stake leg between recruitRank and summed"; "when the sum overflows the ceiling the total stops at K_CEIL exactly — once" | **Tested** |
| 2 | `S` is cumulative emission plus the genesis bounty vault, never decremented | Structural — grep for `storage.S -=` / `.S -=` across `primes_ledger.tolk` and `primes_ratchet.tolk` returns nothing; `S` is only ever incremented | `DecompositionSolvency.spec.ts` — "CLAUDE.md invariant #2: S is unchanged immediately before/after a flush() and its burn"; `GenesisRehearsal.spec.ts` — "runs the full genesis pipeline end to end and opens the line at the first composite" (asserts the bounty vault is pre-counted into `S`) | **Tested** |
| 3 | `T = seeded + swapped + pending`, incremented at mint, not at flush (D-26 three-term identity) | `primes_ledger.tolk:3018` (`storage.T = msg.seedT` at genesis, comment cites D-26 by name); `:4014` (`storage.T += poolInjectionFinal + premium` inside `handleMint`) | `GenesisRehearsal.spec.ts` — "opens the ledger at D-29 L = 10,000, and closes D-26 three-term identity"; `FuzzInvariants.spec.ts` — "holds all ten invariants across a generated operation sequence" (its `checkInvariants` helper asserts `T === seeded + pending + swapped` after every generated step, and the same helper reruns inside the corpus/adversarial/bounce-storm/I9 specs in that file); `DecompositionSolvency.spec.ts` — "CLAUDE.md invariant #3: T moves inside handleMint and is untouched by handleFlush" (timing half, two-term); `PrimesGenesisMint.spec.ts` — "flush() respects cooldown/pct/min guards and preserves T = swapped + pending" | **Tested** |
| 4 | The split is closed at 100%; unresolvable lines (no referral key, no tribute recipient) fall to the pool, never to the team | `primes_ledger.tolk`'s split-closure branches in `executeMint`/`handleMint` (no team-address fallback anywhere in the fold path — D-106 deleted the patron line whole, it is not one of the unresolvable cases) | `SplitClosure.spec.ts` — "composite, NO referral key — the dead line folds into the pool"; "composite, referral key AHEAD of the head — unresolvable, folds to the pool"; "closes at 100% with the tribute line unresolvable, and the treasury still takes only 5%"; "the pool got the tribute line ON TOP of β — the fold is visible, not inferred" | **Tested** |
| 5 | `flush()` is permissionless and fills only at or below `p_f` — the floor guard | `primes_ratchet.tolk`'s `Flush` handler has no sender check; `computeMinOut()` implements `min_out = amount * S / T * (1 + FLOOR_GUARD)` | `DecompositionSolvency.spec.ts` — "B3: min_out = amount * S / T * (1 + FLOOR_GUARD), multiplied before divided"; "B3: the guard is priced from S and T in their own nano-units, with no stray 1e9"; `SenderGates.spec.ts` — "THE CLAIM: every arm is authorised or is on the deliberate-open list" (classifies `Flush` under the `PERMISSIONLESS` table as "§4.3.1 — permissionless, floor-guarded") | **Tested** |
| 6 | No admin withdraw path on any TON balance, not timelocked, not multisig | Structural — grep for a `withdraw`-named handler across all 16 live contracts returns none; and structurally upstream of that, no contract can be REPLACED: no `.tolk` source calls `setContractCodePostponed`/`set_code`/`SETCODE`, and none carries an owner field, an admin opcode or a pause (`primes_market_shard.tolk`, the one contract whose header comment used to state this claim for the escrow it custodied, is gone: D-90 deleted the escrow shard along with the claim/release right, so there is no third TON pool left to make the claim about) | `NoAdminWithdraw.spec.ts` — "covers every contract that can send TON at all"; "classifies every destination — an unrecognised one is a finding, not a default"; "§8: exactly THREE sends in the entire protocol reach an operator address"; "§8: not one of those three takes its amount from the caller"; "§8: the sweep pays only the surplus ABOVE declared liability, and is permissionless"; "§8: the market knows no operator address at all (D-90.2)"; "§8: no contract sends to an address a privileged role supplies"; "§8: the ONE governed send is a voted destination, not a role-supplied one (D-100 point 8)"; "has no code-upgrade primitive in any contract (§8: the code that is deployed is the code)" — a whole-directory scan, so a contract added later is covered on the day it lands; `FuzzInvariants.spec.ts` — "I5: no privileged sender has a withdraw path out of the ledger" | **Tested** |
| 7 | `PRIME_UPLIFT · PRIME_WINDOW < k_max(n)` | `primes_ledger.tolk:241-242` (`PRIME_UPLIFT = 0.05`, `PRIME_WINDOW = 6`, product 0.30, checked at runtime via `kMaxEffective`) | `KMaxCurve.spec.ts`, describe "§5.1: PRIME_UPLIFT · PRIME_WINDOW < k_max(n), swept across the line" — "holds strictly across every decade the head can realistically reach"; "reaches EQUALITY at exactly n = 10⁹ — the invariant is strict, so this is where it stops holding"; "fails properly above 10⁹, in a region where NEITHER clamp is binding"; "locates the crossing by binary search, so the boundary is a measured number and not a comment"; `UpliftStackStake.spec.ts` — "k < 1 holds with five legs, at every n and at the maximum stackable line" | **Tested** |
| 8 | **THE RECRUIT EDGE** (D-106, replaces the deleted `PATRON_CAP` invariant): recruiting pays no TON, and §4.1's referral line is the only line that does. A §4.5 gift mint (`payer != beneficiary`) to an address `minterState` has never seen credits the payer +1 recruit (a `k_max` uplift tier, bounded by the single `K_CEIL` clamp) and opens the beneficiary's newcomer window; `!isFound` is the whole sybil guard, so gifting the same wallet twice counts once | `primes_ledger.tolk:3871-3888` (comment: "§4.5 / §4.7 / D-106: THE RECRUIT EDGE"; `val isRecruit = payer != beneficiary && !msLook.isFound` at `:3888` — no split line, no patron struct, no purse) | `EraTrophy.spec.ts` — "D-106: an ordinary self-mint is not a recruit — only a GIFT is"; "counts a gift to an address the ledger has never seen"; "D-106 THE SYBIL GUARD: gifting the SAME wallet again counts once"; `UpliftStackStake.spec.ts` — "returns seven values, with the stake leg between recruitRank and summed" (the recruit-rank leg enters the same clamped sum as every other uplift, so it cannot push k past K_CEIL) | **Tested** |
| 9 | **One route to a number at any moment, and the head decides which** (D-30/D-45/D-88/D-90): ahead of the head, every number — prime or composite, special or plain — is a paid ascending auction, and winning MINTS the number in the closing transaction; at its turn, a composite mints sequentially for 1 TON and a prime opens a descending lot from `P0(p)` down to `max(NPV(p)/2, MINT_PRICE)` and parks there with no expiry. The old "no lane may terminate above 1 TON except the special-prime parked price" text is deleted by D-88 — there are exactly two lot modes and no special-only lane | `primes_market.tolk:2786` (`getLotLane(n)`, ascending vs descending by primality and head position); `:156` (`MINT_PRICE` = 1 TON, the descending lane's floor); D-90's close-mints-in-transaction path in the `CloseLot` arm | `PrimesMarket.spec.ts`, describe "D-88 · a prime ahead of the head is an ascending auction; behind it, a descending one"; describe "D-90 - a won composite mints in the close transaction"; describe "C7 · getLotLane — exactly one route per number, by primality alone" — "routes every number in a dense sweep exactly as the rule says"; "gives EVERY number exactly one route, and its SCORE never changes it (D-88/D-99)"; "answers -1 for every primorial in range, and a real lane on both sides of each"; "the lane it predicts is the mode the lot actually opens in"; "C6 (D-88): every prime lane rests at getPrimeFloor(n), and PARKS there"; "C6: an ordinary prime lot decays to EXACTLY its resting price, and parks there forever (D-99)" | **Tested** |
| 10 | **Two separate pools of TON with two different owners** — `pending` (ratchet, nobody's) and `owed` (ledger, the prime owners') — each in its own contract, `balance ≈ declared liability` checkable in one get-call. D-90 deletes the escrow and `primes_market_shard.tolk` with it, so there is no third pool; the registrar also answers `getSolvency()` but its declared liability is structurally zero (it custodies no protocol TON), so it is a reconciliation check, not a third pool | `getSolvency()` on `primes_ledger.tolk:4745` (`owed`), `primes_ratchet.tolk:703` (`pending`), `primes_registrar.tolk:2396` (trivial, liability always 0 — see the contract's own header comment) | `DecompositionSolvency.spec.ts` — "B1: every contract answers `balance vs its own declared liability` in ONE get-call" (now checks ledger/ratchet/registrar, not a fourth escrow contract); `FuzzInvariants.spec.ts` — the same "holds all ten invariants..." run re-checks `getSolvency()` on all three after every generated step; `MarkRejectedRace.spec.ts` — carries the surviving assertions from the deleted `EscrowAggregate.spec.ts` now that there is no escrow to aggregate | **Tested** |

## Summary

**All ten invariants are enforced in code, and all ten have a direct, discoverably-named
test proving them today.** No invariant came back `UNENFORCED`. The 2026-08-29 regeneration
found no new gap — the drift was entirely in the previous version's own bookkeeping (missing
invariant #9, the two-term `T` identity, and two stale test citations), not in the code
or its coverage. The 2026-09-04 re-derivation (rows 9 and 10, above) is the same story:
D-88/D-90 changed the rule and the code and tests already followed; only this table's own
wording had lagged. Corrected here; nothing filed to `GAUNTLET.md` beyond the re-derivation
item itself. The 2026-09-13 re-derivation (`GAUNTLET.md` I9) is the same story a third time
— D-106 deleted patron mode and the code and tests already followed; only row 8's wording
and rows 1/4/7's dead citations had lagged, three days behind the decision. All ten
invariants remain enforced and tested; one unrelated stale test-name citation found in row 6
while re-walking this pass (D-90.2 changed an operator-send count from four to three) was
filed as `GAUNTLET.md` I10 and is now corrected (2026-09-13, above) — row 6 cites the
current six `NoAdminWithdraw.spec.ts` test names in file order.
