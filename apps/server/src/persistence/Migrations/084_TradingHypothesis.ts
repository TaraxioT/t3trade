import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * The hypothesis: an idea with a life, rather than five records that never met.
 *
 * Before this, a thought about a market could become a mission mandate, a
 * published plan, a watch, a backtest or a forward validation, and none of
 * those five knew about the others. A backtest was not stored at all; it lived
 * in the transcript and died with it. A validation was immutable, so refining
 * an idea meant ending one and arming another with nothing linking the two.
 * The question "what happened to that idea I had" had no answer anywhere in
 * the product.
 *
 * `trading_hypotheses` is that answer. It is the durable identity, and its
 * versions are the refinement history: the thesis is not a column on the
 * hypothesis because a hypothesis that cannot change is a note, and one that
 * changes in place loses the only thing that makes a comparison meaningful.
 * Version n's backtest belongs to version n's thesis, forever.
 *
 * ## The wall stays exactly where it is
 *
 * No foreign key here reaches `trading_fills`, `trading_closed_trades`,
 * `trading_position_snapshots`, `trading_orders` or any other execution table,
 * and no projection that reports real money reads any of these. A hypothesis
 * is research. `trading_backtest_runs` holds figures that were never traded,
 * and the validation columns added below point at a paper ledger. Promotion to
 * a live position remains what it has always been: a sentence the user types,
 * answered by an ordinary plan and entry.
 *
 * ## Why the runs table stores no per-trade array
 *
 * A run over a year of one-minute bars can take thousands of trades. The
 * report the product actually shows is about twenty numbers, and every one of
 * them is already an aggregate. Storing the trades would make the row grow
 * with the window and buy back nothing any surface reads, so `report_json`
 * holds the `BacktestReport` exactly as the wire carries it, which by
 * construction has no variable-length member.
 *
 * `hypothesis_id` and `hypothesis_version` are nullable because a backtest is
 * still allowed to be a loose question. An idea does not have to be filed
 * before it can be tested.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS trading_hypotheses (
      hypothesis_id TEXT PRIMARY KEY,
      -- The chat it was born in. Unlike the validation's thread_id, this one
      -- is read: the list a conversation sees is scoped by it.
      thread_id TEXT NOT NULL,
      title TEXT NOT NULL,
      -- exploring: written down, not yet tested. testing: it has runs or a
      -- validation against it. supported/unsupported: concluded, and the
      -- conclusion says why in the user's own terms. shelved: put down
      -- without a verdict, which is an honest ending and not a failure.
      status TEXT NOT NULL CHECK (
        status IN ('exploring', 'testing', 'supported', 'unsupported', 'shelved')
      ),
      -- One sentence, set when the status leaves testing and cleared when a
      -- revision reopens it. A conclusion about a thesis that has since
      -- changed is worse than no conclusion.
      conclusion TEXT,
      current_version INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `;

  // The list a thread sees, and the account-wide list, are both this index.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_trading_hypotheses_thread
    ON trading_hypotheses (thread_id, updated_at)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS trading_hypothesis_versions (
      hypothesis_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      thesis_json TEXT NOT NULL,
      -- Why this version exists. Required, because a refinement whose reason
      -- was not written down is indistinguishable from a fit to the last run.
      note TEXT NOT NULL,
      author TEXT NOT NULL CHECK (author IN ('user', 'agent')),
      created_at INTEGER NOT NULL,
      PRIMARY KEY (hypothesis_id, version)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS trading_backtest_runs (
      run_id TEXT PRIMARY KEY,
      -- Null when the run was a loose question rather than a test of a filed
      -- idea. Not a foreign key: a hypothesis deleted out from under a run
      -- should orphan the run, not erase the measurement.
      hypothesis_id TEXT,
      hypothesis_version INTEGER,
      thesis_json TEXT NOT NULL,
      -- The BacktestReport as served, with no per-trade array. See the note
      -- above on why the trades are not kept.
      report_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `;

  // A hypothesis card reads its runs newest first.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_trading_backtest_runs_hypothesis
    ON trading_backtest_runs (hypothesis_id, created_at)
  `;

  // Additive and nullable on both counts: every validation armed before this
  // migration keeps working, unstamped, and the plain arm path still takes no
  // hypothesis at all.
  yield* sql`ALTER TABLE trading_thesis_validations ADD COLUMN hypothesis_id TEXT`;
  yield* sql`ALTER TABLE trading_thesis_validations ADD COLUMN hypothesis_version INTEGER`;
});
