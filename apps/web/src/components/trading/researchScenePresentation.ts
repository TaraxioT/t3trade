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
import type { EventStudyEntryBasis } from "@t3tools/trading-contracts/eventSets";
import { EVENT_STUDY_ENTRY_BASIS_PHRASES } from "@t3tools/trading-contracts/eventSets";
import { STUDY_CHART_CONTEXT_BARS, STUDY_CHART_MAX_WINDOW_BARS } from "@t3tools/contracts";

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
 * The initial mode when a thread holds scenes: calendar shows each measured
 * window where it happened, which is the honest first answer to "did ETH
 * rise after Devcon". Aligned is one click away and Live never moves.
 */
export function resolveInitialGraphMode(scene: ResearchSceneView | undefined): GraphViewMode {
  return scene === undefined ? "live" : "calendar";
}

/**
 * The mode-switch decision when the thread's scene set changes, extracted so
 * the sticky-Live rule is testable: a scene ARRIVING while Live is showing
 * selects Calendar once (the useful first view of new research), and only
 * then. Once the user has chosen any mode, later scene churn never moves
 * them: their choice is stickier than the data. Scenes disappearing entirely
 * hand the graph back to Live, because Calendar and Aligned have nothing to
 * show without them.
 */
export function nextGraphViewMode(input: {
  readonly current: GraphViewMode;
  readonly hasScenes: boolean;
  readonly previouslyHadScenes: boolean;
}): GraphViewMode {
  if (!input.hasScenes) return "live";
  if (input.previouslyHadScenes) return input.current;
  // Scenes just arrived. Auto-select Calendar only from Live: a user who is
  // somehow already in a research mode (impossible without scenes, but total
  // is total) stays put.
  return input.current === "live" ? "calendar" : input.current;
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
 * The honesty block under the graph: every line a reader needs before
 * trusting a number, as data so the renderer cannot drop one quietly.
 * Baseline wording never claims significance.
 */
export function studyExplanationLines(payload: EventStudyScenePayload): ReadonlyArray<string> {
  const { report } = payload;
  const basis = payloadEntryBasis(payload);
  const lines = [
    `${report.nCovered} of ${report.n} occurrences fall inside archived data`,
    `horizon ${describeHorizon(report.horizonBars, report.horizonMs)} on ${payload.interval} bars`,
    `entry basis: ${EVENT_STUDY_ENTRY_BASIS_PHRASES[basis]}`,
    studyRuleSentence(basis),
    `mean ${fmtPct(report.meanReturnPct)}, median ${fmtPct(report.medianReturnPct)}, ` +
      `hit rate ${report.hitRatePercent === null ? "-" : `${report.hitRatePercent}%`}, ` +
      `best ${fmtPct(report.bestReturnPct)}, worst ${fmtPct(report.worstReturnPct)}`,
  ];
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
