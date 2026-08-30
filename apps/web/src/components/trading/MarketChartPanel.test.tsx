/**
 * MarketChartPanel's integration seam: a thread with a published scene gains
 * the Live / Calendar / Event aligned switcher, and only a chart docked in a
 * thread reads scenes at all (the trade home's chart stays live-first). The
 * calendar and aligned renderings themselves are pinned in
 * ResearchScenePanel.test.tsx and in the live browser pass; what is pinned
 * here is the wiring that decides which of those renders.
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
      n: 1,
      nCovered: 0,
      meanReturnPct: null,
      medianReturnPct: null,
      hitRatePercent: null,
      bestReturnPct: null,
      worstReturnPct: null,
      baseline: null,
      rows: [
        {
          startAt: T0 + 400 * DAY,
          endAt: T0 + 400 * DAY,
          label: "Futurera",
          source: "https://example.org/next",
          covered: false,
          reason: "still in the future: it ends after the last archived bar",
          truncated: false,
        },
      ],
      verdict: "0 of 1 occurrence falls inside archived data.",
    },
    occurrenceWindows: [],
    archiveBounds: { recordingSince: null, fromT: T0, toT: T0 + 40 * DAY },
  },
} as never;

const mocks = vi.hoisted(() => ({ ask: vi.fn() }));

vi.mock("../../lib/tradingMarketChartState", () => ({
  useTradingMarketChart: () => ({
    data: { candles: CANDLES, markPrice: 100 },
    error: null,
    stale: false,
  }),
}));

// Scenes follow the dock: the mock honours `enabled` the way the real polling
// hook does, so the trade-home render (no threadRef) sees none.
vi.mock("../../lib/tradingResearchScenesState", () => ({
  useTradingResearchScenes: (
    _environmentId: unknown,
    _threadId: unknown,
    options: { readonly enabled: boolean },
  ) =>
    options.enabled
      ? { scenes: [SCENE], isLoading: false, error: null }
      : { scenes: [], isLoading: false, error: null },
}));

vi.mock("./composerPrefill", () => ({ useComposerPrefill: () => null }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("./useTradingThreadLaunch", () => ({
  useAskAnalyst: () => ({ busy: false, error: null, ask: mocks.ask }),
  analystMarketPrompt: (asset: string) => asset,
}));

const render = (threaded: boolean) =>
  renderToStaticMarkup(
    <MarketChartPanel
      environmentId={"env" as never}
      asset="ETH"
      armable={false}
      {...(threaded ? { threadRef: { threadId: "thread-1" } as never } : {})}
    />,
  );

describe("MarketChartPanel: the research-mode seam", () => {
  it("a thread with a published scene gains Live, Calendar and Event aligned", () => {
    const markup = render(true);
    expect(markup).toContain('data-testid="market-chart-view-live"');
    expect(markup).toContain('data-testid="market-chart-view-calendar"');
    expect(markup).toContain('data-testid="market-chart-view-aligned"');
    expect(markup).toContain("Calendar");
    expect(markup).toContain("Event aligned");
    expect(markup).toContain("1 published scene");
  });

  it("the trade home's chart stays live-first: no research modes without a thread", () => {
    const markup = render(false);
    expect(markup).not.toContain('data-testid="market-chart-view-calendar"');
    expect(markup).not.toContain("published scene");
    // The live chart itself still draws, with its interval selector.
    expect(markup).toContain('data-testid="market-chart-interval-1d"');
  });

  it("the live view still renders the chart, not the research panel, until a mode is chosen", () => {
    const markup = render(true);
    expect(markup).not.toContain('data-testid="research-scene-panel"');
    expect(markup).toContain('data-testid="market-chart-interval-1d"');
  });
});
