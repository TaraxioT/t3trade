import {
  threadMarketScopeKey,
  useThreadMarketCardStore,
  useThreadMarketGraphMode,
  useThreadStudyOverlay,
  type ThreadMarketGraphMode,
} from "./threadMarketCardState";
/**
 * The market, where the trader is already looking.
 *
 * A trading thread's chart and positions sit in the chat column, attached to
 * the composer as its topmost drawer: the picture of the market and what is on
 * it, directly under the sentence being typed about them. The drawer surface
 * itself is the composer's own glass (`.chat-composer-market-drawer` in
 * index.css) — the card is content inside the shell, never a floating card
 * beside it.
 *
 * What the card holds is the same in both of the thread's two states, only
 * sourced differently:
 *
 *   bound     the mission chart with the plan's levels across it, and the
 *             mission's own order ledger — `MissionLivePanel parts="market"`
 *   unbound   the plain market chart with its timeframe selector, and the
 *             account's positions on that market
 *
 * The panel beside the chat keeps what is left: the market header, the mission
 * status strip and the agent log. So there is exactly one chart in a thread
 * view, and every card renders in exactly one place.
 *
 * Collapse is per thread and persisted, and collapsing unmounts the body
 * rather than hiding it: a folded card holds no chart poll, no ticker and no
 * subscription, so a thread whose market the trader is not watching costs the
 * websocket nothing.
 *
 * @module ThreadMarketCard
 */
import type {
  EnvironmentId,
  OrchestrationTradingMission,
  ResearchSceneView,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useCallback, useEffect, useMemo } from "react";
import { useTradingResearchScenes } from "../../lib/tradingResearchScenesState";
import { compatibleStudyScenes } from "./researchScenePresentation";

import { useTradingAccountView } from "../../lib/tradingAccountState";
import { refreshTradingThreadMarket } from "../../lib/tradingThreadMarketState";
import { cn } from "../../lib/utils";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useAtomCommand } from "../../state/use-atom-command";
import { Skeleton } from "../ui/skeleton";
import { AccountPositionsPanel } from "./AccountPositionsPanel";
import { MarketChartPanel } from "./MarketChartPanel";
import { MissionLivePanel } from "./MissionLivePanel";
import { MarketQuote } from "./ThreadMarketPanel";
import { filterAccountsToMarket, missionOnMarket } from "./threadMarketPanelState";
import { useThreadMarketCardCollapsed, useThreadMarketPanelStore } from "./threadMarketPanelStore";
import { isMissionComplete } from "./tradingPresentation";

/** The market's own chart and the account's positions on it: no mission. */
function UnboundMarketBody({
  environmentId,
  asset,
  missions,
  threadRef,
}: {
  environmentId: EnvironmentId;
  asset: string;
  missions: ReadonlyArray<OrchestrationTradingMission>;
  /** The thread this card is docked in, for the chart's chat affordances. */
  threadRef: ScopedThreadRef;
}) {
  const account = useTradingAccountView(environmentId);
  const accounts = account.data?.accounts ?? [];
  const scoped = filterAccountsToMarket(accounts, asset);

  if (account.data === null && account.isLoading) {
    return (
      <div className="flex flex-col gap-3" data-testid="thread-market-card-skeleton">
        {/* The viewport contract the chart itself will fill, so the loading
            beat holds the drawer at the height the market arrives at. */}
        <Skeleton className="trading-graph-viewport w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <MarketChartPanel
        environmentId={environmentId}
        asset={asset}
        // No height class: the panel owns its viewport via the shared
        // trading-graph-viewport contract, so every graph surface reads alike.
        // The armed watch would land in the alert list on the trade home, one
        // surface away from the chart that armed it.
        armable={false}
        // This chart IS in a conversation, so the validation badge and its
        // paper markers can ask it questions.
        threadRef={threadRef}
      />
      {account.error === null ? null : (
        <p className="px-1 text-xs text-destructive">{account.error}</p>
      )}
      <AccountPositionsPanel
        accounts={scoped}
        missions={missions}
        environmentId={environmentId}
        selectedAsset={asset}
        // The card is already about one market, so selecting a row would be
        // selecting what is already selected.
        onSelect={() => {}}
      />
    </div>
  );
}

/**
 * Which of the mission's markets the card is showing.
 *
 * Only drawn when the mission holds more than one, which most do not: a single
 * market needs no choosing, and a one-tab control is chrome. Pressing a tab
 * writes the thread's market focus - the same row the agent's own look writes -
 * so there is one answer to "which market is this thread about" rather than a
 * server one and a client one that can disagree.
 */
function MarketSwitcher({
  markets,
  selected,
  onSelect,
}: {
  readonly markets: ReadonlyArray<string>;
  readonly selected: string;
  readonly onSelect: (market: string) => void;
}) {
  if (markets.length < 2) return null;
  return (
    <div
      role="tablist"
      aria-label="Markets this chat holds"
      data-testid="thread-market-switcher"
      className="flex shrink-0 items-center gap-0.5 rounded-md bg-muted/50 p-0.5"
    >
      {markets.map((market) => {
        const isSelected = market === selected;
        return (
          <button
            key={market}
            type="button"
            role="tab"
            aria-selected={isSelected}
            data-market={market}
            onClick={(event) => {
              // The tab strip lives inside the card's collapse button, so a
              // press that reached it would fold the card away too.
              event.stopPropagation();
              onSelect(market);
            }}
            className={cn(
              "rounded px-2 py-0.5 text-xs font-medium",
              isSelected
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {market}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Mission / Research presentation switcher for a mission-bound thread.
 *
 * Provides a small, existing-style selector to switch between the mission
 * chart and the unified research graph without stacking them simultaneously.
 */
function StudyOverlaySelector({
  studies,
  selectedSceneId,
  isLoading,
  error,
  onSelect,
  onRetry,
}: {
  readonly studies: ReadonlyArray<ResearchSceneView>;
  readonly selectedSceneId: string | null;
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly onSelect: (sceneId: string | null) => void;
  readonly onRetry: () => void;
}) {
  const hasUsableStudy =
    selectedSceneId !== null && studies.some((s) => s.sceneId === selectedSceneId);
  const isAwaitingData = selectedSceneId !== null && !hasUsableStudy && isLoading;
  const isUnavailable = selectedSceneId !== null && !hasUsableStudy && !isLoading;
  const isCachedFailure = selectedSceneId !== null && hasUsableStudy && error !== null;

  return (
    <div className="flex shrink-0 items-center gap-1" onClick={(event) => event.stopPropagation()}>
      <span className="text-[11px] font-medium text-muted-foreground">Study</span>
      <select
        aria-label="Study overlay"
        data-testid="mission-study-selector"
        className="min-w-0 max-w-40 truncate rounded-md border border-border/60 bg-transparent px-1.5 py-0.5 font-mono text-[10.5px] text-foreground"
        value={selectedSceneId ?? ""}
        onChange={(event) => {
          const value = event.target.value;
          onSelect(value === "" ? null : value);
        }}
      >
        <option value="" data-testid="mission-study-option-off">
          Off
        </option>
        {isAwaitingData ? (
          <option value={selectedSceneId} disabled data-testid="mission-study-option-loading">
            Loading study…
          </option>
        ) : null}
        {isUnavailable ? (
          <option value={selectedSceneId} disabled data-testid="mission-study-option-unavailable">
            Unavailable
          </option>
        ) : null}
        {studies.map((study) => (
          <option
            key={study.sceneId}
            value={study.sceneId}
            data-testid={"mission-study-option-" + study.sceneId}
          >
            {study.title}
          </option>
        ))}
      </select>
      {isAwaitingData ? (
        <span
          className="text-[10px] text-muted-foreground animate-pulse"
          data-testid="mission-study-loading"
        >
          Loading…
        </span>
      ) : null}
      {isCachedFailure ? (
        <span
          className="rounded bg-amber-500/10 px-1 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400"
          data-testid="mission-study-not-refreshed"
        >
          Not refreshed
        </span>
      ) : null}
      {isUnavailable && error !== null ? (
        <span
          className="rounded bg-destructive/10 px-1 py-0.5 text-[10px] font-medium text-destructive"
          data-testid="mission-study-unavailable-badge"
        >
          Unavailable
        </span>
      ) : null}
      {error !== null && selectedSceneId !== null ? (
        <button
          type="button"
          onClick={onRetry}
          className="rounded px-1 py-0.5 text-[10px] font-medium text-muted-foreground underline hover:text-foreground"
          data-testid="mission-study-retry"
        >
          Retry
        </button>
      ) : null}
    </div>
  );
}

function ThreadGraphSwitcher({
  selected,
  onSelect,
}: {
  readonly selected: ThreadMarketGraphMode;
  readonly onSelect: (mode: ThreadMarketGraphMode) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Graph presentation"
      data-testid="thread-graph-switcher"
      className="flex shrink-0 items-center gap-0.5 rounded-md bg-muted/50 p-0.5"
    >
      <button
        type="button"
        role="tab"
        aria-selected={selected === "mission"}
        data-graph-mode="mission"
        onClick={(event) => {
          event.stopPropagation();
          onSelect("mission");
        }}
        className={cn(
          "rounded px-2 py-0.5 text-xs font-medium",
          selected === "mission"
            ? "bg-background text-foreground shadow-sm"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        Mission
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={selected === "research"}
        data-graph-mode="research"
        onClick={(event) => {
          event.stopPropagation();
          onSelect("research");
        }}
        className={cn(
          "rounded px-2 py-0.5 text-xs font-medium",
          selected === "research"
            ? "bg-background text-foreground shadow-sm"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        Research
      </button>
    </div>
  );
}

export interface ThreadMarketCardProps {
  readonly environmentId: EnvironmentId;
  readonly asset: string;
  /** The mission bound to this thread, or null for a market the agent looked at. */
  readonly mission: OrchestrationTradingMission | null;
  readonly missions: ReadonlyArray<OrchestrationTradingMission>;
  /** The scoped thread key the collapsed flag is stored under. */
  readonly threadKey: string;
  /** The thread itself, so the switcher can write its market focus. */
  readonly threadId: ThreadId;
}

export function ThreadMarketCard({
  environmentId,
  asset,
  mission,
  missions,
  threadKey,
  threadId,
}: ThreadMarketCardProps) {
  const collapsed = useThreadMarketCardCollapsed(threadKey);
  const setCollapsed = useThreadMarketPanelStore((state) => state.setCardCollapsed);
  const isOpen = !collapsed;

  const scopeKey = threadMarketScopeKey(environmentId, threadId, asset);
  const graphMode = useThreadMarketGraphMode(scopeKey);
  const setGraphMode = useThreadMarketCardStore((state) => state.setGraphMode);

  const isOverlayReaderEnabled = isOpen && graphMode === "mission" && mission !== null;

  const scenes = useTradingResearchScenes(environmentId, threadId, {
    enabled: isOverlayReaderEnabled,
  });
  const activeScenes = scenes.scenes ?? [];
  const compatibleStudies = useMemo(
    () => compatibleStudyScenes(activeScenes, asset),
    [activeScenes, asset],
  );

  const selectedOverlayId = useThreadStudyOverlay(scopeKey);
  const setStudyOverlay = useThreadMarketCardStore((state) => state.setStudyOverlay);

  const handleRetry = useCallback(() => {
    scenes.refresh();
  }, [scenes]);

  // If a selected scene is removed, handle that explicitly.
  // A loading/error response, or a disabled reader must not be mistaken for confirmed removal.
  useEffect(() => {
    if (
      isOverlayReaderEnabled &&
      selectedOverlayId !== null &&
      scenes.scenes !== null &&
      !scenes.isLoading &&
      scenes.error === null &&
      !compatibleStudies.some((s) => s.sceneId === selectedOverlayId)
    ) {
      setStudyOverlay(scopeKey, null);
    }
  }, [
    isOverlayReaderEnabled,
    selectedOverlayId,
    scenes.scenes,
    scenes.isLoading,
    scenes.error,
    compatibleStudies,
    scopeKey,
    setStudyOverlay,
  ]);

  const activeStudyScene = useMemo(() => {
    if (selectedOverlayId === null) return null;
    return compatibleStudies.find((s) => s.sceneId === selectedOverlayId) ?? null;
  }, [compatibleStudies, selectedOverlayId]);

  // The switcher writes the thread's focus row, which `selectThreadPanel` then
  // reads back to pick `asset`. Failing to write costs the tab press and
  // nothing else - the card keeps drawing the market it was drawing.
  const setThreadMarket = useAtomCommand(orchestrationEnvironment.setTradingThreadMarket, {
    reportFailure: false,
  });
  const selectMarket = useCallback(
    (market: string) => {
      void setThreadMarket({ environmentId, input: { threadId, asset: market } })
        .then(() => refreshTradingThreadMarket(environmentId, threadId))
        .catch(() => undefined);
    },
    [environmentId, setThreadMarket, threadId],
  );

  // Every other held market that has something on it, so the card lists a
  // position card per held market while still drawing exactly one chart.
  const otherHeld = mission === null ? [] : mission.markets.filter((market) => market !== asset);
  // The mission as it looks on the market being shown. The header's mark and
  // the body's chart, ledger and levels all come off this one narrowing, so
  // the label and the price under it can never be about different markets.
  const shown = mission === null ? null : missionOnMarket(mission, asset);

  // A finished mission has no live market to card: its chart and its result are
  // the completion summary in the timeline, and the panel states the net in one
  // line. Rendering the header alone would leave a bar of chrome over an empty
  // body, which is what a card with nothing in it is.
  if (mission !== null && isMissionComplete(mission.status)) return null;

  return (
    // Drawer content, not a card: the composer's market drawer class paints
    // the glass, the inset width and the open seam into the composer host
    // below, in both the collapsed and expanded heights.
    <section
      aria-label={`${asset} market`}
      data-testid="thread-market-card"
      data-open={isOpen ? "true" : "false"}
      data-composer-banner-surface="attached"
      className="chat-composer-market-drawer pointer-events-auto px-3 pt-2 sm:px-4"
    >
      <div className="flex w-full min-w-0 items-center gap-2 px-1 py-1">
        <button
          type="button"
          className="flex min-w-0 items-center gap-2 rounded-md text-left"
          aria-expanded={isOpen}
          onClick={() => setCollapsed(threadKey, isOpen)}
          data-testid="thread-market-card-toggle"
        >
          {isOpen ? (
            <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="text-sm font-semibold text-foreground">{asset}</span>
          <MarketQuote
            environmentId={environmentId}
            asset={asset}
            missionMark={shown?.marketPrice ?? null}
          />
        </button>
        {mission === null ? null : (
          <div className="ml-auto flex items-center gap-2">
            {/* The same label the server's `direct_order` records carry: this
                mission exists because the user ordered by chat, not from a
                document-backed strategy. */}
            {mission.mandateOrigin === "direct_order" ? (
              <span className="rounded-full border border-border px-2 py-px text-[11px] text-muted-foreground">
                Direct order
              </span>
            ) : null}
            <MarketSwitcher markets={mission.markets} selected={asset} onSelect={selectMarket} />
            {(compatibleStudies.length > 0 || selectedOverlayId !== null) &&
            graphMode === "mission" ? (
              <StudyOverlaySelector
                studies={compatibleStudies}
                selectedSceneId={selectedOverlayId}
                isLoading={scenes.isLoading}
                error={scenes.error}
                onSelect={(id) => setStudyOverlay(scopeKey, id)}
                onRetry={handleRetry}
              />
            ) : null}
            <ThreadGraphSwitcher
              selected={graphMode}
              onSelect={(mode) => setGraphMode(scopeKey, mode)}
            />
          </div>
        )}
      </div>
      {/* Unmounted rather than hidden while folded: see the module note. The
          cap is on the drawer, so a mission with a long ledger scrolls inside
          it instead of pushing the composer down the column. The x axis is
          CLIPPED, not auto: `overflow-y-auto` alone computes overflow-x to
          auto, and a stray horizontal trackpad swipe then scrolls the drawer
          sideways and cuts the left edge off every line in it with no way
          back. Nothing in the drawer is meant to pan horizontally. */}
      {isOpen ? (
        <div className={cn("max-h-[46vh] overflow-x-clip overflow-y-auto pt-1")}>
          {mission === null ? (
            <UnboundMarketBody
              environmentId={environmentId}
              asset={asset}
              missions={missions}
              threadRef={{ environmentId, threadId }}
            />
          ) : (
            <div className="flex flex-col gap-3">
              {/* Only the selected graph presentation mounts. */}
              {graphMode === "mission" ? (
                <MissionLivePanel
                  mission={shown ?? mission}
                  environmentId={environmentId}
                  parts="chart"
                  chartClassName="trading-graph-viewport w-full min-h-0"
                  studyOverlayScene={activeStudyScene}
                />
              ) : (
                <MarketChartPanel
                  environmentId={environmentId}
                  asset={asset}
                  armable={false}
                  threadRef={{ environmentId, threadId }}
                />
              )}
              {/* Persistent mission information: risk information, revision/refusal feedback, and order ledger/positions stay visible regardless of selected graph. */}
              <MissionLivePanel
                mission={shown ?? mission}
                environmentId={environmentId}
                parts="info"
              />
              {/* And what is on the mission's other markets, listed under it.
                  A market with nothing on it draws nothing rather than an
                  empty card per held market. */}
              {otherHeld.map((market) => (
                <MissionLivePanel
                  key={market}
                  mission={missionOnMarket(mission, market)}
                  environmentId={environmentId}
                  parts="positions"
                />
              ))}
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}
