import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE graph_research_datasets (
      dataset_id TEXT PRIMARY KEY,
      environment_id TEXT NOT NULL,
      source_json TEXT NOT NULL,
      snapshot_block_number INTEGER NOT NULL,
      snapshot_block_hash TEXT NOT NULL,
      entity_kind TEXT NOT NULL CHECK (entity_kind IN ('swaps', 'hour', 'day')),
      from_ms INTEGER NOT NULL,
      to_ms INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('incomplete', 'complete')),
      row_count INTEGER NOT NULL DEFAULT 0,
      stored_bytes INTEGER NOT NULL DEFAULT 0,
      request_count INTEGER NOT NULL DEFAULT 0,
      cursor TEXT,
      created_at INTEGER NOT NULL,
      completed_at INTEGER,
      CHECK (from_ms < to_ms),
      CHECK ((status = 'complete') = (completed_at IS NOT NULL))
    )
  `;

  yield* sql`
    CREATE TABLE graph_research_rows (
      dataset_id TEXT NOT NULL REFERENCES graph_research_datasets(dataset_id) ON DELETE CASCADE,
      entity_id TEXT NOT NULL,
      at_ms INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      stored_bytes INTEGER NOT NULL,
      PRIMARY KEY (dataset_id, entity_id)
    )
  `;
  yield* sql`
    CREATE INDEX idx_graph_research_rows_window
    ON graph_research_rows (dataset_id, at_ms, entity_id)
  `;

  yield* sql`
    CREATE TABLE graph_research_jobs (
      job_id TEXT PRIMARY KEY,
      dataset_id TEXT NOT NULL UNIQUE REFERENCES graph_research_datasets(dataset_id) ON DELETE CASCADE,
      thread_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'paused', 'cancelled', 'complete', 'failed')),
      owner_token TEXT,
      lease_until INTEGER,
      cap_requests INTEGER NOT NULL,
      cap_rows INTEGER NOT NULL,
      cap_bytes INTEGER NOT NULL,
      failure_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX idx_graph_research_jobs_queue
    ON graph_research_jobs (status, updated_at)
  `;
});
