# Cockpit audit — R6 overhaul, Phase 0

Scope: `apps/web/src/components/trading/*`. No server files are in scope; every
datum the redesign needs is already on the mission projection
(`OrchestrationTradingMission`) or the chart feed. **No server-side projection
fields are required.**

## Current structure

### What draws on/around the chart (`MissionPriceChart.tsx`, pure SVG)

| Element                                                                            | Where                                                                          | Persistent?                   |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------- |
| Horizontal level rules (entry, stop, target, liq, armed conditions, pending order) | full plot width, record segment to `now` + hypothetical dashed segment past it | YES — the main clutter source |
| Future time markers (reassess queue)                                               | full-height vertical dashed rules in the future gutter + a caption label       | YES                           |
| Past-event markers (wakes, publishes, stop moves)                                  | 6-unit ticks along the bottom edge ("rug")                                     | small, keep                   |
| Plan projection                                                                    | dotted path mark → expected price + hollow endpoint ring                       | thin, but is a "line"         |
| Fill markers                                                                       | 7px circles on the price path (open=filled, close=hollow)                      | small, keep                   |
| Right price gutter                                                                 | HTML text tags (price over caption) with collision layout, leader lines        | text, not chips               |
| Grid rules + labels, mark dot, crosshair, drag rule/readout                        | fine                                                                           | keep                          |
| Grab strips (drag stop/target)                                                     | invisible 9px strips at level y                                                | keep                          |

### Side panel (`MissionLivePanel.tsx`, 2623 lines)

- Chart card (left): `ChartPriceHeader`, `ChartSlot`, `RiskRewardBar`.
- Readout card (right, 400px): StateChip/P&L, progress rule, StatGrid,
  PositionSkeleton, `WatchStream` (armed sticky + settled scrollback,
  per-watch `<details>`), RevisionNote.
- PositionLedger (spans both), `MissionStatusBar` (one-sentence headline +
  plan popover + countdown + projection + ambient facts).
- State model: `PanelState = planning | armed | live | complete`; module-level
  collapse map; 250ms ticker.
- Derivations live in `tradingPresentation.ts` (pure): `deriveStrategyPlan`,
  `deriveWatchConditions`, `deriveWatchLifecycle`, `deriveChartTimeMarkers`,
  `deriveChartPastMarkers`, `deriveChartFillMarkers`,
  `deriveNextReassessmentAt`, `deriveTargetPrice`, etc.
- Geometry: `missionChartGeometry.ts` (pure, 1607-line test file) — levels,
  gutter tag collision layout (`layoutGutterLabels`), clustering, caps
  (`MAX_DRAWN_CONDITIONS = 2`, `MAX_DRAWN_TIME_MARKERS = 5`).

### WS push path

`ChatView.tsx` mounts `MissionLivePanel` above the composer with the mission
projection (3s poll, freshest mark). `useTradingMarketChart` polls candles
(15s). `missionTimeline` (newest-first, bounded server-side) feeds past
markers and the status bar's last-activity line. `mission.watches` carries
armed predicates incl. `candle_close.interval`. No new events needed.

### Design tokens in use

`--color-profit/loss/armed/info/foreground`, `--color-long`; glass via
`.mission-panel-glass` (backdrop blur + inner highlight, dark variant,
`index.css` ~609-695); mono numerals throughout; radius: `rounded-xl` cards /
`rounded-lg` inner / pills `rounded-full` — one consistent system.

## What to preserve (operator explicitly likes)

- The glassmorphic blur (`.mission-panel-glass`) and the panel skeleton
  (two cards + status bar layout, collapse row, loading skeletons).
- Bottom rug of past-event ticks; fill circles; crosshair; drag affordance.
- The WatchStream's data contract and the WS event names — untouched.

## What to retire

1. **Every persistent full-width horizontal rule** (record + hypothetical
   segments for entry/stop/target/liq/conditions/pending order). Levels become
   glass chips docked in the right price gutter at their price.
2. **Every full-height vertical time rule.** Time markers become chips in the
   bottom axis gutter's future zone.
3. The dotted projection line + endpoint ring → replaced by one translucent
   plan wedge (Phase 3).
4. Leader lines (no persistent rules left to point at).

## File-level phase plan (adjusted from brief)

- **Phase 1** (`MissionPriceChart.tsx`, `index.css`): chips in both gutters,
  hover-to-reveal temporary hairlines, bracket stubs (last ~15% width) for a
  live position's stop/target, fill-marker tooltips, "+N" overflow chip.
  `missionChartGeometry.ts` is untouched (its layout math is reused as-is; its
  1607-line test file stays green).
- **Phase 2** (new `missionHeartbeat.ts` + `.test.ts`, `MissionLivePanel.tsx`):
  one pure function mission-state → sentence; strip rendered above the chart
  card; candle interval rendered from the watch's own `interval` data.
- **Phase 3** (new `missionSelectionStore.ts` (zustand, repo standard),
  `MissionLivePanel.tsx`, `MissionPriceChart.tsx`, new `missionTurnTimeline.ts`
  - tests) — AS BUILT: shared hover/selection between chart chips/markers and
    WatchStream/ledger rows; plan wedge from mark toward target over
    `byMinutes`, invalidation as hard edge; and the TURN TIMELINE — one card per
    wake (why it woke, what it read that turn, what it decided) plus plan
    revision, journal note, and trade cards, newest first, derived from the
    already-pushed `missionTimeline` prose and `recentFills`. The read line is
    the one addition after the fact: wake timeline entries now also carry the
    run's already-recorded tool-call list (`tools_called_json`, migration 051),
    projected read-only as an optional `toolsCalled` field on the wake entry;
    the client translates the tool names into plain words. What it does NOT
    show is the finer detail the plan's example gestured at ("structure ·
    levels · scan" style fetch keys): the fetch keys a `trading_look` call
    named are not recorded anywhere, so they cannot be projected without new
    recording, which would touch trading behavior. Card
    hover claims the moment on the chart (rug tick glow, others dim); chart
    chip/tick/fill hover scrolls to and highlights the matching card.
- **Phase 4** (`index.css`, `MissionLivePanel.tsx`, `MissionPriceChart.tsx`) —
  AS BUILT: the full chip lifecycle (arm = one soft pulse keyed off the
  watch's armed identity, never a remount; fire = the existing ripple, then a
  single ghost element flies from the gutter chip to the turn timeline card
  over ~520ms and is removed, the card flashing briefly, skipped gracefully
  when the card is absent; retire = one fade-out ghost at the chip's last
  dock, then gone), plus the earlier bracket draw-in and PnL count-up. All
  one-shot transform/opacity, all collapsed to instant (or not mounted) under
  `prefers-reduced-motion`. Glass per skill rules.
- **Phase 5**: `test-t3-app` skill, isolated state dir, seeded fixture states,
  screenshots dark/light × desktop/1100px.

## Constraints honored

Web-only; no WS event renames; trading behavior untouched; panel data contract
intact (WatchStream props unchanged in shape, only hover handlers added).
