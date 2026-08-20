# ema_cross gate frequency audit — ETH, Hyperliquid testnet

Read-only measurement. No code, policy value, or running mission was touched.
Reproduction script: `scratch/ema-cross-audit.ts` (plus `scratch/fetch-candles.ts`,
`scratch/supplement.ts`, `scratch/verify-against-repo.ts`). `scratch/` is excluded
via `.git/info/exclude` — a local-only exclusion, not a repo change.

## The question

A live 5m ETH mission trading `ema_cross` saw three EMA crosses in its first
2h10m, all with fast/slow separation of 0.09–0.11 ATR, every one below the
0.15 ATR gate, so none opened a trade. Is that bad luck or the norm? And if
the gate does open, does the resulting signal clear the cost line the soak
measured?

## Data span and gaps

| Interval | From (UTC)       | To (UTC)         | Bars | Gaps                                                          |
| -------- | ---------------- | ---------------- | ---- | ------------------------------------------------------------- |
| 5m       | 2026-08-03T01:05 | 2026-08-19T01:05 | 4609 | none — every consecutive timestamp is exactly 300000 ms apart |
| 1m       | 2026-08-15T10:45 | 2026-08-19T01:07 | 5183 | none — every consecutive timestamp is exactly 60000 ms apart  |

Source: `POST https://api.hyperliquid-testnet.xyz/info`, `{"type":"candleSnapshot",
"req":{"coin":"ETH","interval":…}}`, paginated and de-duplicated by open time.

**The 1m span is 3.5 days, not 14.** This is a hard limit of the endpoint, not a
pagination bug: testnet retains roughly the last 5000 candles per interval, and an
explicit probe for a 1m window 13–14 days back returns `[]`. The 5m series at 16
days is 4609 bars, inside that retention, so it is complete. The 1m table below is
therefore a 3.5-day sample and carries correspondingly wider error bars; it is
adequate for the frequency comparison in step 4 and should not be read as a
14-day-equivalent measurement.

The first 119 bars of each series are consumed as EMA/ATR warmup (the repo's
120-bar `MARKET_STRUCTURE_LOOKBACK_BARS`), leaving **15.59 measured days on 5m**
and **3.52 on 1m**.

## Constants read from the repo

| Constant                                            | Value | Source                                                                        |
| --------------------------------------------------- | ----- | ----------------------------------------------------------------------------- |
| `EMA_FAST_PERIOD`                                   | 9     | [marketStructure.ts:89](packages/trading-contracts/src/marketStructure.ts:89) |
| `EMA_SLOW_PERIOD`                                   | 21    | [marketStructure.ts:90](packages/trading-contracts/src/marketStructure.ts:90) |
| `ATR_LEG_BARS` (the ATR period used with the cross) | 14    | [marketStructure.ts:35](packages/trading-contracts/src/marketStructure.ts:35) |
| `MARKET_STRUCTURE_LOOKBACK_BARS`                    | 120   | [marketStructure.ts:32](packages/trading-contracts/src/marketStructure.ts:32) |
| `emaCross.maxCrossAgeBars`                          | 5     | [policy.ts:201](packages/trading-contracts/src/policy.ts:201)                 |
| `emaCross.minSpreadAtrRatio`                        | 0.15  | [policy.ts:202](packages/trading-contracts/src/policy.ts:202)                 |
| `emaCross.targetAtrMultiple`                        | 3     | [policy.ts:203](packages/trading-contracts/src/policy.ts:203)                 |

### Formulas, matched to the repo

**EMA** — `exponentialMovingAverage`,
[marketStructure.ts:681-694](packages/trading-contracts/src/marketStructure.ts:681).
Seeded with the simple mean of the first `period` closes, then
`avg += (value - avg) * 2/(period+1)` for every later close. The 9- and 21-series
are aligned on their shared tail, so `spread = fast[last] - slow[last]` pairs the
two EMAs of the same bar (`readEmaTrend`,
[marketStructure.ts:702-744](packages/trading-contracts/src/marketStructure.ts:702)).

**True range / ATR** — `trueRanges`,
[marketStructure.ts:810-825](packages/trading-contracts/src/marketStructure.ts:810):
`max(high-low, |high-prevClose|, |low-prevClose|)`. ATR is the **plain arithmetic
mean of the last 14 true ranges**, not Wilder smoothing —
[marketStructure.ts:1154-1155](packages/trading-contracts/src/marketStructure.ts:1154).

**Separation** — `|spread| / atrUsd`, matching `separationAtr` in
[marketStructure.ts:741](packages/trading-contracts/src/marketStructure.ts:741).

**Windowing** — every read is taken over a rolling trailing 120-bar window, which
is what the harness hands the reader, so the EMA seed advances with the mission
exactly as it does live.

**Verification.** `scratch/verify-against-repo.ts` imports the repo's own
`readEmaTrend` and `analyseTimeframe` and compares them to this script's spread,
ATR, and `separationAtr` across 33 sampled 120-bar windows of the real data. Worst
absolute difference on all three: **0 (exact bit-for-bit match)**.

## 1. Cross frequency

A cross is any bar where the sign of `fast - slow` flips against the previous bar.

| Interval | Measured days | Crosses | Crosses/day |
| -------- | ------------- | ------- | ----------- |
| 5m       | 15.59         | 227     | **14.6**    |
| 1m       | 3.52          | 249     | **70.8**    |

## 2. Separation reached within `maxCrossAgeBars`

For each cross, the maximum `|spread| / ATR` reached from the cross bar through
`maxCrossAgeBars` bars later, using the ATR **at the cross bar**. If the spread
flips back before the gate opens, that cross's window ends there.

| Interval | Age bars | Median | p75   | p90   | ≥ 0.15 ATR in time  | Gate-passers/day |
| -------- | -------- | ------ | ----- | ----- | ------------------- | ---------------- |
| 5m       | 5        | 0.265  | 0.509 | 0.938 | 153/227 = **67.4%** | **9.82**         |
| 1m       | 5        | 0.271  | 0.604 | 0.954 | 164/249 = **65.9%** | **46.6**         |

Crosses whose max separation lands in the mission's observed 0.09–0.11 ATR band:
**9 of 227 on 5m (4.0%)**.

## 3. Outcome and cost, 5m baseline (gate 0.15, age 5, target 3.0 ATR)

From the first gate-passing bar's close, which terminus comes first: `+3.0 ATR`
in the cross direction, or `-1.0 ATR` against. A bar touching both is resolved
pessimistically as the stop.

| Measure                                               | Value               |
| ----------------------------------------------------- | ------------------- |
| Gate-passing signals                                  | 153 over 15.59 days |
| Reached +3.0 ATR before -1.0 ATR                      | 42 = **27.5%**      |
| Mean gross move at first terminus                     | **+0.44 bps**       |
| Median gross move at first terminus                   | **-9.2 bps**        |
| Net positive under live costs (12.3 + 4.5 = 16.8 bps) | 39/153 = **25.5%**  |
| Net positive under best case (1.5 + 1.5 = 3.0 bps)    | 42/153 = **27.5%**  |
| Mean net per signal, live costs                       | **-16.36 bps**      |
| Mean net per signal, best case                        | **-2.56 bps**       |
| Sum of net across all 153 signals, live costs         | **-2503 bps**       |

The `net positive` count is effectively the target-hit count: at a 3:1 reward:risk
the two termini are ±3.0 and -1.0 ATR, both far outside the 16.8 bps cost line, so
costs change which signals net positive only at the margin (3 of 153) while
shifting the mean expectancy by the full cost.

## 4. 1m comparison (gate 0.15, age 5, target 3.0 ATR)

| Measure                                | 5m    | 1m       |
| -------------------------------------- | ----- | -------- |
| Crosses/day                            | 14.6  | 70.8     |
| Fraction reaching ≥ 0.15 ATR in 5 bars | 67.4% | 65.9%    |
| Gate-passers/day                       | 9.82  | 46.6     |
| Target hit rate                        | 27.5% | 28.0%    |
| Mean gross bps at first terminus       | +0.44 | +0.72    |
| Median gross bps                       | -9.2  | -2.3     |
| Net positive, live costs (16.8 bps)    | 25.5% | **1.8%** |
| Net positive, best case (3.0 bps)      | 27.5% | 27.4%    |

The gate-open _fraction_ is essentially identical on the two timeframes (67.4% vs
65.9%). What differs is the size of the move each signal is playing for: the 1m
ATR is small enough that a full 3.0-ATR win is often worth less than the 16.8 bps
live cost line, which is why 1m's net-positive fraction collapses from 27.4% (best
case) to 1.8% (live costs) while 5m barely moves (27.5% → 25.5%). Caveat: the 1m
row is measured over 3.5 days, not 15.6.

## 5. Sensitivity table (measurement only, not a recommendation)

5m:

| Gate (ATR) | Age (bars) | Passers | Pass %    | Passers/day | Hit rate  | Mean gross bps | Net+ live | Net+ best |
| ---------- | ---------- | ------- | --------- | ----------- | --------- | -------------- | --------- | --------- |
| 0.10       | 5          | 178     | 78.4%     | 11.42       | 24.2%     | -1.2           | 21.3%     | 24.2%     |
| **0.15**   | **5**      | **153** | **67.4%** | **9.82**    | **27.5%** | **+0.4**       | **25.5%** | **27.5%** |
| 0.20       | 5          | 140     | 61.7%     | 8.98        | 24.3%     | -1.5           | 22.1%     | 24.3%     |
| 0.10       | 8          | 181     | 79.7%     | 11.61       | 24.3%     | -1.2           | 21.5%     | 24.3%     |
| 0.15       | 8          | 157     | 69.2%     | 10.07       | 28.0%     | +0.7           | 26.1%     | 28.0%     |
| 0.20       | 8          | 149     | 65.6%     | 9.56        | 24.8%     | -1.3           | 22.8%     | 24.8%     |

At age 8 the separation distribution shifts up as expected (median 0.265 → 0.311,
p90 0.938 → 1.118), adding ~4 gate-passers over 15.6 days at the 0.15 gate.

1m:

| Gate (ATR) | Age (bars) | Passers | Pass %    | Passers/day | Hit rate  | Mean gross bps | Net+ live | Net+ best |
| ---------- | ---------- | ------- | --------- | ----------- | --------- | -------------- | --------- | --------- |
| 0.10       | 5          | 182     | 73.1%     | 51.76       | 27.5%     | +0.7           | 1.6%      | 26.9%     |
| **0.15**   | **5**      | **164** | **65.9%** | **46.64**   | **28.0%** | **+0.7**       | **1.8%**  | **27.4%** |
| 0.20       | 5          | 147     | 59.0%     | 41.81       | 25.9%     | +0.4           | 0.7%      | 25.2%     |
| 0.10       | 8          | 183     | 73.5%     | 52.05       | 27.3%     | +0.7           | 1.6%      | 26.8%     |
| 0.15       | 8          | 169     | 67.9%     | 48.07       | 27.8%     | +0.6           | 1.8%      | 27.2%     |
| 0.20       | 8          | 157     | 63.1%     | 44.65       | 25.5%     | +0.3           | 0.7%      | 24.8%     |

## Conclusion (factual, scoped)

**How many tradable-under-the-gate signals per day exist on 5m.** Under the
shipped constants (0.15 ATR, 5 bars), 14.6 crosses per day produce **9.8
gate-passing signals per day** over 15.6 gap-free days. Gate-open frequency is not
the binding constraint on this playbook: two thirds of crosses clear 0.15 ATR
within five bars, and the median cross reaches 0.265 ATR — 1.8× the gate.

**Is the live mission's 3-for-3 sub-gate observation typical?** No. The
per-cross failure rate is 32.6%, so three independent failures would be ~3.5%.
Measured directly on rolling 26-bar (2h10m) windows of the same data: **39 of the
445 windows containing exactly three crosses had all three fail the gate — 8.8%**.
Separation landing specifically in the 0.09–0.11 ATR band is rarer still: 9 of 227
crosses, 4.0%. The mission's first 2h10m was an unrepresentative stretch, not the
norm; the cross _rate_ it saw (3 in 2h10m ≈ 33/day) was also more than double the
15.6-day average of 14.6/day, consistent with a locally choppy, low-trend window
where crosses are frequent and separation is small.

**Did gate-passing signals clear observed costs historically?** Not on average.
On 5m, 27.5% of the 153 gate-passing signals reached +3.0 ATR before -1.0 ATR.
Mean gross move at the first terminus was **+0.44 bps** — essentially flat before
costs. Subtracting the soak-measured 16.8 bps round trip gives a mean of
**-16.36 bps per signal** and **-2503 bps summed across all 153 signals**. Under
the best-case maker round trip of 3.0 bps the mean is still negative at
**-2.56 bps**. The 27.5% hit rate is the direct cause: a 3:1 reward:risk needs
above 25% to break even gross, and 27.5% clears that by too little to survive
either cost line. On 1m the same signals fail far harder against live costs (1.8%
net positive vs 27.4% best case), because the per-signal move is small relative to
the fixed cost line.

No policy recommendation is made here, and no values were changed. This is input
to the versioned-policy decision that happens elsewhere.

---

# Part 2 — exit sweep

Read-only, same rules as Part 1. Reproduction: `scratch/exit-sweep.ts`
(standard errors: `scratch/exit-sweep-se.ts`).

## Why

Part 1 measured a single exit rule — first to +3.0 ATR or -1.0 ATR — and found
mean gross **+0.44 bps/signal**, statistically indistinguishable from the 25%
break-even of a 3:1 payoff. That result indicts one exit rule, not the playbook.
Part 2 holds the entry set completely fixed and varies only the exit, to find
whether _any_ plausible exit structure extracts more gross from the same signals.

## Method

**Entries are identical to Part 1** — the same 153 gate-passing 5m signals
(0.15 ATR separation gate, 5-bar max cross age, over the same gap-free 15.59
measured days), entering at the close of the first gate-passing bar. The signal
set is rebuilt by the same code path and comes out at n = 153, matching Part 1
exactly. EMA/ATR/spread are the bit-for-bit repo replication verified in Part 1.

**Intrabar rule, stated conservatively.** When a single bar's range spans both
the favourable level and the adverse level, the **adverse level is counted
first** — the bar is scored as a loss. The same ordering applies when a trailing
giveback and the hard stop fall inside one bar: the hard stop wins. Five-minute
bars cannot say which level was touched first, so every ambiguous bar is
resolved against the trade. This biases every cell below downward by an unknown
but equal-in-spirit amount; it does not favour one exit rule over another.

All 153 signals resolve inside the data under every rule — **zero unresolved
positions**, so no cell depends on the mark-to-last-close fallback.

## Cost scenarios (per round trip)

| Scenario          | Cost         | Basis                                                                                                                                                                                                                                                                    |
| ----------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| (a) maker/maker   | **3.0 bps**  | 1.5 bps maker entry + 1.5 bps maker exit — best case                                                                                                                                                                                                                     |
| (b) observed live | **16.8 bps** | 12.3 bps escalated entry (7.8 escalation drift + 4.5 taker) + 4.5 bps taker exit, as measured in the soak                                                                                                                                                                |
| (c) blended       | **11.4 bps** | **assumption, not a measurement**: entry escalates with probability 0.5 (12.3 bps) else maker (1.5 bps), plus 4.5 bps taker exit. The 0.5 escalation rate is a placeholder pending the soak's actual escalation tally; if the true rate is higher, (c) moves toward (b). |

## The grid

n = 153 signals for every row. Gross = mean gross bps per signal at the exit.
Hit rate = fraction exiting above entry. Hold = mean bars held. Net columns are
gross minus the scenario's round-trip cost.

| Family   | Exit rule                        | Gross bps | Hit rate  | Hold (bars) | Net (a) 3.0 | Net (b) 16.8 | Net (c) 11.4 |
| -------- | -------------------------------- | --------- | --------- | ----------- | ----------- | ------------ | ------------ |
| Fixed    | 1.5 / 1 ATR                      | -0.89     | 37.9%     | 5.0         | -3.89       | -17.69       | -12.29       |
| Fixed    | 2 / 1 ATR                        | -0.92     | 31.4%     | 6.1         | -3.92       | -17.72       | -12.32       |
| Fixed    | **3 / 1 ATR** (Part 1 reference) | **+0.44** | 27.5%     | 7.7         | **-2.56**   | **-16.36**   | **-10.96**   |
| Fixed    | 4 / 1.5 ATR                      | -1.58     | 26.1%     | 14.4        | -4.58       | -18.38       | -12.98       |
| Fixed    | 2 / 0.75 ATR                     | -0.89     | 25.5%     | 4.5         | -3.89       | -17.69       | -12.29       |
| Trailing | **arm 0.5 / give 0.50 ATR**      | **+0.17** | **53.6%** | 3.1         | -2.83       | -16.63       | -11.23       |
| Trailing | arm 0.5 / give 0.75 ATR          | -0.42     | 43.8%     | 3.4         | -3.42       | -17.22       | -11.82       |
| Trailing | arm 1.0 / give 0.50 ATR          | -0.43     | 42.5%     | 4.3         | -3.43       | -17.23       | -11.83       |
| Trailing | arm 1.0 / give 0.75 ATR          | -0.75     | 42.5%     | 4.5         | -3.75       | -17.55       | -12.15       |
| Time     | close of bar 3                   | -1.45     | 41.2%     | 2.5         | -4.45       | -18.25       | -12.85       |
| Time     | close of bar 6                   | -2.09     | 34.0%     | 4.3         | -5.09       | -18.89       | -13.49       |
| Time     | close of bar 12                  | -1.64     | 28.1%     | 6.7         | -4.64       | -18.44       | -13.04       |

**Best cell per scenario** — the same cell wins all three, because the cost is a
constant subtracted from every row and does not reorder them:

| Scenario                        | Best cell     | Net bps/signal |
| ------------------------------- | ------------- | -------------- |
| (a) maker/maker, 3.0 bps        | fixed 3/1 ATR | **-2.56**      |
| (b) observed live, 16.8 bps     | fixed 3/1 ATR | **-16.36**     |
| (c) blended, 11.4 bps (assumed) | fixed 3/1 ATR | **-10.96**     |

Only two of the twelve rules produce positive gross at all, and neither is
distinguishable from zero:

| Rule                         | Mean gross bps | SD    | SE   | t        |
| ---------------------------- | -------------- | ----- | ---- | -------- |
| fixed 3/1 ATR                | +0.44          | 23.02 | 1.86 | **0.24** |
| trailing arm 0.5 / give 0.50 | +0.17          | 16.99 | 1.37 | **0.12** |

Both t-statistics are far below any conventional threshold. The trailing rule
raises the hit rate dramatically (27.5% → 53.6%) and cuts the hold to 3.1 bars,
but it trims the winners by exactly as much as it saves on the losers: gross
stays at zero while dispersion falls (SD 23.0 → 17.0). That is a rule which
changes the shape of the distribution without moving its mean.

## Mandatory caveat

**This is a grid search over twelve exit rules on 153 in-sample signals.** The
twelve cells are evaluated on the same data used to select the winner, so the
best cell's apparent edge is optimistically biased by construction — with twelve
draws from a distribution centred near zero, the maximum is positive by chance
alone even when no rule has real edge. The reported +0.44 bps is a _maximum over
a grid_, not an unbiased estimate of that rule's forward performance; its
unbiased expectation is lower than the number in the table. No cell here may be
used to justify a policy change without forward validation on out-of-sample
signals — that is what the running soak is for. The `n=153` sample also spans a
single 15.6-day regime on a single asset on testnet, and the conservative
intrabar tie-break pushes every cell downward by an unmeasured amount.

## Conclusion

**No exit rule in the grid clears zero under scenario (b), and none clears zero
under scenario (a) either** — the best cell in both is fixed 3/1 ATR at
-16.36 bps and -2.56 bps per signal respectively, and the two rules with
positive gross (+0.44 and +0.17 bps) are statistically indistinguishable from
zero (t = 0.24 and 0.12) before any cost is applied at all.

---

# Part 3 — regime filters

Read-only, same rules as Parts 1-2. Reproduction: `scratch/regime-filters.ts`.

## Why

Parts 1-2 showed the gate-passing cross has no gross edge under any of twelve
exit rules — unconditionally, the entry is indistinguishable from random. This
part tests the remaining possibility: that some measurable regime condition
selects a _subset_ of those crosses that does carry edge. It is the deciding
measurement. If no filter helps, the retire-vs-respec choice collapses.

## Method

The same **153 gate-passing 5m signals** as Parts 1-2, the same Part 1 exit
(+3.0 ATR target, -1.0 ATR stop, **adverse level counted first** when one bar
spans both), over the same gap-free 15.59 measured days. Nothing about entry or
exit changes; only the subset of signals scored changes. Every feature is
measured at the signal's own entry bar, from the same rolling 120-bar window the
live reader is handed, using the repo's EMA seeding, `2/(period+1)` multiplier,
true-range definition and plain-mean ATR(14) — the replication verified
bit-for-bit in Part 1.

| Filter | Definition, at the entry bar                                                                    |
| ------ | ----------------------------------------------------------------------------------------------- |
| F1     | Sign of `slowEMA(now) - slowEMA(6 bars ago)` agrees with cross direction                        |
| F2     | `ATR(14) now / ATR(14) 12 bars ago`: expanding > 1.1, contracting < 0.9, else flat              |
| F3     | Separation at gate-pass minus separation at the cross bar, split at its own median (0.1490 ATR) |
| F4     | Price on the cross-direction side of a 50-bar EMA                                               |
| F5     | The previous gate-passing signal **on the same side** won or lost                               |

The EMA50 in F4 is a long-trend proxy built with the repo's own
`exponentialMovingAverage`; the repo itself defines only the 9/21 pair, so F4 is
an added measurement, not a repo constant.

## Statistical bar, stated up front

**14 filter cells are tested on n = 153.** At a family-wise α = 0.05, the
Bonferroni-adjusted per-cell threshold is α = 0.05/14 = **0.0036**, which on
df ≈ 152 is a two-sided **|t| ≥ 2.97**. A cell counts as "edge found" only if it
clears |t| ≥ 2.97 **and** carries the same sign in both halves of the 15.59-day
span. Cells with **n < 30 are labelled anecdote** and cannot count regardless of
their t. Every cell is reported below, losers included.

## The grid

Split-half columns are mean gross bps in the first and second 7.8 days.

| Filter cell                     | n   | /day | Hit rate | Gross bps | t        | Net maker 3.0 | Net blended 11.4 | H1 gross (n) | H2 gross (n) |
| ------------------------------- | --- | ---- | -------- | --------- | -------- | ------------- | ---------------- | ------------ | ------------ |
| ALL (Part 1 baseline)           | 153 | 9.82 | 27.5%    | +0.44     | 0.24     | -2.56         | -10.96           | -1.6 (77)    | +2.5 (76)    |
| F1 slope agrees                 | 149 | 9.56 | 28.2%    | +0.81     | 0.43     | -2.19         | -10.59           | -1.0 (74)    | +2.6 (75)    |
| F1 slope disagrees — _anecdote_ | 4   | 0.26 | 0.0%     | -13.38    | -4.33    | -16.38        | -24.78           | -15.4 (3)    | -7.2 (1)     |
| F2 ATR expanding                | 60  | 3.85 | 26.7%    | -0.16     | -0.05    | -3.16         | -11.56           | -6.5 (27)    | +5.1 (33)    |
| F2 ATR flat                     | 38  | 2.44 | 26.3%    | -1.05     | -0.33    | -4.05         | -12.45           | -0.0 (24)    | -2.8 (14)    |
| F2 ATR contracting              | 55  | 3.53 | 29.1%    | **+2.12** | 0.65     | -0.88         | -9.28            | +2.2 (26)    | +2.1 (29)    |
| F3 momentum top half            | 77  | 4.94 | 29.9%    | **+2.23** | **0.77** | -0.77         | -9.17            | -1.4 (39)    | +6.0 (38)    |
| F3 momentum bottom half         | 76  | 4.88 | 25.0%    | -1.38     | -0.60    | -4.38         | -12.78           | -1.7 (38)    | -1.1 (38)    |
| F4 price on cross side of EMA50 | 145 | 9.30 | 27.6%    | +0.25     | 0.14     | -2.75         | -11.15           | -1.4 (76)    | +2.1 (69)    |
| F4 price against — _anecdote_   | 8   | 0.51 | 25.0%    | +3.78     | 0.34     | +0.78         | -7.62            | -9.7 (1)     | +5.7 (7)     |
| F5 prior same-side won          | 42  | 2.69 | 28.6%    | **+2.62** | 0.59     | -0.38         | -8.78            | +3.6 (18)    | +1.9 (24)    |
| F5 prior same-side lost         | 109 | 6.99 | 27.5%    | -0.19     | -0.09    | -3.19         | -11.59           | -2.8 (57)    | +2.7 (52)    |
| F1 AND F4                       | 141 | 9.05 | 28.4%    | +0.64     | 0.33     | -2.36         | -10.76           | -0.9 (73)    | +2.3 (68)    |
| F1 AND F2 expanding             | 59  | 3.79 | 27.1%    | +0.04     | 0.01     | -2.96         | -11.36           | -6.3 (26)    | +5.1 (33)    |
| F4 AND F2 expanding             | 57  | 3.66 | 26.3%    | -0.98     | -0.33    | -3.98         | -12.38           | -6.4 (26)    | +3.6 (31)    |

## What clears the bar

**Nothing.** Against the |t| ≥ 2.97 adjusted threshold:

- The largest positive t in the whole grid is **0.77** (F3 momentum top half) —
  roughly a quarter of the bar. Every other positive cell is below 0.65.
- The only cell whose |t| clears 2.97 is **F1 slope disagrees at t = -4.33**, and
  it fails on two counts: **n = 4 is anecdote**, and its sign is _negative_ —
  it identifies a handful of bad signals, not a tradable subset. With 4
  observations a t of that size carries no information about the population.
- The three least-bad positive cells fail on split-half sign too, or on cost:
  - F3 momentum top half (best t) **flips sign across the halves**: -1.4 then
    +6.0. The entire apparent edge sits in the second 7.8 days.
  - F2 ATR contracting (+2.12) and F5 prior-won (+2.62) _are_ sign-consistent
    across halves, but at t = 0.65 and 0.59 they are indistinguishable from
    zero, and neither gross even clears the 3.0 bps maker/maker cost line —
    let alone the 11.4 bps blended one.
- **No cell in the grid nets positive under the blended 11.4 bps scenario.**
  Exactly one nets positive under maker/maker: F4 price-against-EMA50 at
  +0.78 bps net — on **n = 8, an anecdote**, whose two halves are -9.7 and +5.7.

Note also that the frequency column does its job: the cells with the least-bad
gross are the sparse ones. F2 contracting fires 3.5 times/day and F5 prior-won
2.7 times/day, so even if their point estimates were real they would be
selecting against volume, not finding a better trade.

## Caveat

This is 14 hypotheses on one 15.6-day window, one asset, on testnet, sharing a
single 153-signal sample with Parts 1-2 — the same signals scored fourteen more
ways. With that many draws from a distribution centred at zero, the maximum is
positive by construction; the +2.23 and +2.62 cells are what a null grid of this
size is expected to produce. The split-half test is a weak check, not a proper
out-of-sample validation: each half holds ~76 signals and has correspondingly
wide error bars. The conservative intrabar tie-break from Part 2 applies to
every cell equally.

## Conclusion

**No regime filter tested selects a subset of gate-passing crosses with
measurable edge.** Not one of the 14 cells clears the Bonferroni-adjusted
|t| ≥ 2.97 bar on an n ≥ 30 sample; the best positive t in the grid is 0.77 and
it flips sign between the two halves of the span; the two sign-consistent
positive cells (+2.12 and +2.62 bps gross) sit at t ≈ 0.6 and do not clear even
the 3.0 bps maker/maker cost line. The one cell that clears the t bar is n = 4
and negative. Combined with Parts 1-2 — no edge unconditionally, no edge under
any of twelve exit rules — the measurement finds no conditioning variable that
rescues the entry.

That is the finding, not a failure of the search. No policy recommendation is
made here and no values were changed; this is input to the versioned-policy
decision that happens elsewhere.
