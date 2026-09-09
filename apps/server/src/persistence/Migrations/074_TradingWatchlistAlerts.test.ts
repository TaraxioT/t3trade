import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(NodeSqliteClient.layerMemory());

/**
 * The claim worth testing is the round trip, not the DDL: a watch armed under
 * the v073 schema must come out of the rebuild byte-identical on every column
 * it already had, with the new columns reading as the behaviour it already
 * had — `deliver='wake'`, `venue='hyperliquid'`, its asset lifted out of
 * `watch_json`, its account resolved through its mission. And the PRAGMA
 * guard must make a second run a no-op, because fork databases land
 * migrations one head at a time.
 */
layer("074_TradingWatchlistAlerts", (it) => {
  const watchJson = JSON.stringify({
    type: "candle_close",
    market: "ETH",
    interval: "5m",
    direction: "above",
    price: 3000,
  });

  const seedV73 = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 73 });
    yield* sql`
      INSERT OR IGNORE INTO trading_missions (
        mission_id, user_id, trading_account_id, instruction, market,
        harness_json, status, control_json, authority_version, version,
        created_at, updated_at
      ) VALUES (
        'm1', 'local', 'acct_1', 'trade', 'ETH', '{}', 'waiting', '{}', 1, 1, 1, 1
      )
    `;
    // A fully decorated v073 row: every nullable column populated, so the
    // rebuild's carry-over is proven column by column, not just on defaults.
    yield* sql`
      INSERT OR IGNORE INTO trading_watches (
        watch_id, mission_id, watch_json, status, version, created_at, updated_at,
        armed_reason, baseline_signature, last_observed_value, last_evaluated_at,
        prediction_version, armed_with_position, next_evaluate_at
      ) VALUES (
        'w1', 'm1', ${watchJson}, 'active', 3, 100, 200,
        'profit_target', 'out', 42.5, 190, 7, 1, 999
      )
    `;
    // A marketless watch on a mission the missions table does not know —
    // the orphan case the LEFT JOIN backfill must survive with nulls.
    yield* sql`
      INSERT OR IGNORE INTO trading_watches (
        watch_id, mission_id, watch_json, status, version, created_at, updated_at
      ) VALUES (
        'w2', 'm_gone', '{"type":"scheduled_reassessment","runAt":123}',
        'triggered', 1, 10, 20
      )
    `;
  });

  it.effect("rebuilds trading_watches with the old rows byte-identical", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedV73;
      yield* runMigrations({ toMigrationInclusive: 74 });

      const rows = yield* sql<{
        readonly watch_id: string;
        readonly mission_id: string | null;
        readonly watch_json: string;
        readonly status: string;
        readonly version: number;
        readonly created_at: number;
        readonly updated_at: number;
        readonly armed_reason: string | null;
        readonly baseline_signature: string | null;
        readonly last_observed_value: number | null;
        readonly last_evaluated_at: number | null;
        readonly prediction_version: number | null;
        readonly armed_with_position: number | null;
        readonly next_evaluate_at: number | null;
        readonly venue: string;
        readonly asset: string | null;
        readonly account_id: string | null;
        readonly deliver: string;
        readonly rearm_json: string | null;
      }>`SELECT * FROM trading_watches WHERE watch_id IN ('w1', 'w2') ORDER BY watch_id`;

      assert.equal(rows.length, 2);
      const [w1, w2] = rows;

      // Every v073 column, carried over unchanged.
      assert.deepStrictEqual(
        {
          watch_id: w1?.watch_id,
          mission_id: w1?.mission_id,
          watch_json: w1?.watch_json,
          status: w1?.status,
          version: w1?.version,
          created_at: w1?.created_at,
          updated_at: w1?.updated_at,
          armed_reason: w1?.armed_reason,
          baseline_signature: w1?.baseline_signature,
          last_observed_value: w1?.last_observed_value,
          last_evaluated_at: w1?.last_evaluated_at,
          prediction_version: w1?.prediction_version,
          armed_with_position: w1?.armed_with_position,
          next_evaluate_at: w1?.next_evaluate_at,
        },
        {
          watch_id: "w1",
          mission_id: "m1",
          watch_json: watchJson,
          status: "active",
          version: 3,
          created_at: 100,
          updated_at: 200,
          armed_reason: "profit_target",
          baseline_signature: "out",
          last_observed_value: 42.5,
          last_evaluated_at: 190,
          prediction_version: 7,
          armed_with_position: 1,
          next_evaluate_at: 999,
        },
      );

      // The new columns read as the behaviour the row already had.
      assert.equal(w1?.venue, "hyperliquid");
      assert.equal(w1?.asset, "ETH");
      assert.equal(w1?.account_id, "acct_1");
      assert.equal(w1?.deliver, "wake");
      assert.isNull(w1?.rearm_json);

      // Marketless watch on an orphaned mission: nulls, never a failure.
      assert.equal(w2?.watch_id, "w2");
      assert.equal(w2?.mission_id, "m_gone");
      assert.isNull(w2?.asset);
      assert.isNull(w2?.account_id);
      assert.equal(w2?.deliver, "wake");

      // A watch with no mission is now legal — the whole point of the rebuild.
      yield* sql`
        INSERT INTO trading_watches (
          watch_id, mission_id, watch_json, status, version, created_at,
          updated_at, venue, asset, deliver
        ) VALUES ('w3', NULL, '{}', 'active', 1, 1, 1, 'hyperliquid', 'SOL', 'notify')
      `;
      yield* sql`DELETE FROM trading_watches WHERE watch_id = 'w3'`;
    }),
  );

  it.effect("recreates the status indexes and creates the two new tables", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedV73;
      yield* runMigrations({ toMigrationInclusive: 74 });

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND tbl_name = 'trading_watches'
      `;
      assert.isTrue(indexes.some((row) => row.name === "idx_trading_watches_mission_status"));
      assert.isTrue(indexes.some((row) => row.name === "idx_trading_watches_status"));

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table'
      `;
      assert.isTrue(tables.some((row) => row.name === "trading_watchlist"));
      assert.isTrue(tables.some((row) => row.name === "trading_alert_events"));
    }),
  );

  it.effect("a second run is a no-op via the deliver-column guard", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedV73;
      yield* runMigrations({ toMigrationInclusive: 74 });
      const before = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM trading_watches
      `;
      // Re-run the migration body directly (the runner will not repeat it, but
      // a fork database that saw a partial head might): the guard must hold.
      const migration = yield* Effect.promise(() => import("./074_TradingWatchlistAlerts.ts"));
      yield* migration.default;

      const after = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM trading_watches
      `;
      assert.equal(after[0]?.n, before[0]?.n);
    }),
  );
});
