import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * One row per workspace root: the TRADE.md revision that workspace last
 * activated. The row is the server's pinned snapshot for background execution
 * and drift detection — the workspace file itself remains the only document;
 * the server never writes it.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS trading_plan_documents (
      workspace_root TEXT PRIMARY KEY,
      document_path TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      activated_content TEXT NOT NULL,
      activated_at TEXT NOT NULL,
      activated_by_thread_id TEXT NOT NULL,
      activated_by_provider TEXT NOT NULL,
      mission_id TEXT,
      plan_reference_json TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_trading_plan_documents_mission
    ON trading_plan_documents(mission_id)
  `;
});
