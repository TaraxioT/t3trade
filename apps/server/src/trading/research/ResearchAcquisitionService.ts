import * as NodeCrypto from "node:crypto";
import { Clock, Context, Effect, Layer, Schema } from "effect";

import {
  ResearchAcquisitionRequest,
  ResearchError,
  type ResearchJobView,
} from "@t3tools/trading-contracts/researchData";

import { ResearchDatasetStore } from "./ResearchDatasetStore.ts";
import { ResearchAcquisitionWorker } from "./ResearchAcquisitionWorker.ts";

export interface ResearchAcquisitionServiceShape {
  readonly start: (
    request: ResearchAcquisitionRequest,
  ) => Effect.Effect<ResearchJobView, ResearchError>;
  readonly get: (jobId: string) => Effect.Effect<ResearchJobView, ResearchError>;
  readonly cancel: (jobId: string) => Effect.Effect<ResearchJobView, ResearchError>;
  readonly resume: (jobId: string) => Effect.Effect<ResearchJobView, ResearchError>;
}

export class ResearchAcquisitionService extends Context.Service<
  ResearchAcquisitionService,
  ResearchAcquisitionServiceShape
>()("t3/trading/research/ResearchAcquisitionService") {}

export interface ResearchAcquisitionCaps {
  readonly requests: number;
  readonly rows: number;
  readonly bytes: number;
}

export const DEFAULT_RESEARCH_ACQUISITION_CAPS: ResearchAcquisitionCaps = {
  requests: 5_000,
  rows: 500_000,
  bytes: 256 * 1024 * 1024,
};

function readCap(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  throw new ResearchError({ reason: "budget", detail: `${name} must be a positive integer` });
}

export function resolveResearchAcquisitionCaps(
  env: Record<string, string | undefined>,
): ResearchAcquisitionCaps {
  return {
    requests: readCap(
      env.T3_GRAPH_MAX_REQUESTS,
      DEFAULT_RESEARCH_ACQUISITION_CAPS.requests,
      "T3_GRAPH_MAX_REQUESTS",
    ),
    rows: readCap(
      env.T3_GRAPH_MAX_ROWS,
      DEFAULT_RESEARCH_ACQUISITION_CAPS.rows,
      "T3_GRAPH_MAX_ROWS",
    ),
    bytes: readCap(
      env.T3_GRAPH_MAX_STORAGE_BYTES,
      DEFAULT_RESEARCH_ACQUISITION_CAPS.bytes,
      "T3_GRAPH_MAX_STORAGE_BYTES",
    ),
  };
}

const encodeIdentity = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** Stable across process restarts and independent of caller object key order. */
export function researchDatasetIdentity(request: ResearchAcquisitionRequest): string {
  const source = request.source;
  const key = [
    request.environmentId,
    request.threadId,
    source.provider,
    source.chain,
    source.subgraphId,
    source.deployment,
    source.poolAddress.toLowerCase(),
    source.baseTokenAddress.toLowerCase(),
    source.quoteTokenAddress.toLowerCase(),
    source.feeTier,
    source.normalizationVersion,
    request.snapshotBlock.number,
    request.snapshotBlock.hash,
    request.entityKind,
    request.from,
    request.to,
  ];
  return NodeCrypto.createHash("sha256").update(encodeIdentity(key)).digest("hex");
}

export const makeResearchAcquisitionService = Effect.gen(function* () {
  const store = yield* ResearchDatasetStore;
  const worker = yield* ResearchAcquisitionWorker;
  const launch = (jobId: string) =>
    worker.run(jobId).pipe(
      Effect.catch((failure) =>
        Effect.logError("Research acquisition worker stopped", { reason: failure.reason }),
      ),
      Effect.forkDetach,
      Effect.asVoid,
    );
  yield* worker.drain().pipe(
    Effect.catch((failure) =>
      Effect.logError("Queued research acquisition could not resume", { reason: failure.reason }),
    ),
    Effect.forkDetach,
  );
  const start: ResearchAcquisitionServiceShape["start"] = (request) =>
    Effect.gen(function* () {
      if (
        !Schema.is(ResearchAcquisitionRequest)(request) ||
        !request.environmentId ||
        !request.threadId ||
        request.to <= request.from
      ) {
        return yield* new ResearchError({
          reason: "invalid_request",
          detail: "Research acquisition request is invalid",
        });
      }
      const now = yield* Clock.currentTimeMillis;
      const datasetId = researchDatasetIdentity(request);
      const jobId = `graph-${datasetId}`;
      const caps = yield* Effect.try({
        try: () => resolveResearchAcquisitionCaps(process.env),
        catch: (cause) =>
          Schema.is(ResearchError)(cause)
            ? cause
            : new ResearchError({
                reason: "budget",
                detail: "Graph acquisition budget is invalid",
              }),
      });
      const job = yield* store.create({ ...request, datasetId, jobId, caps, now });
      if (job.status === "queued") yield* launch(jobId);
      return job;
    });
  const get: ResearchAcquisitionServiceShape["get"] = (jobId) => store.getJob(jobId);
  const cancel: ResearchAcquisitionServiceShape["cancel"] = (jobId) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      return yield* store.cancel(jobId, now);
    });
  const resume: ResearchAcquisitionServiceShape["resume"] = (jobId) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const caps = yield* Effect.try({
        try: () => resolveResearchAcquisitionCaps(process.env),
        catch: (cause) =>
          Schema.is(ResearchError)(cause)
            ? cause
            : new ResearchError({
                reason: "budget",
                detail: "Graph acquisition budget is invalid",
              }),
      });
      const job = yield* store.resume(jobId, now, caps);
      yield* launch(jobId);
      return job;
    });
  return { start, get, cancel, resume } satisfies ResearchAcquisitionServiceShape;
});

export const ResearchAcquisitionServiceLive: Layer.Layer<
  ResearchAcquisitionService,
  never,
  ResearchDatasetStore | ResearchAcquisitionWorker
> = Layer.effect(ResearchAcquisitionService, makeResearchAcquisitionService);
