import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Trading control results: the durable final outcome of a §14.7 risk control
 * (RC06).
 *
 * A dispatched control command only proves the request was accepted; the
 * reactor's exchange work — bounded closes, cancellations, the all-market
 * finalization — finishes later, and until now its outcome lived only in
 * server logs. One row per applied control records what the operator must be
 * able to see without a provider: the control, a completed/failed/unknown
 * status, the already-composed summary, per-market facts as JSON, and the
 * sequence of the request event it answers, so a client can correlate the
 * result to the press that caused it and ignore stale results.
 *
 * Rows are append-only and read latest-first by the mission projection; no
 * foreign keys reach the exchange-facing tables, and nothing here is
 * authoritative for positions or orders — the exchange stays the truth; this
 * is the record of what T3 Trade's control did about it.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE trading_control_results (
      mission_id TEXT NOT NULL,
      control TEXT NOT NULL,
      status TEXT NOT NULL,
      summary TEXT NOT NULL,
      markets_json TEXT NOT NULL DEFAULT '[]',
      request_event_sequence INTEGER,
      occurred_at INTEGER NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX idx_trading_control_results_mission
    ON trading_control_results (mission_id, occurred_at DESC)
  `;
});
