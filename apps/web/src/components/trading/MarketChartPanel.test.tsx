/**
 * MarketChartPanel's integration seam: the Range rail and the Bars menu are
 * two controls with disjoint vocabularies, the live read names the range the
 * server resolves, a published scene KEEPS the graph on Live and decorates it
 * with its occurrences at their exact instants, and every non-success state
 * keeps the one shared stage's geometry. The calendar and aligned renderings
 * are pinned in ResearchScenePanel.test.tsx; what is pinned here is the shell
 * that owns them.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { MarketChartPanel } from "./MarketChartPanel";

const DAY = 24 * 60 * 60 * 1_000;
const T0 = 1_710_000_000_000;

const CANDLES = Array.from({ length: 40 }, (_, i) => ({
  openTime: T0 + i * DAY,
  open: 100,
  high: 101,
  low: 99,
  close: 100,
  volume: 1,
  trades: 1,
}));

// The Ethereum-style multi-year study: one span, one exact activation, one
// occurrence before recording began, one still to come.
const RULE_AT = T0 + 40 * DAY;
const SPAN_START = T0 - 800 * DAY;
const SPAN_END = T0 - 797 * DAY;
const PRE_ARCHIVE = T0 - 3_000 * DAY;
const UPCOMING = T0 + 2_000 * DAY;

const SCENE = {
  sceneId: "scene-1",
  threadId: "thread-1",
  status: "active",
  referenceStatus: "ok",
  kind: "event_study",
  title: "ETH upgrades on ETH, 1d bars, 30 forward",
  createdAt: T0,
  updatedAt: T0,
  calculationVersion: "event-study-2",
  disclaimer: "Historical research. No order placed. Not a forecast.",
  eventStudy: {
    priceSource: "hyperliquid",
    entryBasis: "first_closed_bar_after_event",
    illustrativeNotionalUsd: 1_000,
    eventSetId: "set-1",
    eventSetName: "ETH upgrades",
    market: "ETH",
    interval: "1d",
    horizonBars: 30,
    report: {
      horizonBars: 30,
      horizonMs: 30 * DAY,
      n: 4,
      nCovered: 2,
      meanReturnPct: -3,
      medianReturnPct: -3,
      hitRatePercent: 50,
      bestReturnPct: 4,
      worstReturnPct: -10,
      baseline: null,
      rows: [],
      verdict: "2 of 4 occurrences fall inside archived data.",
    },
    occurrenceWindows: [
      {
        startAt: SPAN_START,
        endAt: SPAN_END,
        label: "Devcon",
        source: "https://example.org/devcon",
        covered: true,
        entryTime: SPAN_END,
        exitTime: SPAN_END + 30 * DAY,
      },
      {
        startAt: RULE_AT,
        endAt: RULE_AT,
        source: "https://example.org/dencun",
        covered: true,
        entryTime: RULE_AT,
        exitTime: RULE_AT + 30 * DAY,
      },
      {
        startAt: PRE_ARCHIVE,
        endAt: PRE_ARCHIVE,
        label: "Frontier",
        source: "https://example.org/frontier",
        covered: false,
      },
      {
        startAt: UPCOMING,
        endAt: UPCOMING + 3 * DAY,
        label: "Futurera",
        source: "https://example.org/next",
        covered: false,
      },
    ],
    archiveBounds: { recordingSince: T0 - 900 * DAY, fromT: T0, toT: T0 + 40 * DAY },
  },
} as never;

const mocks = vi.hoisted(() => ({
  // Assigned below the fixtures: vi.hoisted runs before module init, so the
  // containers must start empty and be filled once CANDLES/SCENE exist.
  chartState: null as unknown,
  scenesState: [] as unknown[],
  calls: [] as Array<{ interval: unknown; options: Record<string, unknown> }>,
}));

// The default chart state: a healthy read of daily candles.
mocks.chartState = { data: { candles: CANDLES, markPrice: 100 }, error: null, stale: false };
mocks.scenesState = [SCENE];

vi.mock("../../lib/tradingMarketChartState", () => ({
  useTradingMarketChart: (
    _environmentId: unknown,
    _market: unknown,
    interval: unknown,
    options: Record<string, unknown>,
  ) => {
    mocks.calls.push({ interval, options });
    return mocks.chartState;
  },
}));

// The renderer for scene markers is another workstream's: the stub records
// the prop hand-off so the wiring is pinned without depending on the drawing.
vi.mock("./MissionPriceChart", async () => {
  const React = await import("react");
  return {
    MissionPriceChart: (props: {
      readonly candles?: unknown;
      readonly researchMarkers?: unknown;
    }) =>
      React.createElement("div", {
        "data-testid": "mission-price-chart",
        "data-candle-count": Array.isArray(props.candles) ? String(props.candles.length) : "0",
        "data-research-markers":
          props.researchMarkers === undefined ? "" : JSON.stringify(props.researchMarkers),
      }),
  };
});

// Scenes follow the dock: the mock honours `enabled` the way the real polling
// hook does, so the trade-home render (no threadRef) sees none.
vi.mock("../../lib/tradingResearchScenesState", () => ({
  useTradingResearchScenes: (
    _environmentId: unknown,
    _threadId: unknown,
    options: { readonly enabled: boolean },
  ) =>
    options.enabled
      ? { scenes: mocks.scenesState, isLoading: false, error: null }
      : { scenes: [], isLoading: false, error: null },
}));

vi.mock("./composerPrefill", () => ({ useComposerPrefill: () => null }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("./useTradingThreadLaunch", () => ({
  useAskAnalyst: () => ({ busy: false, error: null, ask: vi.fn() }),
  analystMarketPrompt: (asset: string) => asset,
}));

const render = (threaded: boolean, className?: string) =>
  renderToStaticMarkup(
    <MarketChartPanel
      environmentId={"env" as never}
      asset="ETH"
      armable={false}
      {...(className === undefined ? {} : { className })}
      {...(threaded ? { threadRef: { threadId: "thread-1" } as never } : {})}
    />,
  );

describe("MarketChartPanel: Range and Bars as two controls", () => {
  const markup = render(false);

  it("offers the seven ranges as a segmented group, labelled 1D through All", () => {
    expect(markup).toContain('aria-label="Chart range"');
    for (const token of ["1d", "1w", "1m", "6m", "ytd", "1y", "all"]) {
      expect(markup).toContain(`data-testid="market-chart-range-${token}"`);
    }
    expect(markup).toContain(">1D<");
    expect(markup).toContain(">1M<");
    expect(markup).toContain(">YTD<");
    expect(markup).toContain(">All<");
  });

  it("offers Bars as Auto plus spelled-out intervals — no ambiguous 1m/1M tokens in menus", () => {
    expect(markup).toContain('aria-label="Chart bars"');
    expect(markup).toContain('data-testid="market-chart-bars-auto"');
    for (const label of [
      "1 min",
      "3 min",
      "5 min",
      "15 min",
      "1 hour",
      "4 hours",
      "1 day",
      "1 week",
      "1 month",
    ]) {
      expect(markup).toContain(`>${label}<`);
    }
    // The old single interval row is gone: its bare tokens were the ambiguity
    // the split controls exist to remove.
    expect(markup).not.toContain('data-testid="market-chart-interval-1d"');
  });

  it("states the resolved bars beside the header: default is Auto on 5 min bars", () => {
    expect(markup).toContain('data-testid="market-chart-resolved-bars"');
    expect(markup).toContain("Auto: 5 min bars");
  });

  it("the live read names range and maxBars for the server to resolve", () => {
    const last = mocks.calls[mocks.calls.length - 1];
    expect(last?.interval).toBe("5m");
    expect(last?.options.range).toBe("1d");
    expect(last?.options.maxBars).toBe(288);
  });

  it("the request identity is stable across renders: polling never re-keys the read", () => {
    mocks.calls.length = 0;
    render(false);
    render(false);
    expect(mocks.calls).toHaveLength(2);
    expect(mocks.calls[0]).toEqual(mocks.calls[1]);
  });
});

describe("MarketChartPanel: Live-first publication", () => {
  const markup = render(true);

  it("a newly active scene keeps the graph on Live, with the modes one tab away", () => {
    expect(markup).toContain('role="tablist"');
    expect(markup).toContain('data-testid="market-chart-view-live"');
    expect(markup).toContain('data-testid="market-chart-view-calendar"');
    expect(markup).toContain('data-testid="market-chart-view-aligned"');
    const liveTab = markup.match(/<button[^>]*market-chart-view-live[^>]*>/)?.[0] ?? "";
    const calendarTab = markup.match(/<button[^>]*market-chart-view-calendar[^>]*>/)?.[0] ?? "";
    expect(liveTab).toContain('aria-selected="true"');
    expect(calendarTab).toContain('aria-selected="false"');
    expect(markup).toContain("1 published scene");
    // The research panel itself is NOT showing: publication decorates Live.
    expect(markup).not.toContain('data-testid="research-scene-panel"');
  });

  it("hands the active scene's occurrences to the chart at their exact instants", () => {
    const stub = markup.match(/data-research-markers="([^"]*)"/)?.[1] ?? "";
    const markers = JSON.parse(stub.replace(/&quot;/g, '"').replace(/&amp;/g, "&")) as Array<
      Record<string, unknown>
    >;
    expect(markers).toHaveLength(4);
    // An exact occurrence becomes a rule at its exact millisecond.
    expect(markers[1]).toEqual({
      key: `scene-1:${RULE_AT}`,
      label: "ETH upgrades",
      startAt: RULE_AT,
      endAt: RULE_AT,
      sourceUrl: "https://example.org/dencun",
      covered: true,
      upcoming: false,
    });
    // A true span keeps both instants.
    expect(markers[0]).toMatchObject({
      key: `scene-1:${SPAN_START}`,
      label: "Devcon",
      startAt: SPAN_START,
      endAt: SPAN_END,
      covered: true,
    });
    // The pre-archive and upcoming occurrences ride along with their flags;
    // coverage is the renderer's to say, never a reason to drop a fact.
    expect(markers[2]).toMatchObject({ covered: false, upcoming: false });
    expect(markers[3]).toMatchObject({ covered: false, upcoming: true });
  });

  it("uncovered occurrences become a coverage note under the chart, not fake edge markers", () => {
    expect(markup).toContain('data-testid="market-chart-coverage-notes"');
    expect(markup).toContain("Frontier");
    expect(markup).toContain("predates recorded data");
    expect(markup).toContain("has not happened yet");
  });

  it("a thread whose scenes vanished decorates nothing", () => {
    mocks.scenesState = [];
    const cleared = render(true);
    expect(cleared).not.toContain('data-testid="market-chart-coverage-notes"');
    expect(cleared.match(/data-research-markers="([^"]*)"/)?.[1]).toBe("");
    expect(cleared).not.toContain('role="tablist"');
    expect(cleared).not.toContain("published scene");
    mocks.scenesState = [SCENE];
  });

  it("the trade home's chart stays live-first: no research modes without a thread", () => {
    const markup = render(false);
    expect(markup).not.toContain('data-testid="market-chart-view-calendar"');
    expect(markup).not.toContain("published scene");
    // The live chart itself still draws.
    expect(markup).toContain('data-testid="mission-price-chart"');
  });
});

describe("MarketChartPanel: one shared stage for every state", () => {
  it("uses the unified viewport sizing when the caller names no height", () => {
    const markup = render(false);
    expect(markup).toContain("trading-graph-viewport");
    expect(markup).toContain('data-testid="market-chart-stage"');
  });

  it("keeps the caller's height class as the stage sizing instead", () => {
    const markup = render(false, "h-[300px] min-h-0 w-full");
    expect(markup).toContain("h-[300px]");
    expect(markup).not.toContain("trading-graph-viewport");
  });

  it("the loading state is a skeleton inside the stage, not a layout shift", () => {
    const before = mocks.chartState;
    mocks.chartState = { data: null, error: null, isLoading: true, stale: false };
    const markup = render(false);
    mocks.chartState = before;
    expect(markup).toContain('data-testid="market-chart-stage"');
    expect(markup).toContain('data-testid="market-chart-skeleton"');
    expect(markup).toContain('data-testid="market-chart-resolved-bars"');
  });

  it("the error state keeps the same stage geometry", () => {
    const before = mocks.chartState;
    mocks.chartState = { data: null, error: "websocket closed", isLoading: false, stale: false };
    const markup = render(false);
    mocks.chartState = before;
    expect(markup).toContain('data-testid="market-chart-stage"');
    expect(markup).toContain("Chart unavailable");
  });

  it("the not-enough-bars state names the resolved bars, inside the stage", () => {
    const before = mocks.chartState;
    mocks.chartState = {
      data: { candles: CANDLES.slice(0, 1), markPrice: 100 },
      error: null,
      isLoading: false,
      stale: false,
    };
    const markup = render(false);
    mocks.chartState = before;
    expect(markup).toContain('data-testid="market-chart-stage"');
    expect(markup).toContain("Not enough 5 min bars recorded for ETH yet.");
  });
});
