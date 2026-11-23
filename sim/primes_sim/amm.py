"""Constant-product AMM (xy=k) with DeDust's mainnet volatile-pool fee, standing
in for the DeDust PRIMES/GRAM pool (CONCEPT.md SS4.3, SS5).

WHERE 0.0025 COMES FROM, AND WHAT IT IS NOT. It is what DeDust's mainnet factory
sets on a volatile pool: 52,286 of the 52,326 pools its own listing published on
2026-09-17, and `get_trade_fee` on a live one answers 25/10000. It is NOT a
constant of this protocol and must not be treated as one. The fee is per-pool --
mainnet also runs 0.05% stable pools and 0.1%/0.5%/1% volatile ones, and the
testnet venue's DeDust build (same factory address, different code) charges
0.40% -- which is why every RUNTIME consumer reads `get_trade_fee` instead of
importing a number from here.

SENSITIVITY. The fee reaches the protocol through one place only: whether a
flush clears `min_out = amount * S / T` (CONCEPT.md SS4.3.1, FLOOR_GUARD = 0).
Going 0.0025 -> 0.0040 asks the market for 0.15% more premium over the floor.
That used to land against a guard refusing 99.4% of attempts anyway; since
D-143's venue-depth sizing the guard fills 68.0% of them (895/1317), so the fee
is a real term in the fill decision rather than noise under a refusal that was
going to happen regardless. Nothing else in this simulation reads it.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass
class Pool:
    ton_reserve: float   # x
    primes_reserve: float  # y
    fee: float = 0.0025

    @property
    def price_ton_per_primes(self) -> float:
        """Marginal spot price, GRAM per PRIMES."""
        if self.primes_reserve <= 0:
            return float("inf")
        return self.ton_reserve / self.primes_reserve

    def quote_ton_for_primes(self, ton_in: float) -> float:
        """PRIMES out for `ton_in`, without executing. This is what the floor
        guard's `min_out` is compared against (CONCEPT.md SS4.3.1) -- on TON the
        vault simply bounces when the limit cannot be met.
        """
        if ton_in <= 0:
            return 0.0
        ton_in_eff = ton_in * (1 - self.fee)
        return self.primes_reserve * ton_in_eff / (self.ton_reserve + ton_in_eff)

    def max_in_at_floor(self, floor_ton_per_primes: float, floor_guard: float = 0.0) -> float:
        """The largest GRAM input whose AVERAGE execution price still clears the
        floor guard -- `flush()`'s venue-depth sizing (CONCEPT.md SS4.3.1).

        The contract sizes its tranche off `pending` and prices the guard off
        the pool, and nothing connected the two, so a tranche larger than the
        venue could absorb bounced against a guard doing exactly its job: the
        SPOT price sat below the floor while the swap's AVERAGE execution price
        ran above it. Measured on testnet 2026-09-19 at 7.7x above, with the
        spot price 2.1x below.

        Solving `quote_ton_for_primes(a) >= a / p_f * (1 + G)` for `a` -- the
        `a` cancels, because the curve is a price and a price does not care how
        the trade is denominated -- gives

            a_max = p_f * R_p / (1 + G) - R_t / (1 - fee)

        which is positive exactly when the market is below the floor net of the
        pool's fee. Returns 0.0 when no size fills.

        THIS IS NOT A NEW PARAMETER (CLAUDE.md rule 3). `flush_pct`,
        `flush_min_ton` and `FLOOR_GUARD` are unchanged; this is the mechanical
        consequence of the guard they already calibrate, solved for its own free
        variable. `shared/dedustQuote.ts`'s `maxInAtFloor` is the same formula in
        integers, and `SimCrossCheck.spec.ts` pins the two together.
        """
        if self.primes_reserve <= 0 or self.ton_reserve <= 0 or self.fee >= 1:
            return 0.0
        a_max = (
            floor_ton_per_primes * self.primes_reserve / (1.0 + floor_guard)
            - self.ton_reserve / (1.0 - self.fee)
        )
        return a_max if a_max > 0 else 0.0

    def swap_ton_for_primes(self, ton_in: float) -> float:
        """Bank/buyer sends GRAM, receives PRIMES. Returns PRIMES out."""
        if ton_in <= 0:
            return 0.0
        ton_in_eff = ton_in * (1 - self.fee)
        primes_out = self.primes_reserve * ton_in_eff / (self.ton_reserve + ton_in_eff)
        primes_out = min(primes_out, self.primes_reserve * 0.999999)
        self.ton_reserve += ton_in
        self.primes_reserve -= primes_out
        return primes_out

    def swap_primes_for_ton(self, primes_in: float) -> float:
        """Seller sends PRIMES, receives GRAM. Returns GRAM out."""
        if primes_in <= 0:
            return 0.0
        primes_in_eff = primes_in * (1 - self.fee)
        ton_out = self.ton_reserve * primes_in_eff / (self.primes_reserve + primes_in_eff)
        ton_out = min(ton_out, self.ton_reserve * 0.999999)
        self.primes_reserve += primes_in
        self.ton_reserve -= ton_out
        return ton_out
