"""Generate D-99's landmark-prime table (PRICING_MODEL_PLAN.md §3.2).

    python sim/scripts/landmark_primes.py

A landmark prime is one whose interest is its POSITION on the number line
rather than its shape: the prime that guards a power of ten, the ten-millionth
prime, the last prime before an era boundary. That is why it is a POSITION
category (bit 31, 30 points) and not a FORM one -- nothing about 999983's
digits makes it notable, only the fact that no larger prime has six digits.

Three families, about 45 entries, fixed at genesis:

  1. the largest prime BELOW and the smallest prime ABOVE 10^k, k = 1..14
     (14 is AUCTIONABLE_MAX's decade, so this is the whole reachable line)
  2. p_m for m in {10, 100, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8} -- the prime you get
     by counting, the other way a prime can be positionally famous
  3. the largest prime below each of the eight primorial era boundaries (SS7)

Outputs, all deterministic, no network, no RNG:

  contracts/contracts/score_block.tolk.inc   `isLandmarkPrime`, between the
                                             LANDMARK TABLE markers
  shared/score.ts                            LANDMARK_PRIMES, the TS mirror
  shared/landmark_primes.json                the table plus, per entry, HOW it
                                             was established -- the provenance
                                             CLAUDE.md rule 3 asks for

WHAT IS SIEVED AND WHAT IS NOT, stated rather than implied. Families 1 and 3
and every p_m up to m = 10^6 are established by an actual sieve or an actual
descending scan over a deterministic Miller-Rabin -- computed here, not looked
up. p_10^7 and p_10^8 are 179,424,673 and 2,038,074,743 (OEIS A006988); sieving
to two billion to re-derive two constants is not a good use of anyone's minute,
so this script VERIFIES their primality with the same Miller-Rabin the contract
runs and records `"verified": "primality"` against them instead of
`"verified": "sieve"`. If that distinction ever matters, raise --count-limit.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from primes_sim import trophy_auction as trophy  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SHARED = os.path.join(ROOT, "shared")
SCORE_BLOCK = os.path.join(ROOT, "contracts", "contracts", "score_block.tolk.inc")
SCORE_TS = os.path.join(SHARED, "score.ts")

# CONCEPT.md SS7. Eight, never six -- webapp/src/math/primorial.ts is canonical.
PRIMORIALS = [6, 30, 210, 2310, 30030, 510510, 9699690, 223092870]
DECADES = list(range(1, 15))  # 10^1 .. 10^14; AUCTIONABLE_MAX is 4.29e13
COUNT_TARGETS = [10, 100, 1_000, 10_000, 100_000, 1_000_000, 10_000_000, 100_000_000]

# OEIS A006988, a(7) and a(8). Not sieved here -- see the module docstring.
KNOWN_NTH_PRIME = {10_000_000: 179_424_673, 100_000_000: 2_038_074_743}


def prev_prime(n: int) -> int:
    """Largest prime strictly below n. Descending scan over the contract's own
    Miller-Rabin, which is exact far past anything reachable here."""
    c = n - 1
    if c % 2 == 0:
        c -= 1
    while c > 2 and not trophy.is_prime(c):
        c -= 2
    return c


def next_prime(n: int) -> int:
    c = n + 1
    if c % 2 == 0:
        c += 1
    while not trophy.is_prime(c):
        c += 2
    return c


def nth_primes_by_sieve(limit_m: int) -> dict[int, int]:
    """p_m for every m in COUNT_TARGETS up to limit_m, by counting an actual
    sieve. Establishing "the millionth prime" by counting is the only honest
    way to establish it; a table lookup would be an assertion, not a check."""
    wanted = sorted(m for m in COUNT_TARGETS if m <= limit_m)
    if not wanted:
        return {}
    # p_m < m(ln m + ln ln m) for m >= 6 (Rosser-Schoenfeld); +10% belt.
    import math

    top = wanted[-1]
    bound = int(top * (math.log(top) + math.log(math.log(top))) * 1.1)
    sieve = bytearray([1]) * (bound + 1)
    sieve[0:2] = b"\x00\x00"
    for i in range(2, int(bound**0.5) + 1):
        if sieve[i]:
            sieve[i * i :: i] = bytearray(len(sieve[i * i :: i]))
    out: dict[int, int] = {}
    seen = 0
    target_idx = 0
    for p in range(2, bound + 1):
        if not sieve[p]:
            continue
        seen += 1
        if seen == wanted[target_idx]:
            out[wanted[target_idx]] = p
            target_idx += 1
            if target_idx == len(wanted):
                break
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--count-limit",
        type=int,
        default=1_000_000,
        help="largest m for which p_m is established by SIEVE rather than by "
        "primality-verifying the published A006988 value (default 1e6)",
    )
    ap.add_argument("--check", action="store_true", help="fail instead of writing if the outputs would change")
    args = ap.parse_args()

    t0 = time.time()
    entries: list[dict] = []

    print("[1/4] decade guards: largest prime below and smallest above 10^k ...", flush=True)
    for k in DECADES:
        d = 10**k
        entries.append({"n": prev_prime(d), "family": "decade_below", "of": d, "verified": "scan"})
        entries.append({"n": next_prime(d), "family": "decade_above", "of": d, "verified": "scan"})

    print("[2/4] era guards: largest prime below each primorial boundary ...", flush=True)
    for pr in PRIMORIALS:
        entries.append({"n": prev_prime(pr), "family": "era_below", "of": pr, "verified": "scan"})

    print(f"[3/4] counting primes to establish p_m up to m = {args.count_limit:,} ...", flush=True)
    sieved = nth_primes_by_sieve(args.count_limit)
    for m in COUNT_TARGETS:
        if m in sieved:
            entries.append({"n": sieved[m], "family": "nth_prime", "of": m, "verified": "sieve"})
        else:
            p = KNOWN_NTH_PRIME[m]
            assert trophy.is_prime(p), f"A006988 value for m={m} failed Miller-Rabin"
            entries.append({"n": p, "family": "nth_prime", "of": m, "verified": "primality"})

    # Deduplicate: 29 is both p_10 and the prime below the primorial 30, and
    # the table is a SET -- a number is a landmark once, whatever it is a
    # landmark for. The reasons survive in the JSON so the webapp can say why.
    by_n: dict[int, list[dict]] = {}
    for e in entries:
        by_n.setdefault(e["n"], []).append(e)
    table = sorted(by_n)
    every = all(trophy.is_prime(n) for n in table)
    assert every, "a landmark entry is not prime -- the generator is wrong, not the contract"

    print(f"[4/4] {len(table)} distinct landmark primes; writing ...", flush=True)

    tolk = ["fun isLandmarkPrime(n: int): bool {", "    return "]
    lines = []
    for i in range(0, len(table), 3):
        lines.append(" || ".join(f"n == {n}" for n in table[i : i + 3]))
    tolk = "fun isLandmarkPrime(n: int): bool {\n    return " + "\n        || ".join(lines) + ";\n}\n"

    ts = (
        "export const LANDMARK_PRIMES: ReadonlySet<bigint> = new Set<bigint>([\n"
        + "".join(
            "  " + ", ".join(f"{n}n" for n in table[i : i + 6]) + ",\n" for i in range(0, len(table), 6)
        )
        + "]);\n"
    )

    doc = {
        "_source": "sim/scripts/landmark_primes.py",
        "_decision": "D-99",
        "_spec": "PRICING_MODEL_PLAN.md §3.2",
        "_note": (
            "POSITION bit 31, 30 points. `verified` says how each entry was "
            "established: `scan` = descending/ascending deterministic "
            "Miller-Rabin from the landmark, `sieve` = counted off an actual "
            "sieve, `primality` = OEIS A006988's published value confirmed "
            "prime but not re-counted (see the script's docstring)."
        ),
        "count": len(table),
        "entries": [
            {"n": n, "reasons": [{k: v for k, v in e.items() if k != "n"} for e in by_n[n]]} for n in table
        ],
    }

    def write(path: str, text: str) -> bool:
        old = open(path, encoding="utf-8").read() if os.path.exists(path) else None
        if old == text:
            return False
        if args.check:
            print(f"WOULD CHANGE: {path}")
            return True
        with open(path, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
        print(f"  wrote {path}")
        return True

    changed = False
    src = open(SCORE_BLOCK, encoding="utf-8").read()
    b, e = "// LANDMARK TABLE BEGIN\n", "// LANDMARK TABLE END"
    i, j = src.index(b) + len(b), src.index(e)
    changed |= write(SCORE_BLOCK, src[:i] + tolk + src[j:])

    src = open(SCORE_TS, encoding="utf-8").read()
    i, j = src.index(b) + len(b), src.index(e)
    changed |= write(SCORE_TS, src[:i] + ts + src[j:])

    changed |= write(os.path.join(SHARED, "landmark_primes.json"), json.dumps(doc, indent=2) + "\n")

    print(f"done in {time.time() - t0:.1f}s")
    if args.check and changed:
        sys.exit(1)


if __name__ == "__main__":
    main()
