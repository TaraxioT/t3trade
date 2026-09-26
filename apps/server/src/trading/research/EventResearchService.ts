import * as NodeCrypto from "node:crypto";
import { Clock, Context, Effect, Layer, Schema } from "effect";

import {
  EventResearchRecipe,
  EventResearchReport,
  calculateEventResearch,
  type SavedEventStudy,
} from "@t3tools/trading-contracts/eventResearch";
import {
  ResearchError,
  ResearchPriceSample,
  type GraphEntityKind,
  type ResearchAcquisitionRequest,
  type ResearchJobView,
} from "@t3tools/trading-contracts/researchData";

import { GraphHistoricalData } from "./GraphHistoricalData.ts";
import {
  researchDatasetIdentity,
  resolveResearchAcquisitionCaps,
} from "./ResearchAcquisitionService.ts";
import { ResearchAcquisitionWorker } from "./ResearchAcquisitionWorker.ts";
import { ResearchDatasetStore } from "./ResearchDatasetStore.ts";
import { ResearchStudyStore } from "./ResearchStudyStore.ts";

export interface EventResearchServiceShape {
  readonly start: (recipe: EventResearchRecipe) => Effect.Effect<ResearchJobView, ResearchError>;
  readonly run: (jobId: string) => Effect.Effect<ResearchJobView, ResearchError>;
  readonly drain: () => Effect.Effect<ReadonlyArray<ResearchJobView>, ResearchError>;
}

export class EventResearchService extends Context.Service<
  EventResearchService,
  EventResearchServiceShape
>()("t3/trading/research/EventResearchService") {}

const encodeRecipe = Schema.encodeSync(Schema.fromJsonString(EventResearchRecipe));
const encodeReport = Schema.encodeSync(Schema.fromJsonString(EventResearchReport));
const DAY = 86_400_000;
const MINUTE = 60_000;
const STUDY_LEASE_MS = 30 * MINUTE;

interface WindowPlan {
  readonly entityKind: GraphEntityKind;
  readonly from: number;
  readonly to: number;
}

function error(reason: ResearchError["reason"], detail: string): ResearchError {
  return new ResearchError({ reason, detail });
}

function studyIdentity(recipe: EventResearchRecipe): string {
  return NodeCrypto.createHash("sha256").update(encodeRecipe(recipe)).digest("hex");
}

/** One wide aggregate window and narrow swap windows covering the default follow-ups. */
function planWindows(recipe: EventResearchRecipe): ReadonlyArray<WindowPlan> {
  const events = recipe.eventInventory.occurrences.flatMap((event) =>
    event.statementAt === null ? [] : [event.statementAt],
  );
  if (events.length === 0) return [];
  const earliest = Math.min(...events);
  const latest = Math.max(...events);
  const maxHorizon = Math.max(...recipe.horizonsMs, 7 * DAY);
  const contextTo = Math.min(recipe.cutoffAt + 1, latest + maxHorizon + DAY);
  const windows: WindowPlan[] = [
    { entityKind: "hour", from: Math.max(0, earliest - DAY), to: contextTo },
  ];
  const maxDelay = recipe.referencePriceRule.afterMaxDelayMs;
  for (const eventAt of events) {
    const firstFrom = Math.max(0, eventAt - recipe.referencePriceRule.beforeMaxAgeMs);
    const firstTo = Math.min(recipe.cutoffAt + 1, eventAt + 65 * MINUTE + maxDelay + 1);
    if (firstTo > firstFrom) windows.push({ entityKind: "swaps", from: firstFrom, to: firstTo });
    for (const offset of [DAY, 7 * DAY]) {
      const from = eventAt + offset;
      const to = Math.min(recipe.cutoffAt + 1, from + 5 * MINUTE + maxDelay + 1);
      if (to > from) windows.push({ entityKind: "swaps", from, to });
    }
    for (const horizon of recipe.horizonsMs) {
      if (horizon === 3_600_000 || horizon === DAY || horizon === 7 * DAY) continue;
      const from = eventAt + horizon;
      const to = Math.min(recipe.cutoffAt + 1, from + maxDelay + 1);
      if (to > from) windows.push({ entityKind: "swaps", from, to });
    }
  }
  return [
    ...new Map(
      windows.map((window) => [`${window.entityKind}:${window.from}:${window.to}`, window]),
    ).values(),
  ];
}

export const makeEventResearchService = (options: { readonly autoStart?: boolean } = {}) =>
  Effect.gen(function* () {
    const graph = yield* GraphHistoricalData;
    const datasets = yield* ResearchDatasetStore;
    const worker = yield* ResearchAcquisitionWorker;
    const studies = yield* ResearchStudyStore;
    const autoStart = options.autoStart ?? true;

    const run: EventResearchServiceShape["run"] = (jobId) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const ownerToken = NodeCrypto.randomUUID();
        const claimed = yield* studies.claimJob(jobId, ownerToken, now, STUDY_LEASE_MS);
        if (claimed === null) return yield* studies.getJob(jobId);
        const result = yield* Effect.result(
          Effect.gen(function* () {
            const recipe = yield* studies.getRecipe(jobId);
            const plans = planWindows(recipe);
            const datasetIds: string[] = [];
            const priceSamples = new Map<string, ResearchPriceSample>();
            if (plans.length > 0) {
              const context = plans[0]!;
              const capability = yield* graph
                .inspectSource({
                  subgraphId: recipe.source.subgraphId,
                  poolAddress: recipe.source.poolAddress,
                  baseTokenAddress: recipe.source.baseTokenAddress,
                  quoteTokenAddress: recipe.source.quoteTokenAddress,
                  feeTier: recipe.source.feeTier,
                  requiredFrom: context.from,
                  requiredTo: Math.min(context.to, recipe.cutoffAt),
                })
                .pipe(
                  Effect.mapError((cause) => error("source", `Graph capability: ${cause.reason}`)),
                );
              if (
                capability.source.deployment !== recipe.source.deployment ||
                capability.snapshotBlock.number < recipe.snapshotBlock.number
              ) {
                return yield* error(
                  "source",
                  "Graph deployment or snapshot no longer matches the recipe",
                );
              }
            }
            const caps = yield* Effect.try({
              try: () => resolveResearchAcquisitionCaps(process.env),
              catch: (cause) =>
                Schema.is(ResearchError)(cause)
                  ? cause
                  : error("budget", "Invalid Graph research budget"),
            });
            for (const [index, plan] of plans.entries()) {
              const at = yield* Clock.currentTimeMillis;
              yield* studies.renewJob(jobId, ownerToken, at, STUDY_LEASE_MS);
              const request: ResearchAcquisitionRequest = {
                environmentId: recipe.environmentId,
                threadId: recipe.threadId,
                source: recipe.source,
                snapshotBlock: recipe.snapshotBlock,
                entityKind: plan.entityKind,
                from: plan.from,
                to: plan.to,
              };
              const datasetId = researchDatasetIdentity(request);
              const datasetJobId = `graph-${datasetId}`;
              let datasetJob = yield* datasets.create({
                ...request,
                datasetId,
                jobId: datasetJobId,
                caps,
                now: at,
              });
              if (datasetJob.status !== "complete") datasetJob = yield* worker.run(datasetJobId);
              if (datasetJob.status !== "complete") {
                return yield* error(
                  datasetJob.status === "paused" ? "budget" : "source",
                  `Graph dataset ${datasetJob.status}: ${datasetJob.failureReason ?? "acquisition did not complete"}`,
                );
              }
              const progress = yield* studies.recordProgress(
                jobId,
                ownerToken,
                datasetJob,
                yield* Clock.currentTimeMillis,
              );
              datasetIds.push(datasetId);
              if (
                index < plans.length - 1 &&
                (progress.requestCount >= caps.requests ||
                  progress.rowCount >= caps.rows ||
                  progress.storedBytes >= caps.bytes)
              ) {
                return yield* error(
                  "budget",
                  "Event study acquisition budget reached before all windows completed",
                );
              }
              let cursor: string | undefined;
              while (true) {
                const page = yield* datasets.readWindow({
                  datasetId,
                  from: plan.from,
                  to: plan.to,
                  resolution: plan.entityKind,
                  ...(cursor === undefined ? {} : { cursor }),
                });
                if (page.manifest.status !== "complete")
                  return yield* error("conflict", "Study encountered an incomplete dataset");
                if (plan.entityKind === "swaps") {
                  for (const row of page.rows) {
                    if (!Schema.is(ResearchPriceSample)(row))
                      return yield* error("storage", "Swap dataset contains an incompatible row");
                    const previous = priceSamples.get(row.id);
                    if (previous && (previous.at !== row.at || previous.price !== row.price))
                      return yield* error("conflict", "Saved price sample changed across windows");
                    priceSamples.set(row.id, row);
                  }
                }
                if (page.nextCursor === null) break;
                cursor = page.nextCursor;
              }
            }
            const retainedSamples = [...priceSamples.values()].sort(
              (a, b) => a.at - b.at || a.id.localeCompare(b.id),
            );
            const report = yield* Effect.try({
              try: () => calculateEventResearch({ recipe, priceSamples: retainedSamples }),
              catch: () =>
                error("invalid_request", "Event study could not calculate from retained prices"),
            });
            const completedAt = yield* Clock.currentTimeMillis;
            const studyId = studyIdentity(recipe);
            const study: SavedEventStudy = {
              studyId,
              environmentId: recipe.environmentId,
              threadId: recipe.threadId,
              recipe,
              report,
              reportHash: NodeCrypto.createHash("sha256")
                .update(encodeReport(report))
                .digest("hex"),
              datasetIds,
              priceSamples: retainedSamples,
              createdAt: completedAt,
            };
            return yield* studies.completeStudy({ jobId, ownerToken, study, now: completedAt });
          }),
        );
        if (result._tag === "Success") return result.success;
        const failure = result.failure;
        const at = yield* Clock.currentTimeMillis;
        return yield* studies.failJob(
          jobId,
          ownerToken,
          at,
          `${failure.reason}: ${failure.detail}`,
          failure.reason === "budget",
        );
      });

    const drain: EventResearchServiceShape["drain"] = () =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const jobIds = yield* studies.listRunnable(now, 100);
        return yield* Effect.forEach(jobIds, run, { concurrency: 2 });
      });

    const start: EventResearchServiceShape["start"] = (recipe) =>
      Effect.gen(function* () {
        if (
          !Schema.is(EventResearchRecipe)(recipe) ||
          !recipe.environmentId ||
          !recipe.threadId ||
          recipe.horizonsMs.length === 0 ||
          new Set(recipe.horizonsMs).size !== recipe.horizonsMs.length ||
          recipe.eventInventory.occurrences.length > 200 ||
          recipe.eventInventory.asOf > recipe.cutoffAt ||
          recipe.to <= recipe.from ||
          recipe.eventInventory.occurrences.some(
            (event) => event.meetingTo < recipe.from || event.meetingTo >= recipe.to,
          )
        ) {
          return yield* error("invalid_request", "Event study recipe is invalid");
        }
        const now = yield* Clock.currentTimeMillis;
        const studyId = studyIdentity(recipe);
        const jobId = `event-study-${studyId}`;
        const plans = planWindows(recipe);
        const first = plans[0];
        const primaryDatasetId = first
          ? researchDatasetIdentity({
              environmentId: recipe.environmentId,
              threadId: recipe.threadId,
              source: recipe.source,
              snapshotBlock: recipe.snapshotBlock,
              entityKind: first.entityKind,
              from: first.from,
              to: first.to,
            })
          : "";
        const view: ResearchJobView = {
          jobId,
          datasetId: primaryDatasetId,
          environmentId: recipe.environmentId,
          threadId: recipe.threadId,
          source: recipe.source,
          snapshotBlock: recipe.snapshotBlock,
          entityKind: "hour",
          from: first?.from ?? 0,
          to: first?.to ?? 1,
          status: "queued",
          rowCount: 0,
          requestCount: 0,
          storedBytes: 0,
          cursor: null,
          updatedAt: now,
          completedWindows: 0,
          plannedWindows: plans.length,
          resultKind: "event_study",
        };
        const job = yield* studies.createJob({ jobId, studyId, recipe, view });
        if (autoStart && job.status === "queued") {
          yield* run(jobId).pipe(
            Effect.catch((failure) =>
              Effect.logError("Event research worker stopped", { reason: failure.reason }),
            ),
            Effect.forkDetach,
          );
        }
        return job;
      });
    if (autoStart) {
      yield* drain().pipe(
        Effect.catch((failure) =>
          Effect.logError("Queued event research could not resume", { reason: failure.reason }),
        ),
        Effect.forkDetach,
      );
    }
    return { start, run, drain } satisfies EventResearchServiceShape;
  });

export const EventResearchServiceLive = (
  options: { readonly autoStart?: boolean } = {},
): Layer.Layer<
  EventResearchService,
  never,
  GraphHistoricalData | ResearchDatasetStore | ResearchAcquisitionWorker | ResearchStudyStore
> => Layer.effect(EventResearchService, makeEventResearchService(options));
