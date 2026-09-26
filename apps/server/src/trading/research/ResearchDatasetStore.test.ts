import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../../persistence/Migrations.ts";
import { ResearchDatasetStore, ResearchDatasetStoreLive } from "./ResearchDatasetStore.ts";

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
  datasetId: "dataset-1",
  jobId: "job-1",
  environmentId: "environment-1",
  threadId: "thread-1",
  source,
  snapshotBlock,
  entityKind: "swaps" as const,
  from: 1_000,
  to: 10_000_000,
  caps: { requests: 10, rows: 6_000, bytes: 10_000_000 },
  now: 1,
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

layer("ResearchDatasetStore", (it) => {
  it.effect(
    "retains more than 5,000 swaps once, including tied timestamps, and reads offline",
    () =>
      Effect.gen(function* () {
        yield* reset;
        const store = yield* ResearchDatasetStore;
        const started = yield* store.create(base);
        assert.equal(started.status, "queued");
        const owner = "worker-1";
        const claimed = yield* store.claim(base.jobId, owner, 2, 10_000);
        assert.notEqual(claimed, null);
        for (let pageIndex = 0; pageIndex < 6; pageIndex++) {
          const first = pageIndex * 1_000;
          const rows = Array.from({ length: pageIndex === 5 ? 1 : 1_000 }, (_, offset) => {
            const index = first + offset;
            return {
              id: `swap-${String(index).padStart(5, "0")}`,
              at: 2_000 + Math.floor(index / 2) * 1_000,
              price: 1_000 + index,
              blockNumber: 100,
              transactionId: `tx-${index}`,
              logIndex: index,
            };
          });
          const nextCursor = pageIndex === 5 ? null : (rows[rows.length - 1]?.id ?? null);
          const page = {
            entityKind: "swaps" as const,
            rows,
            nextCursor,
            progress: { rowsReturned: rows.length, hasMore: nextCursor !== null, snapshotBlock },
          };
          yield* store.appendPage({
            jobId: base.jobId,
            ownerToken: owner,
            page,
            now: pageIndex + 3,
          });
          if (pageIndex === 0) {
            yield* store.appendPage({ jobId: base.jobId, ownerToken: owner, page, now: 4 });
          }
        }
        const done = yield* store.getJob(base.jobId);
        assert.equal(done.status, "complete");
        assert.equal(done.rowCount, 5_001);
        const window = yield* store.readWindow({
          datasetId: base.datasetId,
          from: 1_000,
          to: 10_000_000,
          resolution: "swaps",
          limit: 1_000,
        });
        assert.equal(window.rows.length, 1_000);
        assert.notEqual(window.nextCursor, null);
        const second = yield* store.readWindow({
          datasetId: base.datasetId,
          from: 1_000,
          to: 10_000_000,
          resolution: "swaps",
          limit: 1_000,
          ...(window.nextCursor === null ? {} : { cursor: window.nextCursor }),
        });
        assert.equal(second.rows[0]?.id, "swap-01000");
        assert.equal(window.manifest.status, "complete");
      }),
  );

  it.effect("persists cursor and consumed budgets before a new owner resumes", () =>
    Effect.gen(function* () {
      yield* reset;
      const store = yield* ResearchDatasetStore;
      yield* store.create({ ...base, caps: { requests: 1, rows: 10, bytes: 10_000 } });
      yield* store.claim(base.jobId, "old-owner", 2, 1);
      const row = {
        id: "first",
        at: 2_000,
        price: 100,
        blockNumber: 100,
        transactionId: "tx",
        logIndex: 1,
      };
      yield* store.appendPage({
        jobId: base.jobId,
        ownerToken: "old-owner",
        page: {
          entityKind: "swaps",
          rows: [row],
          nextCursor: "first",
          progress: { rowsReturned: 1, hasMore: true, snapshotBlock },
        },
        now: 3,
      });
      const paused = yield* store.getJob(base.jobId);
      assert.equal(paused.status, "paused");
      assert.equal(paused.requestCount, 1);
      assert.equal(paused.cursor, "first");
    }),
  );

  it.effect("rejects a changed snapshot while the job is running", () =>
    Effect.gen(function* () {
      yield* reset;
      const store = yield* ResearchDatasetStore;
      yield* store.create(base);
      yield* store.claim(base.jobId, "old-owner", 2, 10_000);
      const row = {
        id: "first",
        at: 2_000,
        price: 100,
        blockNumber: 100,
        transactionId: "tx",
        logIndex: 1,
      };
      yield* store.appendPage({
        jobId: base.jobId,
        ownerToken: "old-owner",
        page: {
          entityKind: "swaps",
          rows: [row],
          nextCursor: "first",
          progress: { rowsReturned: 1, hasMore: true, snapshotBlock },
        },
        now: 3,
      });
      const wrongSnapshot = yield* Effect.result(
        store.appendPage({
          jobId: base.jobId,
          ownerToken: "old-owner",
          page: {
            entityKind: "swaps",
            rows: [row],
            nextCursor: null,
            progress: {
              rowsReturned: 1,
              hasMore: false,
              snapshotBlock: { number: 101, hash: "0xother" },
            },
          },
          now: 4,
        }),
      );
      assert.equal(wrongSnapshot._tag, "Failure");
    }),
  );

  it.effect("refuses a conflicting replay of an already persisted page", () =>
    Effect.gen(function* () {
      yield* reset;
      const store = yield* ResearchDatasetStore;
      yield* store.create(base);
      yield* store.claim(base.jobId, "owner", 2, 10_000);
      const row = {
        id: "same",
        at: 2_000,
        price: 100,
        blockNumber: 100,
        transactionId: "tx",
        logIndex: 1,
      };
      const firstPage = {
        entityKind: "swaps" as const,
        rows: [row],
        nextCursor: "same",
        progress: { rowsReturned: 1, hasMore: true, snapshotBlock },
      };
      yield* store.appendPage({ jobId: base.jobId, ownerToken: "owner", page: firstPage, now: 3 });
      const replay = yield* Effect.result(
        store.appendPage({
          jobId: base.jobId,
          ownerToken: "owner",
          page: { ...firstPage, rows: [{ ...row, price: 200 }] },
          now: 4,
        }),
      );
      assert.equal(replay._tag, "Failure");
      const window = yield* store.readWindow({
        datasetId: base.datasetId,
        from: base.from,
        to: base.to,
        resolution: "swaps",
      });
      assert.equal(window.rows.length, 1);
      assert.equal("price" in window.rows[0]! ? window.rows[0].price : null, 100);
    }),
  );
});
