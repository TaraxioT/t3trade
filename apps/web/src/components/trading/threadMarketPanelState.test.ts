import { describe, expect, it } from "vite-plus/test";

import type {
  OrchestrationTradingMission,
  TradingAccountOpenOrder,
  TradingAccountPosition,
  TradingAccountState,
  TradingThreadMarketFocus,
} from "@t3tools/contracts";

import {
  filterAccountsToMarket,
  missionOnMarket,
  selectThreadPanel,
} from "./threadMarketPanelState";

const focusOn = (asset: string): TradingThreadMarketFocus =>
  ({
    threadId: "thread_1",
    market: { venue: "hyperliquid", asset },
    source: "look",
    updatedAt: "2026-08-28T12:00:00.000Z",
  }) as TradingThreadMarketFocus;

const missionOn = (market: string, markets?: ReadonlyArray<string>): OrchestrationTradingMission =>
  ({
    id: "mission_1",
    threadId: "thread_1",
    market,
    markets: markets ?? [market],
  }) as unknown as OrchestrationTradingMission;

const position = (asset: string): TradingAccountPosition =>
  ({
    market: { venue: "hyperliquid", asset },
    size: 1,
    unrealisedPnl: 0,
    marginUsed: 10,
    protectedSize: 0,
    protection: null,
    authority: { kind: "manual" },
    observedAt: "2026-08-28T12:00:00.000Z",
  }) as TradingAccountPosition;

const order = (asset: string): TradingAccountOpenOrder =>
  ({
    market: { venue: "hyperliquid", asset },
    cloid: `cloid-${asset}`,
    orderId: 1,
    side: "buy",
    limitPrice: 100,
    remainingSize: 1,
    reduceOnly: false,
    authority: { kind: "manual" },
    observedAt: "2026-08-28T12:00:00.000Z",
  }) as TradingAccountOpenOrder;

const account = (input: {
  readonly accountId: string;
  readonly balanceUsd: number | null;
  readonly positions: ReadonlyArray<TradingAccountPosition>;
  readonly openOrders: ReadonlyArray<TradingAccountOpenOrder>;
}): TradingAccountState =>
  ({
    accountId: input.accountId,
    venue: "hyperliquid",
    balanceUsd: input.balanceUsd,
    withdrawableUsd: null,
    balanceObservedAt: null,
    positions: input.positions,
    openOrders: input.openOrders,
  }) as TradingAccountState;

describe("selectThreadPanel", () => {
  it("has no panel for a thread that never named a market", () => {
    expect(selectThreadPanel({ focus: null, mission: null })).toEqual({
      asset: null,
      chart: null,
    });
  });

  it("draws the market chart for a thread that has only looked at one", () => {
    expect(selectThreadPanel({ focus: focusOn("SOL"), mission: null })).toEqual({
      asset: "SOL",
      chart: "market",
    });
  });

  it("lets a bound mission win over the focus row, market and chart together", () => {
    // The mission's chart is the only one carrying the plan's levels, so the
    // panel has to be about the mission's market or the levels would be drawn
    // across another market's candles.
    expect(selectThreadPanel({ focus: focusOn("SOL"), mission: missionOn("ETH") })).toEqual({
      asset: "ETH",
      chart: "mission",
    });
  });

  // A mission holds a set, and focus within it is the thread saying which of
  // its own markets it is talking about — the agent's look and the card's
  // switcher write the same row.
  it("follows focus onto another market the mission holds", () => {
    expect(
      selectThreadPanel({ focus: focusOn("BTC"), mission: missionOn("ETH", ["ETH", "BTC"]) }),
    ).toEqual({ asset: "BTC", chart: "mission" });
  });

  it("stays on a held market when focus lands outside the held set", () => {
    expect(
      selectThreadPanel({ focus: focusOn("SOL"), mission: missionOn("ETH", ["ETH", "BTC"]) }),
    ).toEqual({ asset: "ETH", chart: "mission" });
  });

  it("draws the mission chart for threads that predate the focus row", () => {
    expect(selectThreadPanel({ focus: null, mission: missionOn("ETH") })).toEqual({
      asset: "ETH",
      chart: "mission",
    });
  });

  it("never selects two charts", () => {
    const cases = [
      { focus: null, mission: null },
      { focus: focusOn("SOL"), mission: null },
      { focus: null, mission: missionOn("ETH") },
      { focus: focusOn("SOL"), mission: missionOn("ETH") },
      { focus: focusOn("BTC"), mission: missionOn("ETH", ["ETH", "BTC"]) },
    ];
    for (const input of cases) {
      const { chart } = selectThreadPanel(input);
      expect(["mission", "market", null]).toContain(chart);
    }
  });
});

describe("missionOnMarket", () => {
  const multi = {
    id: "mission_1",
    threadId: "thread_1",
    market: "ETH",
    markets: ["ETH", "BTC"],
    marketPrice: 3_000,
    marketPrices: [
      { market: "ETH", price: 3_000 },
      { market: "BTC", price: 90_000 },
    ],
    position: { market: "ETH", size: 0.5 },
    positions: [
      { market: "ETH", size: 0.5 },
      { market: "BTC", size: -0.01 },
    ],
    strategy: { market: "ETH", intent: "long" },
    strategies: [
      { market: "ETH", intent: "long" },
      { market: "BTC", intent: "short" },
    ],
    orders: [{ market: "ETH" }, { market: "BTC" }],
    recentFills: [{ market: "BTC" }],
    inFlightExecution: { market: "BTC" },
  } as unknown as OrchestrationTradingMission;

  it("hands back the mission itself for its primary market", () => {
    expect(missionOnMarket(multi, "ETH")).toBe(multi);
  });

  // The singular fields are the PRIMARY market's, so reading them for a second
  // market is how an ETH plan would end up drawn over BTC candles.
  it("swaps every singular field for the named market's own", () => {
    const btc = missionOnMarket(multi, "BTC");
    expect(btc.market).toBe("BTC");
    expect(btc.position?.market).toBe("BTC");
    expect(btc.strategy?.market).toBe("BTC");
    expect(btc.marketPrice).toBe(90_000);
    expect(btc.orders.map((order) => order.market)).toEqual(["BTC"]);
    expect(btc.recentFills.map((fill) => fill.market)).toEqual(["BTC"]);
    expect(btc.inFlightExecution?.market).toBe("BTC");
    // The held set itself is a property of the mission, not of one market.
    expect([...btc.markets]).toEqual(["ETH", "BTC"]);
  });

  it("draws nothing rather than the wrong thing on a market with no position", () => {
    const sol = missionOnMarket(multi, "SOL");
    expect(sol.position).toBe(null);
    expect(sol.strategy).toBe(null);
    expect(sol.marketPrice).toBe(undefined);
    expect(sol.orders).toEqual([]);
    expect(sol.inFlightExecution).toBe(null);
  });
});

describe("filterAccountsToMarket", () => {
  const accounts = [
    account({
      accountId: "account_a",
      balanceUsd: 1_000,
      positions: [position("ETH"), position("SOL")],
      openOrders: [order("ETH"), order("BTC")],
    }),
    account({
      accountId: "account_b",
      balanceUsd: null,
      positions: [position("BTC")],
      openOrders: [],
    }),
  ];

  it("keeps only what happens on the market", () => {
    const [first] = filterAccountsToMarket(accounts, "ETH");
    expect(first?.positions.map((entry) => entry.market.asset)).toEqual(["ETH"]);
    expect(first?.openOrders.map((entry) => entry.market.asset)).toEqual(["ETH"]);
  });

  it("drops an account left with nothing and no balance to report", () => {
    // account_b holds only BTC and has never been reconciled, so scoping to
    // ETH leaves it with nothing worth a header.
    expect(filterAccountsToMarket(accounts, "ETH").map((entry) => entry.accountId)).toEqual([
      "account_a",
    ]);
  });

  it("keeps an account with a balance but nothing on the market", () => {
    // The balance line is still true on a market the account is flat on, and
    // the panel's own "No open positions." is the honest empty state.
    const scoped = filterAccountsToMarket(accounts, "DOGE");
    expect(scoped.map((entry) => entry.accountId)).toEqual(["account_a"]);
    expect(scoped[0]?.positions).toEqual([]);
    expect(scoped[0]?.openOrders).toEqual([]);
  });

  it("leaves the source accounts untouched", () => {
    filterAccountsToMarket(accounts, "ETH");
    expect(accounts[0]?.positions.length).toBe(2);
  });
});
