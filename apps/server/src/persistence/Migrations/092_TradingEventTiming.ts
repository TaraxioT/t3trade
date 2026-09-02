import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Event timing: what the recorded timestamps claim, and the read-back that
 * proves the claim was checked.
 *
 * ## The precision column
 *
 * A research mission once recorded twenty hard forks as 24-hour spans
 * starting at 00:00:00 UTC: the model supplied date-only starts and omitted
 * the ends, and the parser padded each to a midnight it invented. The spans
 * were not lies about the forks, but they were not what the research
 * established either, and every study anchored on them inherited the fiction.
 *
 * `time_precision` is the repair: `instant` (one exact moment), `window` (two
 * exact moments), or `date` (whole days, nothing finer). The parser writes it
 * for every new occurrence and refuses the shapes that used to be padded.
 * The column is NULLable on purpose: rows recorded before it existed are
 * spans the old parser produced, and they decode with the field ABSENT
 * rather than being re-derived — a consumer reading them sees "recorded as a
 * span", never a precision nobody declared at the time.
 *
 * ## The confirmation table
 *
 * `trading_event_confirmations` is the durable half of the read-back protocol:
 * `preview` parses a record/add payload, reads the normalized occurrences
 * back, and persists a pending row keyed by the SHA-256 digest of the
 * canonical payload; the following `record`/`add` (with `requireReadBack`)
 * must present that same digest, unchanged, and consumes the row on success.
 * The primary key scopes a digest to its thread: a confirmation read in one
 * conversation confirms nothing in another, and a replayed digest finds its
 * row already consumed and refuses.
 *
 * No foreign key here reaches an execution table, and nothing that reports
 * real money reads either addition. The wall migration 086 drew stays
 * exactly where it was.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Nullable: NULL is the legacy marker, read back as the field being absent.
  // New writes always carry one of the three kinds.
  yield* sql`
    ALTER TABLE trading_event_occurrences ADD COLUMN time_precision TEXT
      CHECK (time_precision IN ('instant', 'window', 'date'))
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS trading_event_confirmations (
      -- The chat the preview ran in. A digest confirms only within the thread
      -- that read it back; the composite primary key enforces the scoping.
      thread_id TEXT NOT NULL,
      digest TEXT NOT NULL,
      -- pending | consumed. Consumed rows stay: a replay must be recognized
      -- as a replay, not met with "no such confirmation".
      status TEXT NOT NULL CHECK (status IN ('pending', 'consumed')),
      created_at INTEGER NOT NULL,
      consumed_at INTEGER,
      PRIMARY KEY (thread_id, digest)
    )
  `;
});
