# Security and the bug bounty

**Testnet round: 22 November – 2 December 2026. Mainnet launches on 2 December 2026.**

## The prize

One prize of **1,000,000 PRIMES** for the first valid report of a bug that can **drain the
system** — move TON or PRIMES out of a contract along a path the spec (`CONCEPT.md`) does not
allow, or break an invariant it states (the floor `p_f = T / S` strictly rising on every mint,
`k < 1`, `S ≤ S_MAX`, no admin withdraw path on any TON balance; see
`docs/audit/invariant-coverage.md`). The figure is read live from the bounty vault's `SECU`
entry (`getProgram`) on <https://primes.live/verify#bounty>, and it is paid from the
mainnet vault's reserved `security_bounty` track after the fix is merged (`DECISIONS.md`
D-170). Every other valid finding earns public credit.

## How to report

**Privately, here:** *Security → Report a vulnerability*
(<https://github.com/KonnikPahoni/primes-contracts/security/advisories/new>). The advisory
is visible only to you and the maintainer, and its timestamp decides "first valid report".
Please include the contract, the message sequence, and ideally a failing
`@ton/sandbox` test (`contracts/tests/` has 1,000+ to copy from).

Do not post a working exploit in public channels before it is fixed.

## Scope

`docs/audit/scope.md` draws the boundary: every path TON can move through, and every figure
the app shows a player. Start at `docs/audit/index.md` (reading order),
`docs/audit/known-limitations.md` (what is already accepted — not eligible), and
`docs/audit/threat-model.md`.

## The live testnet set

Addresses: `docs/audit/deployment-story.md`, and served live at
<https://primes.live/api/contracts>. The set runs a one-hour auction clock and a 3 TON stake
floor (testnet-only divisors); mainnet deploys with both at 1.
