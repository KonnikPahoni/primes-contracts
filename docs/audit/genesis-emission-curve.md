# Genesis emission curve — the first 100 mints after a 200.00 GRAM donation

**Measured** 2026-11-11 · **generator** `sim/scripts/run_phase1.py` (seed 20260814) · **decision** `DECISIONS.md` D-100 point 2, D-154, D-204 · **spec** `CONCEPT.md` §5, §6 point 3

This is a **measurement record**, not a work list. Nothing in it is a to-do.

## Why this file exists

D-100 point 2 replaced D-92's 240 GRAM genesis donation with 4.20 GRAM, and
D-154 and then D-204 raised it to **200.00 GRAM**. The derivation method is unchanged through
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
| `T₀` (`seedT`) | **200.00 GRAM** | D-100 point 2, owner-set. After D-100 point 1 a donation is the *only* thing that lands in `seedT`. |
| `S₀` | **18,572,333 PRIMES** | 15,600,000 bounty vault (D-204) + 1,000,000 vested to the treasury (D-100 point 6; D-166 deleted the operator's 1 M) + the donor's `donate_floor` mint, `T₀ · L` tapered by D-156 (D-100 point 1). |
| `p_f0` | **1.076871e-05 GRAM/PRIMES** | `T₀ / S₀`. D-92's figure was 1.667e-5 — this is 1.55× lower. |
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
| the first mints emit "on the order of 15% of `S₀`" | the largest single mint emits **0.15%** of `S₀` (mint 1: 0.07%) | **NO** |
| "self-correcting within ~10 mints" | the first 10 mints account for **16.5%** of all emission over the curve, and no mint after the tenth emits more than **0.116%** of `S₀` | **NO** |
| the ratchet still holds | `p_f` monotone over all 100 mints | **yes** |

A per-mint ratio *at exactly mint 10* would have been the wrong instrument and is
deliberately not used: mint 10 may be a prime, and a prime emits nothing at all
(§5.1), so that ratio can read `0.00` for a reason with nothing to do with decay.

## The honest reading

The per-mint emission does fall fast. It is a `k·β / T` term and `T` grows by `β`
every mint from a base of only 200.00 GRAM, so the denominator runs away from the
numerator almost immediately. Over the first 100 mints:

- `T` grows **1.1×**, to 226.30 GRAM;
- `S` grows **1.05×**, to 19,411,786 PRIMES — a cumulative emission of **4.5% of `S₀`**;
- `p_f` rises **1.08×**, to 1.165787e-05 GRAM/PRIMES;
- mint 100 emits 0.0565% of `S₀`.

What that costs, and what it does not. It is **not a solvency problem**: nothing
here can make `p_f` fall, `S` is never decremented (§3.3), and every emitted
PRIMES is backed by the same `T` that received the injection — the floor ends the
curve **1.08×** higher than it started. It is a **dilution schedule**, and it is
front-loaded by construction: whoever mints first buys PRIMES at a floor
1.55× cheaper than D-92's would have been. D-100 point 2 calls this
"D-91's own
complaint reproduced by choice" and accepts it in writing; this file is the
measurement that makes the choice legible rather than a footnote.

The number to carry away is the cumulative one: the first 100 mints multiply
`S₀` by **1.05**, and the floor still ends up **1.08×** where it began.

## The first 100 mints

`k = 0` rows are prime mints (§5.1: primes emit nothing and ratchet ~11× harder).

| # | n | kind | k | β (GRAM) | rebate (PRIMES) | % of `S₀` | T (GRAM) | S (PRIMES) | `p_f` | `p_f/p_f0` |
|--:|--:|---|--:|--:|--:|--:|--:|--:|--:|--:|
| 1 | 4 | composite | 0.5343 | 0.2500 | 12,405 | 0.067% | 200.250 | 18,584,738 | 1.077e-05 | 1.0006 |
| 2 | 6 | composite | 0.8861 | 0.3500 | 28,782 | 0.155% | 200.600 | 18,613,520 | 1.078e-05 | 1.0008 |
| 3 | 8 | composite | 0.1969 | 0.2500 | 4,568 | 0.025% | 200.850 | 18,618,087 | 1.079e-05 | 1.0018 |
| 4 | 9 | composite | 0.2046 | 0.3500 | 6,636 | 0.036% | 201.200 | 18,624,724 | 1.080e-05 | 1.0032 |
| 5 | 10 | composite | 0.9353 | 0.2500 | 21,644 | 0.117% | 201.450 | 18,646,368 | 1.080e-05 | 1.0033 |
| 6 | 12 | composite | 0.3587 | 0.2500 | 8,301 | 0.045% | 201.700 | 18,654,668 | 1.081e-05 | 1.0040 |
| 7 | 14 | composite | 0.9352 | 0.2500 | 21,624 | 0.116% | 201.950 | 18,676,293 | 1.081e-05 | 1.0041 |
| 8 | 15 | composite | 0.1969 | 0.3500 | 6,373 | 0.034% | 202.300 | 18,682,665 | 1.083e-05 | 1.0055 |
| 9 | 16 | composite | 0.9352 | 0.2500 | 21,592 | 0.116% | 202.550 | 18,704,257 | 1.083e-05 | 1.0056 |
| 10 | 18 | composite | 0.1969 | 0.3500 | 6,363 | 0.034% | 202.900 | 18,710,621 | 1.084e-05 | 1.0070 |
| 11 | 20 | composite | 0.2240 | 0.2500 | 5,164 | 0.028% | 203.150 | 18,715,785 | 1.085e-05 | 1.0080 |
| 12 | 21 | composite | 0.2989 | 0.2500 | 6,884 | 0.037% | 203.400 | 18,722,669 | 1.086e-05 | 1.0088 |
| 13 | 22 | composite | 0.9352 | 0.2500 | 21,521 | 0.116% | 203.650 | 18,744,189 | 1.086e-05 | 1.0089 |
| 14 | 24 | composite | 0.1969 | 0.2500 | 4,530 | 0.024% | 203.900 | 18,748,719 | 1.088e-05 | 1.0099 |
| 15 | 25 | composite | 0.2730 | 0.2500 | 6,275 | 0.034% | 204.150 | 18,754,994 | 1.089e-05 | 1.0108 |
| 16 | 26 | composite | 0.3060 | 0.3500 | 9,838 | 0.053% | 204.500 | 18,764,832 | 1.090e-05 | 1.0120 |
| 17 | 27 | composite | 0.2292 | 0.2500 | 5,257 | 0.028% | 204.750 | 18,770,089 | 1.091e-05 | 1.0130 |
| 18 | 28 | composite | 0.2694 | 0.2500 | 6,174 | 0.033% | 205.000 | 18,776,264 | 1.092e-05 | 1.0139 |
| 19 | 30 | composite | 0.3823 | 0.2500 | 8,753 | 0.047% | 205.250 | 18,785,017 | 1.093e-05 | 1.0146 |
| 20 | 32 | composite | 0.3851 | 0.2500 | 8,812 | 0.047% | 205.500 | 18,793,829 | 1.093e-05 | 1.0154 |
| 21 | 33 | composite | 0.6437 | 0.2500 | 14,717 | 0.079% | 205.750 | 18,808,545 | 1.094e-05 | 1.0158 |
| 22 | 34 | composite | 0.2089 | 0.2500 | 4,774 | 0.026% | 206.000 | 18,813,320 | 1.095e-05 | 1.0168 |
| 23 | 35 | composite | 0.2226 | 0.2500 | 5,083 | 0.027% | 206.250 | 18,818,402 | 1.096e-05 | 1.0178 |
| 24 | 36 | composite | 0.6348 | 0.2500 | 14,480 | 0.078% | 206.500 | 18,832,883 | 1.096e-05 | 1.0182 |
| 25 | 38 | composite | 0.1997 | 0.2500 | 4,553 | 0.025% | 206.750 | 18,837,435 | 1.098e-05 | 1.0192 |
| 26 | 39 | composite | 0.4517 | 0.2500 | 10,290 | 0.055% | 207.000 | 18,847,725 | 1.098e-05 | 1.0199 |
| 27 | 40 | composite | 0.2599 | 0.2500 | 5,917 | 0.032% | 207.250 | 18,853,642 | 1.099e-05 | 1.0208 |
| 28 | 42 | composite | 0.2034 | 0.2500 | 4,626 | 0.025% | 207.500 | 18,858,268 | 1.100e-05 | 1.0218 |
| 29 | 44 | composite | 0.2471 | 0.3500 | 7,859 | 0.042% | 207.850 | 18,866,127 | 1.102e-05 | 1.0231 |
| 30 | 45 | composite | 0.2061 | 0.2500 | 4,677 | 0.025% | 208.100 | 18,870,804 | 1.103e-05 | 1.0240 |
| 31 | 46 | composite | 0.3312 | 0.2500 | 7,508 | 0.040% | 208.350 | 18,878,312 | 1.104e-05 | 1.0249 |
| 32 | 48 | composite | 0.2794 | 0.3500 | 8,862 | 0.048% | 208.700 | 18,887,174 | 1.105e-05 | 1.0261 |
| 33 | 49 | composite | 0.9351 | 0.2500 | 21,156 | 0.114% | 208.950 | 18,908,329 | 1.105e-05 | 1.0262 |
| 34 | 50 | composite | 0.1969 | 0.2500 | 4,453 | 0.024% | 209.200 | 18,912,783 | 1.106e-05 | 1.0272 |
| 35 | 51 | composite | 0.7642 | 0.2500 | 17,272 | 0.093% | 209.450 | 18,930,055 | 1.106e-05 | 1.0275 |
| 36 | 52 | composite | 0.9350 | 0.2500 | 21,127 | 0.114% | 209.700 | 18,951,182 | 1.107e-05 | 1.0275 |
| 37 | 54 | composite | 0.4275 | 0.3500 | 13,521 | 0.073% | 210.050 | 18,964,703 | 1.108e-05 | 1.0285 |
| 38 | 55 | composite | 0.2502 | 0.2500 | 5,646 | 0.030% | 210.300 | 18,970,349 | 1.109e-05 | 1.0294 |
| 39 | 56 | composite | 0.1968 | 0.2500 | 4,439 | 0.024% | 210.550 | 18,974,789 | 1.110e-05 | 1.0304 |
| 40 | 57 | composite | 0.9350 | 0.2500 | 21,066 | 0.113% | 210.800 | 18,995,854 | 1.110e-05 | 1.0305 |
| 41 | 58 | composite | 0.1968 | 0.2500 | 4,434 | 0.024% | 211.050 | 19,000,289 | 1.111e-05 | 1.0315 |
| 42 | 60 | composite | 0.2236 | 0.2500 | 5,032 | 0.027% | 211.300 | 19,005,321 | 1.112e-05 | 1.0324 |
| 43 | 62 | composite | 0.2889 | 0.2500 | 6,497 | 0.035% | 211.550 | 19,011,818 | 1.113e-05 | 1.0333 |
| 44 | 63 | composite | 0.2675 | 0.3500 | 8,415 | 0.045% | 211.900 | 19,020,232 | 1.114e-05 | 1.0346 |
| 45 | 64 | composite | 0.2330 | 0.2500 | 5,229 | 0.028% | 212.150 | 19,025,462 | 1.115e-05 | 1.0355 |
| 46 | 65 | composite | 0.3204 | 0.2500 | 7,184 | 0.039% | 212.400 | 19,032,645 | 1.116e-05 | 1.0363 |
| 47 | 66 | composite | 0.4385 | 0.2500 | 9,824 | 0.053% | 212.650 | 19,042,469 | 1.117e-05 | 1.0370 |
| 48 | 68 | composite | 0.2017 | 0.2500 | 4,515 | 0.024% | 212.900 | 19,046,984 | 1.118e-05 | 1.0380 |
| 49 | 69 | composite | 0.2880 | 0.3500 | 9,019 | 0.049% | 213.250 | 19,056,003 | 1.119e-05 | 1.0392 |
| 50 | 70 | composite | 0.3109 | 0.2500 | 6,946 | 0.037% | 213.500 | 19,062,950 | 1.120e-05 | 1.0400 |
| 51 | 72 | composite | 0.2514 | 0.2500 | 5,613 | 0.030% | 213.750 | 19,068,562 | 1.121e-05 | 1.0409 |
| 52 | 74 | composite | 0.2231 | 0.2500 | 4,976 | 0.027% | 214.000 | 19,073,539 | 1.122e-05 | 1.0419 |
| 53 | 75 | composite | 0.2015 | 0.2500 | 4,490 | 0.024% | 214.250 | 19,078,028 | 1.123e-05 | 1.0429 |
| 54 | 76 | composite | 0.1997 | 0.2500 | 4,446 | 0.024% | 214.500 | 19,082,475 | 1.124e-05 | 1.0438 |
| 55 | 77 | composite | 0.3141 | 0.2500 | 6,986 | 0.038% | 214.750 | 19,089,461 | 1.125e-05 | 1.0447 |
| 56 | 78 | composite | 0.2201 | 0.2500 | 4,891 | 0.026% | 215.000 | 19,094,352 | 1.126e-05 | 1.0456 |
| 57 | 80 | composite | 0.1978 | 0.2500 | 4,392 | 0.024% | 215.250 | 19,098,744 | 1.127e-05 | 1.0466 |
| 58 | 81 | composite | 0.2318 | 0.2500 | 5,142 | 0.028% | 215.500 | 19,103,886 | 1.128e-05 | 1.0475 |
| 59 | 82 | composite | 0.2335 | 0.2500 | 5,174 | 0.028% | 215.750 | 19,109,060 | 1.129e-05 | 1.0485 |
| 60 | 84 | composite | 0.6497 | 0.2500 | 14,386 | 0.077% | 216.000 | 19,123,446 | 1.130e-05 | 1.0489 |
| 61 | 85 | composite | 0.2717 | 0.2500 | 6,013 | 0.032% | 216.250 | 19,129,459 | 1.130e-05 | 1.0498 |
| 62 | 86 | composite | 0.1990 | 0.2500 | 4,400 | 0.024% | 216.500 | 19,133,859 | 1.132e-05 | 1.0507 |
| 63 | 87 | composite | 0.2356 | 0.2500 | 5,206 | 0.028% | 216.750 | 19,139,065 | 1.133e-05 | 1.0517 |
| 64 | 88 | composite | 0.2080 | 0.2500 | 4,592 | 0.025% | 217.000 | 19,143,656 | 1.134e-05 | 1.0526 |
| 65 | 90 | composite | 0.2043 | 0.2500 | 4,505 | 0.024% | 217.250 | 19,148,161 | 1.135e-05 | 1.0536 |
| 66 | 91 | composite | 0.2618 | 0.2500 | 5,769 | 0.031% | 217.500 | 19,153,930 | 1.136e-05 | 1.0545 |
| 67 | 92 | composite | 0.1988 | 0.2500 | 4,378 | 0.024% | 217.750 | 19,158,308 | 1.137e-05 | 1.0554 |
| 68 | 93 | composite | 0.2014 | 0.2500 | 4,429 | 0.024% | 218.000 | 19,162,737 | 1.138e-05 | 1.0564 |
| 69 | 94 | composite | 0.2000 | 0.2500 | 4,395 | 0.024% | 218.250 | 19,167,132 | 1.139e-05 | 1.0574 |
| 70 | 95 | composite | 0.2022 | 0.2500 | 4,440 | 0.024% | 218.500 | 19,171,572 | 1.140e-05 | 1.0584 |
| 71 | 96 | composite | 0.2833 | 0.2500 | 6,214 | 0.033% | 218.750 | 19,177,786 | 1.141e-05 | 1.0592 |
| 72 | 98 | composite | 0.1990 | 0.2500 | 4,361 | 0.023% | 219.000 | 19,182,147 | 1.142e-05 | 1.0602 |
| 73 | 99 | composite | 0.3496 | 0.2500 | 7,655 | 0.041% | 219.250 | 19,189,802 | 1.143e-05 | 1.0610 |
| 74 | 100 | composite | 0.3304 | 0.2500 | 7,230 | 0.039% | 219.500 | 19,197,032 | 1.143e-05 | 1.0618 |
| 75 | 102 | composite | 0.3152 | 0.2500 | 6,891 | 0.037% | 219.750 | 19,203,923 | 1.144e-05 | 1.0626 |
| 76 | 104 | composite | 0.2918 | 0.2500 | 6,376 | 0.034% | 220.000 | 19,210,298 | 1.145e-05 | 1.0635 |
| 77 | 105 | composite | 0.3549 | 0.2500 | 7,748 | 0.042% | 220.250 | 19,218,046 | 1.146e-05 | 1.0642 |
| 78 | 106 | composite | 0.3933 | 0.2500 | 8,579 | 0.046% | 220.500 | 19,226,625 | 1.147e-05 | 1.0650 |
| 79 | 108 | composite | 0.1974 | 0.2500 | 4,302 | 0.023% | 220.750 | 19,230,927 | 1.148e-05 | 1.0660 |
| 80 | 110 | composite | 0.4042 | 0.2500 | 8,803 | 0.047% | 221.000 | 19,239,730 | 1.149e-05 | 1.0667 |
| 81 | 111 | composite | 0.2921 | 0.2500 | 6,358 | 0.034% | 221.250 | 19,246,088 | 1.150e-05 | 1.0675 |
| 82 | 112 | composite | 0.2027 | 0.2500 | 4,409 | 0.024% | 221.500 | 19,250,497 | 1.151e-05 | 1.0685 |
| 83 | 114 | composite | 0.1997 | 0.2500 | 4,340 | 0.023% | 221.750 | 19,254,837 | 1.152e-05 | 1.0694 |
| 84 | 115 | composite | 0.1971 | 0.2500 | 4,280 | 0.023% | 222.000 | 19,259,117 | 1.153e-05 | 1.0704 |
| 85 | 116 | composite | 0.2004 | 0.2500 | 4,345 | 0.023% | 222.250 | 19,263,462 | 1.154e-05 | 1.0714 |
| 86 | 117 | composite | 0.2610 | 0.2500 | 5,656 | 0.030% | 222.500 | 19,269,118 | 1.155e-05 | 1.0723 |
| 87 | 118 | composite | 0.3690 | 0.2500 | 7,990 | 0.043% | 222.750 | 19,277,108 | 1.156e-05 | 1.0730 |
| 88 | 119 | composite | 0.9348 | 0.2500 | 20,225 | 0.109% | 223.000 | 19,297,333 | 1.156e-05 | 1.0731 |
| 89 | 120 | composite | 0.1968 | 0.2500 | 4,258 | 0.023% | 223.250 | 19,301,590 | 1.157e-05 | 1.0741 |
| 90 | 121 | composite | 0.5488 | 0.3500 | 16,607 | 0.089% | 223.600 | 19,318,198 | 1.157e-05 | 1.0748 |
| 91 | 122 | composite | 0.2135 | 0.2500 | 4,611 | 0.025% | 223.850 | 19,322,808 | 1.158e-05 | 1.0758 |
| 92 | 123 | composite | 0.3547 | 0.2500 | 7,655 | 0.041% | 224.100 | 19,330,464 | 1.159e-05 | 1.0766 |
| 93 | 124 | composite | 0.6400 | 0.3500 | 19,323 | 0.104% | 224.450 | 19,349,786 | 1.160e-05 | 1.0772 |
| 94 | 125 | composite | 0.1991 | 0.2500 | 4,291 | 0.023% | 224.700 | 19,354,077 | 1.161e-05 | 1.0781 |
| 95 | 126 | composite | 0.2150 | 0.2500 | 4,630 | 0.025% | 224.950 | 19,358,707 | 1.162e-05 | 1.0791 |
| 96 | 128 | composite | 0.4246 | 0.3500 | 12,789 | 0.069% | 225.300 | 19,371,496 | 1.163e-05 | 1.0800 |
| 97 | 129 | composite | 0.2552 | 0.2500 | 5,487 | 0.030% | 225.550 | 19,376,983 | 1.164e-05 | 1.0809 |
| 98 | 130 | composite | 0.9347 | 0.2500 | 20,076 | 0.108% | 225.800 | 19,397,059 | 1.164e-05 | 1.0810 |
| 99 | 132 | composite | 0.1968 | 0.2500 | 4,226 | 0.023% | 226.050 | 19,401,285 | 1.165e-05 | 1.0820 |
| 100 | 133 | composite | 0.4894 | 0.2500 | 10,501 | 0.057% | 226.300 | 19,411,786 | 1.166e-05 | 1.0826 |

## Regenerating this file

`cd sim && python scripts/run_phase1.py`. It is written by the same pass that
writes `shared/params.json`, from the same run, so the two can never disagree.

