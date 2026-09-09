import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(NodeSqliteClient.layerMemory());

/**
 * The registry's one behavioral claim: `{venue, asset}` is the identity, so
 * registering a replacement thread for a market is an upsert on the same row
 * rather than a second row. The `IF NOT EXISTS` guard makes a re-run a no-op.
 */
layer("076_TradingAnalystThreads", (it) => {
  it.effect("keys analyst threads by market and replaces on conflict", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({});

      yield* sql`
        INSERT INTO trading_analyst_threads (venue, asset, thread_id, created_at)
        VALUES ('hyperliquid', 'ETH', 'thread_a', 100)
      `;
      yield* sql`
        INSERT INTO trading_analyst_threads (venue, asset, thread_id, created_at)
        VALUES ('hyperliquid', 'ETH', 'thread_b', 200)
        ON CONFLICT (venue, asset) DO UPDATE SET
          thread_id = excluded.thread_id,
          created_at = excluded.created_at
      `;

      const rows = yield* sql<{ readonly thread_id: string; readonly created_at: number }>`
        SELECT thread_id, created_at FROM trading_analyst_threads
        WHERE venue = 'hyperliquid' AND asset = 'ETH'
      `;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.thread_id, "thread_b");
      assert.equal(rows[0]?.created_at, 200);

      // A second run over an existing table is a no-op, not a failure.
      yield* runMigrations({});
    }),
  );
});
