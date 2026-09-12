import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * The external-source revision boundary — one immutable document revision per
 * row.
 *
 * External evidence (official feeds, schedule documents, statements) lands
 * here as content-derived revisions: a correction or a retraction is a NEW row
 * linked to its predecessor through `correction_of` / `retracted`, never an
 * in-place edit, so no capture can rewrite what an earlier capture recorded.
 *
 * `first_observed_at_ms` is when THIS server first saw that revision — the
 * honesty anchor for as-of research — and is deliberately distinct from the
 * source's own `published_at_ms`, which the source may not state at all.
 * `time_precision` uses the event-set vocabulary (`instant`, `window`,
 * `date`): what the document's own time claim is shaped like, never a
 * precision nobody declared.
 *
 * `payload_json` retains the document bytes verbatim as inert data; nothing
 * derived from it is ever evaluated as an instruction. Consumers reference a
 * revision by id and hash; raw bytes are read back through the store, never
 * inlined into events or read models.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS external_source_revisions (
      revision_id          TEXT PRIMARY KEY,
      environment_id       TEXT NOT NULL,
      source_kind          TEXT NOT NULL,
      document_identity    TEXT NOT NULL,
      source_url           TEXT NOT NULL,
      content_sha256       TEXT NOT NULL,
      published_at_ms      INTEGER,
      time_precision       TEXT NOT NULL CHECK (time_precision IN ('instant','window','date')),
      first_observed_at_ms INTEGER NOT NULL,
      capture_ms           INTEGER NOT NULL,
      correction_of        TEXT,
      retracted            INTEGER NOT NULL DEFAULT 0,
      payload_json         TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_external_source_revisions_document
      ON external_source_revisions (environment_id, source_kind, document_identity, first_observed_at_ms DESC)
  `;
});
