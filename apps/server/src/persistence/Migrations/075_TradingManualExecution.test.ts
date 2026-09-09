import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(NodeSqliteClient.layerMemory());

/**
 * The claim worth testing is the round trip over realistic v074 rows: every
 * pre-existing column of the six execution tables comes out of the rebuild
 * byte-identical, the backfills read as the ownership the rows already had
 * (`account_id` through the owning mission, `venue='hyperliquid'`, `asset`
 * from the `market` column where one exists), a mission-less row is now legal,
 * the D4 exclusivity index admits two active missions on DIFFERENT markets and
 * refuses two on the same one, and a second run of the migration body is a
 * no-op — fork databases land migrations one head at a time.
 */
layer("075_TradingManualExecution", (it) => {
  const seedV74 = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 74 });
    yield* sql`
      INSERT OR IGNORE INTO trading_missions (
        mission_id, user_id, trading_account_id, instruction, market,
        harness_json, status, control_json, authority_version, version,
        created_at, updated_at
      ) VALUES (
        'm1', 'local', 'acct_1', 'trade', 'ETH', '{}', 'position_open', '{}', 1, 1, 1, 1
      )
    `;
    // Fully decorated rows: every nullable column populated, so the carry-over
    // is proven column by column rather than only on defaults.
    yield* sql`
      INSERT OR IGNORE INTO trading_execution_records (
        execution_id, mission_id, execution_sequence, action_type, cloid,
        idempotency_key, market, side, size, limit_price, time_in_force,
        reduce_only, signer_address, status, order_results_json,
        created_at, updated_at, stop_price, planned_loss_at_stop_usd
      ) VALUES (
        'exec_1', 'm1', 4, 'open', '0xaaaa', 'idem_m1_4_open', 'ETH', 'buy',
        0.25, 3000.5, 'ioc', 0, '0xsigner', 'filled', '[]', 100, 200, 2950.25, 12.5
      )
    `;
    // An orphan: the mission the row names is gone. The backfill must survive
    // it with the sentinel, never fail the rebuild.
    yield* sql`
      INSERT OR IGNORE INTO trading_execution_records (
        execution_id, mission_id, execution_sequence, action_type, cloid,
        idempotency_key, market, side, size, limit_price, time_in_force,
        reduce_only, signer_address, status, order_results_json,
        created_at, updated_at
      ) VALUES (
        'exec_orphan', 'm_gone', 1, 'close', '0xbbbb', 'idem_gone_1_close', 'BTC',
        'sell', 0.1, 60000, 'ioc', 1, '0xsigner', 'filled', '[]', 50, 60
      )
    `;
    yield* sql`
      INSERT OR IGNORE INTO trading_orders (
        mission_id, cloid, order_id, market, side, limit_price, remaining_size,
        reduce_only, observed_at
      ) VALUES ('m1', '0xcccc', 42, 'ETH', 'sell', 3100, 0.25, 1, 300)
    `;
    yield* sql`
      INSERT OR IGNORE INTO trading_fills (
        fill_id, mission_id, execution_id, cloid, order_id, market, side,
        filled_size, avg_fill_price, fee_usd, fee_token, traded_at, observed_at,
        closed_pnl, direction, crossed
      ) VALUES (
        '42-7', 'm1', 'exec_1', '0xaaaa', 42, 'ETH', 'buy',
        0.25, 3000.75, 0.33, 'USDC', 150, 160, -1.25, 'Open Long', 1
      )
    `;
    yield* sql`
      INSERT OR IGNORE INTO trading_position_snapshots (
        mission_id, market, size, entry_price, unrealised_pnl, margin_used,
        protected_size, observed_at, liquidation_price, mark_px,
        peak_unrealised_pnl, trough_unrealised_pnl, opened_at, leverage
      ) VALUES (
        'm1', 'ETH', 0.25, 3000.75, 4.5, 37.5, 0.25, 400, 2800.1, 3018.2,
        6.75, -2.5, 150, 20
      )
    `;
    yield* sql`
      INSERT OR IGNORE INTO trading_risk_reservations (
        reservation_id, mission_id, execution_id, cloid, action_type,
        reserved_risk_usd, status, reserved_at, released_at
      ) VALUES ('res_1', 'm1', 'exec_1', '0xaaaa', 'open', 14.2, 'released', 100, 210)
    `;
    yield* sql`
      INSERT OR IGNORE INTO trading_account_snapshots (
        mission_id, master_address, account_value, margin_used, withdrawable,
        positions_json, observed_at
      ) VALUES ('m1', '0xmaster', 104.2, 37.5, 60.1, '[]', 400)
    `;
  });

  it.effect("rebuilds the six tables with old rows byte-identical and backfills correct", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedV74;
      yield* runMigrations({ toMigrationInclusive: 75 });

      const execs = yield* sql<{
        readonly execution_id: string;
        readonly mission_id: string | null;
        readonly execution_sequence: number;
        readonly action_type: string;
        readonly cloid: string;
        readonly idempotency_key: string;
        readonly market: string;
        readonly side: string;
        readonly size: number;
        readonly limit_price: number;
        readonly time_in_force: string;
        readonly reduce_only: number;
        readonly signer_address: string;
        readonly status: string;
        readonly order_results_json: string;
        readonly created_at: number;
        readonly updated_at: number;
        readonly stop_price: number | null;
        readonly planned_loss_at_stop_usd: number | null;
        readonly account_id: string;
        readonly venue: string;
        readonly asset: string | null;
      }>`SELECT * FROM trading_execution_records ORDER BY execution_id`;
      assert.equal(execs.length, 2);
      const [exec1, orphan] = execs;
      assert.deepStrictEqual(
        {
          execution_id: exec1?.execution_id,
          mission_id: exec1?.mission_id,
          execution_sequence: exec1?.execution_sequence,
          action_type: exec1?.action_type,
          cloid: exec1?.cloid,
          idempotency_key: exec1?.idempotency_key,
          market: exec1?.market,
          side: exec1?.side,
          size: exec1?.size,
          limit_price: exec1?.limit_price,
          time_in_force: exec1?.time_in_force,
          reduce_only: exec1?.reduce_only,
          signer_address: exec1?.signer_address,
          status: exec1?.status,
          order_results_json: exec1?.order_results_json,
          created_at: exec1?.created_at,
          updated_at: exec1?.updated_at,
          stop_price: exec1?.stop_price,
          planned_loss_at_stop_usd: exec1?.planned_loss_at_stop_usd,
        },
        {
          execution_id: "exec_1",
          mission_id: "m1",
          execution_sequence: 4,
          action_type: "open",
          cloid: "0xaaaa",
          idempotency_key: "idem_m1_4_open",
          market: "ETH",
          side: "buy",
          size: 0.25,
          limit_price: 3000.5,
          time_in_force: "ioc",
          reduce_only: 0,
          signer_address: "0xsigner",
          status: "filled",
          order_results_json: "[]",
          created_at: 100,
          updated_at: 200,
          stop_price: 2950.25,
          planned_loss_at_stop_usd: 12.5,
        },
      );
      assert.equal(exec1?.account_id, "acct_1");
      assert.equal(exec1?.venue, "hyperliquid");
      assert.equal(exec1?.asset, "ETH");
      // The orphan survives with the sentinel account, never a failure.
      assert.equal(orphan?.execution_id, "exec_orphan");
      assert.equal(orphan?.account_id, "unattributed");
      assert.equal(orphan?.asset, "BTC");

      const orders = yield* sql<Record<string, unknown>>`SELECT * FROM trading_orders`;
      assert.deepStrictEqual(orders, [
        {
          mission_id: "m1",
          cloid: "0xcccc",
          order_id: 42,
          market: "ETH",
          side: "sell",
          limit_price: 3100,
          remaining_size: 0.25,
          reduce_only: 1,
          observed_at: 300,
          account_id: "acct_1",
          venue: "hyperliquid",
          asset: "ETH",
        },
      ]);

      const fills = yield* sql<Record<string, unknown>>`SELECT * FROM trading_fills`;
      assert.deepStrictEqual(fills, [
        {
          fill_id: "42-7",
          mission_id: "m1",
          execution_id: "exec_1",
          cloid: "0xaaaa",
          order_id: 42,
          market: "ETH",
          side: "buy",
          filled_size: 0.25,
          avg_fill_price: 3000.75,
          fee_usd: 0.33,
          fee_token: "USDC",
          traded_at: 150,
          observed_at: 160,
          closed_pnl: -1.25,
          direction: "Open Long",
          crossed: 1,
          account_id: "acct_1",
          venue: "hyperliquid",
          asset: "ETH",
        },
      ]);

      const positions = yield* sql<
        Record<string, unknown>
      >`SELECT * FROM trading_position_snapshots`;
      assert.deepStrictEqual(positions, [
        {
          mission_id: "m1",
          market: "ETH",
          size: 0.25,
          entry_price: 3000.75,
          unrealised_pnl: 4.5,
          margin_used: 37.5,
          protected_size: 0.25,
          observed_at: 400,
          liquidation_price: 2800.1,
          mark_px: 3018.2,
          peak_unrealised_pnl: 6.75,
          trough_unrealised_pnl: -2.5,
          opened_at: 150,
          leverage: 20,
          account_id: "acct_1",
          venue: "hyperliquid",
          asset: "ETH",
        },
      ]);

      const reservations = yield* sql<
        Record<string, unknown>
      >`SELECT * FROM trading_risk_reservations`;
      assert.deepStrictEqual(reservations, [
        {
          reservation_id: "res_1",
          mission_id: "m1",
          execution_id: "exec_1",
          cloid: "0xaaaa",
          action_type: "open",
          reserved_risk_usd: 14.2,
          status: "released",
          reserved_at: 100,
          released_at: 210,
          account_id: "acct_1",
          venue: "hyperliquid",
          asset: null,
        },
      ]);

      const snapshots = yield* sql<
        Record<string, unknown>
      >`SELECT * FROM trading_account_snapshots`;
      assert.deepStrictEqual(snapshots, [
        {
          mission_id: "m1",
          master_address: "0xmaster",
          account_value: 104.2,
          margin_used: 37.5,
          withdrawable: 60.1,
          positions_json: "[]",
          observed_at: 400,
          account_id: "acct_1",
          venue: "hyperliquid",
          asset: null,
        },
      ]);

      // Missions gained the venue axis, backfilled.
      const missions = yield* sql<{ readonly venue: string }>`
        SELECT venue FROM trading_missions WHERE mission_id = 'm1'
      `;
      assert.equal(missions[0]?.venue, "hyperliquid");
    }),
  );

  it.effect("manual rows are now legal, and per-market position uniqueness holds", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedV74;
      yield* runMigrations({ toMigrationInclusive: 75 });

      // A NULL-mission execution record and position row: the whole point.
      yield* sql`
        INSERT INTO trading_execution_records (
          execution_id, mission_id, execution_sequence, action_type, cloid,
          idempotency_key, market, side, size, limit_price, time_in_force,
          reduce_only, signer_address, status, order_results_json,
          created_at, updated_at, account_id, venue, asset
        ) VALUES (
          'exec_manual', NULL, 0, 'open', '0xdddd', 'idem_manual_acct_1_0_open',
          'SOL', 'buy', 1, 150, 'ioc', 0, '0xsigner', 'filled', '[]', 1, 1,
          'acct_1', 'hyperliquid', 'SOL'
        )
      `;
      yield* sql`
        INSERT INTO trading_position_snapshots (
          mission_id, market, size, entry_price, unrealised_pnl, margin_used,
          protected_size, observed_at, account_id, venue, asset
        ) VALUES (NULL, 'SOL', 1, 150, 0, 10, 1, 1, 'acct_1', 'hyperliquid', 'SOL')
      `;
      // One manual position per market per account.
      const duplicate = yield* sql`
        INSERT INTO trading_position_snapshots (
          mission_id, market, size, entry_price, unrealised_pnl, margin_used,
          protected_size, observed_at, account_id, venue, asset
        ) VALUES (NULL, 'SOL', 2, 151, 0, 20, 2, 2, 'acct_1', 'hyperliquid', 'SOL')
      `.pipe(
        Effect.as("inserted"),
        Effect.orElseSucceed(() => "refused"),
      );
      assert.equal(duplicate, "refused");
    }),
  );

  it.effect("the exclusivity index is per-market, not per-user", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedV74;
      yield* runMigrations({ toMigrationInclusive: 75 });

      // m1 is active on ETH. A second active mission on BTC must be admitted…
      yield* sql`
        INSERT INTO trading_missions (
          mission_id, user_id, trading_account_id, instruction, market,
          harness_json, status, control_json, authority_version, version,
          created_at, updated_at, venue
        ) VALUES (
          'm2', 'local', 'acct_1', 'trade', 'BTC', '{}', 'analysing', '{}', 1, 1,
          2, 2, 'hyperliquid'
        )
      `;
      // …a second active mission on ETH must not…
      const clash = yield* sql`
        INSERT INTO trading_missions (
          mission_id, user_id, trading_account_id, instruction, market,
          harness_json, status, control_json, authority_version, version,
          created_at, updated_at, venue
        ) VALUES (
          'm3', 'local', 'acct_1', 'trade', 'ETH', '{}', 'analysing', '{}', 1, 1,
          3, 3, 'hyperliquid'
        )
      `.pipe(
        Effect.as("inserted"),
        Effect.orElseSucceed(() => "refused"),
      );
      assert.equal(clash, "refused");
      // …and a terminal mission on ETH is history, never a blocker.
      yield* sql`
        INSERT INTO trading_missions (
          mission_id, user_id, trading_account_id, instruction, market,
          harness_json, status, control_json, authority_version, version,
          created_at, updated_at, venue
        ) VALUES (
          'm4', 'local', 'acct_1', 'trade', 'ETH', '{}', 'revoked', '{}', 1, 1,
          4, 4, 'hyperliquid'
        )
      `;
    }),
  );

  it.effect("the whole chain runs from empty and a re-run of the body is a no-op", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // From empty: nothing seeded, every migration in order.
      yield* runMigrations({});

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table'
      `;
      for (const table of [
        "trading_execution_records",
        "trading_orders",
        "trading_fills",
        "trading_position_snapshots",
        "trading_risk_reservations",
        "trading_account_snapshots",
      ]) {
        assert.isTrue(
          tables.some((row) => row.name === table),
          `missing ${table}`,
        );
      }

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'index'
      `;
      for (const index of [
        "idx_trading_execution_records_mission",
        "idx_trading_execution_records_cloid",
        "idx_trading_execution_records_mission_sequence",
        "idx_trading_execution_records_account",
        "idx_trading_orders_mission",
        "idx_trading_fills_mission",
        "idx_trading_fills_cloid",
        "idx_trading_fills_account",
        "idx_trading_position_snapshots_mission",
        "idx_trading_position_snapshots_manual",
        "idx_trading_risk_reservations_mission",
        "idx_trading_risk_reservations_execution",
        "idx_trading_risk_reservations_account",
        // Since migration 079 the held-set table owns D4 exclusivity; the
        // old one-column missions index is gone at head.
        "idx_trading_mission_markets_mission",
      ]) {
        assert.isTrue(
          indexes.some((row) => row.name === index),
          `missing ${index}`,
        );
      }
      assert.isFalse(
        indexes.some((row) => row.name === "idx_trading_missions_one_active_per_user"),
      );
      assert.isFalse(
        indexes.some((row) => row.name === "idx_trading_missions_one_active_per_market"),
        "the pre-079 exclusivity index must be dropped at head",
      );
      assert.isTrue(
        indexes.some((row) => row.name === "idx_trading_mission_markets_held"),
        "the UNIQUE held-set index is the current exclusivity constraint",
      );

      // Re-run the migration body directly (the runner will not repeat it, but
      // a fork database that saw a partial head might): the guard must hold.
      const before = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM pragma_table_info('trading_execution_records')
      `;
      const migration = yield* Effect.promise(() => import("./075_TradingManualExecution.ts"));
      yield* migration.default;
      const after = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM pragma_table_info('trading_execution_records')
      `;
      assert.equal(after[0]?.n, before[0]?.n);
    }),
  );
});
