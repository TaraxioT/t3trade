// ---------------------------------------------------------------------------
// threadMarketPanelState
// ---------------------------------------------------------------------------
//
// The two pure decisions behind the companion market panel: which market the
// chat is about, and which slice of the account belongs to it.
//
// Kept apart from the components so both can be read as rules rather than
// traced through a render, and tested without mounting anything.

import type {
  OrchestrationTradingMission,
  TradingAccountState,
  TradingThreadMarketFocus,
} from "@t3tools/contracts";

/** What the thread panel draws: one market, and exactly one chart of it. */
export interface ThreadPanelComposition {
  /** The market the whole panel is about, or null for no panel at all. */
  readonly asset: string | null;
  /**
   * Which chart draws that market. `mission` is the mission chart with the
   * plan's entry, stop, target and armed levels on it; `market` is the plain
   * market chart. Never both, and null when there is no panel.
   */
  readonly chart: "mission" | "market" | null;
}

/**
 * What the one panel beside the conversation is composed of.
 *
 * A bound mission wins. It is the thread's committed subject, it has money on
 * it, and its chart is the only one carrying the plan's levels; a look is the
 * agent glancing at something on the way. Deciding the market and the chart in
 * one rule is the point: choosing them separately is how the panel ended up
 * drawing a mission's levels over another market's candles.
 *
 * The focus row is the fallback, and it is the market chart's own case: a
 * thread seeded from the trade home, or moved by the agent's own look, is
 * about a market and not yet about a position.
 */
export function selectThreadPanel(input: {
  readonly focus: TradingThreadMarketFocus | null;
  readonly mission: OrchestrationTradingMission | null;
}): ThreadPanelComposition {
  if (input.mission !== null) return { asset: input.mission.market, chart: "mission" };
  if (input.focus !== null) return { asset: input.focus.market.asset, chart: "market" };
  return { asset: null, chart: null };
}

/**
 * The accounts, carrying only what happens on `asset`.
 *
 * `AccountPositionsPanel` reads whole accounts, so scoping it to one market is
 * a filter on the way in rather than a second panel. Accounts with nothing left
 * on the market are dropped, so the panel's own "No open positions." is what
 * shows rather than a stack of empty account headers — but the balance line
 * survives, because how much is in the account is still true here.
 */
export function filterAccountsToMarket(
  accounts: ReadonlyArray<TradingAccountState>,
  asset: string,
): ReadonlyArray<TradingAccountState> {
  return accounts
    .map((account) => ({
      ...account,
      positions: account.positions.filter((position) => position.market.asset === asset),
      openOrders: account.openOrders.filter((order) => order.market.asset === asset),
    }))
    .filter(
      (account) =>
        account.positions.length > 0 ||
        account.openOrders.length > 0 ||
        account.balanceUsd !== null,
    );
}
