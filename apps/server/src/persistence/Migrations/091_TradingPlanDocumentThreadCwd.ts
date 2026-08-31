import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * The cwd spelling each activation was reached through.
 *
 * `trading_plan_documents` is keyed by the workspace root's real path, which
 * can only be computed while the directory exists. A workspace that is later
 * deleted took its pinned revision with it: the drift guard and the wake
 * composer could no longer find a row they were obliged to enforce. The
 * persisted thread cwd recorded here keeps the pin discoverable after the
 * directory is gone, without weakening the real-path identity while it exists.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE trading_plan_documents ADD COLUMN thread_cwd TEXT
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_trading_plan_documents_thread_cwd
    ON trading_plan_documents(thread_cwd)
  `;

  // Best-effort backfill for rows activated before this column: the
  // activating thread's persisted cwd, when one still exists. A NULL here
  // only costs the deleted-root fallback for that legacy row, never any
  // behavior the directory's existence already provided.
  yield* sql`
    UPDATE trading_plan_documents
    SET thread_cwd = (
      SELECT json_extract(runtime_payload_json, '$.cwd')
      FROM provider_session_runtime
      WHERE thread_id = trading_plan_documents.activated_by_thread_id
    )
    WHERE thread_cwd IS NULL
  `;
});
