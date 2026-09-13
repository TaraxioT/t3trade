import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * The durable Substreams ingestion boundary — sources, committed blocks,
 * normalized pool events, and the detector-notification outbox.
 *
 * Identity rules this schema pins:
 *
 * - One source row per namespaced stream identity: environment + chain +
 *   package SHA-256 + module + module digest (module + params + schema
 *   version) + schema version. A cursor is NEVER reused after module
 *   semantics change — a new digest is a new source row.
 * - One block row per (source, block number): the committed, FINAL-block-only
 *   projection. `block_num` mirrors the decimal `block_number` as an INTEGER
 *   for contiguous range queries; `block_number` stays the canonical TEXT so
 *   uint64 identity never rides a JS number.
 * - Event identity is (environment, chain, block hash, tx hash, log index,
 *   module digest) — a height alone is not identity. Events are insert-only
 *   and duplicate-safe on replay.
 * - The outbox carries committed window notifications for detector
 *   evaluation; rows are acknowledged only after the dependent evaluation
 *   work exists.
 *
 * All four tables are written in ONE transaction per committed batch
 * (see SubstreamsSourceStore.commitBatch): crash before commit replays the
 * batch; crash after replays it duplicate-safely.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS substreams_sources (
      source_id                     TEXT PRIMARY KEY,
      environment_id                TEXT NOT NULL,
      chain_id                      TEXT NOT NULL,
      network                       TEXT NOT NULL,
      package_sha256                TEXT NOT NULL,
      module_name                   TEXT NOT NULL,
      module_digest                 TEXT NOT NULL,
      params_json                   TEXT NOT NULL,
      schema_version                INTEGER NOT NULL,
      cursor                        TEXT,
      state                         TEXT NOT NULL CHECK (state IN ('starting','healthy','stale','unhealthy')),
      state_reason                  TEXT NOT NULL DEFAULT '',
      final_watermark_block         TEXT,
      final_watermark_block_num     INTEGER,
      final_watermark_timestamp_ms  INTEGER,
      last_commit_at_ms             INTEGER,
      created_at_ms                 INTEGER NOT NULL,
      UNIQUE (environment_id, chain_id, package_sha256, module_name, module_digest)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS substreams_blocks (
      source_id       TEXT NOT NULL,
      environment_id  TEXT NOT NULL,
      block_number    TEXT NOT NULL,
      block_num       INTEGER NOT NULL,
      block_hash      TEXT NOT NULL,
      timestamp_ms    INTEGER NOT NULL,
      event_count     INTEGER NOT NULL,
      committed_at_ms INTEGER NOT NULL,
      PRIMARY KEY (source_id, block_number)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_substreams_blocks_range
      ON substreams_blocks (source_id, block_num)
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS substreams_pool_events (
      environment_id   TEXT NOT NULL,
      chain_id         TEXT NOT NULL,
      module_digest    TEXT NOT NULL,
      block_number     TEXT NOT NULL,
      block_num        INTEGER NOT NULL,
      block_hash       TEXT NOT NULL,
      transaction_hash TEXT NOT NULL,
      log_index        INTEGER NOT NULL,
      pool             TEXT NOT NULL,
      amount0_raw      TEXT NOT NULL,
      amount1_raw      TEXT NOT NULL,
      sqrt_price_x96   TEXT NOT NULL,
      sender           TEXT NOT NULL,
      recipient        TEXT NOT NULL,
      committed_at_ms  INTEGER NOT NULL,
      PRIMARY KEY (environment_id, chain_id, block_hash, transaction_hash, log_index, module_digest)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_substreams_pool_events_range
      ON substreams_pool_events (environment_id, module_digest, block_num)
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS substreams_outbox (
      outbox_id      TEXT PRIMARY KEY,
      source_id      TEXT NOT NULL,
      environment_id TEXT NOT NULL,
      from_block_num INTEGER NOT NULL,
      to_block_num   INTEGER NOT NULL,
      to_timestamp_ms INTEGER NOT NULL,
      created_at_ms  INTEGER NOT NULL,
      processed_at_ms INTEGER
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_substreams_outbox_pending
      ON substreams_outbox (environment_id, created_at_ms)
  `;
});
