import { Context, Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  GraphSourceRef,
  ResearchCandle,
  ResearchError,
  ResearchPriceSample,
  type GraphEntityKind,
  type GraphSnapshotBlock,
  type GraphWindowPage,
  type ResearchDatasetManifest,
  type ResearchDatasetWindow,
  type ResearchJobView,
} from "@t3tools/trading-contracts/researchData";

interface DatasetRow {
  readonly dataset_id: string;
  readonly environment_id: string;
  readonly source_json: string;
  readonly snapshot_block_number: number;
  readonly snapshot_block_hash: string;
  readonly entity_kind: GraphEntityKind;
  readonly from_ms: number;
  readonly to_ms: number;
  readonly status: "incomplete" | "complete";
  readonly row_count: number;
  readonly stored_bytes: number;
  readonly request_count: number;
  readonly cursor: string | null;
  readonly completed_at: number | null;
}

interface JobRow extends DatasetRow {
  readonly job_id: string;
  readonly thread_id: string;
  readonly job_status: ResearchJobView["status"];
  readonly owner_token: string | null;
  readonly lease_until: number | null;
  readonly cap_requests: number;
  readonly cap_rows: number;
  readonly cap_bytes: number;
  readonly failure_reason: string | null;
  readonly updated_at: number;
}

export interface ResearchDatasetCreate {
  readonly datasetId: string;
  readonly jobId: string;
  readonly environmentId: string;
  readonly threadId: string;
  readonly source: GraphSourceRef;
  readonly snapshotBlock: GraphSnapshotBlock;
  readonly entityKind: GraphEntityKind;
  readonly from: number;
  readonly to: number;
  readonly caps: { readonly requests: number; readonly rows: number; readonly bytes: number };
  readonly now: number;
}

export interface ResearchDatasetStoreShape {
  readonly create: (input: ResearchDatasetCreate) => Effect.Effect<ResearchJobView, ResearchError>;
  readonly getJob: (jobId: string) => Effect.Effect<ResearchJobView, ResearchError>;
  readonly claim: (
    jobId: string,
    ownerToken: string,
    now: number,
    leaseMs: number,
  ) => Effect.Effect<ResearchJobView | null, ResearchError>;
  readonly appendPage: (input: {
    readonly jobId: string;
    readonly ownerToken: string;
    readonly page: GraphWindowPage;
    readonly now: number;
  }) => Effect.Effect<ResearchJobView, ResearchError>;
  readonly recordFailure: (input: {
    readonly jobId: string;
    readonly ownerToken: string;
    readonly now: number;
    readonly reason: string;
    readonly terminal: boolean;
  }) => Effect.Effect<ResearchJobView, ResearchError>;
  readonly listRunnable: (
    now: number,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<string>, ResearchError>;
  readonly cancel: (jobId: string, now: number) => Effect.Effect<ResearchJobView, ResearchError>;
  readonly resume: (
    jobId: string,
    now: number,
    caps?: { readonly requests: number; readonly rows: number; readonly bytes: number },
  ) => Effect.Effect<ResearchJobView, ResearchError>;
  readonly readWindow: (input: {
    readonly datasetId: string;
    readonly from: number;
    readonly to: number;
    readonly resolution: GraphEntityKind;
    readonly cursor?: string;
    readonly limit?: number;
  }) => Effect.Effect<ResearchDatasetWindow, ResearchError>;
}

export class ResearchDatasetStore extends Context.Service<
  ResearchDatasetStore,
  ResearchDatasetStoreShape
>()("t3/trading/research/ResearchDatasetStore") {}

const sourceJson = Schema.fromJsonString(GraphSourceRef);
const rowJson = Schema.fromJsonString(Schema.Union([ResearchPriceSample, ResearchCandle]));
const encodeSource = Schema.encodeSync(sourceJson);
const decodeSource = Schema.decodeUnknownSync(sourceJson);
const encodeRow = Schema.encodeSync(rowJson);
const decodeRow = Schema.decodeUnknownSync(rowJson);

function error(reason: ResearchError["reason"], detail: string): ResearchError {
  return new ResearchError({ reason, detail });
}

function validPositiveInt(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function jobView(row: JobRow): ResearchJobView {
  return {
    jobId: row.job_id,
    datasetId: row.dataset_id,
    environmentId: row.environment_id,
    threadId: row.thread_id,
    source: decodeSource(row.source_json),
    snapshotBlock: { number: row.snapshot_block_number, hash: row.snapshot_block_hash },
    entityKind: row.entity_kind,
    from: row.from_ms,
    to: row.to_ms,
    status: row.job_status,
    rowCount: row.row_count,
    requestCount: row.request_count,
    storedBytes: row.stored_bytes,
    cursor: row.cursor,
    updatedAt: row.updated_at,
    ...(row.failure_reason === null ? {} : { failureReason: row.failure_reason }),
  };
}

function manifest(row: DatasetRow): ResearchDatasetManifest {
  const base = {
    datasetId: row.dataset_id,
    source: decodeSource(row.source_json),
    snapshotBlock: { number: row.snapshot_block_number, hash: row.snapshot_block_hash },
    entityKind: row.entity_kind,
    from: row.from_ms,
    to: row.to_ms,
    rowCount: row.row_count,
  };
  return row.status === "complete" && row.completed_at !== null
    ? { ...base, status: "complete", completedAt: row.completed_at }
    : { ...base, status: "incomplete" };
}

function cursorParts(
  cursor: string | undefined,
): { readonly at: number; readonly id: string } | null {
  if (cursor === undefined) return { at: 0, id: "" };
  const split = cursor.indexOf(":");
  if (split < 1) return null;
  const at = Number(cursor.slice(0, split));
  if (!Number.isSafeInteger(at) || at < 0) return null;
  try {
    return { at, id: decodeURIComponent(cursor.slice(split + 1)) };
  } catch {
    return null;
  }
}

export const makeResearchDatasetStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const storageError = () => error("storage", "Research dataset storage failed");

  const findJob = (jobId: string) =>
    sql<JobRow>`
    SELECT d.*, j.job_id, j.thread_id, j.status AS job_status,
      j.owner_token, j.lease_until, j.cap_requests, j.cap_rows, j.cap_bytes,
      j.failure_reason, j.updated_at
    FROM graph_research_jobs j
    JOIN graph_research_datasets d ON d.dataset_id = j.dataset_id
    WHERE j.job_id = ${jobId}
  `.pipe(Effect.mapError(storageError));

  const getJob: ResearchDatasetStoreShape["getJob"] = (jobId) =>
    Effect.gen(function* () {
      const rows = yield* findJob(jobId);
      if (!rows[0]) return yield* error("not_found", "Research job was not found");
      return yield* Effect.try({ try: () => jobView(rows[0]!), catch: storageError });
    });

  const create: ResearchDatasetStoreShape["create"] = (input) =>
    Effect.gen(function* () {
      if (
        !input.datasetId ||
        !input.jobId ||
        !input.environmentId ||
        !input.threadId ||
        !Number.isSafeInteger(input.from) ||
        !Number.isSafeInteger(input.to) ||
        input.from < 0 ||
        input.to <= input.from ||
        !validPositiveInt(input.caps.requests) ||
        !validPositiveInt(input.caps.rows) ||
        !validPositiveInt(input.caps.bytes)
      ) {
        return yield* error("invalid_request", "Research dataset request or budget is invalid");
      }
      const encodedSource = encodeSource(input.source);
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`
        INSERT INTO graph_research_datasets (
          dataset_id, environment_id, source_json, snapshot_block_number, snapshot_block_hash,
          entity_kind, from_ms, to_ms, status, created_at
        ) VALUES (
          ${input.datasetId}, ${input.environmentId}, ${encodedSource}, ${input.snapshotBlock.number},
          ${input.snapshotBlock.hash}, ${input.entityKind}, ${input.from}, ${input.to}, 'incomplete', ${input.now}
        ) ON CONFLICT(dataset_id) DO NOTHING
      `;
            yield* sql`
        INSERT INTO graph_research_jobs (
          job_id, dataset_id, thread_id, status, cap_requests, cap_rows, cap_bytes,
          created_at, updated_at
        ) VALUES (
          ${input.jobId}, ${input.datasetId}, ${input.threadId}, 'queued',
          ${input.caps.requests}, ${input.caps.rows}, ${input.caps.bytes}, ${input.now}, ${input.now}
        ) ON CONFLICT(dataset_id) DO NOTHING
      `;
          }),
        )
        .pipe(Effect.mapError(storageError));
      const rows = yield* findJob(input.jobId);
      const row = rows[0];
      if (
        !row ||
        row.dataset_id !== input.datasetId ||
        row.environment_id !== input.environmentId ||
        row.source_json !== encodedSource ||
        row.snapshot_block_number !== input.snapshotBlock.number ||
        row.snapshot_block_hash !== input.snapshotBlock.hash ||
        row.entity_kind !== input.entityKind ||
        row.from_ms !== input.from ||
        row.to_ms !== input.to
      ) {
        return yield* error("conflict", "Dataset identity conflicts with an existing request");
      }
      return yield* Effect.try({ try: () => jobView(row), catch: storageError });
    });

  const claim: ResearchDatasetStoreShape["claim"] = (jobId, ownerToken, now, leaseMs) =>
    Effect.gen(function* () {
      if (!ownerToken || !validPositiveInt(leaseMs))
        return yield* error("invalid_request", "Worker ownership is invalid");
      const claimed = yield* sql<{ readonly job_id: string }>`
      UPDATE graph_research_jobs
      SET status = 'running', owner_token = ${ownerToken}, lease_until = ${now + leaseMs}, updated_at = ${now}
      WHERE job_id = ${jobId}
        AND (status = 'queued' OR (status = 'running' AND lease_until < ${now}))
      RETURNING job_id
    `.pipe(Effect.mapError(storageError));
      return claimed.length === 0 ? null : yield* getJob(jobId);
    });

  const appendPage: ResearchDatasetStoreShape["appendPage"] = (input) =>
    Effect.gen(function* () {
      const { page } = input;
      const result = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const row = (yield* findJob(input.jobId))[0];
            if (!row) return yield* error("not_found", "Research job was not found");
            if (row.job_status !== "running" || row.owner_token !== input.ownerToken)
              return yield* error("conflict", "Worker does not own this running job");
            if (
              page.entityKind !== row.entity_kind ||
              page.progress.snapshotBlock.number !== row.snapshot_block_number ||
              page.progress.snapshotBlock.hash !== row.snapshot_block_hash
            ) {
              return yield* error("conflict", "Graph page has incompatible snapshot provenance");
            }
            if (
              page.rows.length > 1_000 ||
              page.rows.length !== page.progress.rowsReturned ||
              page.progress.hasMore !== (page.nextCursor !== null)
            ) {
              return yield* error("invalid_request", "Graph page progress is inconsistent");
            }
            const encoded = page.rows.map((item) => ({ item, json: encodeRow(item) }));
            const replay = page.nextCursor !== null && row.cursor === page.nextCursor;
            if (page.nextCursor !== null && row.cursor !== null && page.nextCursor <= row.cursor) {
              if (!replay) return yield* error("conflict", "Graph page cursor did not advance");
            }
            const bytes = encoded.reduce((sum, entry) => sum + Buffer.byteLength(entry.json), 0);
            if (
              !replay &&
              (row.request_count >= row.cap_requests ||
                row.row_count + encoded.length > row.cap_rows ||
                row.stored_bytes + bytes > row.cap_bytes)
            ) {
              yield* sql`
          UPDATE graph_research_jobs SET status = 'paused', owner_token = NULL,
            lease_until = NULL, failure_reason = 'configured acquisition budget reached', updated_at = ${input.now}
          WHERE job_id = ${input.jobId}
        `;
              return yield* getJob(input.jobId);
            }
            for (const entry of encoded) {
              const at = "at" in entry.item ? entry.item.at : entry.item.from;
              if (at < row.from_ms || at >= row.to_ms)
                return yield* error(
                  "invalid_request",
                  "Graph page contains a row outside its dataset window",
                );
              const existing = yield* sql<{ readonly payload_json: string }>`
          SELECT payload_json FROM graph_research_rows
          WHERE dataset_id = ${row.dataset_id} AND entity_id = ${entry.item.id}
        `;
              if (existing[0] && existing[0].payload_json !== entry.json) {
                return yield* error("conflict", "Graph entity changed within the same snapshot");
              }
              if (replay && !existing[0])
                return yield* error("conflict", "Replayed Graph page has new entities");
              if (existing[0]) continue;
              yield* sql`
          INSERT INTO graph_research_rows (dataset_id, entity_id, at_ms, payload_json, stored_bytes)
          VALUES (${row.dataset_id}, ${entry.item.id}, ${at}, ${entry.json}, ${Buffer.byteLength(entry.json)})
          ON CONFLICT(dataset_id, entity_id) DO NOTHING
        `;
            }
            if (replay) return jobView(row);
            const totals = (yield* sql<{
              readonly row_count: number;
              readonly stored_bytes: number;
            }>`
        SELECT COUNT(*) AS row_count, COALESCE(SUM(stored_bytes), 0) AS stored_bytes
        FROM graph_research_rows WHERE dataset_id = ${row.dataset_id}
      `)[0];
            const requestCount = row.request_count + 1;
            const isComplete = page.nextCursor === null;
            yield* sql`
        UPDATE graph_research_datasets SET
          row_count = ${totals?.row_count ?? 0}, stored_bytes = ${totals?.stored_bytes ?? 0},
          request_count = ${requestCount}, cursor = ${page.nextCursor},
          status = ${isComplete ? "complete" : "incomplete"}, completed_at = ${isComplete ? input.now : null}
        WHERE dataset_id = ${row.dataset_id} AND status = 'incomplete'
      `;
            const paused =
              !isComplete &&
              (requestCount >= row.cap_requests ||
                (totals?.row_count ?? 0) >= row.cap_rows ||
                (totals?.stored_bytes ?? 0) >= row.cap_bytes);
            yield* sql`
        UPDATE graph_research_jobs SET status = ${isComplete ? "complete" : paused ? "paused" : "running"},
          owner_token = ${isComplete || paused ? null : input.ownerToken},
          lease_until = ${isComplete || paused ? null : input.now + 30_000},
          failure_reason = ${paused ? "configured acquisition budget reached" : null},
          updated_at = ${input.now}
        WHERE job_id = ${input.jobId}
      `;
            return yield* getJob(input.jobId);
          }),
        )
        .pipe(
          Effect.mapError((cause) => (Schema.is(ResearchError)(cause) ? cause : storageError())),
        );
      return result;
    });

  const recordFailure: ResearchDatasetStoreShape["recordFailure"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const row = (yield* findJob(input.jobId))[0];
          if (!row) return yield* error("not_found", "Research job was not found");
          if (row.job_status !== "running" || row.owner_token !== input.ownerToken)
            return yield* error("conflict", "Worker does not own this running job");
          const requestCount = row.request_count + 1;
          const status = input.terminal
            ? "failed"
            : requestCount >= row.cap_requests
              ? "paused"
              : "running";
          yield* sql`
        UPDATE graph_research_datasets SET request_count = ${requestCount}
        WHERE dataset_id = ${row.dataset_id} AND status = 'incomplete'
      `;
          yield* sql`
        UPDATE graph_research_jobs SET status = ${status},
          owner_token = ${status === "running" ? input.ownerToken : null},
          lease_until = ${status === "running" ? input.now + 30_000 : null},
          failure_reason = ${input.reason}, updated_at = ${input.now}
        WHERE job_id = ${input.jobId}
      `;
          return yield* getJob(input.jobId);
        }),
      )
      .pipe(Effect.mapError((cause) => (Schema.is(ResearchError)(cause) ? cause : storageError())));

  const listRunnable: ResearchDatasetStoreShape["listRunnable"] = (now, limit) =>
    Effect.gen(function* () {
      if (!validPositiveInt(limit) || limit > 100)
        return yield* error("invalid_request", "Runnable job limit is invalid");
      const rows = yield* sql<{ readonly job_id: string }>`
      SELECT job_id FROM graph_research_jobs
      WHERE status = 'queued' OR (status = 'running' AND lease_until < ${now})
      ORDER BY updated_at, job_id LIMIT ${limit}
    `.pipe(Effect.mapError(storageError));
      return rows.map((row) => row.job_id);
    });

  const cancel: ResearchDatasetStoreShape["cancel"] = (jobId, now) =>
    Effect.gen(function* () {
      yield* sql`
      UPDATE graph_research_jobs SET status = 'cancelled', owner_token = NULL,
        lease_until = NULL, updated_at = ${now}
      WHERE job_id = ${jobId} AND status IN ('queued', 'running', 'paused')
    `.pipe(Effect.mapError(storageError));
      return yield* getJob(jobId);
    });

  const resume: ResearchDatasetStoreShape["resume"] = (jobId, now, caps) =>
    Effect.gen(function* () {
      const job = yield* getJob(jobId);
      if (job.status !== "cancelled" && job.status !== "paused" && job.status !== "failed")
        return yield* error("conflict", "Research job is not resumable");
      const rows = yield* findJob(jobId);
      const row = rows[0];
      if (!row) return yield* error("not_found", "Research job was not found");
      const nextRequests = Math.max(row.cap_requests, caps?.requests ?? row.cap_requests);
      const nextRows = Math.max(row.cap_rows, caps?.rows ?? row.cap_rows);
      const nextBytes = Math.max(row.cap_bytes, caps?.bytes ?? row.cap_bytes);
      if (
        job.requestCount >= nextRequests ||
        job.rowCount >= nextRows ||
        job.storedBytes >= nextBytes
      ) {
        return yield* error(
          "budget",
          "Increase the configured Graph acquisition cap before resuming",
        );
      }
      yield* sql`
      UPDATE graph_research_jobs SET status = 'queued', failure_reason = NULL,
        cap_requests = ${nextRequests}, cap_rows = ${nextRows}, cap_bytes = ${nextBytes}, updated_at = ${now}
      WHERE job_id = ${jobId}
    `.pipe(Effect.mapError(storageError));
      return yield* getJob(jobId);
    });

  const readWindow: ResearchDatasetStoreShape["readWindow"] = (input) =>
    Effect.gen(function* () {
      if (
        !Number.isSafeInteger(input.from) ||
        !Number.isSafeInteger(input.to) ||
        input.from < 0 ||
        input.to <= input.from ||
        !validPositiveInt(input.limit ?? 1_000) ||
        (input.limit ?? 1_000) > 1_000
      ) {
        return yield* error("invalid_request", "Research read window is invalid");
      }
      const cursor = cursorParts(input.cursor);
      if (!cursor) return yield* error("invalid_request", "Research read cursor is invalid");
      const datasets = yield* sql<DatasetRow>`
      SELECT * FROM graph_research_datasets WHERE dataset_id = ${input.datasetId}
    `.pipe(Effect.mapError(storageError));
      const dataset = datasets[0];
      if (!dataset) return yield* error("not_found", "Research dataset was not found");
      if (
        dataset.entity_kind !== input.resolution ||
        input.from < dataset.from_ms ||
        input.to > dataset.to_ms
      )
        return yield* error("invalid_request", "Read window is outside this dataset or resolution");
      const limit = input.limit ?? 1_000;
      const rows = yield* sql<{
        readonly entity_id: string;
        readonly at_ms: number;
        readonly payload_json: string;
      }>`
      SELECT entity_id, at_ms, payload_json FROM graph_research_rows
      WHERE dataset_id = ${input.datasetId} AND at_ms >= ${input.from} AND at_ms < ${input.to}
        AND (at_ms > ${cursor.at} OR (at_ms = ${cursor.at} AND entity_id > ${cursor.id}))
      ORDER BY at_ms, entity_id LIMIT ${limit + 1}
    `.pipe(Effect.mapError(storageError));
      return yield* Effect.try({
        try: () => {
          const selected = rows.slice(0, limit);
          const last = selected[selected.length - 1];
          return {
            manifest: manifest(dataset),
            rows: selected.map((row) => decodeRow(row.payload_json)),
            nextCursor:
              rows.length > limit && last
                ? `${last.at_ms}:${encodeURIComponent(last.entity_id)}`
                : null,
          };
        },
        catch: storageError,
      });
    });

  return {
    create,
    getJob,
    claim,
    appendPage,
    recordFailure,
    listRunnable,
    cancel,
    resume,
    readWindow,
  } satisfies ResearchDatasetStoreShape;
});

export const ResearchDatasetStoreLive: Layer.Layer<
  ResearchDatasetStore,
  never,
  SqlClient.SqlClient
> = Layer.effect(ResearchDatasetStore, makeResearchDatasetStore);
