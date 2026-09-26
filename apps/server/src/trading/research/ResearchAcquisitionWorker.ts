import * as NodeCrypto from "node:crypto";
import { Clock, Context, Effect, Layer, Semaphore } from "effect";

import type {
  GraphDataError,
  ResearchError,
  ResearchJobView,
} from "@t3tools/trading-contracts/researchData";

import { GraphHistoricalData } from "./GraphHistoricalData.ts";
import { ResearchDatasetStore } from "./ResearchDatasetStore.ts";

export interface ResearchAcquisitionWorkerShape {
  readonly run: (jobId: string) => Effect.Effect<ResearchJobView, ResearchError>;
  readonly drain: () => Effect.Effect<ReadonlyArray<ResearchJobView>, ResearchError>;
}

export class ResearchAcquisitionWorker extends Context.Service<
  ResearchAcquisitionWorker,
  ResearchAcquisitionWorkerShape
>()("t3/trading/research/ResearchAcquisitionWorker") {}

const MAX_TRANSIENT_RETRIES = 3;
const LEASE_MS = 30_000;

function transient(error: GraphDataError): boolean {
  return error.reason === "rate_limit" || error.reason === "upstream_failure";
}

export const makeResearchAcquisitionWorker = Effect.gen(function* () {
  const store = yield* ResearchDatasetStore;
  const graph = yield* GraphHistoricalData;
  const upstream = yield* Semaphore.make(2);

  const run: ResearchAcquisitionWorkerShape["run"] = (jobId) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const ownerToken = NodeCrypto.randomUUID();
      const claimed = yield* store.claim(jobId, ownerToken, now, LEASE_MS);
      if (claimed === null) return yield* store.getJob(jobId);
      let job: ResearchJobView = claimed;
      let transientFailures = 0;

      while (job.status === "running") {
        const pageResult = yield* Effect.result(
          upstream.withPermits(1)(
            graph.readWindow({
              source: job.source,
              poolAddress: job.source.poolAddress,
              snapshotBlock: job.snapshotBlock,
              from: job.from,
              to: job.to,
              entityKind: job.entityKind,
              pageSize: 1_000,
              ...(job.cursor === null ? {} : { cursor: job.cursor }),
            }),
          ),
        );

        if (pageResult._tag === "Failure") {
          const graphError = pageResult.failure;
          const retryable = transient(graphError) && transientFailures < MAX_TRANSIENT_RETRIES;
          const at = yield* Clock.currentTimeMillis;
          const recorded = yield* Effect.result(
            store.recordFailure({
              jobId,
              ownerToken,
              now: at,
              reason: graphError.reason,
              terminal: !retryable,
            }),
          );
          if (recorded._tag === "Failure") return yield* store.getJob(jobId);
          job = recorded.success;
          if (!retryable || job.status !== "running") return job;
          const delay = Math.min(graphError.retryAfterMs ?? 100 * 2 ** transientFailures, 2_000);
          transientFailures++;
          if (delay > 0) yield* Effect.sleep(`${delay} millis`);
          continue;
        }

        const page = pageResult.success;
        if (page.nextCursor !== null && page.nextCursor === job.cursor) {
          const at = yield* Clock.currentTimeMillis;
          return yield* store.recordFailure({
            jobId,
            ownerToken,
            now: at,
            reason: "cursor_did_not_advance",
            terminal: true,
          });
        }
        const at = yield* Clock.currentTimeMillis;
        const persisted = yield* Effect.result(
          store.appendPage({ jobId, ownerToken, page, now: at }),
        );
        if (persisted._tag === "Failure") return yield* store.getJob(jobId);
        job = persisted.success;
        transientFailures = 0;
      }
      return job;
    });

  const drain: ResearchAcquisitionWorkerShape["drain"] = () =>
    Effect.gen(function* () {
      const completed: ResearchJobView[] = [];
      while (true) {
        const now = yield* Clock.currentTimeMillis;
        const jobs = yield* store.listRunnable(now, 100);
        if (jobs.length === 0) return completed;
        const batch = yield* Effect.forEach(jobs, run, { concurrency: 2 });
        completed.push(...batch);
        if (jobs.length < 100) return completed;
      }
    });

  return { run, drain } satisfies ResearchAcquisitionWorkerShape;
});

export const ResearchAcquisitionWorkerLive: Layer.Layer<
  ResearchAcquisitionWorker,
  never,
  ResearchDatasetStore | GraphHistoricalData
> = Layer.effect(ResearchAcquisitionWorker, makeResearchAcquisitionWorker);
