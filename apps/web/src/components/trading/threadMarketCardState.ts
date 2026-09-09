// ---------------------------------------------------------------------------
// threadMarketCardState
// ---------------------------------------------------------------------------
//
// Persistent scoped state for ThreadMarketCard and MarketChartPanel.
//
// 1. Graph presentation mode: "mission" | "research".
//    Per thread and market: defaulting to "mission" on first use.
// 2. Research graph controls: view, range, bars, selectedSceneId, auto-fit,
//    and pending promotion.
//    Scoped by environment, thread, and market so switching views or markets
//    preserves study configuration without leaking across scopes.

import type { TradingChartRange } from "@t3tools/contracts";
import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { ChartInterval } from "../../lib/tradingMarketChartState";
import type { GraphViewMode } from "./researchScenePresentation";

export type ThreadMarketGraphMode = "mission" | "research";

export type StateUpdater<T> = T | ((prev: T) => T);

export interface ThreadResearchViewState {
  readonly view: GraphViewMode;
  readonly range: TradingChartRange;
  readonly bars: ChartInterval | null;
  readonly selectedSceneId: string | null;
  readonly appliedAutoFitIds: ReadonlyArray<string>;
  readonly pendingPromotionSceneId: string | null;
}

export const DEFAULT_RESEARCH_VIEW_STATE: ThreadResearchViewState = {
  view: "live",
  range: "1d",
  bars: null,
  selectedSceneId: null,
  appliedAutoFitIds: [],
  pendingPromotionSceneId: null,
};

export function threadMarketScopeKey(
  environmentId: string,
  threadId: string,
  asset: string,
): string {
  return `${environmentId}:${threadId}:${asset}`;
}

interface ThreadMarketCardStoreState {
  readonly graphModeByScope: Readonly<Record<string, ThreadMarketGraphMode>>;
  readonly setGraphMode: (scopeKey: string, mode: ThreadMarketGraphMode) => void;
  readonly studyOverlayByScope: Readonly<Record<string, string | null>>;
  readonly setStudyOverlay: (scopeKey: string, sceneId: StateUpdater<string | null>) => void;
  readonly researchViewByScope: Readonly<Record<string, ThreadResearchViewState>>;
  readonly setResearchView: (scopeKey: string, view: StateUpdater<GraphViewMode>) => void;
  readonly setResearchRange: (scopeKey: string, range: StateUpdater<TradingChartRange>) => void;
  readonly setResearchBars: (scopeKey: string, bars: StateUpdater<ChartInterval | null>) => void;
  readonly setResearchSceneId: (scopeKey: string, sceneId: StateUpdater<string | null>) => void;
  readonly setResearchAppliedAutoFitIds: (
    scopeKey: string,
    appliedIds: StateUpdater<ReadonlyArray<string>>,
  ) => void;
  readonly setResearchPendingPromotion: (
    scopeKey: string,
    sceneId: StateUpdater<string | null>,
  ) => void;
}

export const useThreadMarketCardStore = create<ThreadMarketCardStoreState>()(
  persist(
    (set) => ({
      graphModeByScope: {},
      setGraphMode: (scopeKey, mode) =>
        set((state) => ({
          graphModeByScope: { ...state.graphModeByScope, [scopeKey]: mode },
        })),
      studyOverlayByScope: {},
      setStudyOverlay: (scopeKey, sceneId) =>
        set((state) => {
          const current = state.studyOverlayByScope[scopeKey] ?? null;
          const nextSceneId = typeof sceneId === "function" ? sceneId(current) : sceneId;
          return {
            studyOverlayByScope: {
              ...state.studyOverlayByScope,
              [scopeKey]: nextSceneId,
            },
          };
        }),
      researchViewByScope: {},
      setResearchView: (scopeKey, view) =>
        set((state) => {
          const current = state.researchViewByScope[scopeKey] ?? DEFAULT_RESEARCH_VIEW_STATE;
          const nextView = typeof view === "function" ? view(current.view) : view;
          return {
            researchViewByScope: {
              ...state.researchViewByScope,
              [scopeKey]: { ...current, view: nextView },
            },
          };
        }),
      setResearchRange: (scopeKey, range) =>
        set((state) => {
          const current = state.researchViewByScope[scopeKey] ?? DEFAULT_RESEARCH_VIEW_STATE;
          const nextRange = typeof range === "function" ? range(current.range) : range;
          return {
            researchViewByScope: {
              ...state.researchViewByScope,
              [scopeKey]: { ...current, range: nextRange },
            },
          };
        }),
      setResearchBars: (scopeKey, bars) =>
        set((state) => {
          const current = state.researchViewByScope[scopeKey] ?? DEFAULT_RESEARCH_VIEW_STATE;
          const nextBars = typeof bars === "function" ? bars(current.bars) : bars;
          return {
            researchViewByScope: {
              ...state.researchViewByScope,
              [scopeKey]: { ...current, bars: nextBars },
            },
          };
        }),
      setResearchSceneId: (scopeKey, selectedSceneId) =>
        set((state) => {
          const current = state.researchViewByScope[scopeKey] ?? DEFAULT_RESEARCH_VIEW_STATE;
          const nextSceneId =
            typeof selectedSceneId === "function"
              ? selectedSceneId(current.selectedSceneId)
              : selectedSceneId;
          return {
            researchViewByScope: {
              ...state.researchViewByScope,
              [scopeKey]: { ...current, selectedSceneId: nextSceneId },
            },
          };
        }),
      setResearchAppliedAutoFitIds: (scopeKey, appliedIds) =>
        set((state) => {
          const current = state.researchViewByScope[scopeKey] ?? DEFAULT_RESEARCH_VIEW_STATE;
          const currentApplied = current.appliedAutoFitIds ?? [];
          const nextApplied =
            typeof appliedIds === "function" ? appliedIds(currentApplied) : appliedIds;
          return {
            researchViewByScope: {
              ...state.researchViewByScope,
              [scopeKey]: { ...current, appliedAutoFitIds: nextApplied },
            },
          };
        }),
      setResearchPendingPromotion: (scopeKey, sceneId) =>
        set((state) => {
          const current = state.researchViewByScope[scopeKey] ?? DEFAULT_RESEARCH_VIEW_STATE;
          const currentPending = current.pendingPromotionSceneId ?? null;
          const nextPending = typeof sceneId === "function" ? sceneId(currentPending) : sceneId;
          return {
            researchViewByScope: {
              ...state.researchViewByScope,
              [scopeKey]: { ...current, pendingPromotionSceneId: nextPending },
            },
          };
        }),
    }),
    { name: "t3-thread-market-card" },
  ),
);

/**
 * Returns the selected graph mode for a given scope, defaulting to "mission".
 */
export function useThreadMarketGraphMode(scopeKey: string): ThreadMarketGraphMode {
  return useThreadMarketCardStore((state) => state.graphModeByScope[scopeKey] ?? "mission");
}

/**
 * Returns the selected study overlay scene id for a given scope, defaulting to null ("Off").
 */
export function useThreadStudyOverlay(scopeKey: string | null | undefined): string | null {
  return useThreadMarketCardStore((state) =>
    scopeKey ? (state.studyOverlayByScope[scopeKey] ?? null) : null,
  );
}

/**
 * Hook to access and update research view state scoped by thread and market.
 */
export function useThreadResearchViewState(scopeKey: string | null | undefined) {
  const rawState = useThreadMarketCardStore((state) =>
    scopeKey ? state.researchViewByScope[scopeKey] : undefined,
  );
  const setResearchView = useThreadMarketCardStore((state) => state.setResearchView);
  const setResearchRange = useThreadMarketCardStore((state) => state.setResearchRange);
  const setResearchBars = useThreadMarketCardStore((state) => state.setResearchBars);
  const setResearchSceneId = useThreadMarketCardStore((state) => state.setResearchSceneId);
  const setResearchAppliedAutoFitIds = useThreadMarketCardStore(
    (state) => state.setResearchAppliedAutoFitIds,
  );
  const setResearchPendingPromotion = useThreadMarketCardStore(
    (state) => state.setResearchPendingPromotion,
  );

  const researchState = rawState ?? DEFAULT_RESEARCH_VIEW_STATE;

  return {
    view: researchState.view,
    range: researchState.range,
    bars: researchState.bars,
    selectedSceneId: researchState.selectedSceneId,
    appliedAutoFitIds:
      researchState.appliedAutoFitIds ?? DEFAULT_RESEARCH_VIEW_STATE.appliedAutoFitIds,
    pendingPromotionSceneId:
      researchState.pendingPromotionSceneId ?? DEFAULT_RESEARCH_VIEW_STATE.pendingPromotionSceneId,
    setView: (view: StateUpdater<GraphViewMode>) => {
      if (scopeKey) setResearchView(scopeKey, view);
    },
    setRange: (range: StateUpdater<TradingChartRange>) => {
      if (scopeKey) setResearchRange(scopeKey, range);
    },
    setBars: (bars: StateUpdater<ChartInterval | null>) => {
      if (scopeKey) setResearchBars(scopeKey, bars);
    },
    setSelectedSceneId: (sceneId: StateUpdater<string | null>) => {
      if (scopeKey) setResearchSceneId(scopeKey, sceneId);
    },
    setAppliedAutoFitIds: (appliedIds: StateUpdater<ReadonlyArray<string>>) => {
      if (scopeKey) setResearchAppliedAutoFitIds(scopeKey, appliedIds);
    },
    setPendingPromotionSceneId: (sceneId: StateUpdater<string | null>) => {
      if (scopeKey) setResearchPendingPromotion(scopeKey, sceneId);
    },
  };
}
