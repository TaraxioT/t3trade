import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer } from "effect";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { GraphDataError, type GraphWindowPage } from "@t3tools/trading-contracts/researchData";
import { runMigrations } from "../../persistence/Migrations.ts";
import { GraphHistoricalData, type GraphHistoricalDataShape } from "./GraphHistoricalData.ts";
import { ResearchDatasetStore, ResearchDatasetStoreLive } from "./ResearchDatasetStore.ts";
import { makeResearchAcquisitionWorker } from "./ResearchAcquisitionWorker.ts";

const source = {
  provider: "the_graph" as const,
  chain: "ethereum" as const,
  subgraphId: "subgraph",
  deployment: "QmDeployment",
  poolAddress: "0xpool",
  baseTokenAddress: "0xbase",
  quoteTokenAddress: "0xquote",
  feeTier: "3000",
  normalizationVersion: 1 as const,
};
const snapshotBlock = { number: 100, hash: "0xhash" };
const base = {
  datasetId: "dataset",
  jobId: "job",
  environmentId: "env",
  threadId: "thread",
  source,
  snapshotBlock,
  entityKind: "swaps" as const,
  from: 1_000,
  to: 100_000,
  caps: { requests: 10, rows: 10_000, bytes: 1_000_000 },
  now: 1,
};
const sample = {
  id: "sample",
  at: 2_000,
  price: 100,
  blockNumber: 100,
  transactionId: "tx",
  logIndex: 1,
};
const page: GraphWindowPage = {
  entityKind: "swaps",
  rows: [sample],
  nextCursor: null,
  progress: { rowsReturned: 1, hasMore: false, snapshotBlock },
};
const layer = it.layer(
  ResearchDatasetStoreLive.pipe(Layer.provideMerge(NodeSqliteClient.layerMemory())),
);

const reset = Effect.gen(function* () {
  yield* runMigrations({});
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM graph_research_jobs`;
  yield* sql`DELETE FROM graph_research_datasets`;
});

function workerWith(readWindow: GraphHistoricalDataShape["readWindow"]) {
  return Effect.gen(function* () {
    const store = yield* ResearchDatasetStore;
    return yield* makeResearchAcquisitionWorker.pipe(
      Effect.provideService(ResearchDatasetStore, store),
      Effect.provideService(
        GraphHistoricalData,
        GraphHistoricalData.of({ inspectSource: () => Effect.die("unused"), readWindow }),
      ),
    );
  });
}

layer("ResearchAcquisitionWorker", (it) => {
  it.effect("completes a queued job and retains a page for offline reads", () =>
    Effect.gen(function* () {
      yield* reset;
      const store = yield* ResearchDatasetStore;
      yield* store.create(base);
      const worker = yield* workerWith(() => Effect.succeed(page));
      const done = yield* worker.run(base.jobId);
      assert.equal(done.status, "complete");
      assert.equal(done.requestCount, 1);
      const window = yield* store.readWindow({
        datasetId: base.datasetId,
        from: base.from,
        to: base.to,
        resolution: "swaps",
      });
      assert.equal(window.rows[0]?.id, "sample");
    }),
  );

  it.effect("fails specifically on indexing errors without completing a manifest", () =>
    Effect.gen(function* () {
      yield* reset;
      const store = yield* ResearchDatasetStore;
      yield* store.create(base);
      const worker = yield* workerWith(() =>
        Effect.fail(
          new GraphDataError({ reason: "indexing", detail: "Subgraph reported an indexing error" }),
        ),
      );
      const failed = yield* worker.run(base.jobId);
      assert.equal(failed.status, "failed");
      assert.equal(failed.requestCount, 1);
      const window = yield* store.readWindow({
        datasetId: base.datasetId,
        from: base.from,
        to: base.to,
        resolution: "swaps",
      });
      assert.equal(window.manifest.status, "incomplete");
    }),
  );

  it.effect("restarts from a persisted cursor after the first page", () =>
    Effect.gen(function* () {
      yield* reset;
      const store = yield* ResearchDatasetStore;
      yield* store.create(base);
      yield* store.claim(base.jobId, "old-owner", 2, 1);
      yield* store.appendPage({
        jobId: base.jobId,
        ownerToken: "old-owner",
        page: {
          entityKind: "swaps",
          rows: [sample],
          nextCursor: "sample",
          progress: { rowsReturned: 1, hasMore: true, snapshotBlock },
        },
        now: 3,
      });
      yield* TestClock.setTime(40_000);
      const worker = yield* workerWith((request) => {
        assert.equal(request.cursor, "sample");
        return Effect.succeed({ ...page, rows: [{ ...sample, id: "sample-2", at: 3_000 }] });
      });
      const done = yield* worker.run(base.jobId);
      assert.equal(done.status, "complete");
      assert.equal(done.rowCount, 2);
      assert.equal(done.requestCount, 2);
    }),
  );

  it.effect("counts a transient failed request against the durable budget before retrying", () =>
    Effect.gen(function* () {
      yield* reset;
      const store = yield* ResearchDatasetStore;
      yield* store.create(base);
      let calls = 0;
      const worker = yield* workerWith(() => {
        calls++;
        return calls === 1
          ? Effect.fail(
              new GraphDataError({
                reason: "rate_limit",
                detail: "Graph gateway rate limit reached",
                retryAfterMs: 0,
              }),
            )
          : Effect.succeed(page);
      });
      const done = yield* worker.run(base.jobId);
      assert.equal(done.status, "complete");
      assert.equal(done.requestCount, 2);
      assert.equal(calls, 2);
    }),
  );

  it.effect("honors cancellation after a pending read resolves, without publishing rows", () =>
    Effect.gen(function* () {
      yield* reset;
      const store = yield* ResearchDatasetStore;
      yield* store.create(base);
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<GraphWindowPage>();
      const worker = yield* workerWith(() =>
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
      );
      const running = yield* worker.run(base.jobId).pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* store.cancel(base.jobId, 2);
      yield* Deferred.succeed(release, page);
      const cancelled = yield* Fiber.join(running);
      assert.equal(cancelled.status, "cancelled");
      assert.equal(cancelled.rowCount, 0);
    }),
  );
});
