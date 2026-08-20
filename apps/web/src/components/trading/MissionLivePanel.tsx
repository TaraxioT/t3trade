// ---------------------------------------------------------------------------
// MissionLivePanel
// ---------------------------------------------------------------------------
//
// The one pinned trading surface, docked directly above the composer. It
// replaces four separate ones — the position-gated chart dock, the plan card,
// the armed-conditions card, and the timeline's position card — which used to
// stack as boxes saying overlapping things, each consuming timeline height
// whether or not it was the thing the operator was looking at.
//
// Four explicit states, driven purely by the projection:
//
//   planning  no strategy yet          → chart + mark, "Analysing the market…"
//   armed     strategy, flat, watching → chart + condition levels + plan summary
//   live      position open            → the same, plus P&L and the held figures
//   complete  mission finished         → the net result, kept for good (plan 27 H1)
//
// It is THREE panes of glass, floating clear of each other and of the composer
// below: the chart card on the left, closed by the risk/reward bar; the readout
// card on the right — the side chip and the P&L, the progress rule, the thesis,
// the grid of figures the exposure is made of, and the armed watches; and under
// both of them, spanning the full width, the status bar that says in a sentence
// what the mission is doing, with the ambient facts trailing right.
// All three carry the composer's material, the same surface tint, blur,
// saturation and hairline outline, plus a 1px inner highlight along the top
// edge so each reads as a lit pane rather than a painted rectangle.
//
// One box holding everything was the first attempt and it was wrong: a price
// chart and a column of prices divided by a single hairline read as one flat
// table, and the eye had nothing to tell it where the picture ended and the
// instrument began. The gaps do that. Below `lg` the two cards stack, each
// keeping its own edges, and the bar stays under them.
//
// Proportion is the point of the row. At the panel's own width (6xl, set at
// its call site in ChatView) the readout takes a fixed 400px and the chart
// takes everything else, which is about 64/35 — a picture with an instrument
// beside it, not two columns splitting the difference. The chart is 440px tall
// because the price line is the one thing here that is read as a shape.
//
// ONE line in the picture. The chart draws closes at the runtime's own
// interval, and nothing else: no candle bodies, no moving averages. Three
// curves in one frame — price, fast EMA, slow EMA — read as three subjects,
// and the two smooth ones won, which is the opposite of the intent. Everything
// else on the chart is a level the plan drew across that line.
//
// Every figure on it is set in the mono face, at one of three sizes: the P&L
// at 24px because it is the number being read, the exposure figures and the
// watch rows at 12px because they are read down a list, and the labels that
// name them at 10.5px. Prose — the plan's thesis, the disclosure — stays in
// the UI face. Mixing a proportional face into a column of prices is what made
// four rows of numbers read as four unrelated facts.
//
// Density is held down by cutting whole objects, not by shrinking type. Three
// things went in the pass that made this match its reference: the schedule
// strip, whose every pill named a price the chart was already drawing a rule
// at; the strip of recent wake pills, which was three amber capsules saying a
// watch had fired, on a panel whose entire subject is watches; and the EMA
// pair with its legend. What is left is a picture, a column of figures, a list
// of conditions and a sentence.
//
// A number still appears at most twice, and only when the two say different
// things: P&L, ROI and progress are header figures and the grid never repeats
// them, while entry and mark ARE in both places — as a tag on the shape and as
// a cell in the column — because the gutter says where and the cell says what.
// Hold time, funding and the day's change are true but not acted on, so they
// sit in the ambient line at the foot; the exact threshold behind each watch is
// a hover; everything the plan said is one disclosure away. Exceptions get
// louder, not quieter: a stop covering only part of the position takes a cell
// of its own, in the loss tone, because that is the difference between a
// bounded loss and an open one.
//
// `planning`, `armed` and `live` draw the same surface; what differs is how
// much of it there is anything to say about. Planning has a market, a mark, a
// candle series and a run history from its first turn, and none of that needs a
// published strategy — but it has no thesis, no levels and no target, so its
// grid holds a mark and a countdown, and the checklist, the risk/reward bar and
// the plan disclosure are absent rather than empty. Nothing on the surface is
// invented to fill the space a plan will later take.
//
// The chart's gate used to be "a
// position exists", which meant a mission spent its whole waiting phase showing
// nothing at all — and waiting is most of a mission's life. The plan's levels
// used to be gated the other way, on `armed`, so they all vanished the instant
// a fill landed. Both gates are gone: the levels change (armed draws what it is
// waiting for, live draws what it is holding against, and a PnL watch resolves
// to a price once there is an exposure to divide by), the surface does not.
//
// Everything here is read from the projection. The chart feed
// (`useTradingMarketChart`, 15s poll) supplies candles + funding/OI/volume; the
// mission poll (3s) supplies the freshest mark via `mission.marketPrice`, so the
// pill and the chart can never show two different marks. No figure is invented:
// a missing denominator omits a figure rather than guessing.

import type {
  EnvironmentId,
  OrchestrationTradingMission,
  TradingMarketChartView,
} from "@t3tools/contracts";
import {
  Activity,
  AlarmClock,
  BellRing,
  BookOpen,
  ChartCandlestick,
  ChevronDown,
  ChevronUp,
  CircleSlash,
  Clock,
  Crosshair,
  ExternalLinkIcon,
  Eye,
  FileText,
  Gauge,
  Hand,
  NotebookPen,
  Receipt,
  Route,
  ShieldCheck,
  TrendingDown,
  TrendingUp,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { type ReactNode, type RefObject, useCallback, useEffect, useRef, useState } from "react";

import { readMissionMode } from "@t3tools/trading-contracts/mode";
import { runtimeTimeframe } from "@t3tools/trading-contracts/strategy";

import type { ChartInterval } from "~/lib/tradingMarketChartState";
import { useTradingMarketChart } from "~/lib/tradingMarketChartState";
import { cn } from "~/lib/utils";
import { Skeleton } from "../ui/skeleton";

import { MissionPriceChart } from "./MissionPriceChart";
import {
  isMomentSelected,
  useMissionSelection,
  type ChartEventSelection,
} from "./missionSelectionStore";
import {
  deriveTurnTimeline,
  describeWakeTrigger,
  type TurnTimelineCard,
} from "./missionTurnTimeline";
import { useMissionPlanRevision, type MissionPlanRevision } from "./useMissionPlanRevision";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import {
  dedupeConditions,
  deriveEntryFillAtMillis,
  deriveProgressToTarget,
  deriveTargetPrice,
  selectVisibleCandles,
  MAX_DRAWN_CONDITIONS,
  type ChartLevelKind,
} from "./missionChartGeometry";
import {
  deriveChartConditions,
  deriveChartFillMarkers,
  deriveChartPastMarkers,
  deriveChartTimeMarkers,
  deriveEffectiveLeverage,
  deriveNextReassessmentAt,
  deriveStrategyPlan,
  deriveTriggerExpiryMillis,
  deriveWatchConditions,
  deriveWatchLifecycle,
  describeDelayedRead,
  formatAge,
  formatDuration,
  formatLeverage,
  formatPrice,
  formatSignedPercent,
  formatSignedUsd,
  formatSize,
  formatUsd,
  hyperliquidTradeUrl,
  isArmedRow,
  isMissionComplete,
  plannedReassessmentAt,
  deriveOrderLedger,
  type OrderLedgerState,
  type ChartFillMarker,
  type ChartPastMarkerInput,
  type ChartTimeMarkerInput,
  type OrderLedgerRow,
  type StrategyPlan,
  type WatchRowType,
  type WatchStreamGroup,
  type WatchStreamItem,
  type WatchStreamRow,
} from "./tradingPresentation";
import { useMissionSizeUnit } from "./missionSizeUnitStore";

/**
 * Module-level collapse state, keyed by mission id.
 *
 * Collapsing mission A must not collapse mission B, and the toggle must survive
 * a remount from the 3s poll. A record at module scope gives both without
 * forcing the call site to pass a `key`. The default is expanded — the panel is
 * the reason the thread is on screen.
 */
const collapsedMissions: Record<string, boolean> = {};

/** Expanded chart area height.
 *
 * Reserved, not reactive (plan 39 phase 1): inside the fixed-height card row
 * the chart card is `flex-1 min-h-0`, so at `sm` and above the chart takes
 * whatever height the fixed row leaves it and changes only when the window
 * resizes — never when state does. The mobile stack keeps the fixed 260px.
 *
 * The 300px floor applies only where the panel stacks and grows with its
 * content. At `lg` the card row is inside the shell's reserved height, so a
 * floor there is a floor the parent cannot honour: the chart overflowed its own
 * card and the card clipped it. At `lg` the chart takes exactly what the fixed
 * column leaves, which is a function of the window and of nothing else. */
const CHART_HEIGHT_CLASS =
  "h-[260px] min-h-0 w-full sm:h-auto sm:min-h-[300px] sm:flex-1 lg:min-h-0";

/**
 * The readout card's width on a wide workspace.
 *
 * Wide enough for a full watch sentence, a price and its verdict on one line
 * at 12px, which is the row this column exists to hold. At 336px the same row
 * truncated the sentence to make room for the word "waiting".
 *
 * 340px between `lg` and `xl` (plan 39 phase 5). The positions card now shares
 * the left column, and six columns of figures need ~435px to rule up; at
 * 1100px with the sidebar open the left column was 388px, so the money and
 * time columns sat outside the card and had to be scrolled to. The log gives
 * up 60px first — its rows already truncate their prose by design, while a
 * figure that has to be scrolled to is a figure the operator cannot read.
 */
const READOUT_WIDTH_CLASS = "lg:w-[340px] xl:w-[400px]";

/**
 * How often the panel's clock ticks.
 *
 * 250ms rather than a second. The axis ends at the forming bar's close, so the
 * live edge walks toward it continuously — at 1Hz that walk was four visible
 * steps a second apart, which reads as a re-render rather than as a price
 * advancing. Four ticks a second is a text update and one ~60-point polyline
 * re-render: no animation loop, no GPU work, and still nowhere near a frame
 * budget. Durations shown in seconds simply re-render the same string three
 * times out of four.
 */
const TICK_INTERVAL_MILLIS = 250;

/** Collapsed summary row height, in pixels. */
const COLLAPSED_ROW_HEIGHT_PX = 38;

/**
 * How many settled watches the stream renders before it says how many are left.
 *
 * A mission that re-levels on every bar retires hundreds of them, and rendering
 * all of them makes a 220px window into sixty screens of scroll — with the row
 * anyone would want in the first two. Forty is a few screens of genuine
 * scrollback; past that the number itself is the useful fact.
 */
const MAX_SETTLED_WATCH_ROWS = 40;

/**
 * How many of the fetched bars the live chart draws.
 *
 * The RPC serves 120 (`maxBars` in `ws.ts`), which on a 1m series is two hours
 * — wide enough that an hour-old trade is a twentieth of the frame and a minute
 * of drift is a few pixels. Sixty bars is the hour that a 1m mission is
 * actually operating on: twice the price resolution, and twice the rate the
 * series slides left.
 */
const VISIBLE_BARS = 24;

/**
 * One card of glass.
 *
 * The chart and the readout are two of these, side by side with a gap between
 * them, not two halves of one box divided by a hairline. A shared box made a
 * chart and a column of figures read as one flat table; two cards on the
 * thread's own ground read as a picture and the instrument beside it, which is
 * what they are. Each carries the composer's material — the same surface tint,
 * blur, saturation and outline — so the pair still belongs to the surface it
 * is docked above.
 */
// The bevel and the drop shadow live in `.mission-panel-glass` rather than in a
// utility here: a Tailwind `shadow-*` replaces the whole box-shadow, so setting
// the inner highlight from this side silently deleted the outer one.
const CARD_CLASS = "mission-panel-glass overflow-hidden rounded-xl border";

/** The shell: the chart and the readout on one row, the status bar under both.
 *  It draws nothing itself — the gaps are the separation, and a third surface
 *  behind three glass ones would be a fourth object on a strip that should
 *  read as one instrument.
 *
 *  The reserved height lives HERE rather than on the card row (plan 39 phase 1).
 *  The panel is bottom-docked above the composer and grows upward, so the box
 *  that must be bounded is the whole panel: with the height on the row instead,
 *  the heartbeat and the status bar added ~96px on top of it and the panel's own
 *  top edge went 41px off screen, taking the heartbeat and the chart's header
 *  with it. Fixing the outer box and letting the row take the slack keeps the
 *  chart's height reserved without hard-coding what the chrome costs. */
const PANEL_SHELL_CLASS =
  "mission-panel group/panel flex w-full flex-col gap-3 lg:h-[min(70vh,780px)] lg:min-h-[540px]";

/** The two columns' own row. Wider gap than the shell's, because these two sit
 *  shoulder to shoulder and the eye needs the seam between a picture and an
 *  instrument to be unmistakable.
 *
 *  Fixed height at `lg` (plan 39 phase 1): every height in the panel is
 *  reserved, not reactive. The row takes whatever the shell's reserved height
 *  leaves after the heartbeat and the status bar, and the pieces inside divide
 *  it — so the chart's height is fixed by CSS and changes only on a window
 *  resize. Below `lg` everything stacks intrinsically. */
const CARD_ROW_CLASS =
  "flex flex-col gap-3 lg:min-h-0 lg:flex-1 lg:flex-row lg:items-stretch lg:gap-4";

/** The positions card's reserved height at `lg` — always mounted, always the
 *  same height, drawing its empty state when there is nothing to show.
 *
 *  200px rather than the 268px the plan sketched. The two cards divide one
 *  fixed column, so every pixel here is a pixel off the chart: at 1440x900,
 *  70vh leaves the column 534px, and 268px of it left a 150px chart — smaller
 *  than the 340px this redesign set out to grow. 200px still rules up the
 *  header, the column headings and four rows before the scroller takes over,
 *  which is the live band plus its first settled legs. */
const POSITIONS_HEIGHT_CLASS = "lg:h-[200px]";

/** How many settled order rows the positions card shows before counting. */
const MAX_ORDER_ROWS = 6;

/** The padding every band on either card starts from, so a figure in the
 *  readout lines up with the chart's own left rule. */
const BAND_PAD_CLASS = "px-4 sm:px-5";

/**
 * The band heading — `next`, `armed`, `held` — that starts each section on the
 * panel's left rule.
 *
 * Mono, wide-tracked and set in the faintest ink on the card: it is a label for
 * the row beneath it, never a figure to read. The wide tracking is what keeps a
 * four-letter lowercase word legible at 10px, and it separates the legend from
 * the mono values in the same band without needing a second colour.
 */
// Set in the muted ink rather than a fraction of it: at 10px a 70%-opacity
// label is under the AA contrast floor in both themes, and these are the words
// that tell an operator what they are looking at.
const BAND_LEGEND_CLASS =
  "font-mono text-[10.5px] uppercase tracking-[0.14em] text-muted-foreground";

/**
 * The context strips — the risk/reward bar, the schedule — that close out a
 * card. Both sit on the same faint ground, a shade off the card, so the band
 * above them reads as that card's centre of gravity.
 */
const CONTEXT_BAND_CLASS = "border-t border-border/40 bg-foreground/[0.02] px-4 py-2 sm:px-5";

/** Which of the four surfaces the projection says to render. */
export type PanelState = "planning" | "armed" | "live" | "complete";

export function readPanelState(mission: OrchestrationTradingMission): PanelState {
  if (isMissionComplete(mission.status)) return "complete";
  // A closed position leaves its snapshot row behind with size zeroed, so this
  // is gated on exposure rather than on the row existing.
  if (mission.position !== null && mission.position.size !== 0) return "live";
  return mission.strategy === null ? "planning" : "armed";
}

/**
 * Whether a state draws candles, and so puts the 15s chart poll on the wire.
 *
 * Everything the chart needs — a market and an interval — exists from mission
 * creation, so the only state that sits it out is the finished one, whose chart
 * is the timeline's completion summary.
 */
export function panelWantsChart(state: PanelState): boolean {
  return state !== "complete";
}

export function MissionLivePanel({
  mission,
  environmentId,
}: {
  readonly mission: OrchestrationTradingMission;
  readonly environmentId: EnvironmentId;
}): ReactNode {
  const state = readPanelState(mission);

  // --- Collapse state, per mission id. --------------------------------------
  const [collapsed, setCollapsed] = useState<boolean>(collapsedMissions[mission.id] ?? false);
  const toggleCollapsed = (): void => {
    setCollapsed((prev) => {
      const next = !prev;
      collapsedMissions[mission.id] = next;
      return next;
    });
  };

  // --- Ticker: the panel's clock. -------------------------------------------
  //
  // Drives the hold time, the reassessment countdown, the staleness chip, and
  // — since the chart's x axis is now wall-clock — the leftward drift of the
  // series. One timer for all of it, at 1Hz: a text update and a ~120-point SVG
  // re-render, no animation loop and no GPU work, so this stays inside the
  // no-peg-the-GPU rule the same way it did when it only moved text.
  const [nowMillis, setNowMillis] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNowMillis(Date.now()), TICK_INTERVAL_MILLIS);
    return () => window.clearInterval(id);
  }, []);

  // --- Derivations from the projection. -------------------------------------
  const position =
    mission.position !== null && mission.position.size !== 0 ? mission.position : null;
  const strategy = mission.strategy;
  const plan = deriveStrategyPlan(mission);

  // Mark price: the 3s mission poll is fresher than the 15s candle feed, so it
  // wins. Falling back to the position snapshot's mark keeps the figure present
  // when the exchange read failed but the position is still known.
  const markPrice = mission.marketPrice ?? position?.markPrice ?? null;

  const entryPrice = position?.entryPrice ?? null;
  // The stop, in both states, on two different grounds.
  //
  // While exposed it is the price protecting the position. While armed it is
  // the price the published plan says it will protect at — and a plan that
  // states a stop and does not draw it is the panel withholding the number the
  // whole trade is sized from. What it must NOT do is survive either: the stop
  // leg outlives the position it protected, and drawing it unconditionally
  // left a rule hanging across a flat mission at a price nothing was
  // protecting. Gated on a live plan that intends a trade, it cannot.
  const isPlanning = state === "planning";
  const wantsPlanLevels = !isPlanning && plan?.isStandAside !== true;
  const stopPrice = wantsPlanLevels ? (strategy?.stop.price ?? null) : null;
  // A stand-aside plan names no target, and drawing a target line from any
  // other figure on it would put a level on the chart for a trade that was
  // explicitly declined.
  const targetProfitUsd = plan?.isStandAside === true ? null : (strategy?.target.profitUsd ?? null);
  // Derived from the exposure once there is one — the price at which this size
  // makes the plan's money — and otherwise taken from the price the plan
  // states. A waiting mission drew no target at all, so the chart showed a
  // stop-less, target-less line while the readout beside it named both.
  const targetPrice =
    entryPrice !== null && targetProfitUsd !== null && position !== null
      ? deriveTargetPrice(entryPrice, targetProfitUsd, position.size)
      : wantsPlanLevels
        ? (strategy?.target.price ?? null)
        : null;
  const progressPercent =
    markPrice !== null && entryPrice !== null && targetPrice !== null
      ? deriveProgressToTarget(markPrice, entryPrice, targetPrice)
      : null;

  const entryMillis = deriveEntryFillAtMillis(mission.recentFills);
  const resolvedEntryMillis =
    entryMillis ??
    (mission.result.firstFillAt === null ? null : Date.parse(mission.result.firstFillAt));
  const holdLabel =
    resolvedEntryMillis === null || Number.isNaN(resolvedEntryMillis)
      ? null
      : formatDuration(nowMillis - resolvedEntryMillis);

  const exchangeUrl = hyperliquidTradeUrl(mission.market, mission.tradingAccountId);

  // --- The operator's own hand on the plan (step 8.4). ----------------------
  //
  // A drag is a `plan()` revision, so it needs the plan the model published and
  // the mission version the panel last read. Both come off the projection; the
  // eight authored fields go out unchanged but for the one leaf that moved.
  const revision = useMissionPlanRevision(mission.id, environmentId);
  const onLevelDragEnd = useCallback(
    (kind: ChartLevelKind, price: number) => {
      if (strategy === null) return;
      if (kind === "stop")
        revision.revise(strategy, { kind: "stop", price }, mission.missionVersion);
      if (kind === "target")
        revision.revise(strategy, { kind: "target", price }, mission.missionVersion);
    },
    [mission.missionVersion, revision, strategy],
  );
  // Only what the plan actually states. A stop rule drawn from a plan with no
  // stop price would be draggable into publishing a price the plan never had.
  const draggableKinds: ReadonlyArray<ChartLevelKind> =
    strategy === null
      ? []
      : [
          ...(stopPrice === null ? [] : (["stop"] as const)),
          ...(strategy.target.price === undefined ? [] : (["target"] as const)),
        ];

  // --- Chart feed. ----------------------------------------------------------
  // Planning draws candles too. The chart needs a market and an interval, both
  // known the moment the mission is created — gating it on a published strategy
  // meant a mission that had taken four turns, and had a market, a mark and a
  // run history, showed one line of text saying it was thinking. Only
  // `complete` sits it out: that mission is reported by the summary card in the
  // timeline, and a second chart of the same finished trade is a duplicate.
  const wantsChart = panelWantsChart(state);
  // The same rule the runtime resolves its own candles with: the interval the
  // mandate names, else 1m. Following the plan's `timeframes[0]` instead meant
  // a plan published on 15m drew a 15m chart of a mission the runtime was
  // waking on 1m structure — two pictures of one mission that disagreed.
  const interval: ChartInterval = runtimeTimeframe(mission.instruction);
  // Phase 9's mode is derived from the mandate rather than stored, which is the
  // right call and leaves one gap: nothing on screen said whether the sentence
  // the operator typed actually put the mission in execute mode. A mode read
  // out of prose that nobody can see read is a mode nobody can correct. Derived
  // here from the same function the server derives it from, off the same
  // `instruction`, so the panel cannot disagree with the model's own read.
  const mode = readMissionMode(mission.instruction);
  const chart = useTradingMarketChart(environmentId, mission.market, interval, {
    enabled: wantsChart,
  });

  // --- What the plan is watching, in either state. --------------------------
  //
  // None of this used to survive the fill: the checklist and the chart levels
  // were gated on `armed`, so the moment a position opened every level the plan
  // was watching — invalidations, scale-ins, PnL floors — vanished from the
  // surface, leaving only entry/stop/target. Those are the levels that matter
  // most while exposed, so they are drawn in both states now.
  const watches = deriveWatchConditions(mission);
  const pnlBasis =
    position !== null && position.entryPrice !== undefined
      ? { entryPrice: position.entryPrice, size: position.size }
      : null;
  // Deduped before it is counted: two watches at one price are one level on a
  // price axis, and counting them twice made "+1 more level armed, off the
  // chart" appear about a level that was already drawn.
  const chartConditions = dedupeConditions(deriveChartConditions(mission, pnlBasis));
  const droppedConditions = Math.max(0, chartConditions.length - MAX_DRAWN_CONDITIONS);
  // The levels behind the "+N" chip, as their own rows: the chip's promise is
  // that the full list is one hover away, and a count alone does not keep it.
  const overflowConditionRows = chartConditions.slice(MAX_DRAWN_CONDITIONS);

  // Every fill the session has made, as circles on the axis. A position that
  // opened and closed an hour ago has no row on the projection any more, but its
  // two fills are still here — so the chart, not the scrollback, is where the
  // session's whole activity is read.
  const fillMarkers = deriveChartFillMarkers(mission);

  // One row per order leg (plan 39 phase 2): queued, working, partial, the
  // open leg with live figures, and every settled leg — the whole record of
  // what the mission has done or is trying to do, in one column. The planned
  // ghost stands in while the plan commits an entry no live order covers.
  const plannedEntry =
    plan !== null && plan.isStandAside !== true && plan.initialSizeUsd !== null
      ? {
          sizeUsd: plan.initialSizeUsd,
          price: null,
          direction: (strategy?.intent === "short" ? "short" : "long") as "long" | "short",
        }
      : null;
  const orderRows = deriveOrderLedger({
    orders: mission.orders,
    position,
    markPrice,
    plannedEntry,
  });

  // The order the agent has committed to but the book has not filled. This is
  // the "I will enter long at X" the plan announces, drawn where it will happen
  // rather than described in a card somewhere else on the screen.
  const inFlight = mission.inFlightExecution;
  const pendingOrder =
    inFlight === null ? null : { price: inFlight.limitPrice, side: inFlight.side };

  // The plan's own read of where price is headed, as a moment on the clock
  // axis: `byMinutes` is measured from the publish, so the endpoint stays
  // fixed while the series slides toward it. Drawn whatever the intent — a
  // stand-aside plan still holds an estimate of where price is going, and the
  // estimate is exactly why it is standing aside.
  const planProjection =
    strategy?.projection !== undefined
      ? {
          price: strategy.projection.price,
          atMillis: strategy.updatedAt + strategy.projection.byMinutes * 60_000,
        }
      : null;

  // The next reassessment, as a mark on the axis rather than only as a
  // countdown in the header — "3m from now" is a moment, and the chart has an
  // axis of moments.
  // The plan's own reassessment moment, used when the projection carries no
  // watch row for it (a runtime-armed reassessment lands in the database
  // without an event, so `watches` can read empty while one is armed).
  const plannedReassessment = plannedReassessmentAt(mission.strategy, nowMillis);
  const nextReassessmentAt = deriveNextReassessmentAt(mission) ?? plannedReassessment;

  // How far the armed entry triggers are drawn into the future gutter: to the
  // plan's own reassessment horizon, and no further. A trigger rule running to
  // the frame edge claims the mission will still be waiting at that price then.
  const triggerExpiryAt = deriveTriggerExpiryMillis(mission);

  // Every armed reassessment, not only the nearest: the header's countdown is
  // one appointment, the axis is the whole queue.
  const timeMarkers = deriveChartTimeMarkers(mission, plannedReassessment);

  // What has already happened, as a rug of ticks along the axis: the mission's
  // own wakes, publishes and stop moves, which no amount of current state can
  // show. Bounded server-side, and again by the geometry's own cap.
  const pastMarkers = deriveChartPastMarkers(mission);

  // One stream: what is armed, then everything that has settled, newest first.
  //
  // Planning shows none of it. The only thing armed before a publish is the
  // staleness reassessment, which the stream excludes anyway — and a list
  // headed by a condition the mission never chose reads as a plan when there
  // is not one.
  const watchStream = state === "planning" ? [] : deriveWatchLifecycle(mission).stream;
  // The turn timeline (phase 3): one card per wake plus revision, note and
  // trade cards, newest first. Everything it states is already pushed — the
  // timeline's composed prose and the fill receipts — so this is a reformat,
  // not a new projection.
  const turnTimeline = deriveTurnTimeline({
    market: mission.market,
    missionTimeline: mission.missionTimeline,
    recentFills: mission.recentFills,
  });
  // A row that just fired holds its place at the top for a beat while the live
  // dot becomes a tick, so the operator sees the moment happen instead of a row
  // sliding down between polls.
  const recentlyFired = useRecentlyFiredWatches(watchStream, nowMillis);

  const pnlSign: "profit" | "loss" | null =
    position === null ? null : position.unrealisedPnl >= 0 ? "profit" : "loss";
  const pnlToneClass =
    position !== null && position.unrealisedPnl < 0 ? "text-loss" : "text-profit";
  const leverage =
    mission.leverage ?? (position === null ? null : deriveEffectiveLeverage(position));
  const roiPercent =
    position !== null && position.marginUsed > 0
      ? (position.unrealisedPnl / position.marginUsed) * 100
      : null;
  // The quiet half of the staleness signal. The loud half — the banner that
  // claims placement is suspended — waits for a much older read.
  const delayedRead = describeDelayedRead(mission, nowMillis);

  // --- The shared selection (phase 3): one store, both directions. ----------
  const selection = useMissionSelection((store) => store.selected);
  const selectPanelEvent = useMissionSelection((store) => store.select);
  const clearPanelEvent = useMissionSelection((store) => store.clear);
  const hoverPanelEvent = (event: { id: string; atMillis: number } | null): void => {
    if (event === null) {
      clearPanelEvent("panel");
      return;
    }
    selectPanelEvent({ eventId: event.id, atMillis: event.atMillis, source: "panel" });
  };

  // --- The fire flight (phase 4): the chip ripples, then flies to its card.
  //
  // A watch that just fired already ripples in the gutter; this walks a ghost
  // of its chip from there to the timeline card of the turn it caused, so the
  // level and the decision read as one event. The card arrives a poll after
  // the firing, so the flight waits for it (and gives up quietly — the
  // ripple alone already announced the fire — if it never comes).
  const flownFiredRef = useRef<Set<string>>(new Set());
  const pendingFlightsRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    for (const id of recentlyFired) {
      if (flownFiredRef.current.has(id)) continue;
      const row = watchStream.find(
        (item): item is WatchStreamRow => item.kind === "watch" && item.id === id,
      );
      if (row === undefined) continue;
      flownFiredRef.current.add(id);
      pendingFlightsRef.current.set(id, row.atMillis);
    }
  }, [recentlyFired, watchStream]);
  useEffect(() => {
    if (pendingFlightsRef.current.size === 0) return;
    for (const [id, watchAt] of [...pendingFlightsRef.current]) {
      const card = turnTimeline.cards.find(
        (candidate) =>
          candidate.kind === "wake" && Math.abs(candidate.atMillis - watchAt) <= 20_000,
      );
      const chip = document.querySelector(`[data-watch-chip="${CSS.escape(id)}"]`);
      const cardEl =
        card === undefined
          ? null
          : document.querySelector(`[data-timeline-card="${CSS.escape(card.id)}"]`);
      if (chip instanceof HTMLElement && cardEl instanceof HTMLElement) {
        pendingFlightsRef.current.delete(id);
        flyChipToCard(chip, cardEl);
      } else if (Date.now() - watchAt > 6_000) {
        // The card (or the chip) never arrived: the ripple alone stands.
        pendingFlightsRef.current.delete(id);
      }
    }
  }, [turnTimeline.cards, nowMillis]);

  // --- complete: the result, one line. --------------------------------------
  // The full review — the post-mortem chart and the fee/PnL breakdown — is the
  // completion summary card in the timeline. Repeating it here would put two
  // charts of the same finished trade on one screen. The row survives settle
  // now (plan 27 H1), so this one-liner is the settled thread's permanent
  // trading surface above the composer.
  if (state === "complete") {
    const net = mission.result.realizedPnlUsd - mission.result.feesPaidUsd;
    return (
      <div
        data-testid="mission-live-panel"
        data-panel-state="complete"
        className={cn(
          "mission-panel",
          CARD_CLASS,
          BAND_PAD_CLASS,
          "flex flex-wrap items-center gap-x-4 gap-y-1 py-3 text-sm",
        )}
      >
        <span className="text-foreground">{mission.market} finished</span>
        <span
          className={cn("font-mono text-base tabular-nums", net >= 0 ? "text-profit" : "text-loss")}
        >
          {formatSignedUsd(net)} net
        </span>
        <span className="font-mono text-[11.5px] tabular-nums text-muted-foreground">
          {mission.result.fillCount} fill{mission.result.fillCount === 1 ? "" : "s"} ·{" "}
          {formatUsd(mission.result.feesPaidUsd)} fees
        </span>
      </div>
    );
  }

  // --- collapsed: the 32px summary row. -------------------------------------
  if (collapsed) {
    return (
      <div
        data-testid="mission-live-panel"
        data-panel-state={state}
        className={cn("mission-panel", CARD_CLASS)}
      >
        <CollapsedRow
          market={mission.market}
          leverageLabel={leverage === null ? null : formatLeverage(leverage)}
          summary={
            state === "planning"
              ? "Analysing"
              : position === null
                ? describeArmedSummary(watches)
                : `${position.size > 0 ? "Long" : "Short"} · ${formatSignedUsd(position.unrealisedPnl)}`
          }
          summaryToneClass={position === null ? "text-muted-foreground" : pnlToneClass}
          progressPercent={progressPercent}
          onExpand={toggleCollapsed}
        />
      </div>
    );
  }

  return (
    <div data-testid="mission-live-panel" data-panel-state={state} className={PANEL_SHELL_CLASS}>
      {/* Two cards with air between them, not two halves of one box. The chart
          is the picture and the readout is the instrument beside it; welding
          them into a single bordered surface made a candle chart and a column
          of prices read as one flat table, which is how the first pass at this
          went wrong.

          Below `lg` they stack, chart first, each keeping its own edges. */}
      <div className={CARD_ROW_CLASS}>
        {/* Left column (plan 39 phase 1): the chart card and, under a glass
            boundary of its own gap, the positions card. Every height here is
            reserved — the chart flexes into whatever the fixed row leaves it,
            and the positions card is always mounted at the same height. */}
        <div
          data-testid="mission-chart-column"
          className="flex min-w-0 flex-1 flex-col gap-3 lg:h-full"
        >
          <section className={cn(CARD_CLASS, "flex min-h-0 flex-1 flex-col")}>
            <ChartPriceHeader
              market={mission.market}
              intervalLabel={interval}
              markPrice={markPrice}
              changePercent={chart.data?.change24hPercent ?? null}
            />
            <ChartSlot
              data={chart.data}
              isLoading={chart.isLoading}
              error={chart.error}
              entryPrice={entryPrice}
              stopPrice={stopPrice}
              targetPrice={targetPrice}
              liquidationPrice={position?.liquidationPrice ?? null}
              entryTime={entryMillis}
              markPrice={markPrice}
              pnlSign={pnlSign}
              conditions={chartConditions}
              fills={fillMarkers}
              pendingOrder={pendingOrder}
              nowMillis={nowMillis}
              triggerExpiryAt={triggerExpiryAt}
              projection={planProjection}
              timeMarkers={timeMarkers}
              pastMarkers={pastMarkers}
              draggableKinds={draggableKinds}
              onLevelDragEnd={onLevelDragEnd}
              refusedStop={revision.refusedStop}
              positionSize={position?.size ?? null}
              overflowCount={droppedConditions}
              firedWatchIds={[...recentlyFired]}
            />
            <RiskRewardBar
              riskUsd={plan?.maxLossUsd ?? null}
              rewardUsd={targetProfitUsd}
              isStandAside={plan?.isStandAside === true}
            />
          </section>

          {/* The positions card (plan 39 phase 2): one glance answers everything
            the mission has done or is trying to do — one list, one row per
            order leg. Always mounted, always the same height; with nothing to
            show it draws its empty state in the skeleton idiom. */}
          <section
            data-testid="mission-positions"
            className={cn(CARD_CLASS, POSITIONS_HEIGHT_CLASS, "flex flex-none flex-col")}
          >
            <PositionsCard
              rows={orderRows}
              market={mission.market}
              leverageLabel={leverage === null ? null : formatLeverage(leverage)}
              position={position}
              markPrice={markPrice}
              stopPrice={stopPrice}
              plan={plan}
              roiPercent={roiPercent}
              pnlToneClass={pnlToneClass}
              nowMillis={nowMillis}
              staleLabel={delayedRead ?? (chart.stale ? "delayed" : null)}
            />
          </section>
        </div>

        {/* The right column is purely the agent log (plan 39 phase 3): a
            header, the armed alerts pinned at the top, and one chronological
            scrollback merging the settled watches and the turn cards. */}
        <section
          data-testid="mission-agent-log"
          className={cn(
            CARD_CLASS,
            READOUT_WIDTH_CLASS,
            "flex min-h-0 w-full min-w-0 flex-col lg:h-full lg:flex-none",
          )}
        >
          {/* The header: the log's name, the money being read, and the panel's
              only chrome.

              The P&L sits here as well as on the positions card, deliberately.
              The heartbeat sentence that used to carry "up $1.37" above the
              chart is gone, and this column is the one an operator watches
              while the mission talks to itself — a log with no reading beside
              it makes them look away to learn whether any of it is working. */}
          <div className={cn(BAND_PAD_CLASS, "flex flex-none items-baseline gap-x-3 pt-3 pb-1.5")}>
            <p className={cn(BAND_LEGEND_CLASS, "flex-none")}>agent log</p>
            {position === null ? null : (
              <span className="ml-auto flex flex-none items-baseline gap-2">
                {roiPercent === null ? null : (
                  <span className={cn("font-mono text-[11px] tabular-nums", pnlToneClass)}>
                    {formatSignedPercent(roiPercent)}
                  </span>
                )}
                <span
                  className={cn(
                    "font-mono text-[15px] leading-none tracking-[-0.02em] tabular-nums",
                    pnlToneClass,
                  )}
                >
                  <AnimatedUsd value={position.unrealisedPnl} />
                </span>
              </span>
            )}
            {/* The collapse control recedes to a hint until the pointer is on
                the panel: a monitoring surface should read as figures, not as
                a toolbar. */}
            <button
              type="button"
              onClick={toggleCollapsed}
              aria-label="Collapse chart"
              className={cn(
                "self-center text-muted-foreground transition-colors hover:text-foreground focus-visible:text-foreground group-hover/panel:text-muted-foreground motion-reduce:transition-none",
                position === null && "ml-auto",
              )}
            >
              <ChevronUp className="size-4" aria-hidden />
            </button>
          </div>
          {/* Progress to target, restored: the rule and the figure it stands
              for, on the panel's left rule. Always mounted at one height — the
              reserved-height rule applies to itself, and a strip that appeared
              with the first fill would move the whole scrollback under it. */}
          <ProgressToTargetRow percent={progressPercent} />
          <AgentLog
            stream={watchStream}
            cards={turnTimeline.cards}
            earlierTurns={turnTimeline.earlierCount}
            nowMillis={nowMillis}
            recentlyFired={recentlyFired}
            droppedConditions={droppedConditions}
            overflowRows={overflowConditionRows}
            selection={selection}
            onHoverEvent={hoverPanelEvent}
          />
          <RevisionNote revision={revision} />
        </section>
      </div>

      {/* The third element, spanning both cards: what the mission is doing,
          said in a sentence, with the facts that qualify it trailing on the
          right. It is the line the landing page closes its readout with, and
          the panel had nowhere to say the one thing a passing glance wants —
          not a price, not a percentage, but a state. Everything on it is
          ambient: a state, a duration, a carrying cost, the day's move. None
          of it is decided on, which is why it is a bar under the instrument
          rather than a cell inside it. */}
      <MissionStatusBar
        headline={describeMissionStatus(state, position, watches, plan)}
        because={plan?.because ?? null}
        plan={plan}
        countdown={formatReassessmentCountdown(nextReassessmentAt)}
        projection={
          // A stand-aside states no prediction, so the bar shows none — and it
          // is read off the intent rather than trusted to be absent. Nothing in
          // the schema forbids the field on a `stand_aside` plan, and a plan
          // published before the wake stopped nagging for one may carry the
          // invented projection that nagging produced. Drawing it would be the
          // panel asserting a direction the plan declined to take.
          strategy?.projection === undefined || plan?.isStandAside === true
            ? null
            : {
                direction: strategy.projection.direction,
                price: strategy.projection.price,
                atMillis: strategy.updatedAt + strategy.projection.byMinutes * 60_000,
              }
        }
        tone={position === null ? "flat" : position.unrealisedPnl >= 0 ? "profit" : "loss"}
        data={chart.data}
        isHolding={position !== null}
        holdLabel={holdLabel}
        modeLabel={mode.kind === "execute_strategy" ? mode.strategy.replaceAll("_", " ") : null}
        exchangeUrl={exchangeUrl}
        lastActivity={deriveLastActivity(mission.missionTimeline, nowMillis)}
      />
    </div>
  );
}

/**
 * What the mission is doing, in one clause.
 *
 * The panel is dense with figures and had no sentence on it. A figure answers
 * "how much"; this answers "what is happening", which is the question a glance
 * from across the room is actually asking.
 */
function describeMissionStatus(
  state: PanelState,
  position: { readonly size: number } | null,
  watches: { readonly rows: ReadonlyArray<{ readonly met: boolean }> } | null,
  plan: StrategyPlan | null,
): string {
  if (position !== null) return position.size > 0 ? "Holding long" : "Holding short";
  if (state === "planning") return "Analysing the market";
  if (plan?.isStandAside === true) return "Standing aside";
  const pending = watches?.rows.filter((row) => !row.met).length ?? 0;
  if (pending === 0) return "Waiting for the entry";
  return `Waiting on ${pending} condition${pending === 1 ? "" : "s"}`;
}

/**
 * The price, above the picture of it.
 *
 * Borrowed wholesale from the Stocks app, which puts the number first and the
 * shape under it: the market, then the mark set large, then how far the day has
 * moved, then which bars are being drawn. It is the one figure that is true
 * whatever the mission is doing — planning, waiting, holding — so it belongs to
 * the chart card rather than to the readout, and it stays put while the panel's
 * state changes underneath it.
 *
 * The mark is `mission.marketPrice` (3s poll) rather than the candle feed's
 * (15s), so this figure and the dot at the end of the line are the same read.
 */
function ChartPriceHeader({
  market,
  intervalLabel,
  markPrice,
  changePercent,
}: {
  readonly market: string;
  readonly intervalLabel: string;
  readonly markPrice: number | null;
  readonly changePercent: number | null;
}): ReactNode {
  // Not the money palette (plan 39 phase 5, check 10). The doctrine reserves
  // profit/loss ink for THIS mission's money, and the day's move is neither:
  // a green +19.68% sitting a few pixels from a red -$1.46 read as "we are up"
  // about a mission that was down. It keeps its sign, which is what says which
  // way the day went, in the foreground ink every other market fact wears.
  const changeTone = changePercent === null ? "text-muted-foreground" : "text-foreground/70";
  return (
    <div className={cn(BAND_PAD_CLASS, "flex items-end justify-between gap-3 pb-2 pt-3")}>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-muted-foreground">
          {market} · USD
        </span>
        <span className="flex items-baseline gap-2">
          <span
            data-testid="mission-chart-mark"
            className="font-mono text-[26px] leading-none tracking-[-0.02em] tabular-nums text-foreground"
          >
            {markPrice === null ? "-" : formatPrice(markPrice)}
          </span>
          {changePercent === null ? null : (
            <span className={cn("font-mono text-[13px] tabular-nums", changeTone)}>
              {formatSignedPercent(changePercent)}
            </span>
          )}
        </span>
      </div>
      {/* Which bars the shape below is made of. The Stocks app puts a row of
          ranges here; this chart draws one, so it states it rather than
          offering it. */}
      <span
        data-testid="mission-chart-interval"
        // Lower case, deliberately: "1M" is a month in every chart app the
        // operator has ever used, and this is one minute.
        className="flex-none rounded-full border border-border/60 px-2 py-0.5 font-mono text-[11px] lowercase tracking-[0.08em] text-muted-foreground"
      >
        {intervalLabel}
      </span>
    </div>
  );
}

/**
 * The two figures the plan fixed before it signed anything, drawn as one bar.
 *
 * The risk and the reward are the same statement read from two ends, so they
 * are one object: a red segment and a green one, sized in proportion to each
 * other. It sits under the chart because it is a property of the levels drawn
 * on it, and it disappears when either half is unknown — half a risk/reward bar
 * claims a ratio that has not been decided.
 */
/**
 * A reward-to-risk ratio, printed so it never rounds itself away.
 *
 * A plan risking $63.67 to make $0.66 has a ratio of 0.0104, and one decimal
 * place prints that as "0.0:1" — a figure that reads as a rendering fault
 * rather than as the (alarming) thing it is. Below a tenth the ratio is stated
 * as a bound instead, which is both honest and legible.
 */
function formatRatio(ratio: number): string {
  if (ratio > 0 && ratio < 0.1) return "<0.1";
  return ratio.toFixed(ratio < 10 ? 1 : 0);
}

function RiskRewardBar({
  riskUsd,
  rewardUsd,
  isStandAside,
}: {
  readonly riskUsd: number | null;
  readonly rewardUsd: number | null;
  readonly isStandAside: boolean;
}): ReactNode {
  // Always mounted (plan 39 phase 1): this strip was the last thing that could
  // still move the chart — it used to unmount on stand-aside and on missing
  // figures, and inside the fixed column its appearing stole chart height
  // between the planning and waiting states. With no committed plan it draws
  // the same band with both segments in muted ink and an em-dash ratio.
  if (isStandAside || riskUsd === null || rewardUsd === null || riskUsd <= 0 || rewardUsd <= 0) {
    return (
      <div
        data-testid="mission-risk-reward"
        className={cn("flex items-center gap-3", CONTEXT_BAND_CLASS)}
      >
        <span className="flex h-5 min-w-0 flex-1 overflow-hidden rounded-[4px] font-mono text-[10px] tabular-nums">
          <span className="flex w-1/2 items-center justify-start whitespace-nowrap bg-foreground/[0.04] px-1.5 text-muted-foreground">
            -
          </span>
          <span className="flex flex-1 items-center justify-end whitespace-nowrap bg-foreground/[0.04] px-1.5 text-muted-foreground">
            -
          </span>
        </span>
        <span className="flex-none font-mono text-[11px] tabular-nums text-muted-foreground">
          - no committed risk
        </span>
      </div>
    );
  }
  const ratio = rewardUsd / riskUsd;
  // The proportion is clamped to a readable band. A 6:1 plan drawn honestly
  // gives the risk segment 14% of the bar, which is narrower than the figure
  // printed in it, and a number spilling out of its own segment is worse than
  // a foreshortened one. The exact ratio is stated in words beside the bar, so
  // nothing here is the only source of the truth it shortens.
  const riskShare = Math.min(72, Math.max(28, (riskUsd / (riskUsd + rewardUsd)) * 100));
  return (
    <div
      data-testid="mission-risk-reward"
      className={cn("flex items-center gap-3", CONTEXT_BAND_CLASS)}
    >
      <span className="flex h-5 min-w-0 flex-1 overflow-hidden rounded-[4px] font-mono text-[10px] tabular-nums">
        <span
          className="mission-rr-segment flex items-center justify-start whitespace-nowrap bg-loss/15 px-1.5 text-loss"
          style={{ width: `${riskShare}%` }}
        >
          {formatSignedUsd(-riskUsd)}
        </span>
        <span className="mission-rr-segment flex flex-1 items-center justify-end whitespace-nowrap bg-profit/15 px-1.5 text-profit">
          {formatSignedUsd(rewardUsd)}
        </span>
      </span>
      <span className="flex-none font-mono text-[11px] tabular-nums text-muted-foreground">
        {formatRatio(ratio)}:1 planned
      </span>
    </div>
  );
}

/**
 * What the last drag came back saying.
 *
 * Three sentences and no fourth: the model republished underneath it, the
 * exchange refused to move the stop, or the take-profit could not be confirmed
 * and the previous one is still resting. All stay until the operator drags
 * again — a message that disappears on a timer is one they will miss while
 * looking at the chart.
 */
function RevisionNote({ revision }: { readonly revision: MissionPlanRevision }): ReactNode {
  // A refused stop and an unconfirmed target are two separate live facts, and
  // both can land from one drag. Say both: hearing only the stop refusal
  // leaves the operator believing the new target is resting when it is not.
  const details = [revision.refusedStop?.detail, revision.unconfirmedTarget?.detail].filter(
    (detail): detail is string => typeof detail === "string" && detail.length > 0,
  );
  const message = revision.lockLost
    ? "The model republished the plan while you were dragging, so the level snapped back. Drag again against what is there now."
    : details.length > 0
      ? details.join(" ")
      : revision.error;
  if (message === null || message === undefined) return null;
  return (
    <button
      type="button"
      onClick={revision.dismiss}
      data-testid="mission-revision-note"
      className="w-full px-3 py-1.5 text-left text-[11px] leading-snug text-muted-foreground"
    >
      {message}
    </button>
  );
}

/** What a collapsed armed mission says in one clause. */
function describeArmedSummary(armed: { readonly rows: ReadonlyArray<unknown> } | null): string {
  if (armed === null || armed.rows.length === 0) return "Waiting";
  return `Waiting on ${armed.rows.length} condition${armed.rows.length === 1 ? "" : "s"}`;
}

/**
 * The chart area, in its four explicit states. Loading and <2-candle states
 * never show a flat line at zero — the first reads as "data is coming", the
 * second as "too little to draw yet".
 */
function ChartSlot(props: {
  readonly data: TradingMarketChartView | null;
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly entryPrice: number | null;
  readonly stopPrice: number | null;
  readonly targetPrice: number | null;
  readonly liquidationPrice: number | null;
  readonly entryTime: number | null;
  readonly markPrice: number | null;
  readonly pnlSign: "profit" | "loss" | null;
  readonly conditions: ReadonlyArray<{
    readonly price: number;
    readonly direction: "above" | "below";
    readonly met: boolean;
  }>;
  readonly fills: ReadonlyArray<ChartFillMarker>;
  readonly pendingOrder: { readonly price: number; readonly side: "buy" | "sell" } | null;
  readonly nowMillis: number;
  readonly triggerExpiryAt: number | null;
  readonly projection: { readonly price: number; readonly atMillis: number } | null;
  readonly timeMarkers: ReadonlyArray<ChartTimeMarkerInput>;
  readonly pastMarkers: ReadonlyArray<ChartPastMarkerInput>;
  readonly draggableKinds: ReadonlyArray<ChartLevelKind>;
  readonly onLevelDragEnd: (kind: ChartLevelKind, price: number) => void;
  readonly refusedStop: { readonly planPrice: number; readonly detail: string } | null;
  readonly positionSize: number | null;
  readonly overflowCount?: number | null;
  readonly firedWatchIds?: ReadonlyArray<string>;
}): ReactNode {
  const { data, isLoading, error } = props;

  if (data === null && isLoading) {
    return <Skeleton className={CHART_HEIGHT_CLASS} />;
  }
  if (data === null && error !== null) {
    return (
      <div
        className={cn(
          CHART_HEIGHT_CLASS,
          "flex items-center justify-center text-xs text-muted-foreground",
        )}
      >
        Chart unavailable
      </div>
    );
  }
  if (data !== null && data.candles.length < 2) {
    return (
      <div
        className={cn(
          CHART_HEIGHT_CLASS,
          "flex items-center justify-center text-xs text-muted-foreground",
        )}
      >
        Building chart…
      </div>
    );
  }
  if (data !== null) {
    return (
      <MissionPriceChart
        // The tail of the fetched series, widened when an older fill would
        // otherwise fall off the left edge. See VISIBLE_BARS.
        candles={selectVisibleCandles(data.candles, VISIBLE_BARS, earliestFillAt(props.fills))}
        entryPrice={props.entryPrice}
        stopPrice={props.stopPrice}
        targetPrice={props.targetPrice}
        liquidationPrice={props.liquidationPrice}
        entryTime={props.entryTime}
        markPrice={props.markPrice}
        pnlSign={props.pnlSign}
        conditions={props.conditions}
        fills={props.fills}
        pendingOrder={props.pendingOrder}
        nowMillis={props.nowMillis}
        {...(props.triggerExpiryAt === null ? {} : { triggerExpiryAt: props.triggerExpiryAt })}
        projection={props.projection}
        timeMarkers={props.timeMarkers}
        pastMarkers={props.pastMarkers}
        draggableKinds={props.draggableKinds}
        onLevelDragEnd={props.onLevelDragEnd}
        refusedLevel={
          props.refusedStop === null
            ? null
            : {
                kind: "stop",
                planPrice: props.refusedStop.planPrice,
                detail: props.refusedStop.detail,
              }
        }
        positionSize={props.positionSize}
        overflowCount={props.overflowCount ?? null}
        firedWatchIds={props.firedWatchIds}
        className={CHART_HEIGHT_CLASS}
      />
    );
  }
  return <Skeleton className={CHART_HEIGHT_CLASS} />;
}

/** The oldest fill's moment, which the chart window has to reach back to. */
function earliestFillAt(fills: ReadonlyArray<ChartFillMarker>): number | null {
  let earliest: number | null = null;
  for (const fill of fills) {
    if (earliest === null || fill.at < earliest) earliest = fill.at;
  }
  return earliest;
}

/**
 * How long a just-fired row keeps its place on the checklist while the live
 * dot becomes a tick, before it drops into the history below.
 */
const FIRED_LINGER_MILLIS = 4_000;

/**
 * Which rows flipped from waiting to met since the panel last looked.
 *
 * The server is the truth about `met`; this hook only remembers the moment of
 * transition so the row can be held on screen through its tick animation. A
 * row that mounts already met (the panel just opened) never counts — there is
 * no moment to show.
 */
function useRecentlyFiredWatches(
  items: ReadonlyArray<WatchStreamItem>,
  nowMillis: number,
): ReadonlySet<string> {
  // No timers: the panel already re-renders on its 250ms clock, so the linger
  // is read off `nowMillis` and expired entries are pruned lazily. A timeout
  // here would be cleared by the next poll's new `rows` identity and leave a
  // fired row stuck at the top of the stream forever.
  const seenMet = useRef<Map<string, boolean>>(new Map());
  const firedAt = useRef<Map<string, number>>(new Map());

  for (const item of items) {
    // Only take-downs group, so a group never contains the transition this
    // hook exists to catch.
    if (item.kind !== "watch") continue;
    const row = item;
    const met = row.state === "triggered";
    const wasMet = seenMet.current.get(row.id);
    if (wasMet === false && met && !firedAt.current.has(row.id)) {
      firedAt.current.set(row.id, nowMillis);
    }
    seenMet.current.set(row.id, met);
  }

  const fired = new Set<string>();
  for (const [id, at] of firedAt.current) {
    if (nowMillis - at < FIRED_LINGER_MILLIS) fired.add(id);
    else firedAt.current.delete(id);
  }
  return fired;
}

/**
 * The levels the chart's gutter folded away, listed in full under the stream.
 *
 * The "+N" chip in the gutter says these exist; this is the list it opens.
 * Hovering (or focusing) the chip itself expands it through the shared
 * selection, and the row under the pointer here claims the selection back, so
 * the drawn chip for a level that has one glows while its row is read — the
 * same two-way join every other row in the panel keeps.
 */
function OverflowLevels({
  rows,
  watchRows,
  open,
  highlighted,
  onToggle,
  onHoverEvent,
  sectionRef,
}: {
  readonly rows: ReadonlyArray<{
    readonly price: number;
    readonly direction: "above" | "below";
    readonly met: boolean;
    readonly id?: string | undefined;
  }>;
  /** The whole stream, to join a level back to the watch that armed it. */
  readonly watchRows: ReadonlyArray<WatchStreamItem>;
  readonly open: boolean;
  /** While the chart's "+N" chip is the live selection. */
  readonly highlighted: boolean;
  readonly onToggle: () => void;
  readonly onHoverEvent: (event: { id: string; atMillis: number } | null) => void;
  readonly sectionRef: RefObject<HTMLDivElement | null>;
}): ReactNode {
  // The watch row a level was armed by, for its icon and its sentence. A level
  // without one (the join lost an id) still lists: the price and its direction
  // are the facts, and dropping the row would un-count a real level.
  const rowFor = (id: string | undefined): WatchStreamRow | null => {
    if (id === undefined) return null;
    for (const item of watchRows) {
      if (item.kind === "watch" && item.id === id) return item;
      for (const member of item.kind === "group" ? item.members : []) {
        if (member.id === id) return member;
      }
    }
    return null;
  };
  return (
    <div
      ref={sectionRef}
      data-testid="mission-overflow-levels"
      className={cn("pt-1.5", highlighted && "rounded-lg bg-armed/10")}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className={cn(
          BAND_PAD_CLASS,
          "flex w-full items-baseline gap-x-1 py-1 font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground motion-reduce:transition-none",
        )}
      >
        <span className="tabular-nums">
          +{rows.length} more level{rows.length === 1 ? "" : "s"} armed, off the chart
        </span>
        <ChevronDown
          className={cn(
            "size-3 self-center transition-transform motion-reduce:transition-none",
            open && "rotate-180",
          )}
          aria-hidden
        />
      </button>
      {open ? (
        <div className="divide-y divide-border/15">
          {rows.map((row) => {
            const watch = rowFor(row.id);
            const Icon = watch === null ? Crosshair : WATCH_TYPE_ICON[watch.watchType];
            return (
              <div
                key={row.id ?? `${row.price}-${row.direction}`}
                data-watch-row={row.id}
                onMouseEnter={() =>
                  row.id === undefined ? undefined : onHoverEvent({ id: row.id, atMillis: 0 })
                }
                onMouseLeave={() => onHoverEvent(null)}
                className={cn(
                  BAND_PAD_CLASS,
                  "flex items-baseline gap-x-2 py-2 font-mono text-[11.5px]",
                )}
              >
                <Icon
                  className="size-[11px] flex-none self-center text-muted-foreground"
                  strokeWidth={2}
                  aria-hidden
                />
                <span className="flex-none text-[9px] text-muted-foreground" aria-hidden>
                  {row.direction === "above" ? "▲" : "▼"}
                </span>
                <span className="flex-none tabular-nums text-foreground/90">
                  {formatPrice(row.price)}
                </span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {watch?.description ?? "armed level"}
                </span>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The icon that says which kind of predicate a row is.
 *
 * One vocabulary across the whole card: Crosshair already means "a price level"
 * wherever it appears, Activity is the wake beacon's PnL mark, and Receipt is
 * its fill mark. A row therefore names its kind in the shape the reader has
 * already learned somewhere else on the panel.
 */
const WATCH_TYPE_ICON: Record<WatchRowType, LucideIcon> = {
  candle_close: ChartCandlestick,
  price_cross: Crosshair,
  pnl_above: Activity,
  pnl_below: Activity,
  pnl_giveback: Activity,
  metric_threshold: Gauge,
  metric_derived: Gauge,
  order_update: Receipt,
  position_update: Receipt,
};

/**
 * A watch's figure in the units its own predicate compares.
 *
 * A PnL level is signed dollars, a give-back is a dollar distance (the sign
 * would claim a side it does not have), a metric is the raw number the
 * evaluator uses — a formatter that guessed units would misstate at least one
 * metric — and a price is a price.
 */
function formatWatchFigure(watchType: WatchRowType, value: number): string {
  switch (watchType) {
    case "price_cross":
    case "candle_close":
      return formatPrice(value);
    case "pnl_above":
    case "pnl_below":
      return formatSignedUsd(value);
    case "pnl_giveback":
      return formatUsd(value);
    case "metric_threshold":
    case "metric_derived":
      return String(value);
    case "order_update":
    case "position_update":
      // Neither carries a level; these rows show their subject instead.
      return "";
  }
}

/**
 * The header countdown to the next scheduled reassessment.
 *
 * "reassess in 2m" while one is armed and in the future; "reassess due" the
 * moment it has passed; null (the slot disappears) when none is armed.
 */
function formatReassessmentCountdown(nextReassessmentAt: number | null): string | null {
  if (nextReassessmentAt === null) return null;
  const remaining = nextReassessmentAt - Date.now();
  if (remaining <= 0) return "due";
  // Just the duration. The cell is labelled NEXT, so "reassess in 14m 3s" both
  // repeated its own label and overflowed the cell — the panel was printing
  // "reassess in 14…", which says neither how long nor until what.
  return formatDuration(remaining);
}

/**
 * Everything the published plan says.
 *
 * The same body that used to sit behind a disclosure at the foot of the readout
 * card, unchanged but for losing its own `<details>`: the popup it now lives in
 * IS the disclosure, and a second expander inside an opened popup would be a
 * control the reader has already used.
 */
function PlanBody({ plan }: { readonly plan: StrategyPlan }): ReactNode {
  return (
    <div className="text-[12px]">
      <p className={cn(BAND_LEGEND_CLASS, "pb-2")}>
        plan · {plan.isStandAside ? "standing aside" : plan.planPhase}
      </p>
      <div className="space-y-1">
        {plan.isStandAside ? (
          // A stand-aside says so in its first line: the plan declined the
          // trade, and reading an intent row before learning that would put
          // the conclusion last.
          <p className="whitespace-pre-wrap text-foreground">
            {plan.because === null ? "Standing aside." : `Standing aside: ${plan.because}`}
          </p>
        ) : (
          <>
            {plan.because === null ? null : <PlanField label="Why" value={plan.because} />}
            <PlanField label="Intent" value={plan.intentLabel} />
          </>
        )}
        {plan.entryTriggers.length === 0 ? null : (
          <PlanField label="Entry trigger" value={plan.entryTriggers.join("; ")} />
        )}
        {plan.orderType === null ? null : <PlanField label="Order type" value={plan.orderType} />}
        {plan.initialSizeUsd === null ? null : (
          <PlanField label="Initial size" value={formatUsd(plan.initialSizeUsd)} />
        )}
        {plan.stopSummary === null ? null : <PlanField label="Stop" value={plan.stopSummary} />}
        {plan.targetUsd === null ? null : (
          <PlanField label="Target" value={formatUsd(plan.targetUsd)} />
        )}
        {plan.maxLossUsd === null ? null : (
          <PlanField label="Max loss" value={formatUsd(plan.maxLossUsd)} />
        )}
        {plan.invalidation.length === 0 ? null : (
          <PlanField label="Invalidation" value={plan.invalidation.join("; ")} />
        )}
        <PlanField label="Reassess after" value={`${plan.reassessMinutes} min untriggered`} />
      </div>
    </div>
  );
}

/**
 * The plan, on the bar, opening upward.
 *
 * It is anchored to the sentence it explains rather than to the foot of a
 * scrolling column, and it opens over the panel instead of pushing the
 * composer down — which is what the disclosure did every time it was used, at
 * the moment the reader wanted to compare the plan against the figures it had
 * just displaced.
 *
 * 400px wide on purpose: the readout card's own width, so the plan's fields
 * wrap on the same measure as the figures they describe.
 */
function PlanPopover({ plan }: { readonly plan: StrategyPlan }): ReactNode {
  return (
    <Popover>
      <PopoverTrigger
        aria-haspopup="dialog"
        data-testid="mission-plan-trigger"
        className="inline-flex flex-none items-center gap-1.5 rounded-full border border-border/60 px-2 py-0.5 font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground motion-reduce:transition-none"
      >
        <FileText className="size-3" strokeWidth={2} aria-hidden />
        Plan
      </PopoverTrigger>
      {/* Upward, because the bar is the panel's bottom edge and the composer is
          directly under it. */}
      <PopoverPopup side="top" align="start" className="w-[400px] max-w-[calc(100vw-2rem)]">
        <div className="max-h-[60vh] overflow-y-auto">
          <PlanBody plan={plan} />
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function PlanField({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}): ReactNode {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
      <span className="w-24 flex-none text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 whitespace-pre-wrap text-foreground">{value}</span>
    </div>
  );
}

/**
 * A signed dollar figure that counts to its value (phase 4).
 *
 * Money that just arrived — a banked profit, a fresh fill — springs from the
 * old number to the new one over ~600ms so the change registers as a change
 * and not as a repaint. One-shot, requestAnimationFrame-driven, and an instant
 * snap under `prefers-reduced-motion`; nothing here loops.
 */
function AnimatedUsd({ value }: { readonly value: number }): ReactNode {
  const [displayed, setDisplayed] = useState(value);
  const fromRef = useRef(value);
  const reduceMotion =
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  useEffect(() => {
    if (reduceMotion) {
      fromRef.current = value;
      setDisplayed(value);
      return;
    }
    const from = fromRef.current;
    if (from === value) return;
    const startedAt = performance.now();
    const durationMs = 600;
    let frame = 0;
    const tick = (now: number): void => {
      const t = Math.min(1, (now - startedAt) / durationMs);
      // Springy without a spring library: ease-out with a slight overshoot
      // past 1, clamped so the last frame lands exactly on the value.
      const eased = 1 - (1 - t) ** 3;
      setDisplayed(from + (value - from) * eased);
      if (t < 1) frame = requestAnimationFrame(tick);
      else fromRef.current = value;
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value, reduceMotion]);

  return formatSignedUsd(displayed);
}

/**
 * Progress to target as a hairline rule, next to the number it stands for.
 *
 * The figure alone ("42% to target") is a number the eye has to read before it
 * means anything; the rule is the same fact at a glance. Drawn in the accent
 * rather than in the P&L's tone — distance travelled toward the target is not
 * the same statement as whether the position is up or down, and painting the
 * rule red through a drawdown said the plan had gone wrong when only the mark
 * had moved.
 *
 * Always mounted, at one height, with a muted em-dash reading when there is no
 * target to measure against: the panel reserves its heights rather than
 * growing into them.
 */
function ProgressToTargetRow({ percent }: { readonly percent: number | null }): ReactNode {
  return (
    <div
      data-testid="mission-progress-to-target"
      className={cn(BAND_PAD_CLASS, "flex flex-none items-center gap-3 pb-2.5")}
    >
      <span
        className="block h-[3px] min-w-0 flex-1 overflow-hidden rounded-full bg-foreground/[0.08]"
        aria-hidden
      >
        {percent === null ? null : (
          // The width eases rather than jumping: the mark moves every 3s, and a
          // rule that snaps reads as a re-render while one that travels reads
          // as the trade advancing.
          <span
            className="block h-full rounded-full bg-primary transition-[width] duration-500 ease-out motion-reduce:transition-none"
            style={{ width: `${Math.max(2, Math.min(100, percent))}%` }}
          />
        )}
      </span>
      <span className="flex-none font-mono text-[11px] tabular-nums text-muted-foreground">
        {percent === null ? "- to target" : `${Math.round(percent)}% to target`}
      </span>
    </div>
  );
}

/** The live header's side chip, tinted by the exposure direction. */
function SideChip({
  market,
  leverageLabel,
  isLong,
  size = "md",
}: {
  readonly market: string;
  readonly leverageLabel: string | null;
  readonly isLong: boolean;
  /**
   * `sm` is the ledger's row height. One component at two sizes rather than a
   * second pill that would drift from this one the first time either changed.
   */
  readonly size?: "md" | "sm";
}): ReactNode {
  const tone = isLong
    ? "border-profit/40 bg-profit/10 text-profit"
    : "border-loss/40 bg-loss/10 text-loss";
  return (
    <span
      className={cn(
        "inline-flex flex-none items-center gap-1.5 rounded-full border font-mono",
        size === "sm" ? "px-1.5 text-[10.5px]" : "px-2.5 py-0.5 text-[12px]",
        tone,
      )}
    >
      <span>{market}</span>
      {leverageLabel === null ? null : (
        <span className="rounded-[3px] bg-current/15 px-1 tabular-nums">{leverageLabel}</span>
      )}
      <span>{isLong ? "Long" : "Short"}</span>
    </span>
  );
}

/** The collapsed summary row: one line at 32px, with a chevron to expand. */
function CollapsedRow({
  market,
  leverageLabel,
  summary,
  summaryToneClass,
  progressPercent,
  onExpand,
}: {
  readonly market: string;
  readonly leverageLabel: string | null;
  readonly summary: string;
  readonly summaryToneClass: string;
  readonly progressPercent: number | null;
  readonly onExpand: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      onClick={onExpand}
      aria-label="Expand chart"
      data-testid="mission-live-panel-collapsed"
      className={cn(
        BAND_PAD_CLASS,
        "flex w-full items-center gap-3 font-mono text-[12px] tabular-nums text-muted-foreground",
      )}
      style={{ height: COLLAPSED_ROW_HEIGHT_PX }}
    >
      <span className="text-foreground">
        {market}
        {leverageLabel === null ? "" : ` ${leverageLabel}`}
      </span>
      <span className={summaryToneClass}>{summary}</span>
      {progressPercent === null ? null : <span>· {Math.round(progressPercent)}% to target</span>}
      <span className="ml-auto">
        <ChevronDown className="size-3.5" aria-hidden />
      </span>
    </button>
  );
}

/**
 * The footer's research snapshot, compacted to one line.
 *
 * Two of the figures need converting before they match their labels.
 * `fundingRate8h` is a rate, not a percentage (0.000125 is 0.0125%/8h), and
 * `openInterest` is in base units of the market, so a dollar figure is the mark
 * price times the size.
 */
/**
 * The ambient line, under everything: the facts that qualify the panel without
 * being decided on.
 *
 * Hold time lives here rather than in the exposure grid. "Held 12m" is a
 * property of the session, not a figure anyone acts on, and in the grid it
 * displaced one that is. Funding is a cost of *carrying*, so it appears when
 * something is being carried and not before. The 24h change stays
 * unconditionally: the chart is an hour wide, so this is the one line that
 * says where the day has been. Open interest and 24h volume left in step 8.5
 * and have not come back.
 *
 * The exchange link sits at the end of it, at the panel's quietest edge. It is
 * the one control here that leaves the app, and it was competing with the P&L
 * for the top-right corner.
 */
/**
 * Fly a fired level's chip to the timeline card of the turn it caused.
 *
 * The chip has already played its ripple; ~400ms in, a single ghost element
 * (a copy of the chip) travels from the gutter to the card over ~520ms on
 * transform and opacity alone, and is removed when it lands. The card keeps a
 * brief highlight so the flight has a visible destination. Instant-off under
 * `prefers-reduced-motion`: no ghost is made at all.
 */
function flyChipToCard(chipEl: HTMLElement, cardEl: HTMLElement): void {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  // The source rect is captured now: the chip itself is retiring and may be
  // gone by the time the flight starts.
  const from = chipEl.getBoundingClientRect();
  cardEl.scrollIntoView({ block: "nearest", behavior: "instant" });
  const chipClass = chipEl.className;
  const chipText = chipEl.textContent ?? "";
  const launch = window.setTimeout(() => {
    const to = cardEl.getBoundingClientRect();
    if (from.width === 0 || to.width === 0) return;
    const ghost = document.createElement("span");
    ghost.textContent = chipText;
    ghost.className = chipClass;
    ghost.style.position = "fixed";
    ghost.style.left = `${from.left}px`;
    ghost.style.top = `${from.top}px`;
    ghost.style.margin = "0";
    ghost.style.zIndex = "50";
    ghost.style.pointerEvents = "none";
    document.body.appendChild(ghost);
    const flight = ghost.animate(
      [
        { transform: "translate(0, 0) scale(1)", opacity: 1 },
        {
          transform: `translate(${to.left + to.width / 2 - (from.left + from.width / 2)}px, ${
            to.top + to.height / 2 - (from.top + from.height / 2)
          }px) scale(0.7)`,
          opacity: 0.3,
        },
      ],
      { duration: 520, easing: "cubic-bezier(0.33, 1, 0.68, 1)" },
    );
    void flight.finished.then(() => ghost.remove()).catch(() => ghost.remove());
    cardEl.classList.add("mission-card-flash");
    window.setTimeout(() => cardEl.classList.remove("mission-card-flash"), 950);
  }, 400);
  // If the panel unmounts mid-flight there is nothing to clean that the
  // reader can still see: the ghost removes itself, and a detached card
  // element holding a class harms nothing.
  void launch;
}

/**
 * The newest thing the harness did, for the status bar's activity segment.
 *
 * The timeline already carries composed prose for every wake, publish and
 * stop move; the bar shows the newest one with its age, so a glance says not
 * just what the mission is doing but what the model last did about it.
 */
function deriveLastActivity(
  timeline: ReadonlyArray<{
    readonly at: string;
    readonly label: string;
    readonly kind?: string | undefined;
    readonly cause?: string | undefined;
  }>,
  nowMillis: number,
): { readonly label: string; readonly ageLabel: string } | null {
  const newest = timeline[0];
  if (newest === undefined) return null;
  const at = Date.parse(newest.at);
  if (Number.isNaN(at)) return null;
  // A wake's label is the run cause verbatim, a literal the harness writes for
  // itself: the bar was printing `market_watch_triggered` at the reader. The
  // timeline cards already say it in words, and this is the same event, so it
  // gets the same sentence. Every other kind is already composed prose.
  const label =
    newest.kind === "wake" ? describeWakeTrigger(newest.cause ?? newest.label) : newest.label;
  return {
    label,
    ageLabel: formatDuration(Math.max(0, nowMillis - at)),
  };
}

function MissionStatusBar({
  headline,
  because,
  plan,
  countdown,
  projection,
  tone,
  data,
  isHolding,
  holdLabel,
  modeLabel,
  exchangeUrl,
  lastActivity,
}: {
  readonly headline: string;
  /** The plan's thesis, carried as the headline's hover. It has no paragraph
   *  on the readout card any more, so this is the cheapest of its two homes —
   *  the other being the plan popup's own first field. */
  readonly because: string | null;
  /** The published plan, for the popup. Null while planning: there is none. */
  readonly plan: StrategyPlan | null;
  /** How long until the next reassessment. Null when none is armed. */
  readonly countdown: string | null;
  /** The plan's own price prediction — the bar's twin of the chart's dotted
   *  line. Absent on a stand-aside, which states none. */
  readonly projection: {
    readonly direction: "long" | "short";
    readonly price: number;
    readonly atMillis: number;
  } | null;
  /** Tinted by the exposure, not by the market: the bar states what this
   *  mission is doing, and a flat mission is neither winning nor losing. */
  readonly tone: "profit" | "loss" | "flat";
  readonly data: TradingMarketChartView | null;
  readonly isHolding: boolean;
  readonly holdLabel: string | null;
  /** The playbook this mission executes, when it executes one rather than
   *  deciding for itself. Read from the mandate, so nothing else on the panel
   *  can disagree with it. */
  readonly modeLabel: string | null;
  readonly exchangeUrl: string | null;
  /** The newest timeline entry — what the model last did, and how long ago. */
  readonly lastActivity: { readonly label: string; readonly ageLabel: string } | null;
}): ReactNode {
  const dotTone =
    tone === "profit" ? "bg-profit" : tone === "loss" ? "bg-loss" : "bg-muted-foreground";
  return (
    <div
      data-testid="mission-status-bar"
      className={cn(
        CARD_CLASS,
        BAND_PAD_CLASS,
        // `lg:min-h` because the bar's own height is state-dependent: the plan
        // pill is 3px taller than bare text, so a planning mission (no plan,
        // no pill) made this bar 42px and every other state 43-45px — and the
        // chart above it absorbed the difference. Reserved, like everything
        // else in the panel. Below `lg` the bar is allowed to wrap and grow.
        "flex flex-none flex-wrap items-center gap-x-4 gap-y-1 py-2.5 lg:min-h-[45px]",
      )}
    >
      {/* The one dot on the panel. It carries real state — flat, up, down —
          and it is what makes this a status bar rather than another figure
          strip. */}
      <span className={cn("size-1.5 flex-none rounded-full", dotTone)} aria-hidden />
      <span
        className="flex-none text-[13px] text-foreground"
        {...(because === null || because === "" ? {} : { title: because })}
      >
        {headline}
      </span>

      {/* The three objects this bar exists for, in the DOM directly after the
          headline so a wrapped bar keeps them on its first row. None of them
          hides at any width: the ambient cluster on the right gives up its
          segments first, and the activity segment truncates before that. */}
      {plan === null ? null : <PlanPopover plan={plan} />}
      {countdown === null ? null : (
        <span
          data-testid="mission-next-reassessment"
          className="flex flex-none items-center gap-1.5 font-mono text-[11px] tabular-nums text-muted-foreground"
          // oxlint-disable-next-line t3code/no-native-title-tooltip -- Upstream's new rule wants the styled Tooltip here. Converting the mission panel's hover copy is a UI change with its own live verification, not part of an upstream sync.
          title="When the mission next reconsiders its plan. The chart's future gutter draws the same appointment as a rule: that says where on the axis, this says how long."
        >
          <Clock className="size-3" strokeWidth={2} aria-hidden />
          next {countdown}
        </span>
      )}
      {projection === null ? null : (
        <span
          data-testid="mission-projection"
          className="flex flex-none items-center gap-1.5 font-mono text-[11px] tabular-nums text-muted-foreground"
          // oxlint-disable-next-line t3code/no-native-title-tooltip -- Upstream's new rule wants the styled Tooltip here. Converting the mission panel's hover copy is a UI change with its own live verification, not part of an upstream sync.
          title="The plan's own price prediction; the dotted line on the chart is this object."
        >
          {projection.direction === "long" ? (
            <TrendingUp className="size-3" strokeWidth={2} aria-hidden />
          ) : (
            <TrendingDown className="size-3" strokeWidth={2} aria-hidden />
          )}
          <span>
            → {formatPrice(projection.price)} by{" "}
            {new Date(projection.atMillis).toLocaleTimeString(undefined, {
              hour: "numeric",
              minute: "2-digit",
            })}
          </span>
        </span>
      )}

      {/* What the model last did, in its own composed words. The headline says
          the state; this says the most recent step the harness took toward it
          — the one line of model activity the panel has room for. Truncated,
          with the full sentence a hover away. */}
      {lastActivity === null ? null : (
        <span
          data-testid="mission-last-activity"
          className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground"
          // oxlint-disable-next-line t3code/no-native-title-tooltip -- Upstream's new rule wants the styled Tooltip here. Converting the mission panel's hover copy is a UI change with its own live verification, not part of an upstream sync.
          title={lastActivity.label}
        >
          {lastActivity.label}
          <span className="text-muted-foreground"> · {lastActivity.ageLabel} ago</span>
        </span>
      )}
      {/* The ambient cluster, and the bar's overflow budget.
          At `lg` and above the bar is one line, so something has to give as it
          narrows. In order: the activity segment truncates (it already carries
          `flex-1 truncate`), then funding drops, then hold time, then the mode.
          The plan pill, the countdown and the prediction never drop — they are
          why this bar exists. Below `lg` the bar is allowed a second row, so
          every segment comes back rather than staying hidden on the narrowest
          screens, which is what a plain `hidden lg:inline` would have done. */}
      <span className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] tabular-nums text-muted-foreground lg:flex-nowrap">
        {isHolding && holdLabel !== null ? (
          <span className="whitespace-nowrap lg:hidden xl:inline">Held {holdLabel}</span>
        ) : null}
        {isHolding && data !== null ? (
          <span className="whitespace-nowrap lg:hidden 2xl:inline">
            Funding {(data.fundingRate8h * 100).toFixed(4)}%/8h
          </span>
        ) : null}
        {modeLabel === null ? null : (
          <span
            data-testid="mission-mode"
            className="whitespace-nowrap uppercase tracking-[0.12em]"
            // oxlint-disable-next-line t3code/no-native-title-tooltip -- Upstream's new rule wants the styled Tooltip here. Converting the mission panel's hover copy is a UI change with its own live verification, not part of an upstream sync.
            title="This mission executes a named playbook rather than deciding for itself. It is read from the mandate."
          >
            execute · {modeLabel}
          </span>
        )}
        {exchangeUrl === null ? null : (
          <a
            href={exchangeUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline group-hover/panel:text-muted-foreground motion-reduce:transition-none"
          >
            Hyperliquid
            <ExternalLinkIcon className="size-3" aria-hidden />
          </a>
        )}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The positions card (plan 39 phase 2): one list, one row per order leg.
// ---------------------------------------------------------------------------

/** The word each order state shows, verbatim from the ledger's vocabulary. */
const ORDER_STATE_WORD: Record<OrderLedgerState, string> = {
  planned: "planned",
  queued: "queued",
  working: "working",
  partial: "partial",
  open: "open",
  closed: "closed",
  cancelled: "cancelled",
  rejected: "rejected",
};

/** The ink class an order state's word and dot wear. */
function orderStateTone(state: OrderLedgerState): string {
  switch (state) {
    case "working":
    case "partial":
      return "text-armed";
    case "open":
      return "text-info";
    case "rejected":
      return "text-loss";
    default:
      return "text-muted-foreground";
  }
}

/**
 * The state token: a dot and a word. Open vs close is carried by fill, reusing
 * the chart's own convention — open legs are a filled circle, closing legs a
 * hollow ring — so green and red stay reserved for money.
 */
function OrderStateToken({
  state,
  isClose,
  settleKey,
}: {
  readonly state: OrderLedgerState;
  readonly isClose: boolean;
  /** Changes when the state changes, so the cross-fade plays exactly once. */
  readonly settleKey: string;
}): ReactNode {
  const tone = orderStateTone(state);
  const dotClass =
    state === "working" || state === "partial"
      ? "bg-armed"
      : state === "open"
        ? "bg-info"
        : state === "rejected"
          ? "bg-loss"
          : "bg-muted-foreground/50";
  return (
    <span
      key={settleKey}
      className={cn("mission-order-settle flex items-center gap-1.5 whitespace-nowrap", tone)}
    >
      {isClose ? (
        <span
          className={cn("size-2 flex-none rounded-full border-[1.5px]", {
            "border-armed": state === "working" || state === "partial",
            "border-info": state === "open",
            "border-loss": state === "rejected",
            "border-muted-foreground/50":
              state !== "working" &&
              state !== "partial" &&
              state !== "open" &&
              state !== "rejected",
          })}
          aria-hidden
        />
      ) : (
        <span
          className={cn(
            "size-2 flex-none rounded-full",
            state === "planned" ? "border border-dashed border-muted-foreground/50" : dotClass,
          )}
          aria-hidden
        />
      )}
      <span className="uppercase tracking-[0.1em] text-[10px]">{ORDER_STATE_WORD[state]}</span>
    </span>
  );
}

/**
 * One order leg's full record, behind the row's hover/press — the same job
 * `LedgerDetail` did for round trips. The open leg carries the position's own
 * figures (mark, stop, liq, margin, protection), which is where the old stat
 * grid's cells live now.
 */
function OrderDetail({
  row,
  market,
  position,
  markPrice,
  stopPrice,
}: {
  readonly row: OrderLedgerRow;
  readonly market: string;
  readonly position: {
    readonly size: number;
    readonly entryPrice?: number | undefined;
    readonly liquidationPrice?: number | undefined;
    readonly marginUsed: number;
    readonly protectedSize: number;
  } | null;
  readonly markPrice: number | null;
  readonly stopPrice: number | null;
}): ReactNode {
  const lines: Array<{ readonly label: string; readonly value: string; readonly tone?: string }> =
    [];
  lines.push({ label: "State", value: ORDER_STATE_WORD[row.state] });
  if (row.sizeUnits !== null)
    lines.push({ label: "Size", value: `${formatSize(row.sizeUnits)} ${market}` });
  if (row.sizeUsd !== null) lines.push({ label: "Notional", value: formatUsd(row.sizeUsd) });
  if (row.price !== null)
    lines.push({ label: row.isClose ? "Exit" : "Entry", value: formatPrice(row.price) });
  if (row.state === "open" && position !== null) {
    if (markPrice !== null) lines.push({ label: "Mark", value: formatPrice(markPrice) });
    lines.push(
      stopPrice === null
        ? { label: "Stop", value: "None", tone: "text-loss" }
        : { label: "Stop", value: formatPrice(stopPrice) },
    );
    if (position.liquidationPrice !== undefined)
      lines.push({ label: "Liq", value: formatPrice(position.liquidationPrice) });
    if (position.marginUsed > 0)
      lines.push({ label: "Margin", value: formatUsd(position.marginUsed) });
    const covered = Math.abs(position.protectedSize);
    const held = Math.abs(position.size);
    if (stopPrice !== null && covered < held)
      lines.push({
        label: "Protected",
        value: covered === 0 ? "None" : `${formatSize(covered)} of ${formatSize(held)}`,
        tone: "text-loss",
      });
  }
  if (row.feeUsd !== null) lines.push({ label: "Fees", value: formatUsd(row.feeUsd) });
  if (row.valueUsd !== null)
    lines.push({
      label: row.state === "open" ? "Unrealised net" : "Net",
      value: formatSignedUsd(row.valueUsd),
      tone: row.valueUsd >= 0 ? "text-profit" : "text-loss",
    });
  if (row.orderRef !== null) lines.push({ label: "Order", value: row.orderRef });
  return (
    <div className="flex w-56 flex-col gap-1.5 text-left">
      {lines.map((line) => (
        <div key={line.label} className="flex items-baseline justify-between gap-4">
          <span className="text-xs text-muted-foreground">{line.label}</span>
          <span
            className={cn(
              "text-right font-mono text-[11px] tabular-nums",
              line.tone ?? "text-foreground",
            )}
          >
            {line.value}
          </span>
        </div>
      ))}
    </div>
  );
}

/** The positions card's column headings, in the ledger's legend ink. */
function OrderHeading({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <span className={cn(BAND_LEGEND_CLASS, "whitespace-nowrap text-right text-muted-foreground")}>
      {children}
    </span>
  );
}

/** One order leg as a row of the positions card. */
function OrderRowView({
  row,
  market,
  leverageLabel,
  position,
  markPrice,
  stopPrice,
  nowMillis,
  sizeUnit,
  onToggleUnit,
  ringToneClass,
}: {
  readonly row: OrderLedgerRow;
  readonly market: string;
  readonly leverageLabel: string | null;
  readonly position: {
    readonly size: number;
    readonly entryPrice?: number | undefined;
    readonly liquidationPrice?: number | undefined;
    readonly marginUsed: number;
    readonly protectedSize: number;
  } | null;
  readonly markPrice: number | null;
  readonly stopPrice: number | null;
  readonly nowMillis: number;
  readonly sizeUnit: "usd" | "units";
  readonly onToggleUnit: () => void;
  /** Non-null while the one-shot filled ring should play, carrying its tone. */
  readonly ringToneClass: string | null;
}): ReactNode {
  const isLong = row.direction === "long";
  const sizeReading =
    sizeUnit === "usd"
      ? row.sizeUsd === null
        ? "-"
        : formatUsd(row.sizeUsd)
      : row.sizeUnits === null
        ? "-"
        : `${formatSize(row.sizeUnits)} ${market}`;
  const otherReading =
    sizeUnit === "usd"
      ? row.sizeUnits === null
        ? "size in units unknown"
        : `${formatSize(row.sizeUnits)} ${market}`
      : row.sizeUsd === null
        ? "notional unknown"
        : formatUsd(row.sizeUsd);
  const timeLabel = row.isLive
    ? row.state === "planned"
      ? "-"
      : formatAge(Math.max(0, nowMillis - row.atMillis))
    : new Date(row.atMillis).toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
      });
  const label = [
    `${ORDER_STATE_WORD[row.state]} ${row.isClose ? "closing" : "opening"} ${
      isLong ? "long" : "short"
    } leg`,
    `size ${sizeReading} (${otherReading})`,
    row.price === null ? "no price yet" : `at ${formatPrice(row.price)}`,
    row.valueUsd === null ? "no value yet" : `worth ${formatSignedUsd(row.valueUsd)} net of fees`,
    `as of ${timeLabel}`,
    "press for the leg's full detail, and to switch the size column between dollars and units",
  ].join(", ");

  return (
    // A popover, not a tooltip: the detail carries the leg's stop, liquidation
    // and margin, and Base UI (correctly) never opens a tooltip for touch, so
    // on a phone those risk figures had no way in at all. `openOnHover` keeps
    // the pointer behaviour a hover exactly as it was, and gives touch and
    // keyboard the press they already expect. The press still flips the size
    // unit; the two are the row's read and its toggle, not one action.
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={0}
        render={
          <button
            type="button"
            aria-label={label}
            onClick={onToggleUnit}
            data-order-state={row.state}
            className={cn(
              "mission-order-enter relative col-span-full grid h-7 grid-cols-subgrid items-center gap-x-3 overflow-hidden rounded-full border px-2 text-left font-mono text-[11px] tabular-nums outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
              ringToneClass,
              row.state === "planned"
                ? "border-dashed border-border/70 bg-foreground/[0.02]"
                : row.isLive
                  ? "border-border bg-foreground/[0.06] hover:bg-foreground/[0.09]"
                  : "border-border/60 bg-foreground/[0.03] hover:bg-foreground/[0.06]",
            )}
          />
        }
      >
        {/* The partial-fill track, behind the row: a CSS width transition, not
            a keyframe, so successive partials grow it continuously. */}
        {row.filledFraction === null ? null : (
          <span
            className="absolute inset-y-0 left-0 rounded-full bg-armed/[0.12] transition-[width] duration-[600ms] ease-out"
            style={{ width: `${Math.round(row.filledFraction * 100)}%` }}
            aria-hidden
          />
        )}
        <SideChip market={market} leverageLabel={leverageLabel} isLong={isLong} size="sm" />
        <OrderStateToken
          state={row.state}
          isClose={row.isClose}
          settleKey={`${row.key}-${row.state}`}
        />
        <span className="whitespace-nowrap text-right text-muted-foreground">
          {row.price === null ? "-" : formatPrice(row.price)}
        </span>
        {/* The size column: tap anywhere on the row to flip its unit. The
            figure cross-fades; the column does not resize. */}
        <span className="whitespace-nowrap text-right text-muted-foreground">
          <span key={sizeUnit} className="mission-size-crossfade inline-block min-w-[64px]">
            {sizeReading}
          </span>
        </span>
        <span
          className={cn(
            "whitespace-nowrap text-right",
            row.valueUsd === null
              ? "text-muted-foreground"
              : row.valueUsd >= 0
                ? "text-profit"
                : "text-loss",
          )}
        >
          {row.valueUsd === null ? "-" : formatSignedUsd(row.valueUsd)}
        </span>
        <span className="whitespace-nowrap text-right text-muted-foreground">{timeLabel}</span>
      </PopoverTrigger>
      <PopoverPopup side="left" tooltipStyle className="max-w-none">
        <OrderDetail
          row={row}
          market={market}
          position={position}
          markPrice={markPrice}
          stopPrice={stopPrice}
        />
      </PopoverPopup>
    </Popover>
  );
}

/**
 * The positions card: header (legend + the money headline), the column
 * headings, and one row per order leg — the live band pinned, settled legs
 * scrolling beneath, `+N earlier` past the cap. The card's height is fixed by
 * its parent; the scroller is what bounds the list, never a dropped row.
 */
function PositionsCard({
  rows,
  market,
  leverageLabel,
  position,
  markPrice,
  stopPrice,
  plan,
  roiPercent,
  pnlToneClass,
  nowMillis,
  staleLabel,
}: {
  readonly rows: ReadonlyArray<OrderLedgerRow>;
  readonly market: string;
  readonly leverageLabel: string | null;
  readonly position: {
    readonly size: number;
    readonly entryPrice?: number | undefined;
    readonly unrealisedPnl: number;
    readonly liquidationPrice?: number | undefined;
    readonly marginUsed: number;
    readonly protectedSize: number;
  } | null;
  readonly markPrice: number | null;
  readonly stopPrice: number | null;
  readonly plan: StrategyPlan | null;
  readonly roiPercent: number | null;
  readonly pnlToneClass: string;
  readonly nowMillis: number;
  /** The staleness word, qualifying every live figure on the card. */
  readonly staleLabel: string | null;
}): ReactNode {
  const sizeUnit = useMissionSizeUnit((store) => store.unit);
  const toggleUnit = useMissionSizeUnit((store) => store.toggle);

  // Past the cap the older settled legs are collapsed, not dropped: the
  // scrollback stays short by default and the count expands into the full
  // order history, which is the only record of what the mission did.
  const [showAllSettled, setShowAllSettled] = useState(false);

  // One-shot filled-ring bookkeeping: a leg that just became `open`, or a
  // closing leg that just settled, pulses once. Keyed on the state transition
  // the panel itself observed, so the 3s poll cannot replay it.
  const prevStates = useRef<Map<string, OrderLedgerState>>(new Map());
  const ringsAt = useRef<Map<string, { at: number; tone: string }>>(new Map());
  for (const row of rows) {
    const prev = prevStates.current.get(row.key);
    if (prev !== undefined && prev !== row.state) {
      if (row.state === "open") {
        ringsAt.current.set(row.key, { at: nowMillis, tone: "mission-order-filled-ring-info" });
      } else if (row.state === "closed" && row.isClose) {
        ringsAt.current.set(row.key, {
          at: nowMillis,
          tone:
            (row.valueUsd ?? 0) >= 0
              ? "mission-order-filled-ring-profit"
              : "mission-order-filled-ring-loss",
        });
      }
    }
    prevStates.current.set(row.key, row.state);
  }
  const ringFor = (key: string): string | null => {
    const ring = ringsAt.current.get(key);
    if (ring === undefined) return null;
    if (nowMillis - ring.at > 700) {
      ringsAt.current.delete(key);
      return null;
    }
    return ring.tone;
  };

  const live = rows.filter((row) => row.isLive);
  const settledAll = rows.filter((row) => !row.isLive);
  const settled = showAllSettled ? settledAll : settledAll.slice(0, MAX_ORDER_ROWS);
  const earlier = settledAll.length - settled.length;

  const renderRow = (row: OrderLedgerRow): ReactNode => (
    <OrderRowView
      key={row.key}
      row={row}
      market={market}
      leverageLabel={leverageLabel}
      position={position}
      markPrice={markPrice}
      stopPrice={stopPrice}
      nowMillis={nowMillis}
      sizeUnit={sizeUnit}
      onToggleUnit={toggleUnit}
      ringToneClass={ringFor(row.key)}
    />
  );

  return (
    <>
      {/* The header: the card's name, the staleness word when it applies, and
          the money headline — live unrealised while a leg is open, the plan's
          committed reading otherwise. The right slot is never blank. */}
      <div className={cn(BAND_PAD_CLASS, "flex flex-none items-center gap-x-3 pb-1.5 pt-2.5")}>
        {/* The left group gives ground first: the money figure on the right is
            the reading this header exists for, so it never truncates and the
            legend + staleness word shrink around it. */}
        <p className={cn(BAND_LEGEND_CLASS, "flex-none")}>positions</p>
        {staleLabel === null ? null : (
          <span
            className="flex min-w-0 items-center gap-1 truncate font-mono text-[11px] uppercase tracking-[0.1em] text-armed"
            // oxlint-disable-next-line t3code/no-native-title-tooltip -- Upstream's new rule wants the styled Tooltip here. Converting the mission panel's hover copy is a UI change with its own live verification, not part of an upstream sync.
            title="The position read is behind. Placement is only suspended once it stops landing altogether."
          >
            <Clock className="size-3" strokeWidth={2} aria-hidden />
            {staleLabel}
          </span>
        )}
        {position !== null ? (
          <span className="ml-auto flex flex-none items-baseline gap-2">
            <span className={cn(BAND_LEGEND_CLASS, "hidden uppercase tracking-[0.14em] xl:inline")}>
              unrealised
            </span>
            {roiPercent === null ? null : (
              <span className={cn("font-mono text-[11px] tabular-nums", pnlToneClass)}>
                {formatSignedPercent(roiPercent)}
              </span>
            )}
            <span
              className={cn(
                "font-mono text-[15px] leading-none tracking-[-0.02em] tabular-nums",
                pnlToneClass,
              )}
            >
              <AnimatedUsd value={position.unrealisedPnl} />
            </span>
          </span>
        ) : plan !== null &&
          plan.isStandAside !== true &&
          plan.maxLossUsd !== null &&
          plan.targetUsd !== null ? (
          <span className="ml-auto flex-none font-mono text-[12px] tabular-nums">
            <span className="text-loss">{formatSignedUsd(-plan.maxLossUsd)}</span>
            <span className="text-muted-foreground"> → </span>
            <span className="text-profit">{formatSignedUsd(plan.targetUsd)}</span>
          </span>
        ) : (
          <span className="ml-auto flex-none font-mono text-[12px] text-muted-foreground">-</span>
        )}
      </div>

      {rows.length === 0 ? (
        // The empty state, in the skeleton idiom: the same headings and row
        // rhythm, naming the columns that are about to fill. With the planned
        // ghost row this only appears before the first plan exists.
        <div className={cn(BAND_PAD_CLASS, "flex-1 pb-3")}>
          <div className="grid grid-cols-[auto_auto_repeat(3,minmax(max-content,1fr))_auto] gap-y-1.5">
            <div className="col-span-full grid grid-cols-subgrid gap-x-3 border border-transparent px-2 pb-0.5">
              <span />
              <OrderHeading>state</OrderHeading>
              <OrderHeading>entry / exit</OrderHeading>
              <OrderHeading>size</OrderHeading>
              <OrderHeading>usd</OrderHeading>
              <OrderHeading>time</OrderHeading>
            </div>
            <div
              data-testid="mission-positions-empty"
              className="col-span-full flex h-7 items-center rounded-full border border-dashed border-border/50 bg-foreground/[0.02] px-3 font-mono text-[11px] text-muted-foreground"
            >
              <span>{market}</span>
              <span className="ml-2 opacity-70">no orders yet</span>
              <span className={cn("ml-auto", BAND_LEGEND_CLASS)}>fills on the entry</span>
            </div>
          </div>
        </div>
      ) : (
        // ONE grid for the whole band — headings and rows share its column
        // tracks, so a heading can never drift off the figures it names. The
        // scroller wraps that single grid: vertically because the card's height
        // is fixed, horizontally because six columns of figures do not fit the
        // left column at every width, and a row that scrolls as a unit is the
        // house answer to a wide region (never a clipped figure).
        <div
          className={cn(
            BAND_PAD_CLASS,
            // Bounded below `lg` for the same reason the agent log is: the
            // stacked panel has no fixed parent to flex against.
            "max-h-[220px] min-h-0 flex-1 overflow-y-auto overflow-x-auto overscroll-contain pb-3 lg:max-h-none",
          )}
        >
          <div className="grid min-w-max grid-cols-[auto_auto_repeat(3,minmax(max-content,1fr))_auto] gap-y-1.5">
            {/* The headings ride the scroll: they are the first row of the same
                grid, pinned so the columns stay named while settled legs pass
                under them. */}
            <div className="sticky top-0 z-20 col-span-full grid grid-cols-subgrid gap-x-3 border border-transparent bg-card px-2 pb-0.5">
              <span />
              <OrderHeading>state</OrderHeading>
              <OrderHeading>entry / exit</OrderHeading>
              {/* The size column's unit is a panel-wide preference; the heading
                  is the keyboard path to the same toggle every row offers. */}
              <button
                type="button"
                onClick={toggleUnit}
                aria-pressed={sizeUnit === "usd"}
                aria-label={`Size column shows ${
                  sizeUnit === "usd" ? "USD notional" : `${market} units`
                }; press to switch to ${sizeUnit === "usd" ? `${market} units` : "USD notional"}`}
                className={cn(
                  BAND_LEGEND_CLASS,
                  "whitespace-nowrap rounded text-right text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                )}
              >
                size · {sizeUnit === "usd" ? "$" : market.toLowerCase()}
              </button>
              <OrderHeading>usd</OrderHeading>
              <OrderHeading>time</OrderHeading>
            </div>
            {/* The live band — planned / queued / working / partial and the
                open leg — pinned under the headings, above the settled
                scrollback: the same shape the agent log keeps for its armed
                rows. Bounded to four rows, because pinned it covers the top of
                the scroller for the whole scroll: a long live band (scaled in
                several times, with working orders alongside) would otherwise
                sit over the settled legs and put their history out of reach.
                Past the cap the band scrolls on its own and the scrollback
                below it stays reachable. */}
            {live.length === 0 ? null : (
              <div className="sticky top-[19px] z-10 col-span-full grid max-h-[8.5rem] grid-cols-subgrid gap-y-1.5 overflow-y-auto overscroll-contain bg-card pb-0.5">
                {live.map(renderRow)}
                {settled.length === 0 ? null : (
                  <div className="col-span-full h-px bg-border" aria-hidden />
                )}
              </div>
            )}
            {settled.map(renderRow)}
            {settledAll.length <= MAX_ORDER_ROWS ? null : (
              <button
                type="button"
                onClick={() => setShowAllSettled((open) => !open)}
                data-testid="mission-positions-earlier"
                className="col-span-full rounded text-left font-mono text-[11px] tabular-nums text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
              >
                {showAllSettled ? "fewer" : `+${earlier} earlier`}
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// The agent log (plan 39 phase 3): nothing but log.
// ---------------------------------------------------------------------------

/** The tone class pair for a log row's rail and icon token. */
const LOG_TONES: Record<string, { rail: string; token: string; icon: string }> = {
  armed: { rail: "bg-armed", token: "bg-armed/10", icon: "text-armed" },
  info: { rail: "bg-info", token: "bg-info/10", icon: "text-info" },
  profit: { rail: "bg-profit", token: "bg-profit/10", icon: "text-profit" },
  loss: { rail: "bg-loss", token: "bg-loss/10", icon: "text-loss" },
  muted: {
    rail: "bg-muted-foreground/30",
    token: "bg-foreground/[0.06]",
    icon: "text-muted-foreground",
  },
};

/**
 * One log row: a 2px tone rail, a 16px round icon token, one clamped prose
 * line, the mono figure, and the clock. Every row in the log — watch or turn —
 * is this one silhouette, readable at a glance without adding a word.
 */
function LogRow({
  tone,
  Icon,
  srWord,
  prose,
  title,
  figure,
  timeLabel,
  isSelected,
  dataAttrs,
  hoverProps,
}: {
  readonly tone: keyof typeof LOG_TONES;
  readonly Icon: LucideIcon;
  /** The row's kind, read back to screen readers before the prose. */
  readonly srWord: string;
  readonly prose: ReactNode;
  readonly title?: string | undefined;
  readonly figure: string | null;
  readonly timeLabel: string;
  readonly isSelected: boolean;
  readonly dataAttrs?: Record<string, string> | undefined;
  readonly hoverProps?:
    | {
        readonly onMouseEnter: () => void;
        readonly onMouseLeave: () => void;
      }
    | undefined;
}): ReactNode {
  const tones = LOG_TONES[tone] ?? LOG_TONES["muted"]!;
  return (
    <div
      {...dataAttrs}
      {...hoverProps}
      {...(title === undefined ? {} : { title })}
      className={cn(
        BAND_PAD_CLASS,
        "mission-log-enter relative flex items-center gap-x-2 py-2 text-[12px] leading-snug",
        isSelected && "bg-armed/10",
      )}
    >
      <span
        className={cn(
          "mission-log-rail absolute inset-y-1.5 left-1.5 w-[2px] rounded-full",
          tones.rail,
        )}
        aria-hidden
      />
      <span
        className={cn(
          "mission-log-token grid size-4 flex-none place-items-center rounded-full",
          tones.token,
        )}
      >
        <Icon className={cn("size-[11px]", tones.icon)} strokeWidth={2} aria-hidden />
      </span>
      <span className="sr-only">{srWord}: </span>
      <span className="min-w-0 flex-1 truncate text-foreground/90">{prose}</span>
      {figure === null ? null : (
        <span className="flex-none font-mono text-[11px] tabular-nums text-muted-foreground">
          {figure}
        </span>
      )}
      <span className="flex-none font-mono text-[10.5px] tabular-nums text-muted-foreground">
        {timeLabel}
      </span>
    </div>
  );
}

/** A watch row's icon, tone and kind word, per the plan-39 icon map. */
function watchRowIdentity(row: WatchStreamRow): {
  Icon: LucideIcon;
  tone: keyof typeof LOG_TONES;
  word: string;
} {
  if (row.state === "armed") return { Icon: Crosshair, tone: "armed", word: "watch armed" };
  if (row.state === "triggered") return { Icon: BellRing, tone: "info", word: "watch fired" };
  return { Icon: CircleSlash, tone: "muted", word: "watch retired" };
}

/** A turn card's icon, tone and kind word, per the plan-39 icon map. */
function turnCardLogIdentity(card: TurnTimelineCard): {
  Icon: LucideIcon;
  tone: keyof typeof LOG_TONES;
  word: string;
} {
  if (card.kind === "trade") {
    // An opening fill is `neutral`: it has realised nothing yet, so painting
    // it with the profit rail would claim a gain that does not exist. Only a
    // closing fill's realised sign earns the profit/loss tones.
    return {
      Icon: Receipt,
      tone: card.tone === "loss" ? "loss" : card.tone === "profit" ? "profit" : "info",
      word: "trade",
    };
  }
  if (card.kind === "note") return { Icon: NotebookPen, tone: "muted", word: "journal note" };
  if (card.kind === "revision") {
    // A stop move and a plan publish share the `revision` kind, and the id
    // prefix is the only thing that separates them without reaching into
    // `missionTurnTimeline.ts`, which this plan lists as out of scope. Both
    // prefixes are assigned in one place there, so the join is stable — but a
    // third `revision` kind added later must widen this, not fall through to
    // the publish glyph.
    if (card.id.startsWith("stop-"))
      return { Icon: ShieldCheck, tone: "armed", word: "stop moved" };
    return { Icon: Route, tone: "info", word: "plan published" };
  }
  // A wake: a level is an arrival, a timer is ambient. Stand-asides and pure
  // reads keep their own glyphs so the scrollback's silhouettes say what the
  // turn actually was. Read off the composed prose for the same reason the
  // revision split is read off the id: the phrases come from one authority
  // (`describeWakeTrigger` / `describeWakeReads`) that this plan does not
  // change, and an unmatched wake falls back to the clock glyph rather than
  // borrowing a shape that would claim something.
  if (card.decisionLabel !== null && /\baside\b/i.test(card.decisionLabel)) {
    return { Icon: Hand, tone: "muted", word: "stood aside" };
  }
  if (card.triggerLabel !== null && card.triggerLabel.startsWith("A level")) {
    return { Icon: Zap, tone: "info", word: "woke on a level" };
  }
  if (card.readLabel !== null && card.decisionLabel === null) {
    return {
      Icon: card.readLabel.includes("strategy sheet") ? BookOpen : Eye,
      tone: "muted",
      word: "looked at the market",
    };
  }
  return { Icon: AlarmClock, tone: card.tone === "loss" ? "loss" : "muted", word: "woke" };
}

/** One entry of the merged scrollback: a settled watch item or a turn card. */
type AgentLogEntry =
  | { readonly kind: "watch"; readonly item: WatchStreamItem }
  | { readonly kind: "card"; readonly card: TurnTimelineCard };

const logEntryAt = (entry: AgentLogEntry): number =>
  entry.kind === "watch" ? entry.item.atMillis : entry.card.atMillis;

/** A clock time, as every settled log row states it. */
function logClock(atMillis: number): string {
  return new Date(atMillis).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * The agent log: armed alerts pinned at the top, and one chronological
 * scrollback merging the settled watches and the turn cards, newest first.
 * More visual, not more text — every row is the same rail/token silhouette.
 */
function AgentLog({
  stream,
  cards,
  earlierTurns,
  nowMillis,
  recentlyFired,
  droppedConditions,
  overflowRows,
  selection,
  onHoverEvent,
}: {
  readonly stream: ReadonlyArray<WatchStreamItem>;
  readonly cards: ReadonlyArray<TurnTimelineCard>;
  readonly earlierTurns: number;
  readonly nowMillis: number;
  readonly recentlyFired: ReadonlySet<string>;
  readonly droppedConditions: number;
  readonly overflowRows: ReadonlyArray<{
    readonly price: number;
    readonly direction: "above" | "below";
    readonly met: boolean;
    readonly id?: string | undefined;
  }>;
  readonly selection: ChartEventSelection | null;
  readonly onHoverEvent: (event: { id: string; atMillis: number } | null) => void;
}): ReactNode {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const [overflowOpen, setOverflowOpen] = useState(false);
  const overflowRef = useRef<HTMLDivElement | null>(null);
  const overflowSeenRef = useRef(false);
  useEffect(() => {
    if (selection?.source !== "chart" || selection.eventId !== "chip-overflow") return;
    if (overflowSeenRef.current) return;
    overflowSeenRef.current = true;
    setOverflowOpen(true);
    overflowRef.current?.scrollIntoView({ block: "nearest", behavior: "instant" });
    return () => {
      overflowSeenRef.current = false;
    };
  }, [selection]);

  // A watch that just fired holds its place among the armed rows for a beat,
  // so the operator sees the dot change rather than the row jump.
  const held = (item: WatchStreamItem) => isArmedRow(item) || recentlyFired.has(item.id);
  const armed = stream.filter(held);
  const settledAll = stream.filter((item) => !held(item));
  const settledShown = settledAll.slice(0, MAX_SETTLED_WATCH_ROWS);
  const earlierSettled = settledAll.length - settledShown.length;

  const entries: AgentLogEntry[] = [
    ...settledShown.map((item): AgentLogEntry => ({ kind: "watch", item })),
    ...cards.map((card): AgentLogEntry => ({ kind: "card", card })),
  ].sort((a, b) => logEntryAt(b) - logEntryAt(a));

  // A chart-side selection scrolls to its row here — one effect, both
  // namespaces (watch ids and card ids), the same join the two old lists kept.
  useEffect(() => {
    if (selection?.source !== "chart" || scrollRef.current === null) return;
    if (selection.eventId === "chip-overflow") return;
    const card = cards.find(
      (candidate) =>
        candidate.id === selection.eventId || isMomentSelected(selection, candidate.atMillis),
    );
    const watchTarget = stream.find(
      (item) =>
        item.id === selection.eventId ||
        (item.kind === "watch" && isMomentSelected(selection, item.atMillis)) ||
        (item.kind === "group" &&
          item.members.some((member) => isMomentSelected(selection, member.atMillis))),
    );
    const element =
      (card === undefined
        ? null
        : scrollRef.current.querySelector(`[data-timeline-card="${CSS.escape(card.id)}"]`)) ??
      (watchTarget === undefined
        ? null
        : scrollRef.current.querySelector(`[data-watch-row="${CSS.escape(watchTarget.id)}"]`));
    element?.scrollIntoView({ block: "nearest", behavior: "instant" });
  }, [selection, cards, stream]);

  const rowIsSelected = (item: WatchStreamItem): boolean => {
    if (selection === null) return false;
    if (selection.eventId === item.id) return true;
    if (item.kind === "watch") return isMomentSelected(selection, item.atMillis);
    return item.members.some((member) => isMomentSelected(selection, member.atMillis));
  };

  const renderWatchRow = (row: WatchStreamRow, live: boolean): ReactNode => {
    const identity = watchRowIdentity(row);
    const threshold =
      row.thresholdValue === null ? null : formatWatchFigure(row.watchType, row.thresholdValue);
    const observed =
      row.observedValue === null ? null : formatWatchFigure(row.watchType, row.observedValue);
    const titleParts = [
      row.description,
      observed === null || threshold === null
        ? null
        : `last read ${observed}, against ${threshold}`,
      row.actionLabel === null ? null : `then: ${row.actionLabel}`,
    ].filter((part): part is string => part !== null);
    return (
      <LogRow
        key={row.id}
        tone={row.state === "triggered" && recentlyFired.has(row.id) ? "info" : identity.tone}
        Icon={identity.Icon}
        srWord={identity.word}
        prose={
          <>
            {row.direction === null ? null : (
              <span className="mr-1 text-[9px] text-muted-foreground" aria-hidden>
                {row.direction === "above" ? "▲" : "▼"}
              </span>
            )}
            {row.description}
            {row.outcomeLabel === null ? null : (
              <span className="text-muted-foreground"> · {row.outcomeLabel}</span>
            )}
          </>
        }
        title={titleParts.join(" — ")}
        figure={threshold}
        timeLabel={live ? formatAge(Math.max(0, nowMillis - row.atMillis)) : logClock(row.atMillis)}
        isSelected={rowIsSelected(row)}
        dataAttrs={{ "data-watch-row": row.id }}
        hoverProps={{
          onMouseEnter: () => onHoverEvent({ id: row.id, atMillis: row.atMillis }),
          onMouseLeave: () => onHoverEvent(null),
        }}
      />
    );
  };

  const renderGroup = (group: WatchStreamGroup): ReactNode => (
    <details key={group.id} className="group">
      <summary
        aria-label={`${group.count} watches ${group.outcomeLabel}, ${logClock(group.atMillis)}`}
        data-watch-row={group.id}
        onMouseEnter={() => onHoverEvent({ id: group.id, atMillis: group.atMillis })}
        onMouseLeave={() => onHoverEvent(null)}
        className={cn(
          BAND_PAD_CLASS,
          "relative flex cursor-pointer list-none select-none items-center gap-x-2 py-2 text-[12px] leading-snug text-muted-foreground marker:hidden hover:bg-foreground/[0.02]",
          rowIsSelected(group) && "bg-armed/10",
        )}
      >
        <span
          className="mission-log-rail absolute inset-y-1.5 left-1.5 w-[2px] rounded-full bg-muted-foreground/30"
          aria-hidden
        />
        <span className="mission-log-token grid size-4 flex-none place-items-center rounded-full bg-foreground/[0.06]">
          <CircleSlash className="size-[11px] text-muted-foreground" strokeWidth={2} aria-hidden />
        </span>
        <span className="sr-only">watches retired: </span>
        <span className="min-w-0 flex-1 truncate tabular-nums">
          {group.count} watches {group.outcomeLabel}
        </span>
        <span className="flex-none font-mono text-[10.5px] tabular-nums text-muted-foreground">
          {logClock(group.atMillis)}
        </span>
      </summary>
      <div className="pl-4">{group.members.map((member) => renderWatchRow(member, false))}</div>
    </details>
  );

  const renderCard = (card: TurnTimelineCard): ReactNode => {
    const identity = turnCardLogIdentity(card);
    return (
      <LogRow
        key={card.id}
        tone={identity.tone}
        Icon={identity.Icon}
        srWord={identity.word}
        prose={
          <>
            {card.triggerLabel}
            {card.readLabel === null ? null : (
              <span className="text-muted-foreground"> · it {card.readLabel}</span>
            )}
            {card.decisionLabel === null ? null : (
              <span className="text-muted-foreground"> · {card.decisionLabel}</span>
            )}
          </>
        }
        title={card.detailLabel ?? undefined}
        figure={card.priceLevel === null ? null : formatPrice(card.priceLevel)}
        timeLabel={logClock(card.atMillis)}
        isSelected={
          selection !== null &&
          (selection.eventId === card.id || isMomentSelected(selection, card.atMillis))
        }
        dataAttrs={{ "data-timeline-card": card.id, "data-timeline-kind": card.kind }}
        hoverProps={{
          onMouseEnter: () => onHoverEvent({ id: card.id, atMillis: card.atMillis }),
          onMouseLeave: () => onHoverEvent(null),
        }}
      />
    );
  };

  return (
    <div
      data-testid="mission-watch-stream"
      className="flex min-h-0 flex-1 flex-col border-t border-border/40 pt-1"
    >
      {/* `flex-1` bounds this only inside the shell's reserved height, which
          exists at `lg` and above. Below `lg` the panel stacks and grows with
          its content, so the scrollback needs a bound of its own — without one
          a mission with fifty settled watches pushed the whole panel off the
          top of a bottom-docked overlay that does not scroll. */}
      <div
        ref={scrollRef}
        className="max-h-[260px] min-h-0 flex-1 overflow-y-auto overscroll-contain lg:max-h-none"
      >
        {armed.length === 0 ? null : (
          // Pinned on an opaque strip, the same waterline the old stream kept:
          // live above, over below.
          <div className="sticky top-0 z-10 bg-card backdrop-blur-sm">
            <div className="divide-y divide-border/25">
              {armed.map((item) =>
                item.kind === "group" ? renderGroup(item) : renderWatchRow(item, true),
              )}
            </div>
            {entries.length === 0 ? null : <div className="h-px bg-border" />}
          </div>
        )}
        <div className="divide-y divide-border/15">
          {entries.map((entry) =>
            entry.kind === "card"
              ? renderCard(entry.card)
              : entry.item.kind === "group"
                ? renderGroup(entry.item)
                : renderWatchRow(entry.item, false),
          )}
        </div>
        {earlierSettled <= 0 && earlierTurns <= 0 ? null : (
          <p
            className={cn(
              BAND_PAD_CLASS,
              "py-2 font-mono text-[11px] tabular-nums text-muted-foreground",
            )}
          >
            {[
              earlierSettled > 0
                ? `${earlierSettled} earlier watch${earlierSettled === 1 ? "" : "es"}`
                : null,
              earlierTurns > 0
                ? `${earlierTurns} earlier turn${earlierTurns === 1 ? "" : "s"}`
                : null,
            ]
              .filter((part) => part !== null)
              .join(" · ")}{" "}
            not shown
          </p>
        )}
      </div>
      {droppedConditions === 0 ? null : (
        <OverflowLevels
          rows={overflowRows}
          watchRows={stream}
          open={overflowOpen}
          highlighted={selection?.source === "chart" && selection.eventId === "chip-overflow"}
          onToggle={() => setOverflowOpen((prev) => !prev)}
          onHoverEvent={onHoverEvent}
          sectionRef={overflowRef}
        />
      )}
    </div>
  );
}
