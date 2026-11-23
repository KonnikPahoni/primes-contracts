# TON PRIMES — audit pack

Twenty-two documents, in reading order. Everything here is published deliberately:
`webapp/vite.config.ts`'s `publishDocs()` names each file, and nothing reaches
`primes.live/docs/audit/` that is not on that list. The repo holds further working notes
that are *not* part of this pack — regenerated churn reports, internal design drafts and
dated run logs — and they are not published, not because they are secret but because
nothing in them is an auditor's business.

**Status: pre-launch.** Testnet only. No mainnet deployment, no real money, no third-party
integration. `CONCEPT.md` is the specification the contracts are written against; where a
document here and `CONCEPT.md` disagree, `CONCEPT.md` wins and the disagreement is a bug.

Several of these are **regenerated from HEAD by a script**, not written by hand — those say
so in their own first lines, and the script is named there. A regenerated document cannot
drift from the code without the generator being wrong, which is the point of generating it.

## Start here

| document | what it answers |
|---|---|
| [scope.md](scope.md) | What is in the audited boundary and what is deliberately outside it. Read first; every other document assumes this boundary. |
| [threat-model.md](threat-model.md) | Every actor — attacker, operator, keeper, bug — what each can do, and what stops it. |
| [known-limitations.md](known-limitations.md) | What is not done, not proven, or accepted as a risk on purpose. The document most likely to change. |

## What is proven, and by what

| document | what it answers |
|---|---|
| [invariant-coverage.md](invariant-coverage.md) | Which must-never-break invariants have a named test proving them — and which do not. |
| [test-coverage-map.md](test-coverage-map.md) | The full test inventory behind the line above. Regenerated. |
| [contract-surface.md](contract-surface.md) | Every contract's get-methods and message opcodes. Regenerated from HEAD. |
| [wire-format.md](wire-format.md) | The message layouts those opcodes carry. Regenerated from HEAD. |

## The economics

| document | what it answers |
|---|---|
| [parameter-provenance.md](parameter-provenance.md) | Where each economic constant comes from. A number traceable to neither the simulation nor `CONCEPT.md` is a bug. |
| [genesis-emission-curve.md](genesis-emission-curve.md) | The genesis emission schedule and the simulation run that produced it. |
| [stat-provenance.md](stat-provenance.md) | Every figure the app displays, mapped to the get-method it is read from (`CONCEPT.md` §9.1). |
| [money-arithmetic.md](money-arithmetic.md) | Rounding, truncation and dust across every place the contracts divide GRAM. |

## Where money can move

| document | what it answers |
|---|---|
| [withdraw-surface.md](withdraw-surface.md) | Every outbound-message site in every contract, classified by destination. GRAM leaves a contract only through these, so "no admin withdraw path" is a property of this set. |
| [sender-gates.md](sender-gates.md) | Who each privileged handler will accept a message from. |
| [bounce-coverage.md](bounce-coverage.md) | What happens to the money when a message bounces or a standard protocol reply comes home. |
| [privileged-credentials.md](privileged-credentials.md) | The three standing credentials that do exist, each one's powers, limits and bounding test. None can move a GRAM balance. |
| [key-loss.md](key-loss.md) | The failure half of the page above: what stops working the day each credential is lost, and which cannot be replaced without a genesis redeploy. |

## Building and running it

| document | what it answers |
|---|---|
| [reproducible-build.md](reproducible-build.md) | The pinned toolchain, the build procedure, and the code hash each contract compiles to. |
| [build-and-test.md](build-and-test.md) | How to build the repo and run every suite, from a cold clone. |
| [deployment-story.md](deployment-story.md) | What genesis actually does, in order, and which key can do what at each step. |
| [index-rebuild.md](index-rebuild.md) | The recovery path for the day the backups are gone — measured, from an empty database. |
| [repo-hygiene.md](repo-hygiene.md) | Secrets posture, tracked build artifacts, dependency audit. |
| [nft-metadata-conformance.md](nft-metadata-conformance.md) | TEP-64 conformance of the metadata served for every minted number. |

## Elsewhere

- [`/verify`](https://primes.live/verify) — the four headline claims, each beside what checks it. Every figure on it is parsed from the documents above rather than re-typed.
- [`CONCEPT.md`](https://primes.live/docs/CONCEPT.md) — the specification.
- [`math-note.md`](https://primes.live/docs/math-note.md) — the ratchet proof.
- [`read-proxy.yaml`](https://primes.live/docs/api/read-proxy.yaml), [`read-index.yaml`](https://primes.live/docs/api/read-index.yaml) — OpenAPI for the two read APIs.
