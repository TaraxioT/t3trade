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
  EventStudyScenePayload,
  ResearchSceneView,
  TradingChartCandleLike,
} from "./researchSceneViewTypes.ts";
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
 * Rebase one occurrence's candles to its measured entry: x is bars since the
 * entry bar, y is the close's percentage change from the entry open. Bars
 * before the entry are excluded; the horizon caps the run. Pure over the
 * windowed read the calendar view already fetched, so both views show the
 * same bars.
 */
export function alignedTracePoints(input: {
  readonly candles: ReadonlyArray<TradingChartCandleLike>;
  readonly entryTime: number;
  readonly intervalMs: number;
  readonly horizonBars: number;
}): ReadonlyArray<AlignedPoint> {
  const entry = input.candles.find((candle) => candle.openTime >= input.entryTime);
  if (entry === undefined || !(entry.open > 0)) return [];
  return input.candles
    .filter((candle) => candle.openTime >= entry.openTime)
    .slice(0, input.horizonBars)
    .map((candle, index) => ({
      barsSinceEntry: index,
      changePct: ((candle.close - entry.open) / entry.open) * 100,
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
 * The study's fixed measurement rule, in the reader's words. Counting is
 * inclusive and says so: the entry bar is the first bar of the horizon, so
 * horizon 1 exits on the entry bar's own close and horizon 2 on the next
 * bar's close — exactly what the engine measures.
 */
export const STUDY_RULE_SENTENCE =
  "entry is the first archived bar whose open lands at or after the event ends; exit is the close of the horizon-th bar, counting the entry as the first";

/**
 * The honesty block under the graph: every line a reader needs before
 * trusting a number, as data so the renderer cannot drop one quietly.
 * Baseline wording never claims significance.
 */
export function studyExplanationLines(payload: EventStudyScenePayload): ReadonlyArray<string> {
  const { report } = payload;
  const lines = [
    `${report.nCovered} of ${report.n} occurrences fall inside archived data`,
    `horizon ${describeHorizon(report.horizonBars, report.horizonMs)} on ${payload.interval} bars`,
    STUDY_RULE_SENTENCE,
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
    payload.archiveBounds.recordingSince === null
      ? "nothing is recorded for this market"
      : `archive recording since ${new Date(payload.archiveBounds.recordingSince).toISOString().slice(0, 10)}`,
  );
  lines.push(`price source: ${payload.priceSource ?? "hyperliquid"}`);
  return lines;
}

/** The marker vocabulary, said once where the picture lives. */
export const MARKER_LEGEND_SENTENCE =
  "bands mark historical counterfactual windows measured on archived bars; dashed markers are paper validation; solid markers are exchange fills; nothing in this view is a fill";

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
