# Genesis emission curve — the first 100 mints after a 100.00 GRAM donation

**Measured** 2026-11-28 · **generator** `sim/scripts/run_phase1.py` (seed 20260814) · **decision** `DECISIONS.md` D-100 point 2, D-154, D-204 · **spec** `CONCEPT.md` §5, §6 point 3

This is a **measurement record**, not a work list. Nothing in it is a to-do.

## Why this file exists

D-100 point 2 replaced D-92's 240 GRAM genesis donation with 4.20 GRAM, and
D-154 and then D-204 raised it to **100.00 GRAM**. The derivation method is unchanged through
both; only its input moves. The consequence the decision commits to
publishing *before deploy* is this one:

> a mint's rebate is `R = k · I · S / T` PRIMES (§5), and `S / T` is `1 / p_f`.
> A smaller genesis floor makes every GRAM of injection buy proportionally
> more PRIMES, so the donation also sizes the front-loaded emission below.

The **ratchet theorem is untouched** — `k < 1` still makes `p_f = T/S` strictly
increasing on every mint, and this run confirms it over the whole curve. But
*the floor rises* and *supply is stable* are different claims. This file measures
the second one.

## Genesis state the curve starts from

| quantity | value | where it comes from |
|---|---|---|
| `T₀` (`seedT`) | **100.00 GRAM** | D-100 point 2, owner-set. After D-100 point 1 a donation is the *only* thing that lands in `seedT`. |
| `S₀` | **17,586,167 PRIMES** | 15,600,000 bounty vault (D-204) + 1,000,000 vested to the treasury (D-100 point 6; D-166 deleted the operator's 1 M) + the donor's `donate_floor` mint, `T₀ · L` tapered by D-156 (D-100 point 1). |
| `p_f0` | **5.686288e-06 GRAM/PRIMES** | `T₀ / S₀`. D-92's figure was 1.667e-5 — this is 2.93× lower. |
| `L` | 10,000 PRIMES/GRAM | D-39, untouched: a denomination knob, not a price. |

## Method

The curve is **not a second model**. It replays the base-case Phase 1 run's own
realised `(kind, β, k)` stream, mint by mint, in order. `β` (the residual
injected into the ratchet) and `k` (the rebate coefficient — `0` on every prime
mint, §5.1) are both independent of the floor, so replaying them from a different
genesis state is exact arithmetic rather than a re-simulation.

The run is on the **D-20** model: primes are not head mints, so the table lists
composites only and opens at **n = 4**. A prime's Dutch lot raises `T` with zero
emission (§5.1, D-7); the replay leaves that GRAM out, which understates the floor
and so overstates emission — the conservative direction for this file.

## What the curve shows

| claim in D-100 point 2 | measured | verdict |
|---|---|---|
| the first mints emit "on the order of 15% of `S₀`" | the largest single mint emits **0.31%** of `S₀` (mint 1: 0.13%) | **NO** |
| "self-correcting within ~10 mints" | the first 10 mints account for **17.0%** of all emission over the curve, and no mint after the tenth emits more than **0.227%** of `S₀` | **NO** |
| the ratchet still holds | `p_f` monotone over all 100 mints | **yes** |

A per-mint ratio *at exactly mint 10* would have been the wrong instrument and is
deliberately not used: mint 10 may be a prime, and a prime emits nothing at all
(§5.1), so that ratio can read `0.00` for a reason with nothing to do with decay.

## The honest reading

The per-mint emission does fall fast. It is a `k·β / T` term and `T` grows by `β`
every mint from a base of only 100.00 GRAM, so the denominator runs away from the
numerator almost immediately. Over the first 100 mints:

- `T` grows **1.3×**, to 126.00 GRAM;
- `S` grows **1.09×**, to 19,109,282 PRIMES — a cumulative emission of **8.7% of `S₀`**;
- `p_f` rises **1.16×**, to 6.593654e-06 GRAM/PRIMES;
- mint 100 emits 0.1044% of `S₀`.

What that costs, and what it does not. It is **not a solvency problem**: nothing
here can make `p_f` fall, `S` is never decremented (§3.3), and every emitted
PRIMES is backed by the same `T` that received the injection — the floor ends the
curve **1.16×** higher than it started. It is a **dilution schedule**, and it is
front-loaded by construction: whoever mints first buys PRIMES at a floor
2.93× cheaper than D-92's would have been. D-100 point 2 calls this
"D-91's own
complaint reproduced by choice" and accepts it in writing; this file is the
measurement that makes the choice legible rather than a footnote.

The number to carry away is the cumulative one: the first 100 mints multiply
`S₀` by **1.09**, and the floor still ends up **1.16×** where it began.

## The first 100 mints

`k = 0` rows are prime mints (§5.1: primes emit nothing and ratchet ~11× harder).

| # | n | kind | k | β (GRAM) | rebate (PRIMES) | % of `S₀` | T (GRAM) | S (PRIMES) | `p_f` | `p_f/p_f0` |
|--:|--:|---|--:|--:|--:|--:|--:|--:|--:|--:|
| 1 | 4 | composite | 0.5348 | 0.2470 | 23,230 | 0.132% | 100.247 | 17,609,397 | 5.693e-06 | 1.0011 |
| 2 | 6 | composite | 0.8868 | 0.3470 | 54,054 | 0.307% | 100.594 | 17,663,450 | 5.695e-06 | 1.0015 |
| 3 | 8 | composite | 0.1971 | 0.2470 | 8,547 | 0.049% | 100.841 | 17,671,997 | 5.706e-06 | 1.0035 |
| 4 | 9 | composite | 0.2047 | 0.3470 | 12,449 | 0.071% | 101.188 | 17,684,446 | 5.722e-06 | 1.0063 |
| 5 | 10 | composite | 0.9360 | 0.2470 | 40,405 | 0.230% | 101.435 | 17,724,851 | 5.723e-06 | 1.0064 |
| 6 | 12 | composite | 0.3590 | 0.2470 | 15,495 | 0.088% | 101.682 | 17,740,346 | 5.732e-06 | 1.0080 |
| 7 | 14 | composite | 0.9360 | 0.2470 | 40,334 | 0.229% | 101.929 | 17,780,680 | 5.733e-06 | 1.0081 |
| 8 | 15 | composite | 0.1970 | 0.3470 | 11,927 | 0.068% | 102.276 | 17,792,607 | 5.748e-06 | 1.0109 |
| 9 | 16 | composite | 0.9359 | 0.2470 | 40,216 | 0.229% | 102.523 | 17,832,823 | 5.749e-06 | 1.0110 |
| 10 | 18 | composite | 0.1970 | 0.3470 | 11,892 | 0.068% | 102.870 | 17,844,715 | 5.765e-06 | 1.0138 |
| 11 | 20 | composite | 0.2242 | 0.2470 | 9,604 | 0.055% | 103.117 | 17,854,320 | 5.775e-06 | 1.0157 |
| 12 | 21 | composite | 0.2991 | 0.2470 | 12,792 | 0.073% | 103.364 | 17,867,112 | 5.785e-06 | 1.0174 |
| 13 | 22 | composite | 0.9359 | 0.2470 | 39,958 | 0.227% | 103.611 | 17,907,069 | 5.786e-06 | 1.0175 |
| 14 | 24 | composite | 0.1970 | 0.2470 | 8,411 | 0.048% | 103.858 | 17,915,480 | 5.797e-06 | 1.0195 |
| 15 | 25 | composite | 0.2732 | 0.2470 | 11,639 | 0.066% | 104.105 | 17,927,119 | 5.807e-06 | 1.0213 |
| 16 | 26 | composite | 0.3062 | 0.3470 | 18,296 | 0.104% | 104.452 | 17,945,415 | 5.821e-06 | 1.0236 |
| 17 | 27 | composite | 0.2293 | 0.2470 | 9,732 | 0.055% | 104.699 | 17,955,146 | 5.831e-06 | 1.0255 |
| 18 | 28 | composite | 0.2696 | 0.2470 | 11,420 | 0.065% | 104.946 | 17,966,566 | 5.841e-06 | 1.0272 |
| 19 | 30 | composite | 0.3825 | 0.2470 | 16,176 | 0.092% | 105.193 | 17,982,742 | 5.850e-06 | 1.0287 |
| 20 | 32 | composite | 0.3854 | 0.2470 | 16,273 | 0.093% | 105.440 | 17,999,015 | 5.858e-06 | 1.0302 |
| 21 | 33 | composite | 0.6441 | 0.2470 | 27,158 | 0.154% | 105.687 | 18,026,174 | 5.863e-06 | 1.0311 |
| 22 | 34 | composite | 0.2091 | 0.2470 | 8,807 | 0.050% | 105.934 | 18,034,981 | 5.874e-06 | 1.0330 |
| 23 | 35 | composite | 0.2228 | 0.2470 | 9,368 | 0.053% | 106.181 | 18,044,349 | 5.884e-06 | 1.0348 |
| 24 | 36 | composite | 0.6352 | 0.2470 | 26,664 | 0.152% | 106.428 | 18,071,014 | 5.889e-06 | 1.0357 |
| 25 | 38 | composite | 0.1998 | 0.2470 | 8,380 | 0.048% | 106.675 | 18,079,394 | 5.900e-06 | 1.0376 |
| 26 | 39 | composite | 0.4520 | 0.2470 | 18,923 | 0.108% | 106.922 | 18,098,317 | 5.908e-06 | 1.0390 |
| 27 | 40 | composite | 0.2601 | 0.2470 | 10,875 | 0.062% | 107.169 | 18,109,191 | 5.918e-06 | 1.0407 |
| 28 | 42 | composite | 0.2036 | 0.2470 | 8,496 | 0.048% | 107.416 | 18,117,688 | 5.929e-06 | 1.0426 |
| 29 | 44 | composite | 0.2472 | 0.3470 | 14,469 | 0.082% | 107.763 | 18,132,157 | 5.943e-06 | 1.0452 |
| 30 | 45 | composite | 0.2062 | 0.2470 | 8,572 | 0.049% | 108.010 | 18,140,729 | 5.954e-06 | 1.0471 |
| 31 | 46 | composite | 0.3314 | 0.2470 | 13,747 | 0.078% | 108.257 | 18,154,476 | 5.963e-06 | 1.0487 |
| 32 | 48 | composite | 0.2796 | 0.3470 | 16,272 | 0.093% | 108.604 | 18,170,748 | 5.977e-06 | 1.0511 |
| 33 | 49 | composite | 0.9357 | 0.2470 | 38,668 | 0.220% | 108.851 | 18,209,416 | 5.978e-06 | 1.0513 |
| 34 | 50 | composite | 0.1970 | 0.2470 | 8,139 | 0.046% | 109.098 | 18,217,555 | 5.989e-06 | 1.0532 |
| 35 | 51 | composite | 0.7647 | 0.2470 | 31,540 | 0.179% | 109.345 | 18,249,095 | 5.992e-06 | 1.0537 |
| 36 | 52 | composite | 0.9356 | 0.2470 | 38,569 | 0.219% | 109.592 | 18,287,664 | 5.993e-06 | 1.0539 |
| 37 | 54 | composite | 0.4277 | 0.3470 | 24,768 | 0.141% | 109.939 | 18,312,432 | 6.004e-06 | 1.0558 |
| 38 | 55 | composite | 0.2503 | 0.2470 | 10,298 | 0.059% | 110.186 | 18,322,730 | 6.014e-06 | 1.0576 |
| 39 | 56 | composite | 0.1970 | 0.2470 | 8,090 | 0.046% | 110.433 | 18,330,820 | 6.024e-06 | 1.0595 |
| 40 | 57 | composite | 0.9356 | 0.2470 | 38,358 | 0.218% | 110.680 | 18,369,178 | 6.025e-06 | 1.0596 |
| 41 | 58 | composite | 0.1970 | 0.2470 | 8,074 | 0.046% | 110.927 | 18,377,252 | 6.036e-06 | 1.0615 |
| 42 | 60 | composite | 0.2237 | 0.2470 | 9,154 | 0.052% | 111.174 | 18,386,406 | 6.047e-06 | 1.0634 |
| 43 | 62 | composite | 0.2891 | 0.2470 | 11,810 | 0.067% | 111.421 | 18,398,216 | 6.056e-06 | 1.0650 |
| 44 | 63 | composite | 0.2677 | 0.3470 | 15,337 | 0.087% | 111.768 | 18,413,554 | 6.070e-06 | 1.0675 |
| 45 | 64 | composite | 0.2332 | 0.2470 | 9,488 | 0.054% | 112.015 | 18,423,042 | 6.080e-06 | 1.0693 |
| 46 | 65 | composite | 0.3206 | 0.2470 | 13,024 | 0.074% | 112.262 | 18,436,066 | 6.089e-06 | 1.0709 |
| 47 | 66 | composite | 0.4388 | 0.2470 | 17,799 | 0.101% | 112.509 | 18,453,865 | 6.097e-06 | 1.0722 |
| 48 | 68 | composite | 0.2018 | 0.2470 | 8,175 | 0.046% | 112.756 | 18,462,040 | 6.107e-06 | 1.0741 |
| 49 | 69 | composite | 0.2882 | 0.3470 | 16,375 | 0.093% | 113.103 | 18,478,415 | 6.121e-06 | 1.0764 |
| 50 | 70 | composite | 0.3111 | 0.2470 | 12,555 | 0.071% | 113.350 | 18,490,969 | 6.130e-06 | 1.0780 |
| 51 | 72 | composite | 0.2516 | 0.2470 | 10,137 | 0.058% | 113.597 | 18,501,106 | 6.140e-06 | 1.0798 |
| 52 | 74 | composite | 0.2233 | 0.2470 | 8,981 | 0.051% | 113.844 | 18,510,088 | 6.150e-06 | 1.0816 |
| 53 | 75 | composite | 0.2016 | 0.2470 | 8,096 | 0.046% | 114.091 | 18,518,184 | 6.161e-06 | 1.0835 |
| 54 | 76 | composite | 0.1999 | 0.2470 | 8,012 | 0.046% | 114.338 | 18,526,196 | 6.172e-06 | 1.0854 |
| 55 | 77 | composite | 0.3143 | 0.2470 | 12,579 | 0.072% | 114.585 | 18,538,775 | 6.181e-06 | 1.0870 |
| 56 | 78 | composite | 0.2202 | 0.2470 | 8,800 | 0.050% | 114.832 | 18,547,575 | 6.191e-06 | 1.0888 |
| 57 | 80 | composite | 0.1979 | 0.2470 | 7,896 | 0.045% | 115.079 | 18,555,472 | 6.202e-06 | 1.0907 |
| 58 | 81 | composite | 0.2319 | 0.2470 | 9,237 | 0.053% | 115.326 | 18,564,708 | 6.212e-06 | 1.0925 |
| 59 | 82 | composite | 0.2336 | 0.2470 | 9,288 | 0.053% | 115.573 | 18,573,996 | 6.222e-06 | 1.0943 |
| 60 | 84 | composite | 0.6500 | 0.2470 | 25,804 | 0.147% | 115.820 | 18,599,800 | 6.227e-06 | 1.0951 |
| 61 | 85 | composite | 0.2718 | 0.2470 | 10,782 | 0.061% | 116.067 | 18,610,582 | 6.237e-06 | 1.0968 |
| 62 | 86 | composite | 0.1991 | 0.2470 | 7,884 | 0.045% | 116.314 | 18,618,467 | 6.247e-06 | 1.0986 |
| 63 | 87 | composite | 0.2357 | 0.2470 | 9,321 | 0.053% | 116.561 | 18,627,788 | 6.257e-06 | 1.1004 |
| 64 | 88 | composite | 0.2081 | 0.2470 | 8,215 | 0.047% | 116.808 | 18,636,003 | 6.268e-06 | 1.1023 |
| 65 | 90 | composite | 0.2044 | 0.2470 | 8,054 | 0.046% | 117.055 | 18,644,056 | 6.278e-06 | 1.1041 |
| 66 | 91 | composite | 0.2619 | 0.2470 | 10,305 | 0.059% | 117.302 | 18,654,361 | 6.288e-06 | 1.1058 |
| 67 | 92 | composite | 0.1989 | 0.2470 | 7,815 | 0.044% | 117.549 | 18,662,176 | 6.299e-06 | 1.1077 |
| 68 | 93 | composite | 0.2015 | 0.2470 | 7,901 | 0.045% | 117.796 | 18,670,077 | 6.309e-06 | 1.1096 |
| 69 | 94 | composite | 0.2001 | 0.2470 | 7,834 | 0.045% | 118.043 | 18,677,910 | 6.320e-06 | 1.1114 |
| 70 | 95 | composite | 0.2023 | 0.2470 | 7,908 | 0.045% | 118.290 | 18,685,819 | 6.330e-06 | 1.1133 |
| 71 | 96 | composite | 0.2834 | 0.2470 | 11,059 | 0.063% | 118.537 | 18,696,877 | 6.340e-06 | 1.1150 |
| 72 | 98 | composite | 0.1991 | 0.2470 | 7,756 | 0.044% | 118.784 | 18,704,633 | 6.351e-06 | 1.1168 |
| 73 | 99 | composite | 0.3498 | 0.2470 | 13,605 | 0.077% | 119.031 | 18,718,238 | 6.359e-06 | 1.1183 |
| 74 | 100 | composite | 0.3306 | 0.2470 | 12,840 | 0.073% | 119.278 | 18,731,078 | 6.368e-06 | 1.1199 |
| 75 | 102 | composite | 0.3153 | 0.2470 | 12,231 | 0.070% | 119.525 | 18,743,308 | 6.377e-06 | 1.1215 |
| 76 | 104 | composite | 0.2920 | 0.2470 | 11,309 | 0.064% | 119.772 | 18,754,618 | 6.386e-06 | 1.1231 |
| 77 | 105 | composite | 0.3551 | 0.2470 | 13,735 | 0.078% | 120.019 | 18,768,352 | 6.395e-06 | 1.1246 |
| 78 | 106 | composite | 0.3935 | 0.2470 | 15,198 | 0.086% | 120.266 | 18,783,550 | 6.403e-06 | 1.1260 |
| 79 | 108 | composite | 0.1975 | 0.2470 | 7,617 | 0.043% | 120.513 | 18,791,167 | 6.413e-06 | 1.1278 |
| 80 | 110 | composite | 0.4044 | 0.2470 | 15,575 | 0.089% | 120.760 | 18,806,743 | 6.421e-06 | 1.1292 |
| 81 | 111 | composite | 0.2923 | 0.2470 | 11,243 | 0.064% | 121.007 | 18,817,985 | 6.430e-06 | 1.1309 |
| 82 | 112 | composite | 0.2028 | 0.2470 | 7,792 | 0.044% | 121.254 | 18,825,777 | 6.441e-06 | 1.1327 |
| 83 | 114 | composite | 0.1998 | 0.2470 | 7,664 | 0.044% | 121.501 | 18,833,441 | 6.451e-06 | 1.1345 |
| 84 | 115 | composite | 0.1972 | 0.2470 | 7,552 | 0.043% | 121.748 | 18,840,992 | 6.462e-06 | 1.1364 |
| 85 | 116 | composite | 0.2005 | 0.2470 | 7,662 | 0.044% | 121.995 | 18,848,655 | 6.472e-06 | 1.1382 |
| 86 | 117 | composite | 0.2611 | 0.2470 | 9,966 | 0.057% | 122.242 | 18,858,621 | 6.482e-06 | 1.1399 |
| 87 | 118 | composite | 0.3692 | 0.2470 | 14,069 | 0.080% | 122.489 | 18,872,690 | 6.490e-06 | 1.1414 |
| 88 | 119 | composite | 0.9353 | 0.2470 | 35,593 | 0.202% | 122.736 | 18,908,283 | 6.491e-06 | 1.1415 |
| 89 | 120 | composite | 0.1969 | 0.2470 | 7,492 | 0.043% | 122.983 | 18,915,776 | 6.502e-06 | 1.1434 |
| 90 | 121 | composite | 0.5491 | 0.3470 | 29,306 | 0.167% | 123.330 | 18,945,081 | 6.510e-06 | 1.1448 |
| 91 | 122 | composite | 0.2136 | 0.2470 | 8,103 | 0.046% | 123.577 | 18,953,184 | 6.520e-06 | 1.1466 |
| 92 | 123 | composite | 0.3549 | 0.2470 | 13,445 | 0.076% | 123.824 | 18,966,629 | 6.529e-06 | 1.1481 |
| 93 | 124 | composite | 0.6403 | 0.3470 | 34,035 | 0.194% | 124.171 | 19,000,664 | 6.535e-06 | 1.1493 |
| 94 | 125 | composite | 0.1992 | 0.2470 | 7,529 | 0.043% | 124.418 | 19,008,192 | 6.545e-06 | 1.1511 |
| 95 | 126 | composite | 0.2151 | 0.2470 | 8,117 | 0.046% | 124.665 | 19,016,310 | 6.556e-06 | 1.1529 |
| 96 | 128 | composite | 0.4248 | 0.3470 | 22,485 | 0.128% | 125.012 | 19,038,795 | 6.566e-06 | 1.1547 |
| 97 | 129 | composite | 0.2554 | 0.2470 | 9,606 | 0.055% | 125.259 | 19,048,401 | 6.576e-06 | 1.1564 |
| 98 | 130 | composite | 0.9352 | 0.2470 | 35,127 | 0.200% | 125.506 | 19,083,528 | 6.577e-06 | 1.1566 |
| 99 | 132 | composite | 0.1969 | 0.2470 | 7,394 | 0.042% | 125.753 | 19,090,922 | 6.587e-06 | 1.1584 |
| 100 | 133 | composite | 0.4896 | 0.2470 | 18,360 | 0.104% | 126.000 | 19,109,282 | 6.594e-06 | 1.1596 |

## Regenerating this file

`cd sim && python scripts/run_phase1.py`. It is written by the same pass that
writes `shared/params.json`, from the same run, so the two can never disagree.

