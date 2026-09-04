/**
 * The research half of the unified graph.
 *
 * The live chart above the composer answers "what is price doing". This panel
 * answers the question the conversation actually asked: what did price do
 * after each Devcon, measured where the study measured it, against what the
 * archive could actually see. Every number rendered here was computed by the
 * server from archived bars; the one arithmetic this component does is
 * display arithmetic on those numbers (a per-notional illustration, and
 * rebasing a path to its entry), and both say so.
 *
 * The panel lives inside the graph's one fixed plot stage. Its upper part is
 * the picture — Calendar shows the ONE selected occurrence where it happened;
 * Event aligned shows the aggregate comparison against its baseline first —
 * and the larger lower part is the inspector, where the per-occurrence data
 * (returns, sources, traces) leads and the full honesty block sits one
 * disclosure away, so opening research never changes the graph's geometry and
 * never buries the study's own rows below the fold.
 *
 * Static SVG only, no animation: research is a document, not a dashboard.
 *
 * @module ResearchScenePanel
 */
import type { EnvironmentId, ResearchSceneView, TradingMarketChartView } from "@t3tools/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import { MissionPriceChart } from "./MissionPriceChart";
import type { ChartInterval, ChartWindow } from "../../lib/tradingMarketChartState";
import { useTradingMarketChart } from "../../lib/tradingMarketChartState";
import {
  PER_NOTIONAL_ILLUSTRATION_LABEL,
  RESEARCH_DISCLAIMER,
  STUDY_CHART_CONTEXT_BARS,
  STUDY_CHART_MAX_WINDOW_BARS,
  type EventStudyScenePayload,
  type ResearchOccurrenceWindow,
  type StrategyReplayScenePayload,
} from "@t3tools/contracts";
import {
  aggregateAlignedTrace,
  alignedTracePoints,
  askAboutOccurrenceSentence,
  BASELINE_REFERENCE_LABEL,
  BASELINE_UNAVAILABLE_SENTENCE,
  baselineReference,
  DERIVED_VS_AUTHORED_SENTENCE,
  describeHorizon,
  extremumPhrase,
  fixedHorizonPnlUsd,
  fmtUsd,
  grossChangeUsd,
  hindsightPerfectPnlUsd,
  historicalGrossChangeLabel,
  MARKER_LEGEND_SENTENCE,
  occurrencePrecisionPhrase,
  occurrenceStudyOverlay,
  PATH_EXTREMA_ASSUMPTIONS_SENTENCE,
  payloadEntryBasis,
  payloadStudyMetric,
  provenanceTrailLine,
  studyExplanationLines,
  studyWindowMaxBars,
  turnIntoStrategySentence,
  validateForwardSentence,
} from "./researchScenePresentation.ts";
import type { DeterministicSceneLayer } from "@t3tools/contracts";
import type { EventStudyEntryBasis } from "@t3tools/trading-contracts/eventSets";

const NOTIONAL_DEFAULT = 1_000;

/** Bars of context on each side of a measured occurrence window (shared with the chart cap). */
const CONTEXT_BARS = STUDY_CHART_CONTEXT_BARS;

const fmtPct = (value: number | null | undefined): string =>
  value === null || value === undefined ? "-" : `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;

/**
 * The honesty block, compacted for the fixed viewport: the two lines a reader
 * needs before trusting any number (coverage and horizon) stay visible, and
 * every full line sits one disclosure away. Nothing is dropped — the details
 * element keeps the whole block in the DOM — but the fine print no longer
 * pushes the per-occurrence data below the inspector's fold.
 */
function StudyExplanation(props: { readonly payload: EventStudyScenePayload }) {
  const lines = studyExplanationLines(props.payload);
  return (
    <div data-testid="research-explanation-block">
      <div
        className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground"
        data-testid="research-explanation-summary"
      >
        <span>{lines[0]}</span>
        <span>{lines[1]}</span>
      </div>
      <details className="mt-0.5 text-xs text-muted-foreground">
        <summary className="cursor-pointer text-[11px]">study details</summary>
        <div
          className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1"
          data-testid="research-explanation"
        >
          {lines.map((line) => (
            <span key={line}>{line}</span>
          ))}
        </div>
      </details>
    </div>
  );
}

/** The bars the fetch window spans: event span plus horizon plus context. */
function windowFor(
  occurrence: ResearchOccurrenceWindow,
  horizonMs: number,
  intervalMs: number,
): ChartWindow | null {
  if (occurrence.entryTime === undefined) return null;
  const pad = CONTEXT_BARS * intervalMs;
  const exit = occurrence.exitTime ?? occurrence.entryTime + horizonMs;
  return { startTime: occurrence.startAt - pad, endTime: exit + pad };
}

/**
 * One occurrence, in calendar time: its own bounded window read through the
 * ordinary chart RPC, and the study the SERVER composed for it: a named
 * activation rule at the exact instant, the measured entry and exit anchored
 * to their own prices, and the signed return drawn between them. The layers
 * come from the scene's deterministic half, never rebuilt here, so the chart
 * cannot downgrade a study into three anonymous bands.
 */
function OccurrenceChart(props: {
  readonly environmentId: EnvironmentId;
  readonly market: string;
  readonly interval: ChartInterval;
  readonly window: ChartWindow;
  readonly occurrence: ResearchOccurrenceWindow;
  readonly horizonBars: number;
  readonly intervalMs: number;
  readonly layers: ReadonlyArray<DeterministicSceneLayer>;
  readonly occurrenceIndex: number;
}) {
  const { data, error, stale } = useTradingMarketChart(
    props.environmentId,
    props.market,
    props.interval,
    {
      enabled: true,
      window: props.window,
      maxBars: studyWindowMaxBars({
        startAt: props.occurrence.startAt,
        endAt: props.occurrence.endAt,
        horizonBars: props.horizonBars,
        intervalMs: props.intervalMs,
      }),
      poll: false,
    },
  );
  const bands = useMemo(() => {
    // Only a genuine multi-day span still draws a band: an instantaneous
    // activation is the named rule on the study overlay, and drawing both a
    // band and a rule for one instant would say the same thing twice.
    if (props.occurrence.endAt - props.occurrence.startAt < props.intervalMs) return [];
    return [
      {
        key: `event:${props.occurrence.startAt}`,
        label: `span`,
        startAt: props.occurrence.startAt,
        endAt: props.occurrence.endAt,
        upcoming: false,
      },
    ];
  }, [props.occurrence, props.intervalMs]);
  const studyOverlay = useMemo(() => {
    const overlay = occurrenceStudyOverlay(props.layers, props.occurrenceIndex, props.horizonBars);
    // An instantaneous activation has no event_span band — the composer
    // refuses zero-width spans — so its named rule comes from the occurrence
    // window itself, at the exact instant it claims. The label is the
    // occurrence's own, never a number re-derived here.
    if (
      overlay.activation === null &&
      props.occurrence.timePrecision === "instant" &&
      props.occurrence.startAt === props.occurrence.endAt
    ) {
      return {
        ...overlay,
        activation: {
          at: props.occurrence.endAt,
          label: props.occurrence.label ?? `occurrence ${props.occurrenceIndex + 1}`,
        },
      };
    }
    return overlay;
  }, [props.layers, props.occurrenceIndex, props.horizonBars, props.occurrence]);

  // Last good view on a transient read failure, labelled stale: the window
  // did not stop existing because a request failed, and a reader
  // mid-inspection keeps the bars they were pointing at, flagged.
  const lastGood = useRef<TradingMarketChartView | null>(null);
  const lastWindowStart = useRef<number | null>(null);
  if (lastWindowStart.current !== props.window.startTime) {
    lastWindowStart.current = props.window.startTime;
    lastGood.current = null;
  }
  if (data !== null) lastGood.current = data;
  const effective = data ?? lastGood.current;
  if (error !== null && lastGood.current === null) {
    return (
      <div className="px-2 py-1 text-xs text-muted-foreground">window read failed: {error}</div>
    );
  }
  if (effective === null) {
    return <div className="h-full min-h-24 motion-safe:animate-pulse rounded bg-muted/40" />;
  }
  return (
    <>
      {/* A transient failure with a retained view is reported by the hook's
          `stale` flag; `error` here covers the same failure seen through this
          component's own window-keyed retention. Either way the notice is the
          honest label for bars that stopped refreshing, never silence. */}
      {stale || error !== null ? (
        <div
          className="px-1 text-[10px] text-muted-foreground"
          data-testid="research-occurrence-stale"
        >
          stale: showing the last good read of this window
        </div>
      ) : null}
      {effective.candles.length < 2 ? (
        <div className="px-2 py-1 text-xs text-muted-foreground">
          Not enough {props.interval} bars recorded around this occurrence.
        </div>
      ) : (
        <MissionPriceChart
          candles={effective.candles}
          eventBands={bands}
          studyOverlay={studyOverlay}
          // A research window carries no position: every execution marker is
          // explicitly null so the chart cannot inherit a stale one.
          entryPrice={null}
          stopPrice={null}
          targetPrice={null}
          liquidationPrice={null}
          entryTime={null}
          markPrice={null}
          pnlSign={null}
          markMotion="static"
          showVolume={false}
          className="h-full min-h-24"
        />
      )}
    </>
  );
}

/**
 * A return and its per-notional illustration, one row: the measured
 * percentage beside the SIGNED gross change on the notional, labelled as
 * exactly that. Never an ending balance, never a profit: the words ride the
 * number so the figure cannot dress up as either.
 */
function ReturnRow(props: { readonly returnPct: number | undefined; readonly notional: number }) {
  if (props.returnPct === undefined) return null;
  const gross = grossChangeUsd(props.notional, props.returnPct);
  return (
    <span
      className={
        props.returnPct >= 0
          ? "text-emerald-600 dark:text-emerald-400"
          : "text-red-600 dark:text-red-400"
      }
    >
      {fmtPct(props.returnPct)} ({fmtUsd(gross)} {historicalGrossChangeLabel(props.notional)})
    </span>
  );
}

/** One covered occurrence row of the report, as the panel reads it. */
type StudyRow = EventStudyScenePayload["report"]["rows"][number];

/** Plain price display, the register the rest of the panel uses. */
const fmtPrice = (value: number): string =>
  value.toLocaleString("en-US", { maximumFractionDigits: 2 });

/**
 * The path_extrema scene's per-occurrence detail, one row: the entry, the
 * named extremum with its date, the MFE excursion beside the hindsight-perfect
 * money at that extremum, and the terminal return beside the fixed-horizon
 * close money — both figures sign-correct for the direction and labelled
 * gross, with the full assumptions sentence riding once under the notional
 * input. Both numbers are always shown together because the honest reading of
 * a hindsight-perfect excursion is only ever next to what holding to the
 * horizon actually did.
 */
function PathExtremumRow(props: {
  readonly row: StudyRow;
  readonly notional: number;
  readonly direction: "short" | "long";
  readonly priceField: "low" | "high";
}) {
  const { row, notional, direction, priceField } = props;
  if (
    !row.covered ||
    row.entryPrice === undefined ||
    row.extremumPrice === undefined ||
    row.extremumTime === undefined ||
    row.excursionReturnPct === undefined ||
    row.returnPct === undefined
  ) {
    // A covered row of a path_extrema study always carries the full set; if a
    // future shape ever does not, the terminal return alone still tells the
    // truth rather than rendering a half-invented extremum.
    return <ReturnRow returnPct={row.returnPct} notional={notional} />;
  }
  const hindsight = hindsightPerfectPnlUsd({
    notionalUsd: notional,
    excursionReturnPct: row.excursionReturnPct,
    direction,
  });
  const fixed = fixedHorizonPnlUsd({ notionalUsd: notional, returnPct: row.returnPct, direction });
  const tone = (value: number): string =>
    value >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400";
  return (
    <span
      className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5"
      data-testid="research-extremum-row"
    >
      <span className="text-muted-foreground">entry {fmtPrice(row.entryPrice)}</span>
      <span>
        {extremumPhrase(priceField)} {fmtPrice(row.extremumPrice)} on{" "}
        {new Date(row.extremumTime).toISOString().slice(0, 10)}
      </span>
      <span className={tone(hindsight)}>
        MFE excursion {fmtPct(row.excursionReturnPct)} ({fmtUsd(hindsight)} hindsight-perfect at the{" "}
        {extremumPhrase(priceField)}, gross)
      </span>
      <span className={tone(fixed)}>
        terminal {fmtPct(row.returnPct)} ({fmtUsd(fixed)} at the horizon close, gross)
      </span>
    </span>
  );
}

/**
 * The calendar view of one event study, split across the graph's fixed
 * geometry: the stage holds the ONE selected occurrence where it happened;
 * the inspector holds everything explanatory — the honesty block, the
 * notional illustration, occurrence navigation and the per-occurrence rows
 * with their sources.
 */
function EventStudyBody(props: {
  readonly environmentId: EnvironmentId;
  readonly payload: EventStudyScenePayload;
  readonly sceneId: string;
  /** The server-composed deterministic layers of this scene, when it has them. */
  readonly layers: ReadonlyArray<DeterministicSceneLayer>;
  readonly prefill: ((sentence: string) => void) | null;
}) {
  const [notional, setNotional] = useState(
    props.payload.illustrativeNotionalUsd ?? NOTIONAL_DEFAULT,
  );
  const [selected, setSelected] = useState(0);
  const { payload } = props;
  const { report } = payload;
  const intervalMs = report.horizonMs / report.horizonBars;
  const rows = report.rows;
  const safeSelected = Math.min(selected, Math.max(0, rows.length - 1));
  const row = rows[safeSelected];
  const window =
    row === undefined
      ? null
      : windowFor({ ...row, covered: row.covered }, report.horizonMs, intervalMs);
  // The path_extrema context: only a scene measured on that metric carries a
  // direction (and its price field), and every money figure below is signed
  // by it. Old scenes decode as forward_return and keep their plain rows.
  const pathExtrema =
    payloadStudyMetric(payload) === "path_extrema"
      ? {
          direction: (payload.direction ?? "short") as "short" | "long",
          priceField: (payload.priceField ?? "low") as "low" | "high",
        }
      : null;

  return (
    <>
      {/* The stage: one occurrence, where it happened. */}
      <div className="flex min-h-0 flex-[2] flex-col" data-testid="research-calendar-stage">
        {row === undefined ? (
          <div className="flex flex-1 items-center justify-center px-2 text-center text-xs text-muted-foreground">
            this study holds no occurrences
          </div>
        ) : window === null ? (
          <div
            className="flex flex-1 items-center justify-center px-2 text-center text-xs text-muted-foreground"
            data-testid="research-occurrence-unmeasured"
          >
            {row.label ?? `occurrence ${safeSelected + 1}`} was not measured: {row.reason}
          </div>
        ) : (
          <OccurrenceChart
            environmentId={props.environmentId}
            market={payload.market}
            interval={payload.interval as ChartInterval}
            window={window}
            occurrence={{ ...row, covered: row.covered }}
            horizonBars={report.horizonBars}
            intervalMs={intervalMs}
            layers={props.layers}
            occurrenceIndex={safeSelected}
          />
        )}
      </div>
      {/* The inspector: everything explanatory scrolls, the frame never grows.
          Data before fine print: the compacted honesty summary, the notional
          and the occurrence rows lead; the full honesty block is the
          disclosure at the end. */}
      <div
        className="trading-graph-inspector min-h-0 flex-[3] overflow-y-auto border-t border-border/60 pt-1"
        data-testid="research-inspector"
      >
        <StudyExplanation payload={payload} />
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
          <label className="text-muted-foreground" htmlFor="research-notional">
            Illustrate per
          </label>
          <input
            id="research-notional"
            type="number"
            min={1}
            value={notional}
            onChange={(event) =>
              setNotional(Math.max(1, Number(event.target.value) || NOTIONAL_DEFAULT))
            }
            className="w-24 rounded border bg-transparent px-1 py-0.5"
          />
          <span className="text-muted-foreground">{PER_NOTIONAL_ILLUSTRATION_LABEL}</span>
        </div>
        {/* The assumptions line every hypothetical PnL figure rides: one
            sentence per scene, beside the notional those figures share. */}
        {pathExtrema !== null ? (
          <div
            className="mt-1 text-[10px] leading-snug text-muted-foreground"
            data-testid="research-extrema-assumptions"
          >
            {PATH_EXTREMA_ASSUMPTIONS_SENTENCE}
          </div>
        ) : null}
        {/* Occurrence navigation: years-apart events are not one unreadable
            chart. Prev/next and the rows below move the measured window that
            fills the stage; the aligned summary is one tab away and never
            lost. */}
        <div className="mt-1 flex items-center gap-2 text-xs" data-testid="research-occurrence-nav">
          <button
            type="button"
            className="rounded border border-border/60 px-2 py-0.5 disabled:opacity-40"
            disabled={safeSelected === 0}
            onClick={() => setSelected(Math.max(0, safeSelected - 1))}
            aria-label="Previous occurrence"
          >
            ←
          </button>
          <span className="text-muted-foreground">
            occurrence {rows.length === 0 ? 0 : safeSelected + 1} of {rows.length}
          </span>
          <button
            type="button"
            className="rounded border border-border/60 px-2 py-0.5 disabled:opacity-40"
            disabled={safeSelected >= rows.length - 1}
            onClick={() => setSelected(Math.min(rows.length - 1, safeSelected + 1))}
            aria-label="Next occurrence"
          >
            →
          </button>
          {row !== undefined && props.prefill !== null ? (
            <button
              type="button"
              className="rounded border border-border/60 px-2 py-0.5 text-muted-foreground hover:text-foreground"
              data-testid={`research-ask-${safeSelected}`}
              onClick={() =>
                props.prefill?.(
                  askAboutOccurrenceSentence({
                    sceneId: props.sceneId,
                    market: payload.market,
                    label: row.label ?? `occurrence ${safeSelected + 1}`,
                    dateIso: new Date(row.startAt).toISOString().slice(0, 10),
                    returnPct: row.returnPct,
                  }),
                )
              }
            >
              Ask about this
            </button>
          ) : null}
        </div>
        <ul className="mt-1 flex flex-col gap-0.5">
          {report.rows.map((candidate, index) => {
            // The time with its precision: an exact instant or window shows
            // the minute, a date (or a legacy span) the day, and the phrase
            // beside it says which claim the timestamps make.
            const iso = new Date(candidate.startAt).toISOString();
            const when =
              candidate.timePrecision === "instant" || candidate.timePrecision === "window"
                ? iso.slice(0, 16)
                : iso.slice(0, 10);
            return (
              <li
                key={`${candidate.startAt}:${index}`}
                className={`flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded border px-1.5 py-0.5 text-xs ${
                  index === safeSelected ? "border-foreground/40" : "border-border/60"
                }`}
                data-testid="research-occurrence"
              >
                <button
                  type="button"
                  className="cursor-pointer font-medium"
                  onClick={() => setSelected(index)}
                >
                  {candidate.label ?? `occurrence ${index + 1}`}
                  <span className="ml-2 font-normal text-muted-foreground">{when}</span>
                </button>
                <span className="text-[10px] text-muted-foreground">
                  {occurrencePrecisionPhrase(candidate.timePrecision)}
                </span>
                {candidate.covered ? (
                  <>
                    {pathExtrema === null ? (
                      <ReturnRow returnPct={candidate.returnPct} notional={notional} />
                    ) : (
                      <PathExtremumRow
                        row={candidate}
                        notional={notional}
                        direction={pathExtrema.direction}
                        priceField={pathExtrema.priceField}
                      />
                    )}
                    {candidate.truncated ? (
                      <span className="text-xs text-amber-600 dark:text-amber-400">
                        truncated at {candidate.barsCovered} bars
                      </span>
                    ) : null}
                  </>
                ) : (
                  <span className="text-muted-foreground">not measured: {candidate.reason}</span>
                )}
                <a
                  className="text-sky-600 underline decoration-dotted dark:text-sky-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500"
                  href={candidate.source.startsWith("http") ? candidate.source : undefined}
                  target="_blank"
                  rel="noreferrer"
                >
                  source
                </a>
              </li>
            );
          })}
        </ul>
      </div>
    </>
  );
}

/**
 * Every covered occurrence rebased to its own measured entry (entry = 100),
 * so the question stops being "what happened next" and starts being "do these
 * shapes resemble each other". Indexed paths are display arithmetic on the
 * same archived bars the calendar view fetched; the aggregate is their mean
 * per bar offset.
 */
/** A covered occurrence with its measured entry present, for the aligned view. */
type CoveredOccurrenceWindow = ResearchOccurrenceWindow & { readonly entryTime: number };

function AlignedTrace(props: {
  readonly environmentId: EnvironmentId;
  readonly market: string;
  readonly interval: ChartInterval;
  readonly intervalMs: number;
  readonly occurrence: CoveredOccurrenceWindow;
  readonly horizonBars: number;
  readonly entryBasis: EventStudyEntryBasis;
}) {
  // The close basis anchors on the entry bar's CLOSE, so its read starts one
  // bar earlier to include that bar and carries one more bar of horizon.
  const closeBasis = props.entryBasis === "first_closed_bar_after_event";
  const { data } = useTradingMarketChart(props.environmentId, props.market, props.interval, {
    enabled: true,
    window: {
      startTime: props.occurrence.entryTime - (closeBasis ? props.intervalMs : 0),
      endTime: (props.occurrence.exitTime ?? props.occurrence.entryTime) + 1,
    },
    maxBars: Math.min(
      props.horizonBars + (closeBasis ? 1 : 0) + 2 * CONTEXT_BARS,
      STUDY_CHART_MAX_WINDOW_BARS,
    ),
    poll: false,
  });
  if (data === null) {
    return <div className="h-[48px] motion-safe:animate-pulse rounded bg-muted/40" />;
  }
  const trace = alignedTracePoints({
    candles: data.candles,
    entryTime: props.occurrence.entryTime,
    intervalMs: props.intervalMs,
    horizonBars: props.horizonBars,
    entryBasis: props.entryBasis,
  });
  if (trace.length < 2) return null;
  return <TraceSvg trace={trace} horizonBars={props.horizonBars} emphasis={false} />;
}

/**
 * One aligned trace, or the aggregate: x is bars since entry, y is percent
 * change from the measured entry. The dashed line at zero is labelled as
 * exactly that (zero change), and the optional `reference` draws the study's
 * baseline as a second, differently-dashed horizontal line with its own
 * label — two flat lines that never get to be mistaken for each other. The
 * aggregate draws heavier.
 */
function TraceSvg(props: {
  readonly trace: ReadonlyArray<{ readonly barsSinceEntry: number; readonly changePct: number }>;
  readonly horizonBars: number;
  readonly emphasis: boolean;
  readonly neutral?: boolean;
  readonly reference?: { readonly valuePct: number; readonly label: string } | null;
}) {
  const width = 240;
  // Traces are compact by design: two ride side by side in the inspector's
  // grid on a desktop-wide drawer, so their height is the grid row's budget.
  const height = 48;
  const step = width / Math.max(1, props.horizonBars);
  const ys = [
    0,
    ...props.trace.map((point) => point.changePct),
    ...(props.reference === null || props.reference === undefined
      ? []
      : [props.reference.valuePct]),
  ];
  const lo = Math.min(...ys);
  const hi = Math.max(...ys);
  const scaleY = (value: number) =>
    height - ((value - lo) / Math.max(1e-9, hi - lo)) * (height - 8) - 4;
  const path = props.trace
    .map(
      (point, index) =>
        `${index === 0 ? "M" : "L"}${(point.barsSinceEntry * step).toFixed(1)},${scaleY(point.changePct).toFixed(1)}`,
    )
    .join(" ");
  const last = props.trace[props.trace.length - 1];
  // Callers guard on length, but the guard belongs where the dereference
  // lives: an empty trace must draw nothing, not read `undefined.changePct`.
  if (last === undefined) return null;
  const tone = props.neutral
    ? "text-muted-foreground"
    : last.changePct >= 0
      ? "text-emerald-500"
      : "text-red-500";
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-full min-h-[48px] w-full" role="img">
      {/* Zero change, said out loud: a flat dashed line beside a baseline
          reference is only honest when each names itself. */}
      <g data-testid="research-zero-line">
        <line
          x1="0"
          x2={width}
          y1={scaleY(0)}
          y2={scaleY(0)}
          stroke="currentColor"
          strokeDasharray="2 3"
          className="text-muted-foreground/40"
        />
        <text
          x={width - 1}
          y={scaleY(0) - 1.5}
          textAnchor="end"
          fontSize="7"
          className="fill-muted-foreground"
        >
          zero change
        </text>
      </g>
      {props.reference === null || props.reference === undefined ? null : (
        <g data-testid="research-baseline-reference">
          <line
            x1="0"
            x2={width}
            y1={scaleY(props.reference.valuePct)}
            y2={scaleY(props.reference.valuePct)}
            stroke="currentColor"
            strokeDasharray="6 3"
            className="text-muted-foreground"
          />
          <text
            x={1}
            y={scaleY(props.reference.valuePct) - 1.5}
            textAnchor="start"
            fontSize="7"
            className="fill-muted-foreground"
          >
            {props.reference.label}
          </text>
        </g>
      )}
      <path
        d={path}
        fill="none"
        strokeWidth={props.emphasis ? 3 : 1.5}
        className={tone}
        stroke="currentColor"
      />
    </svg>
  );
}

/**
 * The event-aligned view of one event study across the graph's fixed
 * geometry: the stage holds the aggregate comparison FIRST — the mean event
 * path against its baseline reference — and the inspector holds the
 * per-occurrence traces and the small-sample honesty.
 */
function EventAlignedBody(props: {
  readonly environmentId: EnvironmentId;
  readonly payload: EventStudyScenePayload;
}) {
  const { payload } = props;
  const entryBasis = payloadEntryBasis(payload);
  const covered = payload.occurrenceWindows.filter(
    (window): window is CoveredOccurrenceWindow => window.covered && window.entryTime !== undefined,
  );
  const baseline = payload.report.baseline;
  return (
    <>
      {/* The stage: the aggregate comparison, first. */}
      <div className="flex min-h-0 flex-[2] flex-col gap-1" data-testid="research-aligned-stage">
        {covered.length === 0 ? (
          <div className="flex flex-1 items-center justify-center px-2 text-center text-xs text-muted-foreground">
            No covered occurrences to align. The calendar view says why each one was not measured.
          </div>
        ) : (
          <>
            {/* The comparison's own numbers, from the report: what the event
                did, what the same horizon did everywhere else, and the
                difference — labelled as derived, never as significance. */}
            <div
              className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs"
              data-testid="research-baseline-summary"
            >
              <span className="font-medium">Event mean {fmtPct(payload.report.meanReturnPct)}</span>
              {baseline === null ? (
                <span className="text-muted-foreground" data-testid="research-baseline-unavailable">
                  {BASELINE_UNAVAILABLE_SENTENCE}
                </span>
              ) : (
                <>
                  <span data-testid="research-baseline-mean">
                    {BASELINE_REFERENCE_LABEL} {fmtPct(baseline.meanReturnPct)}
                  </span>
                  <span
                    className="text-muted-foreground"
                    data-testid="research-baseline-difference"
                  >
                    event minus baseline{" "}
                    {payload.report.meanReturnPct === null
                      ? "-"
                      : fmtPct(payload.report.meanReturnPct - baseline.meanReturnPct)}
                  </span>
                </>
              )}
              <span className="text-muted-foreground">
                {describeHorizon(payload.report.horizonBars, payload.report.horizonMs)}
              </span>
              <span className="text-muted-foreground">
                {covered.length} covered occurrence{covered.length === 1 ? "" : "s"}
              </span>
            </div>
            <div className="min-h-0 flex-1" data-testid="research-aggregate">
              <AggregateTrace
                environmentId={props.environmentId}
                payload={payload}
                covered={covered}
                reference={baselineReference(baseline)}
              />
            </div>
          </>
        )}
      </div>
      {/* The inspector: the study's detail text, per-occurrence shapes, and
          the honesty lines — including the baseline's own numbers (median,
          samples, the overlapping-windows caveat), which live in detail text
          rather than on the stage. Traces flow two per row on a desktop-wide
          drawer so six occurrences do not become six screens of scrolling. */}
      <div
        className="trading-graph-inspector min-h-0 flex-[3] overflow-y-auto border-t border-border/60 pt-1"
        data-testid="research-inspector"
      >
        <StudyExplanation payload={payload} />
        <div className="mt-1 text-xs text-muted-foreground">
          {covered.length} trace(s) rebased to their measured entry; the heavier line above is the
          mean across occurrences, the dashed line is zero change.
        </div>
        {/* Small n is the first thing a reader must know: a mean of two shapes
            is a description, not evidence, and the label says so at a glance. */}
        <div
          className="mt-1 text-xs font-medium text-amber-600 dark:text-amber-400"
          data-testid="research-aligned-smalln"
        >
          n = {covered.length} occurrence{covered.length === 1 ? "" : "s"}
          {covered.length > 0 && covered.length < 5
            ? " (a small sample: descriptive, not evidence)"
            : ""}
        </div>
        <ol className="mt-1 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {covered.map((window, index) => (
            <li
              key={`${window.startAt}:${index}`}
              className="flex flex-col gap-0.5"
              data-testid="research-aligned-trace"
            >
              <div className="flex items-baseline gap-2 text-xs">
                <span className="font-medium">{window.label ?? `occurrence ${index + 1}`}</span>
                <span className="text-muted-foreground">
                  {new Date(window.startAt).toISOString().slice(0, 10)}
                </span>
              </div>
              <div className="min-w-0 flex-1">
                <AlignedTrace
                  environmentId={props.environmentId}
                  market={payload.market}
                  interval={payload.interval as ChartInterval}
                  intervalMs={payload.report.horizonMs / payload.report.horizonBars}
                  occurrence={window}
                  horizonBars={payload.horizonBars}
                  entryBasis={entryBasis}
                />
              </div>
            </li>
          ))}
        </ol>
      </div>
    </>
  );
}

/**
 * The aggregate trace: each covered occurrence's window is fetched by its
 * own hook in a child (rules of hooks), the pure module rebases it, and the
 * parent draws the mean path heavier once every child has answered — beside
 * the baseline reference when the report holds one, and never a line that
 * could be mistaken for one when it does not. Display arithmetic on server
 * bars; per-occurrence numbers are never recomputed.
 */
function AggregateTrace(props: {
  readonly environmentId: EnvironmentId;
  readonly payload: EventStudyScenePayload;
  readonly covered: ReadonlyArray<ResearchOccurrenceWindow>;
  readonly reference: { readonly valuePct: number; readonly label: string } | null;
}) {
  const intervalMs = props.payload.report.horizonMs / props.payload.report.horizonBars;
  const entryBasis = payloadEntryBasis(props.payload);
  const [traces, setTraces] = useState<
    (ReadonlyArray<{ barsSinceEntry: number; changePct: number }> | null)[]
  >(() => props.covered.map(() => null));
  const ready = traces.length > 0 && traces.every((trace) => trace !== null);
  const collected = ready
    ? (traces as ReadonlyArray<ReadonlyArray<{ barsSinceEntry: number; changePct: number }>>)
    : [];
  const aggregate = aggregateAlignedTrace(collected);
  return (
    <>
      {props.covered.map((window, index) => (
        <AggregateTraceFetch
          key={`${window.startAt}:${index}`}
          environmentId={props.environmentId}
          market={props.payload.market}
          interval={props.payload.interval as ChartInterval}
          intervalMs={intervalMs}
          horizonBars={props.payload.horizonBars}
          entryBasis={entryBasis}
          occurrence={window}
          onTrace={(points) =>
            setTraces((previous) => {
              if (previous[index] !== null) return previous;
              const next = [...previous];
              next[index] = points;
              return next;
            })
          }
        />
      ))}
      {!ready ? (
        <div className="h-full min-h-24 motion-safe:animate-pulse rounded bg-muted/40" />
      ) : aggregate.points.length < 2 ? (
        <div className="text-xs text-muted-foreground">not enough bars to aggregate</div>
      ) : (
        <TraceSvg
          trace={aggregate.points}
          horizonBars={props.payload.horizonBars}
          emphasis
          reference={props.reference}
        />
      )}
    </>
  );
}

function AggregateTraceFetch(props: {
  readonly environmentId: EnvironmentId;
  readonly market: string;
  readonly interval: ChartInterval;
  readonly intervalMs: number;
  readonly horizonBars: number;
  readonly entryBasis: EventStudyEntryBasis;
  readonly occurrence: ResearchOccurrenceWindow;
  readonly onTrace: (points: ReadonlyArray<{ barsSinceEntry: number; changePct: number }>) => void;
}) {
  // Same window rule as AlignedTrace: the close basis needs the entry bar,
  // whose open sits one full interval before the entry close it anchors on.
  const closeBasis = props.entryBasis === "first_closed_bar_after_event";
  const entryTime = props.occurrence.entryTime ?? props.occurrence.startAt;
  const { data } = useTradingMarketChart(props.environmentId, props.market, props.interval, {
    enabled: true,
    window: {
      startTime: entryTime - (closeBasis ? props.intervalMs : 0),
      endTime: (props.occurrence.exitTime ?? entryTime) + 1,
    },
    maxBars: Math.min(
      props.horizonBars + (closeBasis ? 1 : 0) + 2 * CONTEXT_BARS,
      STUDY_CHART_MAX_WINDOW_BARS,
    ),
    poll: false,
  });
  useEffect(() => {
    if (data === null || props.occurrence.entryTime === undefined) return;
    props.onTrace(
      alignedTracePoints({
        candles: data.candles,
        entryTime: props.occurrence.entryTime,
        intervalMs: props.intervalMs,
        horizonBars: props.horizonBars,
        entryBasis: props.entryBasis,
      }),
    );
  }, [data, props]);
  return null;
}

function StrategyReplayBody(props: {
  readonly environmentId: EnvironmentId;
  readonly payload: StrategyReplayScenePayload;
}) {
  const { payload } = props;
  const trades = payload.trades;
  const first = trades[0]?.entryTime ?? payload.archiveBounds.fromT;
  const last = trades[trades.length - 1]?.exitTime ?? payload.archiveBounds.toT;
  const window: ChartWindow = { startTime: first - 6 * 60_000, endTime: last + 6 * 60_000 };
  const bands = trades.map((trade, index) => ({
    key: `trade:${index}:${trade.entryTime}`,
    label: `t${index + 1}`,
    startAt: trade.entryTime,
    endAt: trade.entryTime,
    upcoming: false,
  }));
  return (
    // A replay is a document, not a stage/inspector split: it scrolls inside
    // the fixed viewport instead of growing it.
    <div
      className="trading-graph-inspector flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto"
      data-testid="research-inspector"
    >
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>{trades.length} trade(s) shown</span>
        <span>win rate {payload.winRatePercent}%</span>
        <span>expectancy {fmtUsd(payload.expectancyUsd)} per trade after fees and funding</span>
        <span>total fees {fmtUsd(payload.totalFeesUsd)}</span>
      </div>
      <div className="text-sm">{payload.verdictReason}</div>
      <ReplayWindowChart
        environmentId={props.environmentId}
        market={payload.thesis.market}
        interval={payload.interval as ChartInterval}
        window={window}
        bands={bands}
      />
      <ol className="flex flex-col gap-1 text-xs">
        {trades.map((trade, index) => (
          <li key={`${trade.entryTime}:${index}`} className="flex flex-wrap gap-x-3">
            <span className="text-muted-foreground">
              {new Date(trade.entryTime).toISOString().slice(0, 16)}
            </span>
            <span
              className={
                trade.netUsd >= 0
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-red-600 dark:text-red-400"
              }
            >
              {fmtUsd(trade.netUsd)}
            </span>
            <span className="text-muted-foreground">{trade.exitReason}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function ReplayWindowChart(props: {
  readonly environmentId: EnvironmentId;
  readonly market: string;
  readonly interval: ChartInterval;
  readonly window: ChartWindow;
  readonly bands: ReadonlyArray<{
    key: string;
    label: string;
    startAt: number;
    endAt: number;
    upcoming: boolean;
  }>;
}) {
  const { data, error } = useTradingMarketChart(props.environmentId, props.market, props.interval, {
    enabled: true,
    window: props.window,
    maxBars: STUDY_CHART_MAX_WINDOW_BARS,
    poll: false,
  });
  if (error !== null) {
    return <div className="text-xs text-muted-foreground">window read failed: {error}</div>;
  }
  if (data === null) {
    return <div className="h-[160px] motion-safe:animate-pulse rounded bg-muted/40" />;
  }
  if (data.candles.length < 2) {
    return (
      <div className="text-xs text-muted-foreground">
        Not enough bars recorded over the replay window.
      </div>
    );
  }
  return (
    <MissionPriceChart
      candles={data.candles}
      eventBands={props.bands}
      // Replay markers arrive as event bands; the execution-price rails are
      // not this scene's to draw, so they are null, not absent.
      entryPrice={null}
      stopPrice={null}
      targetPrice={null}
      liquidationPrice={null}
      entryTime={null}
      markPrice={null}
      pnlSign={null}
      markMotion="static"
      showVolume={false}
      className="h-[160px]"
    />
  );
}

/**
 * The published scenes of one thread, rendered inside the graph's one fixed
 * plot stage: the mode tabs live on the outer graph (this panel receives the
 * mode), the picture fills the stage's upper half, and everything
 * explanatory scrolls in the inspector below it. Research never expands the
 * outer frame.
 */
export function ResearchScenePanel(props: {
  readonly environmentId: EnvironmentId;
  readonly scenes: ReadonlyArray<ResearchSceneView>;
  readonly loading: boolean;
  readonly error: string | null;
  /** The research mode the outer graph's tabs selected (Live lives outside). */
  readonly mode: "calendar" | "aligned";
  /** The thread composer prefill; null on the trade home (no conversation). */
  readonly prefill: ((sentence: string) => void) | null;
}) {
  const [sceneIndex, setSceneIndex] = useState(0);
  const scene = props.scenes[Math.min(sceneIndex, Math.max(0, props.scenes.length - 1))];
  // A const binding keeps the `eventStudy` narrowing inside the click
  // handlers below, where a property access on `scene` would lose it.
  const study = scene?.eventStudy;

  useEffect(() => {
    if (sceneIndex >= props.scenes.length) setSceneIndex(0);
  }, [props.scenes.length, sceneIndex]);

  // The error, loading and empty states keep the panel's shape: a message
  // where the content would sit, never a different frame.
  if (props.error !== null) {
    return (
      <div
        className="flex flex-1 items-center justify-center rounded border border-border/60 p-2 text-center text-xs text-muted-foreground"
        data-testid="research-scenes-error"
      >
        research scenes unavailable: {props.error}
      </div>
    );
  }
  if (scene === undefined) {
    if (props.loading) {
      return (
        <div
          className="h-full min-h-24 motion-safe:animate-pulse rounded bg-muted/40"
          data-testid="research-scenes-loading"
        />
      );
    }
    return null;
  }

  return (
    <section className="flex h-full min-h-0 flex-col gap-1" data-testid="research-scene-panel">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {props.scenes.length > 1 ? (
            <select
              aria-label="Research scene"
              className="max-w-56 truncate rounded border bg-transparent px-1 py-0.5 text-xs"
              value={sceneIndex}
              onChange={(event) => setSceneIndex(Number(event.target.value))}
            >
              {props.scenes.map((candidate, index) => (
                <option key={candidate.sceneId} value={index}>
                  {candidate.title}
                </option>
              ))}
            </select>
          ) : (
            <h3 className="truncate text-sm font-medium">{scene.title}</h3>
          )}
          {scene.referenceStatus === "retired" ? (
            <span
              className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-600 dark:text-amber-400"
              data-testid="research-reference-retired"
            >
              stale artifact: the event set this study was computed from has been retired; these
              numbers describe what was archived then
            </span>
          ) : null}
        </div>
        <span
          className="text-[10px] uppercase tracking-wide text-muted-foreground"
          data-testid="research-disclaimer"
        >
          {RESEARCH_DISCLAIMER}
        </span>
      </header>
      {/* Stage content and inspector share the fixed viewport; the mode is
          the outer graph's tab, never a second switcher here. */}
      <div className="flex min-h-0 flex-1 flex-col" data-testid="research-scene-body">
        {scene.eventStudy !== undefined ? (
          props.mode === "calendar" ? (
            // Keyed by scene id so a newly published scene (with its own
            // persisted notional and basis) reinitializes the body's local
            // state instead of carrying the previous scene's numbers forward.
            <EventStudyBody
              key={scene.sceneId}
              environmentId={props.environmentId}
              payload={scene.eventStudy}
              sceneId={scene.sceneId}
              layers={scene.scene?.deterministic ?? []}
              prefill={props.prefill}
            />
          ) : (
            <EventAlignedBody environmentId={props.environmentId} payload={scene.eventStudy} />
          )
        ) : scene.strategyReplay !== undefined ? (
          <StrategyReplayBody environmentId={props.environmentId} payload={scene.strategyReplay} />
        ) : scene.annotation !== undefined ? (
          <div
            className="trading-graph-inspector flex min-h-0 flex-1 flex-col overflow-y-auto text-sm"
            data-testid="research-inspector"
          >
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
              model note
            </span>{" "}
            {scene.annotation.text}
            <div className="mt-1 text-xs text-muted-foreground">
              pinned to {new Date(scene.annotation.at).toISOString().slice(0, 16)} on{" "}
              {scene.annotation.market}
            </div>
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center px-2 text-center text-xs text-muted-foreground">
            this scene predates the current format and no longer renders
          </div>
        )}
      </div>
      {/* What is derived and what is authored, said once, and where it goes:
          the graph shows research, and research distinguishes its numbers
          from its prose. The next-step controls are prefills only; nothing
          here plans, arms, or trades on click. */}
      <footer className="flex flex-col gap-1 border-t border-border/60 pt-1">
        {scene.eventStudy !== undefined ? (
          <span className="text-[10px] text-muted-foreground" data-testid="research-provenance">
            {provenanceTrailLine(scene.eventStudy)}
          </span>
        ) : null}
        <span className="text-[10px] text-muted-foreground" data-testid="research-marker-legend">
          {MARKER_LEGEND_SENTENCE}
        </span>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] text-muted-foreground">{DERIVED_VS_AUTHORED_SENTENCE}</span>
          {study !== undefined && props.prefill !== null ? (
            <span className="ml-auto flex gap-1">
              <button
                type="button"
                className="rounded border border-border/60 px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
                data-testid="research-next-strategy"
                onClick={() =>
                  props.prefill?.(turnIntoStrategySentence(study.market, study.eventSetName))
                }
              >
                Turn this into a strategy
              </button>
              <button
                type="button"
                className="rounded border border-border/60 px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
                data-testid="research-next-validate"
                onClick={() =>
                  props.prefill?.(validateForwardSentence(study.market, study.eventSetName))
                }
              >
                Validate this forward
              </button>
            </span>
          ) : null}
        </div>
      </footer>
    </section>
  );
}
