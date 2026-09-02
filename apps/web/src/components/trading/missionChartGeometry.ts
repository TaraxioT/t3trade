// ---------------------------------------------------------------------------
// missionChartGeometry
// ---------------------------------------------------------------------------
//
// The pure math behind the mission price chart. NO React, NO DOM — every
// function here is unit-testable and deterministic, turning the projection's
// candles + prices into the viewBox coordinates the SVG renderer draws.
//
// The chart's "one visual idea": the shape of the trade you are in is the only
// saturated thing on screen. Everything else — the pre-entry line, the level
// rules — is there to frame that shape, and the geometry below computes those
// frames from the projection alone (never from UI state).

import {
  EMA_FAST_PERIOD,
  EMA_SLOW_PERIOD,
  exponentialMovingAverage,
} from "@t3tools/trading-contracts";

import { readFillLifecycle, type ChartFillKind, type ChartFillMarker } from "./tradingPresentation";

/**
 * ViewBox units reserved at the right edge for price tags.
 *
 * 15% of the frame rather than 12%: a tag is a price over a caption, and at
 * 12% the caption of a condition ("close above") was the thing that got
 * ellipsised away on a half-width panel — leaving the level's price with no
 * statement of what the level was.
 */
export const LABEL_GUTTER_WIDTH = 150;
export const CHART_VIEWBOX_WIDTH = 1000;
export const CHART_VIEWBOX_HEIGHT = 160;
/** The drawable plot area: viewBox minus the right-edge price-tag gutter. */
export const PLOT_WIDTH = CHART_VIEWBOX_WIDTH - LABEL_GUTTER_WIDTH; // 880
/** Padding above/below the y-domain, as a fraction of the span. */
export const DOMAIN_PADDING_RATIO = 0.18;
/** Fewer candles than this and there is no chart to draw. */
export const MIN_CANDLES_FOR_SVG = 2;

/**
 * How far from the candle window's midpoint a level may sit and still anchor
 * the y-domain, as a multiple of the candle range.
 *
 * A 20x target can sit far enough away that including it squashes an hour of
 * 1m price action into a band a few pixels tall — the chart then "does not
 * scale", which is exactly the complaint. Beyond this reach the level is
 * excluded from the domain and pinned at the frame edge with a chevron
 * instead, the same idiom the clamped mark dot already uses.
 */
export const DOMAIN_LEVEL_REACH_RATIO = 1.5;

/**
 * Minimum vertical gap between two gutter tags, in viewBox units.
 *
 * A tag is two lines — the price, and the word that says which level it is —
 * so the gap has to clear both or the caption of one tag sits under the price
 * of the next. 18 of 160 is a ninth of the plot's height, which is about two
 * lines of 10px text on the panel heights this chart is rendered at.
 */
export const GUTTER_LABEL_MIN_SEPARATION = 18;

/**
 * Below this gap the entry tag is folded into the mark tag rather than nudged
 * away from it. Two tags 3 units apart reading 1,869.25 and 1,859.43 are two
 * numbers fighting; `1,869.25 (entry 1,859.43)` is one fact.
 */
export const GUTTER_LABEL_MERGE_DISTANCE = 6;

/**
 * How far inside the frame a gutter tag's centre is held, in viewBox units.
 *
 * A tag is drawn centred on its `labelY` and is two lines tall, so a tag
 * centred on the frame edge puts half of itself outside the chart — over the
 * schedule pills below it, or the header above. Nine units is a little over
 * one line at the heights this chart renders at.
 */
export const GUTTER_LABEL_EDGE_INSET = 9;

/**
 * How many armed condition levels the chart draws before it says "+N more".
 *
 * Two, not three. The named levels — entry, stop, target, liquidation, the
 * mark — already own most of the gutter, and a third dashed rule with a third
 * "above"/"below" caption stacked beside them turned the right edge into a
 * price list. The conditions are read as a list in the readout's checklist;
 * on the chart they are there to say "and these two are near". The rest are
 * counted, never silently dropped.
 */
export const MAX_DRAWN_CONDITIONS = 2;

/**
 * How close two armed conditions have to be to become one drawn level, as a
 * fraction of the candle window's own range.
 *
 * A plan that raises its stop twice leaves three watches within a few tenths of
 * a percent of each other — 1,876.00, 1,875.90, 1,875.66 on a window whose bars
 * span twenty dollars. Drawn as three levels they are three rules the eye
 * cannot separate, three gutter tags all captioned "below", and (because the
 * tag layout holds tags apart) three labels no longer next to the rules they
 * name. At this distance they are one line on the price axis, and the chart
 * says so: the nearest price, plus how many watches sit on it.
 */
export const CONDITION_CLUSTER_RANGE_RATIO = 0.03;

/**
 * The share of the plot held empty to the right of "now", as a fraction.
 *
 * Only used when the caller passes `nowMillis` (the live panel does; the
 * post-mortem review chart does not — a closed trade has no future). Two things
 * need this space. The mark dot was pinned hard against the frame edge, where
 * a series sliding leftward is invisible because there is nothing for it to
 * slide away from. And a scheduled reassessment is a point in time *ahead* of
 * the last candle, so without a future there is nowhere on the x axis to draw
 * it.
 */
export const FUTURE_GUTTER_RATIO = 0.12;

/** A point in viewBox space. */
export interface ChartPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * Which of the chart's prices a horizontal level represents.
 *
 * The two `condition_*` kinds are the armed watches a flat mission is waiting
 * on — the levels that decide whether it enters at all. They were invisible
 * before the panel drew a chart pre-position, which made "waiting" look like
 * "idle".
 */
export type ChartLevelKind =
  | "entry"
  | "stop"
  | "target"
  | "liquidation"
  | "condition_above"
  | "condition_below"
  | "pending_buy"
  | "pending_sell";

/** A horizontal price level drawn across the plot. */
export interface ChartLevel {
  readonly kind: ChartLevelKind;
  readonly price: number;
  /** ViewBox y position, clamped into the frame when `offScale` is set. */
  readonly y: number;
  /** Whether this price falls inside the padded y-domain. */
  readonly inFrame: boolean;
  /**
   * Which edge the level is pinned to when it sits outside the domain.
   *
   * A stop or target far enough away to flatten the candle series is excluded
   * from the domain and drawn at the edge with a chevron, rather than dragged
   * into the domain and taking the price action's resolution with it.
   */
  readonly offScale: "above" | "below" | null;
  /**
   * Where this level's rule stops on the x axis, in viewBox units.
   *
   * Everything up to {@link ChartGeometry.nowX} is what the level has been;
   * everything past it is a projection, drawn in the hypothetical register.
   * A named level (entry, stop, target) projects to the frame's right edge —
   * it holds until something moves it. An armed *trigger* does not: the plan
   * that armed it goes stale at its reassessment, so its projection stops
   * there, and `futureEndX === nowX` on a plan already past it. Equal to
   * `nowX` without a clock, which is what keeps the review chart's rules
   * exactly as long as they were.
   */
  readonly futureEndX: number;
  /** Whether an armed condition's predicate is already satisfied. */
  readonly met?: boolean;
  /**
   * The persisted watch id behind a condition level, carried for the
   * renderer's hover selection. @see ChartCondition.id
   */
  readonly id?: string;
  /**
   * How many armed watches this one condition level stands for.
   *
   * Above 1 the level is a cluster — see {@link CONDITION_CLUSTER_RANGE_RATIO}
   * — and its `price` is the nearest of them to the mark, the one the market
   * would reach first.
   */
  readonly count?: number;
  /** A caption the caller supplied, in place of the kind's own. @see ChartCondition.label */
  readonly label?: string;
  /** Armed, or merely claimed. @see ChartCondition.register */
  readonly register?: ChartRegister;
}

/**
 * The drawn level at a given price, or null when the chart draws none there.
 *
 * This is what turns a click on an "Up next" pill into a highlight: the pill
 * carries the price, the chart carries the levels, and this is the join. The
 * pill's price and the level's price come from the same projection field but
 * travel through different arithmetic — a PnL watch is divided back into a
 * price on both paths — so they are compared with a relative tolerance rather
 * than for equality.
 *
 * Nothing is snapped to a merely *nearest* level: the strip can name a level
 * the chart's domain does not reach, and lighting up the closest rule instead
 * would point the operator at the wrong price.
 */
export function findLevelAtPrice(
  levels: ReadonlyArray<ChartLevel>,
  price: number,
): ChartLevel | null {
  const tolerance = Math.max(Math.abs(price), 1) * 1e-6;
  for (const level of levels) {
    if (Math.abs(level.price - price) <= tolerance) return level;
  }
  return null;
}

/** One armed price condition the chart draws as a level. */
export interface ChartCondition {
  readonly price: number;
  readonly direction: "above" | "below";
  readonly met: boolean;
  /** Set by clustering; how many watches this entry stands for. @see ChartLevel.count */
  readonly count?: number;
  /**
   * The persisted watch id this level was armed by, when the caller knows it.
   * Purely carried: the geometry never reads it, but the renderer's hover
   * selection joins a level chip back to its watch-stream row by id.
   */
  readonly id?: string;
  /**
   * The caption for this level's chip, when the caller has a better one than
   * the direction. A thesis's entry rule is a level with a NAME - the idea it
   * belongs to - and "above" is the least of what can be said about it.
   */
  readonly label?: string;
  /**
   * Whether the level is armed or merely claimed. Defaults to `actual`.
   *
   * A validation's entry rule is a claim on every chart it appears on: nothing
   * is watching that price, and a paper fill there costs nothing. Drawn in the
   * same register the future gutter's projections use, so the reader can tell
   * it from a watch that will actually wake the mission.
   */
  readonly register?: ChartRegister;
}

/** One placed fill: where on the plot the mission traded, and what it was. */
export interface ChartFillPoint {
  readonly key: string;
  readonly x: number;
  readonly y: number;
  readonly price: number;
  readonly kind: ChartFillKind;
  /** Epoch millis of the fill, for hover selection. */
  readonly at: number;
  /** The marker's tooltip line, carried from the projection row. */
  readonly label: string | null;
}

/**
 * Whether a drawn thing is a record or a claim.
 *
 * The chart has always drawn the distinction to the right of `now` - thinner,
 * dashed, three quarters opacity - but only ever for the future gutter's own
 * projections. A hypothesis's levels are claims everywhere on the x axis, not
 * only after now, so the register had to become a property a caller can set
 * rather than a consequence of where a thing sits.
 */
export type ChartRegister = "actual" | "hypothetical";

/**
 * What a price band is about, for colour only.
 *
 * Deliberately not a list of meanings. `plan` is the projection's own family,
 * `risk` and `reward` are the two ends of a bracket, and `neutral` is a band
 * with no valence. The geometry never reads this; the renderer maps it to ink.
 */
export type ChartZoneTone = "plan" | "risk" | "reward" | "neutral";

/** A price band a caller wants washed across the plot. */
export interface ChartZoneInput {
  readonly key: string;
  /** The gutter chip's caption. Composed by the caller; never derived here. */
  readonly label: string;
  readonly priceLow: number;
  readonly priceHigh: number;
  readonly tone: ChartZoneTone;
  readonly register: ChartRegister;
}

/**
 * A price band, placed and clipped to the frame.
 *
 * The chart's only band before this was the time-axis `CoverageBand`, which is
 * a statement about a stretch of the x axis. This is its twin on the y axis: a
 * range of PRICE that means something - the projection's honest interval, the
 * distance between a paper trade's stop and its target - drawn as a quiet wash
 * rather than as two lines the reader has to pair up themselves.
 *
 * `height` is zero for a band entirely outside the domain. The renderer draws
 * no rect for those but still docks the chip, with `offScale` pointing at the
 * edge it lies beyond - the same courtesy an off-scale level gets, and for the
 * same reason: a band the frame cannot reach is still a fact about the plan.
 */
export interface ChartZone {
  readonly key: string;
  readonly label: string;
  readonly priceLow: number;
  readonly priceHigh: number;
  readonly tone: ChartZoneTone;
  readonly register: ChartRegister;
  /** ViewBox y of the band's top edge, after clipping. */
  readonly y: number;
  /** The band's clipped height in viewBox units. Zero when fully off-scale. */
  readonly height: number;
  /** Where the chip is drawn, after the shared gutter collision pass. */
  readonly labelY: number;
  /** Which edge the band lies beyond, when the domain does not reach it. */
  readonly offScale: "above" | "below" | null;
}

/**
 * A right-gutter price tag, after collision resolution.
 *
 * `y` is where the level actually sits; `labelY` is where its tag is drawn.
 * When they differ the renderer draws a leader line between them, so a nudged
 * tag still points at its own level.
 */
export interface GutterTag {
  readonly key: string;
  readonly kind: ChartLevelKind | "mark";
  readonly y: number;
  readonly labelY: number;
  readonly price: number;
  readonly offScale: "above" | "below" | null;
  readonly met?: boolean;
  /** Set when the entry tag merged into the mark tag; the entry price. */
  readonly mergedPrice?: number;
  /** How many armed watches the tag's level stands for. @see ChartLevel.count */
  readonly count?: number;
  /** The watch id behind a condition tag, carried for hover selection. */
  readonly id?: string;
  /** A caption the caller supplied, in place of the kind's own. */
  readonly label?: string;
  /** Armed, or merely claimed. @see ChartCondition.register */
  readonly register?: ChartRegister;
}

/**
 * One candle, placed — the market's own texture behind the trade's shape.
 *
 * The chart drew closes only, which is a defensible line chart and not what
 * the same minute looks like on the exchange: a bar that opened at the low and
 * closed at the high reads identically to one that drifted, and the wick that
 * took a stop out is not on screen at all. `bodyTop`/`bodyBottom` are already
 * ordered for a rect, and `halfWidth` is half the bar's own pitch, so the
 * renderer needs no arithmetic of its own.
 */
export interface ChartBar {
  readonly key: number;
  /** ViewBox x of the bar's centre. */
  readonly x: number;
  /** Half the spacing between two bars, capped — see `BAR_MAX_HALF_WIDTH`. */
  readonly halfWidth: number;
  readonly highY: number;
  readonly lowY: number;
  readonly bodyTop: number;
  readonly bodyBottom: number;
  /** Close at or above open is `up`. Doji resolve to `up`, as exchanges do. */
  readonly direction: "up" | "down";
}

/**
 * One of the two moving averages the EMA-cross strategy trades, placed.
 *
 * Both are drawn whenever the window is long enough to carry them, whatever the
 * mission is doing: the cross of a fast average through a slow one is the
 * strategy's entry read, and a chart that shows the entry level without the two
 * curves that produced it is asking the operator to take the setup on faith.
 * The arithmetic is the strategy's own — `exponentialMovingAverage` from the
 * contracts package, at {@link EMA_FAST_PERIOD}/{@link EMA_SLOW_PERIOD} — so
 * the line on screen cannot drift from the line the gate reads.
 */
export interface ChartEmaLine {
  readonly speed: "fast" | "slow";
  readonly period: number;
  readonly points: ReadonlyArray<ChartPoint>;
  /** The average's newest value, in price. */
  readonly lastValue: number;
}

/**
 * Widest a candle body is drawn, in viewBox units.
 *
 * A short window (a mission two bars old) would otherwise draw two slabs
 * hundreds of units wide. The cap keeps a sparse chart reading as a sparse
 * chart rather than as a bar chart of two values.
 */
export const BAR_MAX_HALF_WIDTH = 6;

/**
 * Everything the SVG renderer needs, derived once from candles + prices.
 *
 * The functions (`xForTime`, `yForPrice`) are closed over the domain so the
 * renderer can map without re-deriving bounds per pixel.
 */
export interface ChartGeometry {
  readonly viewBoxWidth: number;
  readonly viewBoxHeight: number;
  readonly plotWidth: number;
  readonly labelGutterWidth: number;
  /** Padded lower bound of the y-domain. */
  readonly domainMin: number;
  /** Padded upper bound of the y-domain. */
  readonly domainMax: number;
  /** Epoch millis of the first candle's openTime. */
  readonly timeStart: number;
  /** Epoch millis mapped to {@link nowX} — `nowMillis`, or the last candle. */
  readonly timeEnd: number;
  /**
   * The x of "now": where the mark sits and the future gutter begins.
   *
   * Equal to `plotWidth` unless the caller passed `nowMillis`, which is what
   * keeps the review chart's geometry byte-identical to what it was.
   */
  readonly nowX: number;
  readonly xForTime: (t: number) => number;
  readonly yForPrice: (p: number) => number;
  /**
   * Every candle in the window, placed. Empty when no candle carries an
   * `open` — a body drawn from a guessed open is a bar that did not happen.
   */
  readonly bars: ReadonlyArray<ChartBar>;
  /** The fast and slow EMAs, or empty when the window is too short for both. */
  readonly emaLines: ReadonlyArray<ChartEmaLine>;
  /** Closes before the entry time — the flat part of the line. */
  readonly preEntryPoints: ReadonlyArray<ChartPoint>;
  /** Closes from entry time onward — the held part of the line. */
  readonly postEntryPoints: ReadonlyArray<ChartPoint>;
  /**
   * The forming bar: last close → the live mark. Two points, or empty.
   *
   * This is the only part of the chart that moves between candle closes, and
   * on a 1m series that is 59 seconds out of every 60. Without it the mark dot
   * floats unattached in the future gutter and the line just stops short of it.
   */
  readonly livePoints: ReadonlyArray<ChartPoint>;
  readonly levels: ReadonlyArray<ChartLevel>;
  /**
   * Every fill that falls inside the drawn window, placed on the axis.
   *
   * The chart's record of the session's activity: each open and each close the
   * mission has made, at the price and moment it happened. Fills older than the
   * first candle are dropped rather than pinned to the left edge — a marker at
   * a time it did not happen is worse than no marker.
   */
  readonly fillPoints: ReadonlyArray<ChartFillPoint>;
  /** Pinned at {@link nowX}; null when markPrice is null. */
  readonly markPoint: ChartPoint | null;
  /**
   * The plan's projection as a drawable path: the live mark to the projected
   * price at its expected moment, clamped into the future gutter. Empty when
   * no projection is published, there is no clock, or there is no mark to
   * start the path from.
   */
  readonly projectionPoints: ReadonlyArray<ChartPoint>;
  /** Every right-gutter price tag, already resolved against collisions. */
  readonly gutterTags: ReadonlyArray<GutterTag>;
  /**
   * Price bands, placed and clipped, with their chips laid out against the
   * gutter tags above. Empty when the caller passed none.
   */
  readonly zones: ReadonlyArray<ChartZone>;
  /** Scheduled future events, placed on the x axis in the future gutter. */
  readonly timeMarkers: ReadonlyArray<ChartTimeMarker>;
  /** Events that already happened, placed inside the drawn window. */
  readonly pastMarkers: ReadonlyArray<ChartPastMarker>;
  /** Event occurrences as placed bands, clipped to the plot. */
  readonly timeBands: ReadonlyArray<ChartTimeBand>;
  /**
   * Researched event occurrences, placed on the time axis. Uncovered inputs
   * (`covered: false`) never appear here — nothing is drawn for them.
   */
  readonly researchMarkers: ReadonlyArray<ChartResearchMarker>;
  /**
   * The research study overlay, placed. Null when the caller passed none;
   * pieces the window could not place (an activation before the first
   * candle) are null rather than pinned, for the same reason an old fill is
   * dropped: a marker at a time it did not happen is worse than none.
   */
  readonly studyOverlay: ChartStudyOverlay | null;
  /** Armed conditions the chart did not draw, so the panel can say how many. */
  readonly droppedConditions: number;
}

/** A future moment the plan is committed to, drawn as a vertical rule. */
export interface ChartTimeMarker {
  readonly key: string;
  readonly label: string;
  /** Epoch millis the marker sits at. */
  readonly at: number;
  /** ViewBox x, clamped into the future gutter. */
  readonly x: number;
  /** True when the moment has passed but the event has not fired yet. */
  readonly overdue: boolean;
  /**
   * Who put this moment on the axis: the runtime's staleness floor (`auto`) or
   * the plan itself. Carried through untouched — the geometry has no opinion on
   * it, the renderer draws the two differently. Defaults to `planned` so a
   * caller that does not distinguish them gets the pre-existing treatment.
   */
  readonly tone: ChartTimeMarkerTone;
}

/**
 * An event occurrence the chart draws as a vertical band behind the price.
 *
 * Input shape: `startAt`/`endAt` in epoch millis, and `upcoming` when the
 * occurrence has not ended yet, so the renderer can draw the not-yet-happened
 * in the hypothetical register the future gutter already owns.
 */
export interface ChartTimeBandInput {
  readonly key: string;
  readonly label: string;
  readonly startAt: number;
  readonly endAt: number;
  readonly upcoming: boolean;
}

/** A band the geometry has placed: viewBox x positions, clipped to the plot. */
export interface ChartTimeBand {
  readonly key: string;
  readonly label: string;
  readonly startAt: number;
  readonly endAt: number;
  readonly upcoming: boolean;
  /** Left edge, never left of the plot. */
  readonly x1: number;
  /** Right edge, never right of the plot. */
  readonly x2: number;
  /** x2 - x1, at least the visible minimum a zero-width occurrence still gets. */
  readonly width: number;
}

/** A band narrower than this reads as nothing at all, so it never goes below. */
export const MIN_EVENT_BAND_WIDTH = 3;

/**
 * One researched event occurrence from a published scene, drawn on the live
 * price graph at its exact saved instant.
 *
 * The scene-derived seam into the chart, deliberately separate from
 * `ChartTimeBandInput` (the thesis `eventBands` the calendar of a validation
 * uses): a research marker is a fact about a wall-clock moment with its own
 * provenance, not a trade and not part of any thesis. `startAt === endAt`
 * means an instantaneous activation (a network upgrade) and draws a vertical
 * rule at the exact millisecond; a genuine multi-instant span draws a band.
 * `covered` false means the occurrence predates the recorded archive — the
 * chart must say so, never invent a position at the left edge. `upcoming`
 * places the next future occurrence in the existing bounded future gutter.
 */
export interface ChartResearchMarkerInput {
  readonly key: string;
  /** The saved occurrence label, e.g. "Dencun". */
  readonly label: string;
  readonly startAt: number;
  readonly endAt: number;
  /** The occurrence's single authoritative source URL, linked in the detail. */
  readonly sourceUrl: string;
  readonly covered: boolean;
  readonly upcoming: boolean;
}

/**
 * A research occurrence the geometry has placed on the time axis.
 *
 * `covered: false` inputs never reach this shape — the geometry draws nothing
 * for them rather than fabricating a position at the left edge. An
 * instantaneous occurrence keeps `x1 === x2` at the EXACT x of its saved
 * millisecond; nothing about label stacking may move a rule. A genuine span
 * (`endAt > startAt`) is clipped to the plot like an event band. An upcoming
 * occurrence is clamped into the future gutter, never beyond it.
 */
export interface ChartResearchMarker {
  readonly key: string;
  readonly label: string;
  readonly startAt: number;
  readonly endAt: number;
  readonly sourceUrl: string;
  readonly upcoming: boolean;
  /** True when the occurrence is a genuine span, not an instant. */
  readonly span: boolean;
  /** The rule's x (instantaneous), or the band's left edge (span). */
  readonly x1: number;
  /** The band's right edge (span); equal to `x1` for an instantaneous rule. */
  readonly x2: number;
  /** Where the marker's label sits, after the stacking pass. */
  readonly labelY: number;
}

/**
 * The one sentence every research marker is disclosed by, on the axis and in
 * the detail. Wording is fixed here so no renderer can drift into calling a
 * researched measurement a trade.
 */
export const RESEARCH_MARKER_NOTE = "Researched event — historical measurement, not a trade";

/** Only http(s) links are links; anything else is prose, never an href. */
export function isHttpSourceUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/**
 * An instant as the research register writes it: exact UTC date and time,
 * e.g. `2024-03-13 13:00 UTC`. Seconds are included only when the saved
 * instant has them, so a whole-minute activation reads as one.
 */
export function formatUtcInstant(at: number): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number): string => String(value).padStart(2, "0");
  const datePart = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(
    date.getUTCDate(),
  )}`;
  const timePart =
    date.getUTCSeconds() === 0
      ? `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`
      : `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
  return `${datePart} ${timePart} UTC`;
}

/**
 * The accessible sentence a research marker carries: the occurrence's name,
 * its exact UTC instant, the not-a-trade wording, and — only for http(s)
 * URLs — the source. Accepts the placed marker or the raw input; both carry
 * the fields it reads.
 */
export function researchMarkerAriaLabel(marker: {
  readonly label: string;
  readonly startAt: number;
  readonly sourceUrl: string;
}): string {
  const source = isHttpSourceUrl(marker.sourceUrl) ? ` Source: ${marker.sourceUrl}.` : "";
  return `${marker.label} at ${formatUtcInstant(marker.startAt)}. ${RESEARCH_MARKER_NOTE}.${source}`;
}

/**
 * Stack research marker labels into rows when their markers sit close on the
 * time axis, so two occurrences a few minutes apart still print two readable
 * lines. Every label keeps its marker's true x; only the y stacks, downward
 * from the top of the frame in fixed rows. Returns each key's label y.
 */
export function layoutResearchMarkerLabels(
  labels: ReadonlyArray<{ readonly key: string; readonly text: string; readonly x: number }>,
  options: {
    /** Estimated width of one character, in viewBox units. */
    readonly charWidth: number;
    /** Vertical distance between two stacked rows, in viewBox units. */
    readonly rowStep: number;
    /** The first row's y, in viewBox units. */
    readonly topY: number;
    readonly frameHeight: number;
  },
): ReadonlyMap<string, number> {
  /** Each row's rightmost occupied x, in drawing order by x. */
  const rowEnds: number[] = [];
  const ys = new Map<string, number>();
  const sorted = [...labels].sort((a, b) => a.x - b.x || a.key.localeCompare(b.key));
  for (const label of sorted) {
    const width = Math.max(1, label.text.length) * options.charWidth;
    let row = rowEnds.findIndex((end) => label.x >= end);
    if (row < 0) {
      row = rowEnds.length;
      rowEnds.push(label.x + width);
    } else {
      rowEnds[row] = label.x + width;
    }
    // A pathological pile of near-identical instants must still label inside
    // the frame: the last row absorbs whatever does not fit above it.
    const maxRow = Math.max(
      0,
      Math.floor((options.frameHeight - options.topY - 2) / options.rowStep),
    );
    ys.set(label.key, options.topY + Math.min(row, maxRow) * options.rowStep);
  }
  return ys;
}

/**
 * One historical study's overlay on a research window: the activation the
 * study anchored on, the measured entry and exit, and the signed return
 * between them.
 *
 * Research-only vocabulary, deliberately separate from the fill markers: a
 * fill is a record of an execution that happened, these are measurements of
 * a counterfactual on archived bars. Nothing here may read as a trade, and
 * the renderer draws them in their own register (rules, outlines, dashed
 * connectors) so it cannot.
 */
export interface ChartStudyOverlayInput {
  /** The activation instant, ruled vertically and named with its own label. */
  readonly activation: { readonly at: number; readonly label: string } | null;
  /** The measured entry; `label` is the caller's short caption ("study entry"). */
  readonly entry: { readonly at: number; readonly price: number; readonly label: string } | null;
  /** The measured exit; `label` names the horizon ("study exit after 30 bars"). */
  readonly exit: { readonly at: number; readonly price: number; readonly label: string } | null;
  /** The signed return the connector between entry and exit carries. */
  readonly returnPct: number | null;
}

/** A study overlay the geometry has placed; null pieces were absent or out of window. */
export interface ChartStudyOverlay {
  readonly activation: { readonly at: number; readonly label: string; readonly x: number } | null;
  readonly entry: {
    readonly at: number;
    readonly price: number;
    readonly label: string;
    readonly x: number;
    readonly y: number;
  } | null;
  readonly exit: {
    readonly at: number;
    readonly price: number;
    readonly label: string;
    readonly x: number;
    readonly y: number;
  } | null;
  /** The connector between placed entry and exit points, when both placed. */
  readonly returnSpan: {
    readonly x1: number;
    readonly y1: number;
    readonly x2: number;
    readonly y2: number;
    readonly returnPct: number;
  } | null;
}

/** @see ChartTimeMarker.tone */
export type ChartTimeMarkerTone = "auto" | "planned";

/** How many past ticks the axis holds before it stops drawing them. */
export const MAX_DRAWN_PAST_MARKERS = 20;

/**
 * Something that already happened, placed on the time axis — plan 24 §4.2.
 *
 * The mirror of {@link ChartTimeMarker}: that one stands in the future gutter
 * for a moment the plan is committed to, this one stands in the drawn window
 * for a moment that has been. A wake, a publish, a stop move — the chart is
 * then a record of the mission's turns and not only of its price.
 */
export interface ChartPastMarker {
  readonly key: string;
  readonly kind: string;
  /** Epoch millis the event happened at. */
  readonly at: number;
  /** ViewBox x, inside the drawn window. */
  readonly x: number;
  /** A wake's cause, for colour-coding by trigger class. */
  readonly cause?: string;
  /** True when the run this marker stands for did not complete. */
  readonly failed?: boolean;
  /**
   * The event's own composed sentence, carried from the timeline row.
   *
   * The projection has always shipped it and the rug always dropped it, so a
   * tick's only name was its kind and its clock time - "wake at 14:32" for
   * every one of twenty ticks, which is a rug of moments with nothing to say
   * about any of them. The renderer draws it on hover and focus.
   */
  readonly label?: string;
}

/** Input shape for {@link computeChartGeometry}. */
export interface ComputeChartGeometryInput {
  // `open` is optional so a series that carries only closes still draws its
  // line; the candle bodies are simply left out of `bars` for those.
  readonly candles: ReadonlyArray<{
    readonly openTime: number;
    readonly open?: number;
    readonly close: number;
    readonly high: number;
    readonly low: number;
  }>;
  readonly entryPrice: number | null;
  readonly stopPrice: number | null;
  readonly targetPrice: number | null;
  readonly liquidationPrice: number | null;
  /** Epoch millis; splits the line into pre/post segments. */
  readonly entryTime: number | null;
  readonly markPrice: number | null;
  /**
   * Armed price conditions, drawn while the mission is flat and waiting. The
   * four nearest the mark are drawn; the rest are counted in
   * `droppedConditions` for the panel to report as text.
   */
  readonly conditions?: ReadonlyArray<ChartCondition>;
  /**
   * The mission's fills, drawn as markers on the axis.
   *
   * This is how a closed position stays on the chart: its open and its close are
   * two points in the series, and they remain there after the position itself is
   * gone. Only the ones inside the drawn window survive `computeChartGeometry`.
   */
  readonly fills?: ReadonlyArray<ChartFillMarker>;
  /**
   * An order the agent has committed to but the book has not filled — the
   * "I will enter long at X" the plan just announced, as a level rather than as
   * a sentence somewhere else on the screen.
   */
  readonly pendingOrder?: { readonly price: number; readonly side: "buy" | "sell" } | null;
  /**
   * Wall-clock now, in epoch millis. Turns the x axis into a clock.
   *
   * Omitted, the axis ends at the last candle's openTime — which means the
   * chart only moves when a bar closes, so a 1m series is frozen for 59 seconds
   * at a time and the mark dot sits on top of the final candle. Supplied, the
   * axis ends at `now`, the series slides continuously, and the space between
   * the last close and the mark is the bar currently forming.
   *
   * The review chart must NOT pass this: its window is closed, and its "mark"
   * is an exit that happened, not a price that is moving.
   */
  readonly nowMillis?: number;
  /**
   * When the armed entry triggers stop being the plan the mission is running,
   * in epoch millis — the plan's own `reassess` horizon.
   *
   * The trigger rules are projected into the future gutter only this far. A
   * level drawn all the way to the frame edge claims the mission will still be
   * watching it then, and an untriggered plan stops being the plan at its
   * reassessment. Omitted (or without `nowMillis`), triggers project like every
   * other level.
   */
  readonly triggerExpiryAt?: number;
  /** Future moments to mark on the axis. Ignored without `nowMillis`. */
  readonly timeMarkers?: ReadonlyArray<{
    readonly key: string;
    readonly label: string;
    readonly at: number;
    readonly tone?: ChartTimeMarkerTone;
  }>;
  /**
   * The plan's published estimate of where price is headed: a price and the
   * moment it is expected by. Drawn as a dotted path from the live mark into
   * the future gutter — a claim, in the hypothetical register, never part of
   * the record. Ignored without `nowMillis` (the review chart has no future).
   */
  readonly projection?: { readonly price: number; readonly atMillis: number } | null;
  /**
   * Moments that have already happened, newest-first as the projection sends
   * them. Placed inside the drawn window; anything older than the first candle
   * is dropped rather than pinned to the left edge, for the same reason an old
   * fill is.
   */
  readonly pastMarkers?: ReadonlyArray<{
    readonly key: string;
    readonly kind: string;
    readonly at: number;
    readonly cause?: string | undefined;
    readonly failed?: boolean | undefined;
    readonly label?: string | undefined;
  }>;
  /**
   * Event occurrences to draw as vertical bands behind the price. Unlike every
   * marker above, a band claims a SPAN of wall-clock time rather than a moment,
   * and unlike the paper trades it is interval-agnostic: the occurrence
   * happened at those times whatever bar size the chart is drawn on. Upcoming
   * bands may sit past `now`, in the future gutter.
   */
  readonly eventBands?: ReadonlyArray<ChartTimeBandInput>;
  /**
   * Researched event occurrences from the thread's active scene, drawn at
   * their exact saved instants (rule) or spans (band). Separate from
   * `eventBands`: these carry research provenance and never render as a
   * fill, order, or execution. An occurrence the archive does not cover
   * (`covered: false`) draws nothing — the caller reports it in prose.
   */
  readonly researchMarkers?: ReadonlyArray<ChartResearchMarkerInput>;
  /**
   * One historical study's overlay on this window (research charts only):
   * activation rule, measured entry and exit, signed return connector.
   * Placed like the fills, with its own vocabulary; never drawn as a fill.
   */
  readonly studyOverlay?: ChartStudyOverlayInput | null;
  /**
   * Price bands to wash across the plot. Generic: the geometry places them and
   * has no opinion on what any of them means. @see ChartZoneInput
   */
  readonly zones?: ReadonlyArray<ChartZoneInput>;
}

/**
 * Derive the target price from the strategy's planned profit and the size.
 *
 * Long (size > 0): target sits ABOVE entry — entry + profit/|size|.
 * Short (size < 0): target sits BELOW entry — entry - profit/|size|.
 * The sign of `size` decides direction; `targetProfitUsd` is always a
 * magnitude.
 *
 * Null when the size cannot name a real price. A zero size divides by zero,
 * and a size winding down toward zero is worse than that: the offset diverges
 * smoothly, so the number stays finite and plausible right up until it is
 * absurd. Seen live on a mission whose agent had scaled a short down to
 * 0.0001 ETH against a planned $8 — the panel and the heartbeat both offered
 * to bank the trade at -77,661.33.
 *
 * A price below zero is not a price, so the caller is told there is no target
 * rather than given a fabricated one, and the sentence drops its clause the
 * way it drops any other missing number.
 */
export function deriveTargetPrice(
  entryPrice: number,
  targetProfitUsd: number,
  size: number,
): number | null {
  const magnitude = Math.abs(size);
  if (magnitude === 0) return null;
  const offset = targetProfitUsd / magnitude;
  const target = size > 0 ? entryPrice + offset : entryPrice - offset;
  return Number.isFinite(target) && target > 0 ? target : null;
}

/**
 * Progress of the live mark toward the target, 0-100.
 *
 * The single formula works for BOTH directions: a short's target < entry, so
 * when the short is profitable both numerator (mark - entry) and denominator
 * (target - entry) are negative and the ratio is positive. Clamped to [0, 100]
 * so a retraced or blown-past target reads as the endpoint, not beyond it.
 *
 * Returns 0 when `target === entry` (no distance to cover — division by zero
 * guard) — the chart's "you have arrived" reading already lives elsewhere.
 */
export function deriveProgressToTarget(mark: number, entry: number, target: number): number {
  if (target === entry) return 0;
  const ratio = ((mark - entry) / (target - entry)) * 100;
  if (!Number.isFinite(ratio)) return 0;
  return Math.max(0, Math.min(100, ratio));
}

/**
 * Find the entry fill's timestamp, for the hold-time display.
 *
 * Looks for the NEWEST fill whose `readFillLifecycle(direction)?.action ===
 * "open"` and returns its `tradedAt` as epoch millis. Reversals and closes do
 * not count — the hold clock starts at the open that established the current
 * exposure. Null when no open fill qualifies or when every fill's direction is
 * unreadable.
 */
export function deriveEntryFillAtMillis(
  fills: ReadonlyArray<{ readonly direction?: string | undefined; readonly tradedAt: string }>,
): number | null {
  let newest: number | null = null;
  for (const fill of fills) {
    const lifecycle = readFillLifecycle(fill.direction);
    if (lifecycle === null || lifecycle.action !== "open") continue;
    const ms = Date.parse(fill.tradedAt);
    if (Number.isNaN(ms)) continue;
    if (newest === null || ms > newest) {
      newest = ms;
    }
  }
  return newest;
}

/**
 * The fewest bars the live window is allowed to show (final-form phase 6).
 *
 * A real trading chart's window is 60–120 bars: enough that structure —
 * a trend, a range, the swing a stop hides behind — is on screen, not just
 * the last few minutes of tape. The floor lives here with the windowing
 * function rather than at each call site, so no caller can narrow the chart
 * below a readable window; a caller asking for MORE than this is honoured.
 */
export const MIN_VISIBLE_BARS = 60;

/**
 * The tail of a fetched series to draw, widened to keep a moment in frame.
 *
 * The live chart draws fewer bars than it fetches, for resolution. That crops
 * history, and history is where the session's earlier fills are — an entry from
 * ninety minutes ago would fall off a sixty-bar window and take its marker with
 * it, which is precisely the record the markers exist to keep. So the window
 * starts at `visibleBars` (floored at {@link MIN_VISIBLE_BARS}) and widens, up
 * to everything fetched, until the earliest moment that must stay visible is
 * inside it.
 *
 * `earliestNeeded` of null (no fills yet) leaves the plain tail.
 */
export function selectVisibleCandles<T extends { readonly openTime: number }>(
  candles: ReadonlyArray<T>,
  visibleBars: number,
  earliestNeeded: number | null,
): ReadonlyArray<T> {
  const tailStart = Math.max(0, candles.length - Math.max(visibleBars, MIN_VISIBLE_BARS));
  if (earliestNeeded === null) return candles.slice(tailStart);

  // The bar the moment falls in, minus one for a little approach context.
  let index = candles.findIndex((candle) => candle.openTime >= earliestNeeded);
  if (index < 0) index = candles.length - 1;
  const wanted = Math.max(0, index - 1);

  return candles.slice(Math.min(tailStart, wanted));
}

/**
 * The series' own bar interval, as the median gap between consecutive opens.
 *
 * The median rather than the mean, and rather than the first gap: a feed with
 * one missing bar has a gap of two intervals in it, and either of the other two
 * readings would take that hole for the pitch of the whole series. Falls back
 * to one minute when there is nothing to measure — the interval every mission
 * defaults to.
 */
export function medianBarInterval(candles: ReadonlyArray<{ readonly openTime: number }>): number {
  const gaps: number[] = [];
  for (let index = 1; index < candles.length; index += 1) {
    const gap = candles[index]!.openTime - candles[index - 1]!.openTime;
    if (gap > 0) gaps.push(gap);
  }
  if (gaps.length === 0) return 60_000;
  gaps.sort((left, right) => left - right);
  return gaps[Math.floor(gaps.length / 2)]!;
}

/** Hold a value inside `[min, max]`. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * The candle window's own range, before any level is considered.
 *
 * Everything else about the y-domain is decided against this: a level within
 * reach of it joins the domain, a level beyond it is pinned at an edge.
 */
function candleBounds(candles: ReadonlyArray<{ readonly high: number; readonly low: number }>): {
  readonly min: number;
  readonly max: number;
} {
  let min = candles[0]!.low;
  let max = candles[0]!.high;
  for (const candle of candles) {
    if (candle.low < min) min = candle.low;
    if (candle.high > max) max = candle.high;
  }
  return { min, max };
}

/**
 * The smallest share of the plot's height the candles are allowed to occupy.
 *
 * `DOMAIN_LEVEL_REACH_RATIO` bounds each level individually, which is not the
 * same as bounding what they do together: a stop above the window and a target
 * below it can each be "within reach" and still, between them, flatten an hour
 * of price action into a band a few pixels tall — which is the chart that
 * reads as broken. This is the floor that stops it. A level that would push
 * the candles below it is dropped from the domain and pinned at the frame edge
 * with a chevron, the same idiom a far target already gets.
 */
export const MIN_CANDLE_DOMAIN_SHARE = 0.45;

/**
 * The levels near enough to the price action to anchor the domain.
 *
 * Liquidation is never an anchor (at 20x it is always far), and neither is the
 * mark (it is polled far more often than the candles). Everything else joins
 * only while it sits within `DOMAIN_LEVEL_REACH_RATIO` candle-ranges of the
 * window's midpoint AND leaves the candles at least
 * {@link MIN_CANDLE_DOMAIN_SHARE} of the resulting domain. Nearest first, so
 * the levels closest to the price action are the ones that keep their place.
 */
function collectDomainAnchors(
  candles: ReadonlyArray<{ readonly high: number; readonly low: number }>,
  candidates: ReadonlyArray<number>,
): number[] {
  const bounds = candleBounds(candles);
  const anchors: number[] = [bounds.min, bounds.max];
  const mid = (bounds.min + bounds.max) / 2;
  // A dead-flat window has no range to scale by; fall back to a tenth of a
  // percent of the price so "near" still means something.
  const range = bounds.max - bounds.min || Math.max(1, Math.abs(mid) * 0.001);
  const reach = range * DOMAIN_LEVEL_REACH_RATIO;

  let min = bounds.min;
  let max = bounds.max;
  const nearestFirst = [...candidates].sort(
    (left, right) => Math.abs(left - mid) - Math.abs(right - mid),
  );
  for (const price of nearestFirst) {
    if (Math.abs(price - mid) > reach) continue;
    const nextMin = Math.min(min, price);
    const nextMax = Math.max(max, price);
    const span = nextMax - nextMin;
    if (span > 0 && range / span < MIN_CANDLE_DOMAIN_SHARE) continue;
    min = nextMin;
    max = nextMax;
    anchors.push(price);
  }
  return anchors;
}

/** Hold a set of gutter tags apart, without letting them leave the frame. */
export function layoutGutterLabels<T extends { readonly y: number; readonly priority: number }>(
  labels: ReadonlyArray<T>,
): ReadonlyArray<T & { readonly labelY: number }> {
  if (labels.length === 0) return [];

  // Top to bottom, with the more important tag first among ties: the sweep
  // below preserves this order, so tags never cross their own levels.
  const placed = labels
    .map((label) => ({ ...label, labelY: label.y }))
    .sort((a, b) => a.y - b.y || a.priority - b.priority);

  // Push apart, letting the lower-priority tag of each too-close pair do the
  // moving. A handful of passes settles any realistic set; the clamping sweeps
  // below guarantee the invariant regardless.
  for (let pass = 0; pass < placed.length + 1; pass += 1) {
    let moved = false;
    for (let i = 0; i < placed.length - 1; i += 1) {
      const above = placed[i]!;
      const below = placed[i + 1]!;
      const deficit = GUTTER_LABEL_MIN_SEPARATION - (below.labelY - above.labelY);
      if (deficit <= 0) continue;
      moved = true;
      if (above.priority < below.priority) {
        below.labelY += deficit;
      } else if (below.priority < above.priority) {
        above.labelY -= deficit;
      } else {
        above.labelY -= deficit / 2;
        below.labelY += deficit / 2;
      }
    }
    if (!moved) break;
  }

  // Two sweeps close the loop: forward pushes everything below the top edge
  // apart, backward pulls everything above the bottom edge back in. Both stop
  // an inset short of the frame rather than at it: a tag is centred on its
  // `labelY` and is two lines tall, so one placed exactly on the bottom edge
  // hung its caption over whatever the panel drew underneath the chart — which
  // is where the schedule pills sit.
  const top = GUTTER_LABEL_EDGE_INSET;
  const bottom = CHART_VIEWBOX_HEIGHT - GUTTER_LABEL_EDGE_INSET;
  for (const tag of placed) {
    tag.labelY = clamp(tag.labelY, top, bottom);
  }
  for (let i = 1; i < placed.length; i += 1) {
    const previous = placed[i - 1]!;
    const current = placed[i]!;
    current.labelY = Math.max(current.labelY, previous.labelY + GUTTER_LABEL_MIN_SEPARATION);
  }
  // The forward sweep can push the bottom tag past the edge, and the backward
  // sweep below starts at the second-to-last — so the last one has to be
  // pulled in first or it is the one tag nothing ever bounds.
  const last = placed[placed.length - 1];
  if (last !== undefined) last.labelY = Math.min(last.labelY, bottom);
  for (let i = placed.length - 2; i >= 0; i -= 1) {
    const next = placed[i + 1]!;
    const current = placed[i]!;
    current.labelY = Math.min(
      current.labelY,
      Math.min(next.labelY - GUTTER_LABEL_MIN_SEPARATION, bottom),
    );
  }
  // The backward sweep can only pull upward, so the last clamp is the one that
  // guarantees the top edge as well.
  for (const tag of placed) {
    tag.labelY = Math.max(tag.labelY, top);
  }

  return placed;
}

// ---------------------------------------------------------------------------
// the unified left-axis lane
// ---------------------------------------------------------------------------
//
// The left of the plot used to carry TWO independent label placements — the
// grid prices above their rules, the session levels below theirs — and each
// was internally collision-free while the two of them printed on top of each
// other at the same left edge. One pass over every left-axis label fixes the
// overlap at its source: the RULES keep their exact y, the labels share one
// lane, and a label that cannot be placed legibly is suppressed — never its
// rule.

/** One label candidate for the unified left-axis lane, before collision. */
export interface LeftAxisLabelEntry {
  readonly id: string;
  /** The visible text, used to deduplicate equal or near-equal prices. */
  readonly text: string;
  /** The label's true y — its rule's y, in viewBox units. */
  readonly y: number;
  /**
   * Lower wins. The frozen order: 0 the current-price readout while one is
   * drawn on the left axis (a live drag), 1 a named session level, 2 an
   * ordinary grid tick. Higher-priority labels are placed first and never
   * move for a lower-priority one.
   */
  readonly priority: number;
}

/** The unified lane's decision for one entry. */
export interface LeftAxisLabelPlacement {
  readonly id: string;
  readonly y: number;
}

/** The lane's result: where each surviving label sits, and what was hidden. */
export interface LeftAxisLayoutResult {
  readonly placed: ReadonlyArray<LeftAxisLabelPlacement>;
  /** Entries with no label: duplicates, and those that could not fit. */
  readonly suppressed: ReadonlySet<string>;
}

/** Tolerance for the float comparisons the lane's arithmetic makes. */
const LEFT_AXIS_EPSILON = 1e-9;

/**
 * Lay out every left-axis label in one collision-aware pass.
 *
 * Same visible text collapses to one label (the more important entry's
 * position wins). Survivors are then placed in priority order at their own y
 * wherever that is legible, else at the nearest legible y within `maxNudge`
 * of it, else not at all: a lower-priority label that cannot be placed is
 * suppressed rather than overlapped, and its rule is never touched. Labels
 * are held half a separation inside the frame so a centred line of text
 * cannot clip over the chart's edge.
 */
export function layoutLeftAxisLabels(input: {
  readonly entries: ReadonlyArray<LeftAxisLabelEntry>;
  readonly frameHeight: number;
  /** Minimum vertical distance between two placed labels, in viewBox units. */
  readonly minSeparation: number;
  /** How far a label may move from its rule, in viewBox units. */
  readonly maxNudge: number;
}): LeftAxisLayoutResult {
  const suppressed = new Set<string>();
  if (input.entries.length === 0) return { placed: [], suppressed };

  // One label per distinct visible text: two entries printing the same
  // number are one fact, and nudging them apart would only make the axis
  // look like it has more levels than it has.
  const byText = new Map<string, LeftAxisLabelEntry>();
  for (const entry of input.entries) {
    const existing = byText.get(entry.text);
    if (existing === undefined) {
      byText.set(entry.text, entry);
      continue;
    }
    const winner = entry.priority < existing.priority ? entry : existing;
    suppressed.add((winner === entry ? existing : entry).id);
    byText.set(entry.text, winner);
  }

  // Most important first, top to bottom within a priority: the sweep below
  // never revisits a placed label, so this order IS the priority order.
  const order = [...byText.values()].sort(
    (a, b) => a.priority - b.priority || a.y - b.y || a.id.localeCompare(b.id),
  );

  const inset = input.minSeparation / 2;
  const placed: LeftAxisLabelPlacement[] = [];
  const placedYs: number[] = [];

  for (const entry of order) {
    const lower = Math.max(entry.y - input.maxNudge, inset);
    const upper = Math.min(entry.y + input.maxNudge, input.frameHeight - inset);
    if (upper < lower - LEFT_AXIS_EPSILON) {
      suppressed.add(entry.id);
      continue;
    }

    // Candidate positions: the true y, the two ends of the nudge range, and
    // one clear separation outside every placed label. The closest candidate
    // to the true y wins (ties break downward), so a label drifts from its
    // rule only as far as it must.
    placedYs.sort((a, b) => a - b);
    const candidates = [entry.y, lower, upper];
    for (const y of placedYs) {
      candidates.push(y + input.minSeparation, y - input.minSeparation);
    }
    let best: number | null = null;
    for (const candidate of candidates) {
      if (candidate < lower - LEFT_AXIS_EPSILON || candidate > upper + LEFT_AXIS_EPSILON) continue;
      if (placedYs.some((y) => Math.abs(candidate - y) < input.minSeparation - LEFT_AXIS_EPSILON)) {
        continue;
      }
      if (
        best === null ||
        Math.abs(candidate - entry.y) < Math.abs(best - entry.y) - LEFT_AXIS_EPSILON ||
        (Math.abs(candidate - entry.y) < Math.abs(best - entry.y) + LEFT_AXIS_EPSILON &&
          candidate > best)
      ) {
        best = candidate;
      }
    }
    if (best === null) {
      suppressed.add(entry.id);
      continue;
    }
    placed.push({ id: entry.id, y: best });
    placedYs.push(best);
  }

  placed.sort((a, b) => a.y - b.y);
  return { placed, suppressed };
}

/**
 * The coarsest decimal count a grid step supports: fewest digits that render
 * every tick of the step distinctly. `2,420`, `2,420.5`, `2,420.51` are then
 * mixed only when the spacing itself demands it. Ticks are aligned to the
 * step, so the step's own decimals are sufficient whatever the asset's
 * magnitude — a $0.000002 step gets six digits and a $50 step gets none.
 */
export function gridPriceDecimals(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 2;
  for (let decimals = 0; decimals <= 8; decimals += 1) {
    const scaled = step * 10 ** decimals;
    if (scaled >= 1 - LEFT_AXIS_EPSILON && Math.abs(scaled - Math.round(scaled)) < 1e-6) {
      return decimals;
    }
  }
  return 8;
}

/**
 * A grid price at exactly the step's precision, grouped like every other
 * price on the chart. Minimum AND maximum fraction digits agree, so two
 * ticks of one scale always print the same shape.
 */
export function formatGridPrice(price: number, decimals: number): string {
  return price.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** The grid's default rule count on an unmeasured or roomy frame. */
export const DEFAULT_GRID_TARGET_LINES = 4;

/**
 * How many grid rules the frame can honestly carry, from its measured
 * rendered width. Narrow frames reduce the TICK COUNT — never the 10px/9px
 * type, which is the smallest this chart reads at.
 */
export function gridTickTarget(renderedWidthPx: number): number {
  if (!Number.isFinite(renderedWidthPx) || renderedWidthPx <= 0) {
    return DEFAULT_GRID_TARGET_LINES;
  }
  if (renderedWidthPx < 360) return 2;
  if (renderedWidthPx < 560) return 3;
  return DEFAULT_GRID_TARGET_LINES;
}

/**
 * Which tag wins when two would overlap. Lower is more important.
 *
 * The mark is what the operator is reading right now; the entry is what every
 * other number is measured from. A condition is the least urgent of the set —
 * it is a level nothing has reached yet.
 */
const GUTTER_PRIORITY: Record<ChartLevelKind | "mark", number> = {
  mark: 0,
  entry: 1,
  stop: 2,
  target: 3,
  // A pending order outranks the conditions: it is the one level something is
  // already committed to, rather than a level that would cause a decision.
  pending_buy: 4,
  pending_sell: 4,
  liquidation: 5,
  condition_above: 6,
  condition_below: 6,
};

/**
 * Where a zone's chip sits in the same contest. Below every level.
 *
 * A band is a range, so its chip has a whole band's height to be nudged inside
 * before it stops pointing at its own subject - which is exactly the property
 * that makes it the right thing to move when a stop chip and a zone chip want
 * the same eighteen units of gutter.
 */
const GUTTER_ZONE_PRIORITY = 7;

/**
 * Place the price bands, then lay their chips out against the level tags.
 *
 * One pass, not two: a zone chip and a stop chip in the same price region are
 * competing for the same gutter, and two independent collision passes would
 * each be satisfied while the two chips sat on top of each other. So both go
 * into `layoutGutterLabels` together and the result is split back apart.
 */
function buildZonesAndTags(input: {
  readonly zones: ReadonlyArray<ChartZoneInput>;
  readonly levels: ReadonlyArray<ChartLevel>;
  readonly markPoint: ChartPoint | null;
  readonly markPrice: number | null;
  readonly yForPrice: (price: number) => number;
  readonly domainMin: number;
  readonly domainMax: number;
}): { readonly zones: ReadonlyArray<ChartZone>; readonly gutterTags: ReadonlyArray<GutterTag> } {
  const placed = input.zones.map((zone) => {
    // Written low-then-high whatever order the caller passed them in: a band is
    // a range, and a caller that swapped its own endpoints still means one.
    const low = Math.min(zone.priceLow, zone.priceHigh);
    const high = Math.max(zone.priceLow, zone.priceHigh);
    const offScale: "above" | "below" | null =
      low > input.domainMax ? "above" : high < input.domainMin ? "below" : null;
    // Clipped, not clamped: a band that runs off the top of the frame is drawn
    // from the top edge down to where it ends, which is the true picture of
    // the part of it the reader can see.
    const topY = clamp(input.yForPrice(high), 0, CHART_VIEWBOX_HEIGHT);
    const bottomY = clamp(input.yForPrice(low), 0, CHART_VIEWBOX_HEIGHT);
    const height = offScale === null ? Math.max(0, bottomY - topY) : 0;
    return {
      zone,
      low,
      high,
      offScale,
      y: topY,
      height,
      // Mid-band, so the chip names the range rather than one of its edges. An
      // off-scale band has no visible middle, so its chip docks at the edge it
      // is beyond, exactly where an off-scale level's does.
      anchorY:
        offScale === null ? (topY + bottomY) / 2 : offScale === "above" ? 0 : CHART_VIEWBOX_HEIGHT,
    };
  });

  const levelCandidates = gutterCandidates(input.levels, input.markPoint, input.markPrice);
  const zoneCandidates = placed.map((entry, index) => ({
    key: `zone-${index}`,
    y: entry.anchorY,
    priority: GUTTER_ZONE_PRIORITY,
  }));

  const laid = layoutGutterLabels([
    ...levelCandidates.map((candidate) => ({ ...candidate, isZone: false as const })),
    ...zoneCandidates.map((candidate) => ({ ...candidate, isZone: true as const })),
  ]);

  const zoneLabelYs = new Map<string, number>();
  for (const entry of laid) {
    if (entry.isZone) zoneLabelYs.set(entry.key, entry.labelY);
  }

  return {
    zones: placed.map((entry, index) => ({
      key: entry.zone.key,
      label: entry.zone.label,
      priceLow: entry.low,
      priceHigh: entry.high,
      tone: entry.zone.tone,
      register: entry.zone.register,
      y: entry.y,
      height: entry.height,
      labelY: zoneLabelYs.get(`zone-${index}`) ?? entry.anchorY,
      offScale: entry.offScale,
    })),
    gutterTags: laid
      .filter((entry) => !entry.isZone)
      .map(({ priority: _priority, isZone: _isZone, ...tag }) => tag as GutterTag),
  };
}

/**
 * The gutter's tag candidates, before any collision pass.
 *
 * Split out from the layout so the zone chips can be laid out in the SAME pass
 * as these (see `buildZonesAndTags`): two passes would each be internally
 * consistent and still let a zone chip land on top of a stop chip.
 *
 * The entry/mark merge is handled here, before the layout runs: two tags a few
 * units apart reading nearly the same price are one fact, not two, and nudging
 * them apart only makes the chart look like it has more levels than it has.
 */
function gutterCandidates(
  levels: ReadonlyArray<ChartLevel>,
  markPoint: ChartPoint | null,
  markPrice: number | null,
) {
  const entry = levels.find((level) => level.kind === "entry") ?? null;
  const mergeEntry =
    entry !== null &&
    markPoint !== null &&
    markPrice !== null &&
    Math.abs(entry.y - markPoint.y) < GUTTER_LABEL_MERGE_DISTANCE;

  const candidates: Array<{
    readonly key: string;
    readonly kind: ChartLevelKind | "mark";
    readonly y: number;
    readonly price: number;
    readonly offScale: "above" | "below" | null;
    readonly met?: boolean;
    readonly mergedPrice?: number;
    readonly count?: number;
    readonly id?: string;
    readonly label?: string;
    readonly register?: ChartRegister;
    readonly priority: number;
  }> = [];

  if (markPoint !== null && markPrice !== null) {
    candidates.push({
      key: "mark",
      kind: "mark",
      y: markPoint.y,
      price: markPrice,
      offScale: null,
      ...(mergeEntry && entry !== null ? { mergedPrice: entry.price } : {}),
      priority: GUTTER_PRIORITY.mark,
    });
  }

  levels.forEach((level, index) => {
    if (mergeEntry && level.kind === "entry") return;
    candidates.push({
      key: `${level.kind}-${index}`,
      kind: level.kind,
      y: level.y,
      price: level.price,
      offScale: level.offScale,
      ...(level.met === undefined ? {} : { met: level.met }),
      ...(level.count === undefined ? {} : { count: level.count }),
      ...(level.id === undefined ? {} : { id: level.id }),
      ...(level.label === undefined ? {} : { label: level.label }),
      ...(level.register === undefined ? {} : { register: level.register }),
      priority: GUTTER_PRIORITY[level.kind],
    });
  });

  return candidates;
}

/**
 * Place one exponential moving average across the window.
 *
 * Returns null below two points: a one-point average is a dot, and the pair is
 * only meaningful drawn together, so the caller drops both when either is
 * missing. The series starts `period - 1` bars in (that is where the seed
 * average completes), so it is aligned to the tail of the candle array.
 */
function buildEmaLine(input: {
  readonly candles: ReadonlyArray<{ readonly openTime: number; readonly close: number }>;
  readonly period: number;
  readonly speed: "fast" | "slow";
  readonly xForTime: (t: number) => number;
  readonly yForPrice: (p: number) => number;
}): ChartEmaLine | null {
  const series = exponentialMovingAverage(
    input.candles.map((candle) => candle.close),
    input.period,
  );
  if (series.length < 2) return null;

  const offset = input.candles.length - series.length;
  const points = series.map((value, index) => ({
    x: input.xForTime(input.candles[offset + index]!.openTime),
    y: input.yForPrice(value),
  }));
  return {
    speed: input.speed,
    period: input.period,
    points,
    lastValue: series[series.length - 1]!,
  };
}

/** Build the level list, pinning anything outside the domain to an edge. */
function buildLevels(input: {
  readonly yForPrice: (p: number) => number;
  readonly domainMin: number;
  readonly domainMax: number;
  readonly entryPrice: number | null;
  readonly stopPrice: number | null;
  readonly targetPrice: number | null;
  readonly liquidationPrice: number | null;
  readonly conditions: ReadonlyArray<ChartCondition>;
  readonly pendingOrder: { readonly price: number; readonly side: "buy" | "sell" } | null;
  /** Where a named level's projection ends — the frame's right edge. */
  readonly levelEndX: number;
  /** Where an armed trigger's projection ends. @see ChartLevel.futureEndX */
  readonly triggerEndX: number;
}): ChartLevel[] {
  const levels: ChartLevel[] = [];

  const pushLevel = (
    kind: ChartLevelKind,
    price: number,
    met?: boolean,
    count?: number,
    id?: string,
    extra?: { readonly label?: string | undefined; readonly register?: ChartRegister | undefined },
  ): void => {
    const offScale: "above" | "below" | null =
      price > input.domainMax ? "above" : price < input.domainMin ? "below" : null;
    const isTrigger = kind === "condition_above" || kind === "condition_below";
    levels.push({
      kind,
      price,
      futureEndX: isTrigger ? input.triggerEndX : input.levelEndX,
      // Pinned at the edge when off-scale, so the line and its tag stay on
      // screen and the chevron says which way the real price lies.
      y:
        offScale === "above"
          ? 0
          : offScale === "below"
            ? CHART_VIEWBOX_HEIGHT
            : input.yForPrice(price),
      inFrame: offScale === null,
      offScale,
      ...(met === undefined ? {} : { met }),
      ...(count === undefined || count <= 1 ? {} : { count }),
      ...(id === undefined ? {} : { id }),
      ...(extra?.label === undefined ? {} : { label: extra.label }),
      ...(extra?.register === undefined ? {} : { register: extra.register }),
    });
  };

  if (input.entryPrice !== null) pushLevel("entry", input.entryPrice);
  if (input.stopPrice !== null) pushLevel("stop", input.stopPrice);
  if (input.targetPrice !== null) pushLevel("target", input.targetPrice);

  // Liquidation is the exception: it is never a domain anchor, and a
  // liquidation 10% away on a 20x book is noise rather than a level, so it is
  // drawn only when it happens to fall inside the frame.
  if (input.liquidationPrice !== null) {
    const inFrame =
      input.liquidationPrice >= input.domainMin && input.liquidationPrice <= input.domainMax;
    if (inFrame) pushLevel("liquidation", input.liquidationPrice);
  }

  // An armed condition sitting on a level the chart has already named is that
  // level, not a second one. A profit-target watch resolves to exactly the
  // target price and a stop-proximity watch to the stop, so drawing both put
  // two rules and two identical gutter tags at one price — "1,858.43 target"
  // with "1,858.43 below" written across it. The named level wins: it says
  // what the price IS, which is the more useful of the two statements.
  const named = levels.map((level) => level.price);
  const alreadyNamed = (price: number): boolean =>
    named.some((existing) => Math.abs(existing - price) <= Math.max(Math.abs(price), 1) * 1e-6);

  for (const condition of input.conditions) {
    if (alreadyNamed(condition.price)) continue;
    pushLevel(
      condition.direction === "above" ? "condition_above" : "condition_below",
      condition.price,
      condition.met,
      condition.count,
      condition.id,
      { label: condition.label, register: condition.register },
    );
  }

  if (input.pendingOrder !== null) {
    pushLevel(
      input.pendingOrder.side === "buy" ? "pending_buy" : "pending_sell",
      input.pendingOrder.price,
    );
  }

  return levels;
}

/**
 * The armed conditions worth drawing: the four nearest the mark.
 *
 * A mission can arm a dozen levels across several republishes. Drawing them
 * all turns the plot into a ladder and hides the price line inside it, so the
 * near ones are drawn and the rest are counted.
 */
function selectConditions(input: {
  readonly conditions: ReadonlyArray<ChartCondition>;
  readonly markPrice: number | null;
  readonly candleRange: number;
}): { readonly drawn: ReadonlyArray<ChartCondition>; readonly dropped: number } {
  const reference = input.markPrice ?? input.conditions[0]?.price ?? 0;
  const unique = clusterConditions(
    dedupeConditions(input.conditions),
    input.candleRange * CONDITION_CLUSTER_RANGE_RATIO,
    reference,
  );
  if (unique.length <= MAX_DRAWN_CONDITIONS) return { drawn: unique, dropped: 0 };
  const nearest = [...unique].sort(
    (a, b) => Math.abs(a.price - reference) - Math.abs(b.price - reference),
  );
  // A dropped cluster takes every watch in it with it, so the count the panel
  // reports is watches, not levels.
  const dropped = nearest
    .slice(MAX_DRAWN_CONDITIONS)
    .reduce((total, condition) => total + (condition.count ?? 1), 0);
  return { drawn: nearest.slice(0, MAX_DRAWN_CONDITIONS), dropped };
}

/**
 * Fold conditions closer together than `tolerance` into one drawn level.
 *
 * Clusters only within a direction: an "above" and a "below" watch at the same
 * price are two opposite statements about it, and merging them would lose the
 * one thing the level says. The representative is the member nearest
 * `reference` (the mark) — the price the market reaches first, which is the one
 * worth reading off the axis — and `met` is the OR, as it is in
 * {@link dedupeConditions}.
 */
export function clusterConditions(
  conditions: ReadonlyArray<ChartCondition>,
  tolerance: number,
  reference: number,
): ReadonlyArray<ChartCondition> {
  if (tolerance <= 0) return conditions;

  const clusters: Array<{
    direction: "above" | "below";
    register: ChartRegister;
    members: ChartCondition[];
  }> = [];
  for (const condition of [...conditions].sort((a, b) => a.price - b.price)) {
    const open = clusters[clusters.length - 1];
    const register = condition.register ?? "actual";
    const joins =
      open !== undefined &&
      open.direction === condition.direction &&
      // Never across registers. An armed watch and a thesis's claimed entry
      // can sit a few dollars apart, and merged into one chip the result
      // states one register about both - either that the mission is watching
      // a price nothing is armed on, or that a live watch is only a claim.
      open.register === register &&
      condition.price - open.members[open.members.length - 1]!.price <= tolerance;
    if (joins) {
      open.members.push(condition);
    } else {
      clusters.push({ direction: condition.direction, register, members: [condition] });
    }
  }

  return clusters.map((cluster) => {
    const nearest = cluster.members.reduce((best, member) =>
      Math.abs(member.price - reference) < Math.abs(best.price - reference) ? member : best,
    );
    return {
      price: nearest.price,
      direction: cluster.direction,
      met: cluster.members.some((member) => member.met),
      count: cluster.members.reduce((total, member) => total + (member.count ?? 1), 0),
      // The representative member's watch id, so the cluster's chip still
      // selects its row in the watch stream.
      ...(nearest.id === undefined ? {} : { id: nearest.id }),
      // And its caption and register: a cluster that dropped them rendered a
      // thesis's entry rule as an anonymous armed level, which is the one
      // thing the hypothetical register exists to prevent.
      ...(nearest.label === undefined ? {} : { label: nearest.label }),
      ...(nearest.register === undefined ? {} : { register: nearest.register }),
    };
  });
}

/**
 * One rule per price and direction, however many watches point at it.
 *
 * A plan that arms both a `price_cross` and a `candle_close` at the same level
 * — which the doctrine asks for at a trigger it wants confirmed — produced two
 * identical rules and two identical gutter tags stacked on top of each other,
 * reading as two levels when the mission is watching one. The checklist below
 * the chart still lists both, because there the difference between a touch and
 * a close is the point; on a price axis it has no y of its own.
 *
 * `met` is the OR: if any watch at the price has fired, the level has been
 * reached.
 */
export function dedupeConditions(
  conditions: ReadonlyArray<ChartCondition>,
): ReadonlyArray<ChartCondition> {
  const byLevel = new Map<string, ChartCondition>();
  for (const condition of conditions) {
    const key = `${condition.direction}:${condition.price}`;
    const existing = byLevel.get(key);
    if (existing === undefined) {
      byLevel.set(key, condition);
      continue;
    }
    if (condition.met && !existing.met) byLevel.set(key, condition);
  }
  return [...byLevel.values()];
}

// ---------------------------------------------------------------------------
// research markers: placement
// ---------------------------------------------------------------------------

/** One row of stacked research labels: a 9px line plus a hair of leading. */
export const RESEARCH_LABEL_ROW_STEP = 10;
/** The first stacked row sits just inside the frame's top edge. */
export const RESEARCH_LABEL_TOP_Y = 2;
/** A 9px monospace glyph, in viewBox units at the widths this chart draws. */
export const RESEARCH_LABEL_CHAR_WIDTH = 7;

/**
 * Place the research occurrences the chart can draw honestly.
 *
 * Mirrors the two placements it rides beside: an instantaneous occurrence is
 * placed like a fill (dropped before the window's first candle, clamped to
 * `now` after it) and a span like an event band (clipped at both edges,
 * dropped when wholly outside). Upcoming occurrences follow the bounded
 * future-gutter policy, and without a clock there is no gutter, so an
 * upcoming marker is dropped rather than drawn as record. An uncovered
 * occurrence (`covered: false`) never becomes a placed marker at all.
 */
function placeResearchMarkers(input: {
  readonly markers: ReadonlyArray<ChartResearchMarkerInput>;
  readonly xForTime: (t: number) => number;
  readonly nowX: number;
  readonly hasClock: boolean;
  readonly timeStart: number;
}): ReadonlyArray<ChartResearchMarker> {
  const placed: Array<Omit<ChartResearchMarker, "labelY">> = [];

  for (const marker of input.markers) {
    // No coverage means no honest position: never a rule, never a band, and
    // never a fabricated one at the left edge. The caller's coverage note is
    // the only disclosure.
    if (!marker.covered) continue;
    const span = marker.endAt > marker.startAt;

    if (marker.upcoming) {
      // No clock, no future gutter: an upcoming occurrence cannot be drawn
      // as record, so it is not drawn.
      if (!input.hasClock) continue;
      if (span) {
        let x1 = clamp(input.xForTime(marker.startAt), input.nowX, PLOT_WIDTH);
        // The visible-minimum floor must not push the band past the plot's
        // right edge and into the price gutter.
        x1 = Math.min(x1, PLOT_WIDTH - MIN_EVENT_BAND_WIDTH);
        const x2 = Math.max(
          clamp(input.xForTime(marker.endAt), input.nowX, PLOT_WIDTH),
          x1 + MIN_EVENT_BAND_WIDTH,
        );
        placed.push({ ...marker, span: true, x1, x2 });
      } else {
        placed.push({
          ...marker,
          span: false,
          x1: clamp(input.xForTime(marker.startAt), input.nowX, PLOT_WIDTH),
          x2: clamp(input.xForTime(marker.startAt), input.nowX, PLOT_WIDTH),
        });
      }
      continue;
    }

    // An occurrence before the window's first candle has no honest x — the
    // same drop an old fill gets, and the opposite of a left-edge pin.
    if (marker.startAt < input.timeStart) continue;

    if (span) {
      const raw1 = input.xForTime(marker.startAt);
      const raw2 = input.xForTime(marker.endAt);
      if (raw2 < 0 || raw1 > PLOT_WIDTH) continue;
      let x1 = clamp(raw1, 0, PLOT_WIDTH);
      x1 = Math.min(x1, PLOT_WIDTH - MIN_EVENT_BAND_WIDTH);
      const x2 = Math.max(clamp(raw2, 0, PLOT_WIDTH), x1 + MIN_EVENT_BAND_WIDTH);
      placed.push({ ...marker, span: true, x1, x2 });
    } else {
      const raw = input.xForTime(marker.startAt);
      if (raw < 0) continue;
      const x = clamp(raw, 0, input.nowX);
      placed.push({ ...marker, span: false, x1: x, x2: x });
    }
  }

  const labelYs = layoutResearchMarkerLabels(
    placed.map((marker) => ({ key: marker.key, text: marker.label, x: marker.x1 })),
    {
      charWidth: RESEARCH_LABEL_CHAR_WIDTH,
      rowStep: RESEARCH_LABEL_ROW_STEP,
      topY: RESEARCH_LABEL_TOP_Y,
      frameHeight: CHART_VIEWBOX_HEIGHT,
    },
  );

  return placed.map((marker) => ({
    ...marker,
    labelY: labelYs.get(marker.key) ?? RESEARCH_LABEL_TOP_Y,
  }));
}

/**
 * Compute the full geometry for the chart, or `null` when there are too few
 * candles to draw anything.
 *
 * The domain is candle highs/lows ∪ {entry, stop, target}, padded 8%. The mark
 * is pinned at the right edge of the plot area regardless of its timestamp
 * (the mark is "now", and "now" is the right edge of a time series).
 */
export function computeChartGeometry(input: ComputeChartGeometryInput): ChartGeometry | null {
  const { candles, entryPrice, stopPrice, targetPrice, liquidationPrice, entryTime, markPrice } =
    input;

  if (candles.length < MIN_CANDLES_FOR_SVG) return null;

  const bounds = candleBounds(candles);
  const { drawn: conditions, dropped: droppedConditions } = selectConditions({
    conditions: input.conditions ?? [],
    markPrice,
    candleRange: bounds.max - bounds.min,
  });

  // --- y-domain: candle range ∪ the levels near enough to it, padded. ------
  const pendingOrder = input.pendingOrder ?? null;
  const anchors = collectDomainAnchors(candles, [
    ...(entryPrice === null ? [] : [entryPrice]),
    ...(stopPrice === null ? [] : [stopPrice]),
    ...(targetPrice === null ? [] : [targetPrice]),
    ...conditions.map((condition) => condition.price),
    // A resting order sits at a price the market is expected to reach, so it is
    // an anchor on the same terms as the levels above it.
    ...(pendingOrder === null ? [] : [pendingOrder.price]),
  ]);
  let rawMin = anchors[0]!;
  let rawMax = anchors[0]!;
  for (const value of anchors) {
    if (value < rawMin) rawMin = value;
    if (value > rawMax) rawMax = value;
  }

  // A zero-height domain (flat market, single price) would collapse the chart
  // to a line and divide by zero in yForPrice. Invent a small span around it:
  // 0.1% of the price, or 1 unit when the price is ~0.
  let domainSpan = rawMax - rawMin;
  if (domainSpan === 0) {
    domainSpan = Math.max(1, Math.abs(rawMax) * 0.001);
  }
  const pad = domainSpan * DOMAIN_PADDING_RATIO;
  const domainMin = rawMin - pad;
  const domainMax = rawMax + pad;
  const paddedSpan = domainMax - domainMin;

  // --- x-domain: first candle openTime .. now (or the last candle). --------
  //
  // `nowX` is where the axis's end lands. With a clock it stops short of the
  // plot's right edge, leaving the future gutter empty; without one it is the
  // right edge, which is the behaviour the review chart depends on.
  const timeStart = candles[0]!.openTime;
  const lastCandleTime = candles[candles.length - 1]!.openTime;
  const hasClock = input.nowMillis !== undefined;
  // A clock behind the last bar would run the axis backwards. Trust the data
  // over the browser's clock when they disagree.
  const clockNow = hasClock ? Math.max(input.nowMillis!, lastCandleTime) : lastCandleTime;

  // The axis scale, in viewBox units per millisecond.
  //
  // With a clock it is a CONSTANT — the window is a fixed number of bar
  // intervals wide, anchored at `now` — and that is the whole fix for a series
  // that "moved oddly" while the price ticked. Fitting `timeStart..now` to the
  // plot instead made the span grow with every passing second and shrink again
  // the moment a bar closed, so between two candles the whole series crept
  // rightward and squashed by ~1.7%, then snapped back. Nothing in the data
  // moved; the ruler did. Held constant, every bar slides left at one steady
  // rate, the pitch never changes, and a new candle arriving is not an event
  // the geometry can see.
  //
  // Without a clock (the review chart) the old fit-to-window mapping is kept
  // exactly: that window is closed, so it has nothing to slide.
  const barIntervalMillis = medianBarInterval(candles);
  // The axis ends at the close of the bar currently forming, not at `now`.
  //
  // This is what makes the line progress left to right. Anchored at `now`, the
  // window advanced with the clock: every bar slid leftward and the mark sat
  // pinned at one x forever, so the only motion on the chart was history
  // retreating. Anchored at the forming bar's close, the ruler holds still for
  // the whole bar while `now` walks toward it — the mark travels rightward
  // across the frame, the line grows after it, and when the bar closes the
  // window steps left by exactly one bar pitch and the next one begins. That
  // step is the "pane moves" motion, and it is one bar wide: on a 60-bar
  // window, under two percent of the plot.
  //
  // Quantised against the last candle's own open, not against the epoch: a
  // feed's bars are not aligned to absolute minute boundaries, and rounding to
  // the epoch would put the axis end mid-bar and leave the step out of phase
  // with the arrivals it is meant to absorb. At least one bar ahead, always —
  // at the instant a bar opens there is still a whole bar forming.
  const barsAhead = Math.max(1, Math.ceil((clockNow - lastCandleTime) / barIntervalMillis));
  const timeEnd = hasClock ? lastCandleTime + barsAhead * barIntervalMillis : lastCandleTime;
  // Where that closing moment lands. The gutter to its right is what holds the
  // scheduled markers and the projection.
  const axisEndX = hasClock ? PLOT_WIDTH * (1 - FUTURE_GUTTER_RATIO) : PLOT_WIDTH;
  const visibleSpan = hasClock ? barIntervalMillis * candles.length : timeEnd - timeStart;
  const pixelsPerMilli = visibleSpan > 0 ? axisEndX / visibleSpan : 0;

  const xForTime = (t: number): number => axisEndX - (timeEnd - t) * pixelsPerMilli;
  // `now` is inside the frame rather than at its anchor: it is one bar's worth
  // to the left of the axis end at a bar open, and reaches the anchor at the
  // close.
  const nowX = hasClock ? xForTime(clockNow) : PLOT_WIDTH;

  // Inverted: higher price → smaller y → top of SVG.
  const yForPrice = (p: number): number => {
    const ratio = (p - domainMin) / paddedSpan;
    return CHART_VIEWBOX_HEIGHT - ratio * CHART_VIEWBOX_HEIGHT;
  };

  // --- pre/post split around entryTime. ------------------------------------
  // Candles with openTime < entryTime are pre-entry (flat, muted); from entry
  // onward they are post-entry (held, coloured by pnl). A null or pre-history
  // entryTime puts everything in post (the whole line is "held"); a post-history
  // entryTime puts everything in pre.
  const splitTime = entryTime;
  const preEntryPoints: ChartPoint[] = [];
  const postEntryPoints: ChartPoint[] = [];
  for (const candle of candles) {
    const point: ChartPoint = { x: xForTime(candle.openTime), y: yForPrice(candle.close) };
    if (splitTime !== null && candle.openTime < splitTime) {
      preEntryPoints.push(point);
    } else {
      // The first post-entry point also closes the pre-entry segment. Without
      // the shared boundary the two polylines stop and start a whole bar apart
      // and the line visibly breaks at the entry.
      if (postEntryPoints.length === 0 && preEntryPoints.length > 0) {
        preEntryPoints.push(point);
      }
      postEntryPoints.push(point);
    }
  }

  // --- candles: the market's own texture, under everything else. -----------
  //
  // Drawn from the bars' own pitch rather than from the interval, so a feed
  // with a gap in it does not stretch one body across the hole. A candle
  // without an `open` is skipped rather than bodied from the previous close:
  // the fallback is a convention, and a chart that invents one is no longer
  // the same picture as the exchange's.
  // One interval's worth of the axis, not the window divided by the bar count:
  // with a constant scale the two are the same on an even series, and on one
  // with a hole in it only this reading keeps every body the same width.
  const barPitch = barIntervalMillis * pixelsPerMilli;
  const halfWidth = Math.max(0.5, Math.min(BAR_MAX_HALF_WIDTH, (barPitch * 0.72) / 2));
  const bars: ChartBar[] = [];
  for (const candle of candles) {
    if (candle.open === undefined) continue;
    // A bar that has slid off the left edge is dropped rather than drawn
    // half-outside the frame.
    if (xForTime(candle.openTime) < -halfWidth) continue;
    const openY = yForPrice(candle.open);
    const closeY = yForPrice(candle.close);
    bars.push({
      key: candle.openTime,
      x: xForTime(candle.openTime),
      halfWidth,
      highY: yForPrice(candle.high),
      lowY: yForPrice(candle.low),
      bodyTop: Math.min(openY, closeY),
      bodyBottom: Math.max(openY, closeY),
      direction: candle.close >= candle.open ? "up" : "down",
    });
  }

  // --- the two moving averages: the EMA strategy's own read. ---------------
  // Both or neither — a fast average alone says nothing about a cross.
  const emaFast = buildEmaLine({
    candles,
    period: EMA_FAST_PERIOD,
    speed: "fast",
    xForTime,
    yForPrice,
  });
  const emaSlow = buildEmaLine({
    candles,
    period: EMA_SLOW_PERIOD,
    speed: "slow",
    xForTime,
    yForPrice,
  });
  const emaLines: ReadonlyArray<ChartEmaLine> =
    emaFast === null || emaSlow === null ? [] : [emaSlow, emaFast];

  // --- levels --------------------------------------------------------------
  //
  // Without a clock there is no future gutter to project into, so every rule
  // ends at `nowX` — which is the plot's right edge, exactly where the review
  // chart has always drawn them.
  const levelEndX = hasClock ? PLOT_WIDTH : nowX;
  const triggerEndX =
    hasClock && input.triggerExpiryAt !== undefined
      ? clamp(xForTime(input.triggerExpiryAt), nowX, PLOT_WIDTH)
      : levelEndX;
  const levels = buildLevels({
    yForPrice,
    domainMin,
    domainMax,
    entryPrice,
    stopPrice,
    targetPrice,
    liquidationPrice,
    conditions,
    pendingOrder,
    levelEndX,
    triggerEndX,
  });

  // --- fills: the session's activity, placed on the axis. ------------------
  // A fill before the window's first candle has no honest x, so it is dropped;
  // one after `now` (a fill landing between the mission poll and the clock
  // tick) is pinned at now. The y is clamped for the same reason the mark's is.
  const fillPoints: ChartFillPoint[] = [];
  for (const fill of input.fills ?? []) {
    if (fill.at < timeStart) continue;
    fillPoints.push({
      key: fill.key,
      x: clamp(xForTime(fill.at), 0, nowX),
      y: clamp(yForPrice(fill.price), 0, CHART_VIEWBOX_HEIGHT),
      price: fill.price,
      kind: fill.kind,
      at: fill.at,
      label: fill.label ?? null,
    });
  }

  // --- mark point: pinned at the right edge of the plot. -------------------
  //
  // The mark is deliberately not a domain anchor (see `collectDomainAnchors`),
  // and it is polled far more often than the candles are — so a fast move puts
  // it outside the padded range. Clamp the dot's y into the plot rather than
  // letting it and its price tag render off-canvas; the tag still reads the
  // true price, so a pinned dot means "off the top/bottom of this frame".
  const markPoint: ChartPoint | null =
    markPrice !== null
      ? { x: nowX, y: clamp(yForPrice(markPrice), 0, CHART_VIEWBOX_HEIGHT) }
      : null;

  // --- the forming bar: last close → the mark. -----------------------------
  // Only with a clock: without one the mark sits exactly on the last candle
  // and this segment would have zero length.
  const lastPoint =
    postEntryPoints[postEntryPoints.length - 1] ??
    preEntryPoints[preEntryPoints.length - 1] ??
    null;
  const livePoints: ReadonlyArray<ChartPoint> =
    hasClock && markPoint !== null && lastPoint !== null ? [lastPoint, markPoint] : [];

  // --- the projection: mark → the plan's expected price, in the gutter. -----
  // Clamped like a time marker: an estimate further out than the gutter
  // reaches is pinned at the frame edge rather than drawn off-canvas. The y is
  // clamped like the mark's, so a bold call still points the right way from
  // inside the frame.
  const projection = input.projection ?? null;
  const projectionPoints: ReadonlyArray<ChartPoint> =
    hasClock && projection !== null && markPoint !== null
      ? [
          markPoint,
          {
            x: clamp(xForTime(projection.atMillis), nowX, PLOT_WIDTH),
            y: clamp(yForPrice(projection.price), 0, CHART_VIEWBOX_HEIGHT),
          },
        ]
      : [];

  // --- future markers, placed in the gutter to the right of now. -----------
  const timeMarkers: ChartTimeMarker[] = hasClock
    ? (input.timeMarkers ?? []).map((marker) => ({
        key: marker.key,
        label: marker.label,
        at: marker.at,
        // Clamped to the plot's right edge: a reassessment further out than
        // the gutter reaches still belongs on screen, pinned at the far edge,
        // rather than drawn off-canvas or silently dropped.
        x: clamp(xForTime(marker.at), nowX, PLOT_WIDTH),
        // Against the clock, not against the axis end: the axis now runs to
        // the close of the forming bar, so a reassessment due in thirty
        // seconds would otherwise be reported as already overdue.
        overdue: marker.at <= clockNow,
        tone: marker.tone ?? "planned",
      }))
    : [];

  // --- past markers: the mission's own turns, on the same axis. ------------
  // Only the ones inside the drawn window: an event before the first candle has
  // no honest x, and the cap keeps a mission that woke two hundred times from
  // fencing its own price line in. Newest-first in, so the cap drops the oldest.
  const pastMarkers: ChartPastMarker[] = [];
  for (const marker of input.pastMarkers ?? []) {
    if (pastMarkers.length >= MAX_DRAWN_PAST_MARKERS) break;
    if (marker.at < timeStart || marker.at > clockNow) continue;
    pastMarkers.push({
      key: marker.key,
      kind: marker.kind,
      at: marker.at,
      x: clamp(xForTime(marker.at), 0, nowX),
      ...(marker.cause === undefined ? {} : { cause: marker.cause }),
      ...(marker.failed === undefined ? {} : { failed: marker.failed }),
      ...(marker.label === undefined ? {} : { label: marker.label }),
    });
  }

  // --- event bands: spans of wall-clock time, behind the price. -----------
  // A band wholly outside the plot is dropped rather than pinned: unlike a
  // moment, a span pinned to an edge would claim a width it does not have.
  // Edges that merely overhang are clipped. An upcoming band clamps into the
  // future gutter the way a time marker does, so the next date stays on
  // screen however far out it is.
  const timeBands: ChartTimeBand[] = [];
  for (const band of input.eventBands ?? []) {
    const raw1 = xForTime(band.startAt);
    const raw2 = xForTime(band.endAt);
    // The gutter clamp below only exists with a clock, so an upcoming band
    // past the axis end is dropped without one, exactly like a time marker.
    const clampsIntoGutter = band.upcoming && hasClock;
    if (raw2 < 0 || (!clampsIntoGutter && raw1 > PLOT_WIDTH)) continue;
    const floor = clampsIntoGutter ? nowX : 0;
    let x1 = clamp(raw1, floor, PLOT_WIDTH);
    // A zero-width occurrence (or one pinned flat at an edge) still gets the
    // visible minimum, shifted to stay inside the plot.
    x1 = Math.min(x1, PLOT_WIDTH - MIN_EVENT_BAND_WIDTH);
    const x2 = Math.max(clamp(raw2, floor, PLOT_WIDTH), x1 + MIN_EVENT_BAND_WIDTH);
    timeBands.push({ ...band, x1, x2, width: x2 - x1 });
  }

  // --- research markers: scene events, at their exact saved instants. -----
  const researchMarkers = placeResearchMarkers({
    markers: input.researchMarkers ?? [],
    xForTime,
    nowX,
    hasClock,
    timeStart,
  });

  // --- the research study overlay: measurements, never fills. -----------
  // Placed like the fills (dropped before the window's first candle, clamped
  // inside the frame) but drawn as its own vocabulary by the renderer. The
  // entry and exit prices come from bars inside the window, so their y is
  // clamped only for the same off-frame courtesy the mark gets.
  const studyInput = input.studyOverlay ?? null;
  let studyOverlay: ChartStudyOverlay | null = null;
  if (studyInput !== null) {
    const activation =
      studyInput.activation !== null &&
      studyInput.activation.at >= timeStart &&
      studyInput.activation.at <= timeEnd
        ? {
            ...studyInput.activation,
            x: clamp(xForTime(studyInput.activation.at), 0, PLOT_WIDTH),
          }
        : null;
    const placeStudyPoint = (
      point: { readonly at: number; readonly price: number; readonly label: string } | null,
    ) =>
      point !== null && point.at >= timeStart
        ? {
            ...point,
            x: clamp(xForTime(point.at), 0, PLOT_WIDTH),
            y: clamp(yForPrice(point.price), 0, CHART_VIEWBOX_HEIGHT),
          }
        : null;
    const entry = placeStudyPoint(studyInput.entry);
    const exit = placeStudyPoint(studyInput.exit);
    const returnSpan =
      entry !== null && exit !== null && studyInput.returnPct !== null
        ? { x1: entry.x, y1: entry.y, x2: exit.x, y2: exit.y, returnPct: studyInput.returnPct }
        : null;
    studyOverlay = { activation, entry, exit, returnSpan };
  }

  // --- price bands, and the one gutter pass they share with the levels. ----
  const gutter = buildZonesAndTags({
    zones: input.zones ?? [],
    levels,
    markPoint,
    markPrice,
    yForPrice,
    domainMin,
    domainMax,
  });

  return {
    viewBoxWidth: CHART_VIEWBOX_WIDTH,
    viewBoxHeight: CHART_VIEWBOX_HEIGHT,
    plotWidth: PLOT_WIDTH,
    labelGutterWidth: LABEL_GUTTER_WIDTH,
    domainMin,
    domainMax,
    timeStart,
    timeEnd,
    nowX,
    xForTime,
    yForPrice,
    bars,
    emaLines,
    preEntryPoints,
    postEntryPoints,
    livePoints,
    levels,
    fillPoints,
    markPoint,
    projectionPoints,
    gutterTags: gutter.gutterTags,
    zones: gutter.zones,
    timeMarkers,
    pastMarkers,
    timeBands,
    researchMarkers,
    studyOverlay,
    droppedConditions,
  };
}
