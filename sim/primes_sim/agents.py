"""The adversarial-by-default agent zoo (IMPLEMENTATION_PLAN.md Phase 1 /
CONCEPT.md SS8, SS10).

Each organic mint is attributed to one agent *archetype*, drawn from a
weighted mix that is adversarial by default (dumpers, campers, bots, whales
outweigh naive/organic minters). Reservation squatting, whale dumps and
flush-sandwiching are separate, asynchronous processes layered on top of the
mint stream, matching how those behaviors actually operate in the protocol
(they are not mint-arrival events themselves).

Every minting agent is, from its second mint on, a **universal
self-referrer** (CONCEPT.md SS8: "beta = 0.65 is the planning number, not
0.75") if it owns any NFT yet -- implemented once in `choose_referral` and
reused by every archetype rather than duplicated per class.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum, auto

import numpy as np


class Archetype(Enum):
    INSTANT_DUMP_REBATER = auto()
    PATIENT_CAMPER = auto()
    BOT_LOOP = auto()
    GIFT_ORGANIC = auto()
    PASSIVE_SELF_REFERRER = auto()


# Adversarial-by-default mix: dumpers + camper + bot loop outweigh organic/gift.
DEFAULT_MIX = {
    Archetype.INSTANT_DUMP_REBATER: 0.32,
    Archetype.PATIENT_CAMPER: 0.15,
    Archetype.BOT_LOOP: 0.18,
    Archetype.GIFT_ORGANIC: 0.15,
    Archetype.PASSIVE_SELF_REFERRER: 0.20,
}


@dataclass
class AgentPool:
    """Weighted archetype draw + per-wallet-id NFT-ownership bookkeeping used
    only to decide whether a wallet can self-refer (owns >=1 NFT already).
    """

    rng: np.random.Generator
    mix: dict = field(default_factory=lambda: dict(DEFAULT_MIX))
    n_wallets_per_archetype: int = 400

    def __post_init__(self):
        self._types = list(self.mix.keys())
        self._weights = np.array([self.mix[t] for t in self._types], dtype=float)
        self._weights /= self._weights.sum()
        self._cumweights = np.cumsum(self._weights)
        # Each archetype gets a pool of wallet ids so "self-referral" and
        # repeat-ownership dynamics are meaningful instead of every mint
        # being a brand-new wallet.
        self._wallet_owned_numbers: dict[int, list[int]] = {}
        self._next_wallet_id = 0
        self._archetype_wallets: dict[Archetype, list[int]] = {t: [] for t in self._types}

    def _get_wallet(self, archetype: Archetype) -> int:
        pool = self._archetype_wallets[archetype]
        if len(pool) < self.n_wallets_per_archetype and (
            len(pool) == 0 or self.rng.random() < 0.15
        ):
            wid = self._next_wallet_id
            self._next_wallet_id += 1
            pool.append(wid)
            self._wallet_owned_numbers[wid] = []
            return wid
        return pool[int(self.rng.integers(0, len(pool)))]

    def draw_archetype(self) -> Archetype:
        idx = int(np.searchsorted(self._cumweights, self.rng.random()))
        idx = min(idx, len(self._types) - 1)
        return self._types[idx]

    def record_ownership(self, wallet_id: int, n: int) -> None:
        self._wallet_owned_numbers.setdefault(wallet_id, []).append(n)

    def choose_referral(self, wallet_id: int) -> int | None:
        """Universal self-referral: use the wallet's lowest-numbered owned
        NFT (the "vanity"/blue-chip key it is most likely to have kept) if it
        owns anything; otherwise no key (first mint, or fully sold out).
        """
        owned = self._wallet_owned_numbers.get(wallet_id, [])
        if not owned:
            return None
        return min(owned)

    def next_minter(self) -> tuple[Archetype, int]:
        archetype = self.draw_archetype()
        wallet_id = self._get_wallet(archetype)
        return archetype, wallet_id


def bot_loop_burst_length(rng: np.random.Generator, p_continue: float = 0.55, cap: int = 6) -> int:
    """Geometric-ish loop length for a BOT_LOOP archetype's rapid-fire burst."""
    n = 1
    while n < cap and rng.random() < p_continue:
        n += 1
    return n


def sells_rebate_immediately(archetype: Archetype) -> bool:
    return archetype in (Archetype.INSTANT_DUMP_REBATER, Archetype.BOT_LOOP)


def claims_tribute_immediately(archetype: Archetype) -> bool:
    # Dumpers/bots claim fast; everyone else batches it up.
    return archetype in (Archetype.INSTANT_DUMP_REBATER, Archetype.BOT_LOOP)


def mint_delay_seconds(archetype: Archetype, ramp: float, rng: np.random.Generator) -> float:
    """How long a *camper* is willing to additionally wait beyond the base
    arrival draw to catch a higher k(t). Other archetypes add ~0.
    """
    if archetype == Archetype.PATIENT_CAMPER:
        # D-98: k(t) is a linear ramp that TOPS OUT at t = ramp, so camping past
        # it buys nothing. Campers wait out the ramp and a little slack, where
        # under the old exponential they had to sit 2-4 time constants to get
        # most of a climb that never actually finished.
        return rng.uniform(1.0, 1.25) * ramp
    return 0.0
