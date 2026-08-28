import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * A mission holds a SET of markets.
 *
 * Hyperliquid nets positions per asset, so authority and exclusivity are
 * per market and stay that way. Nothing about that required a mission to hold
 * only one, and the one-column model made "buy ETH and BTC" a request no
 * single chat could serve.
 *
 * Three changes, one idea:
 *
 * - `trading_mission_markets` is the held set: one row per market a mission has
 *   ever taken, `released_at` set when it lets one go. The D4 exclusivity index
 *   moves here — `(user_id, venue, market) WHERE released_at IS NULL` — because
 *   the old index on `trading_missions` could only ever see the first market a
 *   mission took. `trading_missions.market` stays as the mission's PRIMARY
 *   market: the one it was created on, what the panel opens to, and what the
 *   auto-mandate names. It is a default, no longer the whole authority.
 * - `trading_plan_history.market` keys plans per market. A plan document has
 *   always carried its own `market`; the column makes "the current plan for
 *   BTC" an indexed read instead of a scan-and-decode. The version sequence
 *   stays per mission, so `expectedMissionVersion` still means what it did.
 * - `projection_trading_missions.markets_json` is the read model's held set,
 *   so the client can draw a switcher without joining.
 *
 * Backfill: every existing mission gets a one-element set from its own
 * `market`, released for the two permanent terminals so a completed mission
 * does not hold a market hostage. That is the same predicate the dropped index
 * used, so nothing that was free becomes held and nothing held becomes free.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS trading_mission_markets (
      mission_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      venue TEXT NOT NULL,
      market TEXT NOT NULL,
      bound_at INTEGER NOT NULL,
      released_at INTEGER,
      PRIMARY KEY (mission_id, venue, market)
    )
  `;

  // The D4 invariant, now that a mission can hold more than one: at most one
  // live authority per {user, venue, market}. A released row is history and is
  // deliberately outside the predicate, so the same market can be retaken.
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_trading_mission_markets_held
    ON trading_mission_markets (user_id, venue, market)
    WHERE released_at IS NULL
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_trading_mission_markets_mission
    ON trading_mission_markets (mission_id, released_at)
  `;

  // One element per existing mission. `bound_at` is the mission's own creation
  // time, which is when it took the market.
  yield* sql`
    INSERT OR IGNORE INTO trading_mission_markets
      (mission_id, user_id, venue, market, bound_at, released_at)
    SELECT
      mission_id,
      user_id,
      COALESCE(venue, 'hyperliquid'),
      market,
      created_at,
      CASE WHEN status IN ('revoked', 'completed') THEN updated_at ELSE NULL END
    FROM trading_missions
  `;

  // Superseded by the index above: it could only see a mission's first market.
  yield* sql`DROP INDEX IF EXISTS idx_trading_missions_one_active_per_market`;

  const planCols = yield* sql<{
    readonly name: string;
  }>`PRAGMA table_info(trading_plan_history)`;
  if (!planCols.some((column) => column.name === "market")) {
    yield* sql`ALTER TABLE trading_plan_history ADD COLUMN market TEXT`;
    // The plan document has always carried its market; lifting it into a
    // column is what makes "the current plan for BTC" an index read.
    yield* sql`
      UPDATE trading_plan_history
      SET market = json_extract(strategy_json, '$.market')
      WHERE market IS NULL
    `;
  }
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_trading_plan_history_mission_market
    ON trading_plan_history (mission_id, market, version)
  `;

  const projectionCols = yield* sql<{
    readonly name: string;
  }>`PRAGMA table_info(projection_trading_missions)`;
  if (!projectionCols.some((column) => column.name === "markets_json")) {
    yield* sql`ALTER TABLE projection_trading_missions ADD COLUMN markets_json TEXT`;
    // A JSON array of the held markets. Null until the mission is next
    // projected, and the reader falls back to `[market]` for exactly that gap.
    yield* sql`
      UPDATE projection_trading_missions
      SET markets_json = json_array(market)
      WHERE markets_json IS NULL
    `;
  }
});
