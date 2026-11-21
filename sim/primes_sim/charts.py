"""Landing-page charts (IMPLEMENTATION_PLAN.md Phase 1 output). Deterministic
given a seeded Engine run -- same seed/params always reproduce the same
PNGs, byte-identical modulo matplotlib's own font-rendering nondeterminism.
"""
from __future__ import annotations

import os

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import pandas as pd

from . import analysis as an
from .engine import Engine

PALETTE = {
    "floor": "#1f6f4a",
    "amm": "#c76b1f",
    "pending": "#4a6fa5",
    "grid": "#dddddd",
}


def _style(ax):
    ax.grid(True, color=PALETTE["grid"], linewidth=0.6)
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)


def chart_floor_staircase(e: Engine, out_path: str):
    hist = an.history_df(e)
    fig, ax = plt.subplots(figsize=(9, 5))
    ax.plot(hist["t_days"], hist["floor_price"], color=PALETTE["floor"], linewidth=2.0, label="Floor price p_f = T/S")
    ax.plot(hist["t_days"], hist["amm_price"], color=PALETTE["amm"], linewidth=1.2, alpha=0.85, label="AMM spot price")
    ax.set_xlabel("Days since genesis")
    ax.set_ylabel("TON per PRIMES")
    ax.set_title("Floor-price staircase vs AMM spot price")
    ax.legend(frameon=False)
    _style(ax)
    fig.tight_layout()
    fig.savefig(out_path, dpi=150)
    plt.close(fig)


def chart_head_and_ceiling(e: Engine, out_path: str):
    hist = an.history_df(e)
    fig, ax = plt.subplots(figsize=(9, 5))
    ax.plot(hist["t_days"], hist["head"], color=PALETTE["floor"], linewidth=2.0, label="Mint head (n)")
    ax.axhline(an.OWED_CEILING_N, color="crimson", linestyle="--", linewidth=1.4,
               label=f"owed-dict state-size ceiling (n~{an.OWED_CEILING_N:,})")
    ax.set_xlabel("Days since genesis")
    ax.set_ylabel("n (sequential mint head)")
    ax.set_title("Mint volume vs the owed-dict state-size ceiling (Phase 0 Spike 4)")
    ax.legend(frameon=False)
    _style(ax)
    fig.tight_layout()
    fig.savefig(out_path, dpi=150)
    plt.close(fig)


def chart_pending_and_flush(e: Engine, out_path: str):
    hist = an.history_df(e)
    fig, ax = plt.subplots(figsize=(9, 5))
    ax.plot(hist["t_days"], hist["pending"], color=PALETTE["pending"], linewidth=1.4, label="pending (ratchet TON, standing bid under the floor guard)")
    ax.plot(hist["t_days"], hist["swapped"], color=PALETTE["floor"], linewidth=1.4, label="cumulative swapped+burned")
    ax.set_xlabel("Days since genesis")
    ax.set_ylabel("TON")
    ax.set_title("Ratchet balance: pending vs cumulative flushed (T = swapped + pending)")
    ax.legend(frameon=False)
    _style(ax)
    fig.tight_layout()
    fig.savefig(out_path, dpi=150)
    plt.close(fig)


def chart_tribute_by_prime(e: Engine, annualized_yield: dict, out_path: str):
    fig, ax = plt.subplots(figsize=(9, 5))
    primes = list(annualized_yield.keys())
    values = [annualized_yield[p] for p in primes]
    ax.bar([str(p) for p in primes], values, color=PALETTE["floor"])
    ax.set_xlabel("Genesis auction prime")
    ax.set_ylabel("Annualized tribute yield (TON/year), final quarter of horizon")
    ax.set_title("Tribute run-rate by genesis prime at end of simulated horizon")
    _style(ax)
    fig.tight_layout()
    fig.savefig(out_path, dpi=150)
    plt.close(fig)


def chart_k_over_time(e: Engine, out_path: str):
    mdf = an.mintlog_df(e)
    if mdf.empty:
        return
    sample = mdf.iloc[:: max(1, len(mdf) // 5000)]
    fig, ax = plt.subplots(figsize=(9, 5))
    ax.scatter(sample["t_days"], sample["k"], s=3, alpha=0.35, color=PALETTE["amm"])
    ax.set_xlabel("Days since genesis")
    ax.set_ylabel("k(t) at mint time")
    ax.set_title("Rebate share k(t) realized across mints (adversarial agent mix)")
    _style(ax)
    fig.tight_layout()
    fig.savefig(out_path, dpi=150)
    plt.close(fig)


def render_all(e: Engine, annualized_yield: dict, out_dir: str) -> list[str]:
    os.makedirs(out_dir, exist_ok=True)
    paths = []
    jobs = [
        ("floor_staircase.png", lambda p: chart_floor_staircase(e, p)),
        ("head_vs_owed_ceiling.png", lambda p: chart_head_and_ceiling(e, p)),
        ("pending_vs_flush.png", lambda p: chart_pending_and_flush(e, p)),
        ("tribute_by_prime.png", lambda p: chart_tribute_by_prime(e, annualized_yield, p)),
        ("k_over_time.png", lambda p: chart_k_over_time(e, p)),
    ]
    for fname, fn in jobs:
        path = os.path.join(out_dir, fname)
        fn(path)
        paths.append(path)
    return paths
