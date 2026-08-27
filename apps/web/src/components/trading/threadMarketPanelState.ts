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

/**
 * Which market the companion panel should draw, or null for no panel.
 *
 * Most recent wins: the server writes the focus row on every look, every seed
 * and every bind, so it is by construction the last market the conversation
 * turned to. The bound mission's market is the fallback for threads that
 * predate the row, so a mission created before this existed still gets a panel.
 */
export function selectThreadMarket(input: {
  readonly focus: TradingThreadMarketFocus | null;
  readonly mission: OrchestrationTradingMission | null;
}): string | null {
  if (input.focus !== null) return input.focus.market.asset;
  return input.mission?.market ?? null;
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
