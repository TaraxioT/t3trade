// ---------------------------------------------------------------------------
// MissionPriceChart
// ---------------------------------------------------------------------------
//
// The pure-props SVG renderer for one mission's price line. No state, no
// effects, no data fetching — it draws exactly what its props say, derived
// through `computeChartGeometry`.
//
// Visual idea: the shape of the trade you are in is the only saturated thing
// on screen. The pre-entry line is muted, the levels are thin/dashed, and the
// post-entry segment + its fill carry the profit/loss colour. The mark dot is
// the one moving thing, and it pulses on opacity (GPU-cheap, no layout).
//
// That idea is why the level rules are drawn at a fraction of their colour and
// their gutter tags at near full: a rule spans the whole plot, so a stop drawn
// in solid loss-red was the loudest thing on a chart whose subject is the price.
// The rule says where; the tag says what.
//
// Everything the mission has done or committed to is here, so the chart is the
// activity log and not just a price: the fills as circles (filled for an open,
// hollow for a close, tinted by what the close realised), a resting order as a
// dotted level, the armed conditions as dashed ones, and a scheduled
// reassessment as a rule standing in the future gutter.
//
// The plot stretches (`preserveAspectRatio="none"`), which is right for a price
// line and wrong for text — glyphs stretched with the container width was the
// "distorted labels" complaint. So the gutter is HTML positioned over the SVG
// rather than `<text>` inside it: undistorted at any width, and it gets
// ellipsis and wrapping for free.

import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";

import type { TradingChartCandle } from "@t3tools/contracts";

import { isMomentSelected, useMissionSelection } from "./missionSelectionStore";
import { cn } from "~/lib/utils";

import {
  CHART_VIEWBOX_HEIGHT,
  CHART_VIEWBOX_WIDTH,
  FUTURE_GUTTER_RATIO,
  LABEL_GUTTER_WIDTH,
  PLOT_WIDTH,
  computeChartGeometry,
  findLevelAtPrice,
  medianBarInterval,
  type ChartCondition,
  type ChartLevel,
  type ChartLevelKind,
  type ChartPoint,
  type GutterTag,
} from "./missionChartGeometry";
import { formatPrice, type ChartFillKind, type ChartFillMarker } from "./tradingPresentation";

interface MissionPriceChartProps {
  readonly candles: ReadonlyArray<TradingChartCandle>;
  readonly entryPrice: number | null;
  readonly stopPrice: number | null;
  readonly targetPrice: number | null;
  readonly liquidationPrice: number | null;
  /** Epoch millis; splits the line into pre/post segments. */
  readonly entryTime: number | null;
  readonly markPrice: number | null;
  /** Colours the post-entry segment + fill. Null while flat (no position). */
  readonly pnlSign: "profit" | "loss" | null;
  /**
   * Whether the mark dot pulses. `live` is the default — the dot is the one
   * moving thing on a running chart. `static` is the review chart, where the
   * dot is the exit marker of a trade that is over and nothing is moving.
   */
  readonly markMotion?: "live" | "static";
  /**
   * Armed price conditions to draw while the mission is flat. These are what a
   * waiting mission is waiting for; without them the pre-position chart shows
   * a price line and no reason to be looking at it.
   */
  readonly conditions?: ReadonlyArray<ChartCondition>;
  /**
   * Every fill the mission has made, drawn as a circle on the axis.
   *
   * This is what keeps a session's earlier positions on screen after they are
   * closed: the position row is gone, but the two circles that were its open
   * and its close stay where they happened.
   */
  readonly fills?: ReadonlyArray<ChartFillMarker>;
  /** A committed-but-unfilled order, drawn as a dotted level at its limit. */
  readonly pendingOrder?: { readonly price: number; readonly side: "buy" | "sell" } | null;
  /**
   * Wall-clock now. Passing it turns the x axis into a clock: the series slides
   * continuously instead of stepping once per bar, the mark moves off the frame
   * edge into a reserved future gutter, and the space between the last close
   * and the mark becomes the forming bar.
   *
   * The review chart leaves this out — its window is closed and its mark is an
   * exit that already happened.
   */
  readonly nowMillis?: number;
  /**
   * When the armed entry triggers stop being the plan the mission is running,
   * in epoch millis. Bounds how far their rules are projected into the future
   * gutter. Ignored without `nowMillis`.
   */
  readonly triggerExpiryAt?: number;
  /**
   * A level to call attention to, set by clicking its pill in the "Up next"
   * strip. The `nonce` is what makes a second click on the same pill flash
   * again: the overlay is keyed by it, so React remounts the element and the
   * CSS animation restarts. A price with no drawn level flashes nothing —
   * the strip may name a level the chart's domain does not reach, and an
   * invented rule there would be a lie about where it sits.
   */
  readonly flash?: { readonly price: number; readonly nonce: number } | null;
  /**
   * The plan's best current estimate of where price is headed: a dotted path
   * from the live mark to `{price}` at `{atMillis}`, drawn in the future
   * gutter's hypothetical register. Where the model thinks the market goes —
   * the armed conditions around it are what it does about being wrong.
   */
  readonly projection?: { readonly price: number; readonly atMillis: number } | null;
  /** Future moments to stand in the gutter. Ignored without `nowMillis`. */
  readonly timeMarkers?: ReadonlyArray<{
    readonly key: string;
    readonly label: string;
    readonly at: number;
    readonly tone?: "auto" | "planned";
  }>;
  /** Moments that already happened, newest first. Ignored without `nowMillis`. */
  readonly pastMarkers?: ReadonlyArray<{
    readonly key: string;
    readonly kind: string;
    readonly at: number;
    readonly cause?: string | undefined;
    readonly failed?: boolean | undefined;
  }>;
  /**
   * Which levels the operator may drag, and what to do when they let go.
   *
   * A drag is a `plan()` revision — the same eight authored fields the model
   * publishes, with one leaf replaced — so the chart's job here is narrow: turn
   * a pointer into a price and hand it over. It holds no plan of its own and
   * decides nothing about whether the revision is allowed.
   */
  readonly draggableKinds?: ReadonlyArray<ChartLevelKind>;
  readonly onLevelDragEnd?: (kind: ChartLevelKind, price: number) => void;
  /**
   * A level the exchange refused to move, drawn twice.
   *
   * The rule stays where the stop actually rests, and the price the plan now
   * states is drawn in the hypothetical register the future gutter uses — which
   * is exactly what that register is for: a claim about a level, not a record
   * of one. Without this the panel would draw the dragged price as fact while
   * the position sat behind a different stop.
   */
  readonly refusedLevel?: {
    readonly kind: ChartLevelKind;
    readonly planPrice: number;
    readonly detail: string;
  } | null;
  /**
   * Signed position size, used only for the live risk readout under the
   * pointer while a stop is being dragged. Null while flat — there is no
   * planned loss without a position, and inventing one would be a number the
   * operator could act on.
   */
  readonly positionSize?: number | null;
  /**
   * How many armed levels the geometry folded out of the gutter, for the
   * "+N" overflow chip. Null (the chip is absent) when nothing was folded.
   */
  readonly overflowCount?: number | null;
  /**
   * Watch ids that fired in the last beat (phase 4). A chip whose level was
   * armed by one of them plays its one-shot ripple — the fire is a state
   * change, and the ripple is its announcement, never a loop.
   */
  readonly firedWatchIds?: ReadonlyArray<string> | undefined;
  readonly className?: string;
}

/** How tall a past-event tick stands off the bottom edge, in viewBox units. */
const PAST_MARKER_TICK_HEIGHT = 6;

/** A drawn chip, frozen at its last placement: what a retire fades out from. */
interface ChipSnapshot {
  readonly id: string;
  /** The chip's dock, as a percentage of the frame height. */
  readonly topPercent: number;
  readonly ink: string;
  readonly text: string;
}

// The hypothetical register — how anything drawn to the right of `now` is
// distinguished from the record to its left. Thinner than the rule it
// continues, dashed whatever the rule's own pattern was (a solid entry line
// running into the gutter claims the entry is a fact out there too), and at
// three quarters strength. All three together, because any one alone reads as a
// different level rather than as the same level projected.
const HYPOTHETICAL_STROKE_WIDTH = 0.75;
const HYPOTHETICAL_DASH_ARRAY = "2 5";
const HYPOTHETICAL_OPACITY = 0.75;

/**
 * How wide a live bracket's stub lines are, as a share of the plot width.
 *
 * The full-width rules are gone (phase 1); the only survivors are the stop and
 * target stubs of an OPEN position, short enough to read as "the bracket is
 * right here" without fencing the price line in. ~15%: a fifth of the frame's
 * width at the right edge, beside the gutter chips that name them.
 */
const BRACKET_STUB_RATIO = 0.15;

/**
 * The colour of a past-event tick, by what the event was — plan 24 §4.1.
 *
 * The reading the rug is for is the *mix*: a run of muted ticks is the
 * staleness floor waking a mission that had nothing to decide, an amber one is
 * a level the market actually reached. A failed run is drawn in loss-red
 * because it is a turn the mission was owed and did not get.
 */
function pastMarkerColor(marker: {
  readonly kind: string;
  readonly cause?: string | undefined;
  readonly failed?: boolean | undefined;
}): string {
  if (marker.failed === true) return "var(--color-loss)";
  if (marker.kind === "stop_adjusted") return "var(--color-loss)";
  if (marker.kind === "strategy_published") return "var(--color-foreground)";
  // A note is the model talking, not the market moving. Drawing it in the
  // amber a triggered wake uses would put a level on the rug that never
  // existed.
  if (marker.kind === "journal") return "var(--color-muted-foreground)";
  // A wake the market caused is the one worth seeing; a scheduled one is the
  // backstop, and the rug should read as quieter where the clock did the work.
  return marker.cause === "scheduled_reassessment"
    ? "var(--color-muted-foreground)"
    : "var(--color-armed)";
}

/**
 * The base colour of a level, before the rule/ink split below.
 *
 * `armed` is the chrome's "committed but not yet happened" amber, and both the
 * conditions and a resting order are exactly that.
 */
function levelBaseColor(kind: ChartLevelKind | "mark"): string {
  switch (kind) {
    case "entry":
    case "mark":
      return "var(--color-foreground)";
    case "stop":
      return "var(--color-loss)";
    case "target":
      return "var(--color-profit)";
    case "liquidation":
      return "var(--color-destructive)";
    case "condition_above":
    case "condition_below":
    case "pending_buy":
    case "pending_sell":
      return "var(--color-armed)";
  }
}

/** Chip ink is text and must stay legible, so it is near full strength. */
const INK_MIX = 85;

/** The colour a level's chip is written in. */
function levelInkColor(kind: ChartLevelKind | "mark"): string {
  if (kind === "mark") return "var(--color-foreground)";
  return `color-mix(in oklab, ${levelBaseColor(kind)} ${INK_MIX}%, transparent)`;
}

/** The glyph that opens a gutter tag, or an empty string when it carries none. */
function tagGlyph(tag: GutterTag): string {
  if (tag.kind === "condition_above") return tag.met === true ? "✓ ▲" : "○ ▲";
  if (tag.kind === "condition_below") return tag.met === true ? "✓ ▼" : "○ ▼";
  if (tag.kind === "pending_buy") return "▲";
  if (tag.kind === "pending_sell") return "▼";
  return "";
}

/** The short word that says which price a tag is, under the number. */
function tagCaption(tag: GutterTag): string {
  switch (tag.kind) {
    case "mark":
      return tag.mergedPrice === undefined ? "" : `entry ${formatPrice(tag.mergedPrice)}`;
    case "entry":
      return "entry";
    case "stop":
      return "stop";
    case "target":
      return "target";
    case "liquidation":
      return "liq";
    // Not "close above": a condition here is a `price_cross` as often as a
    // `candle_close` and the geometry does not carry which, so the caption
    // said "close" about levels that fire on a touch. The direction is the
    // part that is always true — and at five characters it is the part that
    // still fits in the gutter on a half-width panel.
    case "condition_above":
      return "above";
    case "condition_below":
      return "below";
    case "pending_buy":
      return "buying";
    case "pending_sell":
      return "selling";
  }
}

/** The circle that marks one fill: filled for an open, hollow for a close. */
function fillMarkerStyle(kind: ChartFillKind): {
  readonly color: string;
  readonly filled: boolean;
} {
  switch (kind) {
    case "open":
      // An open is where the exposure came from — the same ink as the entry
      // rule it created, and solid, because it is a thing that has happened.
      return { color: "var(--color-foreground)", filled: true };
    case "close_profit":
      return { color: "var(--color-profit)", filled: false };
    case "close_loss":
      return { color: "var(--color-loss)", filled: false };
    case "close_flat":
    case "unknown":
      return { color: "var(--color-muted-foreground)", filled: false };
  }
}

/** Post-entry segment + fill colour, driven by which way the trade is running. */
/**
 * Round prices to rule the plot with, inside a domain.
 *
 * The step is the largest of 1, 2, 2.5 or 5 times a power of ten that still
 * leaves at least three lines in the frame — so a $2 range gets $0.50 rules and
 * a $200 range gets $50 ones, and the numbers on them are always numbers a
 * person would say out loud.
 */
function gridPricesFor(min: number, max: number, targetLines: number): ReadonlyArray<number> {
  const span = max - min;
  if (!Number.isFinite(span) || span <= 0) return [];
  const rough = span / targetLines;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step =
    [1, 2, 2.5, 5, 10].map((multiple) => multiple * magnitude).find((size) => size >= rough) ??
    10 * magnitude;
  const lines: number[] = [];
  for (let price = Math.ceil(min / step) * step; price <= max; price += step) {
    // Re-rounded: repeated addition of 0.25 drifts into 1869.7500000000002,
    // which prints as a price nobody chose.
    lines.push(Number(price.toFixed(6)));
  }
  return lines;
}

/**
 * The price line's stroke width, in CSS pixels (the stroke does not scale with
 * the plot, so this is a real width and not a viewBox unit).
 *
 * 2.25 rather than 1.5. The plot stretches to fill a 700×440 card and a 1.5px
 * line across that much glass reads as a hairline diagram; the subject of this
 * card is the price, and the subject should be the boldest mark on it.
 */
const LINE_WIDTH = 2.25;

function pnlColor(sign: "profit" | "loss" | null): string {
  if (sign === "profit") return "var(--color-profit)";
  if (sign === "loss") return "var(--color-loss)";
  return "var(--color-muted-foreground)";
}

/**
 * The plan wedge, or its dotted-path fallback.
 *
 * The wedge is a triangle: the live mark, the target at the projection's
 * moment, and the stop at the same moment — filled with a horizontal gradient
 * in the info ink that fades with distance from now. The far edge (stop →
 * target at `endX`) is drawn as a solid short stroke: that is the
 * invalidation, and it is the one part of the shape allowed to be crisp.
 *
 * When either bracket level is missing or off-frame the shape cannot close
 * honestly, and the old dotted mark → projection path is drawn instead: a
 * weaker statement, but a true one.
 */
function renderPlanWedge(input: {
  readonly gradientId: string;
  readonly projectionPoints: ReadonlyArray<ChartPoint>;
  readonly levels: ReadonlyArray<ChartLevel>;
  readonly endX: number;
}): ReactNode {
  const mark = input.projectionPoints[0]!;
  const target = input.levels.find((level) => level.kind === "target") ?? null;
  const stop = input.levels.find((level) => level.kind === "stop") ?? null;
  // Off-scale is NOT a reason to fall back. The geometry already hands back a
  // `y` clamped into the frame for a level that sits outside it, and the wedge
  // clamps again below, so an off-screen target still closes a shape that
  // points the right way. Rejecting it here resurrected the dotted projection
  // line this wedge replaced, and it did so in the ordinary case: a target a
  // little below the visible range is a normal plan, not a broken one. Only a
  // missing bracket leaves nothing to close the shape against.
  if (target === null || stop === null) {
    return (
      <polyline
        data-testid="mission-chart-projection"
        points={toPoints(input.projectionPoints)}
        fill="none"
        stroke="color-mix(in oklab, var(--color-info) 55%, transparent)"
        strokeWidth={1.25}
        strokeDasharray="1 5"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    );
  }
  // Endpoints clamped into the frame: a bold call still points the right way
  // from inside the chart, the same courtesy the mark dot gets.
  const clampY = (y: number): number => Math.min(CHART_VIEWBOX_HEIGHT - 2, Math.max(2, y));
  const targetY = clampY(target.y);
  const stopY = clampY(stop.y);
  return (
    <g data-testid="mission-chart-projection">
      <polygon
        points={`${mark.x},${mark.y} ${input.endX},${targetY} ${input.endX},${stopY}`}
        fill={`url(#${input.gradientId}-wedge)`}
        stroke="none"
      />
      {/* The hard edge: where the wedge ends is where the plan ends. */}
      <line
        x1={input.endX}
        y1={targetY}
        x2={input.endX}
        y2={stopY}
        stroke="color-mix(in oklab, var(--color-info) 70%, transparent)"
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
      />
    </g>
  );
}

/** Turn a list of points into the `points` attribute of a `<polyline>`/`<polygon>`. */
function toPoints(points: ReadonlyArray<ChartPoint>): string {
  return points.map((point) => `${point.x},${point.y}`).join(" ");
}

/**
 * The band between the post-entry line and the entry price.
 *
 * The baseline is the ENTRY level, not the bottom of the frame. Closing the
 * path at `y = CHART_VIEWBOX_HEIGHT` shaded "distance from the price to the
 * bottom of an arbitrary viewport", which is not a quantity — and because the
 * frame bottom is far from the price action, it painted a saturated slab across
 * the lower half of the chart the instant a fill landed. Against the entry the
 * shaded height is the distance the trade has travelled from its own entry:
 * that is the P&L, it is symmetric above and below, and it starts at nothing
 * and grows, so a one-minute-old trade looks like a one-minute-old trade.
 *
 * Empty string below two points — there is no area in a single sample.
 */
function toAreaPath(points: ReadonlyArray<ChartPoint>, baselineY: number): string {
  if (points.length < 2) return "";
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const segments = points.map((point) => `L ${point.x} ${point.y}`);
  // Up from the baseline at the first point's x, across the line, then back
  // down to the baseline and close.
  return `M ${first.x} ${baselineY} L ${first.x} ${first.y} ${segments.slice(1).join(" ")} L ${last.x} ${baselineY} Z`;
}

export function MissionPriceChart(props: MissionPriceChartProps) {
  const {
    candles,
    entryPrice,
    stopPrice,
    targetPrice,
    liquidationPrice,
    entryTime,
    markPrice,
    pnlSign,
    markMotion = "live",
    conditions,
    fills,
    pendingOrder,
    flash,
    nowMillis,
    triggerExpiryAt,
    projection,
    timeMarkers,
    pastMarkers,
    draggableKinds,
    onLevelDragEnd,
    refusedLevel,
    positionSize,
    overflowCount,
    firedWatchIds,
    className,
  } = props;
  const [drag, setDrag] = useState<{
    readonly kind: ChartLevelKind;
    readonly price: number;
  } | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  // The draw-in dash is stripped once the intro has played. Left on, the
  // polyline keeps `stroke-dasharray: 1` against a `pathLength` that
  // re-normalises every time the points change — and on a line that updates
  // four times a second the dash boundary lands short of the path end often
  // enough that the tail of the line visibly drops out. The class exists for
  // one animation; after it, the line is just a line.
  const [introDone, setIntroDone] = useState(false);
  const drawClass = introDone ? undefined : "mission-line-draw";
  // The crosshair: where the pointer is reading the series, Stocks-style.
  const [hover, setHover] = useState<{
    readonly x: number;
    readonly y: number;
    readonly price: number;
    readonly at: number;
    /** True when the sample is the live mark, not a candle close. */
    readonly isMark: boolean;
  } | null>(null);

  // --- Chip hovers (phase 1/3). ----------------------------------------------
  //
  // A hovered chip extends a temporary hairline across the chart at its level
  // (or its moment, for a time chip): the rule says where, the chip says what,
  // and the rule exists only while the reader is asking. Keyboard focus counts
  // as hover — the reveal is information, not decoration, so it is available to
  // the tab order too.
  const [hoveredTagKey, setHoveredTagKey] = useState<string | null>(null);
  const [hoveredTimeKey, setHoveredTimeKey] = useState<string | null>(null);

  // --- The chip lifecycle (phase 4): arm pulses once, retire fades once. ---
  //
  // Both key off the watch's own id, never the element: a re-render or a
  // resize re-runs this component constantly, and an animation keyed on
  // mounting would replay on every layout shift. The ids seen armed live in
  // a ref written during render (idempotently, the same pattern the panel's
  // `useRecentlyFiredWatches` uses); the pulse class is applied once, on the
  // render the id first appears in after the first.
  const reduceMotion =
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const chipPrimedRef = useRef(false);
  const pulsedIdsRef = useRef<Set<string>>(new Set());
  /** The last snapshot of each drawn chip, so a retire has a ghost to fade. */
  const chipSnapshotRef = useRef<Map<string, ChipSnapshot>>(new Map());
  const [retireGhosts, setRetireGhosts] = useState<ReadonlyArray<ChipSnapshot>>([]);

  // The shared selection: hovering a chip or marker tells the panel which
  // event the reader is on, and the panel can do the same in reverse through
  // `selection`. The store is mission-scoped by construction (one live panel
  // per thread); a second mounted chart (a review) simply never writes.
  const selection = useMissionSelection((state) => state.selected);
  const selectEvent = useMissionSelection((state) => state.select);
  const clearChartSelection = useMissionSelection((state) => state.clear);

  const hoverChartEvent = (event: { id: string; atMillis: number } | null): void => {
    if (event === null) {
      clearChartSelection("chart");
      return;
    }
    selectEvent({ eventId: event.id, atMillis: event.atMillis, source: "chart" });
  };

  const geometry = computeChartGeometry({
    candles,
    entryPrice,
    stopPrice,
    targetPrice,
    liquidationPrice,
    entryTime,
    markPrice,
    ...(conditions === undefined ? {} : { conditions }),
    ...(fills === undefined ? {} : { fills }),
    ...(pendingOrder === undefined ? {} : { pendingOrder }),
    ...(nowMillis === undefined ? {} : { nowMillis }),
    ...(triggerExpiryAt === undefined ? {} : { triggerExpiryAt }),
    ...(projection === undefined ? {} : { projection }),
    ...(timeMarkers === undefined ? {} : { timeMarkers }),
    ...(pastMarkers === undefined ? {} : { pastMarkers }),
  });

  // Too few candles → the parent renders a skeleton / "chart unavailable".
  if (geometry === null) return null;

  // --- Chip lifecycle bookkeeping (see the refs above). ----------------------
  //
  // The first render that draws chips primes the pulse set with everything
  // already armed: a chip the panel opened with has no arrival to announce.
  if (!chipPrimedRef.current) {
    for (const tag of geometry.gutterTags) {
      if (tag.id !== undefined) pulsedIdsRef.current.add(tag.id);
    }
    chipPrimedRef.current = geometry.gutterTags.length > 0;
  }

  // A watch whose chip left the gutter this render gets one fading ghost at
  // its last dock, then is gone. Detected by comparing the snapshot the
  // previous render wrote against the ids on screen now; the state update is
  // React's own render-phase adjustment (conditional, so it converges), and
  // under reduced motion no ghost is ever made — the chip simply leaves.
  const drawnIds = new Set<string>();
  for (const tag of geometry.gutterTags) {
    if (tag.id !== undefined) drawnIds.add(tag.id);
  }
  const newlyRetired: ChipSnapshot[] = [];
  for (const [id, snapshot] of chipSnapshotRef.current) {
    if (drawnIds.has(id)) continue;
    chipSnapshotRef.current.delete(id);
    if (!reduceMotion && newlyRetired.length + retireGhosts.length < 8) {
      newlyRetired.push(snapshot);
    }
  }
  if (newlyRetired.length > 0) {
    setRetireGhosts((prev) => [...prev, ...newlyRetired]);
  }
  const retireGhost = (id: string): void => {
    setRetireGhosts((prev) => prev.filter((ghost) => ghost.id !== id));
  };

  // Unique per mounted chart: two of these on one screen (the live panel and a
  // review) would otherwise share one `<linearGradient id>` and the second
  // would paint with the first's colour.
  // Stripped to word characters: React's generated ids carry punctuation that
  // is legal in an `id` attribute and illegal inside `url(#…)`.
  const gradientId = `mission-chart-${useId().replaceAll(/[^a-zA-Z0-9_-]/g, "")}`;

  // While flat there is no P&L to tint by, so the line takes the window's own
  // direction — up over the hour is green, down is red — which is the rule the
  // Stocks app draws by and the one a glance already expects. While exposed the
  // trade's own result wins: what the position is doing outranks what the hour
  // did.
  const windowRise =
    candles.length >= 2 ? candles[candles.length - 1]!.close - candles[0]!.close : 0;
  const lineColor =
    pnlSign !== null
      ? pnlColor(pnlSign)
      : windowRise < 0
        ? "var(--color-loss)"
        : "var(--color-profit)";
  const segmentColor = lineColor;
  // One fill, from the whole line down to the floor of the frame, fading out as
  // it falls. The band that used to shade the line against the entry is gone:
  // two washes on one plot — a P&L band and a ground gradient — is the
  // "discoloration" that made the plot read as blocks of tinted paper rather
  // than as a lit line. The entry keeps its own dashed rule, which is exactly
  // what the Stocks app does with the previous close.
  const areaPath = toAreaPath(
    [...geometry.preEntryPoints, ...geometry.postEntryPoints],
    CHART_VIEWBOX_HEIGHT,
  );
  const gridPrices = gridPricesFor(geometry.domainMin, geometry.domainMax, 4);

  // One bar's width on the axis, and the slide that plays when a new one lands.
  //
  // Inside a bar the record holds still and only the live edge advances — a
  // third of a pixel a second, which is true motion but not motion anyone can
  // see. The visible event is the close: the window steps left by exactly one
  // bar, and rather than teleporting there, the series starts one pitch to the
  // right and travels into place. Once a minute the whole pane moves, in the
  // direction time runs, for about the length of a breath.
  const barPitch =
    candles.length > 0 ? (PLOT_WIDTH * (1 - FUTURE_GUTTER_RATIO)) / candles.length : 0;
  const lastBarAt = candles[candles.length - 1]?.openTime ?? 0;
  const [slideOffset, setSlideOffset] = useState(0);
  const lastBarRef = useRef(lastBarAt);
  useEffect(() => {
    if (lastBarRef.current === lastBarAt) return;
    lastBarRef.current = lastBarAt;
    setSlideOffset(barPitch);
    // Two frames: the first commits the offset, the second releases it with a
    // transition to animate against. One frame and the browser coalesces both
    // into the end state, which is a teleport with extra steps.
    const first = requestAnimationFrame(() => {
      requestAnimationFrame(() => setSlideOffset(0));
    });
    return () => cancelAnimationFrame(first);
  }, [lastBarAt, barPitch]);
  // The gutter overlay is positioned in percentages of the same viewBox the SVG
  // uses, so the two stay in register at any container size.
  const gutterPercent = (LABEL_GUTTER_WIDTH / CHART_VIEWBOX_WIDTH) * 100;
  const flashedLevel =
    flash === undefined || flash === null ? null : findLevelAtPrice(geometry.levels, flash.price);

  // Pointer y → price, through the same padded domain the geometry drew with,
  // so the level lands where the pointer is rather than near it. Clamped to the
  // domain: a drag that leaves the frame states a price the chart cannot show,
  // and the operator would be publishing a level they cannot see.
  const priceAtClientY = (clientY: number): number | null => {
    const frame = frameRef.current;
    if (frame === null) return null;
    const box = frame.getBoundingClientRect();
    if (box.height <= 0) return null;
    const ratio = Math.min(1, Math.max(0, (clientY - box.top) / box.height));
    const price = geometry.domainMax - ratio * (geometry.domainMax - geometry.domainMin);
    // Rounded, because this price is published: it goes into the plan document,
    // into the journal note the model reads, and onto the exchange. A pointer
    // gives fifteen significant figures and a stop at 1863.5774749999998 is a
    // number no one chose. Two decimals at ETH scale, four below a dollar, so a
    // cheap market keeps the resolution its ticks actually have.
    const decimals = Math.abs(price) >= 1 ? 2 : 4;
    return Number(price.toFixed(decimals));
  };

  // Pointer x → the nearest plotted close, for the hover crosshair. The plot
  // is a linear clock, so the mapping is one division and a nearest-neighbour
  // scan over at most ~120 points. Nothing right of `now` is hoverable — the
  // future gutter holds claims, not samples.
  const hoverAtClient = (clientX: number): void => {
    const frame = frameRef.current;
    if (frame === null) return;
    const box = frame.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return;
    const viewX = ((clientX - box.left) / box.width) * CHART_VIEWBOX_WIDTH;
    if (viewX > geometry.nowX + 4) {
      setHover(null);
      return;
    }
    // A plotted point is a candle's CLOSE, so it is labeled with the close
    // time (open + one interval), not the open. Labeled by the open, the point
    // just left of "now" read a minute stale, and the mark truncated to the
    // same minute as the bar it was closing — two points, one time.
    const interval = medianBarInterval(candles);
    let best: { x: number; y: number; price: number; at: number; isMark: boolean } | null = null;
    for (const candle of candles) {
      const x = geometry.xForTime(candle.openTime);
      if (x < 0) continue;
      if (best === null || Math.abs(x - viewX) < Math.abs(best.x - viewX)) {
        // A forming bar's close is in the future; the clock caps the label at
        // the newest moment that has actually happened.
        const closedAt =
          nowMillis === undefined
            ? candle.openTime + interval
            : Math.min(candle.openTime + interval, nowMillis);
        best = {
          x,
          y: geometry.yForPrice(candle.close),
          price: candle.close,
          at: closedAt,
          isMark: false,
        };
      }
    }
    // The live mark is a sample too — the newest one. Without it the crosshair
    // could never read past the last CLOSED candle, so "now" (the minute
    // currently forming) was unreachable and the readout stopped a minute in
    // the past.
    if (geometry.markPoint !== null && markPrice !== null && nowMillis !== undefined) {
      const mark = geometry.markPoint;
      if (best === null || Math.abs(mark.x - viewX) < Math.abs(best.x - viewX)) {
        best = { x: mark.x, y: mark.y, price: markPrice, at: nowMillis, isMark: true };
      }
    }
    // Vertical position is ignored entirely — Stocks reads the series wherever
    // the finger is, and demanding the pointer be ON the line makes the
    // crosshair flicker.
    setHover(best);
  };

  const draggable = draggableKinds ?? [];
  const isDraggable = (kind: ChartLevelKind) =>
    onLevelDragEnd !== undefined && draggable.includes(kind);

  const startDrag = (kind: ChartLevelKind, event: React.PointerEvent<HTMLElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const price = priceAtClientY(event.clientY);
    if (price !== null) setDrag({ kind, price });
  };
  const moveDrag = (event: React.PointerEvent<HTMLElement>) => {
    if (drag === null) return;
    const price = priceAtClientY(event.clientY);
    if (price !== null) setDrag({ kind: drag.kind, price });
  };
  const endDrag = (event: React.PointerEvent<HTMLElement>) => {
    if (drag === null) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    setDrag(null);
    onLevelDragEnd?.(drag.kind, drag.price);
  };

  // What the dragged stop would plan to lose, live under the pointer. Only for
  // a stop, and only with a position and an entry to measure from: every other
  // combination has no dollar answer and a zero would read as one.
  const dragRiskUsd =
    drag !== null && drag.kind === "stop" && entryPrice !== null && (positionSize ?? 0) !== 0
      ? Math.abs(entryPrice - drag.price) * Math.abs(positionSize ?? 0)
      : null;

  // A refused stop is very often outside the drawn domain — the whole reason it
  // was refused is that it is further from the entry than the approved
  // envelope allows. Drawn at its true y it would be off the frame entirely
  // and the operator would see no second level at all, which reads as "the
  // drag did nothing". So it is pinned to the edge it went off, the same
  // treatment `ChartLevel.offScale` gives a stop the domain excluded.
  const refusedY =
    refusedLevel === undefined || refusedLevel === null
      ? null
      : Math.min(CHART_VIEWBOX_HEIGHT - 3, Math.max(3, geometry.yForPrice(refusedLevel.planPrice)));

  return (
    // `overflow-hidden`: the gutter tags and the mark dot are HTML positioned
    // in percentages of the viewBox, so anything the geometry places near an
    // edge would otherwise be drawn over the bands above and below the chart.
    <div
      ref={frameRef}
      className={cn("relative h-full w-full overflow-hidden", className)}
      // The crosshair follows the pointer whenever nothing is being dragged.
      // The grab strips capture their own pointer during a drag, so the frame
      // sees no moves then; the guard is for the pathological overlap.
      onPointerMove={(event) => {
        if (drag === null) hoverAtClient(event.clientX);
      }}
      onPointerLeave={() => setHover(null)}
    >
      {/* The mark's ring animation, declared once for the whole chart. */}
      <style>{`@keyframes mission-mark-pulse { 0%, 100% { opacity: 0.9; transform: translate(-50%, -50%) scale(1); } 50% { opacity: 0.15; transform: translate(-50%, -50%) scale(1.35); } }
@keyframes mission-level-flash { 0% { opacity: 0; } 15% { opacity: 1; } 100% { opacity: 0; } }
.mission-level-flash { animation: mission-level-flash 1.4s ease-out 2 forwards; opacity: 0; }
.mission-mark-pulse { animation: mission-mark-pulse 1.6s ease-in-out 2; }
.mission-marker-slide { transition: transform 500ms cubic-bezier(0.22, 1, 0.36, 1), left 500ms cubic-bezier(0.22, 1, 0.36, 1); }
/* The line draws itself, left to right, once. A pathLength of 1 normalises
   every polyline to a unit length, so one keyframe serves each segment
   whatever its real length. */
@keyframes mission-line-draw { from { stroke-dashoffset: 1; } to { stroke-dashoffset: 0; } }
.mission-line-draw { stroke-dasharray: 1; animation: mission-line-draw 1100ms cubic-bezier(0.33, 1, 0.68, 1) both; }
/* And the plot settles into place behind it, moving the same way. Six units of
   a 1000-unit viewBox — enough to register as motion, too little to read as a
   slide. */
@keyframes mission-plot-settle { from { transform: translateX(-6px); opacity: 0.4; } to { transform: none; opacity: 1; } }
.mission-plot-settle { animation: mission-plot-settle 1100ms cubic-bezier(0.33, 1, 0.68, 1) both; }
/* Phase 4 — the bracket stubs draw in when a position opens, once, from the
   gutter edge outward: the bracket appearing IS the state change. */
@keyframes mission-stub-draw { from { stroke-dashoffset: 220; } to { stroke-dashoffset: 0; } }
.mission-stub-draw { animation: mission-stub-draw 550ms cubic-bezier(0.33, 1, 0.68, 1) both; }
/* Phase 4 — a chip that just fired ripples once, then the chip is the
   timeline's business. */
@keyframes mission-chip-fire { 0% { box-shadow: 0 0 0 0 color-mix(in oklab, var(--color-armed) 45%, transparent); } 100% { box-shadow: 0 0 0 10px transparent; } }
.mission-chip-fire { animation: mission-chip-fire 700ms cubic-bezier(0, 0, 0.2, 1) 1; }
@media (prefers-reduced-motion: reduce) { .mission-level-flash { animation: none; opacity: 1; } .mission-mark-pulse { animation: none; } .mission-marker-slide { transition: none; } .mission-line-draw { stroke-dasharray: none; animation: none; } .mission-plot-settle { animation: none; } .mission-stub-draw { animation: none; } .mission-chip-fire { animation: none; } }`}</style>
      <svg
        viewBox={`0 0 ${CHART_VIEWBOX_WIDTH} ${CHART_VIEWBOX_HEIGHT}`}
        preserveAspectRatio="none"
        className="h-full w-full"
        aria-hidden="true"
      >
        <defs>
          {/* The Stocks app's one piece of shading: the line's own colour
              poured down to the floor and fading as it goes. It reads as
              light under the line rather than as a filled region, which is
              why it can be bright at the top without competing with the
              stroke. */}
          {/* The wash is theme-scaled. The same 0.22 that reads as pale mint
              under the line on white reads as a lit green mass on near-black —
              it is the single largest coloured region on the panel, and it was
              most of why dark felt crowded. The tokens live in index.css so the
              two themes can disagree about a number the SVG cannot branch on. */}
          <linearGradient id={`${gradientId}-under`} x1="0" y1="0" x2="0" y2="1">
            <stop
              offset="0%"
              stopColor={lineColor}
              style={{ stopOpacity: "var(--mission-chart-wash-top)" }}
            />
            <stop
              offset="45%"
              stopColor={lineColor}
              style={{ stopOpacity: "var(--mission-chart-wash-mid)" }}
            />
            <stop offset="100%" stopColor={lineColor} stopOpacity={0} />
          </linearGradient>
          {/* The plan wedge's fade: strongest at now, softest at the far edge,
              so distance reads as confidence without the shape ever fully
              disappearing — the invalidation edge has to stay findable. */}
          <linearGradient id={`${gradientId}-wedge`} x1="0" y1="0" x2="1" y2="0">
            <stop
              offset="0%"
              stopColor="var(--color-info)"
              style={{ stopOpacity: "var(--mission-chart-wedge-near)" }}
            />
            <stop
              offset="100%"
              stopColor="var(--color-info)"
              style={{ stopOpacity: "var(--mission-chart-wedge-far)" }}
            />
          </linearGradient>
        </defs>

        {/* The price grid. Four rules at round numbers across the domain, which
            is the frame the Stocks app reads its line against — without them a
            price line is a shape with no scale, and every wiggle looks the same
            size whether the market moved a dollar or twenty. */}
        {gridPrices.map((price) => (
          <line
            key={`grid-${price}`}
            x1={0}
            y1={geometry.yForPrice(price)}
            x2={PLOT_WIDTH}
            y2={geometry.yForPrice(price)}
            stroke="color-mix(in oklab, var(--color-foreground) 7%, transparent)"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        ))}

        {/* The future gutter's ground. Barely there now: at 4% it was a grey
            block pasted over the right third of the plot, and the eye read it
            as a different material rather than as the same plot after now.
            The hairline at `now` does the separating; the wash only tints. */}
        {geometry.nowX < PLOT_WIDTH ? (
          <rect
            x={geometry.nowX}
            y={0}
            width={PLOT_WIDTH - geometry.nowX}
            height={CHART_VIEWBOX_HEIGHT}
            fill="color-mix(in oklab, var(--color-foreground) 1.5%, transparent)"
            stroke="none"
          />
        ) : null}
        {geometry.nowX < PLOT_WIDTH ? (
          <line
            x1={geometry.nowX}
            y1={0}
            x2={geometry.nowX}
            y2={CHART_VIEWBOX_HEIGHT}
            stroke="color-mix(in oklab, var(--color-foreground) 14%, transparent)"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        ) : null}

        {/* The series, as one moving object: the fill and all three line
            segments travel together when a bar closes. */}
        <g
          style={{
            transform: `translateX(${slideOffset}px)`,
            transition:
              slideOffset === 0 ? "transform 700ms cubic-bezier(0.33, 1, 0.68, 1)" : "none",
          }}
        >
          {areaPath !== "" ? (
            <path
              className="mission-plot-settle"
              d={areaPath}
              fill={`url(#${gradientId}-under)`}
              stroke="none"
            />
          ) : null}

          {/* The candle bars are gone: the chart is a line chart now — the
            price is one continuous close line, which is the faithful shape of
            "where has price been" without the texture of every bar competing
            with the levels drawn over it. The geometry still computes bars;
            nothing here reads them. */}

          {/* The two EMAs are not drawn. Three curves in one frame — price, fast,
            slow — read as three subjects, and the two that were meant to be a
            quiet backdrop were the two the eye followed, because they are the
            smooth ones. The chart's subject is the price and the levels the
            plan drew across it. `geometry.emaLines` is still computed and still
            tested; putting the pair back is this block and the legend below it. */}

          {/* Pre-entry segment. Held at three quarters of the line's colour
            rather than in grey: the hour before the fill is the same price
            series, and draining it to muted grey was what made the chart look
            like two different instruments spliced at the entry. */}
          {geometry.preEntryPoints.length >= 2 ? (
            <polyline
              className={drawClass}
              onAnimationEnd={() => setIntroDone(true)}
              pathLength={1}
              points={toPoints(geometry.preEntryPoints)}
              fill="none"
              stroke={lineColor}
              strokeWidth={LINE_WIDTH}
              strokeLinejoin="round"
              strokeLinecap="round"
              opacity={pnlSign === null ? 1 : 0.55}
              vectorEffect="non-scaling-stroke"
            />
          ) : null}

          {/* Post-entry segment: the held part, at full strength. */}
          {geometry.postEntryPoints.length >= 2 ? (
            <polyline
              className={drawClass}
              onAnimationEnd={() => setIntroDone(true)}
              pathLength={1}
              points={toPoints(geometry.postEntryPoints)}
              fill="none"
              stroke={segmentColor}
              strokeWidth={LINE_WIDTH}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          ) : null}

          {/* The forming bar: last close → the mark. The one part of the line
            that changes between candle closes, which on a 1m series is 59
            seconds out of every 60 — so it is the segment that carries the
            left-to-right progress, and it is drawn at full strength. */}
          {geometry.livePoints.length === 2 ? (
            <polyline
              points={toPoints(geometry.livePoints)}
              fill="none"
              stroke={segmentColor}
              strokeWidth={LINE_WIDTH}
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          ) : null}
        </g>

        {/* The plan wedge (phase 3): ONE soft translucent shape from the live
            mark toward the target zone over the plan's own byMinutes, fading
            with distance. Its far edge is the invalidation — the hard vertical
            line where the trade stops being the trade — so direction, size and
            deadline read in one glance instead of as three separate lines.
            Falls back to the old dotted path when the bracket levels are not
            both on screen to close the shape against. */}
        {geometry.projectionPoints.length === 2
          ? renderPlanWedge({
              gradientId,
              projectionPoints: geometry.projectionPoints,
              levels: geometry.levels,
              endX: geometry.projectionPoints[1]!.x,
            })
          : null}

        {/* Future moments are TIME CHIPS in the bottom axis gutter (rendered
            with the HTML overlay below); the full-height rules are gone. What
            stays here is the temporary vertical hairline a hovered chip
            extends, so the moment can be read against the price line while it
            is being asked about — and stops existing the instant it is not. */}
        {hoveredTimeKey === null
          ? null
          : geometry.timeMarkers
              .filter((marker) => marker.key === hoveredTimeKey)
              .map((marker) => (
                <line
                  key={`timehairline-${marker.key}`}
                  data-testid="mission-chart-time-hairline"
                  x1={marker.x}
                  y1={0}
                  x2={marker.x}
                  y2={CHART_VIEWBOX_HEIGHT}
                  stroke={
                    marker.tone === "auto"
                      ? "color-mix(in oklab, var(--color-muted-foreground) 40%, transparent)"
                      : "color-mix(in oklab, var(--color-armed) 50%, transparent)"
                  }
                  strokeWidth={1}
                  strokeDasharray="2 4"
                  vectorEffect="non-scaling-stroke"
                />
              ))}

        {/* The mission's own turns, as a rug of ticks along the bottom edge.
            Full-height rules here would fence the price line in behind twenty
            verticals; a rug says "these are the moments" without competing with
            the one saturated shape on screen.

            While a selection is live (from either side), the matching tick
            glows and the rest recede — one moment, one question. */}
        {geometry.pastMarkers.map((marker) => {
          const selected = isMomentSelected(selection, marker.at);
          return (
            <line
              key={`past-${marker.key}`}
              data-testid={`mission-past-tick-${marker.key}`}
              x1={marker.x}
              y1={CHART_VIEWBOX_HEIGHT - (selected ? 10 : PAST_MARKER_TICK_HEIGHT)}
              x2={marker.x}
              y2={CHART_VIEWBOX_HEIGHT}
              stroke={pastMarkerColor(marker)}
              strokeWidth={selected ? 2 : 1}
              opacity={
                selected ? 1 : selection === null ? (marker.failed === true ? 0.9 : 0.55) : 0.2
              }
              vectorEffect="non-scaling-stroke"
            />
          );
        })}

        {/* The bracket stubs (phase 1): while a position is open, its stop and
            target keep a SHORT rule at the right edge of the plot — just wide
            enough that the bracket reads as a bracket next to the chips that
            name it, and no wider. Every other level's full-width rule is gone:
            the levels live in the gutter chips, and a rule spans the plot only
            while its chip is hovered (the hairline below). */}
        {pnlSign === null
          ? null
          : geometry.levels
              .filter((level) => level.kind === "stop" || level.kind === "target")
              .map((level) => (
                <line
                  key={`stub-${level.kind}`}
                  data-testid={`mission-chart-stub-${level.kind}`}
                  className="mission-stub-draw"
                  x1={PLOT_WIDTH * (1 - BRACKET_STUB_RATIO)}
                  y1={level.y}
                  x2={PLOT_WIDTH}
                  y2={level.y}
                  stroke={levelInkColor(level.kind)}
                  strokeWidth={1.5}
                  strokeDasharray="5 4"
                  opacity={0.85}
                  vectorEffect="non-scaling-stroke"
                />
              ))}

        {/* The hovered chip's temporary hairline. Exists only while the chip
            is hovered or focused — the rule says where, the chip says what,
            and both disappear together the moment the reader stops asking. */}
        {hoveredTagKey === null
          ? null
          : geometry.gutterTags
              .filter((tag) => tag.key === hoveredTagKey && tag.kind !== "mark")
              .map((tag) => (
                <line
                  key={`hairline-${tag.key}`}
                  data-testid="mission-chart-hairline"
                  x1={0}
                  y1={tag.y}
                  x2={geometry.nowX}
                  y2={tag.y}
                  stroke={levelInkColor(tag.kind)}
                  strokeWidth={1}
                  strokeDasharray="2 4"
                  opacity={0.5}
                  vectorEffect="non-scaling-stroke"
                />
              ))}

        {/* The flashed level: the same rule, drawn once more in its own ink and
            keyed by the click that asked for it, so the animation restarts on
            every click rather than only the first. */}
        {flashedLevel === null ? null : (
          <line
            key={`flash-${flash?.nonce ?? 0}`}
            data-testid="mission-chart-flash"
            className="mission-level-flash"
            x1={0}
            y1={flashedLevel.y}
            // Stops at now, like the rule it is highlighting: a flash running
            // into the gutter would be the one saturated thing in it.
            x2={geometry.nowX}
            y2={flashedLevel.y}
            stroke={levelInkColor(flashedLevel.kind)}
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
          />
        )}

        {/* The refused level's plan price, in the hypothetical register. The
            rule stays where the stop actually rests; this is what the plan now
            says, drawn as the claim it is — stub-width, like the bracket, not
            a full-width line. */}
        {refusedY === null || refusedLevel === null || refusedLevel === undefined ? null : (
          <line
            data-testid="mission-chart-refused-plan"
            x1={PLOT_WIDTH * (1 - BRACKET_STUB_RATIO)}
            y1={refusedY}
            x2={PLOT_WIDTH}
            y2={refusedY}
            stroke={levelInkColor(refusedLevel.kind)}
            strokeWidth={HYPOTHETICAL_STROKE_WIDTH}
            strokeDasharray={HYPOTHETICAL_DASH_ARRAY}
            opacity={HYPOTHETICAL_OPACITY}
            vectorEffect="non-scaling-stroke"
          />
        )}

        {/* The level under the pointer, while it is being dragged. Full ink,
            because this one IS a statement the operator is making right now. */}
        {drag === null ? null : (
          <line
            data-testid="mission-chart-drag-rule"
            x1={0}
            y1={geometry.yForPrice(drag.price)}
            x2={PLOT_WIDTH}
            y2={geometry.yForPrice(drag.price)}
            stroke={levelInkColor(drag.kind)}
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
          />
        )}

        {/* Leader lines retired with the rules: nothing persistent left on the
            plot for a nudged chip to point at — the hover hairline appears at
            the chip's own level, wherever its label was laid out. */}
      </svg>

      {/* The grab strips. HTML rather than SVG because a stretched plot makes
          a thin SVG hit area unusably narrow at some widths and enormous at
          others; a percentage-positioned strip is the same eight pixels tall
          whatever the panel does. They sit over the plot only — the gutter is
          text and must stay selectable. */}
      {geometry.levels
        .filter((level) => isDraggable(level.kind) && level.inFrame)
        .map((level) => (
          <div
            key={`grab-${level.kind}-${level.price}`}
            data-testid={`mission-chart-grab-${level.kind}`}
            role="slider"
            tabIndex={-1}
            aria-label={`${level.kind} price`}
            aria-valuenow={level.price}
            className="absolute h-[9px] -translate-y-1/2 cursor-ns-resize touch-none"
            style={{
              left: 0,
              width: `${(PLOT_WIDTH / CHART_VIEWBOX_WIDTH) * 100}%`,
              top: `${(level.y / CHART_VIEWBOX_HEIGHT) * 100}%`,
            }}
            onPointerDown={(event) => startDrag(level.kind, event)}
            onPointerMove={moveDrag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          />
        ))}

      {/* The dragged price, and what it would plan to lose. Follows the
          pointer, because a readout the operator has to look away to read is a
          readout they will not read while dragging. */}
      {drag === null ? null : (
        <span
          data-testid="mission-chart-drag-readout"
          // Left, not right: the gutter on the right is where the level tags
          // live, and a readout over them covers the very prices the operator
          // is dragging relative to.
          className="pointer-events-none absolute left-1 -translate-y-1/2 rounded-sm bg-background/90 px-1 py-0.5 font-mono text-[10.5px] tabular-nums"
          style={{
            top: `${(geometry.yForPrice(drag.price) / CHART_VIEWBOX_HEIGHT) * 100}%`,
            color: levelInkColor(drag.kind),
          }}
        >
          {formatPrice(drag.price)}
          {dragRiskUsd === null ? "" : ` · risk $${dragRiskUsd.toFixed(2)}`}
        </span>
      )}

      {/* Fill markers and the mark dot are HTML, not SVG, for the same reason
          the gutter is: the plot stretches (`preserveAspectRatio="none"`), so an
          SVG circle drawn in it comes out an ellipse whose eccentricity depends
          on the container width. Positioned in percentages of the same viewBox,
          they stay in register with the plot at any size and stay round. */}
      {geometry.fillPoints.map((fill) => {
        const style = fillMarkerStyle(fill.kind);
        const selected = selection?.eventId === fill.key || isMomentSelected(selection, fill.at);
        return (
          <span
            key={`fill-${fill.key}`}
            data-testid={`mission-fill-${fill.key}`}
            // A fill is the one thing on the price path worth reading whole:
            // side, size, price, net, as a native tooltip on the marker itself.
            // oxlint-disable-next-line t3code/no-native-title-tooltip -- Upstream's new rule wants the styled Tooltip here. Converting the mission panel's hover copy is a UI change with its own live verification, not part of an upstream sync.
            title={fill.label ?? fill.kind.replaceAll("_", " ")}
            className="group/fill absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full outline-none"
            style={{
              left: `${(fill.x / CHART_VIEWBOX_WIDTH) * 100}%`,
              top: `${(fill.y / CHART_VIEWBOX_HEIGHT) * 100}%`,
            }}
            tabIndex={0}
            aria-label={fill.label ?? undefined}
            onFocus={() => hoverChartEvent({ id: fill.key, atMillis: fill.at })}
            onBlur={() => hoverChartEvent(null)}
            onMouseEnter={() => hoverChartEvent({ id: fill.key, atMillis: fill.at })}
            onMouseLeave={() => hoverChartEvent(null)}
          >
            <span
              className={cn(
                "block size-[7px] rounded-full border-[1.5px] transition-transform duration-150 group-hover/fill:scale-[1.6] motion-reduce:transition-none motion-reduce:group-hover/fill:scale-100",
                selected && "scale-[1.6] motion-reduce:scale-100",
              )}
              style={{
                borderColor: style.color,
                backgroundColor: style.filled ? style.color : "transparent",
              }}
            />
          </span>
        );
      })}

      {/* The past markers' hover targets: one invisible strip per tick, wide
          enough to hit, through which a hover (or focus) claims the moment for
          the shared selection — the tick glows and the panel finds its card. */}
      {geometry.pastMarkers.map((marker) => (
        <span
          key={`pasthit-${marker.key}`}
          className="absolute h-4 w-3 -translate-x-1/2 translate-y-[-100%] rounded-sm outline-none"
          style={{
            left: `${(marker.x / CHART_VIEWBOX_WIDTH) * 100}%`,
            bottom: 0,
          }}
          tabIndex={0}
          aria-label={`${marker.kind} at ${new Date(marker.at).toLocaleTimeString()}`}
          onFocus={() => hoverChartEvent({ id: marker.key, atMillis: marker.at })}
          onBlur={() => hoverChartEvent(null)}
          onMouseEnter={() => hoverChartEvent({ id: marker.key, atMillis: marker.at })}
          onMouseLeave={() => hoverChartEvent(null)}
        />
      ))}

      {/* The mark: a solid dot inside a pulsing ring. The ring is what carries
          the motion, so the dot itself stays a crisp, readable point. */}
      {geometry.markPoint !== null ? (
        <span
          className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2"
          style={{
            left: `${(geometry.markPoint.x / CHART_VIEWBOX_WIDTH) * 100}%`,
            top: `${(geometry.markPoint.y / CHART_VIEWBOX_HEIGHT) * 100}%`,
          }}
          aria-hidden="true"
        >
          {markMotion === "live" ? (
            <span
              // The pulse is finite (two beats in the CSS below) and marks
              // "the mark just moved": the key derived from the price remounts
              // the ring on every change so the pair of beats replays once per
              // move, and between moves the ring sits still.
              key={markPrice ?? "mark"}
              // The translate lives in the keyframes, not in a class: the
              // animation drives `transform`, so a utility that also set it
              // would simply be overwritten on the first frame.
              className="absolute left-1/2 top-1/2 size-[14px] rounded-full border mission-mark-pulse"
              style={{
                borderColor: segmentColor,
              }}
            />
          ) : null}
          <span
            className="block size-[7px] rounded-full"
            style={{ backgroundColor: segmentColor }}
          />
        </span>
      ) : null}

      {/* The projection's endpoint ring retired with the dotted path: the
          wedge carries the same read as one shape, and a ring floating at the
          far edge of a faded wedge is chrome the shape already implies. */}

      {/* Time chips (phase 1): every future moment — reassessments, the plan
          horizon — is a small glass chip docked in the BOTTOM axis gutter, in
          the future zone right of the last candle. Unlabelled queue members
          state their clock time; the nearest one keeps its word. Hovering or
          focusing a chip extends its temporary vertical hairline (above), and
          slides when its moment is re-armed, the way the rule it replaced
          did.

          Anchored by their LEFT edge, at the moment itself, so the chip lies
          in the future zone the moment belongs to. Right-anchoring them read
          well only for a moment far out: a reassessment three minutes away
          sits just past `now`, and a right-anchored chip then hangs backwards
          across the divider and labels the record with a time that has not
          happened. The frame is still safe because the chip may not grow past
          the remaining width, and its text truncates rather than overflowing. */}
      {geometry.timeMarkers.map((marker) => (
        <span
          key={`timechip-${marker.key}`}
          data-testid={`mission-time-chip-${marker.key}`}
          className={cn(
            "mission-marker-slide absolute bottom-0.5 flex max-w-[9rem] cursor-default items-center gap-1 whitespace-nowrap rounded-full border px-1.5 py-[1px] font-mono text-[10px] leading-none outline-none backdrop-blur-sm transition-colors",
            marker.tone === "auto"
              ? "border-border/50 bg-background/70 text-muted-foreground"
              : "border-armed/40 bg-background/70 text-armed",
            hoveredTimeKey === marker.key && "border-armed/70",
          )}
          style={{
            left: `${(marker.x / CHART_VIEWBOX_WIDTH) * 100}%`,
            maxWidth: `calc(${(1 - marker.x / CHART_VIEWBOX_WIDTH) * 100}% - 4px)`,
          }}
          tabIndex={0}
          aria-label={`${marker.label === "" ? "check-in" : marker.label} at ${new Date(
            marker.at,
          ).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`}
          onMouseEnter={() => setHoveredTimeKey(marker.key)}
          onMouseLeave={() => setHoveredTimeKey(null)}
          onFocus={() => setHoveredTimeKey(marker.key)}
          onBlur={() => setHoveredTimeKey(null)}
        >
          <span className="text-[9px]" aria-hidden>
            ◷
          </span>
          <span className="truncate">
            {marker.label === ""
              ? new Date(marker.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
              : marker.label}
          </span>
        </span>
      ))}

      {/* The EMA legend went with the lines it named. A legend for a series
          that is not drawn is two more prices to read in the corner of a chart
          whose top-left is otherwise empty ground. */}

      {/* The grid's own prices, sitting just above their rules at the left of
          the plot. The Stocks app puts this scale on the right; here the right
          is the level gutter — entry, stop, target, the mark — and a price
          scale interleaved with those would be two columns of numbers meaning
          different things. The left of the plot is empty ground. */}
      {gridPrices.map((price) => (
        <span
          key={`grid-label-${price}`}
          className="pointer-events-none absolute left-1.5 -translate-y-full pb-0.5 font-mono text-[10px] leading-none tabular-nums text-muted-foreground"
          style={{ top: `${(geometry.yForPrice(price) / CHART_VIEWBOX_HEIGHT) * 100}%` }}
          aria-hidden="true"
        >
          {formatPrice(price)}
        </span>
      ))}

      {/* The hover crosshair — the Stocks-app read. A hairline at the sampled
          moment, a dot on the line, and the price/time pair floating above,
          all HTML so nothing stretches. It reads the record only; the future
          gutter is claims, and claims have no sample to read. */}
      {hover === null ? null : (
        <>
          <span
            data-testid="mission-chart-crosshair"
            className="pointer-events-none absolute inset-y-0 w-px bg-foreground/25"
            style={{ left: `${(hover.x / CHART_VIEWBOX_WIDTH) * 100}%` }}
            aria-hidden="true"
          />
          <span
            className="pointer-events-none absolute size-[7px] -translate-x-1/2 -translate-y-1/2 rounded-full border-[1.5px] bg-background"
            style={{
              left: `${(hover.x / CHART_VIEWBOX_WIDTH) * 100}%`,
              top: `${(hover.y / CHART_VIEWBOX_HEIGHT) * 100}%`,
              borderColor: segmentColor,
            }}
            aria-hidden="true"
          />
          <span
            className="pointer-events-none absolute top-1 -translate-x-1/2 whitespace-nowrap rounded-sm bg-background/90 px-1.5 py-0.5 font-mono text-[10.5px] leading-none tabular-nums text-foreground"
            style={{
              // Clamped in from both edges so the readout never leaves the
              // frame at either end of the series.
              left: `clamp(3rem, ${(hover.x / CHART_VIEWBOX_WIDTH) * 100}%, calc(100% - 3rem))`,
            }}
            aria-hidden="true"
          >
            {formatPrice(hover.price)}
            <span className="text-muted-foreground">
              {" · "}
              {/* Seconds only on the live sample: candle closes land on the
                  minute, but "now" is inside one, and without the seconds the
                  mark read as the same moment as the bar it is closing. */}
              {new Date(hover.at).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
                ...(hover.isMark ? { second: "2-digit" as const } : {}),
              })}
            </span>
          </span>
        </>
      )}

      {/* The gutter (phase 1): every level is a CHIP — a small glass pill
          docked at its price, color-coded by kind within the panel's one
          accent family. HTML so the glyphs are never stretched by the plot's
          aspect ratio; interactive, because the chip's hover (or focus) is
          what extends its temporary hairline across the chart and claims the
          shared selection for the watch stream's matching row. */}
      <div
        className="absolute inset-y-0 right-0 flex flex-col items-end justify-center gap-[3px] text-[11px] leading-none tabular-nums"
        style={{ width: `max(${gutterPercent}%, 4.5rem)` }}
      >
        {geometry.gutterTags.map((tag) => {
          const caption = tagCaption(tag);
          const glyph = tagGlyph(tag);
          const ink = tag.kind === "mark" ? segmentColor : levelInkColor(tag.kind);
          const hovered = hoveredTagKey === tag.key;
          const selected =
            tag.id !== undefined && selection !== null && selection.eventId === tag.id;
          // The arm pulse: only on the render a watch's chip first appears in
          // after the first, keyed by the watch's own id. Written to the ref
          // here, idempotently, so a re-render of a chip already seen never
          // pulses again.
          const isNewlyArmed =
            tag.id !== undefined && chipPrimedRef.current && !pulsedIdsRef.current.has(tag.id);
          if (isNewlyArmed && tag.id !== undefined) pulsedIdsRef.current.add(tag.id);
          const topPercent = (tag.labelY / CHART_VIEWBOX_HEIGHT) * 100;
          if (tag.id !== undefined) {
            chipSnapshotRef.current.set(tag.id, {
              id: tag.id,
              topPercent,
              ink,
              text:
                `${glyph === "" ? "" : `${glyph} `}${formatPrice(tag.price)}` +
                (caption === "" ? "" : ` ${caption}`),
            });
          }
          return (
            <span
              // Keyed by the watch id where there is one, so the element
              // survives index shifts in the level list — an index-keyed chip
              // remounts when a neighbour appears, and a remount replays the
              // arm pulse about a level that did not just arm.
              key={tag.id ?? tag.key}
              data-testid={`mission-level-chip-${tag.kind}`}
              data-watch-chip={tag.id}
              className={cn(
                "mission-chip flex max-w-full cursor-default items-center gap-1 whitespace-nowrap rounded-full border px-1.5 py-[1.5px] font-mono text-[10.5px] outline-none backdrop-blur-sm transition-[box-shadow,border-color] duration-150",
                hovered || selected ? "border-current/60" : "border-border/50",
                tag.id !== undefined &&
                  firedWatchIds !== undefined &&
                  firedWatchIds.includes(tag.id) &&
                  "mission-chip-fire",
                isNewlyArmed && "mission-chip-arm",
              )}
              style={{
                color: ink,
                top: `${(tag.labelY / CHART_VIEWBOX_HEIGHT) * 100}%`,
                position: "absolute",
                right: 2,
                ...(selected
                  ? { boxShadow: `0 0 0 1px color-mix(in oklab, ${ink} 45%, transparent)` }
                  : {}),
              }}
              tabIndex={0}
              role="note"
              aria-label={`${caption === "" ? tag.kind.replaceAll("_", " ") : caption} at ${formatPrice(tag.price)}`}
              onMouseEnter={() => {
                setHoveredTagKey(tag.key);
                if (tag.id !== undefined) hoverChartEvent({ id: tag.id, atMillis: 0 });
              }}
              onMouseLeave={() => {
                setHoveredTagKey(null);
                hoverChartEvent(null);
              }}
              onFocus={() => {
                setHoveredTagKey(tag.key);
                if (tag.id !== undefined) hoverChartEvent({ id: tag.id, atMillis: 0 });
              }}
              onBlur={() => {
                setHoveredTagKey(null);
                hoverChartEvent(null);
              }}
            >
              {glyph === "" ? null : (
                <span className="text-[9px]" aria-hidden>
                  {glyph}
                </span>
              )}
              <span>{formatPrice(tag.price)}</span>
              {tag.offScale === null ? null : (
                <span aria-hidden>{tag.offScale === "above" ? "↑" : "↓"}</span>
              )}
              {caption === "" ? null : (
                <span className="truncate text-[9.5px] opacity-70">
                  {tag.kind === "mark" ? `(${caption})` : caption}
                  {tag.count === undefined ? "" : ` ×${tag.count}`}
                </span>
              )}
            </span>
          );
        })}
        {/* The retire ghosts (phase 4): a chip whose watch settled fades out
            once at its last dock, then is removed. One element per retire,
            transform/opacity only, gone when the fade ends. */}
        {retireGhosts.map((ghost) => (
          <span
            key={`retiring-${ghost.id}`}
            data-testid="mission-chip-retiring"
            className="mission-chip mission-chip-retire pointer-events-none absolute flex items-center gap-1 whitespace-nowrap rounded-full border border-border/50 px-1.5 py-[1.5px] font-mono text-[10.5px]"
            style={{ color: ghost.ink, top: `${ghost.topPercent}%`, right: 2 }}
            aria-hidden
            onAnimationEnd={() => retireGhost(ghost.id)}
          >
            {ghost.text}
          </span>
        ))}
        {/* The overflow chip: levels the gutter folded away are not silently
            dropped — they are counted here, and hovering the count claims the
            selection so the panel's watch list answers with the full set. */}
        {overflowCount !== null && overflowCount !== undefined && overflowCount > 0 ? (
          <span
            data-testid="mission-chip-overflow"
            className="mission-chip absolute bottom-0.5 right-2 flex cursor-default items-center gap-1 rounded-full border border-border/50 bg-background/70 px-1.5 py-[1.5px] font-mono text-[10.5px] text-muted-foreground outline-none backdrop-blur-sm"
            tabIndex={0}
            aria-label={`${overflowCount} more armed levels, listed in the watch panel`}
            onMouseEnter={() => hoverChartEvent({ id: "chip-overflow", atMillis: 0 })}
            onMouseLeave={() => hoverChartEvent(null)}
            onFocus={() => hoverChartEvent({ id: "chip-overflow", atMillis: 0 })}
            onBlur={() => hoverChartEvent(null)}
          >
            +{overflowCount}
          </span>
        ) : null}
      </div>
    </div>
  );
}
