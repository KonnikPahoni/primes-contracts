"""Parrondo search -- can two losing games be combined into a winning one?

The auditor's question that CONCEPT.md SS5's theorem does not answer. SS5 proves
`k < 1` per mint; Parrondo's paradox is about what a *sequence* of individually
losing plays can do when one play changes the state the next is played in. TON
PRIMES has that structure whether or not it was designed in:

    game A  = mint a composite -- pays back `k * beta < 1` (SS5)
    game B  = mint a prime     -- pays back nothing, `k = 0` (SS5.1)
    coupling = B raises prime rank and opens PRIME_WINDOW, both of which uplift
               `k_max` on subsequent plays of A (SS4.7.1, SS5)

So the question "is there a schedule of minting that extracts more GRAM from the
ratchet than it puts in?" is not answered by the clamp alone, and this script
answers it by solving the chain rather than by argument. See
`primes_sim/parrondo.py` for the model, and in particular for the six places it
is deliberately generous to the attacker.

**This script writes no constants.** It measures a property of the constants
already in `shared/params.json`; if it ever needs to *choose* a number, something
has been designed by accident. Output goes to `sim/output/parrondo.json`.

The kill criterion is a single bit: `exploit_found`. Any policy that returns more
GRAM than it spends -- at any n, any beta row, any rank grant -- falsifies SS5's
central claim and this script exits non-zero.

Usage (from /sim):
    python scripts/run_parrondo.py [horizon]
"""
from __future__ import annotations

import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from primes_sim import parrondo as pa

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "output")
OUT_PATH = os.path.join(OUT_DIR, "parrondo.json")

DEFAULT_HORIZON = 400


def main(horizon: int = DEFAULT_HORIZON) -> bool:
    t0 = time.time()
    params = pa.load_params()

    print("=" * 78)
    print("Parrondo search  (CONCEPT.md SS5 / SS5.1 / SS4.7.1)")
    print("=" * 78)
    print(
        "Measuring EMISSION-ONLY return: rebate value at the floor, per GRAM spent.\n"
        "Tribute, dividends, referral income and the NFT are excluded on purpose --\n"
        "this is the ratchet's exposure, not whether the game is worth playing.\n"
    )

    report = pa.scan(horizon=horizon, params=params)

    print(f"scenarios solved: {report['scenario_count']} "
          f"(n-decade x beta row x recruit-rank grant), horizon = {horizon} opportunities\n")

    print("-- the closed-form bound (infinite free grinding, every uplift at once) --")
    bound = report["scenarios"][0]["bound"]
    for n in pa.N_DECADES:
        m = pa.model_from_params(params, n=n, beta_composite=0.65)
        b = pa.asymptotic_bound(m)
        print(f"  n = {n:>9,}   k_max fully stacked = {b['k_max_fully_stacked']:.4f}"
              f"{'  (clamped at K_CEIL)' if b['clamped_at_K_CEIL'] else ''}"
              f"   return/GRAM at beta ceiling = {b['return_per_ton_at_beta_ceiling']:.4f}")
    print(f"  K_CEIL = {params['rebate']['K_CEIL']}, beta ceiling = {bound['beta_ceiling_in_split']}\n")

    print("-- the finite-horizon search (grinding cost paid, not amortised away) --")
    w = report["worst_case"]
    print(f"  closest any policy gets to break-even: {w['mixed_return_per_ton']:.6f} GRAM per GRAM")
    print(f"    at n = {w['n']:,}, beta row = {w['beta_row']}, recruit rank granted = {w['recruit_rank_granted']}")
    print(f"    margin to break-even: {w['margin_to_break_even']:.6f} GRAM per GRAM\n")

    ss = max((s for s in report["scenarios"] if s["beta_row"] == "self_sender_referred"),
             key=lambda s: s["mixed_return_per_ton"])
    print("-- the self-sender (self-referral + 3 invites to itself, cash recovered "
          f"{pa.BETA_ROWS[0][2]:.2f} at beta {pa.BETA_ROWS[0][1]:.2f}) --")
    print(f"  best return: {ss['mixed_return_per_ton']:.6f} GRAM per GRAM "
          f"at n = {ss['n']:,}, recruit rank granted = {ss['recruit_rank_granted']}\n")

    print("-- the Parrondo signature (mixing beats BOTH pure games) --")
    s = report["widest_signature"]
    print(f"  present in {report['parrondo_signature_count']} of {report['scenario_count']} scenarios")
    print(f"  widest gain: +{s['signature_gain']:.6f} GRAM per GRAM "
          f"({s['best_pure_return_per_ton']:.4f} pure -> {s['mixed_return_per_ton']:.4f} mixed)")
    print(f"    at n = {s['n']:,}, beta row = {s['beta_row']}, recruit rank granted = {s['recruit_rank_granted']}")
    print(
        "  This is EXPECTED and is not a failure: SS4.7.1 sells rank as a reward, so a\n"
        "  player who mints a few primes to hold rank and then mints composites is playing\n"
        "  the game as designed. It is reported because it is the early-warning signal --\n"
        "  the gap between the mixed strategy and 1.0 is the margin the K_CEIL clamp is\n"
        "  actually carrying, and widening the uplift table spends that margin directly.\n"
    )

    os.makedirs(OUT_DIR, exist_ok=True)
    out = dict(report)
    out["_meta"] = {
        "source": "sim/scripts/run_parrondo.py",
        "consumes": "shared/params.json (rebate.*, mint.mint_price_ton); the self-sender "
                    "row's beta and cash from primes_sim.economics' split",
        "writes_constants": False,
        "concept_sections": ["5", "5.1", "4.7.1", "8"],
    }
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2)

    passed = not report["exploit_found"]
    print(f"Wrote {os.path.abspath(OUT_PATH)}")
    print(f"Kill criterion no_profitable_parrondo_strategy: {'PASS' if passed else 'FAIL'}")
    if not passed:
        print("\nEXPLOIT SCENARIOS:")
        print(json.dumps(report["exploit_scenarios"], indent=2))
    print(f"Wall time: {time.time() - t0:.1f}s")
    return passed


if __name__ == "__main__":
    h = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_HORIZON
    sys.exit(0 if main(h) else 1)
