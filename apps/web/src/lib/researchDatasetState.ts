import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, GetSavedResearchResult, ThreadId } from "@t3tools/contracts";
import type {
  ResearchCandle,
  ResearchDatasetWindow,
  ResearchPriceSample,
} from "@t3tools/trading-contracts/researchData";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useMemo, useRef } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { orchestrationEnvironment } from "../state/orchestration";

export interface ResearchWindowSelection {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly datasetId: string;
  readonly from: number;
  readonly to: number;
  readonly resolution: "1h" | "1d";
  readonly studyId?: string;
  readonly simulationId?: string;
}

export function researchWindowIdentity(selection: ResearchWindowSelection): string {
  return JSON.stringify(selection);
}

export function researchCandles(
  rows: ReadonlyArray<ResearchCandle | ResearchPriceSample>,
  resolution: "1h" | "1d",
) {
  return rows
    .filter((row): row is ResearchCandle => "resolution" in row && row.resolution === resolution)
    .map((row) => ({
      openTime: row.from,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: 0,
      trades: 0,
    }));
}

/** A retained read is bound to the saved result, source manifest, and active environment. */
export function useResearchDatasetWindow(selection: ResearchWindowSelection): {
  readonly data: ResearchDatasetWindow | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly stale: boolean;
  readonly refresh: () => void;
} {
  const identity = researchWindowIdentity(selection);
  const atom = useMemo(
    () =>
      orchestrationEnvironment.researchDatasetWindow({
        environmentId: selection.environmentId,
        input: {
          threadId: selection.threadId,
          datasetId: selection.datasetId,
          from: selection.from,
          to: selection.to,
          resolution: selection.resolution,
          ...(selection.studyId !== undefined
            ? { studyId: selection.studyId }
            : { simulationId: selection.simulationId! }),
        },
      }),
    [identity],
  );
  const result = useAtomValue(atom);
  const lastGood = useRef<ResearchDatasetWindow | null>(null);
  const lastIdentity = useRef<string | null>(null);
  if (lastIdentity.current !== identity) {
    lastIdentity.current = identity;
    lastGood.current = null;
  }
  const value = Option.getOrNull(AsyncResult.value(result));
  if (value !== null) lastGood.current = value;
  return {
    data: value ?? lastGood.current,
    loading: AsyncResult.isWaiting(result),
    error: AsyncResult.isFailure(result) ? String(result.cause) : null,
    stale: value === null && lastGood.current !== null,
    refresh: () => appAtomRegistry.refresh(atom),
  };
}

export function useSavedResearch(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  identity: { readonly studyId: string } | { readonly simulationId: string },
): {
  readonly data: GetSavedResearchResult | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly refresh: () => void;
} {
  const key = JSON.stringify([environmentId, threadId, identity]);
  const atom = useMemo(
    () =>
      orchestrationEnvironment.savedResearch({
        environmentId,
        input: { threadId, ...identity },
      }),
    [key],
  );
  const result = useAtomValue(atom);
  const lastGood = useRef<GetSavedResearchResult | null>(null);
  const lastKey = useRef<string | null>(null);
  if (lastKey.current !== key) {
    lastKey.current = key;
    lastGood.current = null;
  }
  const value = Option.getOrNull(AsyncResult.value(result));
  if (value !== null) lastGood.current = value;
  return {
    data: value ?? lastGood.current,
    loading: AsyncResult.isWaiting(result),
    error: AsyncResult.isFailure(result) ? String(result.cause) : null,
    refresh: () => appAtomRegistry.refresh(atom),
  };
}
