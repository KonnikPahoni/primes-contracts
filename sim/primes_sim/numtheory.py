"""Number-theory primitives backing the mint mechanics (CONCEPT.md SS3.1).

A smallest-prime-factor (SPF) sieve gives O(log n) factorization and O(1)
primality for every n up to N_MAX, which is all the simulation needs — real
Miller-Rabin / factorization-proof verification is a Phase 3 contract concern
(see CLAUDE.md "Measured provenance"); the sim only needs the *mathematical
facts* (is n prime? what are its distinct prime factors and exponents?) to
drive tribute and mint-type economics.
"""
from __future__ import annotations

import numpy as np


class Sieve:
    """Smallest-prime-factor sieve over [0, n_max]."""

    def __init__(self, n_max: int):
        self.n_max = n_max
        spf = np.arange(n_max + 1, dtype=np.int64)
        for i in range(2, int(n_max**0.5) + 1):
            if spf[i] == i:  # i is prime, not yet marked by a smaller factor
                spf[i * i :: i] = np.minimum(spf[i * i :: i], i)
        self.spf = spf

    def is_prime(self, n: int) -> bool:
        if n < 2:
            return False
        return self.spf[n] == n

    def factorize(self, n: int) -> dict[int, int]:
        """Return {prime: exponent} for n's prime factorization."""
        factors: dict[int, int] = {}
        while n > 1:
            p = int(self.spf[n])
            e = 0
            while n % p == 0:
                n //= p
                e += 1
            factors[p] = e
        return factors

    def omega(self, n: int) -> int:
        return len(self.factorize(n))
