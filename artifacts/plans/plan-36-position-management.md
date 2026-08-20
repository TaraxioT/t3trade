# Plan 36 — The exit that must not fail, and the target that could not win

Worked from mission `a92f4c84-b126-4dec-ab88-d13ed944360b` (ETH, 2026-08-18
13:17–13:40 local). Every number below is a query result against
`~/.t3/userdata/state.sqlite`. Where this plan and an earlier document disagree,
this one was measured and the other was not.

## What the mission did

21 harness runs in 22m40s: 13 `market_watch_triggered`, 2
`scheduled_reassessment`, 5 `user_message`, 1 `mission_created`. The 13 market
wakes produced **no trades** — every one settled `no_setup/insufficient_volatility`
or `no_decision`. The single trade was operator-ordered on both legs: "Enter a
short anyway" at 13:24:51, "close the position a proper break even" at 13:27:45.
Held 3m19s, net **−$0.607** on $0.450 of fees.

Twelve of the thirteen market wakes were self-inflicted. On every plan the model
published two entry triggers at the _same_ price — "1m close above 1900.14" and
"1m close below 1900.14" — and armed both. One of a straddle at the current price
always fires on the next bar. The pairs are in `trading_watches`: 1900.14, 1899.85,
1899.72, 1899.57, 1899.46, then five more after the trade. 27 of 35 watches are
model-armed. The thirteenth wake came from a watch belonging to a position that
had already closed.

The published target was `profitUsd = 0.34` while the same payload carried
`roundTripUsd = 0.5589` and `preferredTargetUsd = 1.118`. Hitting it exactly
banks $0.34 against $0.45 of fees: **−$0.11, by construction.**

## Order of work

Items 1–4 are defects. They ship first and they are not optional: one of them can
strand a live position, and the other three corrupt the record any later mission
analysis reads. Items 5–8 are the behaviour change.

---

### 1. A rate-limited read must never refuse an exit

**Evidence.** `trading_event_inbox` row 467, 13:27:51:
`execution 1 refused: TradingReconciliationError(account_read_failed):
HyperliquidRequestError(http_error): clearinghouseState status=429`. No order was
sent. The operator had to type "Try again."

**Cause.** `submitReduceOnly` opens with
`reconciler.reconcile(…, "before_execution")`
([TradingExecutionGuard.ts:309](apps/server/src/trading/TradingExecutionGuard.ts:309)),
which calls `readCanonicalAccount`
([HyperliquidReconciler.ts:145](apps/server/src/trading/HyperliquidReconciler.ts:145)).
That gateway read is the **only** exchange read on the exit path with no
`retryTransientRead` wrapper — `TradingExitService` retries all three of its own
(lines 165, 169, 173). A 429 that `classifyUnknownFailure` would have called
retryable took the whole close down instead.

**Change.** Wrap the gateway call inside `readCanonicalAccount` in
`retryTransientRead`. Same treatment for `readCanonicalOpenOrders`. The
reconciler's reads are reads; the bounded-at-one rule in
[RetryTransient.ts](apps/server/src/trading/RetryTransient.ts) already says why
that is safe and why two would not be.

**Test.** `HyperliquidReconciler.test.ts` — a gateway that fails once with a 429
and succeeds on retry reconciles; one that fails twice still surfaces
`account_read_failed`. `TradingExecutionGuard.test.ts` — a close survives a single
transient preflight failure.

**Why first.** On testnet this cost one operator message. On mainnet during a
rate-limit burst it is a position that cannot be exited.

---

### 2. One close, one row

**Evidence.** Two rows in `trading_closed_trades` for this mission, identical in
every field except `closed_at` (1787039899661 / 1787039899728, 67ms apart) and the
`hold_millis` derived from it. Two matching `trading_event_inbox` rows (468, 470),
so the 13:28:32 wake carried the same ~1,000-character trade scorecard **twice**.

**Cause.** `PRIMARY KEY (mission_id, closed_at)` where `closed_at` is a local
observation clock, not exchange fill identity. Two reconciles observing the same
close stamp two different keys, and the inbox dedup key is built from the same
value.

**Change.** Key the closed trade and its inbox event off the closing fill's
exchange identity (`trading_fills` — last fill id / exchange timestamp of the
sequence that flattened the position), not the observation instant. Migration to
de-duplicate existing rows on `(mission_id, opened_at, direction, size)`.

**Test.** Two reconciles over one close write one row and emit one event.

---

### 3. Watches retire with the position

**Evidence.** The position closed at 13:28:19. Watch `312e5b2b` — `price_cross
below 1896.75`, the target level of that dead position — **fired at 13:33:53** and
woke run `67244af3`, which concluded nothing. All seven position-phase watches
stayed active until the model cancelled four by hand at 13:34:02, 5m43s and two
wasted wakes late. `retireWorkingOrdersQuietly` retires orders on flat; nothing
retires watches.

**Change.** On the flat transition in `TradingMissionReactor`, retire as
`superseded` every position-scoped watch: types `pnl_above`, `pnl_below`,
`pnl_giveback`, and any watch whose `armed_reason` is `profit_target`,
`stop_decision`, `stop_proximity`, `prediction_horizon` or
`prediction_invalidation`. Model-armed price levels stay — a level is still a
level when flat — but they lose their `prediction_version` binding.

**Test.** A mission that goes flat leaves no position-scoped watch active; a
model-armed price level survives.

---

### 4. No protection order on a flat position

**Evidence.** `trading_protection_orders` holds one row: `kind = take_profit`,
`size = 0.0`, `limit_price = 1896.75`, `placed_at = 1787039899941` — **280ms after
the close** — and `retired_at` still null.

**Change.** `TradingProtectionService` must not write a protection record for a
zero size, and must retire any open record when it observes the position flat.
Item 6 removes the take-profit leg entirely, but the zero-size guard is the
general fix and belongs regardless.

**Test.** Reconciling a flat position writes no protection row and retires any
outstanding one.

---

### 5. A level at the current price is a poll, not an alert

**Evidence.** 12 of 13 market wakes. Six consecutive minutes of mirrored
`candle_close` pairs at one price, each wake paying ~16,000 characters of
`trading_look` to conclude "no setup" — the same conclusion, from the same two
EMAs, on a market whose `volatilityRatio` had not changed.

**Change, runtime.** `trading_watch` refuses to arm a `price_cross` or
`candle_close` when an active watch already sits within `ENTRY_HINT_TOLERANCE_BPS`
of that price in the opposite direction. The refusal returns the existing watch's
handle and its reason: _a level armed on both sides of the current price fires on
the next bar whichever way it goes; arm the level your thesis turns on, or arm
nothing and let the reassessment carry you._ A refusal that explains is what
corrects the model mid-mission.

**Change, doctrine.** `playbook.ts` standing rules: a `stand_aside` plan states its
entry conditions but arms **no** price level at the current price. What it arms is
the reassessment. Entry triggers are for levels the market must travel to reach.

**Test.** The mirrored arm is refused and names the incumbent; a same-direction
re-level through `replacesWatchId` still works; two levels genuinely apart both arm.

**Expected effect.** 12 wakes and ~195,000 characters of look results removed from
a 23-minute mission.

---

### 6. The target wakes; it does not exit, and it does not lose

**Evidence.** `target_profit_usd = 0.34` on the closed trade against
`roundTripUsd = 0.5589`. `ensureProfitTargetArmed`
([TradingTurnCoordinator.ts:520](apps/server/src/trading/TradingTurnCoordinator.ts:520))
arms `pnl_above` at whatever the plan named, with no cost check.
`evaluatePnlAbove` ([WatchEvaluator.ts:574](apps/server/src/trading/WatchEvaluator.ts:574))
compares it to `position.unrealisedPnl` — **gross**, with the exit fee still
unpaid. The one protection order this produced is item 4.

**Three changes.**

_Reject a target that cannot pay for itself._ `trading_plan` refuses
`target.profitUsd` below the live `preferredTargetUsd` (2× round trip), naming
both numbers. The model already has `preferredTargetUsd` in its wake payload and
in `positionCosts`, so this is one corrected republish, not a loop. Implementation
note to verify: the publish handler needs a cost estimate in hand; confirm one is
reachable there before choosing rejection over clamping.

_Evaluate net._ `evaluatePnlAbove` fires on `unrealisedPnl` minus the unpaid exit
cost, not on gross. A target that fires is then always genuinely bankable.

_Never rest an order at it._ Remove the take-profit ALO from
`TradingProtectionService` — `takeProfitLimitPrice` and its call site at line 807.
The stop stays server-side; the target becomes a wake and nothing more. The plan's
`target` leg keeps `profitUsd` (the wake level) and `price`/`method` as prose.

**What this deliberately does not do.** It does not remove the upside wake.
`giveback`, `stop_proximity` and `prediction_invalidation` all fire on the
downside; without `pnl_above` a position moving quietly in the mission's favour
would wake for nothing until the cadence timer. The asymmetry is the reason to
keep it.

**Test.** A sub-cost target is refused with both numbers in the message. A
`pnl_above` armed at $1.12 does not fire at $1.12 gross when $0.22 of exit cost is
outstanding; it fires at $1.34. No take-profit order is placed for any position.

---

### 7. A held position wakes on a clock

**Evidence.** The position was "covered" — seven armed watches — so `ensureNotDeaf`
took the covered branch and armed the **slow sanity backstop** instead of the
3-bar cadence ([TradingTurnCoordinator.ts:723](apps/server/src/trading/TradingTurnCoordinator.ts:723)).
The only clock over the whole hold was the model's own `projection.byMinutes = 5`
horizon at 13:30:21, which the operator's close pre-empted. A position held on a 1m
mandate had no runtime-armed reassessment.

**Change.** While holding, always arm and maintain
`watchCoverageFloorMillis({ holdingPosition: true })` — 3 bars, clamped to
[2 min, 15 min] — regardless of coverage. Levels are alerts; cadence is separate
and unconditional. The sanity backstop stays for flat missions only. The
prediction horizon continues to sit on top, so a model that names a shorter
horizon still gets it.

This is the replacement the target used to be: the mission is asked, on a clock,
whether there is enough profit to bank and whether the thesis still holds — against
live conditions, not against a number guessed at entry.

**Test.** `TradingWatchCoverageFloor.test.ts` — a fully covered holding mission
still gets a reassessment inside the holding floor; a flat covered mission still
gets the backstop, not the metronome.

---

### 8. A stand-aside turn reads fewer bars

**Evidence.** 17 `trading_look` calls, **293,500 characters — 82% of the mission's
entire context**, against 35,589 characters for all 21 wake payloads combined. The
model asked for `bars: 120` on essentially every turn and used it to recompute
`ema(20)` and `ema(50)`, which the server had already computed.

**Change.** Cap the echoed candle table when the mission is flat, in
`resolveEchoedBars` ([handlers.ts:905](apps/server/src/mcp/toolkits/trading/handlers.ts:905)).
Entry and position turns keep the full 120 — the shape matters when a trade is
being contemplated or managed. Safe by construction: `indicatorReadings` computes
on the **full** fetched window and only `boundCandles` trims what rides back, so a
50-period EMA is unaffected by a 60-bar echo. The reply notes the cap so the model
knows it can ask for more.

**Test.** A flat look with `bars: 120` echoes the cap; `ema(50)` over that call
matches the value from an uncapped read; a look with a position echoes 120.

**Not in this plan.** Indicators-only looks — no candle table at all — are the
right end state, but the plan-35 replay showed a divergence when candles were
removed wholesale. That needs its own before/after replay and should not ride on
this one.

---

## Also found, not scheduled

`findMisarmedEntryConditions` ([watch.ts:981](packages/trading-contracts/src/watch.ts:981))
reported a false misarm on six consecutive wakes. It matches only `active` watches,
so the trigger that just **fired** is invisible to it and the surviving opposite-side
sibling is reported as the mismatch. The text it produced —
`armedAs=candle_close shouldBe=candle_close mismatch=direction` — tells the model it
armed the thing it should have armed. Item 5 removes the straddle that makes this
reachable, so the false positive should disappear with it. Re-measure after item 5
lands rather than patching the detector blind; if it survives, the fix is to
consider watches triggered within the current wake, and to never emit a report
whose `armedAs` equals its `shouldBe`.

## Not a defect

The model's stand-asides were correct. `volatilityRatio` was genuinely low, the
range was stable, and it said so in one line each time, as the mandate asked. It
also complied with the operator override, said plainly that it disagreed, and
reported the loss honestly including the fee split. The judgement was sound. What
failed was the machinery around it: the instrument it used to wait with, the target
it was allowed to publish, and the read it paid for to reach the same conclusion
thirteen times.

## Verification

`vp run -r --concurrency-limit 2 typecheck`, `vp lint`, and the server, web,
trading-contracts, contracts, hyperliquid and shared suites, all green before each
commit. Items 1–4 are unit-testable in full. Items 5–8 change what the model sees,
so each carries a before/after replay through `scripts/wake-payload-replay` on both
CLIs, per plan 35's discipline: same action, same direction, parameters within
tolerance, on both models, or the section goes back narrow-first.

The soak is the operator's. Items 5 and 7 are the ones only a live run can judge —
whether a mission that arms one level and a clock still catches what it should.
