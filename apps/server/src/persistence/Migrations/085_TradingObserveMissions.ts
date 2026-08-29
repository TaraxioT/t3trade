import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Two columns for the live narrative: what a validation last concluded, and
 * what a mission is for.
 *
 * ## `last_comparison`
 *
 * A verdict change is an event, and an event is a difference between two
 * evaluations. The running verdict was recomputed from the ledger on every
 * read and stored nowhere, so nothing could tell "still worse than the
 * backtest" from "worse than the backtest as of this bar" — which are the same
 * number and opposite news. This is the previous reading, written on the pass
 * that produced it, and it is nullable because every validation armed before
 * this migration has no previous reading and must not be reported as having
 * changed on its first pass after the upgrade.
 *
 * ## `purpose`
 *
 * A mission that exists to watch rather than to trade. Stored rather than
 * derived from the mandate: the mandate's words are the model's to read, and
 * "structurally unable to trade" is a fact the server enforces on every
 * execution call, so it may not depend on a regex over prose that a later turn
 * could rewrite. `trade` is the default and is every mission that already
 * exists, which is why the column carries one rather than being backfilled by
 * a second statement.
 *
 * It sits on the row rather than inside `control_json` because `control` is the
 * mutable half of a mission — entries on, entries off, pause after close — and
 * purpose is fixed at creation. Putting an immutable fact in the mutable struct
 * would invite a setter that must never exist.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE trading_thesis_validations ADD COLUMN last_comparison TEXT`;

  yield* sql`
    ALTER TABLE trading_missions ADD COLUMN purpose TEXT NOT NULL DEFAULT 'trade'
  `;
});
