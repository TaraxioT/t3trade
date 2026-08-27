import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, OrchestrationTradingMission, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useEffect } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { orchestrationEnvironment } from "../state/orchestration";

function tradingMissionSnapshotAtom(environmentId: EnvironmentId) {
  return orchestrationEnvironment.tradingMissionSnapshot({ environmentId, input: {} });
}

function tradingAccountInvalidationsAtom(environmentId: EnvironmentId) {
  return orchestrationEnvironment.tradingAccountInvalidations({ environmentId, input: {} });
}

export function refreshTradingMissions(environmentId: EnvironmentId): void {
  appAtomRegistry.refresh(tradingMissionSnapshotAtom(environmentId));
}

/**
 * The slow fallback re-read for a mounted mission surface.
 *
 * The projection is push-invalidated now: the server publishes an invalidation
 * on every trading event and every reconcile pass, and the subscription below
 * refetches on each one — that is what replaced the old 3s poll. This interval
 * survives only as a backstop for the cases push cannot cover: an older server
 * without the subscription RPC, or a subscription that failed without a
 * session change to restart it.
 */
const MISSION_FALLBACK_POLL_INTERVAL_MS = 30_000;

export interface TradingMissionsState {
  readonly missions: ReadonlyArray<OrchestrationTradingMission>;
  readonly error: string | null;
  readonly isLoading: boolean;
  readonly refresh: () => void;
}

/**
 * The trading missions projected for one environment.
 *
 * Everything here comes from `projection_trading_missions`, which the trading
 * projector rebuilds from the event stream. There is no client-side mission
 * state to go stale, and nothing is synthesized when the projection is empty.
 */
export function useTradingMissions(environmentId: EnvironmentId): TradingMissionsState {
  const result = useAtomValue(tradingMissionSnapshotAtom(environmentId));
  const snapshot = Option.getOrNull(AsyncResult.value(result));

  const refresh = useCallback(() => {
    refreshTradingMissions(environmentId);
  }, [environmentId]);

  // Push: the server's invalidation doorbell. The atom's value is the latest
  // stream event, so a new revision means "the trading tables moved" — a fill,
  // a status change, a reconcile pass — and one refetch answers it.
  const invalidation = useAtomValue(tradingAccountInvalidationsAtom(environmentId));
  const revision = Option.getOrNull(AsyncResult.value(invalidation))?.revision ?? null;
  useEffect(() => {
    if (revision === null) {
      return;
    }
    refresh();
  }, [revision, refresh]);

  useEffect(() => {
    const id = window.setInterval(refresh, MISSION_FALLBACK_POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  return {
    missions: snapshot?.missions ?? [],
    error: result._tag === "Failure" ? "Failed to load trading missions." : null,
    isLoading: result.waiting,
    refresh,
  };
}

/**
 * The single mission bound to a thread, if any (§10.2: one active mission per
 * thread). Client-side filter over the environment snapshot — the projection
 * already carries `threadId`, so no contract change is needed for Phase 2.
 *
 * `mission` is `null` when the thread has no bound mission (the common case for
 * non-trading threads); the caller gates the UI on that. `error` is carried
 * alongside because a thread holding exposure has to be able to say the feed
 * stopped — a mission that looks frozen and a mission whose poll is failing are
 * the same picture otherwise.
 */
export function useTradingMissionForThread(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): { readonly mission: OrchestrationTradingMission | null; readonly error: string | null } {
  const { missions, error } = useTradingMissions(environmentId);
  return { mission: missions.find((m) => m.threadId === threadId) ?? null, error };
}
