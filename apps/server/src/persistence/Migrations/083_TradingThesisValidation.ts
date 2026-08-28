import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Forward validation: an armed thesis and the paper fills it takes.
 *
 * Two tables, and their separateness is the point rather than a filing
 * convenience. Everything the product says about real money is computed from
 * `trading_fills`, `trading_closed_trades`, `trading_position_snapshots` and
 * `trading_orders`. A paper fill is a statement about what a rule WOULD have
 * done, and if one ever reached those tables it would show up as realised PnL
 * on an account that never traded. So paper rows live in a namespace of their
 * own, no foreign key joins them to an execution record, and no projection
 * that reports money reads them. That is enforced by tests at the service
 * boundary, and it is why these are not extra columns on the ledger.
 *
 * `trading_thesis_validations` carries the lifecycle (armed, paused, ended),
 * the thesis itself, the costs frozen at arm time, and the backtest baseline
 * the forward run is scored against. It also carries the pending-fill state
 * the incremental engine needs: a rule that fired on the last closed bar has
 * not filled yet, and that fact has to survive a restart or the fill is
 * silently dropped.
 *
 * `trading_thesis_paper_fills` is one row per paper trade. A row with a null
 * `exit_time` is the open position — there is at most one per validation, and
 * it is deliberately the same row rather than a separate "open" table, so a
 * trade has one identity from entry to settlement.
 *
 * Costs are frozen at arm time rather than measured per settlement. The
 * comparison a validation exists for is against a backtest priced once, and a
 * forward run whose fee assumption drifted underneath it would report a change
 * in the thesis that was really a change in the spread.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS trading_thesis_validations (
      validation_id TEXT PRIMARY KEY,
      -- The chat thread that armed it, so the report can be delivered back
      -- where it was asked for. Never a mission: forward validation is
      -- research, and binding it to a mission would imply it can trade.
      thread_id TEXT,
      venue TEXT NOT NULL,
      asset TEXT NOT NULL,
      interval TEXT NOT NULL,
      thesis_json TEXT NOT NULL,
      label TEXT,
      status TEXT NOT NULL,
      armed_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      ended_at INTEGER,
      end_reason TEXT,
      notional_usd REAL NOT NULL,
      costs_json TEXT NOT NULL,
      -- The backtest's own figures at arm time. Null when no backtest could
      -- be run, which the report says rather than comparing against a zero.
      baseline_json TEXT,
      -- Closed bars actually evaluated. A paused stretch does not count, so a
      -- hit rate is never quoted over a window with a hole in it.
      bars_watched INTEGER NOT NULL DEFAULT 0,
      -- The one-bar delay, made durable. Open time of the bar whose close
      -- fired the entry rule and whose fill is still owed.
      pending_entry_signal_time INTEGER,
      -- An exit already decided, filling at the next bar's open.
      pending_exit_reason TEXT,
      -- Open time of the last bar evaluated, so a redelivery of the same
      -- closed bar cannot double-count it.
      last_bar_time INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `;

  // The evaluator's read on every candle delivery: which validations are
  // armed on this market and interval.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_trading_thesis_validations_live
    ON trading_thesis_validations (status, asset, interval)
  `;

  // The expiry sweep's read, and the follow set's.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_trading_thesis_validations_status
    ON trading_thesis_validations (status, expires_at)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS trading_thesis_paper_fills (
      paper_trade_id TEXT PRIMARY KEY,
      validation_id TEXT NOT NULL,
      entry_time INTEGER NOT NULL,
      entry_price REAL NOT NULL,
      -- The bar whose close fired the rule. Stop and target distances were
      -- measured here, never at the fill bar, whose readings do not exist yet
      -- at the moment of the fill.
      signal_time INTEGER NOT NULL,
      stop_price REAL,
      target_price REAL,
      -- Null while the position is open. There is at most one such row per
      -- validation.
      exit_time INTEGER,
      exit_price REAL,
      exit_reason TEXT,
      bars_held INTEGER NOT NULL DEFAULT 0,
      gross_usd REAL,
      fees_usd REAL,
      funding_usd REAL,
      net_usd REAL,
      adverse_excursion_usd REAL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `;

  // The report reads a validation's trades oldest first; the chart reads the
  // recent ones. Both are this index.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_trading_thesis_paper_fills_validation
    ON trading_thesis_paper_fills (validation_id, entry_time)
  `;
});
