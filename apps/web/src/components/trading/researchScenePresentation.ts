/**
 * Pure derivations for the research half of the unified graph.
 *
 * Kept out of the components for the same reason `tradeHomePresentation` is:
 * a label the graph shows is a claim about server-computed state, and claims
 * are easier to pin in a test than in a render tree. Everything here is
 * display arithmetic on server-owned numbers (rebased traces, mean paths,
 * human time) plus the sentences the honesty block renders; nothing invents
 * a measurement.
 *
 * @module researchScenePresentation
 */
import type {
  DeterministicSceneLayer,
  EventStudyScenePayload,
  ResearchSceneView,
  TradingChartCandleLike,
} from "./researchSceneViewTypes.ts";
import type { ResearchOccurrenceWindow } from "@t3tools/contracts";
import type { ChartResearchMarkerInput } from "./missionChartGeometry.ts";
import type { EventStudyEntryBasis } from "@t3tools/trading-contracts/eventSets";
import { EVENT_STUDY_ENTRY_BASIS_PHRASES } from "@t3tools/trading-contracts/eventSets";
import {
  RESEARCH_CALCULATION_VERSIONS,
  STUDY_CHART_CONTEXT_BARS,
  STUDY_CHART_MAX_WINDOW_BARS,
  type TradingChartInterval,
  type TradingChartRange,
} from "@t3tools/contracts";
import { autoInterval, sceneAutoFit } from "../../lib/tradingChartRangePolicy";

/**
 * Bars of context either side of a measured occurrence window. Aliased off
 * the contract constant so the window the graph pads and the cap the chart
 * RPC clamps to are one number, not two that can drift.
 */
export const OCCURRENCE_CONTEXT_BARS = STUDY_CHART_CONTEXT_BARS;

export type GraphViewMode = "live" | "calendar" | "aligned";

/**
 * The presentation half of the scene lifecycle: the graph shows what is
 * active. Superseded and cleared rows stay on the server as history — the
 * lifecycle word rides every view precisely so this filter is a decision
 * made once, here, rather than inferred from absence in every consumer.
 * Without it a cleared scene keeps decorating the graph forever, and the
 * mode switcher with it.
 */
export function activeGraphScenes(
  scenes: ReadonlyArray<ResearchSceneView>,
): ReadonlyArray<ResearchSceneView> {
  return scenes.filter((scene) => scene.status === "active");
}

/**
 * The mode-switch decision when the thread's scene set changes, extracted so
 * the Live-first rule is testable: a scene ARRIVING never moves the graph.
 * The study is published onto Live — named markers at their exact instants,
 * one auto-fit of the range — and Calendar and Event aligned stay one click
 * away. Scenes disappearing entirely hand the graph back to Live, because
 * Calendar and Aligned have nothing to show without them.
 */
export function nextGraphViewMode(input: {
  readonly current: GraphViewMode;
  readonly hasScenes: boolean;
  readonly previouslyHadScenes: boolean;
}): GraphViewMode {
  // Scenes just arrived: keep whatever the reader is looking at, Live
  // included. Research decorates the live graph; it does not take it over.
  if (input.hasScenes) return input.current;
  // Scenes vanished (cleared, or the thread's last scene was superseded away):
  // the research modes have nothing to render, so the graph comes home.
  return "live";
}

/** The label on the event-aligned stage's baseline reference line. */
export const BASELINE_REFERENCE_LABEL = "Baseline mean";

/** The exact sentence the aligned stage shows when the report holds no baseline. */
export const BASELINE_UNAVAILABLE_SENTENCE = "Baseline unavailable for this served window";

/** The dashed reference the aggregate comparison draws, when there is one to draw. */
export interface BaselineReference {
  readonly valuePct: number;
  readonly label: string;
}

/**
 * The baseline mean as a drawn reference: one horizontal level across the
 * horizon axis, labelled as the baseline. Null when the report holds no
 * baseline (the served window was shorter than the horizon) — and then
 * NOTHING may draw in its place, because a made-up level would read as a
 * measurement.
 */
export function baselineReference(
  baseline: { readonly meanReturnPct: number } | null,
): BaselineReference | null {
  return baseline === null
    ? null
    : { valuePct: baseline.meanReturnPct, label: BASELINE_REFERENCE_LABEL };
}

/**
 * The scene-derived markers the LIVE graph draws, one per occurrence window at
 * its exact saved instants. An instantaneous activation (`startAt === endAt`)
 * becomes a rule at that millisecond; a true span becomes a band; an
 * occurrence after `now` is flagged `upcoming` so the renderer can place it in
 * the future gutter. Uncovered occurrences are still handed over — coverage is
 * the renderer's to say, never a reason to silently drop a recorded fact.
 */
export function liveResearchMarkers(
  scene: {
    readonly sceneId: string;
    readonly eventStudy?:
      | {
          readonly eventSetName: string;
          readonly occurrenceWindows: ReadonlyArray<ResearchOccurrenceWindow>;
        }
      | undefined;
  },
  now: number,
): ReadonlyArray<ChartResearchMarkerInput> {
  const study = scene.eventStudy;
  if (study === undefined) return [];
  return study.occurrenceWindows.map((window) => ({
    key: `${scene.sceneId}:${window.startAt}`,
    label: window.label ?? study.eventSetName,
    startAt: window.startAt,
    endAt: window.endAt,
    sourceUrl: window.source,
    covered: window.covered,
    upcoming: window.endAt > now,
  }));
}

/**
 * The accessible name of one research marker: its label, the exact UTC
 * instant(s), what it means (a historical counterfactual measurement, never a
 * fill — or an expectation, for an upcoming occurrence), and the authoritative
 * source the date came from. Composed here so the derivation and the renderer
 * cannot disagree about what a marker claims.
 */
export function researchMarkerAccessibleName(marker: ChartResearchMarkerInput): string {
  const coverage = marker.covered ? "" : ", not covered by recorded data";
  const when =
    marker.startAt === marker.endAt
      ? `at ${new Date(marker.startAt).toISOString()}`
      : `from ${new Date(marker.startAt).toISOString()} to ${new Date(marker.endAt).toISOString()}`;
  const meaning = marker.upcoming
    ? "upcoming researched occurrence"
    : "historical counterfactual measurement, not a fill";
  return `${marker.label} ${when}${coverage}: ${meaning}; source ${marker.sourceUrl}`;
}

/**
 * Short coverage notes for occurrences the archive never reached, rendered as
 * text under the chart — an occurrence older than the recording start cannot
 * be drawn at the left edge without inventing a position, so it says so
 * instead. A future occurrence is likewise named as not having happened yet.
 */
export function uncoveredOccurrenceNotes(
  scene: {
    readonly eventStudy?:
      | {
          readonly eventSetName: string;
          readonly occurrenceWindows: ReadonlyArray<ResearchOccurrenceWindow>;
        }
      | undefined;
  },
  now: number,
): ReadonlyArray<string> {
  const study = scene.eventStudy;
  if (study === undefined) return [];
  const notes: Array<string> = [];
  for (const window of study.occurrenceWindows) {
    if (window.covered) continue;
    const label = window.label ?? study.eventSetName;
    const date = new Date(window.startAt).toISOString().slice(0, 10);
    notes.push(
      window.endAt > now
        ? `${label} (${date}) has not happened yet`
        : `${label} (${date}) predates recorded data`,
    );
  }
  return notes;
}

/** The range/bars pair a scene's arrival fits the live graph to, once. */
export interface SceneAutoFitRecommendation {
  readonly range: TradingChartRange;
  readonly interval: TradingChartInterval;
}

/**
 * The one-time range recommendation for a newly active event-study scene,
 * pure over dates: the smallest fixed range that holds every occurrence the
 * graph can actually draw (covered ones inside the archive, upcoming ones in
 * the future gutter), `all` when none does. An occurrence the archive never
 * reached can never draw, so it must not stretch the fit; but when nothing is
 * drawable the whole set decides, because `all` plus the coverage note is the
 * honest frame for it.
 */
export function sceneAutoFitRecommendation(
  occurrenceWindows: ReadonlyArray<{
    readonly startAt: number;
    readonly endAt: number;
    readonly covered: boolean;
  }>,
  now: number,
): SceneAutoFitRecommendation {
  const relevant = occurrenceWindows.filter((window) => window.covered || window.endAt > now);
  const source = relevant.length > 0 ? relevant : occurrenceWindows;
  const earliest = source.length > 0 ? Math.min(...source.map((w) => w.startAt)) : now;
  const latest = relevant.length > 0 ? Math.max(...relevant.map((w) => w.endAt)) : now;
  const range = sceneAutoFit(earliest, latest, now);
  return { range, interval: autoInterval(range, "event_study_fit") };
}

/** The once-per-scene gate around {@link sceneAutoFitRecommendation}. */
export interface SceneAutoFitDecision {
  readonly apply: boolean;
  /** The set to keep in the caller's ref: the applied ids, this one included. */
  readonly appliedSceneIds: ReadonlySet<string>;
  readonly recommendation?: SceneAutoFitRecommendation;
}

/**
 * Whether a scene's auto-fit should be applied NOW: once per active scene id,
 * ever. Publishing a new scene supersedes the old one, so each new id gets
 * its one fit; polls and refreshes of the same scene never move the range
 * again, and a user's own choice after any fit is stickier than the data.
 */
export function sceneAutoFitDecision(
  appliedSceneIds: ReadonlySet<string>,
  scene: {
    readonly sceneId: string;
    readonly eventStudy?:
      | {
          readonly occurrenceWindows: ReadonlyArray<{
            readonly startAt: number;
            readonly endAt: number;
            readonly covered: boolean;
          }>;
        }
      | undefined;
  },
  now: number,
): SceneAutoFitDecision {
  const windows = scene.eventStudy?.occurrenceWindows;
  if (windows === undefined || appliedSceneIds.has(scene.sceneId)) {
    return { apply: false, appliedSceneIds };
  }
  const applied = new Set(appliedSceneIds);
  applied.add(scene.sceneId);
  return {
    apply: true,
    appliedSceneIds: applied,
    recommendation: sceneAutoFitRecommendation(windows, now),
  };
}

export interface AlignedPoint {
  readonly barsSinceEntry: number;
  /** Percentage change from the measured entry open. */
  readonly changePct: number;
}

/**
 * Rebase one occurrence's candles to its measured entry, on the basis the
 * study measured: x is bars since the entry bar, y is the close's percentage
 * change from the entry price (the entry bar's close on the close basis, its
 * open on the open basis). Bars before the entry are excluded; the run is
 * capped at the horizon, which on the close basis includes the entry bar
 * itself plus a full horizon of following bars, so the trace's last point is
 * the row's own measured return. Pure over the windowed read the calendar
 * view already fetched, so both views show the same bars.
 */
export function alignedTracePoints(input: {
  readonly candles: ReadonlyArray<TradingChartCandleLike>;
  readonly entryTime: number;
  readonly intervalMs: number;
  readonly horizonBars: number;
  readonly entryBasis?: EventStudyEntryBasis;
}): ReadonlyArray<AlignedPoint> {
  const basis = input.entryBasis ?? "first_bar_open_after_event";
  let entry: TradingChartCandleLike | undefined;
  if (basis === "first_closed_bar_after_event") {
    // The entry moment is the entry bar's CLOSE, so the bar sought is the
    // last one that opened before it: true whichever close-time convention
    // the feed stamps (close at open+interval or open+interval-1), because
    // both put the entry bar's open a full interval before its close and the
    // next bar's open at or after the entry moment itself.
    for (const candle of input.candles) {
      if (candle.openTime >= input.entryTime) break;
      entry = candle;
    }
  } else {
    entry = input.candles.find((candle) => candle.openTime >= input.entryTime);
  }
  if (entry === undefined || !(entry.open > 0 && entry.close > 0)) return [];
  const anchor = basis === "first_closed_bar_after_event" ? entry.close : entry.open;
  const bars = input.horizonBars + (basis === "first_closed_bar_after_event" ? 1 : 0);
  return input.candles
    .filter((candle) => candle.openTime >= entry.openTime)
    .slice(0, bars)
    .map((candle, index) => ({
      barsSinceEntry: index,
      changePct: ((candle.close - anchor) / anchor) * 100,
    }));
}

/**
 * The aggregate trace: the mean change per bar offset across covered
 * occurrences, reported with the count it averaged. Distinct by construction
 * (the graph draws it heavier), and honest about small n by carrying n.
 */
export function aggregateAlignedTrace(traces: ReadonlyArray<ReadonlyArray<AlignedPoint>>): {
  readonly points: ReadonlyArray<AlignedPoint>;
  readonly n: number;
} {
  if (traces.length === 0) return { points: [], n: 0 };
  const sums = new Map<number, { sum: number; count: number }>();
  for (const trace of traces) {
    for (const point of trace) {
      const current = sums.get(point.barsSinceEntry) ?? { sum: 0, count: 0 };
      current.sum += point.changePct;
      current.count += 1;
      sums.set(point.barsSinceEntry, current);
    }
  }
  const points = [...sums.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([bars, { sum, count }]) => ({ barsSinceEntry: bars, changePct: sum / count }));
  return { points, n: traces.length };
}

/** Human words for a horizon: "30 bars (about 30 days)". */
export function describeHorizon(horizonBars: number, horizonMs: number): string {
  const days = horizonMs / (24 * 60 * 60 * 1_000);
  const human =
    days >= 365
      ? `about ${(days / 365).toFixed(1)} years`
      : days >= 60
        ? `about ${(days / 30).toFixed(1)} months`
        : days >= 1
          ? `${Math.round(days)} day${days >= 2 ? "s" : ""}`
          : `${Math.round(days * 24)} hours`;
  return `${horizonBars} bars (${human})`;
}

/**
 * The study's fixed measurement rule, in the reader's words, on the basis the
 * study measured. The open-basis sentence is exported as
 * {@link STUDY_RULE_SENTENCE} because it is the rule scenes computed before
 * the basis field existed were measured on.
 */
export function studyRuleSentence(basis: EventStudyEntryBasis): string {
  return basis === "first_closed_bar_after_event"
    ? "entry is the close of the first bar that closed after the event; exit is the close a full horizon of bars later, close to close"
    : STUDY_RULE_SENTENCE;
}

/**
 * The open basis's rule, kept as the constant it has always been: counting is
 * inclusive and says so, the entry bar is the first bar of the horizon, so
 * horizon 1 exits on the entry bar's own close and horizon 2 on the next
 * bar's close, exactly what the engine measures on that basis.
 */
export const STUDY_RULE_SENTENCE =
  "entry is the first archived bar whose open lands at or after the event ends; exit is the close of the horizon-th bar, counting the entry as the first";

/** The basis a payload's numbers were measured on, old scenes as the open basis. */
export function payloadEntryBasis(payload: EventStudyScenePayload): EventStudyEntryBasis {
  return payload.entryBasis ?? "first_bar_open_after_event";
}

const fmtDate = (t: number): string => new Date(t).toISOString().slice(0, 16);

/**
 * Whether a scene's numbers were computed by the current study engine. A
 * scene persisted at an older calculation version keeps its recorded numbers
 * forever — they are what was measured then — but it must say it predates the
 * current semantics rather than passing them off as current, and the fix is
 * republishing the same recipe (which writes a new scene row), never silently
 * restamping the old one.
 */
export function isLegacyEventStudyScene(payload: EventStudyScenePayload): boolean {
  return (
    payload.report.nComplete === undefined ||
    (payload as { calculationVersion?: string }).calculationVersion !==
      RESEARCH_CALCULATION_VERSIONS.eventStudy
  );
}

/**
 * The honesty block under the graph: every line a reader needs before
 * trusting a number, as data so the renderer cannot drop one quietly.
 * Baseline wording never claims significance. A legacy-calculation scene
 * says so on the first line that could otherwise read as current numbers.
 */
export function studyExplanationLines(
  payload: EventStudyScenePayload & { readonly calculationVersion?: string },
): ReadonlyArray<string> {
  const { report } = payload;
  const basis = payloadEntryBasis(payload);
  const lines = [
    `${report.nCovered} of ${report.n} occurrences fall inside archived data`,
    ...(report.nComplete === undefined
      ? []
      : [
          `${report.nComplete} completed the full horizon, ${report.nPartial ?? 0} truncated, ` +
            `${report.nUnavailable ?? report.n - report.nCovered} not measurable; aggregates are over complete horizons only`,
        ]),
    `horizon ${describeHorizon(report.horizonBars, report.horizonMs)} on ${payload.interval} bars`,
    `entry basis: ${EVENT_STUDY_ENTRY_BASIS_PHRASES[basis]}`,
    studyRuleSentence(basis),
    `mean ${fmtPct(report.meanReturnPct)}, median ${fmtPct(report.medianReturnPct)}, ` +
      `hit rate ${report.hitRatePercent === null ? "-" : `${report.hitRatePercent}%`}, ` +
      `best ${fmtPct(report.bestReturnPct)}, worst ${fmtPct(report.worstReturnPct)}`,
  ];
  if (
    payload.calculationVersion !== undefined &&
    payload.calculationVersion !== RESEARCH_CALCULATION_VERSIONS.eventStudy
  ) {
    lines.push(
      `computed at calculation version ${payload.calculationVersion}, older than the current ` +
        `${RESEARCH_CALCULATION_VERSIONS.eventStudy}: the entry-extremum, gap, cutoff and completeness semantics ` +
        "have since been repaired — republish the same recipe to recompute",
    );
  }
  lines.push(
    report.baseline === null
      ? "no baseline: the served window is shorter than the horizon"
      : `baseline: mean ${fmtPct(report.baseline.meanReturnPct)}, median ${fmtPct(report.baseline.medianReturnPct)} ` +
          `over ${report.baseline.samples} every-bar samples of the same horizon (overlapping windows; a center-of-mass comparison, not a significance test)`,
  );
  lines.push(
    payload.requestedFromT === undefined || payload.requestedToT === undefined
      ? `served ${fmtDate(payload.archiveBounds.fromT)} to ${fmtDate(payload.archiveBounds.toT)}`
      : `requested ${fmtDate(payload.requestedFromT)} to ${fmtDate(payload.requestedToT)}, ` +
          `served ${fmtDate(payload.archiveBounds.fromT)} to ${fmtDate(payload.archiveBounds.toT)}`,
  );
  lines.push(
    payload.archiveBounds.recordingSince === null
      ? "nothing is recorded for this market"
      : `archive recording since ${new Date(payload.archiveBounds.recordingSince).toISOString().slice(0, 10)}`,
  );
  lines.push(`price source: ${payload.priceSource ?? "hyperliquid"}`);
  return lines;
}

/** The marker vocabulary, said once where the picture lives. */
export const MARKER_LEGEND_SENTENCE =
  "bands, activation rules and study entry and exit markers are historical counterfactual measurements on archived bars; dashed ring markers are paper validation; solid dot markers are exchange fills; nothing in this view is a fill";

/**
 * The compact provenance trail under the graph: researched facts -> event set
 * -> study/backtest -> this scene -> the optional artifacts that may follow.
 * One line, from the scene's own recorded recipe; the optional tail is only
 * drawn when the user actually created the next artifact (the sentence says
 * none exists until then, which is itself provenance).
 */
export function provenanceTrailLine(payload: EventStudyScenePayload): string {
  const head = `researched dates (web, sourced) -> event set "${payload.eventSetName}" -> ${payload.report.nCovered}/${payload.report.n} measured on ${payload.interval} ${payload.priceSource ?? "hyperliquid"} bars -> this scene`;
  return `${head} -> hypothesis / forward validation / mission: not created (each needs your explicit ask)`;
}

export const DERIVED_VS_AUTHORED_SENTENCE =
  "every number and line here is computed by the server from archived bars; notes marked as agent notes are authored explanations, never measurements";

const fmtPct = (value: number | null | undefined): string =>
  value === null || value === undefined ? "-" : `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;

/** USD with a sign only when negative, the register the panel has always used. */
export const fmtUsd = (value: number): string =>
  `${value < 0 ? "-" : ""}$${Math.abs(value).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

/**
 * The signed money figure an event study's percentage maps onto: display
 * arithmetic on a measured return, nothing more.
 */
export function grossChangeUsd(notionalUsd: number, returnPct: number): number {
  return (notionalUsd * returnPct) / 100;
}

/**
 * The label that must ride any money figure derived from a study: the amount
 * is a historical gross change on the named notional, before costs, and the
 * words say so rather than dressing up as profit, PnL, or a balance.
 */
export function historicalGrossChangeLabel(notionalUsd: number): string {
  return `historical gross change on ${fmtUsd(notionalUsd)}, before costs`;
}

// ---------------------------------------------------------------------------
// the path_extrema metric: hypothetical PnL is display arithmetic, nothing more
// ---------------------------------------------------------------------------

/**
 * The assumptions line that rides a path_extrema scene's money figures: each
 * event is illustrated on the full notional INDEPENDENTLY (no compounding, no
 * reuse across events), gross of every cost, and the hindsight-perfect figure
 * is the maximum favorable excursion after entry — the best the path offered,
 * never a strategy result anyone could have realized.
 */
export const PATH_EXTREMA_ASSUMPTIONS_SENTENCE =
  "hypothetical illustration: each event gets the full notional independently (never compounded or reused), gross — no fees, funding, slippage or liquidation; the hindsight-perfect figure is the maximum favorable excursion after entry, not a realizable strategy result";

/**
 * The fixed-horizon close PnL on one event's notional: sign-correct for the
 * direction, so a SHORT profits when price falls (a negative measured return
 * negates into positive money) and loses when it rises. Pure display
 * arithmetic on the row's measured terminal returnPct — the notional is the
 * reader's current illustration, never an allocated position.
 */
export function fixedHorizonPnlUsd(input: {
  readonly notionalUsd: number;
  readonly returnPct: number;
  readonly direction: "short" | "long";
}): number {
  return (
    (input.notionalUsd * (input.direction === "short" ? -input.returnPct : input.returnPct)) / 100
  );
}

/**
 * The hindsight-perfect PnL at the extremum on one event's notional: the
 * excursion is long-convention signed like returnPct, so a short negates it
 * too. This is the maximum favorable excursion — the best point the path
 * reached after entry — and every figure it produces must ride
 * {@link PATH_EXTREMA_ASSUMPTIONS_SENTENCE}: nobody could have known the
 * extremum in advance, and nobody exits every window at its best tick.
 */
export function hindsightPerfectPnlUsd(input: {
  readonly notionalUsd: number;
  readonly excursionReturnPct: number;
  readonly direction: "short" | "long";
}): number {
  return (
    (input.notionalUsd *
      (input.direction === "short" ? -input.excursionReturnPct : input.excursionReturnPct)) /
    100
  );
}

/** The extremum in the reader's words: a short reads the low, a long the high. */
export function extremumPhrase(priceField: "low" | "high"): string {
  return priceField === "low" ? "lowest low" : "highest high";
}

/**
 * What one occurrence's timestamps claim, as a phrase the panel can put
 * beside the time. Legacy rows carry no claim and say exactly that — "recorded
 * as a span" — rather than a precision nobody declared at the time, and a
 * date never reads as a midnight it did not establish.
 */
export function occurrencePrecisionPhrase(
  precision: "instant" | "window" | "date" | undefined,
): string {
  switch (precision) {
    case "instant":
      return "exact instant";
    case "window":
      return "exact window";
    case "date":
      return "date precision (whole days, no time of day claimed)";
    default:
      return "recorded as a span";
  }
}

/**
 * The metric a scene's numbers were measured on; scenes persisted before
 * metrics existed are forward_return and never reinterpreted.
 */
export function payloadStudyMetric(payload: {
  readonly metric?: "forward_return" | "path_extrema" | undefined;
}): "forward_return" | "path_extrema" {
  return payload.metric ?? "forward_return";
}

/**
 * The calendar chart's study overlay for one occurrence, derived from the
 * server-composed deterministic layers rather than rebuilt from the row: the
 * activation rule the graph anchors on (carrying the occurrence's real
 * label), the measured entry and exit with their prices, and the signed
 * return between them. Null fields mean the scene holds no such layer, and
 * the chart draws nothing for them rather than inventing a position.
 */
export interface OccurrenceStudyOverlay {
  readonly activation: { readonly at: number; readonly label: string } | null;
  readonly entry: { readonly at: number; readonly price: number; readonly label: string } | null;
  readonly exit: { readonly at: number; readonly price: number; readonly label: string } | null;
  readonly returnPct: number | null;
}

/**
 * The horizon rides the exit marker's label because it is the one number a
 * reader needs to tell a horizon-30 exit from a truncated one.
 */
export function occurrenceStudyOverlay(
  layers: ReadonlyArray<DeterministicSceneLayer>,
  occurrenceIndex: number,
  horizonBars: number,
): OccurrenceStudyOverlay {
  let activation: OccurrenceStudyOverlay["activation"] = null;
  let entry: OccurrenceStudyOverlay["entry"] = null;
  let exit: OccurrenceStudyOverlay["exit"] = null;
  let returnPct: number | null = null;
  for (const layer of layers) {
    if (layer.kind === "event_span" && layer.occurrenceIndex === occurrenceIndex) {
      // An instantaneous activation (start equal to end) is the rule; a
      // genuine multi-day span keeps its band and still rules at its end.
      activation = { at: layer.endAt, label: layer.label };
    } else if (layer.kind === "study_entry" && layer.occurrenceIndex === occurrenceIndex) {
      entry = { at: layer.at, price: layer.price, label: "study entry" };
    } else if (layer.kind === "study_exit" && layer.occurrenceIndex === occurrenceIndex) {
      exit = { at: layer.at, price: layer.price, label: `study exit after ${horizonBars} bars` };
    } else if (layer.kind === "return_span" && layer.occurrenceIndex === occurrenceIndex) {
      returnPct = layer.returnPct;
    }
  }
  return { activation, entry, exit, returnPct };
}

/**
 * The window the calendar view fetches for one occurrence: the event span
 * plus the measured horizon plus fixed context bars either side. Bounded per
 * occurrence so years-apart events cost small reads, not one giant series.
 */
export function occurrenceWindow(
  occurrence: {
    readonly startAt: number;
    readonly endAt: number;
    readonly entryTime?: number;
    readonly exitTime?: number;
  },
  horizonMs: number,
  intervalMs: number,
): { readonly startTime: number; readonly endTime: number } {
  const pad = OCCURRENCE_CONTEXT_BARS * intervalMs;
  const entry = occurrence.entryTime ?? occurrence.endAt;
  const exit = occurrence.exitTime ?? entry + horizonMs;
  return { startTime: occurrence.startAt - pad, endTime: exit + pad };
}

/**
 * The `maxBars` a study window must ask the chart RPC for, derived from the
 * recipe: event span plus horizon plus context bars on both sides, bounded by
 * the ceiling the RPC clamps to. The window read keeps the NEWEST bars when
 * it must cut, so a `maxBars` smaller than the window itself would silently
 * drop the entry — the oldest bars of a study window are exactly the entry.
 */
export function studyWindowMaxBars(input: {
  readonly startAt: number;
  readonly endAt: number;
  readonly horizonBars: number;
  readonly intervalMs: number;
}): number {
  const spanBars = Math.ceil(Math.max(0, input.endAt - input.startAt) / input.intervalMs);
  return Math.min(
    input.horizonBars + spanBars + 2 * OCCURRENCE_CONTEXT_BARS,
    STUDY_CHART_MAX_WINDOW_BARS,
  );
}

/** The "Ask about this" prefill sentence for one occurrence. No ids leak when unambiguous. */
export function askAboutOccurrenceSentence(input: {
  readonly sceneId: string;
  readonly market: string;
  readonly label: string;
  readonly dateIso: string;
  readonly returnPct: number | undefined;
}): string {
  const measured =
    input.returnPct === undefined
      ? "was not measured"
      : `measured ${input.returnPct > 0 ? "+" : ""}${input.returnPct.toFixed(2)}% over the horizon`;
  return `About the ${input.market} research scene ${input.sceneId.slice(0, 8)}: the ${input.dateIso} occurrence (${input.label}) ${measured}. Walk me through which bars produced that number.`;
}

/** Next-step prefills. Sentences only: nothing here plans, arms, or trades. */
export function turnIntoStrategySentence(market: string, setName: string): string {
  return `Turn the "${setName}" event study on ${market} into a testable thesis: express it in the grammar, say what the grammar could not hold, and backtest it. Do not publish a plan or arm anything.`;
}

export function validateForwardSentence(market: string, setName: string): string {
  return `Validate the "${setName}" idea on ${market} forward on paper. This is my explicit ask for a paper validation: arm one, nothing live.`;
}
