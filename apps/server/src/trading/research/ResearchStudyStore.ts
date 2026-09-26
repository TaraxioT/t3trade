import * as NodeCrypto from "node:crypto";
import { Context, Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  EventResearchRecipe,
  EventResearchReport,
  SavedEventStudy,
  calculateEventResearch,
} from "@t3tools/trading-contracts/eventResearch";
import {
  EventLongSimulationReport,
  EventLongSimulationRequest,
  SavedEventLongSimulation,
  simulateEventLongs,
} from "@t3tools/trading-contracts/eventLongSimulation";
import { ResearchError, ResearchJobView } from "@t3tools/trading-contracts/researchData";

interface StudyJobRow {
  readonly job_id: string;
  readonly result_id: string;
  readonly kind: "event_study" | "long_simulation";
  readonly environment_id: string;
  readonly thread_id: string;
  readonly recipe_json: string;
  readonly view_json: string;
  readonly status: ResearchJobView["status"];
  readonly owner_token: string | null;
  readonly lease_until: number | null;
}

interface StudyRow {
  readonly payload_json: string;
  readonly report_hash: string;
}

export interface ResearchStudyStoreShape {
  readonly createJob: (input: {
    readonly jobId: string;
    readonly studyId: string;
    readonly recipe: EventResearchRecipe;
    readonly view: ResearchJobView;
  }) => Effect.Effect<ResearchJobView, ResearchError>;
  readonly getJob: (jobId: string) => Effect.Effect<ResearchJobView, ResearchError>;
  readonly getRecipe: (jobId: string) => Effect.Effect<EventResearchRecipe, ResearchError>;
  readonly listRunnable: (
    now: number,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<string>, ResearchError>;
  readonly claimJob: (
    jobId: string,
    ownerToken: string,
    now: number,
    leaseMs: number,
  ) => Effect.Effect<ResearchJobView | null, ResearchError>;
  readonly renewJob: (
    jobId: string,
    ownerToken: string,
    now: number,
    leaseMs: number,
  ) => Effect.Effect<void, ResearchError>;
  readonly recordProgress: (
    jobId: string,
    ownerToken: string,
    datasetJob: ResearchJobView,
    now: number,
  ) => Effect.Effect<ResearchJobView, ResearchError>;
  readonly failJob: (
    jobId: string,
    ownerToken: string,
    now: number,
    reason: string,
    paused: boolean,
  ) => Effect.Effect<ResearchJobView, ResearchError>;
  readonly completeStudy: (input: {
    readonly jobId: string;
    readonly ownerToken: string;
    readonly study: SavedEventStudy;
    readonly now: number;
  }) => Effect.Effect<ResearchJobView, ResearchError>;
  readonly readStudy: (studyId: string) => Effect.Effect<SavedEventStudy, ResearchError>;
  readonly createSimulationJob: (input: {
    readonly jobId: string;
    readonly simulationId: string;
    readonly request: EventLongSimulationRequest;
    readonly view: ResearchJobView;
  }) => Effect.Effect<ResearchJobView, ResearchError>;
  readonly getSimulationRequest: (
    jobId: string,
  ) => Effect.Effect<EventLongSimulationRequest, ResearchError>;
  readonly listSimulationRunnable: (
    now: number,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<string>, ResearchError>;
  readonly claimSimulationJob: (
    jobId: string,
    ownerToken: string,
    now: number,
    leaseMs: number,
  ) => Effect.Effect<ResearchJobView | null, ResearchError>;
  readonly completeSimulation: (input: {
    readonly jobId: string;
    readonly ownerToken: string;
    readonly simulation: SavedEventLongSimulation;
    readonly now: number;
  }) => Effect.Effect<ResearchJobView, ResearchError>;
  readonly readSimulation: (
    simulationId: string,
  ) => Effect.Effect<SavedEventLongSimulation, ResearchError>;
}

export class ResearchStudyStore extends Context.Service<
  ResearchStudyStore,
  ResearchStudyStoreShape
>()("t3/trading/research/ResearchStudyStore") {}

const recipeJson = Schema.fromJsonString(EventResearchRecipe);
const viewJson = Schema.fromJsonString(ResearchJobView);
const studyJson = Schema.fromJsonString(SavedEventStudy);
const reportJson = Schema.fromJsonString(EventResearchReport);
const simulationRequestJson = Schema.fromJsonString(EventLongSimulationRequest);
const simulationJson = Schema.fromJsonString(SavedEventLongSimulation);
const simulationReportJson = Schema.fromJsonString(EventLongSimulationReport);
const encodeRecipe = Schema.encodeSync(recipeJson);
const decodeRecipe = Schema.decodeUnknownSync(recipeJson);
const encodeView = Schema.encodeSync(viewJson);
const decodeView = Schema.decodeUnknownSync(viewJson);
const encodeStudy = Schema.encodeSync(studyJson);
const decodeStudy = Schema.decodeUnknownSync(studyJson);
const encodeReport = Schema.encodeSync(reportJson);
const encodeSimulationRequest = Schema.encodeSync(simulationRequestJson);
const decodeSimulationRequest = Schema.decodeUnknownSync(simulationRequestJson);
const encodeSimulation = Schema.encodeSync(simulationJson);
const decodeSimulation = Schema.decodeUnknownSync(simulationJson);
const encodeSimulationReport = Schema.encodeSync(simulationReportJson);

function reportHash(report: EventResearchReport): string {
  return NodeCrypto.createHash("sha256").update(encodeReport(report)).digest("hex");
}

function simulationReportHash(report: EventLongSimulationReport): string {
  return NodeCrypto.createHash("sha256").update(encodeSimulationReport(report)).digest("hex");
}

function matchesStudyEvidence(study: SavedEventStudy): boolean {
  try {
    const calculated = calculateEventResearch({
      recipe: study.recipe,
      priceSamples: study.priceSamples,
    });
    return encodeReport(calculated) === encodeReport(study.report);
  } catch {
    return false;
  }
}

function matchesSimulationEvidence(
  simulation: SavedEventLongSimulation,
  parent: SavedEventStudy,
): boolean {
  const retained = new Map(simulation.priceSamples.map((sample) => [sample.id, sample]));
  if (
    parent.priceSamples.some((sample) => {
      const found = retained.get(sample.id);
      return !found || found.at !== sample.at || found.price !== sample.price;
    })
  )
    return false;
  try {
    const calculated = simulateEventLongs({
      parentStudy: { ...parent, priceSamples: simulation.priceSamples },
      scenario: simulation.scenario,
    });
    return encodeSimulationReport(calculated) === encodeSimulationReport(simulation.report);
  } catch {
    return false;
  }
}

function error(reason: ResearchError["reason"], detail: string): ResearchError {
  return new ResearchError({ reason, detail });
}

function storageError(): ResearchError {
  return error("storage", "Research study storage failed");
}

export const makeResearchStudyStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const findJob = (jobId: string) => sql<StudyJobRow>`
    SELECT job_id, result_id, kind, environment_id, thread_id, recipe_json, view_json,
      status, owner_token, lease_until
    FROM graph_research_result_jobs WHERE job_id = ${jobId}
  `;
  const getJob: ResearchStudyStoreShape["getJob"] = (jobId) =>
    Effect.gen(function* () {
      const row = (yield* findJob(jobId).pipe(Effect.mapError(storageError)))[0];
      if (!row) return yield* error("not_found", "Research study job was not found");
      return yield* Effect.try({ try: () => decodeView(row.view_json), catch: storageError });
    });
  const createJob: ResearchStudyStoreShape["createJob"] = (input) =>
    Effect.gen(function* () {
      if (
        !input.jobId ||
        !input.studyId ||
        !Schema.is(EventResearchRecipe)(input.recipe) ||
        !Schema.is(ResearchJobView)(input.view) ||
        input.view.jobId !== input.jobId ||
        input.view.environmentId !== input.recipe.environmentId ||
        input.view.threadId !== input.recipe.threadId
      ) {
        return yield* error("invalid_request", "Research study job is invalid");
      }
      const encodedRecipe = encodeRecipe(input.recipe);
      const encodedView = encodeView(input.view);
      yield* sql`
        INSERT INTO graph_research_result_jobs (
          job_id, result_id, kind, environment_id, thread_id, recipe_json, view_json, status, updated_at
        ) VALUES (
          ${input.jobId}, ${input.studyId}, 'event_study', ${input.recipe.environmentId},
          ${input.recipe.threadId}, ${encodedRecipe}, ${encodedView}, 'queued', ${input.view.updatedAt}
        ) ON CONFLICT DO NOTHING
      `.pipe(Effect.mapError(storageError));
      const row = (yield* findJob(input.jobId).pipe(Effect.mapError(storageError)))[0];
      if (
        !row ||
        row.kind !== "event_study" ||
        row.result_id !== input.studyId ||
        row.recipe_json !== encodedRecipe ||
        row.environment_id !== input.recipe.environmentId ||
        row.thread_id !== input.recipe.threadId
      ) {
        return yield* error("conflict", "Research study identity conflicts with an existing job");
      }
      return yield* getJob(input.jobId);
    });
  const getRecipe: ResearchStudyStoreShape["getRecipe"] = (jobId) =>
    Effect.gen(function* () {
      const row = (yield* findJob(jobId).pipe(Effect.mapError(storageError)))[0];
      if (!row || row.kind !== "event_study")
        return yield* error("not_found", "Research study job was not found");
      return yield* Effect.try({ try: () => decodeRecipe(row.recipe_json), catch: storageError });
    });
  const listRunnable: ResearchStudyStoreShape["listRunnable"] = (now, limit) =>
    sql<{ readonly job_id: string }>`
      SELECT job_id FROM graph_research_result_jobs
      WHERE kind = 'event_study' AND (status = 'queued' OR (status = 'running' AND lease_until < ${now}))
      ORDER BY updated_at ASC LIMIT ${limit}
    `.pipe(
      Effect.map((rows) => rows.map((row) => row.job_id)),
      Effect.mapError(storageError),
    );
  const claimJob: ResearchStudyStoreShape["claimJob"] = (jobId, ownerToken, now, leaseMs) =>
    Effect.gen(function* () {
      if (!ownerToken || !Number.isSafeInteger(leaseMs) || leaseMs <= 0)
        return yield* error("invalid_request", "Study job lease is invalid");
      const row = (yield* findJob(jobId).pipe(Effect.mapError(storageError)))[0];
      if (!row || row.kind !== "event_study")
        return yield* error("not_found", "Research study job was not found");
      const running = { ...decodeView(row.view_json), status: "running" as const, updatedAt: now };
      const claimed = yield* sql<{ readonly job_id: string }>`
        UPDATE graph_research_result_jobs SET status = 'running', owner_token = ${ownerToken},
          lease_until = ${now + leaseMs}, view_json = ${encodeView(running)}, updated_at = ${now}
        WHERE job_id = ${jobId} AND kind = 'event_study'
          AND (status = 'queued' OR (status = 'running' AND lease_until < ${now}))
        RETURNING job_id
      `.pipe(Effect.mapError(storageError));
      return claimed.length === 0 ? null : running;
    });
  const renewJob: ResearchStudyStoreShape["renewJob"] = (jobId, ownerToken, now, leaseMs) =>
    Effect.gen(function* () {
      const updated = yield* sql<{ readonly job_id: string }>`
        UPDATE graph_research_result_jobs SET lease_until = ${now + leaseMs}, updated_at = ${now}
        WHERE job_id = ${jobId} AND owner_token = ${ownerToken} AND status = 'running'
        RETURNING job_id
      `.pipe(Effect.mapError(storageError));
      if (updated.length !== 1)
        return yield* error("conflict", "Study worker no longer owns the job");
    });
  const recordProgress: ResearchStudyStoreShape["recordProgress"] = (
    jobId,
    ownerToken,
    datasetJob,
    now,
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const row = (yield* findJob(jobId))[0];
          if (!row || row.status !== "running" || row.owner_token !== ownerToken) {
            return yield* error("conflict", "Study worker does not own this job");
          }
          const dataset = (yield* sql<{
            readonly environment_id: string;
            readonly thread_id: string;
            readonly status: string;
          }>`
        SELECT d.environment_id, j.thread_id, d.status FROM graph_research_datasets d
        JOIN graph_research_jobs j ON j.dataset_id = d.dataset_id
        WHERE d.dataset_id = ${datasetJob.datasetId}
      `)[0];
          if (
            !dataset ||
            dataset.status !== "complete" ||
            dataset.environment_id !== row.environment_id ||
            dataset.thread_id !== row.thread_id ||
            datasetJob.status !== "complete"
          ) {
            return yield* error("conflict", "Study progress references an incompatible dataset");
          }
          yield* sql`
        INSERT INTO graph_research_result_job_datasets (
          job_id, dataset_id, row_count, request_count, stored_bytes
        ) VALUES (
          ${jobId}, ${datasetJob.datasetId}, ${datasetJob.rowCount},
          ${datasetJob.requestCount}, ${datasetJob.storedBytes}
        ) ON CONFLICT(job_id, dataset_id) DO UPDATE SET
          row_count = excluded.row_count,
          request_count = excluded.request_count,
          stored_bytes = excluded.stored_bytes
      `;
          const totals = (yield* sql<{
            readonly completed_windows: number;
            readonly row_count: number;
            readonly request_count: number;
            readonly stored_bytes: number;
          }>`
        SELECT COUNT(*) AS completed_windows, COALESCE(SUM(row_count), 0) AS row_count,
          COALESCE(SUM(request_count), 0) AS request_count,
          COALESCE(SUM(stored_bytes), 0) AS stored_bytes
        FROM graph_research_result_job_datasets WHERE job_id = ${jobId}
      `)[0]!;
          const view = {
            ...decodeView(row.view_json),
            completedWindows: totals.completed_windows,
            rowCount: totals.row_count,
            requestCount: totals.request_count,
            storedBytes: totals.stored_bytes,
            updatedAt: now,
          };
          yield* sql`
        UPDATE graph_research_result_jobs SET view_json = ${encodeView(view)}, updated_at = ${now}
        WHERE job_id = ${jobId} AND owner_token = ${ownerToken} AND status = 'running'
      `;
          return view;
        }),
      )
      .pipe(Effect.mapError((cause) => (Schema.is(ResearchError)(cause) ? cause : storageError())));
  const failJob: ResearchStudyStoreShape["failJob"] = (jobId, ownerToken, now, reason, paused) =>
    Effect.gen(function* () {
      const current = yield* getJob(jobId);
      const status = paused ? ("paused" as const) : ("failed" as const);
      const view = { ...current, status, failureReason: reason, updatedAt: now };
      const updated = yield* sql<{ readonly job_id: string }>`
        UPDATE graph_research_result_jobs SET status = ${status}, view_json = ${encodeView(view)},
          owner_token = NULL, lease_until = NULL, updated_at = ${now}
        WHERE job_id = ${jobId} AND owner_token = ${ownerToken} AND status = 'running'
        RETURNING job_id
      `.pipe(Effect.mapError(storageError));
      if (updated.length !== 1)
        return yield* error("conflict", "Study worker no longer owns the job");
      return view;
    });
  const readStudy: ResearchStudyStoreShape["readStudy"] = (studyId) =>
    Effect.gen(function* () {
      const row = (yield* sql<StudyRow>`
        SELECT payload_json, report_hash FROM graph_research_results
        WHERE result_id = ${studyId} AND kind = 'event_study'
      `.pipe(Effect.mapError(storageError)))[0];
      if (!row) return yield* error("not_found", "Saved event study was not found");
      return yield* Effect.try({
        try: () => {
          const study = decodeStudy(row.payload_json);
          if (
            study.reportHash !== row.report_hash ||
            reportHash(study.report) !== row.report_hash
          ) {
            throw storageError();
          }
          return study;
        },
        catch: storageError,
      });
    });
  const completeStudy: ResearchStudyStoreShape["completeStudy"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const row = (yield* findJob(input.jobId))[0];
          if (!row || row.kind !== "event_study")
            return yield* error("not_found", "Research study job was not found");
          if (
            row.result_id !== input.study.studyId ||
            row.environment_id !== input.study.environmentId ||
            row.thread_id !== input.study.threadId
          ) {
            return yield* error("conflict", "Saved study does not belong to this job");
          }
          if (
            !Schema.is(SavedEventStudy)(input.study) ||
            row.recipe_json !== encodeRecipe(input.study.recipe) ||
            input.study.reportHash !== reportHash(input.study.report) ||
            input.study.report.inventoryId !== input.study.recipe.eventInventory.id ||
            !matchesStudyEvidence(input.study)
          ) {
            return yield* error(
              "conflict",
              "Saved study report or recipe hash does not match its evidence",
            );
          }
          const existing = (yield* sql<StudyRow>`
        SELECT payload_json, report_hash FROM graph_research_results WHERE result_id = ${input.study.studyId}
      `)[0];
          const encoded = encodeStudy(input.study);
          if (
            existing &&
            (existing.report_hash !== input.study.reportHash || existing.payload_json !== encoded)
          ) {
            return yield* error("conflict", "Saved study ID already has different evidence");
          }
          if (row.status === "complete" && existing) return decodeView(row.view_json);
          if (row.status !== "running" || row.owner_token !== input.ownerToken)
            return yield* error("conflict", "Study worker does not own this job");
          const recorded = yield* sql<{ readonly dataset_id: string }>`
        SELECT dataset_id FROM graph_research_result_job_datasets WHERE job_id = ${input.jobId}
      `;
          if (
            recorded.length !== input.study.datasetIds.length ||
            recorded.some((item) => !input.study.datasetIds.includes(item.dataset_id))
          ) {
            return yield* error(
              "conflict",
              "Saved study dataset lineage does not match completed progress",
            );
          }
          for (const datasetId of input.study.datasetIds) {
            const dataset = yield* sql<{
              readonly status: string;
              readonly environment_id: string;
            }>`
          SELECT status, environment_id FROM graph_research_datasets WHERE dataset_id = ${datasetId}
        `;
            if (
              dataset[0]?.status !== "complete" ||
              dataset[0]?.environment_id !== row.environment_id
            )
              return yield* error(
                "conflict",
                "Saved study references an incomplete or foreign dataset",
              );
          }
          yield* sql`
        INSERT INTO graph_research_results (
          result_id, kind, environment_id, thread_id, payload_json, report_hash, created_at
        ) VALUES (
          ${input.study.studyId}, 'event_study', ${input.study.environmentId}, ${input.study.threadId},
          ${encoded}, ${input.study.reportHash}, ${input.study.createdAt}
        ) ON CONFLICT(result_id) DO NOTHING
      `;
          for (const datasetId of input.study.datasetIds) {
            yield* sql`
          INSERT INTO graph_research_result_datasets (result_id, dataset_id)
          VALUES (${input.study.studyId}, ${datasetId}) ON CONFLICT DO NOTHING
        `;
          }
          const view = {
            ...decodeView(row.view_json),
            status: "complete" as const,
            studyId: input.study.studyId,
            updatedAt: input.now,
          };
          yield* sql`
        UPDATE graph_research_result_jobs SET status = 'complete', view_json = ${encodeView(view)},
          owner_token = NULL, lease_until = NULL, updated_at = ${input.now}
        WHERE job_id = ${input.jobId}
      `;
          return view;
        }),
      )
      .pipe(Effect.mapError((cause) => (Schema.is(ResearchError)(cause) ? cause : storageError())));
  const createSimulationJob: ResearchStudyStoreShape["createSimulationJob"] = (input) =>
    Effect.gen(function* () {
      if (
        !input.jobId ||
        !input.simulationId ||
        !Schema.is(EventLongSimulationRequest)(input.request) ||
        !Schema.is(ResearchJobView)(input.view) ||
        input.view.jobId !== input.jobId
      ) {
        return yield* error("invalid_request", "Long simulation job is invalid");
      }
      const parent = yield* readStudy(input.request.parentStudyId);
      if (
        input.view.environmentId !== parent.environmentId ||
        input.view.threadId !== parent.threadId ||
        input.view.source.deployment !== parent.recipe.source.deployment
      ) {
        return yield* error("conflict", "Long simulation job is outside its parent study");
      }
      const encodedRequest = encodeSimulationRequest(input.request);
      yield* sql`
        INSERT INTO graph_research_result_jobs (
          job_id, result_id, kind, environment_id, thread_id, recipe_json, view_json, status, updated_at
        ) VALUES (
          ${input.jobId}, ${input.simulationId}, 'long_simulation', ${parent.environmentId},
          ${parent.threadId}, ${encodedRequest}, ${encodeView(input.view)}, 'queued', ${input.view.updatedAt}
        ) ON CONFLICT DO NOTHING
      `.pipe(Effect.mapError(storageError));
      const row = (yield* findJob(input.jobId).pipe(Effect.mapError(storageError)))[0];
      if (
        !row ||
        row.kind !== "long_simulation" ||
        row.result_id !== input.simulationId ||
        row.recipe_json !== encodedRequest ||
        row.environment_id !== parent.environmentId ||
        row.thread_id !== parent.threadId
      ) {
        return yield* error("conflict", "Long simulation identity conflicts with an existing job");
      }
      return yield* getJob(input.jobId);
    });
  const getSimulationRequest: ResearchStudyStoreShape["getSimulationRequest"] = (jobId) =>
    Effect.gen(function* () {
      const row = (yield* findJob(jobId).pipe(Effect.mapError(storageError)))[0];
      if (!row || row.kind !== "long_simulation")
        return yield* error("not_found", "Long simulation job was not found");
      return yield* Effect.try({
        try: () => decodeSimulationRequest(row.recipe_json),
        catch: storageError,
      });
    });
  const listSimulationRunnable: ResearchStudyStoreShape["listSimulationRunnable"] = (now, limit) =>
    sql<{ readonly job_id: string }>`
      SELECT job_id FROM graph_research_result_jobs
      WHERE kind = 'long_simulation' AND (status = 'queued' OR (status = 'running' AND lease_until < ${now}))
      ORDER BY updated_at ASC LIMIT ${limit}
    `.pipe(
      Effect.map((rows) => rows.map((row) => row.job_id)),
      Effect.mapError(storageError),
    );
  const claimSimulationJob: ResearchStudyStoreShape["claimSimulationJob"] = (
    jobId,
    ownerToken,
    now,
    leaseMs,
  ) =>
    Effect.gen(function* () {
      if (!ownerToken || !Number.isSafeInteger(leaseMs) || leaseMs <= 0)
        return yield* error("invalid_request", "Long simulation lease is invalid");
      const row = (yield* findJob(jobId).pipe(Effect.mapError(storageError)))[0];
      if (!row || row.kind !== "long_simulation")
        return yield* error("not_found", "Long simulation job was not found");
      const running = { ...decodeView(row.view_json), status: "running" as const, updatedAt: now };
      const claimed = yield* sql<{ readonly job_id: string }>`
        UPDATE graph_research_result_jobs SET status = 'running', owner_token = ${ownerToken},
          lease_until = ${now + leaseMs}, view_json = ${encodeView(running)}, updated_at = ${now}
        WHERE job_id = ${jobId} AND kind = 'long_simulation'
          AND (status = 'queued' OR (status = 'running' AND lease_until < ${now}))
        RETURNING job_id
      `.pipe(Effect.mapError(storageError));
      return claimed.length === 0 ? null : running;
    });
  const readSimulation: ResearchStudyStoreShape["readSimulation"] = (simulationId) =>
    Effect.gen(function* () {
      const row = (yield* sql<StudyRow>`
        SELECT payload_json, report_hash FROM graph_research_results
        WHERE result_id = ${simulationId} AND kind = 'long_simulation'
      `.pipe(Effect.mapError(storageError)))[0];
      if (!row) return yield* error("not_found", "Saved long simulation was not found");
      return yield* Effect.try({
        try: () => {
          const simulation = decodeSimulation(row.payload_json);
          if (
            simulation.reportHash !== row.report_hash ||
            simulationReportHash(simulation.report) !== row.report_hash
          )
            throw storageError();
          return simulation;
        },
        catch: storageError,
      });
    });
  const completeSimulation: ResearchStudyStoreShape["completeSimulation"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const row = (yield* findJob(input.jobId))[0];
          if (!row || row.kind !== "long_simulation")
            return yield* error("not_found", "Long simulation job was not found");
          const simulation = input.simulation;
          if (
            !Schema.is(SavedEventLongSimulation)(simulation) ||
            row.result_id !== simulation.simulationId ||
            row.environment_id !== simulation.environmentId ||
            row.thread_id !== simulation.threadId ||
            row.recipe_json !==
              encodeSimulationRequest({
                parentStudyId: simulation.parentStudyId,
                scenario: simulation.scenario,
              }) ||
            simulation.reportHash !== simulationReportHash(simulation.report) ||
            simulation.report.parentStudyId !== simulation.parentStudyId ||
            simulation.report.parentReportHash !== simulation.parentReportHash
          ) {
            return yield* error(
              "conflict",
              "Long simulation does not match its saved job and report",
            );
          }
          const parent = yield* readStudy(simulation.parentStudyId);
          if (
            parent.environmentId !== simulation.environmentId ||
            parent.threadId !== simulation.threadId ||
            parent.reportHash !== simulation.parentReportHash ||
            parent.report.version !== simulation.parentReportVersion
          ) {
            return yield* error("conflict", "Long simulation parent lineage changed");
          }
          if (!matchesSimulationEvidence(simulation, parent)) {
            return yield* error(
              "conflict",
              "Long simulation report does not match retained price samples",
            );
          }
          const recorded = yield* sql<{ readonly dataset_id: string }>`
        SELECT dataset_id FROM graph_research_result_job_datasets WHERE job_id = ${input.jobId}
      `;
          const expected = new Set([
            ...parent.datasetIds,
            ...recorded.map((item) => item.dataset_id),
          ]);
          if (
            expected.size !== simulation.datasetIds.length ||
            simulation.datasetIds.some((datasetId) => !expected.has(datasetId))
          ) {
            return yield* error("conflict", "Long simulation dataset lineage is incomplete");
          }
          for (const datasetId of simulation.datasetIds) {
            const dataset = (yield* sql<{
              readonly status: string;
              readonly environment_id: string;
            }>`
          SELECT status, environment_id FROM graph_research_datasets WHERE dataset_id = ${datasetId}
        `)[0];
            if (dataset?.status !== "complete" || dataset.environment_id !== row.environment_id) {
              return yield* error(
                "conflict",
                "Long simulation references an incomplete or foreign dataset",
              );
            }
          }
          const encoded = encodeSimulation(simulation);
          const existing = (yield* sql<StudyRow>`
        SELECT payload_json, report_hash FROM graph_research_results WHERE result_id = ${simulation.simulationId}
      `)[0];
          if (
            existing &&
            (existing.payload_json !== encoded || existing.report_hash !== simulation.reportHash)
          ) {
            return yield* error("conflict", "Long simulation ID already has different evidence");
          }
          if (row.status === "complete" && existing) return decodeView(row.view_json);
          if (row.status !== "running" || row.owner_token !== input.ownerToken)
            return yield* error("conflict", "Long simulation worker does not own this job");
          yield* sql`
        INSERT INTO graph_research_results (
          result_id, kind, environment_id, thread_id, parent_id, payload_json, report_hash, created_at
        ) VALUES (
          ${simulation.simulationId}, 'long_simulation', ${simulation.environmentId},
          ${simulation.threadId}, ${simulation.parentStudyId}, ${encoded}, ${simulation.reportHash}, ${simulation.createdAt}
        ) ON CONFLICT(result_id) DO NOTHING
      `;
          for (const datasetId of simulation.datasetIds) {
            yield* sql`
          INSERT INTO graph_research_result_datasets (result_id, dataset_id)
          VALUES (${simulation.simulationId}, ${datasetId}) ON CONFLICT DO NOTHING
        `;
          }
          const view = {
            ...decodeView(row.view_json),
            status: "complete" as const,
            simulationId: simulation.simulationId,
            updatedAt: input.now,
          };
          yield* sql`
        UPDATE graph_research_result_jobs SET status = 'complete', view_json = ${encodeView(view)},
          owner_token = NULL, lease_until = NULL, updated_at = ${input.now}
        WHERE job_id = ${input.jobId}
      `;
          return view;
        }),
      )
      .pipe(Effect.mapError((cause) => (Schema.is(ResearchError)(cause) ? cause : storageError())));
  return {
    createJob,
    getJob,
    getRecipe,
    listRunnable,
    claimJob,
    renewJob,
    recordProgress,
    failJob,
    completeStudy,
    readStudy,
    createSimulationJob,
    getSimulationRequest,
    listSimulationRunnable,
    claimSimulationJob,
    completeSimulation,
    readSimulation,
  } satisfies ResearchStudyStoreShape;
});

export const ResearchStudyStoreLive: Layer.Layer<ResearchStudyStore, never, SqlClient.SqlClient> =
  Layer.effect(ResearchStudyStore, makeResearchStudyStore);
