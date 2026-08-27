/**
 * The trade home's read models: account view, watchlist, armed watches, and
 * the alert feed (final-form Phases 4+5).
 *
 * All four are server truths served whole by their RPCs; nothing here derives
 * client-side state. Freshness rides the account doorbell
 * (`subscribeTradingAccount`): the server publishes an invalidation on every
 * trading event — a fill, a watchlist edit, an alert append — and each hook
 * refetches once per ring. There are no poll intervals in this module by
 * design; the mission snapshot's 30s backstop (see `tradingMissionsState`)
 * exists for older servers, and these RPCs have no older servers to cover.
 *
 * @module tradingAccountState
 */
import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  TradingAccountView,
  TradingAccountWatch,
  TradingAlertEvent,
  TradingWatchlistEntry,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, type Atom } from "effect/unstable/reactivity";
import { useCallback, useEffect } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { orchestrationEnvironment } from "../state/orchestration";

/** How many alerts the feed asks for. Server clamps to [1, 200]. */
const ALERT_FEED_LIMIT = 50;

function accountViewAtom(environmentId: EnvironmentId) {
  return orchestrationEnvironment.tradingAccountView({ environmentId, input: {} });
}

function watchlistAtom(environmentId: EnvironmentId) {
  return orchestrationEnvironment.tradingWatchlist({ environmentId, input: {} });
}

function watchesAtom(environmentId: EnvironmentId) {
  return orchestrationEnvironment.tradingWatches({ environmentId, input: {} });
}

function alertsAtom(environmentId: EnvironmentId) {
  return orchestrationEnvironment.tradingAlerts({
    environmentId,
    input: { limit: ALERT_FEED_LIMIT },
  });
}

export function refreshTradingWatchlist(environmentId: EnvironmentId): void {
  appAtomRegistry.refresh(watchlistAtom(environmentId));
}

export function refreshTradingWatches(environmentId: EnvironmentId): void {
  appAtomRegistry.refresh(watchesAtom(environmentId));
}

export function refreshTradingAlerts(environmentId: EnvironmentId): void {
  appAtomRegistry.refresh(alertsAtom(environmentId));
}

export function refreshTradingAccountView(environmentId: EnvironmentId): void {
  appAtomRegistry.refresh(accountViewAtom(environmentId));
}

/**
 * Subscribe one query atom to the account doorbell: refetch once per
 * invalidation revision. The subscription atom is shared per environment, so
 * four hooks on one page cost one stream, not four.
 */
function useDoorbellRefresh(environmentId: EnvironmentId, refresh: () => void): void {
  const invalidation = useAtomValue(
    orchestrationEnvironment.tradingAccountInvalidations({ environmentId, input: {} }),
  );
  const revision = Option.getOrNull(AsyncResult.value(invalidation))?.revision ?? null;
  useEffect(() => {
    if (revision === null) return;
    refresh();
  }, [revision, refresh]);
}

interface QueryState<T> {
  readonly data: T | null;
  readonly error: string | null;
  readonly isLoading: boolean;
  readonly refresh: () => void;
}

function useDoorbellQuery<T>(
  environmentId: EnvironmentId,
  atom: (environmentId: EnvironmentId) => Atom.Atom<AsyncResult.AsyncResult<T, unknown>>,
  failureMessage: string,
): QueryState<T> {
  const result = useAtomValue(atom(environmentId));
  const refresh = useCallback(() => {
    appAtomRegistry.refresh(atom(environmentId));
  }, [atom, environmentId]);
  useDoorbellRefresh(environmentId, refresh);
  return {
    data: Option.getOrNull(AsyncResult.value(result)),
    error: result._tag === "Failure" ? failureMessage : null,
    isLoading: result.waiting,
    refresh,
  };
}

/** The account read model: balances, positions, open orders, archiver health. */
export function useTradingAccountView(
  environmentId: EnvironmentId,
): QueryState<TradingAccountView> {
  return useDoorbellQuery(environmentId, accountViewAtom, "Failed to load the trading account.");
}

export interface TradingWatchlistState extends QueryState<{
  readonly entries: ReadonlyArray<TradingWatchlistEntry>;
}> {}

/** The user-ordered watchlist, served in `position` order. */
export function useTradingWatchlist(environmentId: EnvironmentId): TradingWatchlistState {
  return useDoorbellQuery(environmentId, watchlistAtom, "Failed to load the watchlist.");
}

/** Account-scoped armed watches, cancel targets included. */
export function useTradingWatches(
  environmentId: EnvironmentId,
): QueryState<{ readonly watches: ReadonlyArray<TradingAccountWatch> }> {
  return useDoorbellQuery(environmentId, watchesAtom, "Failed to load armed alerts.");
}

/** The fired-alert feed, newest first. */
export function useTradingAlerts(
  environmentId: EnvironmentId,
): QueryState<{ readonly alerts: ReadonlyArray<TradingAlertEvent> }> {
  return useDoorbellQuery(environmentId, alertsAtom, "Failed to load the alert feed.");
}
