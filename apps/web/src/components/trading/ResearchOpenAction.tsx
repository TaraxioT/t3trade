import type { EnvironmentId, OpenResearchSceneAction, ThreadId } from "@t3tools/contracts";
import { OpenResearchSceneAction as OpenResearchSceneActionSchema } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useState } from "react";

import { refreshTradingResearchScenes } from "../../lib/tradingResearchScenesState";
import { refreshTradingThreadMarket } from "../../lib/tradingThreadMarketState";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useAtomCommand } from "../../state/use-atom-command";
import { threadMarketScopeKey, useThreadMarketCardStore } from "./threadMarketCardState";
import { useThreadMarketPanelStore } from "./threadMarketPanelStore";

export function matchingResearchAction(
  value: unknown,
  environmentId: string,
  threadId: string,
  resultId: string,
): value is OpenResearchSceneAction {
  if (!Schema.is(OpenResearchSceneActionSchema)(value)) return false;
  return (
    value.environmentId === environmentId &&
    value.threadId === threadId &&
    value.datasetIds.length > 0 &&
    value.source.chain === "ethereum" &&
    (value.resultKind === "event_study"
      ? value.studyId === resultId
      : value.simulationId === resultId)
  );
}

export function sameResearchActionIdentity(
  a: OpenResearchSceneAction,
  b: OpenResearchSceneAction,
): boolean {
  return (
    a.environmentId === b.environmentId &&
    a.threadId === b.threadId &&
    a.sceneId === b.sceneId &&
    a.market === b.market &&
    a.resultKind === b.resultKind &&
    a.studyId === b.studyId &&
    a.simulationId === b.simulationId &&
    a.source.provider === b.source.provider &&
    a.source.chain === b.source.chain &&
    a.source.subgraphId === b.source.subgraphId &&
    a.source.deployment === b.source.deployment &&
    a.source.poolAddress === b.source.poolAddress &&
    a.source.baseTokenAddress === b.source.baseTokenAddress &&
    a.source.quoteTokenAddress === b.source.quoteTokenAddress &&
    a.source.feeTier === b.source.feeTier &&
    a.source.normalizationVersion === b.source.normalizationVersion &&
    a.datasetIds.length === b.datasetIds.length &&
    a.datasetIds.every((id, index) => b.datasetIds[index] === id)
  );
}

/** User initiated navigation; a completed background job never replaces a live chart on its own. */
export function ResearchOpenAction(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly threadKey: string;
  readonly resultId: string;
  readonly resultKind: "event_study" | "long_simulation";
  readonly action?: unknown;
}) {
  const publish = useAtomCommand(orchestrationEnvironment.publishSavedResearch);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const apply = (action: OpenResearchSceneAction) => {
    const scope = threadMarketScopeKey(props.environmentId, props.threadId, action.market);
    useThreadMarketPanelStore.getState().setCardCollapsed(props.threadKey, false);
    const card = useThreadMarketCardStore.getState();
    card.openResearchScene(
      scope,
      action.sceneId,
      action.view === "event_aligned" ? "aligned" : "calendar",
    );
    refreshTradingThreadMarket(props.environmentId, props.threadId);
    refreshTradingResearchScenes(props.environmentId, props.threadId);
    requestAnimationFrame(() => {
      const target = document.querySelector<HTMLElement>('[data-testid="thread-market-card"]');
      target?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      target?.focus({ preventScroll: true });
    });
  };
  const open = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (props.action !== undefined) {
        if (
          !matchingResearchAction(props.action, props.environmentId, props.threadId, props.resultId)
        ) {
          setError("This chart action belongs to another result or environment.");
          return;
        }
      }
      const result = await publish({
        environmentId: props.environmentId,
        input: {
          threadId: props.threadId,
          ...(props.resultKind === "event_study"
            ? { studyId: props.resultId }
            : { simulationId: props.resultId }),
        },
      });
      if (
        result._tag !== "Success" ||
        !matchingResearchAction(
          result.value.openResearch,
          props.environmentId,
          props.threadId,
          props.resultId,
        ) ||
        (props.action !== undefined &&
          !sameResearchActionIdentity(props.action, result.value.openResearch))
      ) {
        setError("Could not open the saved result in this thread.");
        return;
      }
      apply(result.value.openResearch);
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        disabled={busy}
        onClick={() => void open()}
        className="rounded border px-2 py-1 text-xs font-medium hover:bg-accent"
        data-testid="research-open-action"
      >
        {busy ? "Opening…" : "Open on graph"}
      </button>
      {error === null ? null : (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      )}
    </span>
  );
}
