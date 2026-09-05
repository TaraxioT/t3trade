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

import { Button } from "../ui/button";
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
  alignedExtremumMark,
  alignedTracePoints,
  askAboutOccurrenceSentence,
  BASELINE_REFERENCE_LABEL,
  BASELINE_UNAVAILABLE_SENTENCE,
  baselineReference,
  DERIVED_VS_AUTHORED_SENTENCE,
  describeHorizon,
  extremumBarPhrase,
  extremumCoincidenceSentence,
  extremumPhrase,
  extremumRuleMarker,
  fixedHorizonPnlUsd,
  fmtPrice,
  fmtUsd,
  grossChangeUsd,
  hindsightPerfectPnlUsd,
  historicalGrossChangeLabel,
  isLegacyEventStudyScene,
  MARKER_LEGEND_SENTENCE,
  occurrencePrecisionPhrase,
  occurrenceStudyOverlay,
  PATH_EXTREMA_ASSUMPTIONS_SENTENCE,
  payloadEntryBasis,
  payloadStudyMetric,
  provenanceTrailLine,
  REPLAY_MARKER_WINDOW,
  replayEntryBandLabel,
  replayEntryRuleLabel,
  replayExitRuleLabel,
  replayShowingSentence,
  studyExplanationLines,
  studyWindowMaxBars,
  turnIntoStrategySentence,
  validateForwardSentence,
} from "./researchScenePresentation.ts";
import type { DeterministicSceneLayer } from "@t3tools/contracts";
import type { ChartResearchMarkerInput } from "./missionChartGeometry.ts";
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
function StudyExplanation(props: {
  readonly payload: EventStudyScenePayload;
  /** The scene row's calculation version, so a legacy scene says it is legacy. */
  readonly calculationVersion?: string | undefined;
}) {
  const lines = studyExplanationLines(
    props.calculationVersion === undefined
      ? props.payload
      : { ...props.payload, calculationVersion: props.calculationVersion },
  );
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
 *
 * On a path_extrema occurrence measured by the current engine, the hindsight
 * extremum ALSO draws — a dotted rule at the extremum bar's open time with
 * its price, derived from the same report row the layers were composed from.
 * It is a different artifact from the terminal close, and the two stay
 * separate markers even when they land on the same bar.
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
  readonly sceneId: string;
  /** The selected report row, for the pieces the deterministic layers do not carry. */
  readonly row: StudyRow;
  /**
   * The path_extrema context, only on scenes measured by the current engine:
   * legacy scenes keep their recorded numbers and their legacy line, never a
   * newly-corrected extremum marker.
   */
  readonly extremumContext: {
    readonly priceField: "low" | "high";
    readonly interval: string;
  } | null;
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
    // The row rides every call so the exit label can state what the window
    // actually measured (the full horizon, or its truncation); the extremum
    // piece additionally requires the current-engine context — a legacy
    // scene's rows keep their numbers in the inspector, never a
    // newly-corrected hindsight marker on the chart.
    const overlay = occurrenceStudyOverlay(props.layers, props.occurrenceIndex, props.horizonBars, {
      row: props.row,
      priceField: props.extremumContext?.priceField ?? "low",
      interval: props.extremumContext?.interval ?? props.interval,
    });
    const gated = props.extremumContext === null ? { ...overlay, extremum: null } : overlay;
    // An instantaneous activation has no event_span band — the composer
    // refuses zero-width spans — so its named rule comes from the occurrence
    // window itself, at the exact instant it claims. The label is the
    // occurrence's own, never a number re-derived here.
    if (
      gated.activation === null &&
      props.occurrence.timePrecision === "instant" &&
      props.occurrence.startAt === props.occurrence.endAt
    ) {
      return {
        ...gated,
        activation: {
          at: props.occurrence.endAt,
          label: props.occurrence.label ?? `occurrence ${props.occurrenceIndex + 1}`,
        },
      };
    }
    return gated;
  }, [
    props.layers,
    props.occurrenceIndex,
    props.horizonBars,
    props.occurrence,
    props.row,
    props.extremumContext,
    props.interval,
  ]);
  // The extremum rule: same report row as the exit square, its own marker.
  // Out of the loaded window the geometry drops it honestly rather than
  // pinning it at an edge.
  const extremumMarker: ChartResearchMarkerInput | null =
    studyOverlay.extremum === null
      ? null
      : extremumRuleMarker({
          sceneId: props.sceneId,
          occurrenceIndex: props.occurrenceIndex,
          at: studyOverlay.extremum.at,
          price: studyOverlay.extremum.price,
          priceField: props.extremumContext?.priceField ?? "low",
          interval: props.extremumContext?.interval ?? props.interval,
          source: props.row.source,
        });
  // Coincidence never swallows a marker: when the extremum bar IS the exit
  // bar, the sentence says both draw there, each with its own price.
  const coincidence =
    extremumMarker !== null &&
    studyOverlay.exit !== null &&
    studyOverlay.extremum !== null &&
    studyOverlay.extremum.at === studyOverlay.exit.at
      ? extremumCoincidenceSentence(
          props.extremumContext?.priceField ?? "low",
          props.extremumContext?.interval ?? props.interval,
          studyOverlay.extremum.at,
        )
      : null;

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
          researchMarkers={extremumMarker === null ? [] : [extremumMarker]}
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
      {coincidence === null ? null : (
        <div
          className="px-1 text-[10px] text-muted-foreground"
          data-testid="research-extremum-coincident"
        >
          {coincidence}
        </div>
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
  readonly interval: string;
}) {
  const { row, notional, direction, priceField, interval } = props;
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
      {/* The extremum claims its BAR, never an instant: the row records the
          bar's open time, and the phrase says exactly that. */}
      <span>
        {extremumBarPhrase(priceField, interval, row.extremumTime)}: {fmtPrice(row.extremumPrice)}
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
  /** The scene row's calculation version, so legacy scenes can say so. */
  readonly calculationVersion?: string | undefined;
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
  // The hindsight-extremum marker draws only where the CURRENT engine
  // measured the row: a legacy-calculation scene keeps its recorded numbers
  // (the inspector rows and the legacy line) and must not pass them off as
  // newly-corrected geometry. The row itself still rides every overlay call
  // so the exit label states the truth about the window that was measured.
  const drawExtremum =
    pathExtrema !== null &&
    !isLegacyEventStudyScene({ ...payload, calculationVersion: props.calculationVersion });

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
            sceneId={props.sceneId}
            row={row}
            extremumContext={
              drawExtremum && pathExtrema !== null
                ? { priceField: pathExtrema.priceField, interval: payload.interval }
                : null
            }
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
        <StudyExplanation payload={payload} calculationVersion={props.calculationVersion} />
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
                        interval={payload.interval}
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
  /**
   * The row's hindsight extremum as a mark on the trace, only on current-engine
   * path_extrema scenes: the requested extreme beside the horizon's terminal
   * close, both labelled, neither drawn as the other.
   */
  readonly extremumMark: { readonly barsSinceEntry: number; readonly changePct: number } | null;
  readonly extremumPhraseText: string | null;
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
  return (
    <TraceSvg
      trace={trace}
      horizonBars={props.horizonBars}
      emphasis={false}
      extremumMark={props.extremumMark}
      extremumLabel={props.extremumPhraseText}
    />
  );
}

/**
 * One aligned trace, or the aggregate: x is bars since entry, y is percent
 * change from the measured entry. The dashed line at zero is labelled as
 * exactly that (zero change), and the optional `reference` draws the study's
 * baseline as a second, differently-dashed horizontal line with its own
 * label — two flat lines that never get to be mistaken for each other. The
 * aggregate draws heavier.
 *
 * On a path_extrema trace the two artifacts of the question are marked where
 * they land: a ring at the row's hindsight extremum (its excursion, in the
 * trace's own long-convention percent) and a square at the terminal close —
 * the horizon's end. The excursion joins the y-range so the ring never clips,
 * and each mark names itself in a title, so coincidence never swallows one.
 */
function TraceSvg(props: {
  readonly trace: ReadonlyArray<{ readonly barsSinceEntry: number; readonly changePct: number }>;
  readonly horizonBars: number;
  readonly emphasis: boolean;
  readonly neutral?: boolean;
  readonly reference?: { readonly valuePct: number; readonly label: string } | null;
  readonly extremumMark?: { readonly barsSinceEntry: number; readonly changePct: number } | null;
  readonly extremumLabel?: string | null;
}) {
  const width = 240;
  // Traces are compact by design: two ride side by side in the inspector's
  // grid on a desktop-wide drawer, so their height is the grid row's budget.
  const height = 48;
  const step = width / Math.max(1, props.horizonBars);
  const extremum =
    props.extremumMark === undefined || props.extremumMark === null ? null : props.extremumMark;
  const ys = [
    0,
    ...props.trace.map((point) => point.changePct),
    ...(props.reference === null || props.reference === undefined
      ? []
      : [props.reference.valuePct]),
    ...(extremum === null ? [] : [extremum.changePct]),
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
      {extremum === null ? null : (
        <g data-testid="research-trace-extremum">
          <circle
            cx={(extremum.barsSinceEntry * step).toFixed(1)}
            cy={scaleY(extremum.changePct)}
            r={3}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            className="text-muted-foreground"
          >
            {/* The row's hindsight extremum, its bar offset and its measured
                excursion: the requested extreme, not the terminal close. A
                single template string because <title> takes text, not nodes. */}
            <title>{`${
              props.extremumLabel ?? "extremum"
            } (hindsight) at bar ${extremum.barsSinceEntry} of ${
              props.horizonBars
            }, excursion ${extremum.changePct.toFixed(2)}%`}</title>
          </circle>
        </g>
      )}
      <g data-testid="research-trace-terminal">
        <rect
          x={last.barsSinceEntry * step - 2.5}
          y={scaleY(last.changePct) - 2.5}
          width={5}
          height={5}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          className="text-muted-foreground"
        >
          {/* The terminal close at the horizon's end — the study exit's own
              artifact on the aligned stage, distinct from the ring above. */}
          <title>{`terminal close at the horizon, bar ${last.barsSinceEntry} of ${
            props.horizonBars
          }, ${last.changePct.toFixed(2)}%`}</title>
        </rect>
      </g>
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
  /** The scene row's calculation version, so legacy scenes can say so. */
  readonly calculationVersion?: string | undefined;
}) {
  const { payload } = props;
  const entryBasis = payloadEntryBasis(payload);
  // Occurrence windows and report rows are parallel arrays (the server maps
  // one from the other), so each covered window carries its own row into the
  // aligned view — the extremum the row measured, never a re-derivation.
  const covered = payload.occurrenceWindows
    .map((window, index) => ({ window, row: payload.report.rows[index] }))
    .filter(
      (pair): pair is { window: CoveredOccurrenceWindow; row: StudyRow } =>
        pair.window.covered && pair.window.entryTime !== undefined,
    );
  const baseline = payload.report.baseline;
  const intervalMs = payload.report.horizonMs / payload.report.horizonBars;
  // The extremum ring draws only on current-engine path_extrema scenes: the
  // requested extreme marked beside the horizon's terminal close, and legacy
  // numbers kept as recorded rather than masquerading as corrected geometry.
  const extremumScene =
    payloadStudyMetric(payload) === "path_extrema" &&
    !isLegacyEventStudyScene({ ...payload, calculationVersion: props.calculationVersion });
  const extremumPhraseText =
    extremumScene && payload.priceField !== undefined ? extremumPhrase(payload.priceField) : null;
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
        <StudyExplanation payload={payload} calculationVersion={props.calculationVersion} />
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
          {covered.map(({ window, row }, index) => (
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
                  intervalMs={intervalMs}
                  occurrence={window}
                  horizonBars={payload.horizonBars}
                  entryBasis={entryBasis}
                  extremumMark={
                    extremumScene
                      ? alignedExtremumMark({
                          row,
                          entryTime: window.entryTime,
                          entryBasis,
                          intervalMs,
                          lastBar: payload.horizonBars,
                        })
                      : null
                  }
                  extremumPhraseText={extremumPhraseText}
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
  readonly covered: ReadonlyArray<{ readonly window: ResearchOccurrenceWindow }>;
  readonly reference: { readonly valuePct: number; readonly label: string } | null;
}) {
  const intervalMs = props.payload.report.horizonMs / props.payload.report.horizonBars;
  const entryBasis = payloadEntryBasis(props.payload);
  // Slots are keyed by OCCURRENCE IDENTITY, never array position: the
  // covered list can grow, shrink or reorder between reads, and a positional
  // slot would either keep a departed occurrence's trace or leave a hole an
  // arriving one can never fill. Each slot carries its own outcome — a
  // failed or empty fetch is a stated fact beside the aggregate, never a
  // phantom success and never an eternal skeleton.
  type TraceSlot =
    | {
        readonly status: "ok";
        readonly points: ReadonlyArray<{ barsSinceEntry: number; changePct: number }>;
      }
    | { readonly status: "empty" }
    | { readonly status: "failed" };
  const slotKey = (window: ResearchOccurrenceWindow) => `${window.startAt}:${window.endAt}`;
  const [slots, setSlots] = useState<ReadonlyMap<string, TraceSlot>>(new Map());
  const recordSlot = (window: ResearchOccurrenceWindow, slot: TraceSlot) =>
    setSlots((previous) => {
      const key = slotKey(window);
      if (previous.get(key)?.status === "ok") return previous;
      const next = new Map(previous);
      next.set(key, slot);
      return next;
    });
  const settled = props.covered.map(({ window }) => slots.get(slotKey(window)) ?? null);
  const ready = settled.length > 0 && settled.every((slot) => slot !== null);
  const failedCount = settled.filter((slot) => slot?.status === "failed").length;
  const emptyCount = settled.filter((slot) => slot?.status === "empty").length;
  const collected = ready
    ? settled.flatMap((slot) => (slot !== null && slot.status === "ok" ? [slot.points] : []))
    : [];
  const aggregate = aggregateAlignedTrace(collected);
  return (
    <>
      {props.covered.map(({ window }) => (
        <AggregateTraceFetch
          key={slotKey(window)}
          environmentId={props.environmentId}
          market={props.payload.market}
          interval={props.payload.interval as ChartInterval}
          intervalMs={intervalMs}
          horizonBars={props.payload.horizonBars}
          entryBasis={entryBasis}
          occurrence={window}
          onTrace={(points) =>
            recordSlot(window, points.length === 0 ? { status: "empty" } : { status: "ok", points })
          }
          onFailed={() => recordSlot(window, { status: "failed" })}
        />
      ))}
      {!ready ? (
        <div className="h-full min-h-24 motion-safe:animate-pulse rounded bg-muted/40" />
      ) : aggregate.points.length < 2 ? (
        <div className="text-xs text-muted-foreground" data-testid="aligned-aggregate-empty">
          not enough bars to aggregate
          {failedCount > 0 ? ` — ${failedCount} trace fetch(es) failed` : ""}
        </div>
      ) : (
        <>
          <TraceSvg
            trace={aggregate.points}
            horizonBars={props.payload.horizonBars}
            emphasis
            reference={props.reference}
          />
          {failedCount + emptyCount > 0 ? (
            <div
              className="px-1 text-[10px] text-muted-foreground"
              data-testid="aligned-trace-coverage"
            >
              aggregate over {collected.length} trace(s)
              {emptyCount > 0 ? `, ${emptyCount} with no usable bars` : ""}
              {failedCount > 0
                ? `, ${failedCount} unavailable (fetch failed — not an empty path)`
                : ""}
            </div>
          ) : null}
        </>
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
  /** Called once when this fetch has FAILED — a stated outcome, not a skeleton. */
  readonly onFailed: () => void;
}) {
  // Same window rule as AlignedTrace: the close basis needs the entry bar,
  // whose open sits one full interval before the entry close it anchors on.
  const closeBasis = props.entryBasis === "first_closed_bar_after_event";
  const entryTime = props.occurrence.entryTime ?? props.occurrence.startAt;
  const { data, error } = useTradingMarketChart(props.environmentId, props.market, props.interval, {
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
  // A failed read settles this occurrence's slot as failed: the aggregate
  // keeps the survivors and the coverage line says what is missing, instead
  // of a skeleton that can never resolve or an empty trace that reads as a
  // path that went nowhere.
  useEffect(() => {
    if (error !== null) props.onFailed();
  }, [error, props]);
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

/**
 * The strategy replay, drawn as complete trade geometry: every VISIBLE trade
 * renders both of its markers — an entry (a wash band plus a rule labelled
 * with the thesis's side and the entry price) and an exit (its own rule with
 * the exit price, the exit reason and the net result). The display window is
 * capped, so a long run stays readable; the showing line keeps the taken
 * count, the persisted count and the drawn slice distinct, and bounded
 * navigation reaches the omitted trades. The thesis is single-sided, so its
 * side is every trade's side — a record, never an inference from prices.
 */
function StrategyReplayBody(props: {
  readonly environmentId: EnvironmentId;
  readonly payload: StrategyReplayScenePayload;
}) {
  const { payload } = props;
  const trades = payload.trades;
  const side = payload.thesis.side;
  const [offset, setOffset] = useState(0);
  // Bounded navigation: the window moves in fixed steps and can never leave
  // [0, persisted − window], so the omitted trades are reachable, not lost.
  const maxOffset = Math.max(0, trades.length - REPLAY_MARKER_WINDOW);
  const safeOffset = Math.min(offset, maxOffset);
  const visible = trades.slice(safeOffset, safeOffset + REPLAY_MARKER_WINDOW);
  const first = visible[0]?.entryTime ?? payload.archiveBounds.fromT;
  const last =
    visible[visible.length - 1]?.exitTime ??
    trades[trades.length - 1]?.exitTime ??
    payload.archiveBounds.toT;
  const window: ChartWindow = { startTime: first - 6 * 60_000, endTime: last + 6 * 60_000 };
  const bands = visible.map((trade, i) => ({
    key: `trade:${safeOffset + i}:entry:${trade.entryTime}`,
    label: replayEntryBandLabel(safeOffset + i),
    startAt: trade.entryTime,
    endAt: trade.entryTime,
    upcoming: false,
  }));
  const markers: ReadonlyArray<ChartResearchMarkerInput> = visible.flatMap((trade, i) => {
    const index = safeOffset + i;
    return [
      {
        key: `trade:${index}:entry:${trade.entryTime}`,
        label: replayEntryRuleLabel(trade, index, side),
        startAt: trade.entryTime,
        endAt: trade.entryTime,
        sourceUrl: "",
        covered: true,
        upcoming: false,
      },
      {
        key: `trade:${index}:exit:${trade.exitTime}`,
        label: replayExitRuleLabel(trade, index),
        startAt: trade.exitTime,
        endAt: trade.exitTime,
        sourceUrl: "",
        covered: true,
        upcoming: false,
      },
    ];
  });
  return (
    // A replay is a document, not a stage/inspector split: it scrolls inside
    // the fixed viewport instead of growing it.
    <div
      className="trading-graph-inspector flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto"
      data-testid="research-inspector"
    >
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>{payload.tradesTaken} trade(s) taken</span>
        <span>win rate {payload.winRatePercent}%</span>
        <span>expectancy {fmtUsd(payload.expectancyUsd)} per trade after fees and funding</span>
        <span>total fees {fmtUsd(payload.totalFeesUsd)}</span>
      </div>
      <div className="text-sm">{payload.verdictReason}</div>
      <div className="flex items-center gap-2 text-xs" data-testid="research-replay-nav">
        <button
          type="button"
          className="rounded border border-border/60 px-2 py-0.5 disabled:opacity-40"
          disabled={safeOffset === 0}
          onClick={() => setOffset(Math.max(0, safeOffset - REPLAY_MARKER_WINDOW))}
          aria-label="Previous trades"
        >
          ←
        </button>
        <span className="text-muted-foreground" data-testid="research-replay-showing">
          {replayShowingSentence({
            fromIndex: safeOffset,
            drawn: visible.length,
            persisted: trades.length,
            taken: payload.tradesTaken,
          })}
        </span>
        <button
          type="button"
          className="rounded border border-border/60 px-2 py-0.5 disabled:opacity-40"
          disabled={safeOffset >= maxOffset}
          onClick={() => setOffset(Math.min(maxOffset, safeOffset + REPLAY_MARKER_WINDOW))}
          aria-label="Next trades"
        >
          →
        </button>
      </div>
      <ReplayWindowChart
        environmentId={props.environmentId}
        market={payload.thesis.market}
        interval={payload.interval as ChartInterval}
        window={window}
        bands={bands}
        markers={markers}
      />
      <ol className="flex flex-col gap-1 text-xs">
        {visible.map((trade, i) => (
          <li
            key={`${trade.entryTime}:${safeOffset + i}`}
            data-testid="research-replay-trade"
            className="flex flex-wrap items-baseline gap-x-3"
          >
            <span className="text-muted-foreground">
              t{safeOffset + i + 1} {side}
            </span>
            <span>
              {new Date(trade.entryTime).toISOString().slice(0, 16)} →{" "}
              {new Date(trade.exitTime).toISOString().slice(0, 16)}
            </span>
            <span>
              entry {fmtPrice(trade.entryPrice)} → exit {fmtPrice(trade.exitPrice)}
            </span>
            <span
              className={
                trade.netUsd >= 0
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-red-600 dark:text-red-400"
              }
            >
              {fmtUsd(trade.netUsd)} net
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
  readonly markers: ReadonlyArray<ChartResearchMarkerInput>;
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
      researchMarkers={props.markers}
      // Replay trades draw as bands and research rules — counterfactual
      // measurements of a backtest, never fills; the execution-price rails
      // are not this scene's to draw, so they are null, not absent.
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
  /** The identity-keyed selection the outer graph owns; null falls back to the first scene. */
  readonly selectedSceneId: string | null;
  readonly onSelectScene: (sceneId: string) => void;
  /**
   * The explicit open/focus intent: select by identity, switch the outer
   * graph to the framing view, and re-fit. Publication made a scene active;
   * only this is the ask to SEE it.
   */
  readonly onOpenScene: (sceneId: string) => void;
  readonly loading: boolean;
  readonly error: string | null;
  /** Retries the scenes read when a refresh failed over a kept picture. */
  readonly onRetry?: (() => void) | undefined;
  /** The research mode the outer graph's tabs selected (Live lives outside). */
  readonly mode: "calendar" | "aligned";
  /** The thread composer prefill; null on the trade home (no conversation). */
  readonly prefill: ((sentence: string) => void) | null;
}) {
  // Selection is keyed by scene ID, never array position: the server's
  // newest-first order can change between polls, and an index would silently
  // point at another scene. The parent owns the id; the local state exists
  // only for the parent-less fallback (direct render sites under 1 scene).
  const scene =
    props.scenes.find((candidate) => candidate.sceneId === props.selectedSceneId) ??
    props.scenes[0];
  const sceneId = scene?.sceneId ?? null;
  // A const binding keeps the `eventStudy` narrowing inside the click
  // handlers below, where a property access on `scene` would lose it.
  const study = scene?.eventStudy;

  // The error and empty states keep the panel's shape: a message where the
  // content would sit, never a different frame. A refresh failure with
  // scenes already in hand is a STALE notice over the kept picture plus a
  // retry — the cached scenes are never discarded visually, which is what an
  // early error return used to do.
  if (props.error !== null && (scene === undefined || props.scenes.length === 0)) {
    return (
      <div
        className="flex flex-1 items-center justify-center rounded border border-border/60 p-2 text-center text-xs text-muted-foreground"
        data-testid="research-scenes-error"
      >
        research scenes unavailable: {props.error}
      </div>
    );
  }
  const staleNotice =
    props.error !== null ? (
      <div
        className="flex items-center gap-2 rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-600 dark:text-amber-400"
        data-testid="research-scenes-stale"
      >
        <span>scene refresh failed — showing the last good read ({props.error})</span>
        {props.onRetry === undefined ? null : (
          <button
            type="button"
            className="cursor-pointer underline"
            data-testid="research-scenes-retry"
            onClick={props.onRetry}
          >
            retry
          </button>
        )}
      </div>
    ) : null;
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
        {staleNotice}
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {props.scenes.length > 1 ? (
            <select
              aria-label="Research scene"
              className="max-w-56 truncate rounded border bg-transparent px-1 py-0.5 text-xs"
              value={sceneId ?? undefined}
              onChange={(event) => props.onSelectScene(event.target.value)}
            >
              {props.scenes.map((candidate) => (
                <option key={candidate.sceneId} value={candidate.sceneId}>
                  {candidate.title}
                </option>
              ))}
            </select>
          ) : (
            <h3 className="truncate text-sm font-medium">{scene.title}</h3>
          )}
          {sceneId === null ? null : (
            <Button
              size="xs"
              variant="ghost"
              className="h-6 px-2 text-[10.5px]"
              data-testid="research-open-scene"
              onClick={() => props.onOpenScene(sceneId)}
            >
              Open on graph
            </Button>
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
          {scene.sceneError === undefined ? null : (
            <span
              className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-600 dark:text-amber-400"
              data-testid="research-scene-error"
            >
              this scene's markers were not composed: {scene.sceneError}
            </span>
          )}
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
              calculationVersion={scene.calculationVersion}
              layers={scene.scene?.deterministic ?? []}
              prefill={props.prefill}
            />
          ) : (
            <EventAlignedBody
              environmentId={props.environmentId}
              payload={scene.eventStudy}
              calculationVersion={scene.calculationVersion}
            />
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
