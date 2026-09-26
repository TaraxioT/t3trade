import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { GraphDataError } from "@t3tools/trading-contracts/researchData";
import type { SavedEventStudy } from "@t3tools/trading-contracts/eventResearch";
import type { EventResearchRecipe } from "@t3tools/trading-contracts/eventResearch";
import type { ResearchJobView } from "@t3tools/trading-contracts/researchData";

import { publishSavedResearch, startGraphStudy } from "./researchHandlers.ts";

const scope = { environmentId: "env-1", threadId: "thread-1" };
const source = {
  provider: "the_graph" as const,
  chain: "ethereum" as const,
  subgraphId: "subgraph",
  deployment: "deployment",
  poolAddress: "pool",
  baseTokenAddress: "weth",
  quoteTokenAddress: "usdc",
  feeTier: "3000",
  normalizationVersion: 1 as const,
};

it.effect("refuses a missing Graph credential before reading the Fed calendar", () =>
  Effect.gen(function* () {
    let calendarCalls = 0;
    const result = yield* Effect.result(
      startGraphStudy({
        input: { action: "study_graph", from: "2021-01-01", to: "2026-01-01" },
        scope,
        now: Date.parse("2026-01-02T00:00:00Z"),
        inspectSource: () =>
          Effect.fail(new GraphDataError({ reason: "configuration", detail: "Graph key missing" })),
        resolveCalendar: () => {
          calendarCalls++;
          return Effect.die("must not fetch");
        },
        startStudy: () => Effect.die("must not start"),
      }),
    );
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") {
      assert.match(String(result.failure), /configuration/);
    }
    assert.equal(calendarCalls, 0);
  }),
);

it.effect("refuses a saved study from another thread before publishing", () =>
  Effect.gen(function* () {
    let published = false;
    const result = yield* Effect.result(
      publishSavedResearch({
        input: { action: "publish_saved_research", studyId: "study-1" },
        scope,
        now: 100,
        readStudy: () =>
          Effect.succeed({ environmentId: "env-1", threadId: "thread-2" } as SavedEventStudy),
        readSimulation: () => Effect.die("must not read simulation"),
        publishScene: () => {
          published = true;
          return Effect.die("must not publish");
        },
        recordMarket: () => Effect.die("must not focus market"),
      }),
    );
    assert.equal(result._tag, "Failure");
    assert.equal(published, false);
  }),
);

it.effect("returns a typed net P&L summary with a published saved long", () =>
  Effect.gen(function* () {
    const study = {
      studyId: "study-1",
      environmentId: scope.environmentId,
      threadId: scope.threadId,
      datasetIds: ["dataset-1"],
      recipe: { source },
    } as unknown as SavedEventStudy;
    const simulation = {
      simulationId: "long-1",
      parentStudyId: "study-1",
      environmentId: scope.environmentId,
      threadId: scope.threadId,
      datasetIds: ["dataset-1"],
      report: {
        summary: {
          eventCount: 2,
          coveredTrades: 1,
          totalNetPnlQuote: 98.51,
          totalFeesQuote: 1,
          totalSlippageCostQuote: 0.49,
        },
      },
    } as never;
    const result = yield* publishSavedResearch({
      input: { action: "publish_saved_research", simulationId: "long-1" },
      scope,
      now: 100,
      readStudy: () => Effect.succeed(study),
      readSimulation: () => Effect.succeed(simulation),
      publishScene: () =>
        Effect.succeed({ outcome: "published", scene: { sceneId: "scene-1" } } as never),
      recordMarket: () => Effect.succeed({} as never),
    });
    assert.deepEqual(result.savedResultSummary, {
      kind: "long_simulation",
      simulationId: "long-1",
      parentStudyId: "study-1",
      eventCount: 2,
      coveredTrades: 1,
      totalNetPnlQuote: 98.51,
      totalFeesQuote: 1,
      totalSlippageCostQuote: 0.49,
    });
  }),
);

it.effect("starts a pinned study with sourced inventory and an exclusive recipe end", () =>
  Effect.gen(function* () {
    let recipe: EventResearchRecipe | undefined;
    const job: ResearchJobView = {
      jobId: "job-1",
      datasetId: "dataset-1",
      environmentId: scope.environmentId,
      threadId: scope.threadId,
      source,
      snapshotBlock: { number: 1, hash: "0xhash" },
      entityKind: "hour",
      from: 1,
      to: 2,
      status: "queued",
      rowCount: 0,
      requestCount: 0,
      storedBytes: 0,
      cursor: null,
      updatedAt: 1,
    };
    const result = yield* startGraphStudy({
      input: { action: "study_graph", from: "2026-01-28", to: "2026-01-28" },
      scope,
      now: Date.parse("2026-02-01T00:00:00Z"),
      inspectSource: () =>
        Effect.succeed({
          source,
          snapshotBlock: job.snapshotBlock,
          indexedThrough: Date.parse("2026-02-01T00:00:00Z"),
          token0: { address: "usdc", decimals: 6 },
          token1: { address: "weth", decimals: 18 },
          coverage: {
            swaps: { firstAt: 0, lastAt: 2 },
            hour: { firstAt: 0, lastAt: 2 },
            day: { firstAt: 0, lastAt: 2 },
          },
        }),
      resolveCalendar: () =>
        Effect.succeed({
          id: "inventory",
          category: "scheduled",
          from: "2026-01-28",
          to: "2026-01-28",
          asOf: 1,
          retrievedAt: 1,
          status: "complete",
          affectedPeriods: [],
          occurrences: [],
        }),
      startStudy: (value) => {
        recipe = value;
        return Effect.succeed(job);
      },
    });
    assert.equal(result.researchJob?.jobId, "job-1");
    assert.equal(recipe?.to, "2026-01-29");
    assert.equal(recipe?.environmentId, "env-1");
  }),
);
