/**
 * MarketChartPanel (unified graph): the chart of any followed market — no
 * mission required — and, when it is docked in a thread, the research the
 * conversation published onto it.
 *
 * Two controls own the live read, deliberately separate. Range says how much
 * history; Bars says how wide each bar is. The server resolves a range to a
 * window (`all` is everything the archive recorded — only it knows that
 * span), so the client never computes windows; it sends
 * `{interval, range, maxBars}` and the pure policy module
 * (`tradingChartRangePolicy`) decides which requests are even servable.
 *
 * Publication is Live-first. A newly published event study does NOT take the
 * graph over: it stays on Live, its occurrences arrive as named markers at
 * their exact instants, and the range auto-fits ONCE per scene id so the
 * markers land somewhere visible. Afterwards the reader's own Range, Bars and
 * view choices are stickier than the data — polls and scene refreshes never
 * move them — until the thread's scenes vanish entirely, when the graph comes
 * home to Live.
 *
 * One outer frame serves every view: header and tabs, the Range rail, and one
 * plot stage that Live, Calendar and Event aligned share, so switching views
 * is a change of content, never a change of geometry. Research detail
 * (explanations, occurrence navigation, provenance) scrolls inside the fixed
 * viewport in its inspector rather than growing the frame.
 *
 * The one chart interaction stays as it was: hovering the plot docks a chip
 * in the gutter at the pointer's price, and clicking it arms a notify watch
 * there — through the same `armTradingWatch` RPC the alert panel's form uses.
 * `armable={false}` takes the chip and its hint off, because the thread panel
 * has no alert list to read the armed watch back from.
 *
 * No clock of its own: the chart poll lives in `useTradingMarketChart`, and
 * nothing here animates continuously.
 *
 * @module MarketChartPanel
 */
import type {
  EnvironmentId,
  ScopedThreadRef,
  TradingArmWatchInput,
  TradingChartRange,
} from "@t3tools/contracts";
import { STUDY_CHART_MAX_WINDOW_BARS } from "@t3tools/contracts";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { refreshTradingWatches } from "../../lib/tradingAccountState";
import { useComposerPrefill } from "./composerPrefill";
import { ThesisChartBadgeLine, askAboutPaperMarker } from "./ThesisChartBadgeLine";
import { useTradingMarketChart, type ChartInterval } from "../../lib/tradingMarketChartState";
import {
  MENU_INTERVALS,
  RANGES,
  RANGE_LABELS,
  intervalMenuLabel,
  promoteAllToMonthly,
  rangeMaxBars,
  resolveBars,
  resolvedBarsLabel,
} from "../../lib/tradingChartRangePolicy";
import { cn } from "../../lib/utils";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { formatPrice } from "./tradingPresentation";
import { MissionPriceChart } from "./MissionPriceChart";
import { describeControlFailure } from "./useMissionControls";
import { analystMarketPrompt, useAskAnalyst } from "./useTradingThreadLaunch";
import { ResearchScenePanel } from "./ResearchScenePanel";
import {
  liveResearchMarkers,
  nextGraphViewMode,
  sceneAutoFitDecision,
  sceneMarketOf,
  uncoveredOccurrenceNotes,
  type GraphViewMode,
} from "./researchScenePresentation.ts";
import { useTradingResearchScenes } from "../../lib/tradingResearchScenesState";

/** The graph's three views, in tab order. Live is first and is the home. */
const VIEW_MODES: ReadonlyArray<GraphViewMode> = ["live", "calendar", "aligned"];

/** What the last arm-at-price click came to. */
type ArmStatus =
  | { readonly kind: "armed"; readonly text: string }
  | { readonly kind: "failed"; readonly text: string };

export function MarketChartPanel({
  environmentId,
  asset,
  className,
  armable = true,
  threadRef,
}: {
  environmentId: EnvironmentId;
  asset: string;
  /**
   * Sizing for the one shared plot stage, e.g. the trade home's height class.
   * When absent the stage uses the unified graph's own viewport sizing
   * (`trading-graph-viewport`).
   */
  className?: string;
  /** Whether hovering the plot offers the arm-at-price chip. */
  armable?: boolean;
  /**
   * The thread this chart is docked in, when it is docked in one.
   *
   * Only the chat affordances and the research scenes read it: a chart docked
   * in a thread shows the calendar and event-aligned views of that thread's
   * published studies, and clicking a validation badge or one of its paper
   * markers writes a question into that thread's composer. Absent on the
   * trade home, where there is no conversation to put a sentence into and the
   * chart stays live-first with no research modes at all.
   */
  threadRef?: ScopedThreadRef | undefined;
}) {
  // Range and Bars are two states because they are two questions: how much
  // history, and how wide each bar is. `bars === null` is Auto.
  const [range, setRange] = useState<TradingChartRange>("1d");
  const [bars, setBars] = useState<ChartInterval | null>(null);
  const [view, setView] = useState<GraphViewMode>("live");

  // The policy clock is per mount, not per poll: range arithmetic (YTD spans,
  // servability, bar budgets) moves on calendar scales, and a mount-stable
  // value keeps the read's atom identity stable across polls instead of
  // re-keying it every fifteen seconds.
  const policyNow = useMemo(() => Date.now(), []);
  const resolved = resolveBars(range, bars, policyNow);
  const chart = useTradingMarketChart(environmentId, asset, resolved.interval, {
    enabled: true,
    range,
    maxBars: rangeMaxBars(range, resolved.interval, policyNow),
  });
  // Research scenes belong to the conversation: only a chart docked in a
  // thread reads them, and the trade home's chart stays live-first with no
  // research modes at all. Loading follows the dock, not the current view —
  // every research view of the same scenes reads the same cache.
  const scenes = useTradingResearchScenes(environmentId, threadRef?.threadId ?? null, {
    enabled: threadRef !== undefined,
  });
  const arm = useAtomCommand(orchestrationEnvironment.armTradingWatch);
  const [armStatus, setArmStatus] = useState<ArmStatus | null>(null);
  const [isArming, setIsArming] = useState(false);
  // "Ask the analyst" (Phase 8): one analyst thread per market, reused.
  const analyst = useAskAnalyst(environmentId);

  const data = chart.data;

  // A clock stamped per poll, not per tick: the axis reaches now and the
  // future gutter exists, which is where an event set's next upcoming
  // occurrence draws. It moves only when the poll brings new data, so nothing
  // here repaints continuously.
  const nowMillis = useMemo(() => Date.now(), [data]);

  // The validation running on this market, handed to the chart whole: the
  // chart derives its own markers, bands and levels from it (see
  // `MissionPriceChart`'s `thesis` prop), so this panel wires one thing and
  // every other chart surface gets the same picture from the same seam.
  const thesis = data?.thesis ?? null;
  // Cards ask; they never act. On a thread this writes the question into that
  // thread's composer, and on the trade home there is no thread, so the badge
  // and the markers are read-only. @see composerPrefill
  const prefill = useComposerPrefill(threadRef ?? null);

  // The thread's active scenes, filtered to THIS panel's market before
  // anything draws. A scene belongs to the market it was measured on: without
  // the filter, a thread that studied ETH would draw its markers on BTC bars
  // — foreign geometry at honest-looking positions. Selection is keyed by
  // scene ID, never array position: the server's newest-first order can
  // change between polls, and an index would silently point at another scene.
  // The scenes hook already keeps only active scenes, so a cleared or
  // superseded scene vanishes here and its markers leave the graph with it.
  const activeScenes = scenes.scenes ?? [];
  const marketScenes = useMemo(
    () =>
      activeScenes.filter(
        (scene) => (sceneMarketOf(scene) ?? "").toUpperCase() === asset.toUpperCase(),
      ),
    [activeScenes, asset],
  );
  const [selectedSceneId, setSelectedSceneId] = useState<string | null>(null);
  // One-time auto-fit per active scene id (declared here because the market
  // and environment resets below clear it). The gate is a ref of applied ids
  // around the pure decision, so polls and refreshes of the same scene never
  // move the range again.
  const appliedAutoFitRef = useRef<ReadonlySet<string>>(new Set());
  // The all + 1w fit can outrun the bar budget once the archive's own
  // recording start is known — only the response can say. When the fit chose
  // all + 1w, this holds the scene id whose response may still promote to
  // monthly bars; the reader moving Range or Bars cancels it.
  const pendingPromotionRef = useRef<string | null>(null);
  // A market or environment switch invalidates a prior selection and every
  // fit already applied: fits are per market context, and a scene id selected
  // under another asset is not this asset's scene even if the thread holds it.
  useEffect(() => {
    setSelectedSceneId(null);
    appliedAutoFitRef.current = new Set();
    pendingPromotionRef.current = null;
  }, [asset, environmentId]);
  const marketStudyScenes = useMemo(
    () => marketScenes.filter((scene) => scene.eventStudy !== undefined),
    [marketScenes],
  );
  const activeStudyScene = useMemo(() => {
    const selected = marketStudyScenes.find((scene) => scene.sceneId === selectedSceneId);
    return selected ?? marketStudyScenes[0] ?? null;
  }, [marketStudyScenes, selectedSceneId]);
  const hasScenes = marketScenes.length > 0;
  const selectedScene = useMemo(
    () =>
      marketScenes.find((scene) => scene.sceneId === selectedSceneId) ?? marketScenes[0] ?? null,
    [marketScenes, selectedSceneId],
  );

  // The explicit open/focus intent: publication made the scene active, and
  // THIS is the user's ask to see it — refresh first so a scene published
  // moments ago is in hand, select it by identity, switch to the view that
  // frames its markers, and clear its fit gate so opening re-frames even a
  // scene that had auto-fitted before. It never recomputes or duplicates the
  // scene; it navigates to what is already there.
  const openScene = (sceneId: string) => {
    scenes.refresh();
    setSelectedSceneId(sceneId);
    setView("calendar");
    const nextApplied = new Set(appliedAutoFitRef.current);
    nextApplied.delete(sceneId);
    appliedAutoFitRef.current = nextApplied;
  };

  const armAtPrice = (price: number) => {
    if (isArming || data === null) return;
    const direction: "above" | "below" = price >= data.markPrice ? "above" : "below";
    const input: TradingArmWatchInput = {
      condition: { kind: "price", market: asset, direction, price, confirm: "touch" },
      deliver: "notify",
      rearm: { mode: "once" },
    };
    setIsArming(true);
    setArmStatus(null);
    void arm({ environmentId, input }).then((result) => {
      setIsArming(false);
      const failure = describeControlFailure(result);
      if (failure !== null) {
        setArmStatus({ kind: "failed", text: failure });
        return;
      }
      if (result._tag === "Success" && result.value.outcome === "rejected") {
        setArmStatus({ kind: "failed", text: result.value.reason });
        return;
      }
      setArmStatus({
        kind: "armed",
        text: `Alert armed: ${asset} ${direction} ${formatPrice(price)}`,
      });
      refreshTradingWatches(environmentId);
    });
  };

  // --- Live-first publication -------------------------------------------------
  //
  // A scene arriving never moves the view (the reader stays wherever they
  // are, Live included); the thread's scenes vanishing entirely hand the
  // graph back to Live, because Calendar and Event aligned have nothing to
  // show without them. The decision is pure (`nextGraphViewMode`) so the
  // stickiness is testable without a running effect loop.
  const hadScenesRef = useRef(hasScenes);
  useEffect(() => {
    setView((current) =>
      nextGraphViewMode({ current, hasScenes, previouslyHadScenes: hadScenesRef.current }),
    );
    hadScenesRef.current = hasScenes;
  }, [hasScenes]);

  // When the selected event-study scene changes, fit the range once so the
  // study's occurrences land inside the window (see the gate above; a scene
  // that comes back does not re-fit unless the reader explicitly opens it).
  useEffect(() => {
    if (activeStudyScene === null) return;
    const decision = sceneAutoFitDecision(appliedAutoFitRef.current, activeStudyScene, Date.now());
    if (!decision.apply || decision.recommendation === undefined) return;
    appliedAutoFitRef.current = decision.appliedSceneIds;
    setRange(decision.recommendation.range);
    setBars(decision.recommendation.interval);
    pendingPromotionRef.current =
      decision.recommendation.range === "all" && decision.recommendation.interval === "1w"
        ? activeStudyScene.sceneId
        : null;
  }, [activeStudyScene]);
  useEffect(() => {
    const recordingSince = data?.recordingSince;
    const sceneId = pendingPromotionRef.current;
    if (recordingSince === undefined || sceneId === null) return;
    // The reader moved on from the fitted pair: promotion is moot, drop it.
    if (range !== "all" || bars !== "1w") {
      pendingPromotionRef.current = null;
      return;
    }
    if (!promoteAllToMonthly(recordingSince, Date.now(), STUDY_CHART_MAX_WINDOW_BARS)) return;
    pendingPromotionRef.current = null;
    setBars("1mo");
  }, [data, range, bars]);

  // The live graph's scene decoration: named markers at their exact instants
  // (an instantaneous activation a rule, a true span a band, an upcoming
  // occurrence in the future gutter) and a coverage note for occurrences the
  // archive never reached — text, never a fake edge marker.
  const researchMarkers = useMemo(
    () => (activeStudyScene === null ? [] : liveResearchMarkers(activeStudyScene, nowMillis)),
    [activeStudyScene, nowMillis],
  );
  const coverageNotes = useMemo(
    () => (activeStudyScene === null ? [] : uncoveredOccurrenceNotes(activeStudyScene, nowMillis)),
    [activeStudyScene, nowMillis],
  );

  // The resolved bars text says what the graph is actually drawing, including
  // the cases where Auto made the decision: a manual choice that cannot serve
  // the range falls back and says so, rather than silently requesting an
  // impossible combination.
  const resolvedBarsText =
    resolved.mode === "manual"
      ? resolvedBarsLabel(resolved.interval)
      : resolved.mode === "auto"
        ? `Auto: ${resolvedBarsLabel(resolved.interval)}`
        : `Auto: ${resolvedBarsLabel(resolved.interval)} (${intervalMenuLabel(bars ?? resolved.interval)} not servable on this range)`;

  const moveView = (delta: number) => {
    const index = VIEW_MODES.indexOf(view);
    const next = VIEW_MODES[(index + delta + VIEW_MODES.length) % VIEW_MODES.length];
    // VIEW_MODES covers every GraphViewMode, so the fallback is unreachable;
    // it exists because indexed access is `| undefined` to the typechecker.
    setView(next ?? view);
  };
  const onViewKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      moveView(1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      moveView(-1);
    }
  };

  return (
    <div className="flex flex-col gap-1">
      {hasScenes ? (
        <div
          className="flex min-w-0 flex-wrap items-center gap-1 px-1 text-[10.5px]"
          role="tablist"
          aria-label="Chart view"
        >
          {VIEW_MODES.map((option) => (
            <button
              key={option}
              type="button"
              role="tab"
              aria-selected={view === option}
              tabIndex={view === option ? 0 : -1}
              data-testid={`market-chart-view-${option}`}
              className={cn(
                "shrink-0 cursor-pointer whitespace-nowrap rounded px-2 py-0.5 transition-colors",
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1",
                view === option
                  ? "bg-accent font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => {
                setView(option);
                if (option !== "live") scenes.refresh();
              }}
              onKeyDown={onViewKeyDown}
            >
              {option === "live" ? "Live" : option === "calendar" ? "Calendar" : "Event aligned"}
            </button>
          ))}
          <span className="shrink-0 whitespace-nowrap text-muted-foreground/70">
            {marketScenes.length === 1
              ? "1 published scene"
              : `${marketScenes.length} published scene(s) on ${asset}`}
          </span>
          {selectedScene === null ? null : (
            <span className="ml-auto flex min-w-0 items-center gap-1">
              <select
                aria-label="Research scene"
                data-testid="market-chart-scene-select"
                className="min-w-0 max-w-48 truncate rounded-md border border-border/60 bg-transparent px-1 py-0.5 font-mono text-[10.5px]"
                value={selectedScene.sceneId}
                onChange={(event) => setSelectedSceneId(event.target.value)}
              >
                {marketScenes.map((scene) => (
                  <option key={scene.sceneId} value={scene.sceneId}>
                    {scene.title}
                  </option>
                ))}
              </select>
              <Button
                size="xs"
                variant="ghost"
                className="h-6 shrink-0 whitespace-nowrap px-2 text-[10.5px]"
                data-testid="market-chart-open-scene"
                onClick={() => openScene(selectedScene.sceneId)}
              >
                Open on graph
              </Button>
            </span>
          )}
        </div>
      ) : null}
      {/* The Range rail and the Bars menu: two controls, two vocabularies —
          and LIVE's controls only. Calendar and Event aligned draw fixed
          per-occurrence recipes the server measured; leaving the rail there
          would promise a recalculation no press can perform, so the research
          views state their measured recipe read-only instead.
          Range labels stay short (1D…All); Bars labels are always spelled
          out (1 min…1 month), so no two buttons can be read as the same
          thing. */}
      {view !== "live" ? (
        <div
          className="flex flex-wrap items-center gap-2 px-1 font-mono text-[10.5px] text-muted-foreground"
          data-testid="market-chart-research-recipe"
        >
          {selectedScene?.eventStudy !== undefined ? (
            <span>
              {selectedScene.eventStudy.interval} bars · {selectedScene.eventStudy.horizonBars}-bar
              horizon · measured recipe — Range and Bars apply to Live
            </span>
          ) : selectedScene?.strategyReplay !== undefined ? (
            <span>
              {selectedScene.strategyReplay.interval} bars · replay window per trade — Range and
              Bars apply to Live
            </span>
          ) : (
            <span>research view — Range and Bars apply to Live</span>
          )}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2 px-1">
          <div
            className="flex overflow-hidden rounded-md border border-border/60 font-mono text-[10.5px] leading-none"
            role="group"
            aria-label="Chart range"
          >
            {RANGES.map((option) => (
              <button
                key={option}
                type="button"
                data-testid={`market-chart-range-${option}`}
                aria-pressed={option === range}
                className={cn(
                  "cursor-pointer px-1.5 py-1 transition-colors",
                  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1",
                  option === range
                    ? "bg-accent font-medium text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
                onClick={() => setRange(option)}
              >
                {RANGE_LABELS[option]}
              </button>
            ))}
          </div>
          <select
            aria-label="Chart bars"
            data-testid="market-chart-bars"
            className="rounded-md border border-border/60 bg-transparent px-1 py-0.5 font-mono text-[10.5px]"
            value={resolved.mode === "manual" && bars !== null ? bars : "auto"}
            onChange={(event) =>
              setBars(event.target.value === "auto" ? null : (event.target.value as ChartInterval))
            }
          >
            <option value="auto" data-testid="market-chart-bars-auto">
              Auto
            </option>
            {MENU_INTERVALS.map((option) => (
              <option key={option} value={option} data-testid={`market-chart-bars-${option}`}>
                {intervalMenuLabel(option)}
              </option>
            ))}
          </select>
          <span
            className="font-mono text-[10.5px] tabular-nums text-muted-foreground"
            data-testid="market-chart-resolved-bars"
          >
            {resolvedBarsText}
          </span>
        </div>
      )}
      {/* The one shared plot stage. Same frame, same header, same rail for
          Live, Calendar and Event aligned; the content changes, the geometry
          never does. `className` is the caller's sizing; without it Live takes
          the unified fixed viewport, while the research views take the
          research floor instead — their explanatory content extends the
          drawer's one scroll rather than fighting its cap for a second fixed
          height. */}
      <div
        className={cn(
          "relative flex min-h-0 flex-col",
          className ??
            (view === "live" ? "trading-graph-viewport" : "trading-graph-viewport-research"),
        )}
        data-testid="market-chart-stage"
      >
        {hasScenes && view !== "live" ? (
          <ResearchScenePanel
            environmentId={environmentId}
            scenes={marketScenes}
            selectedSceneId={selectedScene?.sceneId ?? null}
            onSelectScene={setSelectedSceneId}
            onOpenScene={openScene}
            loading={scenes.isLoading}
            error={scenes.error}
            onRetry={scenes.refresh}
            mode={view === "aligned" ? "aligned" : "calendar"}
            prefill={prefill}
          />
        ) : data !== null && data.candles.length >= 2 ? (
          <>
            <MissionPriceChart
              candles={data.candles}
              entryPrice={null}
              stopPrice={null}
              targetPrice={null}
              liquidationPrice={null}
              entryTime={null}
              markPrice={data.markPrice}
              pnlSign={null}
              showVolume
              {...(data.sessionLevels === undefined ? {} : { sessionLevels: data.sessionLevels })}
              {...(data.recordingSince === undefined
                ? {}
                : { recordingSince: data.recordingSince })}
              {...(data.gaps === undefined ? {} : { gaps: data.gaps })}
              {...(thesis === null ? {} : { thesis })}
              {...(data.eventBands === undefined ? {} : { eventBands: data.eventBands })}
              nowMillis={nowMillis}
              {...(researchMarkers.length === 0 ? {} : { researchMarkers })}
              {...(prefill === null || thesis === null
                ? {}
                : { onAskAboutMarker: askAboutPaperMarker(prefill, thesis.headline) })}
              {...(armable ? { onArmAtPrice: armAtPrice } : {})}
            />
            {coverageNotes.length > 0 ? (
              <div
                className="px-1 pt-0.5 text-[10px] text-muted-foreground"
                data-testid="market-chart-coverage-notes"
              >
                {coverageNotes.join(" · ")}
              </div>
            ) : null}
          </>
        ) : chart.error === null && data === null ? (
          // Switching range or bars re-reads the series under a new key, so
          // `data` is null again for that beat. A skeleton inside the stage
          // says so in the same geometry: the previous bars left up would be a
          // picture the controls no longer name.
          <Skeleton
            className={cn("w-full flex-1", className === undefined ? "min-h-24" : "")}
            data-testid="market-chart-skeleton"
          />
        ) : (
          <div className="flex flex-1 items-center justify-center rounded-md border border-border/60 px-6 text-center text-sm text-muted-foreground">
            {chart.error !== null
              ? "Chart unavailable"
              : `Not enough ${resolvedBarsLabel(resolved.interval)} recorded for ${asset} yet.`}
          </div>
        )}
      </div>
      <ThesisChartBadgeLine thesis={thesis} prefill={view === "live" ? prefill : null} />
      <div className="flex items-center gap-2 px-1">
        <Button
          size="xs"
          variant="ghost"
          className="text-[10.5px]"
          disabled={analyst.busy}
          onClick={() => void analyst.ask({ asset, prompt: analystMarketPrompt(asset) })}
          data-testid="market-chart-ask-analyst"
        >
          {analyst.busy ? "Asking…" : "Ask the analyst"}
        </Button>
        {analyst.error === null ? null : (
          <span className="text-[10.5px] text-destructive">{analyst.error}</span>
        )}
        {!armable ? null : armStatus === null ? (
          <span className="text-[10.5px] text-muted-foreground/80">
            Hover the chart and click the chip to arm a price alert.
          </span>
        ) : (
          <span
            data-testid="market-chart-arm-status"
            className={cn(
              "text-[10.5px]",
              armStatus.kind === "failed" ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {armStatus.text}
          </span>
        )}
      </div>
    </div>
  );
}
