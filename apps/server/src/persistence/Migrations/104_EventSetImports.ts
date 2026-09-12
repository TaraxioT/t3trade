import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Durable lineage for event sets imported from retained external-source
 * revisions (`external_source_revisions`, migration 103).
 *
 * One row per completed import: which event set was written, from which
 * ordered revision ids, under which content digest. The event set itself
 * lives in the authored tables (`trading_event_sets` /
 * `trading_event_occurrences`, migration 086/092) — an import writes through
 * `TradingEventService.record` exactly like an agent-authored set, so this
 * table is provenance, never a second calendar.
 *
 * `import_id` is content-derived (event set name + revision ids + imported
 * instant) by the importing service, so the same projection replayed at the
 * same instant is the same row and a genuine re-import (new instant or new
 * revisions) is a new row. `capture_status`/`capture_note` record the capture
 * attempt that preceded the import — including its failure — because an
 * import over retained revisions while the source is unreachable is honest
 * only if the staleness is stated where the lineage is read.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS trading_event_set_imports (
      import_id                TEXT PRIMARY KEY,
      event_set_name           TEXT NOT NULL,
      source_kind              TEXT NOT NULL,
      revision_ids_json        TEXT NOT NULL,
      event_set_content_sha256 TEXT NOT NULL,
      imported_at_ms           INTEGER NOT NULL,
      capture_status           TEXT NOT NULL,
      capture_note             TEXT
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_trading_event_set_imports_set
      ON trading_event_set_imports (event_set_name, imported_at_ms DESC)
  `;
});
