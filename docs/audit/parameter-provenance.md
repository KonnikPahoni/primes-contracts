# Parameter provenance — every constant → the sim run that produced it

`GAUNTLET.md` Track I ("the audit pack"), item I8. `CLAUDE.md` rule 3: "never invent an
economic parameter... hardcoding a number in a contract or in the UI that is not
traceable to [`shared/params.json`] is a bug." `stat-provenance.md` (I-track, generated
by `tools/stat-provenance.mjs`) already proves the *demand* side of that rule — every
number the webapp shows traces to a get-method. This document proves the other half: for
every economic constant declared in a contract, where it comes from and what pins it
against drift.

**Manual audit, not a regenerated report** — a script can grep constant declarations
(and did, for the inventory below), but deciding which of them are *economic* rather
than wire/encoding, and whether an in-file comment is a real citation, is a judgement
call the same way `scope.md` and `known-limitations.md` are. Re-run the audit whenever a
new `.tolk` file adds a top-level `const`.

## Method

`contracts/contracts/*.tolk` declares 143 top-level `const NAME: (int|coins) = ...`
constants. Excluded from this audit as not economic in nature (they encode wire format,
gas cost, or enum tags, not game balance, so CLAUDE.md rule 3 does not apply to them):

- **Opcodes and tags** — `PROGRAM_TAG_*`, `*_ACTION_*`, `BURN_TAG`, `CLAIM_TAG`,
  `DEDUST_SWAP_OP`.
- **Enum-style mode/status constants** — `MODE_ASCENDING`/`MODE_DUTCH_BUYNOW*`,
  `SPECIAL_TIER_*`, `FLUSH_NEVER`/`FLUSH_FILLED`/`FLUSH_BOUNCED`, `SET_TWIN_PAIR` and its
  siblings (these are the `constellations.shipped_set_types` ids, structural not
  economic).
- **Fixed-point/encoding scale factors** — `K_SCALE`, `FRAC_SHIFT`, `BPS_DEN`.
- **Pure TVM gas budgets** (`*_GAS`, `*_HOP_GAS`, `TRANSFER_GAS`) — these price compute,
  not game balance; `contracts/gas-baseline.json` and `GasRegression.spec.ts` are their
  provenance chain, already covered by CLAUDE.md's "Measured provenance" section.

That leaves **~48 genuinely economic/game-balance constants**, checked one by one against
`shared/params.json` and the test suite. `shared/params.json` itself has three disjoint
generators (`sim/scripts/run_phase1.py` owns everything except the two keys below;
`run_constellations.py` owns `constellations`; `run_determinations.py` owns
`determinations` and `acquisition` — `run_phase1.py`'s own `FOREIGN_PARAM_KEYS` constant
enforces the split so one generator's run never silently deletes another's block).

## Result: no untraceable constant found

Every economic-shaped constant checked either **(a)** matches a `shared/params.json`
value exactly (a direct read or a simple percentage-of/sum-of derivation), or **(b)**
carries an explicit in-file comment naming why it is deliberately *not* sim-sourced — a
`DECISIONS.md` D-number, an owner-declared exception, or params.json's own
self-disclosure (`trophy_auction`'s `_declared_note`: several auction constants are
"owner-declared, NOT a simulation output"). No constant was found that is plausibly
economic, has no params.json match, and has no comment or decision citing where it came
from — the bar this audit set out to check.

Representative bindings (the full mint/rebate/flush/fee core — `MINT_PRICE`,
`TRIBUTE_AMOUNT`, `K_CEIL`, `PRIME_UPLIFT`, `FLUSH_PCT`, `OPS_RESERVE`, and
sixteen more) are pinned by `SimCrossCheck.spec.ts`'s `C12` binding table — a generic
harness (`declared()` reads the `.tolk` source literal, `param()` reads the params.json
path, one `it()` per row) that fails loudly on a rename or a resize on either side.
Others are pinned by their own dedicated spec (`OperatorVesting.spec.ts`,
`KMaxCurve.spec.ts`, `Sinks.spec.ts`'s burn-price block, `UpliftStackStake.spec.ts`).

**Corrected this sweep (readiness sweep #38, 2026-09-13):** this section previously also
named `PATRON_CAP` as a live C12 binding and `PatronCap.spec.ts` as its dedicated pin.
`DECISIONS.md` D-106 (signed 2026-09-07) deleted §4.6's patron line in its entirety —
`PATRON_CAP`, `PATRON_PHI1_AMOUNT`, `PATRON_PHI2_AMOUNT` and the `patronage` key itself
are gone from both the contracts and `shared/params.json` (`SimCrossCheck.spec.ts`'s own
C12 table already documents the deletion inline, around its `N0_ANCHOR` row), and
`PatronCap.spec.ts` no longer exists in `contracts/tests/`. Citing them here was citing
dead code, the same class of staleness this document's own D-89 correction (below)
already fixed once for `CROWN_FLOOR_NUM`/`CROWN_P0_NUM`. Removed rather than left to
mislead a reader into looking for a constant or a spec file that are no longer there.

**Deliberately unwired, and correctly so** — confirmed by comment, not assumed:

- `STAKE_UPLIFT_MAX = 0` — "D-34. Raising it is a fresh deployment (D-10)." Already listed
  in `known-limitations.md` §1.
- `BURN_MIN_GRACE` (voucher) — "This is not an economic parameter... fixed here rather
  than in params.json," by its own header.
- `VEST_TRANCHES`/`VEST_INTERVAL` — "a DISCLOSURE SCHEDULE, not economic parameters...
  CLAUDE.md rule 3 is not engaged."
- `TIMELOCK_DELAY` — a governance/safety constant ("30 days, engineering-spec §4.9"), not
  a game-balance figure.
- `AUCTION_WINDOW`, `BID_EXTENSION`, `SCORE_HALVING`, `PRIME_P0_MIN`,
  `PRIME_P0_MULT_NUM/DEN` — params.json's `trophy_auction._declared_note` states these
  are owner-declared, and the comments cite `D-3` ("the Fragment-style clock") and the
  prime-ness of 4020s ("67 minutes... deliberately prime").
- `MAX_MEMBERS = 14` / `MAX_TOTAL_EXPONENT = 48` (registrar) vs. `constellations.max_members
  = 7` / `max_total_exponent = 18` in params.json — **not a mismatch**: the contract
  constants are structural worst-case bounds, params.json reports the sim's *measured*
  maximum actually reached below the simulated horizon. The registrar comment explains
  the divergence; `DictGrowth.spec.ts` checks params.json's bound is itself sane (`0 <
  max_members < 64`), not equality to the contract.
- `DIRICHLET_MIN_N = 100000` / `DIRICHLET_MOD = 101` (`primes_market.tolk`,
  `primes_ledger.tolk`) — added since this audit was first written (**D-96**, signed
  2026-09-03, replacing D-68's `small_primes` family with the `dirichlet_primes` one).
  Both constants' own comment states they are "OWNER-DECLARED (the density ceiling is an
  owner constraint, not a sim output)", the same class as `AUCTION_WINDOW`/`SCORE_HALVING`
  above; `shared/params.json`'s `determinations...dirichlet_primes` entry (`count: 488`,
  `tier: "free"`) is the sim's *measured* population under the owner's declared density
  ceiling, not the source of the two constants themselves. Confirmed both contracts still
  carry byte-identical values (comment: "must stay byte-identical to `primes_ledger.tolk`'s
  copy").

## The one real gap found: a citation with no test

`primes_registrar.tolk`'s four discovery-bounty constants — `BOUNTY_TWIN_PAIR`,
`BOUNTY_SOPHIE_GERMAIN`, `BOUNTY_COMPLETE_FACTORIZATION`, `BOUNTY_PRIMORIAL_CROWN` — were
already comment-cited to `constellations.discovery_bounty.per_type.*.bounty_nanoprimes`
and their literal values already matched that path exactly (verified byte for byte: `5167322834`,
`9619789280`, `0`, `3600000000000`). But **no test pinned them** — a resize on either
side (a sim re-run, or an edit to the constant) would have drifted silently until
someone happened to re-derive it by hand, exactly the failure class C12 exists to catch
for its other 24 rows.

**Fixed in this iteration, not just filed**: added four rows to `SimCrossCheck.spec.ts`'s
`C12` `BINDINGS` table (`BOUNTY_TWIN_PAIR`/`BOUNTY_SOPHIE_GERMAIN`/
`BOUNTY_COMPLETE_FACTORIZATION`/`BOUNTY_PRIMORIAL_CROWN`), following the exact pattern of
the existing 24 — this is closing a coverage gap the table itself was designed to catch,
not new mechanics or surface, so it is ordinary gauntlet work rather than an escalation.
Verified by hand (this sandbox cannot execute the suite itself — see below): all four
`declared()` reads equal their `param()` targets exactly.

One smaller citation noted, not fixed — it does not rise to "untraceable," it is
one-line documentation staleness:

- `RES_FEE`/`ITEM_DEPLOY_VALUE` are comment-cited (to a params.json path, or in
  `ITEM_DEPLOY_VALUE`'s case to the deleted `docs/phase0-report.md §5`, now unverifiable
  provenance per `CLAUDE.md`'s "before concluding something is unimplemented" note) but
  not test-pinned. Smaller than the bounty gap — these are single scalars already covered
  indirectly by `FeeLines.spec.ts` / `GenesisRehearsal.spec.ts`'s broader split-closure
  assertions, not left bare the way the four bounty constants were.

**Corrected this sweep (Sweep #22, 2026-09-04):** this bullet originally also named
`CROWN_FLOOR_NUM`/`CROWN_P0_NUM` — **D-89 (2026-09-01) deleted both from the contract set
entirely** ("the crown constants were OWNER-DECLARED in params.json... this removes a
hand-picked economic input rather than adding one", `primes_market.tolk`'s own comment
above `specialNumberTier`), so citing them as "not test-pinned" was citing dead code, not
a live gap. `grep -rn "CROWN_FLOOR_NUM\|CROWN_P0_NUM" contracts/contracts/*.tolk` returns
nothing. Removed from the list rather than left to mislead a reader into looking for a
constant that is no longer there.

## `SimCrossCheck.spec.ts`'s C12 suite could not be executed in this sandbox

`SimCrossCheck.spec.ts` replays a trace exported by `sim/scripts/export_trace.py
--mode chain-replay` into `sim/output/chain_replay_trace.json` (gitignored, generated on
demand); the whole file is `describe.skip`'d when that file is absent. Generating it in
this sandbox segfaults inside NumPy's C extension after `LD_LIBRARY_PATH` is pointed at
the nix `gcc-15.3.0-lib` + system `libz.so.1` combination needed to import it at all —
the same class of nix-vs-system native-library fault as the already-closed **G16**
(`sim`'s own pytest suite hits an adjacent `libstdc++.so.6` version of this), not a new
finding. The four added bindings were therefore verified with a standalone Node script
reproducing `declared()`/`param()` exactly (shown above) rather than via `jest`; the
suite remains skipped in `gate:contracts` here exactly as it already was before this
change (confirmed: running `SimCrossCheck.spec.ts` alone reports "1 skipped" both before
and after this edit — the new rows type-check and are syntactically part of the array,
they just never execute in an environment that cannot produce the trace file, same as
the other 24 rows never have in this sandbox).

## params.json → contract: no orphaned sim output found

Spot-checked `mint`, `rebate`, `flush`, `trophy_auction`, `fees` for a field with no
contract wiring at all (**`patronage` removed from this list, readiness sweep #38,
2026-09-13** — D-106 deleted the key along with the patron line; the two paragraphs
below originally spot-checked it too, when it still existed). Every scalar with an
obvious contract analogue is wired. The non-scalar content under these keys
(`headroom_table`, `breakeven_surface`, `npv_ladder`, sweep/sensitivity tables) is sim
diagnostics that justify the scalar the contract does read, not a config value meant to
be wired anywhere — and an explicitly-labelled `"PROPOSED, NOT SIGNED"` figure
(`rebate.headroom_table_documented_proposal_0p06_over_5`) is correctly unwired and
self-disclosed as such. `fees.royalty_*` is on-chain per TEP-66 but not enforced —
already covered as an intentional disclosure by the repo's internal drift matrix (not
part of this published pack), not a new finding here.

## Touched

- `contracts/tests/SimCrossCheck.spec.ts` — four new `C12` bindings (the fix).
- `docs/audit/parameter-provenance.md` — this document (new).
