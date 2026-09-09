import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_RESEARCH_VIEW_STATE,
  threadMarketScopeKey,
  useThreadMarketCardStore,
} from "./threadMarketCardState";

describe("threadMarketCardState", () => {
  it("computes canonical scope keys", () => {
    expect(threadMarketScopeKey("env-1", "thread-1", "ETH")).toBe("env-1:thread-1:ETH");
    expect(threadMarketScopeKey("env-1", "thread-1", "BTC")).toBe("env-1:thread-1:BTC");
    expect(threadMarketScopeKey("env-2", "thread-1", "ETH")).toBe("env-2:thread-1:ETH");
  });

  it("defaults graph mode to mission for any scope", () => {
    const state = useThreadMarketCardStore.getState();
    const scopeKey = "test-env:test-thread:ETH";
    expect(state.graphModeByScope[scopeKey]).toBeUndefined();
  });

  it("persists graph mode per scope without cross-scope leakage", () => {
    const scopeEth = "env-1:thread-1:ETH";
    const scopeBtc = "env-1:thread-1:BTC";
    const scopeOtherThread = "env-1:thread-2:ETH";

    const { setGraphMode } = useThreadMarketCardStore.getState();

    setGraphMode(scopeEth, "research");

    const state = useThreadMarketCardStore.getState();
    expect(state.graphModeByScope[scopeEth]).toBe("research");
    expect(state.graphModeByScope[scopeBtc]).toBeUndefined();
    expect(state.graphModeByScope[scopeOtherThread]).toBeUndefined();

    // Updating BTC does not mutate ETH
    setGraphMode(scopeBtc, "mission");
    const updated = useThreadMarketCardStore.getState();
    expect(updated.graphModeByScope[scopeEth]).toBe("research");
    expect(updated.graphModeByScope[scopeBtc]).toBe("mission");
  });

  it("persists research view state across view toggles and isolates by scope", () => {
    const scopeEth = "env-1:thread-1:ETH";
    const scopeBtc = "env-1:thread-1:BTC";

    const {
      setGraphMode,
      setResearchView,
      setResearchRange,
      setResearchBars,
      setResearchSceneId,
      setResearchAppliedAutoFitIds,
      setResearchPendingPromotion,
    } = useThreadMarketCardStore.getState();

    // 1. Configure ETH research view
    setResearchView(scopeEth, "calendar");
    setResearchRange(scopeEth, "1w");
    setResearchBars(scopeEth, "1h");
    setResearchSceneId(scopeEth, "scene-eth-funding");
    setResearchAppliedAutoFitIds(scopeEth, ["scene-eth-funding"]);
    setResearchPendingPromotion(scopeEth, "scene-eth-funding");

    // 2. ETH research view is configured
    let state = useThreadMarketCardStore.getState();
    expect(state.researchViewByScope[scopeEth]).toEqual({
      view: "calendar",
      range: "1w",
      bars: "1h",
      selectedSceneId: "scene-eth-funding",
      appliedAutoFitIds: ["scene-eth-funding"],
      pendingPromotionSceneId: "scene-eth-funding",
    });

    // 3. BTC research view remains untouched at default
    expect(state.researchViewByScope[scopeBtc]).toBeUndefined();

    // 4. Toggle ETH to Mission and back to Research
    setGraphMode(scopeEth, "mission");
    expect(useThreadMarketCardStore.getState().graphModeByScope[scopeEth]).toBe("mission");

    setGraphMode(scopeEth, "research");
    expect(useThreadMarketCardStore.getState().graphModeByScope[scopeEth]).toBe("research");

    // 5. Research view state on ETH survived toggle
    state = useThreadMarketCardStore.getState();
    expect(state.researchViewByScope[scopeEth]).toEqual({
      view: "calendar",
      range: "1w",
      bars: "1h",
      selectedSceneId: "scene-eth-funding",
      appliedAutoFitIds: ["scene-eth-funding"],
      pendingPromotionSceneId: "scene-eth-funding",
    });
  });

  it("defaults study overlay to null (Off) and isolates by scope without leaking", () => {
    const scopeEth = "env-1:thread-1:ETH";
    const scopeBtc = "env-1:thread-1:BTC";
    const scopeOtherEnv = "env-2:thread-1:ETH";

    const { setStudyOverlay } = useThreadMarketCardStore.getState();

    // Defaults to undefined in store
    expect(useThreadMarketCardStore.getState().studyOverlayByScope[scopeEth]).toBeUndefined();

    // Set ETH study overlay
    setStudyOverlay(scopeEth, "study-eth-drawdown");

    let state = useThreadMarketCardStore.getState();
    expect(state.studyOverlayByScope[scopeEth]).toBe("study-eth-drawdown");
    expect(state.studyOverlayByScope[scopeBtc]).toBeUndefined();
    expect(state.studyOverlayByScope[scopeOtherEnv]).toBeUndefined();

    // Set BTC to a different study
    setStudyOverlay(scopeBtc, "study-btc-halving");
    state = useThreadMarketCardStore.getState();
    expect(state.studyOverlayByScope[scopeEth]).toBe("study-eth-drawdown");
    expect(state.studyOverlayByScope[scopeBtc]).toBe("study-btc-halving");

    // Setting ETH to null ("Off") leaves BTC untouched
    setStudyOverlay(scopeEth, null);
    state = useThreadMarketCardStore.getState();
    expect(state.studyOverlayByScope[scopeEth]).toBeNull();
    expect(state.studyOverlayByScope[scopeBtc]).toBe("study-btc-halving");
  });

  it("preserves study overlay across Mission/Research toggles and keeps it distinct from research view scene selection", () => {
    const scopeEth = "env-1:thread-1:ETH";
    const { setGraphMode, setStudyOverlay, setResearchSceneId } =
      useThreadMarketCardStore.getState();

    // Mission mode has an active study overlay
    setGraphMode(scopeEth, "mission");
    setStudyOverlay(scopeEth, "overlay-study-123");

    // Research view has its own separate scene
    setResearchSceneId(scopeEth, "research-scene-456");

    let state = useThreadMarketCardStore.getState();
    expect(state.studyOverlayByScope[scopeEth]).toBe("overlay-study-123");
    expect(state.researchViewByScope[scopeEth]?.selectedSceneId).toBe("research-scene-456");

    // Toggle to Research
    setGraphMode(scopeEth, "research");
    state = useThreadMarketCardStore.getState();
    expect(state.graphModeByScope[scopeEth]).toBe("research");
    expect(state.studyOverlayByScope[scopeEth]).toBe("overlay-study-123");
    expect(state.researchViewByScope[scopeEth]?.selectedSceneId).toBe("research-scene-456");

    // Toggle back to Mission
    setGraphMode(scopeEth, "mission");
    state = useThreadMarketCardStore.getState();
    expect(state.graphModeByScope[scopeEth]).toBe("mission");
    expect(state.studyOverlayByScope[scopeEth]).toBe("overlay-study-123");
    expect(state.researchViewByScope[scopeEth]?.selectedSceneId).toBe("research-scene-456");
  });
});
