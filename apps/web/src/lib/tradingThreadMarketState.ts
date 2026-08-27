/**
 * The market a chat thread is about, and the pure rule that picks it.
 *
 * The server keeps one row per thread — seeded by the trade home's "Trade in
 * chat", moved by the agent's own `trading_look`, and written again when the
 * thread takes authority on a market. This hook reads that row and rides the
 * account doorbell, which the server rings only when the row actually changes,
 * so a mission looking at the same market on every wake costs no refetches.
 *
 * Threads that were never about a market read `null` forever, which is the
 * common case: the read is one row by primary key, and the companion panel is
 * absent rather than empty.
 *
 * @module tradingThreadMarketState
 */
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ThreadId, TradingThreadMarketFocus } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useEffect } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { orchestrationEnvironment } from "../state/orchestration";

function threadMarketAtom(environmentId: EnvironmentId, threadId: ThreadId) {
  return orchestrationEnvironment.tradingThreadMarket({ environmentId, input: { threadId } });
}

export function refreshTradingThreadMarket(environmentId: EnvironmentId, threadId: ThreadId): void {
  appAtomRegistry.refresh(threadMarketAtom(environmentId, threadId));
}

export interface TradingThreadMarketState {
  readonly focus: TradingThreadMarketFocus | null;
  readonly isLoading: boolean;
}

/** The thread's market row, refetched once per doorbell ring. */
export function useTradingThreadMarketFocus(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): TradingThreadMarketState {
  const result = useAtomValue(threadMarketAtom(environmentId, threadId));
  const refresh = useCallback(() => {
    refreshTradingThreadMarket(environmentId, threadId);
  }, [environmentId, threadId]);

  const invalidation = useAtomValue(
    orchestrationEnvironment.tradingAccountInvalidations({ environmentId, input: {} }),
  );
  const revision = Option.getOrNull(AsyncResult.value(invalidation))?.revision ?? null;
  useEffect(() => {
    if (revision === null) return;
    refresh();
  }, [revision, refresh]);

  const view = Option.getOrNull(AsyncResult.value(result));
  return {
    // A failed read is an absent panel, not an error banner: the conversation
    // is the surface, and a market it cannot draw is not worth interrupting it.
    focus: view?.focus ?? null,
    isLoading: result.waiting,
  };
}
