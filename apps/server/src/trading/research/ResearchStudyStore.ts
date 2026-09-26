import * as NodeCrypto from "node:crypto";
import { Context, Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  EventResearchRecipe,
  EventResearchReport,
  SavedEventStudy,
} from "@t3tools/trading-contracts/eventResearch";
import { ResearchError, ResearchJobView } from "@t3tools/trading-contracts/researchData";

interface StudyJobRow {
  readonly job_id: string;
  readonly result_id: string;
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
}

export class ResearchStudyStore extends Context.Service<
  ResearchStudyStore,
  ResearchStudyStoreShape
>()("t3/trading/research/ResearchStudyStore") {}

const recipeJson = Schema.fromJsonString(EventResearchRecipe);
const viewJson = Schema.fromJsonString(ResearchJobView);
const studyJson = Schema.fromJsonString(SavedEventStudy);
const reportJson = Schema.fromJsonString(EventResearchReport);
const encodeRecipe = Schema.encodeSync(recipeJson);
const decodeRecipe = Schema.decodeUnknownSync(recipeJson);
const encodeView = Schema.encodeSync(viewJson);
const decodeView = Schema.decodeUnknownSync(viewJson);
const encodeStudy = Schema.encodeSync(studyJson);
const decodeStudy = Schema.decodeUnknownSync(studyJson);
const encodeReport = Schema.encodeSync(reportJson);

function reportHash(report: EventResearchReport): string {
  return NodeCrypto.createHash("sha256").update(encodeReport(report)).digest("hex");
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
    SELECT job_id, result_id, environment_id, thread_id, recipe_json, view_json,
      status, owner_token, lease_until
    FROM graph_research_result_jobs WHERE job_id = ${jobId} AND kind = 'event_study'
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
        ) ON CONFLICT(result_id) DO NOTHING
      `.pipe(Effect.mapError(storageError));
      const row = (yield* findJob(input.jobId).pipe(Effect.mapError(storageError)))[0];
      if (
        !row ||
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
      if (!row) return yield* error("not_found", "Research study job was not found");
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
      if (!row) return yield* error("not_found", "Research study job was not found");
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
          if (!row) return yield* error("not_found", "Research study job was not found");
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
            input.study.report.inventoryId !== input.study.recipe.eventInventory.id
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
  } satisfies ResearchStudyStoreShape;
});

export const ResearchStudyStoreLive: Layer.Layer<ResearchStudyStore, never, SqlClient.SqlClient> =
  Layer.effect(ResearchStudyStore, makeResearchStudyStore);
