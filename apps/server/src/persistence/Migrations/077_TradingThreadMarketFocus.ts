import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * The market a chat thread is about.
 *
 * One row per thread, upserted: the trade home seeds it from "Trade in chat",
 * the agent's own `trading_look` moves it, and taking authority on a market
 * writes it too. The client reads it to decide which market's chart, position
 * and alerts sit beside the conversation.
 *
 * It is a note about attention, never an authority record. Authority lives in
 * `trading_missions` and only ever changes through `createMission`; a row here
 * grants nothing, so it is safe for the client to write directly.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS trading_thread_market_focus (
      thread_id TEXT PRIMARY KEY,
      venue TEXT NOT NULL,
      asset TEXT NOT NULL,
      source TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `;
});
