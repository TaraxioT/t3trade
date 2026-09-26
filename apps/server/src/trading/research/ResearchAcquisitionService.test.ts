import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../../persistence/Migrations.ts";
import { ResearchDatasetStoreLive } from "./ResearchDatasetStore.ts";
import { ResearchDatasetStore } from "./ResearchDatasetStore.ts";
import {
  ResearchAcquisitionService,
  ResearchAcquisitionServiceLive,
  resolveResearchAcquisitionCaps,
} from "./ResearchAcquisitionService.ts";
import { ResearchAcquisitionWorker } from "./ResearchAcquisitionWorker.ts";

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
const request = {
  environmentId: "env",
  threadId: "thread",
  source,
  snapshotBlock: { number: 100, hash: "0xhash" },
  entityKind: "hour" as const,
  from: 1_000,
  to: 100_000,
};

const idleWorker = Layer.effect(
  ResearchAcquisitionWorker,
  Effect.gen(function* () {
    const store = yield* ResearchDatasetStore;
    return { run: (jobId: string) => store.getJob(jobId), drain: () => Effect.succeed([]) };
  }),
);

const layer = it.layer(
  ResearchAcquisitionServiceLive.pipe(
    Layer.provideMerge(idleWorker),
    Layer.provideMerge(ResearchDatasetStoreLive),
    Layer.provideMerge(NodeSqliteClient.layerMemory()),
  ),
);

layer("ResearchAcquisitionService", (it) => {
  it("refuses an invalid configured cap instead of silently using a larger default", () => {
    assert.throws(() => resolveResearchAcquisitionCaps({ T3_GRAPH_MAX_REQUESTS: "0" }));
  });
  it.effect(
    "coalesces identical requests and scopes dataset identity by environment and snapshot",
    () =>
      Effect.gen(function* () {
        yield* runMigrations({});
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DELETE FROM graph_research_jobs`;
        yield* sql`DELETE FROM graph_research_datasets`;
        const service = yield* ResearchAcquisitionService;
        const first = yield* service.start(request);
        const same = yield* service.start(request);
        const otherEnvironment = yield* service.start({ ...request, environmentId: "other-env" });
        const otherSnapshot = yield* service.start({
          ...request,
          snapshotBlock: { number: 101, hash: "0xother" },
        });
        assert.equal(first.jobId, same.jobId);
        assert.equal(first.datasetId, same.datasetId);
        assert.notEqual(first.datasetId, otherEnvironment.datasetId);
        assert.notEqual(first.datasetId, otherSnapshot.datasetId);
        assert.equal((yield* service.get(first.jobId)).status, "queued");
      }),
  );

  it.effect("cancels and resumes the same durable job without losing its identity", () =>
    Effect.gen(function* () {
      yield* runMigrations({});
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM graph_research_jobs`;
      yield* sql`DELETE FROM graph_research_datasets`;
      const service = yield* ResearchAcquisitionService;
      const started = yield* service.start(request);
      const cancelled = yield* service.cancel(started.jobId);
      assert.equal(cancelled.status, "cancelled");
      const resumed = yield* service.resume(started.jobId);
      assert.equal(resumed.status, "queued");
      assert.equal(resumed.datasetId, started.datasetId);
    }),
  );
});
