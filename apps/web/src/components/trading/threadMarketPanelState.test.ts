import { describe, expect, it } from "vite-plus/test";

import type {
  OrchestrationTradingMission,
  TradingAccountOpenOrder,
  TradingAccountPosition,
  TradingAccountState,
  TradingThreadMarketFocus,
} from "@t3tools/contracts";

import { filterAccountsToMarket, selectThreadMarket } from "./threadMarketPanelState";

const focusOn = (asset: string): TradingThreadMarketFocus =>
  ({
    threadId: "thread_1",
    market: { venue: "hyperliquid", asset },
    source: "look",
    updatedAt: "2026-08-28T12:00:00.000Z",
  }) as TradingThreadMarketFocus;

const missionOn = (market: string): OrchestrationTradingMission =>
  ({ id: "mission_1", threadId: "thread_1", market }) as unknown as OrchestrationTradingMission;

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

describe("selectThreadMarket", () => {
  it("has no market for a thread that never named one", () => {
    expect(selectThreadMarket({ focus: null, mission: null })).toBeNull();
  });

  it("takes the focus row, which is the most recent market by construction", () => {
    expect(selectThreadMarket({ focus: focusOn("SOL"), mission: null })).toBe("SOL");
  });

  it("prefers the focus row over the bound mission's market", () => {
    expect(selectThreadMarket({ focus: focusOn("SOL"), mission: missionOn("ETH") })).toBe("SOL");
  });

  it("falls back to the bound mission for threads that predate the row", () => {
    expect(selectThreadMarket({ focus: null, mission: missionOn("ETH") })).toBe("ETH");
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
