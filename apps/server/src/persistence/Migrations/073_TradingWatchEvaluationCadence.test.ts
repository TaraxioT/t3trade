import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(NodeSqliteClient.layerMemory());

/**
 * Plan 38 phase 3's cadence column.
 *
 * The claim worth testing is the null contract, not the DDL: every watch armed
 * before this build must keep evaluating on every sweep, so the column has to
 * arrive null on rows that already exist — and re-running the migration must
 * be a no-op via the PRAGMA guard, because fork databases land migrations one
 * head at a time.
 */
layer("073_TradingWatchEvaluationCadence", (it) => {
  it.effect("adds a null next_evaluate_at to watches that predate it", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 72 });
      yield* sql`
        INSERT INTO trading_watches (
          watch_id, mission_id, watch_json, status, version, created_at, updated_at
        ) VALUES ('w1', 'm1', '{}', 'armed', 1, 1, 1)
      `;

      yield* runMigrations({ toMigrationInclusive: 73 });

      const rows = yield* sql<{ readonly next_evaluate_at: number | null }>`
        SELECT next_evaluate_at FROM trading_watches WHERE mission_id = 'm1'
      `;
      // Null reads as "evaluate on every sweep" — the behaviour the row
      // already had.
      assert.equal(rows.length, 1);
      assert.isNull(rows[0]?.next_evaluate_at);

      // The PRAGMA guard makes a second run a no-op.
      yield* runMigrations({ toMigrationInclusive: 73 });
      const after = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM trading_watches
      `;
      assert.equal(after[0]?.n, 1);
    }),
  );
});
