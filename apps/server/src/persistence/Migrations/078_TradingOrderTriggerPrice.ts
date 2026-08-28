import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Where a resting stop actually fires.
 *
 * A protective stop is a trigger order: the exchange watches `trigger_price`
 * and, when it is touched, submits a market-ish order capped by `limit_price`
 * so a thin book cannot fill it anywhere. The two are deliberately far apart —
 * the limit carries the slippage allowance — and only `limit_price` was ever
 * persisted, so the positions panel showed a trader their 2,472 stop as
 * 2,447.3 and they read their risk twenty-five dollars looser than it was.
 *
 * Nullable, and null for every ordinary limit order: an order with no trigger
 * is not a trigger order, and a default would invent one. Rows written before
 * this column existed are re-populated by the next reconcile pass, which
 * rewrites the table wholesale from the exchange.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(trading_orders)
  `;
  if (columns.some((column) => column.name === "trigger_price")) return;

  yield* sql`
    ALTER TABLE trading_orders ADD COLUMN trigger_price REAL
  `;
});
