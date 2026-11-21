# /sim — TON PRIMES economic simulation

Python agent-based simulation of the token economy — the parameter authority
(CLAUDE.md rule 3). `primes_sim/` implements the discrete-event engine, the
adversarial agent zoo, chart rendering, and the writers for
`/shared/params.json`. Each params.json block carries its own `_source`; the
engineering measurements underneath them are in CLAUDE.md "Measured provenance".

## Environment

A plain **venv + requirements.txt**: the sim has three real dependencies
(numpy, pandas, matplotlib) plus pytest. Local is Python 3.14; CI
(`.github/workflows/ci.yml`) installs the same requirements on Python 3.12.

## Setup

```bash
python -m venv .venv
# Windows:
.venv\Scripts\activate
# POSIX:
source .venv/bin/activate
pip install -r requirements.txt
```

## Test

```bash
pytest -q                # inside sim/
```

## Regenerate `shared/params.json`

Two generators, each owning its own top-level keys (`run_phase1.py`'s
`FOREIGN_PARAM_KEYS` copies the others through untouched). Run them in this order:

1. `python scripts/run_determinations.py` — `determinations`, `acquisition`. Phase 1
   reads `determinations.d20_baseline`'s prime-lane model from it.
2. `python scripts/run_phase1.py` — every other block.

Deterministic (fixed seed `20260814`): re-running reproduces the same numeric
fields (only `_meta.generated_at` moves). `run_phase1.py` runs the baseline
three-year pass plus ~40 more (pessimistic uplifts, no floor guard, the staked
reserve sweep, low/high growth for the owed-dict ceiling), prints the kill
criteria and the ceiling crossings, and also writes
`docs/audit/genesis-emission-curve.md` and the charts in `/sim/output/`.

Run both from `sim/` with the requirements above installed; `run_phase1.py` rewrites
`shared/params.json` in place.
