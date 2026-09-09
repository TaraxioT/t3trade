import {
  type EnvironmentId,
  type OrchestrationTradingMission,
  RESEARCH_DISCLAIMER,
  type ResearchSceneView,
  type ThreadId,
  type TradingMissionId,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { MissionPriceChart } from "./MissionPriceChart";
import { ChartSlot } from "./MissionLivePanelSections";
import { MissionLivePanel } from "./MissionLivePanel";
import { liveResearchMarkers } from "./researchScenePresentation";

// Mock out the chart hook so we can inspect the exact parameters MissionLivePanel passes it.
const chartHookCalls: Array<{ asset: string; interval: string }> = [];
vi.mock("~/lib/tradingMarketChartState", () => ({
  useTradingMarketChart: (_env: unknown, asset: string, interval: string) => {
    chartHookCalls.push({ asset, interval });
    const current = Date.now();
    return {
      data: {
        asset,
        interval,
        candles: [
          {
            openTime: current - 120_000,
            open: 2000,
            high: 2050,
            low: 1990,
            close: 2020,
            volume: 10,
          },
          {
            openTime: current - 60_000,
            open: 2020,
            high: 2040,
            low: 2010,
            close: 2030,
            volume: 20,
          },
          { openTime: current, open: 2030, high: 2060, low: 2025, close: 2050, volume: 30 },
        ],
      },
      isLoading: false,
      error: null,
      refresh: vi.fn(),
    };
  },
}));

vi.mock("./composerPrefill", () => ({
  useComposerPrefill: () => null,
}));

vi.mock("./missionSelectionStore", () => ({
  useMissionSelection: () => ({ selectedMomentId: null, selectMoment: vi.fn() }),
  isMomentSelected: () => false,
}));

vi.mock("./missionChartModeStore", () => ({
  useMissionChartMode: () => "candles",
}));

describe("MissionLivePanel Study Overlay Integration", () => {
  const currentNow = Date.now();
  const sampleStudyScene = {
    sceneId: "scene-eth-funding",
    status: "active" as const,
    referenceStatus: "ok" as const,
    threadId: "thread-1" as ThreadId,
    kind: "event_study" as const,
    title: "ETH Funding Rate Spike",
    createdAt: currentNow - 300_000,
    updatedAt: currentNow - 300_000,
    calculationVersion: "v1",
    disclaimer: RESEARCH_DISCLAIMER,
    eventStudy: {
      eventSetName: "Funding Spikes",
      market: "ETH",
      occurrenceWindows: [
        {
          startAt: currentNow - 60_000,
          endAt: currentNow - 60_000,
          label: "Funding Spike 0.05%",
          source: "https://example.com/source-1",
          covered: true,
          entryTime: currentNow - 60_000,
          exitTime: currentNow - 30_000,
        },
      ],
    },
  } as never as ResearchSceneView;

  const sampleMission = {
    id: "mission-1" as TradingMissionId,
    tradingAccountId: "acc-1",
    mandateOrigin: "direct_order",
    threadId: "thread-1" as ThreadId,
    market: "ETH",
    markets: ["ETH"],
    status: "position_open",
    marketPrice: 2040,
    marketPrices: [{ market: "ETH", price: 2040 }],
    instruction: "trade 1m ETH long",
    watches: [],
    missionTimeline: [],
    missionVersion: 1,
    leverage: 1,
    position: {
      market: "ETH",
      size: 0.5,
      entryPrice: 2020,
      unrealisedPnl: 10,
      marginUsed: 50,
      protectedSize: 0,
      liquidationPrice: 1800,
      observedAt: new Date(currentNow).toISOString(),
    },
    positions: [],
    strategy: null,
    strategies: [],
    orders: [],
    recentFills: [],
    inFlightExecution: null,
    result: { firstFillAt: null },
  } as never as OrchestrationTradingMission;

  it("renders research markers and mission levels together in the same MissionPriceChart", () => {
    const researchMarkers = liveResearchMarkers(sampleStudyScene, currentNow);
    expect(researchMarkers.length).toBeGreaterThan(0);

    const markup = renderToStaticMarkup(
      <MissionPriceChart
        candles={[
          {
            openTime: currentNow - 120_000,
            open: 2000,
            high: 2050,
            low: 1990,
            close: 2020,
            volume: 10,
          },
          {
            openTime: currentNow - 60_000,
            open: 2020,
            high: 2040,
            low: 2010,
            close: 2030,
            volume: 20,
          },
          { openTime: currentNow, open: 2030, high: 2060, low: 2025, close: 2050, volume: 30 },
        ]}
        entryPrice={2020}
        stopPrice={1980}
        targetPrice={2100}
        liquidationPrice={1800}
        entryTime={currentNow - 60_000}
        markPrice={2040}
        pnlSign="profit"
        conditions={[]}
        fills={[]}
        pendingOrder={null}
        nowMillis={currentNow}
        researchMarkers={researchMarkers}
        className="h-[300px] w-full"
      />,
    );

    // 1. Mission trading levels are present as level chips in the price axis gutter
    expect(markup).toContain('data-testid="mission-level-chip-entry"');
    expect(markup).toContain('data-testid="mission-level-chip-stop"');
    expect(markup).toContain('data-testid="mission-level-chip-target"');
    expect(markup).toContain('data-testid="mission-level-chip-mark"');

    // 2. Research study markers are present in the same chart
    expect(markup).toContain(
      `data-testid="research-marker-scene-eth-funding:${currentNow - 60_000}:exit"`,
    );

    // 3. Research marker carries study metadata (source URL / label)
    expect(markup).toContain("Funding Spike 0.05% exit");
  });

  it("ChartSlot renders researchMarkers and coverageNotes alongside mission chart", () => {
    const researchMarkers = liveResearchMarkers(sampleStudyScene, currentNow);
    const coverageNotes = ["1 occurrence before available history"];

    const chartSlotProps: Parameters<typeof ChartSlot>[0] = {
      threadRef: { environmentId: "env-1" as EnvironmentId, threadId: "thread-1" as ThreadId },
      data: {
        market: "ETH",
        interval: "1m",
        candles: [
          {
            openTime: currentNow - 120_000,
            open: 2000,
            high: 2050,
            low: 1990,
            close: 2020,
            volume: 10,
          },
          {
            openTime: currentNow - 60_000,
            open: 2020,
            high: 2040,
            low: 2010,
            close: 2030,
            volume: 20,
          },
          { openTime: currentNow, open: 2030, high: 2060, low: 2025, close: 2050, volume: 30 },
        ],
      } as never,
      isLoading: false,
      error: null,
      entryPrice: 2020,
      stopPrice: 1980,
      targetPrice: 2100,
      liquidationPrice: null,
      entryTime: currentNow - 60_000,
      markPrice: 2030,
      pnlSign: "profit",
      conditions: [],
      fills: [],
      pendingOrder: null,
      nowMillis: currentNow,
      triggerExpiryAt: null,
      projection: null,
      timeMarkers: [],
      pastMarkers: [],
      draggableKinds: [],
      onLevelDragEnd: () => {},
      refusedStop: null,
      positionSize: null,
      researchMarkers,
      coverageNotes,
    };

    const markup = renderToStaticMarkup(<ChartSlot {...chartSlotProps} />);

    // Renders research marker in chart
    expect(markup).toContain(
      `data-testid="research-marker-scene-eth-funding:${currentNow - 60_000}:exit"`,
    );
    // Renders coverage notes
    expect(markup).toContain('data-testid="mission-chart-coverage-notes"');
    expect(markup).toContain("1 occurrence before available history");
  });

  it("MissionLivePanel passes research markers and leaves mission candle interval (1m) unchanged", () => {
    chartHookCalls.length = 0;

    const markupWithStudy = renderToStaticMarkup(
      <MissionLivePanel
        mission={sampleMission}
        environmentId={"env-1" as EnvironmentId}
        parts="chart"
        studyOverlayScene={sampleStudyScene}
      />,
    );

    // Chart hook must be called with the mission's 1m timeframe, NOT the study's horizon
    expect(chartHookCalls.length).toBeGreaterThan(0);
    expect(chartHookCalls[chartHookCalls.length - 1]?.interval).toBe("1m");

    // Research markers are present in the output
    expect(markupWithStudy).toContain(
      `data-testid="research-marker-scene-eth-funding:${currentNow - 60_000}:exit"`,
    );

    // Now render without study (Off)
    chartHookCalls.length = 0;
    const markupWithoutStudy = renderToStaticMarkup(
      <MissionLivePanel
        mission={sampleMission}
        environmentId={"env-1" as EnvironmentId}
        parts="chart"
        studyOverlayScene={null}
      />,
    );

    // Timeframe remains 1m
    expect(chartHookCalls.length).toBeGreaterThan(0);
    expect(chartHookCalls[chartHookCalls.length - 1]?.interval).toBe("1m");

    // Research markers are absent
    expect(markupWithoutStudy).not.toContain(
      `data-testid="research-marker-scene-eth-funding:${currentNow - 60_000}:exit"`,
    );
    expect(markupWithoutStudy).not.toContain('data-testid="mission-chart-coverage-notes"');

    // Mission trading levels are present in both
    expect(markupWithoutStudy).toContain('data-testid="mission-level-chip-entry"');
    expect(markupWithStudy).toContain('data-testid="mission-level-chip-entry"');
  });
});
