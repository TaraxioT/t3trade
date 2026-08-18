import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * `armed_with_position` on `trading_watches`: was the mission holding when
 * this watch was armed?
 *
 * Migration 069 gave the runtime's own projection watches a version so a plan
 * revision could sweep exactly the pair it replaced. This is the same problem
 * one level out: a level the MODEL armed carries no linkage at all, so nothing
 * could tell an entry trigger armed while flat from a proxy for the position's
 * target armed while holding.
 *
 * The measured case: a mission armed a bare `price_cross` at the price its
 * $0.70 target reached, closed the position, and the runtime retired the
 * position-linked `pnl_above` and left the price level standing on a flat
 * book. It fired at a position that no longer existed, and only the model
 * cancelling it by hand twenty seconds later stopped it.
 *
 * Keying off the watch KIND cannot fix that — a price level is exactly the
 * thing that is still legitimate when flat. Position linkage can: a level
 * armed while a position was open belongs to that position's plan and goes
 * with it; one armed while flat is a standing entry trigger and survives.
 *
 * Null on every existing row, which reads as "not linked" — the behaviour
 * those rows already had.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(trading_watches)`;

  if (!columns.some((column) => column.name === "armed_with_position")) {
    yield* sql`ALTER TABLE trading_watches ADD COLUMN armed_with_position INTEGER`;
  }
});
