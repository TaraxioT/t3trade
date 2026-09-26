import * as NodeCrypto from "node:crypto";
import { Clock, Context, Effect, Layer, Schema } from "effect";

import {
  EventLongSimulationReport,
  EventLongSimulationRequest,
  simulateEventLongs,
  type SavedEventLongSimulation,
} from "@t3tools/trading-contracts/eventLongSimulation";
import {
  ResearchError,
  ResearchPriceSample,
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

export interface EventLongSimulationServiceShape {
  readonly start: (
    request: EventLongSimulationRequest,
  ) => Effect.Effect<ResearchJobView, ResearchError>;
  readonly run: (jobId: string) => Effect.Effect<ResearchJobView, ResearchError>;
  readonly drain: () => Effect.Effect<ReadonlyArray<ResearchJobView>, ResearchError>;
}

export class EventLongSimulationService extends Context.Service<
  EventLongSimulationService,
  EventLongSimulationServiceShape
>()("t3/trading/research/EventLongSimulationService") {}

const encodeRequest = Schema.encodeSync(Schema.fromJsonString(EventLongSimulationRequest));
const encodeReport = Schema.encodeSync(Schema.fromJsonString(EventLongSimulationReport));
const LEASE_MS = 30 * 60_000;

interface SampleWindow {
  readonly from: number;
  readonly to: number;
}

function error(reason: ResearchError["reason"], detail: string): ResearchError {
  return new ResearchError({ reason, detail });
}

function simulationIdentity(parentReportHash: string, request: EventLongSimulationRequest): string {
  return NodeCrypto.createHash("sha256")
    .update(parentReportHash)
    .update(encodeRequest(request))
    .digest("hex");
}

function covered(windows: ReadonlyArray<SampleWindow>, from: number, to: number): boolean {
  return windows.some((window) => window.from <= from && window.to >= to);
}

export const makeEventLongSimulationService = (options: { readonly autoStart?: boolean } = {}) =>
  Effect.gen(function* () {
    const studies = yield* ResearchStudyStore;
    const datasets = yield* ResearchDatasetStore;
    const worker = yield* ResearchAcquisitionWorker;
    const graph = yield* GraphHistoricalData;
    const autoStart = options.autoStart ?? true;

    const run: EventLongSimulationServiceShape["run"] = (jobId) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const ownerToken = NodeCrypto.randomUUID();
        const claimed = yield* studies.claimSimulationJob(jobId, ownerToken, now, LEASE_MS);
        if (claimed === null) return yield* studies.getJob(jobId);
        const result = yield* Effect.result(
          Effect.gen(function* () {
            const request = yield* studies.getSimulationRequest(jobId);
            const parent = yield* studies.readStudy(request.parentStudyId);
            const samples = new Map(parent.priceSamples.map((sample) => [sample.id, sample]));
            const datasetIds = new Set(parent.datasetIds);
            const coverage: SampleWindow[] = [];
            for (const datasetId of datasetIds) {
              const datasetJob = yield* datasets.getJob(`graph-${datasetId}`);
              if (datasetJob.status !== "complete")
                return yield* error("conflict", "Parent study references an incomplete dataset");
              if (datasetJob.entityKind === "swaps")
                coverage.push({ from: datasetJob.from, to: datasetJob.to });
            }
            const caps = yield* Effect.try({
              try: () => resolveResearchAcquisitionCaps(process.env),
              catch: (cause) =>
                Schema.is(ResearchError)(cause)
                  ? cause
                  : error("budget", "Invalid Graph research budget"),
            });
            for (let pass = 0; pass < 2; pass++) {
              const currentSamples = [...samples.values()];
              const report = simulateEventLongs({
                parentStudy: { ...parent, priceSamples: currentSamples },
                scenario: request.scenario,
              });
              const needed: SampleWindow[] = [];
              for (const outcome of report.outcomes) {
                if (
                  outcome.status !== "skipped" ||
                  (outcome.reason !== "entry_unavailable" && outcome.reason !== "exit_unavailable")
                )
                  continue;
                const event = parent.recipe.eventInventory.occurrences.find(
                  (item) => item.id === outcome.eventId,
                );
                if (event?.statementAt === null || event?.statementAt === undefined) continue;
                let target: number;
                let wait: number;
                if (outcome.reason === "entry_unavailable") {
                  target = event.statementAt + request.scenario.entryDelayMs;
                  wait = request.scenario.maxEntryWaitMs;
                } else {
                  const targetEntry = event.statementAt + request.scenario.entryDelayMs;
                  const entry = currentSamples
                    .filter(
                      (sample) =>
                        sample.at >= targetEntry &&
                        sample.at <= targetEntry + request.scenario.maxEntryWaitMs,
                    )
                    .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))[0];
                  if (!entry) continue;
                  target = entry.at + request.scenario.holdMs;
                  wait = request.scenario.maxExitWaitMs;
                }
                const to = Math.min(parent.recipe.cutoffAt + 1, target + wait + 1);
                if (to > target && !covered(coverage, target, to))
                  needed.push({ from: target, to });
              }
              const distinct = [
                ...new Map(
                  needed.map((window) => [`${window.from}:${window.to}`, window]),
                ).values(),
              ];
              if (distinct.length === 0) break;
              for (const window of distinct) {
                const at = yield* Clock.currentTimeMillis;
                yield* studies.renewJob(jobId, ownerToken, at, LEASE_MS);
                const capability = yield* graph
                  .inspectSource({
                    subgraphId: parent.recipe.source.subgraphId,
                    poolAddress: parent.recipe.source.poolAddress,
                    baseTokenAddress: parent.recipe.source.baseTokenAddress,
                    quoteTokenAddress: parent.recipe.source.quoteTokenAddress,
                    feeTier: parent.recipe.source.feeTier,
                    requiredFrom: window.from,
                    requiredTo: window.to,
                  })
                  .pipe(
                    Effect.mapError((cause) =>
                      error("source", `Graph capability: ${cause.reason}`),
                    ),
                  );
                if (
                  capability.source.deployment !== parent.recipe.source.deployment ||
                  capability.snapshotBlock.number < parent.recipe.snapshotBlock.number
                ) {
                  return yield* error(
                    "source",
                    "Graph deployment or snapshot no longer matches the parent study",
                  );
                }
                const acquisition: ResearchAcquisitionRequest = {
                  environmentId: parent.environmentId,
                  threadId: parent.threadId,
                  source: parent.recipe.source,
                  snapshotBlock: parent.recipe.snapshotBlock,
                  entityKind: "swaps",
                  from: window.from,
                  to: window.to,
                };
                const datasetId = researchDatasetIdentity(acquisition);
                const datasetJobId = `graph-${datasetId}`;
                let datasetJob = yield* datasets.create({
                  ...acquisition,
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
                if (
                  progress.requestCount > caps.requests ||
                  progress.rowCount > caps.rows ||
                  progress.storedBytes > caps.bytes
                ) {
                  return yield* error("budget", "Long simulation acquisition budget reached");
                }
                datasetIds.add(datasetId);
                coverage.push(window);
                let cursor: string | undefined;
                while (true) {
                  const page = yield* datasets.readWindow({
                    datasetId,
                    from: window.from,
                    to: window.to,
                    resolution: "swaps",
                    ...(cursor === undefined ? {} : { cursor }),
                  });
                  if (page.manifest.status !== "complete")
                    return yield* error(
                      "conflict",
                      "Long simulation encountered an incomplete dataset",
                    );
                  for (const row of page.rows) {
                    if (!Schema.is(ResearchPriceSample)(row))
                      return yield* error("storage", "Swap dataset contains an incompatible row");
                    const previous = samples.get(row.id);
                    if (previous && (previous.at !== row.at || previous.price !== row.price))
                      return yield* error("conflict", "Price sample changed across saved windows");
                    samples.set(row.id, row);
                  }
                  if (page.nextCursor === null) break;
                  cursor = page.nextCursor;
                }
              }
            }
            const priceSamples = [...samples.values()].sort(
              (a, b) => a.at - b.at || a.id.localeCompare(b.id),
            );
            const report = simulateEventLongs({
              parentStudy: { ...parent, priceSamples },
              scenario: request.scenario,
            });
            const createdAt = yield* Clock.currentTimeMillis;
            const simulation: SavedEventLongSimulation = {
              simulationId: simulationIdentity(parent.reportHash, request),
              environmentId: parent.environmentId,
              threadId: parent.threadId,
              parentStudyId: parent.studyId,
              parentReportHash: parent.reportHash,
              parentReportVersion: parent.report.version,
              datasetIds: [...datasetIds],
              scenario: request.scenario,
              report,
              reportHash: NodeCrypto.createHash("sha256")
                .update(encodeReport(report))
                .digest("hex"),
              priceSamples,
              createdAt,
            };
            return yield* studies.completeSimulation({
              jobId,
              ownerToken,
              simulation,
              now: createdAt,
            });
          }),
        );
        if (result._tag === "Success") return result.success;
        const at = yield* Clock.currentTimeMillis;
        return yield* studies.failJob(
          jobId,
          ownerToken,
          at,
          `${result.failure.reason}: ${result.failure.detail}`,
          result.failure.reason === "budget",
        );
      });

    const drain: EventLongSimulationServiceShape["drain"] = () =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const jobs = yield* studies.listSimulationRunnable(now, 100);
        return yield* Effect.forEach(jobs, run, { concurrency: 2 });
      });

    const start: EventLongSimulationServiceShape["start"] = (request) =>
      Effect.gen(function* () {
        if (!Schema.is(EventLongSimulationRequest)(request) || !request.parentStudyId) {
          return yield* error("invalid_request", "Long simulation request is invalid");
        }
        const parent = yield* studies.readStudy(request.parentStudyId);
        const now = yield* Clock.currentTimeMillis;
        const simulationId = simulationIdentity(parent.reportHash, request);
        const jobId = `long-simulation-${simulationId}`;
        const view: ResearchJobView = {
          jobId,
          datasetId: parent.datasetIds[0] ?? "",
          environmentId: parent.environmentId,
          threadId: parent.threadId,
          source: parent.recipe.source,
          snapshotBlock: parent.recipe.snapshotBlock,
          entityKind: "swaps",
          from: 0,
          to: 1,
          status: "queued",
          rowCount: 0,
          requestCount: 0,
          storedBytes: 0,
          cursor: null,
          updatedAt: now,
          resultKind: "long_simulation",
        };
        const job = yield* studies.createSimulationJob({ jobId, simulationId, request, view });
        if (autoStart && job.status === "queued") {
          yield* run(jobId).pipe(
            Effect.catch((failure) =>
              Effect.logError("Long simulation worker stopped", { reason: failure.reason }),
            ),
            Effect.forkDetach,
          );
        }
        return job;
      });
    if (autoStart) {
      yield* drain().pipe(
        Effect.catch((failure) =>
          Effect.logError("Queued long simulations could not resume", { reason: failure.reason }),
        ),
        Effect.forkDetach,
      );
    }
    return { start, run, drain } satisfies EventLongSimulationServiceShape;
  });

export const EventLongSimulationServiceLive = (
  options: { readonly autoStart?: boolean } = {},
): Layer.Layer<
  EventLongSimulationService,
  never,
  ResearchStudyStore | ResearchDatasetStore | ResearchAcquisitionWorker | GraphHistoricalData
> => Layer.effect(EventLongSimulationService, makeEventLongSimulationService(options));
