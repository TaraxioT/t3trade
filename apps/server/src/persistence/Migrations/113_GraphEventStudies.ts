import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Retained Graph event-window studies — the versioned, content-addressed
 * result records `GraphEventWindowStudyService` commits.
 *
 * One row per study: the exact spec echo (event set with per-occurrence
 * sources, pool, interval, every compared variant) and the full result JSON
 * (per-variant/occurrence reports with dataset lineage, coverage disclosure,
 * applies-now assessment, uncertainty statement). `study_id` is
 * content-derived over the spec, so the same study design over the same
 * retained datasets replays idempotently instead of double-recording.
 *
 * FILE ONLY at this checkpoint: Worker B owns the file, the coordinator
 * registers it in Migrations.ts at integration (parallel-checkpoint.md).
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS forge_graph_event_studies (
      study_id     TEXT PRIMARY KEY,
      environment_id TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      spec_json    TEXT NOT NULL,
      result_json  TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_forge_graph_event_studies_env_time
      ON forge_graph_event_studies (environment_id, created_at_ms DESC)
  `;
});
