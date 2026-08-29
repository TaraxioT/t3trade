import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Event sets: the external calendar a thesis can anchor on.
 *
 * The archive records what the market did. It carries no trace of when a
 * conference happened, an upgrade shipped, or a lockup unlocked, so a user's
 * "every time after Devcon, ETH goes up" had nowhere to live: no indicator,
 * metric or watch can express it. These two tables are that place: a named set
 * of dated occurrences, each carrying the source the date came from.
 *
 * ## Why the archive is the wrong home for this
 *
 * The market archive is the recorder's: it holds what the exchange served and
 * nothing anyone typed. An event set is an authored record, closer to a
 * hypothesis than to a candle, so it lives in state.sqlite beside the
 * hypothesis tables and follows their rules.
 *
 * ## The wall stays exactly where it is
 *
 * No foreign key here reaches an execution table, and no projection that
 * reports real money reads either of these. The furthest this data ever
 * travels is into a thesis's event operand, a descriptive study, and a band
 * on a chart. Trading an event-anchored idea remains what it has always been:
 * a sentence the user types, answered by an ordinary plan and entry.
 *
 * ## Why every occurrence carries an author and a source
 *
 * A date nobody can check is a number every downstream number silently rests
 * on, so `source` is NOT NULL (a URL, or "user provided" when the user
 * dictated the date) and `author` records who wrote the row. The primary key
 * is (event_set_id, start_at): the same event cannot start twice on the same
 * instant, which makes `record`'s full replace and `add`'s append the only
 * two write shapes there are.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS trading_event_sets (
      event_set_id TEXT PRIMARY KEY,
      -- The chat the set was recorded in. Read by nothing yet: attribution,
      -- kept for the same reason the hypothesis table keeps it.
      thread_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      -- Null while active. A retired set refuses in new theses but keeps
      -- evaluating in ones already saved, so retiring is a soft leave.
      retired_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `;

  // One name, one set, whatever case it was typed in: "Devcon" and "devcon"
  // are the same calendar, and a second set under a casing variant would
  // silently split the occurrences between them.
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_trading_event_sets_name
    ON trading_event_sets (lower(name))
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS trading_event_occurrences (
      event_set_id TEXT NOT NULL,
      start_at INTEGER NOT NULL,
      end_at INTEGER NOT NULL,
      label TEXT,
      source TEXT NOT NULL,
      author TEXT NOT NULL CHECK (author IN ('user', 'agent')),
      created_at INTEGER NOT NULL,
      PRIMARY KEY (event_set_id, start_at)
    )
  `;

  // The flat rows the engines read: every occurrence of a few named sets,
  // ordered by end.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_trading_event_occurrences_set
    ON trading_event_occurrences (event_set_id, end_at)
  `;
});
