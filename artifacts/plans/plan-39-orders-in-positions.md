# Plan 39 — one Positions surface, a pure Agent Log, a chart that never moves

Execute end to end. Verify live in the browser after every phase. Do not ask
questions; every decision below is made.

## Doctrine

Evolve the cockpit, do not restyle it. Keep `.mission-panel-glass`, the pill
vocabulary (`h-7 rounded-full border px-2 font-mono text-[11px] tabular-nums`),
the legend caps (`BAND_LEGEND_CLASS`), mono/tabular figures, the prose-vs-mono
split, and the existing tokens: `--color-armed` amber = committed-not-exposed,
`--color-info` blue = arrival, `--color-profit/--color-loss` = **money only**,
muted = settled. **No exemptions** — settled in the phase-5 pass: the chart
header's 24h change gave up its profit/loss ink and now wears `text-foreground/70`
with its sign intact, because a green day-change beside a red mission P&L read as
the mission being up when it was down. No new palette, no new radius scale, no type sizes outside
10.5 / 11 / 11.5 / 12 / 13.5px. A reader who knows today's panel must recognise
tomorrow's instantly.

Animation doctrine, already established in `apps/web/src/index.css` (~660-800):
one-shot only, never looping, ≤700ms, spring `cubic-bezier(0.34,1.56,0.64,1)`
for arrivals, `ease-out` for departures, every one switched off under
`@media (prefers-reduced-motion: reduce)`, and every enter keyed on identity so
the 3s poll cannot replay it (the trap `mission-chip-arm` documents).

## Files

- `apps/web/src/components/trading/MissionLivePanel.tsx` (3320) — layout
  (804-1105), constants (220-321), `StatGrid` (1295), `PositionSkeleton` (1409),
  `PositionLedger` (1484), `LedgerRow` (1666), `WatchStream` (2023),
  `TurnTimeline` (2302), `turnCardIdentity` (2368).
- `apps/web/src/components/trading/tradingPresentation.ts` — `derivePositionLedger`
  (2518), `deriveRoundTrips`, `WatchStreamRow` (1526), `deriveUpNextItems` (1817).
- `apps/web/src/components/trading/missionTurnTimeline.ts` — turn cards.
- `apps/web/src/components/trading/MissionPriceChart.tsx` — SVG root (841).
- `packages/contracts/src/trading.ts` — `OrchestrationTradingMission` (246),
  `TradingExecutionView` (57), `TradingFillView` (76).
- `apps/server/src/trading/TradingMissionProjection.ts` — `readExecutionSurfaces`
  (~624-712).
- `apps/web/src/index.css` — mission keyframes ~660-800.

---

## Phase 0 — the missing data (server, additive)

The projection carries **one** non-terminal order (`inFlightExecution`, statuses
`reserved|submitted|accepted`) and fills already collapsed per `order_id`. An
order lifecycle cannot be drawn from that. Everything needed is in SQLite:
`trading_execution_records` (migration 038 — `cloid`, `action_type`, `side`,
`size`, `limit_price`, `time_in_force`, `reduce_only`, `status`, `created_at`,
`updated_at`) joined to `trading_fills` on `cloid`. Status vocabulary, verbatim:
`reserved → submitted → accepted → filled | cancelled | rejected`.

1. Add `TradingOrderView` to `packages/contracts/src/trading.ts` beside
   `TradingExecutionView`: `executionId, cloid, actionType, side, market, size,
   limitPrice, timeInForce, reduceOnly, status, filledSize, avgFillPrice
   (nullable), feeUsd, closedPnl, orderId (optional), createdAt, updatedAt`.
2. Add `orders: Schema.Array(TradingOrderView)` to `OrchestrationTradingMission`.
   Additive only — rename nothing, keep `inFlightExecution` and `recentFills`.
3. In `readExecutionSurfaces`, one new query: every execution record for the
   mission `LEFT JOIN` the per-order fill aggregate (`SUM(filled_size)`,
   size-weighted `avg_fill_price`, `SUM(fee_usd)`, `SUM(closed_pnl)`),
   `ORDER BY updated_at DESC LIMIT 50`. Mirror the existing cap comment.
   Three corrections to that query, decided:
   - **Filter to orders.** `action_type` is not just open/close — the records
     table also holds `modify_stop` and `cancel` actions
     (`TradingStopAdjustmentService`, `HyperliquidExecutionService`). Those are
     not orders and must not become ledger rows: filter
     `action_type IN ('open','scale_in','close','reduce','reduce_only_exit')`.
     A stop move is an Agent Log row (Phase 3's `ShieldCheck`); a cancel action
     surfaces as its *target* order's `cancelled` status, never as a row of
     its own.
   - **Join on both keys.** `trading_fills.cloid` is nullable (migration 038
     line 77) — an exchange-reconciled fill can arrive without one, and the
     existing `plannedRisk` query already guards `cloid IS NOT NULL` for
     exactly this reason. Aggregate fills by `COALESCE(cloid, execution_id)`
     and join that key against the record's `cloid` *and* `execution_id`, so
     no fill silently drops off its order.
   - **Use `trading_orders`.** Migration 038 also keeps a reconciled
     open-order table — `(mission_id, cloid) → order_id, remaining_size` —
     that the reconciler holds current even when fill rows lag. `LEFT JOIN` it:
     `orderId` comes from there, and partial progress is
     `1 - remaining_size/size` when the row exists, the fill sum otherwise.
4. `TradingMissionProjection.test.ts`: one case per terminal status, one partial
   fill (`filled_size < size`), one order with no fills at all.

---

## Phase 1 — a chart that never moves

Two faults. The ledger is a sibling `<section>` **below** `CARD_ROW_CLASS`
([MissionLivePanel.tsx:1046](apps/web/src/components/trading/MissionLivePanel.tsx:1046)),
so a position appearing reflows the row and shoves the chart up — and the panel
is bottom-docked above the composer, so it grows *upward* and the chart jumps.
Meanwhile the chart is pinned at `CHART_HEIGHT_CLASS = "h-[260px] w-full
sm:h-[340px]"` (line 220) while a third of the viewport above sits empty.

**The rule: every height in the panel is reserved, not reactive.** Nothing on
screen may move because state changed. This is the panel's own stated principle —
`PositionSkeleton` exists because "the card does not reflow at the one moment the
operator is watching it hardest" (line 1409). Extend it to the whole panel.

- The card row takes a fixed target height, `lg:h-[min(70vh,780px)]` with
  `lg:min-h-[440px]`, and gains `lg:items-stretch`. Both columns are `h-full`.
- Left column: `flex min-w-0 flex-1 flex-col gap-3` holding the chart card and,
  under a clear glass boundary of its own gap, the positions card.
- The positions card is **always mounted and always the same height**
  (`lg:h-[268px] flex-none`), never conditionally rendered. With nothing to show
  it draws its empty state — same headings, same row rhythm, in the
  `PositionSkeleton` idiom, naming the columns that are about to fill.
- The chart card is `flex-1 min-h-0`, so with a fixed parent and a fixed sibling
  its height is fixed too. It changes only when the window resizes. Delete the
  standalone ledger section and the `max-h-[220px]` on the turn scroller.
- `CHART_HEIGHT_CLASS` becomes `h-[260px] w-full sm:h-auto sm:min-h-[300px]
  sm:flex-1` inside a `flex min-h-0 flex-col` card. The SVG is already
  `preserveAspectRatio="none"` + `h-full w-full` with viewBox-percentage overlays
  ([MissionPriceChart.tsx:841](apps/web/src/components/trading/MissionPriceChart.tsx:841)),
  so it stretches to any height with no geometry change. Give the same
  `flex-1 min-h-0` to all three `ChartSlot` placeholder branches (skeleton,
  "Chart unavailable", "Building chart…") so the card can never collapse.
- Right column: `READOUT_WIDTH_CLASS lg:flex-none h-full flex flex-col min-h-0`;
  its log region is `flex-1 min-h-0 overflow-y-auto`, so it absorbs slack instead
  of dictating height. Its fixed width is why Positions belongs on the left.
- **Equal height is CSS stretch, never JS.** No `ResizeObserver`, no measured
  heights, no arithmetic matching. Below `lg` everything stacks intrinsically.
- No `transition-[height]` anywhere. A height that never changes needs no easing;
  a transition here would only make a bug look intentional.
- **`RiskRewardBar` is the last thing that can still move the chart.** It
  unmounts on stand-aside and on missing figures
  ([MissionLivePanel.tsx:1218](apps/web/src/components/trading/MissionLivePanel.tsx:1218)),
  and inside the new fixed column with a `flex-1` chart, its appearing steals
  chart height between the planning and waiting states — Phase 5 check 1 fails
  as written. Decision: the strip is **always mounted at a fixed height**, the
  panel's reserved-height rule applied to itself. With no committed plan it
  draws the same band with both segments in muted ink, an em-dash ratio, and
  the reading `no committed risk` — the same naming job `PositionSkeleton`
  does for the grid.
- **The heartbeat clamps to one line** (`truncate`). It is `w-fit max-w-full`
  today ([MissionLivePanel.tsx:822](apps/web/src/components/trading/MissionLivePanel.tsx:822))
  and a long sentence wraps to two lines, moving the panel's top edge — the
  exact motion this phase exists to kill. The full sentence already rides the
  `title` hover, so nothing is lost.
- Add `data-testid`: `mission-chart-column`, `mission-positions`,
  `mission-agent-log`.

---

## Phase 2 — Positions: one place, one row per leg

One glance answers everything the mission has done or is trying to do. **One
list, one row per order** — not per round trip. An order is the atomic thing the
exchange acts on, and a filled opening order *is* the position it created, so
one row per leg is the only model that holds pending orders, partial fills and
positions in one column without inventing a second grammar. This is also what
"don't combine open and close" means: an open leg and a close leg are two rows,
never one `entry → exit` cell.

Retire the round-trip pairing from this view. `deriveRoundTrips` and
`derivePositionLedger` stay in `tradingPresentation.ts` with their tests; the
ledger simply stops calling them. Add `deriveOrderLedger(mission, markPrice,
nowMillis)` returning one row per order, newest first, merging
`mission.orders` with the live position for the leg that is still open.

### Row states

| status | word | reads as |
| --- | --- | --- |
| `reserved` | `queued` | muted, no figures yet |
| `submitted` / `accepted` | `working` | armed amber, limit price live |
| filled `0 < f < size` | `partial` | armed amber + fill track |
| `filled`, opening leg, still held | `open` | info, **live** mark/P&L/fee |
| `filled`, closing leg | `closed` | muted, realised figures frozen |
| `cancelled` | `cancelled` | muted |
| `rejected` | `rejected` | loss ink |

**An eighth state, `planned`, closes a hole the plan left open.** Once the
right column is pure log, the armed-state `StatGrid` branch — SIZE / RISK /
TARGET, [MissionLivePanel.tsx:1338](apps/web/src/components/trading/MissionLivePanel.tsx:1338)
— has no destination anywhere in this document, and a mission waiting on a
*trigger* (no resting order yet) would show an empty positions card while
committed to $892 of size. Decision: while the plan commits an entry that no
live order covers, the card draws one **`planned` ghost row** — dashed border
in the `PositionSkeleton` idiom, muted, planned size and entry price, `—` for
every figure it does not have. The first real order replaces it in place,
keyed on identity so the swap animates once (`mission-order-settle`, not a
fresh enter). With this row the card is empty only before the first plan
exists — the empty state's job shrinks to the planning state.

**Open vs close is carried by colour AND by fill**, reusing the chart's own
established convention — its fill markers are already `open = filled circle,
close = hollow circle`. So an opening leg's state token is solid `--color-info`;
a closing leg's is a hollow ring in `text-foreground/70`. Green and red stay
reserved for money, which is why open/close does not borrow them.

### Mandatory columns, in order

1. **Identity** — the existing `SideChip`: `ETH · 1x · Long`. Unchanged pill.
2. **State** — the token above; solid for open legs, hollow for close.
3. **Entry / Exit** — the price this leg executed at (limit price while working).
   One price per row, because one row is one leg.
4. **Size** — **tap to toggle** between asset units (`0.0066 ETH`) and USD
   notional (`$16.00`). **Defaults to USD notional** — the product
   realignment says consumer tool, and a consumer thinks in dollars; units
   are the toggle's second reading, not its first.
   The toggle is one panel-wide preference, not per row:
   a zustand store beside `missionSelectionStore.ts`, persisted to
   `localStorage`, so every row switches together and the choice survives a
   reload. Toggling animates as a 180ms cross-fade on the figure only — the
   column does not resize (reserve the wider of the two widths).
   Header cell is the button; rows are also tappable. Keyboard reachable,
   `aria-pressed`, and the sr-only label states both readings.
5. **USD value** — the leg's money outcome, **net of fees**: live unrealised
   P&L minus fees paid while the leg is open, realised net once closed, `—`
   while queued/working. Profit/loss ink. This is the one column that may use
   the money palette.
6. **Time** — clock time for a settled leg, live relative age (`12s`) for a
   working or open one, ticking off the panel's existing 250ms ticker.

**No fee column.** Six columns, not seven: the USD column is already net, so
a standing fee column restates a figure the net absorbed, and at 1100px the
left column is ~610px — six columns rule up without truncation, seven fight
for it. The per-leg fee lives in the expanded `LedgerDetail`, beside mark /
liq / margin, accumulating live across partial fills.

Cap 6 rows plus `+N earlier`. The live band — queued / working / partial, and
the open leg — is pinned; settled legs scroll beneath it in
`flex-1 min-h-0 overflow-y-auto`. That is the same shape `WatchStream` already
uses (armed sticky, settled scrollback), so it reads as the house pattern.
Never drop a row to save height: the card's height is fixed and the scroller is
what bounds it.

### The position's own figures come here too

With the right column becoming pure log, `StatGrid`'s cells (SIZE / ENTRY /
MARK / STOP / LIQ / MARGIN / PROTECTED) and the `UNREALISED` headline move into
this card:

- Card header row: legend `positions` left; `UNREALISED  +0.07%  +$0.01`
  right, in `AnimatedUsd`, exactly as the readout renders it today. **The
  right slot is never blank**: with no open leg it shows the plan's committed
  reading instead — `-$34 → +$18` in the money inks — so the card's headline
  always answers "what is at stake", live or planned.
- The six cells become the **expanded detail of the open row** — the existing
  hover-tooltip / press-popover on `LedgerRow` already exists for this; extend
  `LedgerDetail` to carry them rather than building a second surface.
- `PositionSkeleton`'s naming job passes to the card's empty state.

Also retire from the right column: the `order_update` watch row and the
`"order working"` `UpNextItem` in `deriveUpNextItems` (1834). Both live here now.

---

## Phase 3 — the right column becomes purely the Agent Log

Nothing but log. The state chip, P&L header, progress rule, side chips,
`StatGrid` and `PositionSkeleton` all leave (Phase 2 says where they go). What
remains: a header reading `agent log`, armed alerts pinned at the top, and one
chronological scrollback merging today's `WatchStream` settled rows and
`TurnTimeline` cards.

More visual, not more text. Every row is
`[2px tone rail][16px round icon token][one clamped prose line][mono figure][clock]`.
The rail carries the class colour (armed / info / profit / loss / muted); the
token is `size-4 rounded-full grid place-items-center bg-<tone>/10` with an 11px
lucide glyph inside. That replaces today's bare 11px grey glyph and gives each
row a silhouette readable at a glance without adding a word.

Icon map, replacing `turnCardIdentity`'s Radar / FileText / FileText / Receipt:

| meaning | glyph | tone |
| --- | --- | --- |
| woke on a timer | `AlarmClock` | muted |
| woke on a level | `Zap` | info |
| looked at the market | `Eye` | muted |
| read a strategy sheet | `BookOpen` | muted |
| plan published / revised | `Route` | info |
| stood aside | `Hand` | muted |
| watch armed | `Crosshair` | armed |
| watch fired | `BellRing` | info |
| watch retired / replaced | `CircleSlash` | muted |
| stop moved | `ShieldCheck` | armed |
| journal note | `NotebookPen` | muted |
| fill / trade | `Receipt` | profit / loss |

Keep the chart↔log selection join (`data-timeline-card`, `data-watch-chip`,
`flyChipToCard`), the take-down group folding, the `+N earlier` counts, and the
sr-only kind word on every row.

---

## Phase 4 — the transitions

Positions is a live surface; a state change must be *seen*, never merely found
on the next poll. Add beside the existing `mission-*` keyframes in `index.css`,
all one-shot, all identity-keyed, all reduced-motion guarded:

- `mission-order-enter` — 380ms, `translateY(6px) + scale(0.97) → 1` + fade, on
  the spring curve. A new order row.
- `mission-order-settle` — 320ms cross-fade of the **state token only**; the row
  does not move, so the eye stays on the figures.
- `mission-order-filled-ring` — 620ms single ring pulse in `--color-info` as a
  leg becomes `open`; `--color-profit` when a closing leg settles in profit,
  `--color-loss` when not.
- `mission-order-exit` — 420ms ease-out fade + `translateX(6px)` on cancel or
  reject, same grammar as `mission-chip-retire`.
- `mission-log-enter` — 260ms fade + `translateY(4px)` for a new log row; the dot
  keeps `watch-tick-in`.
- Partial-fill track — an inset `absolute inset-y-0 left-0 rounded-full
  bg-armed/12` behind the row, width `filledSize / size`, driven by
  `transition-[width] duration-600 ease-out`. A CSS transition, not a keyframe,
  so successive partials grow it continuously instead of restarting.
- Size-unit toggle — 180ms cross-fade on the figure, no reflow.
- Money figures keep `AnimatedUsd`. Do not write a second number-roll.

---

## Phase 5 — the discrepancy sweep (mandatory, not optional)

After Phase 4, audit the whole panel live and fix what you find. Produce a
findings table — `file:line`, the defect, the fix, before/after screenshots —
and patch every one. Do not report a defect you did not fix; if something is out
of scope, say so explicitly and why.

Cover, in the browser, for **all four panel states** (planning, waiting, holding,
complete) × **1440 / 1100 / 820px** × **light and dark**:

1. **Motion** — the panel's `top` and the chart's `height` must be byte-identical
   across all four states. Anything that moves when state changes is a defect.
   (This is an `lg:` invariant — below `lg` the panel stacks and grows
   intrinsically, so assert it at 1440 and 1100 and *not* at 820, where only
   the overflow and figure checks apply.)
2. **Overflow** — no horizontal page scroll; every wide region scrolls inside its
   own container; no clipped glyph, no truncated figure, no text riding a border.
   Check the panel header's clip at narrow widths specifically.
3. **Figures** — every number mono + `tabular-nums`; no `NaN`, `undefined`,
   `Infinity`, `$0.00` where a value exists, or `-` where one is known; signs and
   currency consistent; percent and USD never swapped.
4. **Ink** — profit/loss used for money only; armed/info used per doctrine;
   no hard-coded hex; both themes legible; disabled/muted states still ≥4.5:1.
5. **Live** — with a mission running, confirm mark, P&L, fee, fill progress and
   relative times all update without a reload, and that a 3s poll re-render
   replays no entrance animation.
6. **Console + network** — `browser_console_messages` clean; no React key
   warnings, no `act`/hydration warnings, no failed requests.
7. **Reduced motion** — re-run with the emulated preference; every animation
   must be off and every layout identical.
8. **Keyboard + a11y** — tab through the new size toggle, the order rows and the
   log; visible focus ring on each; `aria-pressed` on the toggle; every row's
   sr-only label reads the whole row back as a sentence.
9. **Empty and degraded** — no orders, no position, chart error, stale chart,
   rejected-only history. Each must draw its reserved shape, not a hole.
10. **A known doctrine breach to settle** — the chart header's 24h change
    already wears `text-profit`/`text-loss`
    ([MissionLivePanel.tsx:1147](apps/web/src/components/trading/MissionLivePanel.tsx:1147))
    for a figure that is not this mission's money. Either recolor it to
    foreground/muted, or write the exemption into the doctrine block at the
    top of this file in words. Decide once, in this pass — do not leave the
    doctrine and the code disagreeing.

---

## Live verification loop (Playwright MCP — run it every phase, not just at the end)

1. `vp run dev` from the repo root, backgrounded. Read the `[dev-runner]` line
   for the web port and the `/pair#token=...` URL. Never pass `--browser`.
2. `browser_navigate` the complete pairing URL exactly once, as the first
   navigation, fragment verbatim. Keep that tab for the whole loop.
3. Open a trading thread with a live mission. For states live testnet will not
   produce on demand (`reserved`, partial, `cancelled`, `rejected`), stop the
   server, seed `trading_execution_records` / `trading_fills` with
   `node apps/server/scripts/t3-sqlite-state.ts exec`, restart on the same base
   dir. Read `.agents/skills/test-t3-app/references/sqlite-fixtures.md` first.
   Never touch `~/.t3`.
4. Every phase: `browser_take_screenshot` at each width,
   `browser_console_messages` (clean), and `browser_evaluate` asserting
   - `|rect(mission-chart-column).height - rect(mission-agent-log).height| <= 1`
   - `rect(mission-live-panel).top` identical across all four states
   - `rect(mission-chart-column).height` identical across all four states
   - `rect(mission-live-panel).height` greater than the pre-change baseline
     (record it before touching anything).
5. Walk one order `working → partial → filled → closed` and screenshot each step,
   to confirm the transitions read as motion rather than as a re-render.
6. Keep the environment alive between phases; tear down only at the very end.

## Gates

- `pnpm tc`
- `vp run --filter @t3tools/web test` and `--filter @t3tools/server test`
- Updated: `tradingPresentation.test.ts` (new `deriveOrderLedger` — one case per
  status, partial fill, open-leg live figures, unit toggle),
  `missionLivePanelState.test.ts`, `TradingMissionProjection.test.ts`
- Final report: the Phase 5 findings table, plus before/after screenshots of all
  four states side by side.

## Out of scope

Chart internals (`missionChartGeometry.ts`, the SVG's own drawing), the status
bar's sentence, the thread receipts, any trading behaviour, any event rename,
any change to what the agent is allowed to do.

**Charting library: decided against, not deferred.** The chart draws
`VISIBLE_BARS = 24` points on a 15s poll, so there is no performance problem for
a canvas renderer to solve — a library would cost 40-150KB gzipped and forfeit
CSS-token styling to render what one SVG path already does. Everything that makes
this chart worth keeping (gutter level chips with collision layout, drag-to-move
stop and target, the projection wedge, the past-event rug, watch chip
arm/retire/fire, the chart to log selection join) would have to be rebuilt against
a primitives API, discarding 1448 lines of tested geometry and its 1618 lines of
tests. Revisit only on a concrete trigger: real candlesticks, interactive
zoom/pan, or multi-timeframe overlays over hundreds of bars.
