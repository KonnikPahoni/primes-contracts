"""Resolution of `owed_dict_ceiling_flag` (UPGRADE_PLAN_V5.md SS3 item 8,
CONCEPT.md SS3.2.1's "verify against config params 20/21 and 43").

Phase 0 (CLAUDE.md "Measured provenance", Spike 4) measured, in `@ton/sandbox` rather
than by estimate:

  * config 43 `max_acc_state_cells = 65,536` for a non-masterchain account;
  * the `owed` dictionary (`uint32 -> uint128`) at **2.00 cells/entry**, so a
    single-account `owed` map cannot pass ~32,768 entries -> pi(x) = 32,768 ->
    **n = 386,093**;
  * config 18 rent on basechain: ~10.20 TON/year at pi(1e6) entries.

v5 makes this **worse**, not better: SS3.2's flat prime dividend adds an
`entry[p]` stamp per prime. Carried in the same dictionary value the entry
becomes `uint32 -> (uint128 owed, uint128 entry)` = 256 value bits, which still
fits one cell, so the measured 2.00 cells/entry is the right planning figure and
2.5 is the conservative one. Both are reported below.

Config 20/21 (gas prices/limits) are **not** the binding constraint and this
module says so with a number rather than by omission: the ledger's per-mint work
is omega(n) <= 8 dictionary writes plus one `div_acc` addition, and Phase 0
measured Miller-Rabin -- far heavier -- at 0.026 TON even at the 3.3e24
exactness bound. Sharding changes the per-mint cost by one message hop per
shard touched, which is the number Phase B must benchmark against the 10% gas
line; it does not change the O(log n) dictionary cost materially, since a shard's
dictionary is *shallower* than the monolithic one.
"""
from __future__ import annotations

import math

import numpy as np

MAX_ACC_STATE_CELLS = 65_536       # config param 43, basechain (Phase 0, live read)
CELLS_PER_OWED_ENTRY = 2.00        # measured, Phase 0 Spike 4
CELLS_PER_OWED_ENTRY_V5 = 2.50     # conservative: owed + div_acc entry stamp
CODE_CELL_ALLOWANCE = 4_000        # leave room for contract code + other state


def entries_per_shard(cells_per_entry: float = CELLS_PER_OWED_ENTRY_V5,
                      utilisation: float = 0.80) -> int:
    usable = (MAX_ACC_STATE_CELLS - CODE_CELL_ALLOWANCE) * utilisation
    return int(usable // cells_per_entry)


def prime_count(n: int) -> int:
    """pi(n) by sieve -- exact, not the log approximation."""
    if n < 2:
        return 0
    sieve = np.ones(n + 1, dtype=bool)
    sieve[:2] = False
    for i in range(2, int(n ** 0.5) + 1):
        if sieve[i]:
            sieve[i * i:: i] = False
    return int(sieve.sum())


def n_for_prime_count(target: int, hi: int = 20_000_000) -> int:
    """Smallest n with pi(n) >= target."""
    sieve = np.ones(hi + 1, dtype=bool)
    sieve[:2] = False
    for i in range(2, int(hi ** 0.5) + 1):
        if sieve[i]:
            sieve[i * i:: i] = False
    cum = np.cumsum(sieve)
    idx = int(np.searchsorted(cum, target))
    if idx > hi:
        # searchsorted returns len(cum) = hi+1 when pi(hi) < target: a capacity the
        # sieve never reached, which used to come back as if it were an answer.
        raise ValueError(f"pi({hi}) = {int(cum[-1])} < {target}; raise `hi`")
    return idx


def sharding_plan(target_n: int, cells_per_entry: float = CELLS_PER_OWED_ENTRY_V5,
                  utilisation: float = 0.80) -> dict:
    per_shard = entries_per_shard(cells_per_entry, utilisation)
    pi_target = prime_count(target_n)
    shards = max(1, math.ceil(pi_target / per_shard))
    # round up to a power of two so routing is a bit-mask on the prime, not a
    # division: shard_id = (p >> k) & (S-1) style range routing
    shards_pow2 = 1 << math.ceil(math.log2(shards)) if shards > 1 else 1
    return {
        "target_n": target_n,
        "pi_target": pi_target,
        "cells_per_entry": cells_per_entry,
        "entries_per_shard": per_shard,
        "shards_required": shards,
        "shards_rounded_pow2": shards_pow2,
        "headroom_n_with_pow2_shards": None,  # filled by caller if wanted
    }


def report(targets=(386_093, 1_000_000, 2_000_000, 10_000_000)) -> dict:
    rows = []
    for ce in (CELLS_PER_OWED_ENTRY, CELLS_PER_OWED_ENTRY_V5):
        per_shard = entries_per_shard(ce)
        single_account_n = n_for_prime_count(per_shard)
        rows.append({
            "cells_per_entry": ce,
            "entries_per_account": per_shard,
            "single_account_ceiling_n": single_account_n,
            "plans": [sharding_plan(t, ce) for t in targets],
        })
    # what 16 shards buys
    per16 = entries_per_shard(CELLS_PER_OWED_ENTRY_V5) * 16
    return {
        "config_43_max_acc_state_cells": MAX_ACC_STATE_CELLS,
        "code_cell_allowance": CODE_CELL_ALLOWANCE,
        "utilisation_assumed": 0.80,
        "variants": rows,
        "recommended": {
            "decision": "shard the ledger's `owed`+`entry` map by prime range across a "
                        "fixed, power-of-two set of sibling ledger shards",
            "shards": 16,
            "routing": "static range routing on p (shard = p * S // N_MAX_PLANNED), so a "
                       "shard address is derivable off-chain and the splitter addresses it "
                       "directly -- one hop, no lookup table, no admin registry",
            "capacity_entries": per16,
            "capacity_n": n_for_prime_count(per16),
            "why_not_defer": "v5 adds the div_acc `entry[p]` stamp to the same map, so the "
                             "ceiling moves the wrong way; the flag cannot be carried forward "
                             "unchanged.",
            "alternative_rejected": "moving the owed balance into each prime's NFT item "
                                    "removes the central map entirely but reintroduces the "
                                    "dust/forward-fee problem SS3.2.1 rejected push tribute "
                                    "for, on the claim path instead of the mint path.",
            "config_20_21_note": "Gas limits are not binding: the per-mint ledger work is "
                                 "omega(n) <= 8 dict writes plus one addition, against a "
                                 "Miller-Rabin cost Phase 0 measured at 0.026 TON. Sharding "
                                 "adds one message hop per shard touched (<= omega(n)); that "
                                 "hop count is the Phase B gas-benchmark input, and it is the "
                                 "only part of this decision Phase A cannot close.",
        },
    }
