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
}));

const cardStateStore = vi.hoisted(() => {
  let graphMode: "mission" | "research" = "mission";
  const setGraphModeCalls: Array<[scopeKey: string, mode: "mission" | "research"]> = [];
  return {
    get graphMode() {
      return graphMode;
    },
    set graphMode(m: "mission" | "research") {
      graphMode = m;
    },
    setGraphModeCalls,
    setGraphMode: (scopeKey: string, mode: "mission" | "research") => {
      setGraphModeCalls.push([scopeKey, mode]);
      cardStateStore.graphMode = mode;
    },
    reset: () => {
      graphMode = "mission";
      setGraphModeCalls.length = 0;
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
    useThreadMarketCardStore: (selector: (state: any) => any) =>
      selector({
        graphModeByScope: { "env-1:thread-1:ETH": cardStateStore.graphMode },
        setGraphMode: cardStateStore.setGraphMode,
      }),
  };
});

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
