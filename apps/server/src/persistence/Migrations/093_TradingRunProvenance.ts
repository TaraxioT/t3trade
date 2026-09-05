import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Saved backtest runs gain a provenance column.
 *
 * A run row already explains most of itself: `thesis_json` and `report_json`
 * hold the rule, the window it was asked for, what the archive served, the
 * costs and notional it was priced at, and every figure — and `created_at` is
 * the as-of cutoff of the archive read. What it could not say was which
 * CALENDAR an event-anchored thesis ran on, or which arithmetic produced the
 * numbers. A set's id is stable while its dates are corrected and amended, so
 * an id alone cannot say which occurrences the run actually saw.
 *
 * `provenance_json` holds exactly that: the content digests of the event sets
 * the thesis anchored on, pinned at save time, and the calculation version.
 *
 * Nullable on purpose. Runs filed before this column existed have no
 * provenance, and the honest reading of that is "not recorded" — never a
 * digest reconstructed after the fact, which would pin a calendar the run
 * never saw.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE trading_backtest_runs ADD COLUMN provenance_json TEXT
  `;
});
