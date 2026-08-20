# Plan 38 — Progressive Disclosure

**Status:** design only. No code in this document. Written 2026-08-19 against
`main` @ `130889597`.

A next-generation trading toolkit built on one idea: **the runtime stops
pushing data at the model and starts advertising what it holds.** The wake
becomes a notification, not a briefing. Everything else is pulled by name, in
known sizes, or delivered as a trigger the server armed on the model's behalf.

---

## 0. Why — the measurements this rests on

Every number below is recomputed from `~/.t3/userdata/state.sqlite`, not
carried over from a prior plan. Method is in Appendix A.

### 0.1 The context is still one tool

All trading tool results ever recorded (`projection_thread_activities`,
`kind='tool.completed'`):

| tool               | calls | mean result chars |    max | total chars |     share |
| ------------------ | ----: | ----------------: | -----: | ----------: | --------: |
| `trading_look`     |   240 |            22,002 | 63,162 |   5,280,588 | **91.2%** |
| `trading_strategy` |    43 |             4,486 |  9,008 |     192,898 |      3.3% |
| `trading_plan`     |   171 |             1,212 |  2,076 |     207,261 |      3.6% |
| `trading_watch`    |   231 |               336 |    750 |      77,838 |      1.3% |
| `trading_enter`    |    22 |               827 |  1,163 |      18,206 |      0.3% |
| `trading_exit`     |    41 |               280 |    448 |      11,512 |      0.2% |
| `trading_journal`  |     1 |             1,219 |  1,219 |       1,219 |      0.0% |

Plan 35 measured `trading_look` at 85.3% of one mission's model-bound content.
Across the whole database it is **91.2% of all trading tool output**. On the
current build alone (§0.3, §0.4) it is **88.4%** of looks-plus-wakes combined —
122 looks × 15,355 chars against 142 wakes × 1,735. **Plan 35's cuts worked and
did not change the verdict: the read is still the context.**

### 0.2 What plan 35 actually bought

The candle re-encoding shipped and is measurable in the record:

| encoding                          | calls | mean bars | **chars per bar** |
| --------------------------------- | ----: | --------: | ----------------: |
| verbose `candles[]` (pre-plan-35) |    65 |        89 |           **135** |
| table `bars[]` (current)          |   121 |        54 |            **38** |

A 3.5× reduction on the single largest field. This is the pattern the whole
plan generalises: _the same information, addressed rather than echoed._

### 0.3 Where a current-build look actually goes

122 look calls on the post-plan-35 build. **Mean 15,355 chars.**

| section                     | present | mean when present |     share |
| --------------------------- | ------: | ----------------: | --------: |
| `structure`                 |     120 |             4,375 | **28.0%** |
| `mission`                   |     122 |             4,028 | **26.2%** |
| `candles`                   |     121 |             2,299 |     14.9% |
| `orderBook`                 |     122 |               898 |      5.8% |
| `higherTimeframeVolatility` |     121 |               680 |      4.4% |
| `volatility`                |     121 |               677 |      4.4% |
| `microstructure`            |     122 |               599 |      3.9% |
| `snapshot`                  |     122 |               454 |      3.0% |
| `account`                   |     120 |               248 |      1.6% |
| `position`                  |     120 |               180 |      1.2% |
| `levelHistory`              |      24 |               886 |      1.1% |
| `positionCosts`             |      20 |               900 |      1.0% |
| `trades`                    |      12 |             1,173 |      0.8% |
| **`indicators`**            | **105** |           **125** |  **0.7%** |
| `cost`                      |     102 |               101 |      0.6% |
| `resolvedMarket`            |     122 |                80 |      0.5% |
| `previousStructureRead`     |      24 |               111 |      0.1% |
| `openOrders`                |     120 |                46 |      0.3% |

Inside `mission` (mean 4,028): `watches` 2,860 · `mission` 1,613 · `strategy`
1,258 · `strategyHistory` 3,342 · `targetCalibration` 1,047 · `authority` 525.

Inside `structure` (mean 4,375): `timeframes` 2,372 · `candidates` 2,099 ·
`regime` 1,850 · `setups` 1,608 · `alignment` 213.

**The line that decides this plan:** `indicators` was requested on 105 of 122
calls and costs **125 characters**. The 2,299-char candle window it is derived
from was echoed alongside it. A server-computed derived value is ~18× cheaper
than the raw window, and the model _already prefers it when offered_.

### 0.4 The wake is nearly done

142 wakes on the current build. **Mean 1,735 chars**; flat 1,780 (n=134),
holding 1,882 (n=7), max 3,418. Nothing hits the 5,000 ceiling.

| field                                                             | present | mean |     share |
| ----------------------------------------------------------------- | ------: | ---: | --------: |
| `armedWatches`                                                    |     141 |  374 | **21.4%** |
| `pendingEvents`                                                   |     134 |  267 | **14.6%** |
| `strategyReview`                                                  |     112 |  287 | **13.1%** |
| `triggeringWatch`                                                 |     130 |  114 |      6.0% |
| `position`                                                        |     141 |  101 |      5.8% |
| `readFirst`                                                       |     141 |  100 |      5.7% |
| `costContext`                                                     |     112 |   99 |      4.5% |
| `plan`                                                            |     141 |   90 |      5.2% |
| `positionReview`                                                  |      29 |  259 |      3.1% |
| identity (`kind`/`missionId`/`harnessRunId`/`cause`/`occurredAt`) |     142 |  187 |     10.7% |
| `userMessage`                                                     |      10 |  368 |      1.5% |
| `misarmedEntryConditions`                                         |      14 |  239 |      1.4% |
| `unarmedEntryConditions`                                          |      22 |  161 |      1.4% |
| `workingEntry`                                                    |       5 |  154 |      0.3% |
| `positionCosts`                                                   |      29 |  118 |      1.4% |
| `prediction`                                                      |      32 |   85 |      1.1% |
| `wakeReason`                                                      |      81 |   28 |      1.0% |
| `market` + `markPrice`                                            |     141 |   30 |      1.7% |

**Conclusion.** The wake is 1.7k and the read is 15.4k. Plan 38 spends most of
its effort on the read and the trigger, and takes only the ~600 chars off the
wake that are genuinely prose the model does not act on.

---

## 1. Lean wakes

### 1.1 What a wake is for

A wake answers exactly one question: _does this need a decision now?_ It is not
a briefing, and every character in it that is not evidence for that question is
paid on every wake of every mission forever.

### 1.2 The payload

The lean wake carries **six** things and nothing else:

| #   | field                  | source                                           | budget | notes                                         |
| --- | ---------------------- | ------------------------------------------------ | -----: | --------------------------------------------- |
| 1   | identity               | run/mission ids, cause, occurredAt               |    187 | unchanged                                     |
| 2   | `position`             | reconciler snapshot                              |    101 | size, entry, uPnL, cumulative funding, margin |
| 3   | `workingOrders`        | working-order service                            |  ≤ 160 | one line per resting order; absent when none  |
| 4   | `triggered`            | the watch that fired **plus its observed value** |  ≤ 190 | see §1.4                                      |
| 5   | `cost`                 | `costContext` / `describePositionCostLine`       |     99 | one line, either state                        |
| 6   | `plan`                 | intent, phase, stop, target                      |     90 | the numbers only, never the prose             |
| —   | `fetch` pointer        | static                                           |   ≤ 90 | see §1.5                                      |
| —   | `market` + `markPrice` | snapshot                                         |     30 |                                               |

**Budget: 950 chars typical, 1,300 hard trim trigger.** `MAX_WAKEUP_CHARS`
stays 5,000 as the structural backstop — it is a guarantee, not a target, and
this plan does not touch it.

Measured today: 1,735 mean. Projected: ~950. **−45%.**

### 1.3 What moves out, and where it goes

| field removed             | mean chars | where it goes instead                                                                                                                                                                                                      |
| ------------------------- | ---------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `strategyReview`          |        287 | `trading_look({fetch:["plan"]})` — it is prose restating the playbook the model can read                                                                                                                                   |
| `positionReview`          |        259 | `fetch:["position_costs"]`                                                                                                                                                                                                 |
| `misarmedEntryConditions` |        239 | **deleted outright** — plan 34 F8 already found it describes a condition that stopped deciding anything once entry happened; it is already suppressed while holding, and while flat it duplicates `unarmedEntryConditions` |
| `unarmedEntryConditions`  |        161 | folded into `triggered` when it is the _reason_ for the wake; otherwise `fetch:["plan"]`                                                                                                                                   |
| `readFirst`               |        100 | replaced by the `fetch` pointer, which is the same instruction plus the menu key                                                                                                                                           |
| `prediction`              |         85 | `fetch:["plan"]` — the trigger already carries `predictionVersion`                                                                                                                                                         |
| `wakeReason`              |         28 | folded into `cause`                                                                                                                                                                                                        |
| `armedWatches` (shrink)   |  374 → 150 | one line per watch, capped at 4, newest first; the full set is `fetch:["watches"]`                                                                                                                                         |

The removals total ~1,380 chars _where present_; because several ride only
some wakes, the measured mean falls 1,735 → ~950. Net added: ~90 (the `fetch`
pointer). Retained
`workingOrders` grows the holding wake slightly and is worth it — plan 34
measured a 93% silent entry shortfall that a working-order line would have made
visible on the next wake.

### 1.4 `pendingEvents` is NOT deleted — it is folded

The brief lists the wake payload as "position, working orders, triggered
watches, cost line — and nothing else", which reads as dropping `pendingEvents`
(267 chars, 14.6%, the second-largest field).

**Do not drop it.** Plan 35 tested exactly this against the database and the
hypothesis failed: `pendingEvents` is not a restatement of `triggeringWatch` —
it carries the _observed value_ that the watch line rounds away or omits
entirely. The sample wake in Appendix B shows it: the watch line says
`price=1916 confirm=close interval=5m`, and only the pending event says the
bar actually closed at **1914.6** against a threshold of **1915.53**.

The design keeps the information and deletes the container: **the observed
value merges into the `triggered` line.** One line carrying `id`, the
condition, the observed value, and the threshold it crossed. Budget 190 chars,
replacing 114 (`triggeringWatch`) + 267 (`pendingEvents`) = 381. Saving 191
chars with no information lost.

Only the _tail_ beyond the triggering event is dropped (today `pendingEvents`
is capped at 3 and 134 of 142 wakes carried it, usually with one entry).
Anything the model needs beyond the firing event is `fetch:["events"]`.

### 1.5 The `fetch` pointer, and why the catalog is not on the wake

The brief specifies that "the wake ADVERTISES what is fetchable in one line
each". Taken literally with ~20 catalog items at ~45 chars, that is **~900
characters of static text on every wake** — which would be the single largest
field, larger than today's `armedWatches`, and would consume the entire budget
this section just freed.

This is the precise mistake plan 35 already fixed once: the `omitted` paragraph
and the mandate line were "208 identical characters on every wake, saying the
same thing twice". Re-adding 900 is a regression with a nicer name.

**The split that satisfies the intent without the cost:**

- **The static catalog lives in the tool description** (§2.2), which the
  provider pays for once per session, not once per wake.
- **A catalog call returns it in full with sizes** — `trading_look` with no
  `fetch` argument returns the menu itself (~450 chars), paid once per mission
  when the model wants to plan its budget.
- **The wake carries one line**, and only the _dynamic_ half: what is stale,
  what is newly available, and the reminder to pull before acting. Example:

  ```
  fetch: nothing here but the above — trading_look({fetch:[...]}) ; menu: trading_look({})
  ```

  90 chars, static. When the archive has something the mission has not seen —
  a funding print, a fresh structure read — the line names _that key only_:

  ```
  fetch: new since last turn: funding_stats, oi_premium ; menu: trading_look({})
  ```

The model therefore always knows the menu exists and how to get it, and never
pays for the menu on a wake it acts on immediately.

---

## 2. The data menu

### 2.1 One tool, one parameter

`trading_look` gains a `fetch: string[]` parameter listing catalog keys. It
replaces `scope[]`.

**The tool keeps the name `trading_look`.** The brief suggests `trading_fetch`;
that rename is declined for measured reasons:

- **186 references** to `trading_look` across `apps/` and `packages/` (source
  and tests), plus the doctrine prose the model itself reads
  (`StrategyProse.ts`, `TradingAutoMission.ts`, `TradingMissionService.ts`).
- `tools.test.ts` asserts **exactly 7 tools** and **total description chars <
  4,000** (currently 3,260, per-tool cap 500). Adding an 8th tool breaks the
  first assertion; the catalog cannot fit in a 500-char description if the
  descriptions also enumerate item sizes.

A rename is a mechanical change across 186 sites and should be its own commit
if it is ever wanted — deliberately **not** bundled with a semantic change to
the same tool. What matters is the menu, not the name.

### 2.2 The catalog

Sizes marked **(m)** are measured from real look results (§0.3); **(e)** are
estimated from the archive row shape or from a measured sibling. Every size is
the _typical_ result; a caller can compute its own budget by summing.

| key                      | what it returns                                                |                                   chars |
| ------------------------ | -------------------------------------------------------------- | --------------------------------------: |
| `snapshot`               | mark, mid, oracle, funding8h, OI, 24h volume, 24h change       |                             454 **(m)** |
| `book`                   | best bid/ask with sizes + summed depth over 5 levels a side    |                             130 **(e)** |
| `book_full`              | 10 levels a side                                               |                             898 **(m)** |
| `microstructure`         | book imbalance, near depth, spread bps                         |                             599 **(m)** |
| `candles:<interval>:<n>` | OHLCV table, column-header form                                |                          38 × n **(m)** |
| `indicators:<spec>`      | ema / sma / rsi / vwap, `value` + `previous`                   | ~40 per reading; 125 for a pair **(m)** |
| `volatility`             | ATR, realised σ, noise floor on the mission interval           |                             677 **(m)** |
| `volatility_htf`         | the same on the paired higher timeframe                        |                             680 **(m)** |
| `structure`              | full multi-timeframe read with scored `candidates[]`           |                           4,375 **(m)** |
| `structure_brief`        | alignment + the single top-scored candidate                    |                            ~420 **(e)** |
| `funding_stats:<W>`      | trailing W-day mean, current sign, sign-flip count, last print |                            ~140 **(e)** |
| `funding_series:<n>`     | last n hourly funding rows from the archive                    |                          28 × n **(e)** |
| `oi_premium:<n>`         | last n `asset_ctx` samples (OI, premium, oracle, mark)         |                          55 × n **(e)** |
| `book_history:<n>`       | last n `book_summary` rows                                     |                          48 × n **(e)** |
| `levels`                 | level history near the mark                                    |                             886 **(m)** |
| `position`               | size, entry, uPnL, cumulative funding, margin                  |                             180 **(m)** |
| `position_costs`         | the full cost estimate                                         |                             900 **(m)** |
| `orders`                 | working orders                                                 |                              46 **(m)** |
| `account`                | equity, margin used, capacity                                  |                             248 **(m)** |
| `plan`                   | the published plan with its prose                              |                           1,258 **(m)** |
| `watches`                | the armed set in full                                          |                           2,860 **(m)** |
| `events`                 | the pending-event tail                                         |                   ~90 per event **(e)** |
| `journal`                | mission notes, newest first                                    |                           1,219 **(m)** |
| `trades`                 | completed round trips                                          |                           1,173 **(m)** |
| `calibration`            | published targets graded against fills                         |                           1,047 **(m)** |
| `plan_history`           | prior plan revisions                                           |                           3,342 **(m)** |

Everything from `funding_stats` down to `book_history` is served from the
**market archive** (`~/.t3/userdata/market-archive.sqlite`), not from the
exchange. They are the four items the Info API cannot answer at all.

### 2.3 The design rules

1. **The model budgets its own context.** Every catalog entry publishes a size.
   A call for `structure` is a deliberate 4,375-char decision, not a side
   effect of asking for "the assessment".
2. **No key implies another.** Today `scope:["candles"]` also delivers
   `volatility` and `higherTimeframeVolatility` — measured present on 121 of
   the 121 calls that named `candles`, **1,357 chars the caller did not ask
   for**. Under `fetch` each is its own key with its own price. (`indicators`
   is already opt-in via its own parameter, which is exactly why it is the
   cheapest and most-used field in the read — see §0.3.)
3. **A `fetch` with no keys returns the menu**, not the data. This is the
   catalog call — ~450 chars, the cheapest possible way to answer "what can I
   ask for?".
4. **Unknown keys are refused by name**, never silently dropped, and the
   refusal names the nearest valid key. A silent drop reads to the model as
   "the server has nothing", which is the failure mode that makes a model
   re-ask with a wider scope.
5. **Sizes are advertised, then enforced.** `candles:1m:5000` is refused with
   the cap in the refusal, not truncated. A bound the model can raise is not a
   bound (this is the existing `TRADING_LOOK_MAX_BARS` doctrine, kept).
6. **Derived beats raw wherever both exist.** When a call names both
   `indicators:ema20` and the window it is computed from, the response says so
   once — it does not refuse, but the catalog entry for `candles` names the
   derived alternative and its size.

### 2.4 The archive read seam

The archive is a **separate SQLite file with its own schema and no migration
chain** (see the `plan-38` sibling work already on `main`). The server needs a
read-only seam to it:

- One service wrapping `apps/server/src/trading/archive/read.ts` —
  `latestCandle`, `candlesInRange`, `trailingMeanFunding`,
  `latestAssetContext`, `latestBookSummary`, `knownGaps`. Those functions are
  already pure and already written; nothing new is computed in this plan's
  phase 2 beyond wiring.
- **Opened read-only.** The archiver is the only writer. The file is WAL, so a
  reader never blocks it.
- **Absence is a first-class answer.** If the archive file does not exist, or
  the archiver has not been running, every archive-backed key returns
  `unavailable` with the reason — never a zero, never an empty series that
  reads as "no funding". `known_gaps` is surfaced in the same shape: a caller
  asking for a window the archive knows it is missing is told so.

---

## 3. Metric watches

### 3.1 The generalisation

Today's `WatchCondition` union has six kinds — `price`, `pnl`, `giveback`,
`fill`, `time`, `metric` — where `metric` is limited to five snapshot numbers
(`funding_rate_8h`, `open_interest`, `day_volume_usd`, `spread_bps`,
`volume_ratio`) that the 2s sweep can already read without new plumbing.

Plan 38 adds a **seventh kind, `derived`**: any metric the server can compute
locally from the archive, delivered as a trigger and never as a polled data
dump. This **generalises the existing machinery and replaces nothing**:

- The persisted form stays `MarketWatch` in `watch_json`. A new variant is
  additive; no payload migration.
- `baseline_signature`, `last_observed_value`, and `last_evaluated_at` already
  exist on `trading_watches` and are exactly what a derived metric needs —
  `fireOnChange` for sign flips, `last_observed_value` for the workspace's
  live-number checklist.
- `armed_with_position` (migration 072) applies unchanged: a derived watch
  armed while holding belongs to that position's plan and is retired with it; one
  armed while flat is a standing entry trigger and survives. **The 072 semantics
  are the reason this generalises safely** — a funding-flip trigger armed flat
  must outlive a position that opens and closes beneath it.
- Fires once, then terminal. Re-arm to keep it. Same as every other watch.

### 3.2 The definition

A derived-metric watch condition:

| field             | type                       | required            | meaning                                                                                                |
| ----------------- | -------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------ |
| `kind`            | `"derived"`                | yes                 | the discriminator                                                                                      |
| `market`          | `TradingMarket`            | yes                 | which coin                                                                                             |
| `metric`          | `DerivedMetricName` (§3.3) | yes                 | what is computed                                                                                       |
| `params`          | per-metric struct (§3.3)   | per metric          | window, interval, period — typed per metric, never a free bag                                          |
| `direction`       | `"above" \| "below"`       | yes, except `flip`  | which side of `value` fires                                                                            |
| `value`           | number                     | yes, except `flip`  | the threshold                                                                                          |
| `mode`            | `"level" \| "cross"`       | no, default `cross` | `level` fires whenever the value is beyond the threshold; `cross` fires only on the transition into it |
| `confirm`         | `"bar_close"`              | no                  | evaluate only on a closed bar of `params.interval`                                                     |
| `evaluateEveryMs` | number                     | no                  | server-chosen per metric; see §3.5                                                                     |

**Refusal codes** (extending `WatchRefusalCode`, same shape as today):

| code                         | when                                                                                                                                                                                                                                                     |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `derived_needs_archive`      | the metric's data is not in the archive (missing file, or `known_gaps` covers the window)                                                                                                                                                                |
| `derived_window_unavailable` | the requested window exceeds what the archive holds for that series                                                                                                                                                                                      |
| `derived_params_invalid`     | a required per-metric param is missing or out of range                                                                                                                                                                                                   |
| `derived_already_true`       | `mode: "level"` and the metric is already beyond the threshold — the same guard `giveback` has, and for the same reason: a watch true the moment it is written fires on the next sweep and wakes the run seconds later to widen the same threshold again |

### 3.3 The metric catalog

Each entry names its params, its data source, and its natural evaluation
cadence. Every one is computable from the archive tables.

| `metric`             | params                                         | source               | cadence      |
| -------------------- | ---------------------------------------------- | -------------------- | ------------ |
| `funding_mean`       | `windowDays` (1–30)                            | `funding`            | 30 min       |
| `funding_sign_flip`  | `windowDays`                                   | `funding`            | 30 min       |
| `funding_cumulative` | `sinceEntry: true`                             | `funding` + position | 30 min       |
| `sigma_return`       | `interval`, `period`                           | `candles`            | on bar close |
| `sigma_distance`     | `interval`, `period`, `basis: "mean" \| "ema"` | `candles`            | on bar close |
| `sigma_ratio`        | `interval`, `fast`, `slow`                     | `candles`            | on bar close |
| `ema_distance`       | `interval`, `period`                           | `candles`            | on bar close |
| `oi_change_rate`     | `windowMinutes`                                | `asset_ctx`          | 1 min        |
| `premium_mean`       | `windowMinutes`                                | `asset_ctx`          | 1 min        |
| `depth_ratio`        | `windowMinutes`                                | `book_summary`       | 1 min        |
| `bars_since`         | `interval`, `sinceWatchId`                     | `candles`            | on bar close |
| `hold_bars`          | `interval`                                     | `candles` + position | on bar close |

### 3.4 Five concrete examples, drawn from the audit's Phase 10

Phase 10's "what would promote the closest WEAK strategies to candidates" names
the metrics each near-miss strategy needs _observed_. These are those metrics,
expressed as armed triggers.

**(1) S3 funding sign, the deepest-sample strategy.** Phase 10 asks for the trailing 1–7 day
mean funding computed hourly, traded _"at most daily on sign changes"_. The
trailing mean crossing zero is the entire signal.

```
kind: derived, market: ETH, metric: funding_mean,
params: { windowDays: 7 }, direction: below, value: 0, mode: cross
```

Fires the moment the 7-day mean funding turns negative. Cadence 30 min. Costs
zero context until it fires; today this would be an hourly `trading_look` at
15,355 chars to read a number the server already has.

**(2) S3 flip detection, convention-agnostic.** Phase 10 flags the open
question as whether the inverse/carry convention flips across regimes, and
requires _"consistent OOS sign in ≥2 sub-periods"_. `funding_sign_flip` uses
the existing `fireOnChange` baseline machinery — the first evaluation records
the sign and fires nothing; a later one that reads the other sign fires.

```
kind: derived, market: BTC, metric: funding_sign_flip,
params: { windowDays: 1 }
```

No `direction` or `value`: a flip has no threshold. The durable
`baseline_signature` column means a flip that happens while the server is down
still fires on the first sweep after restart — which is exactly the event this
strategy is made of.

**(3) S5 capitulation fade, the entry.** Phase 10: _"rolling σ over a lookback
(v=2.5 threshold on down-move magnitude vs trailing vol)"_ and _"distance below
local mean in σ units"_.

```
kind: derived, market: ETH, metric: sigma_distance,
params: { interval: "5m", period: 20, basis: "mean" },
direction: below, value: -2.5, mode: cross, confirm: bar_close
```

`confirm: bar_close` reuses the existing candle-close evaluation path — the
same machinery `price` watches use for `confirm: "close"` today.

**(4) S5 hold clock, the exit.** Phase 10: _"a 3-bar (M=3) holding clock"_ and
_"time-since-signal"_. A wall-clock `time` watch cannot express this: three 5m
bars is not fifteen minutes when a bar is late or the mission entered mid-bar.

```
kind: derived, market: ETH, metric: hold_bars,
params: { interval: "5m" }, direction: above, value: 3, mode: level
```

**(5) S1 hourly mean reversion, the entry.** Phase 10: _"1h candles and a 72h
rolling σ, long-only after down-moves ≥2σ"_ and _"last-hour return in σ
units"_.

```
kind: derived, market: ETH, metric: sigma_return,
params: { interval: "1h", period: 72 },
direction: below, value: -2, mode: cross, confirm: bar_close
```

**(6, bonus) OI context, which nothing else provides.** Phase 10's honesty
section lists no OI modelling at all, and the one-line answer says hourly
OI/premium _"would likely change the answer"_. The archive is the only place
this series exists going forward.

```
kind: derived, market: ETH, metric: oi_change_rate,
params: { windowMinutes: 60 }, direction: above, value: 0.05, mode: cross
```

### 3.5 Evaluation, and why the 2s sweep is not touched

The sweep runs every 2s (`SWEEP_INTERVAL`). Recomputing a 72-period rolling σ
over three coins on every tick is waste — the underlying bar does not change
for an hour.

Each metric declares a natural cadence (§3.3). The evaluator honours it via a
per-watch `next_evaluate_at` (migration 073, §5.1): a derived watch whose time
has not come is skipped in O(1) by the sweep's existing row scan. `confirm:
bar_close` metrics are driven by the candle-delivery path instead, which is
where `candle_close` watches already live.

`last_observed_value` is written on every real evaluation, under the same
write-guard the numeric evaluators already use (epsilon + `OBSERVATION_REFRESH_MILLIS`),
so the workspace's conditions checklist shows the live number next to its
threshold for derived watches exactly as it does for price and PnL.

---

## 4. What gets deleted or shrunk

### 4.1 Tool descriptions

Current: 7 tools, **3,260 chars** (cap: 7 tools, < 4,000 total, ≤ 500 each).

| tool               |       now |       after | change                                                            |
| ------------------ | --------: | ----------: | ----------------------------------------------------------------- |
| `trading_look`     |       494 |       ≤ 500 | rewritten for `fetch[]`; names the menu call, not the items       |
| `trading_watch`    |       497 |       ≤ 500 | one clause for `derived`; the metric catalog does **not** go here |
| `trading_strategy` |       498 |         498 | untouched                                                         |
| `trading_enter`    |       496 |         496 | untouched                                                         |
| `trading_plan`     |       495 |         495 | untouched                                                         |
| `trading_exit`     |       494 |         494 | untouched                                                         |
| `trading_journal`  |       286 |         286 | untouched                                                         |
| **total**          | **3,260** | **≤ 3,270** | stays under 4,000 with 7 tools                                    |

The catalog and the metric list are **runtime data**, returned by the menu call
and by a watch refusal — not description text. This is the plan-29 rule that
took the toolkit from ~15,000 to under 6,000 chars: _"a description says what
the tool returns and the non-obvious behaviours — not enumerations"_.

### 4.2 Look scopes

`scope[]` is deleted. Its seven values map onto the catalog:

| scope        |                                                                                       mean chars | fate                                                                                                                                                                                                                                                                                                                                                       |
| ------------ | -----------------------------------------------------------------------------------------------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `market`     |         2,132 (snapshot 454 + orderBook 898 + microstructure 599 + resolvedMarket 80 + cost 101) | **split** into `snapshot`, `book`/`book_full`, `microstructure` — the model stops paying 898 for depth when it wanted the spread                                                                                                                                                                                                                           |
| `candles`    | 3,781 (bars 2,299 + volatility 677 + volatility_htf 680 + indicators 125, three of them implied) | **split** into `candles:<interval>:<n>`, `volatility`, `volatility_htf`, `indicators`                                                                                                                                                                                                                                                                      |
| `structure`  |                                                                                            4,375 | **kept whole as `structure`, plus a new `structure_brief` (~420)**. Not deleted: plan 35 explicitly left `structure.candidates` unproven and said judging it needs a discretionary mission, not a playbook-directed one. Deleting it here would repeat the mistake plan 35 avoided. The brief version gives the model the cheap option it currently lacks. |
| `position`   |                                                 474 (position 180 + account 248 + openOrders 46) | **split** into `position`, `account`, `orders`; `position_costs` (900) becomes opt-in rather than riding `position`                                                                                                                                                                                                                                        |
| `mission`    |                                                                                            4,028 | **split** into `plan` (1,258), `watches` (2,860), `events`. The `authority` (525), `harness` (120), `control` (77), `mode` (24) and `bound` (4) siblings collapse into 3–4 lines on the `plan` item — they are status flags, not documents                                                                                                                 |
| `retrospect` |                                                   4,389 (plan_history 3,342 + calibration 1,047) | **split** into `plan_history`, `calibration`, `journal`                                                                                                                                                                                                                                                                                                    |
| `trades`     |                                                                                            1,173 | becomes `trades`, unchanged                                                                                                                                                                                                                                                                                                                                |

**Nothing is deleted outright from the read.** Every scope's content remains
reachable; what changes is that it is addressed by name with a published price
instead of arriving in a bundle. The savings come from what the model _stops
asking for_ — a `structure`-free reassessment turn drops from 15,355 to ~1,000.

### 4.3 Wake fields

Deleted outright: `misarmedEntryConditions` (239 chars, plan 34 F8 already
found it decides nothing post-entry). Everything else in §1.3 moves behind a
catalog key. `readFirst` (100) is replaced by the `fetch` pointer (≤90).

### 4.4 Measured projection

| surface                                |           today |            after | change   |
| -------------------------------------- | --------------: | ---------------: | -------- |
| wake, typical                          |           1,735 |             ~950 | **−45%** |
| read, reassessment turn (no structure) |          15,355 |           ~1,000 | **−93%** |
| read, full assessment turn             |          15,355 |           ~7,500 | **−51%** |
| tool descriptions                      |           3,260 |          ≤ 3,270 | flat     |
| an armed derived metric, per turn      | 15,355 (a poll) | 0 until it fires | —        |

The last row is the plan. A strategy that needs "trailing 7-day mean funding
observed once an hour" costs **nothing** until the number does something.

---

## 5. Migration and compatibility

### 5.1 Migration 073 — and only 073

App migration numbers **067–072 are taken**; the next free slot is **073**.

`073_TradingWatchEvaluationCadence`: add `next_evaluate_at INTEGER` to
`trading_watches`. Null on every existing row, which reads as "evaluate on
every sweep" — the behaviour those rows already have.

**That is the whole app schema change.** Specifically _not_ needed:

- **No watch payload migration.** `watch_json` holds the whole `MarketWatch`;
  a new union variant is additive and old rows decode unchanged.
- **No columns for observed values.** `baseline_signature`,
  `last_observed_value` and `last_evaluated_at` already exist and already carry
  exactly what a derived metric needs.
- **No archive tables in `state.sqlite`.** The market archive is a separate
  file with its own `meta.schema_version`. Adding a column there bumps
  `ARCHIVE_SCHEMA_VERSION` in `apps/server/src/trading/archive/db.ts` and
  touches nothing in the app chain. **The archive must never join the app's
  migration chain** — that is the property that lets the archiver be killed,
  restarted, and version-bumped independently of a server release.

### 5.2 The masked-encode fixture trap

**This is the trap that will cost a follow-up agent an afternoon if it is not
read first.**

`handlers.test.ts` builds its dependencies with `as unknown` casts —
`fakeCostEstimator` (line ~353) is the canonical case. The cast means a field
the _contract_ declares required but the _fixture_ omits is a runtime
`undefined` that TypeScript cannot catch. It surfaces only when something
encodes the whole struct — which `trading_look`'s position read does — and it
surfaces as a masked **"internal server error"**, not as a schema complaint.

The fixture already carries a comment saying so, and a regression test at the
bottom of the file exists because this has bitten before (`roundTripTakerMakerUsd`
and `roundTripMakerMakerUsd` were the pair that did it).

**The rule for every phase of this plan:** any new required field on a result
struct returned by a handler must be mirrored in the corresponding
`handlers.test.ts` fake in the same commit. This plan adds required fields to:

- the catalog/menu result (phase 2),
- the derived-watch result and its refusal shape (phase 3),
- the wake projection (phase 1, via `TradingWakeupComposer`).

Phase 1 is the sharpest case: the composer is provided by `fakeCostEstimator`
in the same file, so a wake field change and a cost-estimator fixture change
land together or the suite reports an internal server error and the cause looks
like the wake code.

### 5.3 How existing missions keep working

| concern                                  | resolution                                                                                                                                                                                                                                                |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Missions mid-flight when the build lands | `scope[]` and `fetch[]` are **both accepted** through phases 1–3. A call naming `scope` gets today's behaviour byte for byte. `scope[]` is deleted in phase 4, after a soak on the new path.                                                              |
| Watches armed before the build           | Untouched. `watch_json` decodes as before; `next_evaluate_at` is null, so they evaluate on every sweep exactly as today.                                                                                                                                  |
| Doctrine prose naming `trading_look`     | The tool name does not change (§2.1). `StrategyProse.ts`, `TradingAutoMission.ts` and `TradingMissionService.ts` keep their references; only the argument shape they describe changes, in phase 4.                                                        |
| A mission whose wake shrank mid-run      | The removed fields are all reachable by `fetch`. The wake's `fetch` pointer names the menu, so a model that wants what used to ride the wake can ask for it in one call.                                                                                  |
| The archive not running                  | Every archive-backed catalog key and every `derived` watch returns/refuses with `derived_needs_archive`. **A missing archive must never degrade to a zero.** A funding mean of 0 read as real is the single most dangerous failure this plan can produce. |
| `armed_with_position` semantics          | Unchanged and load-bearing (§3.1). Derived watches inherit it on arm.                                                                                                                                                                                     |

---

## 6. Landing order

Four phases, each independently shippable and testable. The established
verification path is the **trading harness replay**
(`scripts/wake-payload-replay/`) plus `bun run test:fork` from `apps/server`.

### Phase 1 — The lean wake

**Ships:** the six-field wake (§1.2), the folded `triggered` line carrying the
observed value (§1.4), the `fetch` pointer (§1.5),
`misarmedEntryConditions` deleted, `armedWatches` capped at 4 one-line entries.

**Does not ship:** any change to `trading_look`, any new watch kind, any
archive read. Phase 1 touches `TradingWakeupComposer.ts` and its tests only.

**Verify:**

1. `TradingWakeupComposer.test.ts` — a new case pinning the 950-char typical
   budget and the 1,300 trim trigger, plus one pinning that the observed value
   from the firing event appears in the `triggered` line (the plan-35 finding,
   made a test so it cannot be re-lost).
2. **Replay** the recorded wake corpus through the composer and diff: assert
   mean chars ≤ 1,000 and that no field carrying an observed value was dropped.
3. `bun run test:fork` green; `handlers.test.ts` fixtures updated in the same
   commit (§5.2).

**Independently valuable:** −45% on every wake, with no other moving part.

### Phase 2 — The data menu

**Ships:** `fetch[]` on `trading_look` accepted alongside `scope[]`; the full
catalog (§2.2) including the four archive-backed keys; the menu call
(`fetch` absent → catalog, ~450 chars); the read-only archive seam (§2.4);
refusal-by-name for unknown keys.

**Verify:**

1. Unit: every catalog key returns within ±20% of its published size against
   the fixture market. A key whose real size drifts past its advertised one is
   a failing test, not a surprise in production — the published price is the
   contract.
2. Unit: `scope[]` calls produce byte-identical results to the pre-phase build
   (the compatibility guarantee in §5.3).
3. Unit: with the archive file absent, all four archive keys return
   `unavailable` with a reason and **never a zero**.
4. **Replay** a recorded mission with `scope`→`fetch` translation and compare
   decisions turn by turn. Plan 35's precedent is the standard: _dropping
   candles entirely diverged in replay_ — re-encoding was safe, removal was
   not. Any decision divergence blocks the phase.

### Phase 3 — Derived metric watches

**Ships:** migration 073; the `derived` condition kind; the twelve-metric
catalog (§3.3); cadence-aware evaluation; the four refusal codes; the
`funding_sign_flip` differential path on the existing `fireOnChange`.

**Verify:**

1. Unit per metric: computed value against a hand-checked fixture series in a
   temp archive file (the archive's own test convention, already established in
   `apps/server/src/trading/archive/*.test.ts`).
2. Unit: `mode: "level"` with an already-true threshold refuses
   `derived_already_true` (the `giveback` guard, generalised) — this is the
   instant-refire bug plan 34 step 6 fixed, and the one most likely to recur.
3. Unit: a sign flip that occurs while the evaluator is stopped fires on the
   first sweep after restart (`baseline_signature` durability).
4. Unit: `armed_with_position` — a derived watch armed flat survives a position
   opening and closing beneath it; one armed while holding is retired with it.
5. **Live**: arm example (1) and (2) from §3.4 on a real mission against the
   running archive and confirm exactly one wake per real crossing, with the
   observed value on the `triggered` line.

### Phase 4 — Delete the old path

**Ships:** `scope[]` removed from `TradingLookInput`; the implied-bundle
behaviour (§2.3 rule 2) removed; doctrine prose updated to describe `fetch`;
`trading_look`'s description rewritten within its 500-char cap.

**Gate:** phase 4 does not start until a soak on phases 1–3 shows no decision
regressions. It is the only irreversible phase.

**Verify:**

1. `tools.test.ts` — still exactly 7 tools, total < 4,000, each ≤ 500.
2. Full `bun run test:fork`, typecheck clean, lint at baseline.
3. **Replay** the full recorded corpus one last time on the `fetch`-only build.

---

## Appendix A — Measurement method

All figures recomputed 2026-08-19 from `~/.t3/userdata/state.sqlite`.

- **Tool result sizes:** `projection_thread_activities` where
  `kind='tool.completed'`, taking
  `json_extract(payload_json,'$.data.item.result.content[0].text')` — the exact
  text the model received, not the envelope.
- **Look composition:** the 239 parseable look results, decomposed by top-level
  JSON key, then by second-level key for `mission`, `structure` and `candles`.
- **Current build vs historical:** a look is "current build" if
  `candles.bars` is an array (the plan-35 table encoding) or `levelHistory` is
  present. 122 of 239 qualify.
- **Wake sizes:** `projection_thread_messages` where `role='user'` and the text
  contains the `readFirst` marker — 142 wakes, all on the current build.
  Composition by parsing the rendered `key:` blocks.
- **Tool description chars:** parsed out of
  `apps/server/src/mcp/toolkits/trading/tools.ts` and summed; cross-checked
  against the budget assertion in `tools.test.ts`.

## Appendix B — A real current wake, 1,463 chars

Verbatim, most recent at time of writing. The `pendingEvents` block is the
§1.4 case: the watch line says `price=1916`, and only the event says the bar
closed at **1914.6** against **1915.53**.

```
trading-harness-wakeup
kind: trading-harness-wakeup
missionId: 06f01ed5-9b1d-4440-ae6a-12882c63f851
harnessRunId: d0f5727f-6af0-44d5-bd2b-afbeef8d0e16
cause: market_watch_triggered
occurredAt: 1787103638582
triggeringWatch: id=1202b80a on={kind=price market=ETH direction=below
  price=1916 confirm=close interval=5m} status=triggered
market: ETH
markPrice: 1914
position: market=ETH size=0 unrealisedPnl=0 cumulativeFunding=0 marginUsed=0
costContext: referenceNotionalUsd=500 roundTripUsd=0.5514 roundTripBps=11
  takerMakerUsd=0.3131 makerMakerUsd=0.15 preferredTargetUsd=1.103
plan: intent=stand_aside phase=waiting maxPlannedLossUsd=62.99
strategyReview: FLAT — every playbook is a candidate again (momentum,
  range_reversion, opening_range, rsi_reversion; ema_cross unscored — read
  `ema`). Take the one whose expected move beats the round trip
  (`costContext`), or none.
armedWatches: [0] id=0159bc44 on={kind=time runAt=1787104504224}
unarmedEntryConditions: [0] description=Reconsider only if a fresh 5m
  EMA(9/21) cross is confirmed while the cross is no older than 5 bars and the
  move clears taker-costs. priceLevel=1916 timeframe=5m
pendingEvents: [0] category=market
  deduplicationKey=candle_close:1202b80a-...:1787103599999
  occurredAt=1787103638565 summary=5m candle closed 1914.6 (below 1915.53)
readFirst: no candles, book, structure, account or mandate here — call
  trading_look before acting
```

Under §1.2 this wake becomes roughly:

```
trading-harness-wakeup
kind: trading-harness-wakeup
missionId: 06f01ed5 harnessRunId: d0f5727f
cause: market_watch_triggered occurredAt: 1787103638582
market: ETH markPrice: 1914
position: size=0
triggered: id=1202b80a 5m close below 1916 — closed 1914.6 vs 1915.53
cost: roundTripUsd=0.5514 roundTripBps=11 takerMakerUsd=0.3131
  makerMakerUsd=0.15 preferredTargetUsd=1.103
plan: intent=stand_aside phase=waiting maxPlannedLossUsd=62.99
armed: [0] 0159bc44 time runAt=1787104504224
fetch: nothing here but the above — trading_look({fetch:[...]}) ;
  menu: trading_look({})
```

~640 chars. The observed value survives; the prose does not.
