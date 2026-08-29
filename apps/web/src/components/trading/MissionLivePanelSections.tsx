// ---------------------------------------------------------------------------
// MissionLivePanelSections
// ---------------------------------------------------------------------------
//
// The live panel's shared chrome, split out of MissionLivePanel.tsx by size
// alone: the layout constants every card shares, and the section components
// the panel composes — the chart card's header and slot, the plan popover,
// the readout rows, and the status bar. Nothing here owns state beyond its
// own hooks; the panel remains the owner of the collapse store.

import type { ScopedThreadRef, TradingMarketChartView } from "@t3tools/contracts";
import {
  Activity,
  ChartCandlestick,
  ChevronDown,
  Clock,
  Crosshair,
  ExternalLinkIcon,
  FileText,
  Gauge,
  Receipt,
  TrendingDown,
  TrendingUp,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { Skeleton } from "../ui/skeleton";

import { MissionPriceChart } from "./MissionPriceChart";
import { useComposerPrefill } from "./composerPrefill";
import { ThesisChartBadgeLine, paperMarkerSentence } from "./ThesisChartBadgeLine";
import { describeWakeTrigger } from "./missionTurnTimeline";
import { type MissionPlanRevision } from "./useMissionPlanRevision";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import {
  selectVisibleCandles,
  MIN_VISIBLE_BARS,
  type ChartLevelKind,
  type ChartZoneInput,
} from "./missionChartGeometry";
import {
  formatDuration,
  formatPrice,
  formatSignedUsd,
  formatUsd,
  type ChartFillMarker,
  type ChartPastMarkerInput,
  type ChartTimeMarkerInput,
  type StrategyPlan,
  type WatchRowType,
  type WatchStreamItem,
  type WatchStreamRow,
} from "./tradingPresentation";
import type { PanelState } from "./MissionLivePanel";

/** The chart's height inside the thread panel.
 *
 * Fixed, and deliberately modest. The panel is one narrow column and the agent
 * log below is the section that has to be long — a chart that took the slack
 * left the log four rows tall on a laptop. So the picture states a size and
 * the log gets everything else.
 *
 * 200px, measured rather than guessed: at 260 the log came out 212px tall in
 * an 848px column — the shortest section on a panel it is supposed to
 * dominate. At 200 it is the tallest, and it is the only section that grows
 * with the window, so it stays the tallest.
 *
 * Reserved, not reactive: it changes on a window resize and on nothing a
 * mission does, which is the rule every height in this panel keeps. */
export const CHART_HEIGHT_CLASS = "h-[200px] min-h-0 w-full";

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
export const TICK_INTERVAL_MILLIS = 250;

/**
 * How many settled watches the stream renders before it says how many are left.
 *
 * A mission that re-levels on every bar retires hundreds of them, and rendering
 * all of them makes a 220px window into sixty screens of scroll — with the row
 * anyone would want in the first two. Forty is a few screens of genuine
 * scrollback; past that the number itself is the useful fact.
 */
export const MAX_SETTLED_WATCH_ROWS = 40;

/**
 * How many of the fetched bars the live chart draws.
 *
 * The RPC serves 120 (`maxBars` in `ws.ts`), which on a 1m series is two hours
 * — wide enough that an hour-old trade is a twentieth of the frame and a minute
 * of drift is a few pixels. Sixty bars is the hour that a 1m mission is
 * actually operating on: twice the price resolution, and twice the rate the
 * series slides left.
 *
 * This was briefly written as 24, which was a lie: `selectVisibleCandles`
 * floors every ask at {@link MIN_VISIBLE_BARS}, so 60 is what every render
 * actually showed. Stating the floor directly keeps constant and behavior
 * in one place.
 */
export const VISIBLE_BARS = MIN_VISIBLE_BARS;

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
export const CARD_CLASS = "mission-panel-glass overflow-hidden rounded-xl border";

/** The panel's own column: header, chart, status strip, positions, agent log.
 *
 * One vertical stack, not two columns. The panel lives beside the chat now
 * rather than across the width above the composer, and a 384px column has no
 * room for a picture and an instrument shoulder to shoulder — the two-column
 * row was sized for a 6xl surface that no longer exists.
 *
 * `min-h-0` on the shell and on the log's own section is what makes the log
 * the section that scrolls: everything above it states a height, so the log
 * takes the remainder and bounds its own scrollback inside it. */
export const PANEL_SHELL_CLASS =
  "mission-panel group/panel flex min-h-0 w-full flex-1 flex-col gap-3";

/** The positions card's reserved height — always mounted, always the same
 *  height, drawing its empty state when there is nothing to show.
 *
 *  Unconditional now that the panel is one column: the old `lg:` qualifier was
 *  there because the card shared a fixed-height column with the chart, and it
 *  shares nothing now. 150px rules up the header, the column headings and
 *  three rows before the scroller takes over, which is the live band plus its
 *  first settled legs — and every pixel past that is a pixel off the log. */
export const POSITIONS_HEIGHT_CLASS = "h-[150px]";

/** How many settled order rows the positions card shows before counting. */
export const MAX_ORDER_ROWS = 6;

/** The padding every band on either card starts from, so a figure in the
 *  readout lines up with the chart's own left rule. */
export const BAND_PAD_CLASS = "px-4 sm:px-5";

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
export const BAND_LEGEND_CLASS =
  "font-mono text-[10.5px] uppercase tracking-[0.14em] text-muted-foreground";

/**
 * The context strips — the risk/reward bar, the schedule — that close out a
 * card. Both sit on the same faint ground, a shade off the card, so the band
 * above them reads as that card's centre of gravity.
 */
export const CONTEXT_BAND_CLASS =
  "border-t border-border/40 bg-foreground/[0.02] px-4 py-2 sm:px-5";

/**
 * What the mission is doing, in one clause.
 *
 * The panel is dense with figures and had no sentence on it. A figure answers
 * "how much"; this answers "what is happening", which is the question a glance
 * from across the room is actually asking.
 */
export function describeMissionStatus(
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

export function RiskRewardBar({
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
 * Two sentences and no third: the model republished underneath it, or the
 * exchange refused to move the stop. Both stay until the operator drags
 * again — a message that disappears on a timer is one they will miss while
 * looking at the chart.
 */
export function RevisionNote({ revision }: { readonly revision: MissionPlanRevision }): ReactNode {
  const details = [revision.refusedStop?.detail].filter(
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

/**
 * The chart area, in its four explicit states. Loading and <2-candle states
 * never show a flat line at zero — the first reads as "data is coming", the
 * second as "too little to draw yet".
 */
export function ChartSlot(props: {
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
  /** Price bands to wash under the plot - the plan's projection zone today. */
  readonly zones?: ReadonlyArray<ChartZoneInput>;
  /**
   * The thread this chart lives in, so the validation badge and its paper
   * markers can write a question into its composer.
   */
  readonly threadRef: ScopedThreadRef;
}): ReactNode {
  const { data, isLoading, error } = props;
  const thesis = data?.thesis ?? null;
  const prefill = useComposerPrefill(props.threadRef);

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
        {...(props.zones === undefined ? {} : { zones: props.zones })}
        {...(thesis === null ? {} : { thesis })}
        {...(prefill === null || thesis === null
          ? {}
          : {
              onAskAboutMarker: (marker: { readonly at: number }) =>
                prefill(paperMarkerSentence({ headline: thesis.headline, atMillis: marker.at })),
            })}
        className={CHART_HEIGHT_CLASS}
      />
    );
  }
  return <Skeleton className={CHART_HEIGHT_CLASS} />;
}

/**
 * The chart plus the validation badge under it.
 *
 * Split from `ChartSlot` only so the badge stays out of the four early
 * returns above: a skeleton and an "unavailable" line have no validation to
 * name, and the badge would have had to be repeated in each branch.
 */
export function ChartSlotWithBadge(
  props: Parameters<typeof ChartSlot>[0] & { readonly threadRef: ScopedThreadRef },
): ReactNode {
  const prefill = useComposerPrefill(props.threadRef);
  return (
    <>
      <ChartSlot {...props} />
      <ThesisChartBadgeLine thesis={props.data?.thesis ?? null} prefill={prefill} />
    </>
  );
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
export function useRecentlyFiredWatches(
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
export function OverflowLevels({
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
export function formatWatchFigure(watchType: WatchRowType, value: number): string {
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
export function formatReassessmentCountdown(nextReassessmentAt: number | null): string | null {
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

/**
 * What would make the plan wrong, on the bar next to the plan itself.
 *
 * The prose has always been on the plan and has only ever been readable from
 * inside the plan popup, folded into one semicolon-joined line among nine
 * other fields. That is the wrong place for it: the invalidation is not
 * another parameter of the trade, it is the condition under which the trade
 * stops being the trade, and it is the one thing an operator watching a
 * position wants within reach.
 *
 * Its own disclosure, in the plan popup's visual family, opening upward for
 * the same reason: the bar is the panel's bottom edge and the composer is
 * directly under it. One line per clause, because they are separate
 * conditions and joining them with semicolons made a paragraph out of a list.
 *
 * Not on the chart. The clauses are prose - "regime flips to mean-reverting"
 * is not a price and has no y.
 */
function InvalidationPopover({
  invalidation,
}: {
  readonly invalidation: ReadonlyArray<string>;
}): ReactNode {
  if (invalidation.length === 0) return null;
  return (
    <Popover>
      <PopoverTrigger
        aria-haspopup="dialog"
        data-testid="mission-invalidation-trigger"
        className="inline-flex flex-none items-center gap-1.5 rounded-full border border-border/60 px-2 py-0.5 font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground motion-reduce:transition-none"
      >
        <TriangleAlert className="size-3" strokeWidth={2} aria-hidden />
        Wrong if
        {invalidation.length > 1 ? ` ×${invalidation.length}` : ""}
      </PopoverTrigger>
      <PopoverPopup side="top" align="start" className="w-[320px] max-w-[calc(100vw-2rem)]">
        <div className="max-h-[60vh] overflow-y-auto text-[12px]">
          <p className={cn(BAND_LEGEND_CLASS, "pb-2")}>this read is wrong if</p>
          <ul className="space-y-1" data-testid="mission-invalidation-list">
            {invalidation.map((line) => (
              <li key={line} className="flex gap-1.5 text-foreground">
                <span aria-hidden className="text-muted-foreground">
                  ·
                </span>
                <span className="whitespace-pre-wrap">{line}</span>
              </li>
            ))}
          </ul>
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
export function AnimatedUsd({ value }: { readonly value: number }): ReactNode {
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
export function ProgressToTargetRow({ percent }: { readonly percent: number | null }): ReactNode {
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
export function SideChip({
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
export function flyChipToCard(chipEl: HTMLElement, cardEl: HTMLElement): void {
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
export function deriveLastActivity(
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

export function MissionStatusBar({
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
      {plan === null ? null : <InvalidationPopover invalidation={plan.invalidation} />}
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
