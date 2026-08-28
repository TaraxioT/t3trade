import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(NodeSqliteClient.layerMemory());

/**
 * Two claims: an order written under v077 survives the column with its trigger
 * reading null, and a second run is a no-op. Fork databases land migrations one
 * head at a time, so an unguarded ALTER is a crash on the next boot.
 */
layer("078_TradingOrderTriggerPrice", (it) => {
  // The layer is shared across the cases below, so each seeds its own cloid:
  // `trading_orders` is keyed on (account_id, cloid) and a reused one collides.
  const seedV77 = (cloid: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 77 });
      yield* sql`
        INSERT INTO trading_orders (
          mission_id, cloid, order_id, market, side, limit_price,
          remaining_size, reduce_only, observed_at, account_id, venue, asset
        ) VALUES (
          NULL, ${cloid}, 11, 'ETH', 'sell', 2447.3, 0.35, 1, 1000,
          'acct_1', 'hyperliquid', 'ETH'
        )
      `;
    });

  it.effect("adds a nullable trigger price and leaves existing orders alone", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedV77("cloid_pre_078");
      yield* runMigrations({ toMigrationInclusive: 78 });

      const rows = yield* sql<{
        readonly limit_price: number;
        readonly trigger_price: number | null;
      }>`
        SELECT limit_price, trigger_price FROM trading_orders WHERE cloid = 'cloid_pre_078'
      `;
      assert.strictEqual(rows.length, 1);
      // An order that predates the column has no trigger to report, and null
      // is the honest answer. The next reconcile pass rewrites the table from
      // the exchange and fills it in.
      assert.strictEqual(rows[0]!.trigger_price, null);
      assert.strictEqual(rows[0]!.limit_price, 2447.3);
    }),
  );

  it.effect("is a no-op on a database that already has the column", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedV77("cloid_rerun_078");
      yield* runMigrations({ toMigrationInclusive: 78 });
      yield* sql`
        UPDATE trading_orders SET trigger_price = 2472 WHERE cloid = 'cloid_rerun_078'
      `;
      yield* runMigrations({ toMigrationInclusive: 78 });

      const rows = yield* sql<{ readonly trigger_price: number | null }>`
        SELECT trigger_price FROM trading_orders WHERE cloid = 'cloid_rerun_078'
      `;
      assert.strictEqual(rows[0]!.trigger_price, 2472);
    }),
  );
});
