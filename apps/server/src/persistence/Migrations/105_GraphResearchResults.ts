import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE graph_research_results (
      result_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('event_study', 'long_simulation')),
      environment_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      parent_id TEXT,
      payload_json TEXT NOT NULL,
      report_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE graph_research_result_datasets (
      result_id TEXT NOT NULL REFERENCES graph_research_results(result_id) ON DELETE CASCADE,
      dataset_id TEXT NOT NULL REFERENCES graph_research_datasets(dataset_id) ON DELETE RESTRICT,
      PRIMARY KEY (result_id, dataset_id)
    )
  `;
  yield* sql`
    CREATE TABLE graph_research_result_jobs (
      job_id TEXT PRIMARY KEY,
      result_id TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK (kind IN ('event_study', 'long_simulation')),
      environment_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      recipe_json TEXT NOT NULL,
      view_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'paused', 'cancelled', 'complete', 'failed')),
      owner_token TEXT,
      lease_until INTEGER,
      updated_at INTEGER NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX idx_graph_research_result_jobs_queue
    ON graph_research_result_jobs (status, updated_at)
  `;
  yield* sql`
    CREATE TABLE graph_research_result_job_datasets (
      job_id TEXT NOT NULL REFERENCES graph_research_result_jobs(job_id) ON DELETE CASCADE,
      dataset_id TEXT NOT NULL REFERENCES graph_research_datasets(dataset_id) ON DELETE RESTRICT,
      row_count INTEGER NOT NULL,
      request_count INTEGER NOT NULL,
      stored_bytes INTEGER NOT NULL,
      PRIMARY KEY (job_id, dataset_id)
    )
  `;
});
