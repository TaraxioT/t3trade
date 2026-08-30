import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN workspace_mode TEXT NOT NULL DEFAULT 'market_research'
  `;

  yield* sql`
    ALTER TABLE projection_thread_sessions
    ADD COLUMN workspace_mode TEXT NOT NULL DEFAULT 'market_research'
  `;

  yield* sql`
    ALTER TABLE provider_session_runtime
    ADD COLUMN workspace_mode TEXT NOT NULL DEFAULT 'market_research'
  `;
});
