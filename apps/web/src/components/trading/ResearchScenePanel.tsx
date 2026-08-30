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
  DERIVED_VS_AUTHORED_SENTENCE,
  MARKER_LEGEND_SENTENCE,
  provenanceTrailLine,
  studyExplanationLines,
  studyWindowMaxBars,
  turnIntoStrategySentence,
  validateForwardSentence,
} from "./researchScenePresentation.ts";

const NOTIONAL_DEFAULT = 1_000;

/** Bars of context on each side of a measured occurrence window (shared with the chart cap). */
const CONTEXT_BARS = STUDY_CHART_CONTEXT_BARS;

const fmtUsd = (value: number): string =>
  `${value < 0 ? "-" : ""}$${Math.abs(value).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

const fmtPct = (value: number | null | undefined): string =>
  value === null || value === undefined ? "-" : `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;

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
 * ordinary chart RPC, the entry and exit drawn as the bars they were measured
 * on, and the signed return beside them.
 */
function OccurrenceChart(props: {
  readonly environmentId: EnvironmentId;
  readonly market: string;
  readonly interval: ChartInterval;
  readonly window: ChartWindow;
  readonly occurrence: ResearchOccurrenceWindow;
  readonly horizonBars: number;
  readonly intervalMs: number;
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
    const bands = [
      {
        key: `event:${props.occurrence.startAt}`,
        label: "event",
        startAt: props.occurrence.startAt,
        endAt: props.occurrence.endAt,
        upcoming: false,
      },
    ];
    if (props.occurrence.entryTime !== undefined) {
      bands.push({
        key: `entry:${props.occurrence.entryTime}`,
        label: "entry",
        startAt: props.occurrence.entryTime,
        endAt: props.occurrence.entryTime,
        upcoming: false,
      });
    }
    if (props.occurrence.exitTime !== undefined) {
      bands.push({
        key: `exit:${props.occurrence.exitTime}`,
        label: "exit",
        startAt: props.occurrence.exitTime,
        endAt: props.occurrence.exitTime,
        upcoming: false,
      });
    }
    return bands;
  }, [props.occurrence]);

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
    return (
      <div
        className="h-[120px] motion-safe:animate-pulse rounded bg-muted/40"
        data-testid="research-occurrence-loading"
      />
    );
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
          className="h-[120px]"
        />
      )}
    </>
  );
}

/** A return and its per-notional illustration, one row. */
function ReturnRow(props: { readonly returnPct: number | undefined; readonly notional: number }) {
  if (props.returnPct === undefined) return null;
  const gross = (props.notional * props.returnPct) / 100;
  return (
    <span
      className={
        props.returnPct >= 0
          ? "text-emerald-600 dark:text-emerald-400"
          : "text-red-600 dark:text-red-400"
      }
    >
      {fmtPct(props.returnPct)} ({fmtUsd(gross)} on {fmtUsd(props.notional)})
    </span>
  );
}

function EventStudyBody(props: {
  readonly environmentId: EnvironmentId;
  readonly payload: EventStudyScenePayload;
  readonly sceneId: string;
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

  return (
    <div className="flex flex-col gap-2">
      {/* The honesty block: every line a reader needs before trusting a
          number, straight from the pure module so the renderer cannot drop
          one quietly. */}
      <div
        className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-muted-foreground"
        data-testid="research-explanation"
      >
        {studyExplanationLines(payload).map((line) => (
          <span key={line}>{line}</span>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
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
      {/* Occurrence navigation: years-apart events are not one unreadable
          chart. Prev/next moves the measured window; the aligned summary is
          one tab away and never lost. */}
      <div className="flex items-center gap-2 text-xs" data-testid="research-occurrence-nav">
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
        {rows[safeSelected] !== undefined && props.prefill !== null ? (
          <button
            type="button"
            className="rounded border border-border/60 px-2 py-0.5 text-muted-foreground hover:text-foreground"
            data-testid={`research-ask-${safeSelected}`}
            onClick={() =>
              props.prefill?.(
                askAboutOccurrenceSentence({
                  sceneId: props.sceneId,
                  market: payload.market,
                  label: rows[safeSelected]?.label ?? `occurrence ${safeSelected + 1}`,
                  dateIso: new Date(rows[safeSelected]?.startAt ?? 0).toISOString().slice(0, 10),
                  returnPct: rows[safeSelected]?.returnPct,
                }),
              )
            }
          >
            Ask about this
          </button>
        ) : null}
      </div>
      <ol className="flex flex-col gap-3">
        {report.rows.map((row, index) => {
          const window = windowFor({ ...row, covered: row.covered }, report.horizonMs, intervalMs);
          const when = new Date(row.startAt).toISOString().slice(0, 10);
          return (
            <li
              key={`${row.startAt}:${index}`}
              className={`rounded border p-2 ${index === safeSelected ? "border-foreground/40" : "border-border/60"}`}
              data-testid="research-occurrence"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <div className="text-sm font-medium">
                  {row.label ?? `occurrence ${index + 1}`}
                  <span className="ml-2 text-xs font-normal text-muted-foreground">{when}</span>
                </div>
                <div className="text-sm">
                  {row.covered ? (
                    <>
                      <ReturnRow returnPct={row.returnPct} notional={notional} />
                      {row.truncated ? (
                        <span className="ml-2 text-xs text-amber-600 dark:text-amber-400">
                          truncated at {row.barsCovered} bars
                        </span>
                      ) : null}
                    </>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      not measured: {row.reason}
                    </span>
                  )}
                </div>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                <a
                  className="text-sky-600 underline decoration-dotted dark:text-sky-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500"
                  href={row.source.startsWith("http") ? row.source : undefined}
                  target="_blank"
                  rel="noreferrer"
                >
                  source: {row.source}
                </a>
                {props.prefill === null ? null : (
                  <button
                    type="button"
                    className="text-muted-foreground underline decoration-dotted hover:text-foreground"
                    onClick={() =>
                      props.prefill?.(
                        askAboutOccurrenceSentence({
                          sceneId: props.sceneId,
                          market: payload.market,
                          label: row.label ?? `occurrence ${index + 1}`,
                          dateIso: when,
                          returnPct: row.returnPct,
                        }),
                      )
                    }
                  >
                    ask about this occurrence
                  </button>
                )}
              </div>
              {window !== null ? (
                <div className="mt-2">
                  <OccurrenceChart
                    environmentId={props.environmentId}
                    market={payload.market}
                    interval={payload.interval as ChartInterval}
                    window={window}
                    occurrence={{ ...row, covered: row.covered }}
                    horizonBars={report.horizonBars}
                    intervalMs={intervalMs}
                  />
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
    </div>
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
}) {
  const { data } = useTradingMarketChart(props.environmentId, props.market, props.interval, {
    enabled: true,
    window: {
      startTime: props.occurrence.entryTime,
      endTime: (props.occurrence.exitTime ?? props.occurrence.entryTime) + 1,
    },
    maxBars: Math.min(props.horizonBars + 2 * CONTEXT_BARS, STUDY_CHART_MAX_WINDOW_BARS),
    poll: false,
  });
  if (data === null) {
    return <div className="h-[60px] motion-safe:animate-pulse rounded bg-muted/40" />;
  }
  const trace = alignedTracePoints({
    candles: data.candles,
    entryTime: props.occurrence.entryTime,
    intervalMs: props.intervalMs,
    horizonBars: props.horizonBars,
  });
  if (trace.length < 2) return null;
  return <TraceSvg trace={trace} horizonBars={props.horizonBars} emphasis={false} />;
}

/**
 * One aligned trace, or the aggregate: x is bars since entry, y is percent
 * change from the measured entry (the dashed line is zero change, not an
 * index level, because the axis is a change). The aggregate draws heavier.
 */
function TraceSvg(props: {
  readonly trace: ReadonlyArray<{ readonly barsSinceEntry: number; readonly changePct: number }>;
  readonly horizonBars: number;
  readonly emphasis: boolean;
  readonly neutral?: boolean;
}) {
  const width = 240;
  const height = 60;
  const step = width / Math.max(1, props.horizonBars);
  const ys = [0, ...props.trace.map((point) => point.changePct)];
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
    <svg viewBox={`0 0 ${width} ${height}`} className="h-[60px] w-full" role="img">
      <line
        x1="0"
        x2={width}
        y1={scaleY(0)}
        y2={scaleY(0)}
        stroke="currentColor"
        strokeDasharray="2 3"
        className="text-muted-foreground/40"
      />
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

function EventAlignedBody(props: {
  readonly environmentId: EnvironmentId;
  readonly payload: EventStudyScenePayload;
}) {
  const { payload } = props;
  const covered = payload.occurrenceWindows.filter(
    (window): window is CoveredOccurrenceWindow => window.covered && window.entryTime !== undefined,
  );
  return (
    <div className="flex flex-col gap-2">
      <div className="text-xs text-muted-foreground">
        {covered.length} trace(s) rebased to their measured entry (dashed line = zero change). Bars
        since the entry run left to right for {payload.horizonBars} bars; each path is that
        occurrence's archived closes as a percentage of its entry. The heavier line is the mean
        across occurrences.
      </div>
      {/* Small n is the first thing a reader must know: a mean of two shapes
          is a description, not evidence, and the label says so at a glance. */}
      <div
        className="text-xs font-medium text-amber-600 dark:text-amber-400"
        data-testid="research-aligned-smalln"
      >
        n = {covered.length} occurrence{covered.length === 1 ? "" : "s"}
        {covered.length > 0 && covered.length < 5
          ? " (a small sample: descriptive, not evidence)"
          : ""}
      </div>
      <ol className="flex flex-col gap-2">
        {covered.map((window, index) => (
          <li
            key={`${window.startAt}:${index}`}
            className="flex items-center gap-3"
            data-testid="research-aligned-trace"
          >
            <div className="w-28 shrink-0 text-xs">
              <div className="font-medium">{window.label ?? `occurrence ${index + 1}`}</div>
              <div className="text-muted-foreground">
                {new Date(window.startAt).toISOString().slice(0, 10)}
              </div>
            </div>
            <div className="min-w-0 flex-1">
              <AlignedTrace
                environmentId={props.environmentId}
                market={payload.market}
                interval={payload.interval as ChartInterval}
                intervalMs={payload.report.horizonMs / payload.report.horizonBars}
                occurrence={window}
                horizonBars={payload.horizonBars}
              />
            </div>
          </li>
        ))}
      </ol>
      {covered.length > 1 ? (
        <div
          className="flex items-center gap-3 border-t border-border/60 pt-2"
          data-testid="research-aggregate"
        >
          <div className="w-28 shrink-0 text-xs font-medium">
            aggregate (mean of {covered.length})
          </div>
          <div className="min-w-0 flex-1">
            <AggregateTrace
              environmentId={props.environmentId}
              payload={payload}
              covered={covered}
            />
          </div>
        </div>
      ) : null}
      {covered.length === 0 ? (
        <div className="rounded border border-border/60 p-2 text-xs text-muted-foreground">
          No covered occurrences to align. The calendar view says why each one was not measured.
        </div>
      ) : null}
    </div>
  );
}

/**
 * The aggregate trace: each covered occurrence's window is fetched by its
 * own hook in a child (rules of hooks), the pure module rebases it, and the
 * parent draws the mean path heavier once every child has answered. Display
 * arithmetic on server bars; per-occurrence numbers are never recomputed.
 */
function AggregateTrace(props: {
  readonly environmentId: EnvironmentId;
  readonly payload: EventStudyScenePayload;
  readonly covered: ReadonlyArray<ResearchOccurrenceWindow>;
}) {
  const intervalMs = props.payload.report.horizonMs / props.payload.report.horizonBars;
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
        <div className="h-[60px] motion-safe:animate-pulse rounded bg-muted/40" />
      ) : aggregate.points.length < 2 ? (
        <div className="text-xs text-muted-foreground">not enough bars to aggregate</div>
      ) : (
        <TraceSvg trace={aggregate.points} horizonBars={props.payload.horizonBars} emphasis />
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
  readonly occurrence: ResearchOccurrenceWindow;
  readonly onTrace: (points: ReadonlyArray<{ barsSinceEntry: number; changePct: number }>) => void;
}) {
  const { data } = useTradingMarketChart(props.environmentId, props.market, props.interval, {
    enabled: true,
    window: {
      startTime: props.occurrence.entryTime ?? props.occurrence.startAt,
      endTime:
        (props.occurrence.exitTime ?? props.occurrence.entryTime ?? props.occurrence.startAt) + 1,
    },
    maxBars: Math.min(props.horizonBars + 2 * CONTEXT_BARS, STUDY_CHART_MAX_WINDOW_BARS),
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
    <div className="flex flex-col gap-2">
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
 * The published scenes of one thread, with the calendar and event-aligned
 * views. Rendered inside the thread's market card below the live chart, so
 * the live chart stays first and research never decorates another thread's
 * graph.
 */
export function ResearchScenePanel(props: {
  readonly environmentId: EnvironmentId;
  readonly scenes: ReadonlyArray<ResearchSceneView>;
  readonly loading: boolean;
  readonly error: string | null;
  /** The research mode the outer graph controls own (Live lives outside). */
  readonly mode: "calendar" | "aligned";
  readonly onModeChange: (mode: "calendar" | "aligned") => void;
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

  if (props.error !== null) {
    return (
      <div
        className="rounded border border-border/60 p-2 text-xs text-muted-foreground"
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
          className="h-6 motion-safe:animate-pulse rounded bg-muted/40"
          data-testid="research-scenes-loading"
        />
      );
    }
    return null;
  }

  return (
    <section
      className="mt-2 rounded border border-border/60 p-2"
      data-testid="research-scene-panel"
    >
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
          {scene.eventStudy !== undefined ? (
            <div className="flex gap-1 text-xs">
              {(["calendar", "aligned"] as const).map((candidate) => (
                <button
                  key={candidate}
                  type="button"
                  className={`rounded px-2 py-0.5 ${props.mode === candidate ? "bg-muted font-medium" : "text-muted-foreground"}`}
                  onClick={() => props.onModeChange(candidate)}
                  data-testid={`research-mode-${candidate}`}
                >
                  {candidate === "calendar" ? "Calendar" : "Event aligned"}
                </button>
              ))}
            </div>
          ) : null}
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
      <div className="mt-2">
        {scene.eventStudy !== undefined ? (
          props.mode === "calendar" ? (
            <EventStudyBody
              environmentId={props.environmentId}
              payload={scene.eventStudy}
              sceneId={scene.sceneId}
              prefill={props.prefill}
            />
          ) : (
            <EventAlignedBody environmentId={props.environmentId} payload={scene.eventStudy} />
          )
        ) : scene.strategyReplay !== undefined ? (
          <StrategyReplayBody environmentId={props.environmentId} payload={scene.strategyReplay} />
        ) : scene.annotation !== undefined ? (
          <div className="text-sm">
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
          <div className="text-xs text-muted-foreground">
            this scene predates the current format and no longer renders
          </div>
        )}
      </div>
      {/* What is derived and what is authored, said once, and where it goes:
          the graph shows research, and research distinguishes its numbers
          from its prose. The next-step controls are prefills only; nothing
          here plans, arms, or trades on click. */}
      <footer className="mt-2 flex flex-col gap-1 border-t border-border/60 pt-2">
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
