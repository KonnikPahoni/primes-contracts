"""Mint-arrival process: Poisson base rate + hype bursts + weekend/era
seasonality (IMPLEMENTATION_PLAN.md Phase 1 / CONCEPT.md SS10).

Generates a stream of inter-arrival gaps (seconds) rather than a fixed
timestamp list, since hype bursts and the era-boundary bump are stateful.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

DAY = 86400.0
WEEK = 7 * DAY

# Primorials up to a scale far beyond any realistic simulated horizon.
PRIMORIALS = [6, 30, 210, 2310, 30030, 510510, 9699690, 223092870]


@dataclass
class ArrivalParams:
    base_rate_per_day: float = 80.0     # organic+adversarial baseline mints/day
    weekend_multiplier: float = 1.25    # weekend engagement bump
    hype_rate_per_day: float = 1.0 / 21.0  # hype-burst events ~ every 3 weeks
    hype_multiplier: float = 6.0
    hype_halflife_days: float = 1.5
    era_window: int = 500               # +/- mints around a primorial boundary
    era_multiplier: float = 1.8
    growth_per_day: float = 0.0015      # slow organic growth in base rate (compounding)


class ArrivalProcess:
    """Stateful thinning-free rate model: draws exponential gaps against the
    *current* instantaneous rate (re-evaluated after every draw), which is
    an adequate approximation for a rate that varies smoothly relative to
    the mean gap.
    """

    def __init__(self, params: ArrivalParams, rng: np.random.Generator):
        self.p = params
        self.rng = rng
        self.t = 0.0
        self._active_hype_until = -1.0
        self._active_hype_start = -1.0
        self._next_hype_check = self._draw_next_hype_gap()

    def _draw_next_hype_gap(self) -> float:
        return self.rng.exponential(1.0 / self.p.hype_rate_per_day) * DAY

    def _seasonal_mult(self, t: float) -> float:
        day_of_week = (t / DAY) % 7
        is_weekend = day_of_week >= 5.0
        return self.p.weekend_multiplier if is_weekend else 1.0

    def _hype_mult(self, t: float) -> float:
        if t >= self._next_hype_check and self._active_hype_until < t:
            self._active_hype_start = t
            self._active_hype_until = t + self.p.hype_halflife_days * DAY * 4
            self._next_hype_check = t + self._draw_next_hype_gap()
        if t < self._active_hype_until:
            age_days = (t - self._active_hype_start) / DAY
            decay = 0.5 ** (age_days / self.p.hype_halflife_days)
            return 1.0 + (self.p.hype_multiplier - 1.0) * decay
        return 1.0

    def _era_mult(self, n_head: int) -> float:
        for pr in PRIMORIALS:
            if abs(pr - n_head) <= self.p.era_window:
                return self.p.era_multiplier
        return 1.0

    def rate_per_day(self, t: float, n_head: int) -> float:
        base = self.p.base_rate_per_day * (1.0 + self.p.growth_per_day) ** (t / DAY)
        return base * self._seasonal_mult(t) * self._hype_mult(t) * self._era_mult(n_head)

    def next_gap(self, n_head: int) -> float:
        """Advance internal clock by one drawn inter-arrival gap (seconds)."""
        rate_day = max(self.rate_per_day(self.t, n_head), 1e-6)
        gap = self.rng.exponential(1.0 / rate_day) * DAY
        self.t += gap
        return gap
