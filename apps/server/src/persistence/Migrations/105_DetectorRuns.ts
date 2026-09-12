import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * The detector-run boundary — committed v2 evaluations and the versioned
 * detector state they advance.
 *
 * Two tables, deliberately separate from CapabilityStore's file-based
 * history: v2 evaluation records carry `DetectionResult` payloads the v1
 * history readers cannot decode, and mixing them in would make those readers
 * silently drop rows. SQL also gives the state row the compare-and-set home
 * the revision discipline needs.
 *
 * - `forge_detector_state` holds ONE current state row per
 *   (environment, capability): the canonical envelope bytes from
 *   `encodeDetectorState` persisted VERBATIM, the revision they were committed
 *   at, and the evaluation that committed them. Version and revision advance
 *   monotonically; the store's commit compares `state_revision` before every
 *   advance (revision CAS — a stale writer never overwrites a newer state).
 * - `forge_detector_evaluations` is the immutable, append-only log: one row
 *   per committed evaluation id, `record_json` the exact record bytes (so a
 *   replayed commit is byte-comparable), `result_json` the DetectionResult for
 *   direct reads. `evaluation_id` is content-derived; the store refuses the
 *   same id arriving with different record bytes.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS forge_detector_state (
      environment_id      TEXT NOT NULL,
      capability_id       TEXT NOT NULL,
      version             INTEGER NOT NULL,
      state_revision      INTEGER NOT NULL,
      state_json          TEXT NOT NULL,
      last_evaluation_id  TEXT NOT NULL,
      committed_at_ms     INTEGER NOT NULL,
      PRIMARY KEY (environment_id, capability_id)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS forge_detector_evaluations (
      evaluation_id   TEXT PRIMARY KEY,
      environment_id  TEXT NOT NULL,
      capability_id   TEXT NOT NULL,
      version         INTEGER NOT NULL,
      state_revision  INTEGER NOT NULL,
      input_digest    TEXT NOT NULL,
      result_json     TEXT NOT NULL,
      record_json     TEXT NOT NULL,
      committed_at_ms INTEGER NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_forge_detector_evaluations_scope_time
      ON forge_detector_evaluations (environment_id, capability_id, committed_at_ms DESC)
  `;
});
