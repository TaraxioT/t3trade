import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * The append-only activation log for TRADE.md revisions. The
 * `trading_plan_documents` row stays one-per-workspace (the server's pinned
 * snapshot for background execution and drift detection); this table keeps
 * every revision ever activated, with the change note, so "what did the plan
 * say last week" survives the next activation and the next deactivation.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS trading_plan_document_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_root TEXT NOT NULL,
      kind TEXT NOT NULL,
      content_hash TEXT,
      activated_content TEXT,
      activated_at TEXT NOT NULL,
      activated_by_thread_id TEXT NOT NULL,
      activated_by_provider TEXT NOT NULL,
      mission_id TEXT,
      change_note TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_trading_plan_document_revisions_root
    ON trading_plan_document_revisions(workspace_root, id)
  `;
});
