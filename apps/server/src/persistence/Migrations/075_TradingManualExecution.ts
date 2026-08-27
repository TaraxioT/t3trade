import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Final-form Phase 7: execution stops being mission property.
 *
 * The six migration-038 execution tables are rebuilt so a row can be owned by
 * either authority D4 recognises — a mission, or the user's own hand:
 *
 * - `mission_id` becomes NULLABLE. NULL means "manual": the user placed it
 *   from the order ticket, no mission anywhere near it.
 * - `account_id TEXT NOT NULL DEFAULT 'unattributed'` — the trading account
 *   every row settles against, backfilled from the owning mission (a row whose
 *   mission is gone backfills the same `'unattributed'` sentinel the DEFAULT
 *   carries, rather than failing the whole rebuild; 0.2's delete path means
 *   such rows should not exist, but a migration must not bet the database on
 *   "should"). Every production write path names the account explicitly; the
 *   DEFAULT exists so decade-old fixtures and imports degrade to the sentinel
 *   instead of refusing.
 * - `venue TEXT NOT NULL DEFAULT 'hyperliquid'` and `asset TEXT` — the D1
 *   market identity as columns, `asset` backfilled from the existing `market`
 *   column where the table has one (reservations and account snapshots carry
 *   no market, so their `asset` stays NULL). `market` itself is untouched:
 *   every existing read keeps working, and the pair is what new venue-aware
 *   reads filter on.
 *
 * SQLite cannot make a NOT NULL column nullable, so each table is rebuilt and
 * every index 038/039/053 put on them is recreated — plus, where a primary key
 * contained `mission_id`, the uniqueness is re-expressed:
 *
 * - `trading_orders` PK `(mission_id, cloid)` → `(account_id, cloid)`. A cloid
 *   is hash-derived from its owner, so this is the same uniqueness with an
 *   owner column that is never NULL.
 * - `trading_position_snapshots` PK `(mission_id, market)` → two partial
 *   unique indexes: `(mission_id, market)` for mission rows and
 *   `(account_id, venue, market)` for manual rows (one manual position per
 *   market per account — D4's per-market authority made flesh).
 * - `trading_account_snapshots` PK `(mission_id)` → the same split.
 * - 053's unique `(mission_id, execution_sequence)` becomes partial over
 *   mission rows; manual rows are already unique through `idempotency_key`,
 *   which encodes the manual owner and sequence.
 *
 * `trading_missions` gains `venue` (backfilled `'hyperliquid'`), and 035's
 * one-active-mission-per-USER index is replaced by the D4 exclusivity index:
 * at most one active mission per `{user, venue, market}`. The other half of
 * exclusivity — manual exposure blocking a mission and vice versa — is service
 * logic, because "open manual position or resting manual order" is not a
 * predicate an index can see.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Rebuild guard, same convention as 074: fork databases land migrations one
  // head at a time, and a re-run over already-rebuilt tables must be a no-op.
  const executionCols = yield* sql<{
    readonly name: string;
  }>`PRAGMA table_info(trading_execution_records)`;
  const alreadyRebuilt = executionCols.some((column) => column.name === "account_id");

  if (!alreadyRebuilt) {
    // -- trading_execution_records ------------------------------------------
    yield* sql`
      CREATE TABLE trading_execution_records_rebuilt (
        execution_id TEXT PRIMARY KEY,
        mission_id TEXT,
        execution_sequence INTEGER NOT NULL,
        action_type TEXT NOT NULL,
        cloid TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        market TEXT NOT NULL,
        side TEXT NOT NULL,
        size REAL NOT NULL,
        limit_price REAL NOT NULL,
        time_in_force TEXT NOT NULL,
        reduce_only INTEGER NOT NULL,
        signer_address TEXT NOT NULL,
        status TEXT NOT NULL,
        order_results_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        stop_price REAL,
        planned_loss_at_stop_usd REAL,
        account_id TEXT NOT NULL DEFAULT 'unattributed',
        venue TEXT NOT NULL DEFAULT 'hyperliquid',
        asset TEXT
      )
    `;
    yield* sql`
      INSERT INTO trading_execution_records_rebuilt (
        execution_id, mission_id, execution_sequence, action_type, cloid,
        idempotency_key, market, side, size, limit_price, time_in_force,
        reduce_only, signer_address, status, order_results_json, created_at,
        updated_at, stop_price, planned_loss_at_stop_usd,
        account_id, venue, asset
      )
      SELECT
        e.execution_id, e.mission_id, e.execution_sequence, e.action_type, e.cloid,
        e.idempotency_key, e.market, e.side, e.size, e.limit_price, e.time_in_force,
        e.reduce_only, e.signer_address, e.status, e.order_results_json, e.created_at,
        e.updated_at, e.stop_price, e.planned_loss_at_stop_usd,
        COALESCE(m.trading_account_id, 'unattributed'), 'hyperliquid', e.market
      FROM trading_execution_records e
      LEFT JOIN trading_missions m ON m.mission_id = e.mission_id
    `;
    yield* sql`DROP TABLE trading_execution_records`;
    yield* sql`ALTER TABLE trading_execution_records_rebuilt RENAME TO trading_execution_records`;

    // -- trading_orders ------------------------------------------------------
    yield* sql`
      CREATE TABLE trading_orders_rebuilt (
        mission_id TEXT,
        cloid TEXT NOT NULL,
        order_id INTEGER NOT NULL,
        market TEXT NOT NULL,
        side TEXT NOT NULL,
        limit_price REAL NOT NULL,
        remaining_size REAL NOT NULL,
        reduce_only INTEGER NOT NULL,
        observed_at INTEGER NOT NULL,
        account_id TEXT NOT NULL DEFAULT 'unattributed',
        venue TEXT NOT NULL DEFAULT 'hyperliquid',
        asset TEXT,
        PRIMARY KEY (account_id, cloid)
      )
    `;
    yield* sql`
      INSERT INTO trading_orders_rebuilt (
        mission_id, cloid, order_id, market, side, limit_price, remaining_size,
        reduce_only, observed_at, account_id, venue, asset
      )
      SELECT
        o.mission_id, o.cloid, o.order_id, o.market, o.side, o.limit_price,
        o.remaining_size, o.reduce_only, o.observed_at,
        COALESCE(m.trading_account_id, 'unattributed'), 'hyperliquid', o.market
      FROM trading_orders o
      LEFT JOIN trading_missions m ON m.mission_id = o.mission_id
    `;
    yield* sql`DROP TABLE trading_orders`;
    yield* sql`ALTER TABLE trading_orders_rebuilt RENAME TO trading_orders`;

    // -- trading_fills -------------------------------------------------------
    yield* sql`
      CREATE TABLE trading_fills_rebuilt (
        fill_id TEXT PRIMARY KEY,
        mission_id TEXT,
        execution_id TEXT,
        cloid TEXT,
        order_id INTEGER NOT NULL,
        market TEXT NOT NULL,
        side TEXT NOT NULL,
        filled_size REAL NOT NULL,
        avg_fill_price REAL NOT NULL,
        fee_usd REAL NOT NULL,
        fee_token TEXT NOT NULL,
        traded_at INTEGER NOT NULL,
        observed_at INTEGER NOT NULL,
        closed_pnl REAL NOT NULL DEFAULT 0,
        direction TEXT,
        crossed INTEGER,
        account_id TEXT NOT NULL DEFAULT 'unattributed',
        venue TEXT NOT NULL DEFAULT 'hyperliquid',
        asset TEXT
      )
    `;
    yield* sql`
      INSERT INTO trading_fills_rebuilt (
        fill_id, mission_id, execution_id, cloid, order_id, market, side,
        filled_size, avg_fill_price, fee_usd, fee_token, traded_at, observed_at,
        closed_pnl, direction, crossed, account_id, venue, asset
      )
      SELECT
        f.fill_id, f.mission_id, f.execution_id, f.cloid, f.order_id, f.market,
        f.side, f.filled_size, f.avg_fill_price, f.fee_usd, f.fee_token,
        f.traded_at, f.observed_at, f.closed_pnl, f.direction, f.crossed,
        COALESCE(m.trading_account_id, 'unattributed'), 'hyperliquid', f.market
      FROM trading_fills f
      LEFT JOIN trading_missions m ON m.mission_id = f.mission_id
    `;
    yield* sql`DROP TABLE trading_fills`;
    yield* sql`ALTER TABLE trading_fills_rebuilt RENAME TO trading_fills`;

    // -- trading_position_snapshots -----------------------------------------
    yield* sql`
      CREATE TABLE trading_position_snapshots_rebuilt (
        mission_id TEXT,
        market TEXT NOT NULL,
        size REAL NOT NULL,
        entry_price REAL,
        unrealised_pnl REAL NOT NULL,
        margin_used REAL NOT NULL,
        protected_size REAL NOT NULL,
        observed_at INTEGER NOT NULL,
        liquidation_price REAL,
        mark_px REAL,
        peak_unrealised_pnl REAL,
        trough_unrealised_pnl REAL,
        opened_at INTEGER,
        leverage REAL,
        account_id TEXT NOT NULL DEFAULT 'unattributed',
        venue TEXT NOT NULL DEFAULT 'hyperliquid',
        asset TEXT
      )
    `;
    yield* sql`
      INSERT INTO trading_position_snapshots_rebuilt (
        mission_id, market, size, entry_price, unrealised_pnl, margin_used,
        protected_size, observed_at, liquidation_price, mark_px,
        peak_unrealised_pnl, trough_unrealised_pnl, opened_at, leverage,
        account_id, venue, asset
      )
      SELECT
        p.mission_id, p.market, p.size, p.entry_price, p.unrealised_pnl,
        p.margin_used, p.protected_size, p.observed_at, p.liquidation_price,
        p.mark_px, p.peak_unrealised_pnl, p.trough_unrealised_pnl, p.opened_at,
        p.leverage,
        COALESCE(m.trading_account_id, 'unattributed'), 'hyperliquid', p.market
      FROM trading_position_snapshots p
      LEFT JOIN trading_missions m ON m.mission_id = p.mission_id
    `;
    yield* sql`DROP TABLE trading_position_snapshots`;
    yield* sql`
      ALTER TABLE trading_position_snapshots_rebuilt RENAME TO trading_position_snapshots
    `;

    // -- trading_risk_reservations ------------------------------------------
    yield* sql`
      CREATE TABLE trading_risk_reservations_rebuilt (
        reservation_id TEXT PRIMARY KEY,
        mission_id TEXT,
        execution_id TEXT NOT NULL,
        cloid TEXT NOT NULL,
        action_type TEXT NOT NULL,
        reserved_risk_usd REAL NOT NULL,
        status TEXT NOT NULL,
        reserved_at INTEGER NOT NULL,
        released_at INTEGER,
        account_id TEXT NOT NULL DEFAULT 'unattributed',
        venue TEXT NOT NULL DEFAULT 'hyperliquid',
        asset TEXT
      )
    `;
    yield* sql`
      INSERT INTO trading_risk_reservations_rebuilt (
        reservation_id, mission_id, execution_id, cloid, action_type,
        reserved_risk_usd, status, reserved_at, released_at,
        account_id, venue, asset
      )
      SELECT
        r.reservation_id, r.mission_id, r.execution_id, r.cloid, r.action_type,
        r.reserved_risk_usd, r.status, r.reserved_at, r.released_at,
        COALESCE(m.trading_account_id, 'unattributed'), 'hyperliquid', NULL
      FROM trading_risk_reservations r
      LEFT JOIN trading_missions m ON m.mission_id = r.mission_id
    `;
    yield* sql`DROP TABLE trading_risk_reservations`;
    yield* sql`
      ALTER TABLE trading_risk_reservations_rebuilt RENAME TO trading_risk_reservations
    `;

    // -- trading_account_snapshots ------------------------------------------
    yield* sql`
      CREATE TABLE trading_account_snapshots_rebuilt (
        mission_id TEXT,
        master_address TEXT NOT NULL,
        account_value REAL NOT NULL,
        margin_used REAL NOT NULL,
        withdrawable REAL NOT NULL,
        positions_json TEXT NOT NULL,
        observed_at INTEGER NOT NULL,
        account_id TEXT NOT NULL DEFAULT 'unattributed',
        venue TEXT NOT NULL DEFAULT 'hyperliquid',
        asset TEXT
      )
    `;
    yield* sql`
      INSERT INTO trading_account_snapshots_rebuilt (
        mission_id, master_address, account_value, margin_used, withdrawable,
        positions_json, observed_at, account_id, venue, asset
      )
      SELECT
        s.mission_id, s.master_address, s.account_value, s.margin_used,
        s.withdrawable, s.positions_json, s.observed_at,
        COALESCE(m.trading_account_id, 'unattributed'), 'hyperliquid', NULL
      FROM trading_account_snapshots s
      LEFT JOIN trading_missions m ON m.mission_id = s.mission_id
    `;
    yield* sql`DROP TABLE trading_account_snapshots`;
    yield* sql`
      ALTER TABLE trading_account_snapshots_rebuilt RENAME TO trading_account_snapshots
    `;
  }

  // -- indexes, recreated idempotently outside the guard ---------------------
  // 038's three, 039's unique reservation index, 053's unique sequence index
  // (now partial over mission rows), plus the account-scoped reads Phase 7 adds.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_trading_execution_records_mission
    ON trading_execution_records (mission_id, execution_sequence)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_trading_execution_records_cloid
    ON trading_execution_records (cloid)
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_trading_execution_records_mission_sequence
    ON trading_execution_records (mission_id, execution_sequence)
    WHERE mission_id IS NOT NULL
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_trading_execution_records_account
    ON trading_execution_records (account_id, execution_sequence)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_trading_orders_mission
    ON trading_orders (mission_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_trading_fills_mission
    ON trading_fills (mission_id, traded_at)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_trading_fills_cloid
    ON trading_fills (cloid)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_trading_fills_account
    ON trading_fills (account_id, traded_at)
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_trading_position_snapshots_mission
    ON trading_position_snapshots (mission_id, market)
    WHERE mission_id IS NOT NULL
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_trading_position_snapshots_manual
    ON trading_position_snapshots (account_id, venue, market)
    WHERE mission_id IS NULL
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_trading_risk_reservations_mission
    ON trading_risk_reservations (mission_id, status)
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_trading_risk_reservations_execution
    ON trading_risk_reservations (execution_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_trading_risk_reservations_account
    ON trading_risk_reservations (account_id, status)
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_trading_account_snapshots_mission
    ON trading_account_snapshots (mission_id)
    WHERE mission_id IS NOT NULL
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_trading_account_snapshots_manual
    ON trading_account_snapshots (account_id)
    WHERE mission_id IS NULL
  `;

  // -- trading_missions: the venue axis and the D4 exclusivity index ---------
  const missionCols = yield* sql<{
    readonly name: string;
  }>`PRAGMA table_info(trading_missions)`;
  if (!missionCols.some((column) => column.name === "venue")) {
    yield* sql`
      ALTER TABLE trading_missions ADD COLUMN venue TEXT NOT NULL DEFAULT 'hyperliquid'
    `;
  }

  // The old index enforced "one active mission per user"; D4 narrows the claim
  // to the market. The old index guarantees at most one active row exists at
  // rebuild time, so the new, weaker-per-row constraint cannot fail on
  // existing data.
  yield* sql`DROP INDEX IF EXISTS idx_trading_missions_one_active_per_user`;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_trading_missions_one_active_per_market
    ON trading_missions (user_id, venue, market)
    WHERE status NOT IN ('revoked', 'completed')
  `;
});
