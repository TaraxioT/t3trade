/**
 * The market card's attachment seam: the thread's market renders as the
 * composer's topmost drawer — content inside the glass shell — never as a
 * floating card above it. What is pinned here is the surface the card renders
 * on, the collapse behavior that must survive the move, and the stylesheet
 * contract the drawer and the graph viewport depend on. The chart's own
 * rendering is MarketChartPanel's seam (MarketChartPanel.test.tsx).
 */
// @effect-diagnostics nodeBuiltinImport:off - Contract checks read index.css for the drawer and viewport classes.
import * as NodeFS from "node:fs";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { ThreadMarketCard, type ThreadMarketCardProps } from "./ThreadMarketCard";

const THREAD_KEY = "env-1:thread-1";

const store = vi.hoisted(() => {
  const setCardCollapsedCalls: Array<[threadKey: string, collapsed: boolean]> = [];
  const store = {
    collapsed: false,
    setCardCollapsedCalls,
    setCardCollapsed: (threadKey: string, collapsed: boolean) => {
      setCardCollapsedCalls.push([threadKey, collapsed]);
      store.collapsed = collapsed;
    },
  };
  return store;
});

// The card holds no React state of its own — its one decision (folded or not)
// lives in the per-thread store — so the toggle can be exercised by calling
// the component as a function, the way AddProviderInstanceWizardSteps does.
// That needs `useCallback` to work without a render dispatcher.
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useCallback: (factory: unknown) => factory,
  useMemo: (factory: () => unknown) => factory(),
  useEffect: (effect: () => void) => effect(),
}));

const cardStateStore = vi.hoisted(() => {
  let graphMode: "mission" | "research" = "mission";
  let studyOverlay: string | null = null;
  let scenes: Array<any> | null = [];
  let isLoading = false;
  let error: string | null = null;
  const setGraphModeCalls: Array<[scopeKey: string, mode: "mission" | "research"]> = [];
  const setStudyOverlayCalls: Array<[scopeKey: string, sceneId: string | null]> = [];
  return {
    get graphMode() {
      return graphMode;
    },
    set graphMode(m: "mission" | "research") {
      graphMode = m;
    },
    get studyOverlay() {
      return studyOverlay;
    },
    set studyOverlay(s: string | null) {
      studyOverlay = s;
    },
    get scenes() {
      return scenes;
    },
    set scenes(s: Array<any> | null) {
      scenes = s;
    },
    get isLoading() {
      return isLoading;
    },
    set isLoading(l: boolean) {
      isLoading = l;
    },
    get error() {
      return error;
    },
    set error(e: string | null) {
      error = e;
    },
    setGraphModeCalls,
    setStudyOverlayCalls,
    setGraphMode: (scopeKey: string, mode: "mission" | "research") => {
      setGraphModeCalls.push([scopeKey, mode]);
      cardStateStore.graphMode = mode;
    },
    setStudyOverlay: (scopeKey: string, sceneId: string | null) => {
      setStudyOverlayCalls.push([scopeKey, sceneId]);
      cardStateStore.studyOverlay = sceneId;
    },
    reset: () => {
      graphMode = "mission";
      studyOverlay = null;
      scenes = [];
      isLoading = false;
      error = null;
      setGraphModeCalls.length = 0;
      setStudyOverlayCalls.length = 0;
    },
  };
});

vi.mock("./threadMarketCardState", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./threadMarketCardState")>();
  return {
    ...actual,
    threadMarketScopeKey: (env: string, thread: string, asset: string) =>
      `${env}:${thread}:${asset}`,
    useThreadMarketGraphMode: () => cardStateStore.graphMode,
    useThreadStudyOverlay: () => cardStateStore.studyOverlay,
    useThreadMarketCardStore: <T,>(
      selector: (state: ReturnType<typeof actual.useThreadMarketCardStore.getState>) => T,
    ): T =>
      selector({
        ...actual.useThreadMarketCardStore.getState(),
        graphModeByScope: { "env-1:thread-1:ETH": cardStateStore.graphMode },
        studyOverlayByScope: { "env-1:thread-1:ETH": cardStateStore.studyOverlay },
        setGraphMode: cardStateStore.setGraphMode,
        setStudyOverlay: cardStateStore.setStudyOverlay as never,
      }),
  };
});

vi.mock("../../lib/tradingResearchScenesState", () => ({
  useTradingResearchScenes: (
    _environmentId: unknown,
    _threadId: unknown,
    options: { readonly enabled: boolean },
  ) =>
    options.enabled
      ? {
          scenes: cardStateStore.scenes,
          isLoading: cardStateStore.isLoading,
          error: cardStateStore.error,
          refresh: vi.fn(),
        }
      : { scenes: [], isLoading: false, error: null, refresh: vi.fn() },
}));

vi.mock("./threadMarketPanelStore", () => ({
  useThreadMarketCardCollapsed: () => store.collapsed,
  useThreadMarketPanelStore: () => store.setCardCollapsed,
}));

vi.mock("../../lib/tradingAccountState", () => ({
  useTradingAccountView: () => ({ data: { accounts: [] }, isLoading: false, error: null }),
}));
vi.mock("../../lib/tradingThreadMarketState", () => ({
  refreshTradingThreadMarket: () => Promise.resolve(),
}));
vi.mock("../../state/orchestration", () => ({
  orchestrationEnvironment: { setTradingThreadMarket: "setTradingThreadMarket" },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("./AccountPositionsPanel", () => ({
  AccountPositionsPanel: () => <div data-testid="account-positions-stub" />,
}));
vi.mock("./MarketChartPanel", () => ({
  MarketChartPanel: () => <div data-testid="market-chart-stub" />,
}));
vi.mock("./MissionLivePanel", () => ({
  MissionLivePanel: ({ parts }: { parts?: string }) => (
    <div data-testid={`mission-live-stub-${parts ?? "default"}`} data-parts={parts} />
  ),
}));
vi.mock("./ThreadMarketPanel", () => ({
  MarketQuote: () => <span data-testid="market-quote-stub" />,
}));

const PROPS: ThreadMarketCardProps = {
  environmentId: "env-1" as ThreadMarketCardProps["environmentId"],
  asset: "ETH",
  mission: null,
  missions: [],
  threadKey: THREAD_KEY,
  threadId: "thread-1" as ThreadMarketCardProps["threadId"],
};

const render = (collapsed: boolean, mission?: unknown) => {
  store.collapsed = collapsed;
  return renderToStaticMarkup(<ThreadMarketCard {...PROPS} mission={(mission ?? null) as never} />);
};

interface TestIdProps {
  readonly "data-testid"?: string;
  readonly "data-open"?: string;
  readonly onClick?: () => void;
  readonly children?: unknown;
}

const findToggle = (root: ReactElement<TestIdProps>): ReactElement<TestIdProps> => {
  const queue: unknown[] = [root];
  while (queue.length > 0) {
    const next = queue.shift();
    if (!isValidElement(next)) continue;
    const element = next as ReactElement<TestIdProps>;
    if (element.props["data-testid"] === "thread-market-card-toggle") return element;
    queue.push(...Children.toArray(element.props.children as ReactNode));
  }
  throw new Error("toggle button not rendered");
};

describe("ThreadMarketCard: attached to the composer's glass shell", () => {
  it("renders on the composer's drawer surface, not an independent card", () => {
    const markup = render(false);

    expect(markup).toContain('data-testid="thread-market-card"');
    expect(markup).toContain("chat-composer-market-drawer");
    expect(markup).toContain("pointer-events-auto");
    // The old floating-card surface is gone: no border, fill or blur of its own.
    expect(markup).not.toContain("border-border/60");
    expect(markup).not.toContain("bg-background/95");
    expect(markup).not.toContain("backdrop-blur-sm");
    expect(markup).not.toContain("rounded-xl");
    expect(markup).not.toContain("max-w-3xl");
  });

  it("keeps a compact attached header while collapsed and unmounts the body", () => {
    const markup = render(true);

    expect(markup).toContain('data-open="false"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('data-testid="thread-market-card-toggle"');
    expect(markup).toContain('data-testid="market-quote-stub"');
    expect(markup).toContain("ETH");
    expect(markup).not.toContain('data-testid="market-chart-stub"');
    expect(markup).not.toContain("max-h-[46vh]");
  });

  it("expands into a body that scrolls inside the drawer", () => {
    const markup = render(false);

    expect(markup).toContain('data-open="true"');
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('data-testid="market-chart-stub"');
    expect(markup).toContain("max-h-[46vh]");
    expect(markup).toContain("overflow-y-auto");
  });

  it("keeps the market switcher for a mission holding more than one market", () => {
    const markup = render(false, {
      market: "ETH",
      markets: ["ETH", "BTC"],
      status: "position_open",
      mandateOrigin: "direct_order",
      marketPrice: 1_000,
      marketPrices: [],
      positions: [],
      strategies: [],
      orders: [],
      recentFills: [],
      inFlightExecution: null,
    });

    expect(markup).toContain('data-testid="thread-market-switcher"');
    expect(markup).toContain("Direct order");
  });

  it("the toggle writes the thread's fold choice, and the next render folds", () => {
    store.collapsed = false;
    store.setCardCollapsedCalls.length = 0;

    const open = ThreadMarketCard({ ...PROPS });
    if (!isValidElement<TestIdProps>(open)) throw new Error("card did not render");
    expect(open.props["data-open"]).toBe("true");
    findToggle(open).props.onClick?.();

    expect(store.setCardCollapsedCalls).toEqual([[THREAD_KEY, true]]);

    // The stored choice is what the next render reads: still attached, folded.
    const folded = ThreadMarketCard({ ...PROPS });
    if (!isValidElement<TestIdProps>(folded)) throw new Error("card did not render");
    expect(folded.props["data-open"]).toBe("false");
    expect(Children.toArray(folded.props.children as ReactNode)).toHaveLength(1);
  });

  it("for a bound mission, defaults to Mission graph and mounts only mission chart", () => {
    cardStateStore.reset();
    const markup = render(false, {
      market: "ETH",
      markets: ["ETH"],
      status: "position_open",
      mandateOrigin: "user_chat",
      marketPrice: 2000,
      marketPrices: [],
      positions: [],
      strategies: [],
      orders: [],
      recentFills: [],
      inFlightExecution: null,
    });

    // Graph switcher is rendered and has Mission selected
    expect(markup).toContain('data-testid="thread-graph-switcher"');
    expect(markup).toContain('data-graph-mode="mission"');
    expect(markup).toContain('data-graph-mode="research"');

    // Only mission chart mounts, not the research chart
    expect(markup).toContain('data-testid="mission-live-stub-chart"');
    expect(markup).not.toContain('data-testid="market-chart-stub"');

    // Persistent mission info is mounted
    expect(markup).toContain('data-testid="mission-live-stub-info"');
  });

  it("switching to Research mounts only research chart while keeping mission info accessible", () => {
    cardStateStore.reset();
    cardStateStore.graphMode = "research";

    const markup = render(false, {
      market: "ETH",
      markets: ["ETH"],
      status: "position_open",
      mandateOrigin: "user_chat",
      marketPrice: 2000,
      marketPrices: [],
      positions: [],
      strategies: [],
      orders: [],
      recentFills: [],
      inFlightExecution: null,
    });

    // Only research chart mounts, not the mission chart
    expect(markup).toContain('data-testid="market-chart-stub"');
    expect(markup).not.toContain('data-testid="mission-live-stub-chart"');

    // Mission info remains accessible in Research view
    expect(markup).toContain('data-testid="mission-live-stub-info"');
  });

  it("for an unbound research thread, does not render the Mission/Research selector", () => {
    const markup = render(false, null);

    // No selector
    expect(markup).not.toContain('data-testid="thread-graph-switcher"');
    // Unbound body renders research chart and account positions
    expect(markup).toContain('data-testid="market-chart-stub"');
    expect(markup).toContain('data-testid="account-positions-stub"');
  });

  it("renders compact Study selector with Off and compatible studies when bound mission has published studies", () => {
    cardStateStore.reset();
    cardStateStore.scenes = [
      { sceneId: "scene-eth-spike", title: "ETH Funding Spike", eventStudy: { market: "ETH" } },
      { sceneId: "scene-eth-breakout", title: "ETH Breakout", eventStudy: { market: "eth" } },
      { sceneId: "scene-btc-halving", title: "BTC Halving", eventStudy: { market: "BTC" } },
    ];

    const markup = render(false, {
      market: "ETH",
      markets: ["ETH"],
      status: "position_open",
      mandateOrigin: "user_chat",
      marketPrice: 2000,
      marketPrices: [],
      positions: [],
      strategies: [],
      orders: [],
      recentFills: [],
      inFlightExecution: null,
    });

    expect(markup).toContain('data-testid="mission-study-selector"');
    expect(markup).toContain('data-testid="mission-study-option-off"');
    expect(markup).toContain('data-testid="mission-study-option-scene-eth-spike"');
    expect(markup).toContain("ETH Funding Spike");
    expect(markup).toContain('data-testid="mission-study-option-scene-eth-breakout"');
    expect(markup).toContain("ETH Breakout");
    // BTC study must NOT be offered on ETH mission
    expect(markup).not.toContain("BTC Halving");
  });

  it("does not render Study selector when there are no compatible event studies for the mission's asset", () => {
    cardStateStore.reset();
    cardStateStore.scenes = [
      { sceneId: "scene-btc-halving", title: "BTC Halving", eventStudy: { market: "BTC" } },
      { sceneId: "scene-eth-note", title: "ETH Note", annotation: { market: "ETH" } },
    ];

    const markup = render(false, {
      market: "ETH",
      markets: ["ETH"],
      status: "position_open",
      mandateOrigin: "user_chat",
      marketPrice: 2000,
      marketPrices: [],
      positions: [],
      strategies: [],
      orders: [],
      recentFills: [],
      inFlightExecution: null,
    });

    expect(markup).not.toContain('data-testid="mission-study-selector"');
  });

  it("does not render Study selector when graphMode is research", () => {
    cardStateStore.reset();
    cardStateStore.graphMode = "research";
    cardStateStore.scenes = [
      { sceneId: "scene-eth-spike", title: "ETH Funding Spike", eventStudy: { market: "ETH" } },
    ];

    const markup = render(false, {
      market: "ETH",
      markets: ["ETH"],
      status: "position_open",
      mandateOrigin: "user_chat",
      marketPrice: 2000,
      marketPrices: [],
      positions: [],
      strategies: [],
      orders: [],
      recentFills: [],
      inFlightExecution: null,
    });

    expect(markup).not.toContain('data-testid="mission-study-selector"');
    expect(markup).toContain('data-testid="market-chart-stub"');
  });

  it("clears selected overlay upon confirmed scene removal, but preserves it during loading or error", () => {
    cardStateStore.reset();
    cardStateStore.studyOverlay = "removed-scene-1";

    // 1. Loading state: must NOT clear overlay
    cardStateStore.isLoading = true;
    cardStateStore.scenes = [];
    render(false, {
      market: "ETH",
      markets: ["ETH"],
      status: "position_open",
      mandateOrigin: "user_chat",
      marketPrice: 2000,
      marketPrices: [],
      positions: [],
      strategies: [],
      orders: [],
      recentFills: [],
      inFlightExecution: null,
    });
    expect(cardStateStore.setStudyOverlayCalls).toEqual([]);

    // 2. Error state: must NOT clear overlay
    cardStateStore.isLoading = false;
    cardStateStore.error = "Network timeout";
    render(false, {
      market: "ETH",
      markets: ["ETH"],
      status: "position_open",
      mandateOrigin: "user_chat",
      marketPrice: 2000,
      marketPrices: [],
      positions: [],
      strategies: [],
      orders: [],
      recentFills: [],
      inFlightExecution: null,
    });
    expect(cardStateStore.setStudyOverlayCalls).toEqual([]);

    // 3. Confirmed removal (!isLoading && error === null && scenes loaded but missing scene):
    // must explicitly reset to null (Off)
    cardStateStore.error = null;
    cardStateStore.scenes = [];
    render(false, {
      market: "ETH",
      markets: ["ETH"],
      status: "position_open",
      mandateOrigin: "user_chat",
      marketPrice: 2000,
      marketPrices: [],
      positions: [],
      strategies: [],
      orders: [],
      recentFills: [],
      inFlightExecution: null,
    });
    expect(cardStateStore.setStudyOverlayCalls).toEqual([["env-1:thread-1:ETH", null]]);
  });

  it("backs the drawer surface and the graph viewport with real stylesheet rules", () => {
    const stylesheet = NodeFS.readFileSync(new URL("../../trading.css", import.meta.url), "utf8");
    // Whitespace-stripped so formatter line wrapping cannot break the check.
    const compact = stylesheet.replace(/\s+/g, "");

    // The market drawer shares the composer drawer material, including the
    // masked glass pseudo-element that paints the inset surface and its seam.
    expect(compact).toContain(".chat-composer-market-drawer{");
    expect(compact).toContain(
      ":is(.chat-composer-drawer-surface,.chat-composer-top-drawer,.chat-composer-market-drawer)::before{",
    );
    // The frozen graph viewport contract other surfaces consume.
    expect(compact).toContain(".trading-graph-viewport{");
    expect(compact).toContain("clamp(300px,46vh,470px)");
    expect(compact).toContain("clamp(200px,30vh,280px)");
    expect(compact).toContain(".trading-graph-viewport-research{");
  });
});
