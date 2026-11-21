"""Trace-export mode for the sim engine (docs/phase3-report.md §7 item 1,
the task brief's own "single most important test").

Produces a mint-by-mint event log (who minted what n, k(t) at that moment,
tribute paid, referral, factors, running T/S/pending) as JSON, suitable for
replay against the real Tolk contracts in @ton/sandbox
(contracts/tests/SimCrossCheck.spec.ts).

Two modes:

  --mode full          Run the engine exactly as Phase 1 configured it
                        (whale dumps, sandwich bots
                        all active) and export the resulting trace. This is
                        the "real" simulation output; it is NOT intended to be
                        chain-replayed 1:1 because several of the mechanisms
                        it exercises (DeDust
                        flush/AMM) have no live counterpart in the contracts
                        built so far (docs/phase3-report.md §1).

  --mode chain-replay   A deliberately narrowed configuration whose mint
                        stream corresponds *exactly* to what the currently
                        implemented contracts (primes_ledger.tolk et al., the
                        v5 decomposition) can execute: the
                        ledger is deployed fresh and seeded via GenesisSeed
                        exactly as contracts/tests/PrimesGenesisMint.spec.ts
                        already does, no whale dumps/sandwich
                        bots, and ZERO k_max uplifts
                        (the WS1 clamp structure exists on-chain but every
                        uplift term is 0 until WS2). Every mint in this trace
                        is a plain direct mint (prime or composite, with
                        §5.1's k = 0 on primes and §3.2's e·√p tribute split)
                        with an optional referral key, which is exactly what
                        the ledger's `mint` implements. This is the mode
                        SimCrossCheck.spec.ts consumes.

Usage (from /sim, with the venv active):
    python scripts/export_trace.py --mode chain-replay --mints 2000 \
        --out output/chain_replay_trace.json
"""
from __future__ import annotations

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from primes_sim.engine import Engine, SimParams  # noqa: E402
from primes_sim.arrivals import ArrivalParams  # noqa: E402
from primes_sim import economics as econ  # noqa: E402

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "output")


def build_chain_replay_engine(n_mints: int, seed: int, seed_t: float, seed_s: float) -> Engine:
    """Build an Engine whose genesis state matches a freshly-deployed
    primes_ledger.tolk right after its GenesisSeed bootstrap (see
    contracts/tests/PrimesGenesisMint.spec.ts's beforeEach): head=2, T=seed_t,
    S=seed_s, pending=0, no pre-owned genesis-auction primes. Disables every
    subsystem the on-chain contracts don't implement yet (whale dumps, sandwich bots, DeDust
    flush) so the resulting mint stream is something `mint` alone can
    fully reproduce.
    """
    p = SimParams(
        seed=seed,
        horizon_days=3650.0,          # generous; max_mints is the real stop condition
        n_max=max(n_mints * 3, 10_000),
        max_mints=n_mints,
        history_every_n_mints=max(n_mints // 20, 1),
        whale_dump_rate_per_day=0.0,
        sandwich_active=False,
        flush_cooldown_seconds=3650.0 * 86400.0 * 10,  # never triggers within horizon_days above
        arrival=ArrivalParams(base_rate_per_day=800.0, growth_per_day=0.0, hype_multiplier=1.0),
        # WS1 parity: the ledger's kMaxEffective sums its uplift terms but every
        # term resolves to 0 until WS2 wires the activation paths (prime rank,
        # PRIME_UPLIFT window, newcomer window, patron rank). Zero them here too
        # or the engine's per-wallet windows would produce k values `mint`
        # cannot reproduce. Re-enable term by term as WS2 lands each one.
        uplifts=econ.UpliftParams(
            prime_uplift=0.0,
            newcomer_uplift=0.0,
            recruit_rank_uplifts=(0.0,),
            prime_rank_uplifts=(0.0,),
            recruit_rank_tiers=(),
            prime_rank_tiers=(),
        ),
    )
    e = Engine(p)

    # ---- Calibration shim: replace the engine's genesis with the same
    # fresh-bank state the sandbox fixture seeds via GenesisSeed. This is a deliberate, documented departure from Engine's
    # normal genesis path (see the "chain-replay" mode docstring above), not
    # a change to the engine's core mechanics. ----
    e.T = seed_t
    e.S = seed_s
    e.pending = 0.0
    e.floor_price_genesis = seed_t / seed_s if seed_s > 0 else 0.0
    # First-mint k(t) calibration: primes_ledger.tolk special-cases
    # lastMintTime==0 to a saturated t=RAMP_SECONDS (kOfT == k_max) for the
    # very first mint after deploy (see handleMint's `val t = ...`
    # line). The engine's own default (last_mint_t=0, so t-last_mint_t is
    # whatever the first arrival's wall-clock time is, typically small) does
    # NOT reproduce that. Pre-seeding last_mint_t deeply negative reproduces
    # the same saturation for mint #1; every mint after that uses real
    # elapsed sim time on both sides, so this only affects mint #1.
    e.last_mint_t = -(p.ramp_seconds * 2.0)
    return e


def build_full_engine(n_mints: int | None, seed: int) -> Engine:
    """The Phase 1-shaped configuration (whale dumps, sandwich bots all active), optionally capped
    at `n_mints`. Not intended for chain replay -- see module docstring.
    """
    p = SimParams(
        seed=seed,
        horizon_days=3 * 365.0,
        n_max=2_000_000,
        max_mints=n_mints,
        history_every_n_mints=500,
        # Genesis constants, stated rather than defaulted. Left implicit, this
        # trace silently carried the pre-2026-08-15 genesis (auction-funded LP,
        # no founder seed) for two design generations -- DENOMINATION_PLAN P7.
        # These three MUST track run_phase1.py's BASELINE_KWARGS.
        genesis_lp_primes_per_ton=10_000.0,   # L, DENOMINATION_PLAN P1
        bounty_vault_pct_of_lp=0.20,
        genesis_seed_ton=200.0,               # SS6 point 3, owner 2026-08-15
    )
    return Engine(p)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["full", "chain-replay"], default="chain-replay")
    ap.add_argument("--mints", type=int, default=10_000)
    ap.add_argument("--seed", type=int, default=20260813)
    ap.add_argument("--seed-t", type=float, default=1000.0, help="chain-replay only: matches PrimesGenesisMint.spec.ts's GenesisSeed T (1000 TON)")
    # DENOMINATION_PLAN P1: the fixture seeds at the DEPLOY floor, 1/(L * 1.2)
    # TON per PRIMES. At L = 10,000 that is 12,000 PRIMES per TON, so 1000 TON
    # of seed is 12M PRIMES. Must move with PrimesGenesisMint.spec.ts's `seedS`.
    ap.add_argument("--seed-s", type=float, default=15_000_000.0, help="chain-replay only: matches PrimesGenesisMint.spec.ts's GenesisSeed S (15M PRIMES at L=10,000, D-41)")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    os.makedirs(OUT_DIR, exist_ok=True)
    out_path = args.out or os.path.join(OUT_DIR, f"{args.mode.replace('-', '_')}_trace.json")

    if args.mode == "chain-replay":
        e = build_chain_replay_engine(args.mints, args.seed, args.seed_t, args.seed_s)
        meta = {
            "mode": "chain-replay",
            "seed": args.seed,
            "requested_mints": args.mints,
            "seed_t_ton": args.seed_t,
            "seed_s_primes": args.seed_s,
            "note": (
                "No genesis auction, reservations, whale dumps, sandwich bots, "
                "or k_max uplifts -- disabled to match "
                "what the currently implemented v5 contracts (primes_ledger.tolk "
                "et al., WS1 economics: k=0 primes, e*sqrt(p) tribute, zero "
                "uplift terms) can actually execute. See CONCEPT.md SS5 and the K_CEIL clamp in primes_ledger.tolk."
            ),
        }
    else:
        e = build_full_engine(args.mints, args.seed)
        meta = {"mode": "full", "seed": args.seed, "requested_mints": args.mints}

    e.run()
    out = e.export_trace(out_path, extra_meta=meta)
    print(f"Wrote {out_path}: {out['summary']['total_mints']} mints, "
          f"final head={out['summary']['final_head']}, "
          f"final T={out['summary']['final_T']:.6f}, final S={out['summary']['final_S']:.6f}, "
          f"final pending={out['summary']['final_pending']:.6f}, "
          f"final floor_price={out['summary']['final_floor_price']:.9f}")


if __name__ == "__main__":
    main()
