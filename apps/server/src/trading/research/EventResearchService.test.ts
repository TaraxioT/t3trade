import { assert, it } from "@effect/vitest";
import { Context, Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import type {
  GraphSourceCapabilities,
  ResearchCandle,
  ResearchPriceSample,
} from "@t3tools/trading-contracts/researchData";
import type { EventResearchRecipe } from "@t3tools/trading-contracts/eventResearch";

import { runMigrations } from "../../persistence/Migrations.ts";
import { GraphHistoricalData, type GraphHistoricalDataShape } from "./GraphHistoricalData.ts";
import { ResearchDatasetStoreLive } from "./ResearchDatasetStore.ts";
import { ResearchAcquisitionWorkerLive } from "./ResearchAcquisitionWorker.ts";
import { ResearchStudyStore, ResearchStudyStoreLive } from "./ResearchStudyStore.ts";
import { EventResearchService, EventResearchServiceLive } from "./EventResearchService.ts";

const eventAt = Date.parse("2026-01-28T19:00:00Z");
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
const event = {
  id: "fomc:scheduled:2026-01-28",
  meetingFrom: "2026-01-27",
  meetingTo: "2026-01-28",
  classification: "scheduled",
  statementAt: eventAt,
  missingTimeReason: null,
  sourceUrl: "https://www.federalreserve.gov/statement",
  sourceHash: "statement-hash",
  sourceExcerpt: "For release at 2:00 p.m. EST",
  calendarUrl: "https://www.federalreserve.gov/calendar",
  calendarHash: "calendar-hash",
  retrievedAt: eventAt + 1,
  timezoneInterpretation: "America/New_York (EST, UTC-05:00)",
  minutesReleasedOn: "2026-02-18",
} as const;
const recipe: EventResearchRecipe = {
  environmentId: "env",
  threadId: "thread",
  eventInventory: {
    id: "inventory",
    category: "scheduled",
    from: "2026-01-01",
    to: "2026-02-01",
    asOf: eventAt + 8 * 86_400_000,
    retrievedAt: eventAt + 8 * 86_400_000,
    status: "complete",
    affectedPeriods: [],
    occurrences: [event],
  },
  source,
  snapshotBlock: { number: 1, hash: "0xhash" },
  from: "2026-01-01",
  to: "2026-02-01",
  horizonsMs: [3_600_000, 86_400_000, 7 * 86_400_000],
  referencePriceRule: { beforeMaxAgeMs: 300_000, afterMaxDelayMs: 300_000 },
  cutoffAt: eventAt + 8 * 86_400_000,
};
const sample = (id: string, at: number, price: number): ResearchPriceSample => ({
  id,
  at,
  price,
  blockNumber: 1,
  transactionId: `0x${id}`,
  logIndex: 1,
});
const samples = [
  sample("pre", eventAt - 60_000, 100),
  sample("entry", eventAt + 5 * 60_000, 100),
  sample("hour", eventAt + 3_600_000, 101),
  sample("hourlong", eventAt + 65 * 60_000, 102),
  sample("day", eventAt + 86_400_000, 98),
  sample("daylong", eventAt + 86_700_000, 99),
  sample("week", eventAt + 7 * 86_400_000, 110),
  sample("weeklong", eventAt + 7 * 86_400_000 + 300_000, 111),
];

function graphFixture(calls: { count: number }): GraphHistoricalDataShape {
  const capabilities: GraphSourceCapabilities = {
    source,
    snapshotBlock: recipe.snapshotBlock,
    indexedThrough: recipe.cutoffAt,
    token0: { address: "0xquote", decimals: 6 },
    token1: { address: "0xbase", decimals: 18 },
    coverage: {
      swaps: { firstAt: 0, lastAt: recipe.cutoffAt },
      hour: { firstAt: 0, lastAt: recipe.cutoffAt },
      day: { firstAt: 0, lastAt: recipe.cutoffAt },
    },
  };
  return {
    inspectSource: () => Effect.succeed(capabilities),
    readWindow: (request) => {
      calls.count++;
      const rows: ReadonlyArray<ResearchPriceSample | ResearchCandle> =
        request.entityKind === "swaps"
          ? samples.filter((row) => row.at >= request.from && row.at < request.to)
          : [
              {
                id: "hour",
                from: eventAt,
                to: eventAt + 3_600_000,
                resolution: "1h",
                open: 100,
                high: 101,
                low: 100,
                close: 101,
              },
            ];
      return Effect.succeed({
        entityKind: request.entityKind,
        rows,
        nextCursor: null,
        progress: {
          rowsReturned: rows.length,
          hasMore: false,
          snapshotBlock: recipe.snapshotBlock,
        },
      });
    },
  };
}

function testLayer(calls: { count: number }) {
  const database = NodeSqliteClient.layerMemory();
  const sourceLayer = Layer.succeed(GraphHistoricalData, graphFixture(calls));
  const storeLayer = Layer.mergeAll(ResearchDatasetStoreLive, ResearchStudyStoreLive).pipe(
    Layer.provideMerge(database),
  );
  const workerLayer = ResearchAcquisitionWorkerLive.pipe(
    Layer.provideMerge(storeLayer),
    Layer.provideMerge(sourceLayer),
  );
  return EventResearchServiceLive({ autoStart: false }).pipe(
    Layer.provideMerge(workerLayer),
    Layer.provideMerge(storeLayer),
    Layer.provideMerge(sourceLayer),
  );
}

const calls = { count: 0 };
const layer = it.layer(testLayer(calls));

layer("EventResearchService", (it) => {
  it.effect(
    "returns a job immediately, drains it, and reopens identical saved evidence offline",
    () =>
      Effect.gen(function* () {
        yield* runMigrations({});
        const sql = yield* SqlClient.SqlClient;
        const table = yield* sql<{
          readonly name: string;
        }>`SELECT name FROM sqlite_master WHERE name = 'graph_research_result_jobs'`;
        assert.equal(table[0]?.name, "graph_research_result_jobs");
        const service = yield* EventResearchService;
        const store = yield* ResearchStudyStore;
        const probe = yield* Effect.result(store.getJob("absent"));
        assert.equal(probe._tag, "Failure");
        if (probe._tag === "Failure") assert.equal(probe.failure.reason, "not_found");
        const queued = yield* service.start(recipe);
        const same = yield* service.start(recipe);
        assert.equal(same.jobId, queued.jobId);
        assert.equal(queued.status, "queued");
        assert.equal(calls.count, 0);
        const completed = yield* service.drain();
        assert.equal(completed.length, 1);
        assert.equal(completed[0]?.status, "complete");
        assert.equal(completed[0]?.plannedWindows, 4);
        assert.equal(completed[0]?.completedWindows, 4);
        assert.equal(completed[0]?.requestCount, 4);
        const study = yield* store.readStudy(completed[0]!.studyId!);
        assert.equal(study.report.rows[0]?.horizons[0]?.status, "measured");
        assert.equal(study.priceSamples.length, samples.length);
        const beforeRead = calls.count;
        const reopened = yield* store.readStudy(study.studyId);
        assert.deepEqual(reopened, study);
        assert.equal(calls.count, beforeRead);
        const reused = yield* service.start(recipe);
        assert.equal(reused.status, "complete");
        assert.equal(calls.count, beforeRead);
      }),
  );

  it.effect("saves a zero-event report without querying Graph or the legacy archive", () =>
    Effect.gen(function* () {
      yield* runMigrations({});
      const service = yield* EventResearchService;
      const empty = {
        ...recipe,
        eventInventory: { ...recipe.eventInventory, id: "empty", occurrences: [] },
      };
      const started = yield* service.start(empty);
      const before = calls.count;
      const completed = yield* service.drain();
      assert.equal(completed.find((job) => job.jobId === started.jobId)?.status, "complete");
      assert.equal(calls.count, before);
    }),
  );
});
