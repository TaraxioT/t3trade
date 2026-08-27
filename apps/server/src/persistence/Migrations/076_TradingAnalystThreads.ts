import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Final-form Phase 8: the analyst-thread registry.
 *
 * One analyst thread per `{venue, asset}`, reused every time the trader asks
 * about that market. The registry is what makes the analyst profile survive a
 * restart: the in-memory session-profile map is rebuilt from these rows at
 * boot, so a message sent to an analyst thread after a restart still runs as
 * an analyst — three read tools, no filesystem — instead of quietly becoming
 * an ordinary coding agent.
 *
 * The pair is the identity (D1), so it is the primary key; replacing a dead
 * thread for a market is an upsert on the same row.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS trading_analyst_threads (
      venue TEXT NOT NULL,
      asset TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (venue, asset)
    )
  `;
});
