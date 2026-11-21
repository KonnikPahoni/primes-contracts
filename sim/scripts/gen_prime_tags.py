"""Generate shared/prime_tags.json -- the tag and starting-price table.

    python sim/scripts/gen_prime_tags.py --table-max 1000000

Outputs, all deterministic given (table_max, npv_horizon, params):

  shared/prime_tags.json        registry + summary + the notable rows
  shared/prime_tags.csv         the full table, one row per prime
  shared/prime_tags_summary.md  what a human should read first

The table is the artefact the auction and reservation contracts commit to as a
Merkle root (see docs/prime-taxonomy.md). It has to be reproducible bit for bit
from this script and nothing else -- no network, no wall clock, no RNG.
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from primes_sim import pricing, taxonomy, tribute  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SHARED = os.path.join(ROOT, "shared")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--table-max", type=int, default=1_000_000,
                    help="highest prime that gets a row")
    ap.add_argument("--npv-horizon", type=int, default=None,
                    help="how far the tribute sweep runs; default 2x table-max "
                         "so every tabled prime has a full doubling of future line")
    ap.add_argument("--discount-rate", type=float, default=0.35)
    ap.add_argument("--mints-per-year", type=float, default=134_648.0,
                    help="from the Phase 1 baseline: 403945 mints / 3 years")
    ap.add_argument("--out-prefix", default="prime_tags")
    args = ap.parse_args()

    npv_horizon = args.npv_horizon or 2 * args.table_max

    t0 = time.time()
    print(f"[1/4] tagging primes <= {args.table_max:,} ...", flush=True)
    tagged = taxonomy.tag_primes(args.table_max)
    primes = tagged["primes"]
    masks = tagged["mask"]
    print(f"      {len(primes):,} primes, {len(taxonomy.TAGS)} tags, "
          f"{time.time() - t0:.1f}s", flush=True)

    print("[2/4] measuring tag rarity ...", flush=True)
    counts = taxonomy.tag_counts(tagged)
    bits = taxonomy.surprisal_bits(tagged)          # per decade band
    ntab = len(primes)
    global_bits = {
        k: (24.0 if c == 0 else min(24.0, -math.log2(c / ntab)))
        for k, c in counts.items()
    }

    print(f"[3/4] tribute NPV sweep to {npv_horizon:,} ...", flush=True)
    t1 = time.time()
    npv = tribute.prime_tribute_npv(
        npv_horizon,
        discount_rate_annual=args.discount_rate,
        mints_per_year=args.mints_per_year,
    )["npv"]
    print(f"      {time.time() - t1:.1f}s", flush=True)

    print("[4/4] pricing ...", flush=True)
    pp = pricing.PriceParams()
    rows = []
    for i, p in enumerate(primes):
        p = int(p)
        m = masks[i]
        rb = taxonomy.score_bits(p, m, bits, cap=pp.rarity_cap_bits)
        vk = pricing.vanity_keys(p)
        vm = pricing.vanity_multiplier(p)
        anchor = npv.get(p, 0.0)
        price = pricing.reserve_ton(anchor, rb, vm, pp)
        rows.append({
            "p": p,
            "tags": taxonomy.tags_of(m),
            "vanity": vk,
            "rarity_bits": round(rb, 4),
            "vanity_multiplier": round(vm, 4),
            "npv_ton": round(anchor, 6),
            "reserve_ton": round(price, 6),
            "mask": m,
        })

    os.makedirs(SHARED, exist_ok=True)

    # ---- full table as CSV (the thing the Merkle tree is built over)
    csv_path = os.path.join(SHARED, f"{args.out_prefix}.csv")
    with open(csv_path, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["p", "mask", "rarity_bits", "vanity_multiplier",
                    "npv_ton", "reserve_ton", "tags", "vanity"])
        for r in rows:
            w.writerow([r["p"], r["mask"], r["rarity_bits"], r["vanity_multiplier"],
                        r["npv_ton"], r["reserve_ton"],
                        "|".join(r["tags"]), "|".join(r["vanity"])])

    # ---- registry + summary as JSON
    by_price = sorted(rows, key=lambda r: -r["reserve_ton"])
    by_rarity = sorted(rows, key=lambda r: (-r["rarity_bits"], r["p"]))
    total_reserve = sum(r["reserve_ton"] for r in rows)

    doc = {
        "schema_version": "1.0.0",
        "generator": "sim/scripts/gen_prime_tags.py",
        "inputs": {
            "table_max": args.table_max,
            "npv_horizon": npv_horizon,
            "discount_rate_annual": args.discount_rate,
            "mints_per_year": args.mints_per_year,
            "anchor_margin": pp.anchor_margin,
            "kappa_per_bit": pp.kappa_per_bit,
            "rarity_cap_bits": pp.rarity_cap_bits,
            "vanity_cap": pricing.VANITY_CAP,
            "surprisal_cap_bits": 20.0,
            "cross_family_discount": 0.25,
        },
        "counts": {
            "primes_tabled": len(rows),
            "tags": len(taxonomy.TAGS),
            "families": list(taxonomy.FAMILIES),
        },
        "tag_registry": [
            {
                "bit": i,
                "key": t.key,
                "family": t.family,
                "label": t.label,
                "definition": t.definition,
                "oeis": t.oeis,
                "curated": t.curated,
                "members_below_table_max": counts[t.key],
                "density": counts[t.key] / len(rows) if rows else 0.0,
                "surprisal_bits_global": round(global_bits[t.key], 4),
            }
            for i, t in enumerate(taxonomy.TAGS)
        ],
        "surprisal_by_band": {
            str(b): {k: round(v, 4) for k, v in row.items()}
            for b, row in sorted(bits.items())
        },
        "vanity_registry": [
            {"key": r.key, "label": r.label, "multiplier": r.multiplier, "note": r.note}
            for r in pricing.VANITY_RULES
        ],
        "aggregates": {
            "total_reserve_ton": round(total_reserve, 2),
            "percentiles_ton": {
                f"p{q}": round(sorted(r["reserve_ton"] for r in rows)[min(len(rows) - 1, q * len(rows) // 100)], 4)
                for q in (1, 10, 25, 50, 75, 90, 99)
            },
            "below_2_ton": sum(1 for r in rows if r["reserve_ton"] < 2),
            "above_5_ton": sum(1 for r in rows if r["reserve_ton"] > 5),
            "above_10_ton": sum(1 for r in rows if r["reserve_ton"] > 10),
            "above_100_ton": sum(1 for r in rows if r["reserve_ton"] > 100),
            "by_band": {
                str(b): {
                    "primes": sum(1 for r in rows if len(str(r["p"])) == b),
                    "total_reserve_ton": round(sum(r["reserve_ton"] for r in rows if len(str(r["p"])) == b), 2),
                    "max_reserve_ton": round(max((r["reserve_ton"] for r in rows if len(str(r["p"])) == b), default=0.0), 2),
                }
                for b in sorted({len(str(r["p"])) for r in rows})
            },
        },
        "top_100_by_reserve": [
            {k: r[k] for k in ("p", "reserve_ton", "npv_ton", "rarity_bits", "vanity_multiplier", "tags", "vanity")}
            for r in by_price[:100]
        ],
        "top_50_by_rarity": [
            {k: r[k] for k in ("p", "rarity_bits", "reserve_ton", "tags")}
            for r in by_rarity[:50]
        ],
    }

    json_path = os.path.join(SHARED, f"{args.out_prefix}.json")
    with open(json_path, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, indent=2)

    # ---- human summary
    md = [f"# Prime tag & reserve table\n",
          f"Generated by `sim/scripts/gen_prime_tags.py` "
          f"(table_max={args.table_max:,}, npv_horizon={npv_horizon:,}, "
          f"discount={args.discount_rate:.0%}/yr).\n",
          f"{len(rows):,} primes tabled across {len(taxonomy.TAGS)} tags "
          f"in {len(taxonomy.FAMILIES)} families.\n",
          "\n## Tag rarity (measured, not asserted)\n",
          "| family | tag | members | density | bits |",
          "|---|---|---:|---:|---:|"]
    for t in taxonomy.TAGS:
        c = counts[t.key]
        md.append(f"| {t.family} | `{t.key}`{' *' if t.curated else ''} | {c:,} | "
                  f"{c / len(rows):.3e} | {global_bits[t.key]:.1f} |")
    md.append("\n`*` = curated: the complete set known to mathematics, not a sweep.\n")

    md.append("\n## Top 40 by reserve price\n")
    md.append("| p | reserve (TON) | NPV | bits | vanity | tags |")
    md.append("|---:|---:|---:|---:|---:|---|")
    for r in by_price[:40]:
        md.append(f"| {r['p']} | {r['reserve_ton']:,.2f} | {r['npv_ton']:,.2f} | "
                  f"{r['rarity_bits']:.1f} | {r['vanity_multiplier']:.2f}x | "
                  f"{', '.join(r['tags'][:6])} |")

    md.append("\n## Rarest 25 primes in the table\n")
    md.append("| p | bits | reserve (TON) | tags |")
    md.append("|---:|---:|---:|---|")
    for r in by_rarity[:25]:
        md.append(f"| {r['p']} | {r['rarity_bits']:.1f} | {r['reserve_ton']:,.2f} | "
                  f"{', '.join(r['tags'][:8])} |")

    md.append(f"\n## Distribution\n")
    md.append(f"- total reserve value of the whole table: **{total_reserve:,.0f} TON**")
    md.append(f"- reserve percentiles (TON): " + ", ".join(
        f"{k}={v:,.2f}" for k, v in doc['aggregates']['percentiles_ton'].items()))
    md.append(f"- below 2 TON: {doc['aggregates']['below_2_ton']:,} primes "
              f"({doc['aggregates']['below_2_ton'] / len(rows):.1%})")
    md.append(f"- above 10 TON: {doc['aggregates']['above_10_ton']:,}")
    md.append(f"- above 100 TON: {doc['aggregates']['above_100_ton']:,}")

    md_path = os.path.join(SHARED, f"{args.out_prefix}_summary.md")
    with open(md_path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(md) + "\n")

    print(f"\nwrote {csv_path}")
    print(f"wrote {json_path}")
    print(f"wrote {md_path}")
    print(f"total {time.time() - t0:.1f}s")


if __name__ == "__main__":
    main()
