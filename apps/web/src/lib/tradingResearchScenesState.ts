import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ResearchSceneView, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { orchestrationEnvironment } from "../state/orchestration";
import { activeGraphScenes } from "../components/trading/researchScenePresentation.ts";

/**
 * One thread's published research scenes.
 *
 * Scenes are thread-scoped on the server and this hook is thread-scoped here:
 * research published in another conversation never decorates this graph. The
 * read is research mode all the way down, no signer and no entitlement beyond
 * the environment the caller is connected to.
 */
function tradingResearchScenesAtom(environmentId: EnvironmentId, threadId: ThreadId) {
  return orchestrationEnvironment.tradingResearchScenes({ environmentId, input: { threadId } });
}

type TradingResearchScenesAtom = ReturnType<typeof tradingResearchScenesAtom>;

const DISABLED_SCENES_ATOM: TradingResearchScenesAtom = Atom.make(
  AsyncResult.initial<{ readonly scenes: ReadonlyArray<ResearchSceneView> }>(),
);

/** Scenes change exactly when the conversation publishes one: a short poll. */
const SCENES_POLL_INTERVAL_MS = 15_000;

export interface TradingResearchScenesState {
  readonly scenes: ReadonlyArray<ResearchSceneView> | null;
  readonly error: string | null;
  readonly isLoading: boolean;
  readonly refresh: () => void;
}

export function useTradingResearchScenes(
  environmentId: EnvironmentId,
  threadId: ThreadId | null,
  options: { readonly enabled: boolean },
): TradingResearchScenesState {
  const atom = useMemo(
    () =>
      threadId !== null && options.enabled
        ? tradingResearchScenesAtom(environmentId, threadId)
        : DISABLED_SCENES_ATOM,
    [environmentId, threadId, options.enabled],
  );
  const result = useAtomValue(atom);
  // A failed read (or a failed publish upstream) must not blank the graph:
  // the prior scenes stay until a good read replaces them, flagged through
  // the error the hook already reports.
  const lastGoodRef = useRef<ReadonlyArray<ResearchSceneView> | null>(null);
  const lastAtomRef = useRef<TradingResearchScenesAtom | null>(null);
  if (lastAtomRef.current !== atom) {
    lastAtomRef.current = atom;
    lastGoodRef.current = null;
  }
  const refresh = useCallback(() => {
    if (threadId !== null && options.enabled) {
      appAtomRegistry.refresh(tradingResearchScenesAtom(environmentId, threadId));
    }
  }, [environmentId, threadId, options.enabled]);

  useEffect(() => {
    if (threadId === null || !options.enabled) return;
    const timer = window.setInterval(refresh, SCENES_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [threadId, options.enabled, refresh]);

  const value = Option.getOrNull(AsyncResult.value(result));
  if (value !== null) lastGoodRef.current = activeGraphScenes(value.scenes);
  const effective = value === null ? lastGoodRef.current : activeGraphScenes(value.scenes);
  return {
    scenes: effective === null ? null : effective,
    error: AsyncResult.isFailure(result) ? String(result.cause) : null,
    // Loading is the result's own `waiting` flag: true while the first read
    // is in flight and during refreshes, without blanking a good value.
    isLoading: AsyncResult.isWaiting(result),
    refresh,
  };
}
