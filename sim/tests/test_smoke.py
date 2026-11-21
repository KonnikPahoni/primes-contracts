"""Phase 0 smoke test: proves the /sim environment (numpy/pandas/matplotlib/pytest)
is wired up correctly. Replaced by real engine tests in Phase 1.
"""
import numpy as np
import pandas as pd

from primes_sim import __version__


def test_package_imports():
    assert __version__ == "2.0.0"


def test_numpy_pandas_interop():
    arr = np.arange(10)
    s = pd.Series(arr)
    assert s.sum() == 45


def test_floor_ratchet_toy_inequality():
    """Sanity-check the ratchet theorem's algebraic shape (CONCEPT.md §5) on toy
    numbers: p_f' > p_f for any k < 1, any positive injection I.
    """
    T, S = 1000.0, 100.0
    p_f = T / S
    for k in (0.01, 0.2, 0.5, 0.9, 0.999):
        injection = 0.65
        s_new = S + k * injection / p_f
        t_new = T + injection
        p_f_new = t_new / s_new
        assert p_f_new > p_f
