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

import type { EnvironmentId, OrchestrationTradingMission } from "@t3tools/contracts";
import { ChevronUp } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import { readMissionMode } from "@t3tools/trading-contracts/mode";
import { runtimeTimeframe } from "@t3tools/trading-contracts/strategy";

import type { ChartInterval } from "~/lib/tradingMarketChartState";
import { useTradingMarketChart } from "~/lib/tradingMarketChartState";
import { cn } from "~/lib/utils";

import { useMissionSelection } from "./missionSelectionStore";
import { deriveTurnTimeline } from "./missionTurnTimeline";
import { useMissionPlanRevision } from "./useMissionPlanRevision";
import {
  dedupeConditions,
  deriveEntryFillAtMillis,
  deriveProgressToTarget,
  deriveTargetPrice,
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
  formatDuration,
  formatLeverage,
  formatSignedPercent,
  formatSignedUsd,
  formatUsd,
  hyperliquidTradeUrl,
  isMissionComplete,
  plannedReassessmentAt,
  deriveOrderLedger,
  type WatchStreamRow,
} from "./tradingPresentation";
import { AgentLog } from "./MissionAgentLog";
import {
  CARD_CLASS,
  CARD_ROW_CLASS,
  ChartPriceHeader,
  ChartSlot,
  CollapsedRow,
  MissionStatusBar,
  PANEL_SHELL_CLASS,
  POSITIONS_HEIGHT_CLASS,
  ProgressToTargetRow,
  READOUT_WIDTH_CLASS,
  RevisionNote,
  RiskRewardBar,
  TICK_INTERVAL_MILLIS,
  AnimatedUsd,
  BAND_LEGEND_CLASS,
  BAND_PAD_CLASS,
  deriveLastActivity,
  describeArmedSummary,
  describeMissionStatus,
  flyChipToCard,
  formatReassessmentCountdown,
  useRecentlyFiredWatches,
} from "./MissionLivePanelSections";
import { PositionsCard } from "./MissionPositionsCard";

/**
 * Module-level collapse state, keyed by mission id.
 *
 * Collapsing mission A must not collapse mission B, and the toggle must survive
 * a remount from the 3s poll. A map at module scope gives both without forcing
 * the call site to pass a `key`. The default is expanded — the panel is the
 * reason the thread is on screen.
 *
 * Bounded: only the most recently toggled missions are remembered, so a long
 * session cannot grow the map one entry per mission forever. Evicting the
 * oldest entry just means that mission renders expanded again — the default.
 */
const COLLAPSED_MISSIONS_MAX = 50;
const collapsedMissions = new Map<string, boolean>();

/** Record a mission's collapse choice, evicting the oldest one past the cap. */
function rememberCollapsed(missionId: string, collapsed: boolean): void {
  // Re-insert so iteration order stays least-recently-toggled first.
  collapsedMissions.delete(missionId);
  collapsedMissions.set(missionId, collapsed);
  if (collapsedMissions.size > COLLAPSED_MISSIONS_MAX) {
    const oldest = collapsedMissions.keys().next().value;
    if (oldest !== undefined) collapsedMissions.delete(oldest);
  }
}

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
  const [collapsed, setCollapsed] = useState<boolean>(collapsedMissions.get(mission.id) ?? false);
  const toggleCollapsed = (): void => {
    setCollapsed((prev) => {
      const next = !prev;
      rememberCollapsed(mission.id, next);
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
