import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import { Effect, Layer, Schema } from "effect";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  EventResearchReport,
  calculateEventResearch,
  type EventResearchRecipe,
  type SavedEventStudy,
} from "@t3tools/trading-contracts/eventResearch";
import type { EventLongScenario } from "@t3tools/trading-contracts/eventLongSimulation";
import type { ResearchPriceSample } from "@t3tools/trading-contracts/researchData";

import { runMigrations } from "../../persistence/Migrations.ts";
import { GraphHistoricalData, type GraphHistoricalDataShape } from "./GraphHistoricalData.ts";
import { ResearchDatasetStoreLive } from "./ResearchDatasetStore.ts";
import { ResearchAcquisitionWorkerLive } from "./ResearchAcquisitionWorker.ts";
import { ResearchStudyStore, ResearchStudyStoreLive } from "./ResearchStudyStore.ts";
import {
  EventLongSimulationService,
  EventLongSimulationServiceLive,
} from "./EventLongSimulationService.ts";

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
const recipe: EventResearchRecipe = {
  environmentId: "env",
  threadId: "thread",
  eventInventory: {
    id: "inventory",
    category: "scheduled",
    from: "2026-01-01",
    to: "2026-02-01",
    asOf: eventAt + 9 * 86_400_000,
    retrievedAt: eventAt + 9 * 86_400_000,
    status: "complete",
    affectedPeriods: [],
    occurrences: [
      {
        id: "event",
        meetingFrom: "2026-01-27",
        meetingTo: "2026-01-28",
        classification: "scheduled",
        statementAt: eventAt,
        missingTimeReason: null,
        sourceUrl: "https://www.federalreserve.gov/statement",
        sourceHash: "hash",
        sourceExcerpt: "2:00 p.m. EST",
        calendarUrl: "https://www.federalreserve.gov/calendar",
        calendarHash: "calendar",
        retrievedAt: eventAt + 1,
        timezoneInterpretation: "America/New_York (EST, UTC-05:00)",
        minutesReleasedOn: null,
      },
    ],
  },
  source,
  snapshotBlock: { number: 1, hash: "0xhash" },
  from: "2026-01-01",
  to: "2026-02-01",
  horizonsMs: [86_400_000],
  referencePriceRule: { beforeMaxAgeMs: 300_000, afterMaxDelayMs: 300_000 },
  cutoffAt: eventAt + 9 * 86_400_000,
};
const sample = (id: string, at: number, price: number): ResearchPriceSample => ({
  id,
  at,
  price,
  blockNumber: 1,
  transactionId: `0x${id}`,
  logIndex: 1,
});
const priceSamples = [
  sample("pre", eventAt - 60_000, 100),
  sample("entry", eventAt + 300_000, 100),
  sample("exit", eventAt + 300_000 + 86_400_000, 110),
];
const report = calculateEventResearch({ recipe, priceSamples });
const parent: SavedEventStudy = {
  studyId: "parent",
  environmentId: "env",
  threadId: "thread",
  recipe,
  report,
  reportHash: NodeCrypto.createHash("sha256")
    .update(Schema.encodeSync(Schema.fromJsonString(EventResearchReport))(report))
    .digest("hex"),
  datasetIds: [],
  priceSamples,
  createdAt: eventAt + 9 * 86_400_000,
};
const scenario: EventLongScenario = {
  notionalQuote: 1_000,
  entryDelayMs: 300_000,
  holdMs: 86_400_000,
  maxEntryWaitMs: 300_000,
  maxExitWaitMs: 300_000,
  feeBpsPerSide: 0,
  slippageBpsPerSide: 0,
};
const parentView = {
  jobId: "parent-job",
  datasetId: "",
  environmentId: "env",
  threadId: "thread",
  source,
  snapshotBlock: recipe.snapshotBlock,
  entityKind: "hour" as const,
  from: 0,
  to: 1,
  status: "queued" as const,
  rowCount: 0,
  requestCount: 0,
  storedBytes: 0,
  cursor: null,
  updatedAt: 1,
};

const calls = { count: 0 };
const graph: GraphHistoricalDataShape = {
  inspectSource: () =>
    Effect.succeed({
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
    }),
  readWindow: (request) => {
    calls.count++;
    const rows = [sample("week-exit", eventAt + 300_000 + 7 * 86_400_000, 120)].filter(
      (row) => row.at >= request.from && row.at < request.to,
    );
    return Effect.succeed({
      entityKind: request.entityKind,
      rows,
      nextCursor: null,
      progress: { rowsReturned: rows.length, hasMore: false, snapshotBlock: recipe.snapshotBlock },
    });
  },
};

const database = NodeSqliteClient.layerMemory();
const stores = Layer.mergeAll(ResearchStudyStoreLive, ResearchDatasetStoreLive).pipe(
  Layer.provideMerge(database),
);
const graphLayer = Layer.succeed(GraphHistoricalData, graph);
const worker = ResearchAcquisitionWorkerLive.pipe(
  Layer.provideMerge(stores),
  Layer.provideMerge(graphLayer),
);
const layer = it.layer(
  EventLongSimulationServiceLive({ autoStart: false }).pipe(
    Layer.provideMerge(worker),
    Layer.provideMerge(stores),
    Layer.provideMerge(graphLayer),
  ),
);

const setup = Effect.gen(function* () {
  yield* runMigrations({});
  const store = yield* ResearchStudyStore;
  yield* store.createJob({ jobId: "parent-job", studyId: "parent", recipe, view: parentView });
  yield* store.claimJob("parent-job", "owner", 2, 1_000);
  yield* store.completeStudy({ jobId: "parent-job", ownerToken: "owner", study: parent, now: 3 });
});

layer("EventLongSimulationService", (it) => {
  it.effect("saves default and cost-only follow-ups offline with parent lineage", () =>
    Effect.gen(function* () {
      yield* setup;
      const service = yield* EventLongSimulationService;
      const store = yield* ResearchStudyStore;
      const queued = yield* service.start({ parentStudyId: "parent", scenario });
      assert.equal(queued.status, "queued");
      assert.equal(calls.count, 0);
      const completed = yield* service.drain();
      const saved = yield* store.readSimulation(completed[0]!.simulationId!);
      assert.equal(saved.parentStudyId, "parent");
      assert.equal(saved.parentReportHash, parent.reportHash);
      assert.equal(saved.report.summary.totalNetPnlQuote, 100);
      assert.equal(calls.count, 0);
      const changed = yield* service.start({
        parentStudyId: "parent",
        scenario: { ...scenario, feeBpsPerSide: 10 },
      });
      assert.notEqual(changed.jobId, queued.jobId);
      yield* service.drain();
      assert.equal(calls.count, 0);
    }),
  );

  it.effect("acquires a new saved dataset revision for a newly requested hold horizon", () =>
    Effect.gen(function* () {
      yield* setup;
      const service = yield* EventLongSimulationService;
      const store = yield* ResearchStudyStore;
      const started = yield* service.start({
        parentStudyId: "parent",
        scenario: { ...scenario, holdMs: 7 * 86_400_000 },
      });
      const completed = yield* service.drain();
      const saved = yield* store.readSimulation(
        completed.find((job) => job.jobId === started.jobId)!.simulationId!,
      );
      assert.equal(saved.report.summary.coveredTrades, 1);
      assert.equal(saved.datasetIds.length, 1);
      assert.equal(calls.count > 0, true);
      const after = calls.count;
      const reopened = yield* store.readSimulation(saved.simulationId);
      assert.deepEqual(reopened, saved);
      assert.equal(calls.count, after);
    }),
  );
});
