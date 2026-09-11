import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * The Forge evidence boundary — one retained fetch per row.
 *
 * Raw observations are persisted against an evidence id, not stuffed into
 * events or evaluations: an evaluation names its evidence ids and consumers
 * read the payload back by id through authenticated transport. The row
 * carries the provenance a retained window needs to be believed on its own —
 * endpoint (never credentials), deployment, pinned block, window, digest —
 * while `payload_json` holds the normalized observations themselves.
 *
 * `historical` marks a window retained for comparison, labeled with its
 * original block and time; nothing about the flag changes how the row is
 * served, only what downstream policy may do with it.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS forge_source_evidence (
      evidence_id        TEXT PRIMARY KEY,
      environment_id     TEXT NOT NULL,
      pool_id            TEXT NOT NULL,
      historical         INTEGER NOT NULL DEFAULT 0,
      endpoint           TEXT NOT NULL,
      deployment         TEXT NOT NULL,
      pinned_block       INTEGER NOT NULL,
      pinned_block_hash  TEXT,
      window_start       INTEGER NOT NULL,
      window_end         INTEGER NOT NULL,
      fetched_at_ms      INTEGER NOT NULL,
      digest             TEXT NOT NULL,
      observation_count  INTEGER NOT NULL,
      payload_json       TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_forge_evidence_env_time
      ON forge_source_evidence (environment_id, fetched_at_ms)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_forge_evidence_pool_window
      ON forge_source_evidence (pool_id, window_end)
  `;
});
