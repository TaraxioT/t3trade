import * as NodeCrypto from "node:crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { TradingEventsInput, TradingEventsResult } from "@t3tools/trading-contracts/eventSets";
import type {
  TradingChartInput,
  TradingChartResult,
} from "@t3tools/trading-contracts/researchScenes";
import type { SavedEventStudy } from "@t3tools/trading-contracts/eventResearch";
import type { SavedEventLongSimulation } from "@t3tools/trading-contracts/eventLongSimulation";
import { TradingToolRejectedError } from "@t3tools/trading-contracts/tools";

import type { FomcCalendarServiceShape } from "../../../trading/research/FomcCalendarService.ts";
import type { GraphHistoricalDataShape } from "../../../trading/research/GraphHistoricalData.ts";
import { UNISWAP_V3_ETHEREUM_SUBGRAPH_ID } from "../../../trading/research/GraphHistoricalData.ts";
import type { EventResearchServiceShape } from "../../../trading/research/EventResearchService.ts";
import type { EventLongSimulationServiceShape } from "../../../trading/research/EventLongSimulationService.ts";
import type { ResearchStudyStoreShape } from "../../../trading/research/ResearchStudyStore.ts";
import type {
  ResearchSceneWrite,
  TradingResearchSceneServiceShape,
} from "../../../trading/TradingResearchSceneService.ts";
import type { TradingThreadMarketServiceShape } from "../../../trading/TradingThreadMarketService.ts";

export interface ResearchInvocationScope {
  readonly environmentId: string;
  readonly threadId: string;
}

const DAY = 86_400_000;
const HOUR = 3_600_000;
const MINUTE = 60_000;

function refusal(
  scope: ResearchInvocationScope,
  reason: "events_refused" | "chart_refused",
  detail: string,
): TradingToolRejectedError {
  return new TradingToolRejectedError({ reason, threadId: scope.threadId, detail });
}

function dateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = DateTime.make(`${value}T00:00:00Z`);
  return Option.isSome(parsed) && DateTime.formatIsoDateUtc(parsed.value) === value;
}

/** A source capability check precedes the official calendar fetch and every job write. */
export function startGraphStudy(input: {
  readonly input: TradingEventsInput;
  readonly scope: ResearchInvocationScope;
  readonly now: number;
  readonly inspectSource: GraphHistoricalDataShape["inspectSource"];
  readonly resolveCalendar: FomcCalendarServiceShape["resolve"];
  readonly startStudy: EventResearchServiceShape["start"];
}): Effect.Effect<TradingEventsResult, TradingToolRejectedError> {
  return Effect.gen(function* () {
    const { scope, now } = input;
    const today = DateTime.makeUnsafe(now);
    const to = input.input.to ?? DateTime.formatIsoDateUtc(today);
    const from = input.input.from ?? DateTime.formatIsoDateUtc(DateTime.add(today, { years: -5 }));
    if (!dateOnly(from) || !dateOnly(to) || from > to) {
      return yield* Effect.fail(
        refusal(scope, "events_refused", "study_graph needs valid from/to UTC dates"),
      );
    }
    const fromMs = DateTime.makeUnsafe(`${from}T00:00:00Z`).epochMilliseconds;
    const toExclusive = DateTime.formatIsoDateUtc(
      DateTime.add(DateTime.makeUnsafe(`${to}T00:00:00Z`), { days: 1 }),
    );
    const toMs = Math.min(
      now - HOUR,
      DateTime.makeUnsafe(`${toExclusive}T00:00:00Z`).epochMilliseconds,
    );
    if (toMs <= fromMs) {
      return yield* Effect.fail(
        refusal(scope, "events_refused", "Graph window has no indexed past time"),
      );
    }
    const horizonsMs = input.input.horizonsMs ?? [HOUR, DAY, 7 * DAY];
    if (
      horizonsMs.length === 0 ||
      new Set(horizonsMs).size !== horizonsMs.length ||
      horizonsMs.some((horizon) => !Number.isSafeInteger(horizon) || horizon <= 0)
    ) {
      return yield* Effect.fail(
        refusal(scope, "events_refused", "Horizons must be distinct positive milliseconds"),
      );
    }
    const capability = yield* input
      .inspectSource({
        subgraphId: UNISWAP_V3_ETHEREUM_SUBGRAPH_ID,
        poolAddress: "0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8",
        baseTokenAddress: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
        quoteTokenAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        feeTier: "3000",
        requiredFrom: fromMs,
        requiredTo: toMs,
      })
      .pipe(
        Effect.mapError((error) =>
          refusal(scope, "events_refused", `Graph source ${error.reason}: ${error.detail}`),
        ),
      );
    const inventory = yield* input
      .resolveCalendar({
        from,
        to: toExclusive,
        asOf: now,
        category: input.input.category ?? "scheduled",
      })
      .pipe(Effect.mapError((error) => refusal(scope, "events_refused", error.detail)));
    const job = yield* input
      .startStudy({
        environmentId: scope.environmentId,
        threadId: scope.threadId,
        eventInventory: inventory,
        source: capability.source,
        snapshotBlock: capability.snapshotBlock,
        from,
        to: toExclusive,
        horizonsMs,
        referencePriceRule: { beforeMaxAgeMs: 5 * MINUTE, afterMaxDelayMs: 5 * MINUTE },
        cutoffAt: Math.min(now, capability.indexedThrough),
      })
      .pipe(Effect.mapError((error) => refusal(scope, "events_refused", error.detail)));
    return {
      researchJob: job,
      outcome: `Graph FOMC study ${job.status}; job ${job.jobId}. ${inventory.occurrences.length} sourced occurrences in the frozen inventory.`,
    };
  });
}

export function startLongSimulation(input: {
  readonly input: TradingEventsInput;
  readonly scope: ResearchInvocationScope;
  readonly readStudy: ResearchStudyStoreShape["readStudy"];
  readonly startLong: EventLongSimulationServiceShape["start"];
}): Effect.Effect<TradingEventsResult, TradingToolRejectedError> {
  return Effect.gen(function* () {
    const { parentStudyId, scenario } = input.input;
    if (!parentStudyId || !scenario) {
      return yield* Effect.fail(
        refusal(input.scope, "events_refused", "simulate_long needs parentStudyId and scenario"),
      );
    }
    const parent = yield* input
      .readStudy(parentStudyId)
      .pipe(
        Effect.mapError(() => refusal(input.scope, "events_refused", "Saved study is unavailable")),
      );
    if (
      parent.environmentId !== input.scope.environmentId ||
      parent.threadId !== input.scope.threadId
    ) {
      return yield* Effect.fail(
        refusal(
          input.scope,
          "events_refused",
          "Saved study belongs to another environment or thread",
        ),
      );
    }
    const job = yield* input
      .startLong({ parentStudyId, scenario })
      .pipe(Effect.mapError((error) => refusal(input.scope, "events_refused", error.detail)));
    return { researchJob: job, outcome: `Long simulation ${job.status}; job ${job.jobId}.` };
  });
}

export function publishSavedResearch(input: {
  readonly input: TradingChartInput;
  readonly scope: ResearchInvocationScope;
  readonly now: number;
  readonly readStudy: ResearchStudyStoreShape["readStudy"];
  readonly readSimulation: ResearchStudyStoreShape["readSimulation"];
  readonly publishScene: TradingResearchSceneServiceShape["publish"];
  readonly recordMarket: TradingThreadMarketServiceShape["record"];
}): Effect.Effect<TradingChartResult, TradingToolRejectedError> {
  return Effect.gen(function* () {
    const { studyId, simulationId } = input.input;
    if ((studyId === undefined) === (simulationId === undefined)) {
      return yield* Effect.fail(
        refusal(input.scope, "chart_refused", "Specify exactly one studyId or simulationId"),
      );
    }
    let study: SavedEventStudy;
    let simulation: SavedEventLongSimulation | undefined;
    if (studyId !== undefined) {
      study = yield* input
        .readStudy(studyId)
        .pipe(
          Effect.mapError(() =>
            refusal(input.scope, "chart_refused", "Saved study is unavailable"),
          ),
        );
    } else {
      simulation = yield* input
        .readSimulation(simulationId!)
        .pipe(
          Effect.mapError(() =>
            refusal(input.scope, "chart_refused", "Saved simulation is unavailable"),
          ),
        );
      study = yield* input
        .readStudy(simulation.parentStudyId)
        .pipe(
          Effect.mapError(() =>
            refusal(input.scope, "chart_refused", "Parent study is unavailable"),
          ),
        );
    }
    if (
      study.environmentId !== input.scope.environmentId ||
      study.threadId !== input.scope.threadId ||
      (simulation !== undefined &&
        (simulation.environmentId !== input.scope.environmentId ||
          simulation.threadId !== input.scope.threadId))
    ) {
      return yield* Effect.fail(
        refusal(
          input.scope,
          "chart_refused",
          "Saved result belongs to another environment or thread",
        ),
      );
    }
    const resultId = studyId ?? simulation!.simulationId;
    const sceneId = `graph-${NodeCrypto.createHash("sha256")
      .update(`${input.scope.environmentId}:${input.scope.threadId}:${resultId}`)
      .digest("hex")}`;
    const document =
      simulation === undefined
        ? {
            kind: "graph_event_study" as const,
            studyId: study.studyId,
            source: study.recipe.source,
            datasetIds: [...study.datasetIds],
          }
        : {
            kind: "graph_long_simulation" as const,
            simulationId: simulation.simulationId,
            parentStudyId: study.studyId,
            source: study.recipe.source,
            datasetIds: [...simulation.datasetIds],
          };
    const write: ResearchSceneWrite = {
      sceneId,
      threadId: input.scope.threadId,
      kind: document.kind,
      title: simulation === undefined ? "FOMC ETH event study" : "FOMC ETH long simulation",
      market: "ETH",
      interval: null,
      calculationVersion:
        simulation === undefined ? "graph-event-study-1" : "graph-long-simulation-1",
      payload: { kind: "graphResearch", document },
      now: input.now,
    };
    const published = yield* input
      .publishScene(write)
      .pipe(
        Effect.mapError(() =>
          refusal(input.scope, "chart_refused", "Could not save the research scene"),
        ),
      );
    if (published.outcome === "refused") {
      return yield* Effect.fail(refusal(input.scope, "chart_refused", published.reason));
    }
    yield* input
      .recordMarket({ threadId: input.scope.threadId, asset: "ETH", source: "look" })
      .pipe(
        Effect.mapError(() =>
          refusal(
            input.scope,
            "chart_refused",
            "Scene saved, but thread market focus could not be set; retry publish_saved_research",
          ),
        ),
      );
    return {
      scene: published.scene,
      openResearch: {
        kind: "open_research_scene",
        environmentId: input.scope.environmentId,
        threadId: input.scope.threadId,
        sceneId: published.scene.sceneId,
        market: "ETH",
        source: study.recipe.source,
        datasetIds: [...document.datasetIds],
        resultKind: simulation === undefined ? "event_study" : "long_simulation",
        ...(simulation === undefined
          ? { studyId: study.studyId }
          : { simulationId: simulation.simulationId }),
        view: "calendar",
        label: "Open on graph",
      },
      outcome: "Saved research scene is ready. Open on graph to view the retained result.",
    };
  });
}
