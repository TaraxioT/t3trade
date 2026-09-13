import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * The durable occurrence boundary — logical false→true transitions of a
 * detector condition, persisted across windows and restarts.
 *
 * One row per OBSERVATION of a logical occurrence (not per window): the first
 * detection inserts it, later windows while the condition still holds only
 * CONFIRM it, a consumed row can never fire again, and an explicit reset
 * (a changed `reset_key`) closes the old row and lets the next detection open
 * a new one. `version` keys rows to the program identity — a detector
 * artifact revision is a NEW program with a fresh occurrence space, and the
 * previous version's rows stay untouched history.
 *
 * Written by DetectorRunStore.recordOccurrence inside the same discipline as
 * the state CAS: everything is refusal-shaped and append-mostly; the only
 * in-place updates are confirmations (last_confirmed_at_ms), the one-time
 * consume mark, and the one-time reset mark.
 *
 * FILE ONLY at this checkpoint: Worker B owns the file, the coordinator
 * registers it in Migrations.ts at integration (parallel-checkpoint.md).
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS forge_detector_occurrences (
      occurrence_row_id   INTEGER PRIMARY KEY AUTOINCREMENT,
      environment_id      TEXT NOT NULL,
      capability_id       TEXT NOT NULL,
      version             INTEGER NOT NULL,
      occurrence_key      TEXT NOT NULL,
      reset_key           TEXT NOT NULL,
      first_detected_at_ms INTEGER NOT NULL,
      last_confirmed_at_ms INTEGER NOT NULL,
      valid_until_ms      INTEGER NOT NULL,
      evaluation_id       TEXT NOT NULL,
      consumed_at_ms      INTEGER,
      reset_at_ms         INTEGER
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_forge_detector_occurrences_scope
      ON forge_detector_occurrences (environment_id, capability_id, version, occurrence_key, occurrence_row_id DESC)
  `;
});
