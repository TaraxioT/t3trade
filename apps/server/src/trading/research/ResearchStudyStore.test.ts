import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeCrypto from "node:crypto";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  EventResearchReport,
  calculateEventResearch,
  type EventResearchRecipe,
} from "@t3tools/trading-contracts/eventResearch";
import { runMigrations } from "../../persistence/Migrations.ts";
import { ResearchStudyStore, ResearchStudyStoreLive } from "./ResearchStudyStore.ts";

const source = {
  provider: "the_graph",
  chain: "ethereum",
  subgraphId: "subgraph",
  deployment: "QmDeployment",
  poolAddress: "0xpool",
  baseTokenAddress: "0xbase",
  quoteTokenAddress: "0xquote",
  feeTier: "3000",
  normalizationVersion: 1,
} as const;
const recipe: EventResearchRecipe = {
  environmentId: "environment",
  threadId: "thread",
  eventInventory: {
    id: "inventory",
    category: "scheduled",
    from: "2026-01-01",
    to: "2026-02-01",
    asOf: 1,
    retrievedAt: 1,
    status: "complete",
    affectedPeriods: [],
    occurrences: [],
  },
  source,
  snapshotBlock: { number: 1, hash: "0xhash" },
  from: "2026-01-01",
  to: "2026-02-01",
  horizonsMs: [3_600_000],
  referencePriceRule: { beforeMaxAgeMs: 300_000, afterMaxDelayMs: 300_000 },
  cutoffAt: 1,
};
const view = {
  jobId: "job",
  datasetId: "dataset",
  environmentId: "environment",
  threadId: "thread",
  source,
  snapshotBlock: recipe.snapshotBlock,
  entityKind: "hour" as const,
  from: 1,
  to: 2,
  status: "queued" as const,
  rowCount: 0,
  requestCount: 0,
  storedBytes: 0,
  cursor: null,
  updatedAt: 1,
};
const study = {
  studyId: "study",
  environmentId: "environment",
  threadId: "thread",
  recipe,
  report: calculateEventResearch({ recipe, priceSamples: [] }),
  reportHash: NodeCrypto.createHash("sha256")
    .update(
      Schema.encodeSync(Schema.fromJsonString(EventResearchReport))(
        calculateEventResearch({ recipe, priceSamples: [] }),
      ),
    )
    .digest("hex"),
  datasetIds: [],
  priceSamples: [],
  createdAt: 2,
};

const layer = it.layer(
  ResearchStudyStoreLive.pipe(Layer.provideMerge(NodeSqliteClient.layerMemory())),
);
const reset = Effect.gen(function* () {
  yield* runMigrations({});
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM graph_research_result_datasets`;
  yield* sql`DELETE FROM graph_research_result_job_datasets`;
  yield* sql`DELETE FROM graph_research_results`;
  yield* sql`DELETE FROM graph_research_result_jobs`;
});

layer("ResearchStudyStore", (it) => {
  it.effect("saves a typed study under job ownership and rereads it unchanged", () =>
    Effect.gen(function* () {
      yield* reset;
      const store = yield* ResearchStudyStore;
      yield* store.createJob({ jobId: "job", studyId: "study", recipe, view });
      const claimed = yield* store.claimJob("job", "owner", 2, 1_000);
      assert.equal(claimed?.status, "running");
      const completed = yield* store.completeStudy({
        jobId: "job",
        ownerToken: "owner",
        study,
        now: 3,
      });
      assert.equal(completed.status, "complete");
      assert.equal(completed.studyId, "study");
      const reread = yield* store.readStudy("study");
      assert.deepEqual(reread, study);
      const again = yield* store.createJob({ jobId: "job", studyId: "study", recipe, view });
      assert.equal(again.status, "complete");
    }),
  );

  it.effect("refuses a conflicting result under an existing immutable study ID", () =>
    Effect.gen(function* () {
      yield* reset;
      const store = yield* ResearchStudyStore;
      yield* store.createJob({ jobId: "job", studyId: "study", recipe, view });
      yield* store.claimJob("job", "owner", 2, 1_000);
      yield* store.completeStudy({ jobId: "job", ownerToken: "owner", study, now: 3 });
      const conflict = yield* Effect.result(
        store.completeStudy({
          jobId: "job",
          ownerToken: "owner",
          study: { ...study, reportHash: "different" },
          now: 4,
        }),
      );
      assert.equal(conflict._tag, "Failure");
      if (conflict._tag === "Failure") assert.equal(conflict.failure.reason, "conflict");
    }),
  );

  it.effect("rejects a false report hash and corrupted saved payload", () =>
    Effect.gen(function* () {
      yield* reset;
      const store = yield* ResearchStudyStore;
      yield* store.createJob({ jobId: "job", studyId: "study", recipe, view });
      yield* store.claimJob("job", "owner", 2, 1_000);
      const falseHash = yield* Effect.result(
        store.completeStudy({
          jobId: "job",
          ownerToken: "owner",
          study: { ...study, reportHash: "false" },
          now: 3,
        }),
      );
      assert.equal(falseHash._tag, "Failure");
      const forgedReport = { ...study.report, cutoffAt: 2 };
      const forgedJson = yield* Schema.encodeEffect(Schema.fromJsonString(EventResearchReport))(
        forgedReport,
      );
      const forgedHash = NodeCrypto.createHash("sha256").update(forgedJson).digest("hex");
      const forged = yield* Effect.result(
        store.completeStudy({
          jobId: "job",
          ownerToken: "owner",
          study: { ...study, report: forgedReport, reportHash: forgedHash },
          now: 3,
        }),
      );
      assert.equal(forged._tag, "Failure");
      yield* store.completeStudy({ jobId: "job", ownerToken: "owner", study, now: 3 });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE graph_research_results SET report_hash = 'tampered' WHERE result_id = 'study'`;
      const corrupted = yield* Effect.result(store.readStudy("study"));
      assert.equal(corrupted._tag, "Failure");
      if (corrupted._tag === "Failure") assert.equal(corrupted.failure.reason, "storage");
    }),
  );
});
