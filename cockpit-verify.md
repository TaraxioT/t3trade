# Cockpit verification - R6, live testnet mission

First time the rebuilt cockpit has been rendered in a browser. Everything below
was checked against a **real agent-discretion mission** on Hyperliquid testnet,
in an isolated dev environment. No fixture missions were seeded; every state in
this report is one the mission actually produced.

Screenshots: `artifacts/cockpit-verify/`.

## Environment and isolation

|             |                                                               |
| ----------- | ------------------------------------------------------------- |
| State dir   | `/tmp/t3code-test.oQXqhH` (disposable, created for this pass) |
| Web / API   | `http://localhost:5735` / `13775`                             |
| Project cwd | `/tmp/t3code-test.oQXqhH/project` (scratch, not the repo)     |
| Thread      | `16261b26-44c2-4242-bf0a-7c225ab580e4`                        |

The repo's `.t3/userdata/state.sqlite` was never opened, and nothing was pointed
at `~/.t3`. The market archiver (PID 78836) was left running and untouched.

**Shared account.** The testnet account is shared with watch-only soak
`2af6960b`. Before starting, `clearinghouseState` for
`0xb2b6…c30e` reported `accountValue 899.321758` and
**`assetPositions: []`** - zero open positions. So every position and fill in
this report is attributable to this mission. At the end the account held
`898.924575` and one position: **ETH short 0.0001** (dust, entry 2,338.67),
which is this mission's, left running rather than force-closed.

## What the mission did

Prompt pasted verbatim, no strategy named and no execute verb, so the agent had
full discretion. It ran for roughly 40 minutes: **22 harness runs, 2 published
plans, 23 fills.**

1. **Stood aside first.** Its opening read was that momentum was the best-ranked
   playbook but the 5m continuation was a near-miss: no higher-low pivot run,
   recent direction flat, last twenty minutes at 30% of the wider-window pace.
   It published a stand-aside plan naming a trigger (a 5m close above 2,347.20)
   and a 15-minute reassessment. It explicitly rejected RSI reversion, short
   momentum, and opening-range/EMA-cross by name.
2. **Switched character and entered short.** On a later wake it revised to plan
   v2 and sold to open **0.3841 ETH short at 2,338.67**, stop 2,349, target
   2,318, with profit-giveback and PnL watches armed.
3. **Managed it down.** It moved the stop (`trail_peak`), then scaled out
   repeatedly across the window - 0.0713, 0.044, 0.1725, 0.0244, 0.0078, 0.0417
   ETH - as levels it was watching were reached.

Net effect on the account over the window was about **-$0.40**, i.e. fees and
small give-backs; this pass was a UI verification, not a strategy evaluation.

Because the agent both stood aside **and** entered, the flat/armed, stand-aside
and holding states were all exercised on real data.

## Checklist

| #   | Check                                                                             | Result                                        |
| --- | --------------------------------------------------------------------------------- | --------------------------------------------- |
| 1   | No persistent full-width horizontal or vertical lines on the chart                | **pass**                                      |
| 2   | Level chips legible in the price gutter, never overlapping unreadably             | **pass**                                      |
| 3   | Overflow collapses to a "+N" chip that opens the panel list                       | **pass**                                      |
| 4   | Time chips sit in the bottom-axis future zone right of the last candle            | **fail, then fixed**                          |
| 5   | Heartbeat reads as a correct plain-language sentence, clock times, no field names | **fail, then fixed** (three separate defects) |
| 6   | Hover sync works both directions                                                  | **pass**                                      |
| 7   | Projection wedge is one shape, no leftover lines or endpoint rings                | **fail, then fixed**                          |
| 8   | Motion: arm / fire / count-up play once, nothing loops                            | **pass**                                      |
| 9   | `prefers-reduced-motion`: every animation instant                                 | **pass**                                      |
| 10  | `prefers-reduced-transparency`: glass falls back solid                            | **fail, then fixed**                          |
| 11  | Disconnected banner renders, recovery works                                       | **pass**                                      |
| 12  | Zero em-dashes in visible UI text                                                 | **pass**                                      |
| 13  | No-mission composed state                                                         | **pass**                                      |
| 14  | Initial-load skeletons                                                            | **partially exercised**                       |

Each verified in dark and light, at 1600px and 1100px, unless noted.

### 1. No persistent lines - pass

Audited by reading the SVG rather than by eye, in both stand-aside and holding
states. In the holding state the chart contained 17 `<line>`, and every one is
on the allow-list:

- 2 full-width horizontals - the **grid rules** at 7% foreground (explicitly
  "keep").
- 11 bottom **rug ticks**, each exactly 6 units tall (keep).
- 2 **bracket stubs**, `x 722.5 → 850` of an 850-wide plot = **15.0%**, matching
  the "~15%" spec exactly.
- 1 vertical at the **wedge's own far edge** (the invalidation hard edge, part
  of the one wedge shape).
- 1 full-height vertical at `nowX`.

**Zero** `<circle>` elements, so no endpoint rings anywhere. No level rules, no
hypothetical dashed segments, no leader lines, no full-height time rules.

One honest note: the single full-height vertical at `nowX` is a deliberate 14%
opacity "now" hairline, documented in `MissionPriceChart.tsx` as the record /
future separator. It is the vertical counterpart of the horizontal grid rules,
not one of the retired per-reassessment time rules. Left as designed.

### 2 and 3. Gutter chips - pass

Six level chips in the holding state (stop, two armed conditions, entry, mark,
target). Measured: **zero pairwise overlaps**, uniform 22-23px vertical gaps
between 16px-tall chips. The collision layout does its job.

Overflow: the chart showed a `+N` time chip, and the panel showed
`+3 more levels armed, off the chart`. Clicking it expanded the watch stream
(text length 775 → 893) into the full plain-language list - "ETH mark crosses
above 2,342.93", "ETH unrealised PnL falls to -$2.29".

### 4. Time chips in the future zone - fail, then fixed

Chips were anchored by their **right** edge. That reads well only for a moment
far out; a reassessment three minutes away sits just past `now`, so the chip
hung backwards over the divider and labelled the record with a time that had not
happened. Measured live: chip spanned `x 841-890` while `now` was at `886`.

Fixed by anchoring the left edge at the moment, with a `max-width` clamp so the
chip still cannot overflow the frame. Same chip then spanned `897-968` against a
`now` of `891` and a frame edge of `1087`. Verified at the extreme too: a chip
clamped to the plot edge (`left: 85%`) rendered `977-1048`, inside the frame and
not truncated.

Commit `2f1d14243`.

### 5. Heartbeat sentence - fail, then fixed (three defects)

**(a) The missing check-in time.** The strip read
`Standing aside: <reason>` with no `re-reading at HH:MM`, even though the
mission genuinely had a reassessment armed. Cross-checked against the database:
`trading_watches` held one active
`{"type":"scheduled_reassessment","runAt":1787201634034}` (10:23), while the
client's `mission.watches` was `[]`.

Root cause is server-side: `TradingWatchService.registerWatch` writes the row
without emitting an orchestration event, and `ProjectionPipeline` only rebuilds
the mission projection on events, so watches armed at runtime (the staleness
floor, the prediction roll-forward) never reach the client. Per the brief I
fixed this in `apps/web` rather than the server, because the datum is
_derivable_ from fields already pushed: the plan carries
`reassess.afterMinutes` and `updatedAt`, and the reassessment is measured from
that publish. New `plannedReassessmentAt` recomputes it, forward in time only,
and is used as a fallback by both the heartbeat and the chart's time markers.
After: `Standing aside: … · re-reading at 10:23 AM`, matching the database
`runAt` exactly. Commit `bc555920e`.

The underlying server bug is filed as a separate task; the projection is still
wrong for every other consumer.

**(b) A raw literal in the status bar.** The activity segment printed
`market_watch_triggered · 4m 28s ago`, and earlier `user_message` - the run
cause verbatim. The turn timeline already renders the same event as prose via
`describeWakeTrigger`, so the bar now uses it: "A level it was watching was
reached". No raw enum appears anywhere on the page. Commit `8b6716e20`.

**(c) A negative target price.** Caught late, and the worst of the three. The
heartbeat offered to **bank the trade at -77,661.33**, and the gutter agreed.
`deriveTargetPrice` guarded a zero size but not a vanishing one: the offset is
`profit / |size|`, so as the agent scaled the short down to 0.0001 ETH against a
planned $8, `8 / 0.0001` gave an 80,000 offset and `2,338.67 - 80,000`. The
number stays finite and plausible right up until it is absurd.

It now returns `null` for a zero size and for any result that is not a finite
positive price. The sentence drops the clause the way it drops any other missing
number: `Short 0.0001 ETH from 2,338.67 · down $0.00 · out above 2,349`. Commit
`066c4aaef`.

Otherwise the sentence is correct and cross-checks against the real position. In
the holding state it read `Short 0.3128 ETH from 2,338.67 · up $0.18 · banking
at 2,313.09, out above 2,349` against a real short with entry 2,338.67 and stop
2,349. Times are clock times; no field names remain.

One deliberate behaviour worth knowing: the stand-aside clause is capped at 90
characters and ends in an ellipsis, with the full narrative on hover. That is by
design, but the cut is at a character rather than a word boundary, so it can
read `…so moment…`. Left alone; noted as a polish candidate.

### 6. Hover sync - pass, both directions

**Card → chart.** Hovering the "Stop moved" card (10:24:21.800) set exactly its
matching rug tick to `opacity 1, stroke-width 2` and dimmed all nine others to
`0.2`, and the card itself took `bg-armed/10`.

**Chart → card.** With the timeline scrolled to top and the trade card out of
view (scrollHeight 531 vs 220 visible), hovering the fill marker scrolled the
list to `scrollTop 79`, brought the card into view, and highlighted exactly that
one card.

### 7. Projection wedge - fail, then fixed

When drawn, the wedge is one `<polygon>` with a gradient fill and no endpoint
ring. But `renderPlanWedge` fell back to **the dotted projection path the wedge
was built to replace** whenever a bracket level was off-scale, and that fired in
the ordinary case: the mission's target drifted below the visible range and the
chart drew a dotted `1 5` polyline from the mark to the horizon.

The geometry already clamps a level's `y` into the frame when it sets `offScale`
(`missionChartGeometry.ts:146`), and the wedge clamps again, so an off-screen
target still closes a shape that points the right way. Dropped `offScale` from
the guard; only a genuinely missing bracket still falls back. After: the
projection is one `<g>` holding a single polygon, zero dotted polylines, zero
circles. Commit `1404343d7`.

### 8 and 9. Motion - pass

No `infinite` iteration count on any `mission-*` animation. `mission-chip-arm`,
`mission-chip-fire`, `mission-card-flash`, `mission-analysing-dot` are all `1`;
`mission-chip-retire`, `mission-stub-draw`, `mission-line-draw`,
`mission-plot-settle` are single-shot `forwards`/`both`. The only `infinite`
animations in `index.css` are unrelated (skeleton shimmer, status pulse).

`flyChipToCard` is a single 520ms WAAPI flight that removes its ghost on finish,
and returns early under reduced motion so no ghost is ever created. The PnL
count-up is a one-shot rAF over 600ms that cancels on cleanup and snaps
instantly under reduced motion.

Under an emulated `prefers-reduced-motion: reduce`, **zero** elements matching
`[class*="mission-"]` had a running animation; stub, chip and mark dot all
computed `animation-name: none`, `duration 0s`, and the chip's slide transition
computed `none`. Screenshot `05`.

### 10. Reduced transparency - fail, then fixed

Under an emulated `prefers-reduced-transparency: reduce`, the panel correctly
went solid but a **level chip still computed `backdrop-filter: blur(8px)` over a
0.62-alpha fill**. The fallback lived inside `@layer components`, and the chips
carry Tailwind's `backdrop-blur-sm` utility directly; layer order is decided
before specificity and Tailwind declares `utilities` after `components`, so the
utility won. A frosted fill in front of a price is the one thing this fallback
exists to prevent.

Moved the block out of the layer - unlayered styles outrank every layered one,
so no `!important` was needed. After: chips and panels both compute
`backdrop-filter: none` over an opaque fill. Commit `f052571c7`. Screenshot
`06`.

### 11. Disconnected and recovery - pass

The feed was cut at the browser with CDP offline rather than by killing the
backend, deliberately, so the live testnet mission kept running. Within 2s the
banner rendered: **"George's MacBook Pro: Offline - Reconnect this environment
before sending messages or running actions"**, with Reconnect and Connections
actions. Restoring connectivity cleared it within 2s and the panel resumed
live. Screenshots `16`, `17`.

### 12. Em-dashes - pass

Scanned the rendered DOM, not just the source. Of 84 visible text nodes, the
only match was inside an inline `<style>` element's CSS comments. **Zero
em-dashes in visible UI text.** `missionTurnTimeline.ts` actively strips
em-dashes out of model-authored prose, which is why server text stays clean.

### 13. No-mission composed state - pass

On a fresh draft thread in the same project, the mission panel, heartbeat,
status bar, chart and header pill are all absent and the composer stands alone
("What should we build in project?"). The cockpit contributes nothing when there
is no mission. Screenshot `18`.

### 14. Initial-load skeletons - partially exercised

Honest result. Polling every 110ms through a cold load, I caught a frame with a
live `animate-skeleton` element while the panel was still populating
(screenshot `19`), but the dev server hydrates fast enough that the full
skeleton composition never held long enough to photograph cleanly. Attempts to
hold it open with CDP network throttling starved the unbundled dev module graph
and timed out the navigation instead. The skeleton path is present and rendered;
a full-panel skeleton capture is **not** claimed.

## Not exercised

- **Mission complete / settled state.** The mission was still holding when this
  pass ended and was left running rather than force-closed.
- **Blocked / stand-down state.** The mission was never paused or revoked.
- **Full-panel loading skeleton**, as described above.

## Fixes landed

Seven commits on `main`, not pushed:

| Commit      | Fix                                                                                      |
| ----------- | ---------------------------------------------------------------------------------------- |
| `bc555920e` | Heartbeat and time axis state the reassessment the plan names when no watch is projected |
| `2f1d14243` | Time chip docks at its moment instead of hanging backwards across `now`                  |
| `f052571c7` | Reduced-transparency fallback beats the chips' own blur                                  |
| `8b6716e20` | Status bar says why the mission woke instead of printing the literal                     |
| `18ddf79cf` | Heartbeat strip gets a surface so the transcript cannot show through it                  |
| `1404343d7` | Plan wedge stays one shape when a bracket level is off-scale                             |
| `066c4aaef` | No target named when the size cannot reach the planned profit                            |

`18ddf79cf` came out of the 1100px pass and is not on the original checklist:
the panel is an overlay and the thread scrolls under it, so the bare
transparent heartbeat paragraph had transcript prose painted directly behind
it - at 1100px two lines of text collided outright.
`elementsFromPoint` at the strip's own centre returned a `chat-markdown`
paragraph immediately beneath it. It now carries the panel's own glass, sized
with `w-fit` so the air above the cards survives.

## Known issues not fixed

- **Server projection staleness** (root cause of fix 1). Watches armed at
  runtime never refresh the mission projection, so `mission.watches` reads empty
  while watches are genuinely armed. The web fallback covers the reassessment
  time only; price-style runtime watches have no equivalent. Filed as a
  follow-up task.
- **Time chips can overlap.** Two chips whose moments are close overlapped by
  15px (`921-992` against `977-1048`). This is pre-existing - under the old
  right-anchoring they overlapped by the same 14px - and the explicit
  non-overlap requirement is scoped to the price-gutter level chips, which pass.
  Time chips have no collision layout, unlike the price gutter.
- **Raw order hashes in the watch stream.** Rows render as
  `Order 0x6ccd84d05d8e970d34d376978cd…`. Cosmetic.
- **Stand-aside clause truncates mid-word** at its 90-character cap.
- Transcript text is faintly visible through the ~18px gap between the two glass
  cards at 1100px. Intended "air between cards"; noted only for completeness.

## Gates

- `@t3tools/web` typecheck: clean.
- `@t3tools/web` tests: **228 files, 2353 tests, all passing** (7 added).
- `vp lint`: **0 errors** (pre-existing warnings only, none in the changed code).

The **R5 agent-discretion demo gate is satisfied**: the mission ran clean end to
end from a prompt that named no strategy and no execute verb - it read the
market, chose a playbook, stood aside when nothing set up, switched character,
entered, moved its stop and scaled out, explaining each plan in plain language.

## Screenshots

| File                                          | State                                                           |
| --------------------------------------------- | --------------------------------------------------------------- |
| `cockpit-01-light-1600-standaside.png`        | Stand-aside, before the heartbeat fix                           |
| `02-light-1600-standaside-fixed.png`          | Stand-aside with `re-reading at 10:23 AM` and the reassess chip |
| `03-light-1600-holding.png`                   | First holding state, light                                      |
| `04-dark-1600-holding.png`                    | Holding, dark                                                   |
| `05-dark-1600-reduced-motion.png`             | `prefers-reduced-motion: reduce`                                |
| `06-dark-1600-reduced-transparency-fixed.png` | `prefers-reduced-transparency: reduce`, after the fix           |
| `07-dark-1600-holding-full.png`               | Full panel, dark, holding                                       |
| `08-dark-1100-holding.png`                    | 1100px, heartbeat colliding with the transcript                 |
| `09-dark-1100-holding-fixed.png`              | 1100px after the heartbeat surface fix                          |
| `10-light-1100-holding.png`                   | 1100px, light                                                   |
| `11-light-1600-holding.png`                   | 1600px, light                                                   |
| `12-light-1600-holding-final.png`             | Final, light, 1600                                              |
| `13-light-1100-holding-final.png`             | Final, light, 1100                                              |
| `14-dark-1600-holding-final.png`              | Final, dark, 1600                                               |
| `15-dark-1100-holding-final.png`              | Final, dark, 1100                                               |
| `16-dark-1600-disconnected.png`               | Offline banner                                                  |
| `17-dark-1600-recovered.png`                  | Recovered                                                       |
| `18-dark-1600-no-mission.png`                 | No-mission composed state                                       |
| `19-dark-1600-loading-skeletons.png`          | Loading frame with a live skeleton                              |
| `20-dark-1600-target-fixed.png`               | Heartbeat after the negative-target fix                         |
