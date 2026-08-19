import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * `next_evaluate_at` on `trading_watches`: when should this watch next be
 * evaluated?
 *
 * Plan 38 phase 3 gives derived-metric watches a per-metric cadence — a
 * trailing 7-day funding mean observed once an hour costs nothing until the
 * number does something. The evaluator sweeps every ~2s; without a due time
 * every derived watch would recompute on every sweep and the cadence the plan
 * prices its budget on would not exist.
 *
 * Null on every existing row, which reads as "evaluate on every sweep" — the
 * behaviour those rows already have. No backfill and no payload migration:
 * `watch_json` decodes as before because a new condition variant is additive.
 *
 * The market archive DB is a separate file with its own `meta.schema_version`
 * (bumped via `ARCHIVE_SCHEMA_VERSION` in trading/archive/db.ts). It must
 * never join this app migration chain — that separation is what lets the
 * archiver be killed, restarted, and version-bumped independently of a server
 * release.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(trading_watches)`;

  if (!columns.some((column) => column.name === "next_evaluate_at")) {
    yield* sql`ALTER TABLE trading_watches ADD COLUMN next_evaluate_at INTEGER`;
  }
});
