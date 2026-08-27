import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Final-form Phases 4 + 5: the watchlist, account-scoped watches, and the
 * alert feed — one migration because the two phases share it by design.
 *
 * Part 1 — `trading_watchlist`. A user-ordered list of `{venue, asset}` pairs
 * the trader wants on the home screen. `position` orders it; the pair is the
 * identity (D1), so it is the primary key.
 *
 * Part 2 — `trading_watches` rebuilt. Watches stop being mission property:
 * `mission_id` becomes nullable so a user with no mission can arm an alert.
 * New columns:
 * - `venue` / `asset`: the D1 market identity as columns. Backfilled
 *   `'hyperliquid'` and the market inside `watch_json` (null for the two
 *   marketless watch types, `order_update` and `scheduled_reassessment`).
 * - `account_id`: backfilled from the owning mission's trading account; null
 *   on an account-less alert.
 * - `deliver`: where a firing goes — `'wake'` (the historic behaviour, and
 *   the backfill, so every existing watch keeps waking exactly as before),
 *   `'notify'` (alert feed only), or `'both'`.
 * - `rearm_json`: once vs repeat-with-cooldown for notify watches; null means
 *   once, which is every existing watch's behaviour.
 * SQLite cannot make a NOT NULL column nullable, so the table is rebuilt and
 * 035's surviving status index is recreated (the strategy-version index died
 * in 063). Every pre-existing column carries over byte-identical.
 *
 * Part 3 — `trading_alert_events`, append-only: what fired, where, when, and
 * the same summary/payload the wake path writes into the inbox. The feed
 * reads it newest-first; nothing ever updates a row.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS trading_watchlist (
      venue TEXT NOT NULL,
      asset TEXT NOT NULL,
      added_at INTEGER NOT NULL,
      position INTEGER NOT NULL,
      PRIMARY KEY (venue, asset)
    )
  `;

  // Rebuild guard: fork databases land migrations one head at a time, and a
  // re-run over a table that already carries `deliver` must be a no-op.
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(trading_watches)`;
  if (!columns.some((column) => column.name === "deliver")) {
    yield* sql`
      CREATE TABLE trading_watches_rebuilt (
        watch_id TEXT PRIMARY KEY,
        mission_id TEXT,
        watch_json TEXT NOT NULL,
        status TEXT NOT NULL,
        version INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        armed_reason TEXT,
        baseline_signature TEXT,
        last_observed_value REAL,
        last_evaluated_at INTEGER,
        prediction_version INTEGER,
        armed_with_position INTEGER,
        next_evaluate_at INTEGER,
        venue TEXT NOT NULL DEFAULT 'hyperliquid',
        asset TEXT,
        account_id TEXT,
        deliver TEXT NOT NULL DEFAULT 'wake',
        rearm_json TEXT
      )
    `;

    yield* sql`
      INSERT INTO trading_watches_rebuilt (
        watch_id, mission_id, watch_json, status, version, created_at, updated_at,
        armed_reason, baseline_signature, last_observed_value, last_evaluated_at,
        prediction_version, armed_with_position, next_evaluate_at,
        venue, asset, account_id, deliver, rearm_json
      )
      SELECT
        w.watch_id, w.mission_id, w.watch_json, w.status, w.version, w.created_at,
        w.updated_at, w.armed_reason, w.baseline_signature, w.last_observed_value,
        w.last_evaluated_at, w.prediction_version, w.armed_with_position,
        w.next_evaluate_at,
        'hyperliquid', json_extract(w.watch_json, '$.market'),
        m.trading_account_id, 'wake', NULL
      FROM trading_watches w
      LEFT JOIN trading_missions m ON m.mission_id = w.mission_id
    `;

    yield* sql`DROP TABLE trading_watches`;
    yield* sql`ALTER TABLE trading_watches_rebuilt RENAME TO trading_watches`;
  }

  // 035's surviving index, recreated: the evaluator and the mission read model
  // both read watches by (mission, status).
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_trading_watches_mission_status
    ON trading_watches (mission_id, status)
  `;

  // The evaluator's new tracked read is status-first (mission optional).
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_trading_watches_status
    ON trading_watches (status)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS trading_alert_events (
      event_id TEXT PRIMARY KEY,
      venue TEXT NOT NULL,
      asset TEXT NOT NULL,
      account_id TEXT,
      watch_id TEXT NOT NULL,
      fired_at INTEGER NOT NULL,
      summary TEXT NOT NULL,
      payload_json TEXT NOT NULL
    )
  `;

  // The feed reads newest-first with a limit.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_trading_alert_events_fired
    ON trading_alert_events (fired_at DESC)
  `;
});
