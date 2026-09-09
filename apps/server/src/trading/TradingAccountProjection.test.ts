/**
 * TradingAccountProjection tests — final-form Phase 3.
 *
 * The view is derived on read from the reconciled tables, so the tests seed
 * those tables directly (the TradingBudgetReader pattern) and assert the
 * account-addressed assembly: `MarketRef` identity, protection provenance,
 * owning authority, and the latest balance per account. The invalidation bus
 * is receipt-driven: subscribe first, invalidate, join — no sleeps.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { TradingMissionId } from "@t3tools/contracts";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  TradingAccountProjection,
  TradingAccountProjectionLive,
} from "./TradingAccountProjection.ts";

const layer = it.layer(
  TradingAccountProjectionLive.pipe(
    Layer.provideMerge(NodeSqliteClient.layerMemory()),
    Layer.provideMerge(NodeServices.layer),
  ),
);

/** Migrate the shared in-memory db, then truncate the tables the view reads. */
const migrated = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({});
  yield* sql`DELETE FROM trading_missions`;
  yield* sql`DELETE FROM trading_mission_markets`;
  yield* sql`DELETE FROM trading_position_snapshots`;
  yield* sql`DELETE FROM trading_orders`;
  yield* sql`DELETE FROM trading_account_observations`;
});

const seedMission = (missionId: string, accountId: string, market = "ETH") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO trading_missions (
        mission_id, user_id, trading_account_id, instruction, market,
        harness_json, status, control_json, authority_version,
        version, created_at, updated_at
      ) VALUES (
        -- One user per mission: the one-active-mission-per-user unique index
        -- (pre-D4) would otherwise refuse the second seeded mission.
        ${missionId}, ${`user_${missionId}`}, ${accountId}, 'trade', ${market}, '{}',
        'position_open', '{}', 1, 1, 1000, 1000
      )
    `;
  });

layer("TradingAccountProjection", (it) => {
  it.effect("assembles positions with MarketRef, provenance, and authority", () =>
    Effect.gen(function* () {
      yield* migrated;
      const sql = yield* SqlClient.SqlClient;
      yield* seedMission("mission_1", "account_a", "ETH");
      yield* seedMission("mission_2", "account_a", "BTC");

      // A protected long and an unprotected short, on the same account.
      yield* sql`
        INSERT INTO trading_position_snapshots
          (mission_id, market, size, entry_price, unrealised_pnl, margin_used,
           protected_size, liquidation_price, mark_px, observed_at, account_id)
        VALUES
          ('mission_1', 'ETH', 2, 3000, 20, 600, 2, 2500, 3010, 2000, 'account_a'),
          ('mission_2', 'BTC', -0.1, 60000, -5, 300, 0, NULL, 59950, 3000, 'account_a')
      `;

      const projection = yield* TradingAccountProjection;
      const view = yield* projection.view();

      assert.strictEqual(view.accounts.length, 1);
      const account = view.accounts[0]!;
      assert.strictEqual(account.accountId, "account_a");
      assert.strictEqual(account.venue, "hyperliquid");
      assert.strictEqual(account.positions.length, 2);

      const eth = account.positions.find((p) => p.market.asset === "ETH")!;
      assert.deepStrictEqual(eth.market, { venue: "hyperliquid", asset: "ETH" });
      assert.strictEqual(eth.size, 2);
      assert.strictEqual(eth.protection, "resting_on_exchange");
      assert.deepStrictEqual(eth.authority, {
        kind: "mission",
        missionId: TradingMissionId.make("mission_1"),
      });
      assert.strictEqual(eth.markPrice, 3010);
      assert.strictEqual(eth.liquidationPrice, 2500);

      const btc = account.positions.find((p) => p.market.asset === "BTC")!;
      // Nothing rests against the short, so no provenance is claimed for it.
      assert.strictEqual(btc.protection, null);
      assert.deepStrictEqual(btc.authority, {
        kind: "mission",
        missionId: TradingMissionId.make("mission_2"),
      });
      assert.strictEqual(btc.liquidationPrice, undefined);

      // The view dates itself from the newest reconciled observation.
      assert.strictEqual(view.updatedAt, "1970-01-01T00:00:03.000Z");
    }),
  );

  it.effect("carries open orders and the latest balance per account", () =>
    Effect.gen(function* () {
      yield* migrated;
      const sql = yield* SqlClient.SqlClient;
      yield* seedMission("mission_1", "account_a");
      yield* seedMission("mission_2", "account_b");

      yield* sql`
        INSERT INTO trading_orders
          (mission_id, cloid, order_id, market, side, limit_price, remaining_size,
           reduce_only, observed_at, account_id)
        VALUES ('mission_1', ${"a".repeat(32)}, 42, 'ETH', 'buy', 2900, 1.5, 0, 2000, 'account_a')
      `;
      // Two observations on account_a's mission history: the newer one wins.
      yield* sql`
        INSERT INTO trading_account_observations (mission_id, account_value, observed_at)
        VALUES ('mission_1', 1020, 5000), ('mission_2', 800, 4000)
      `;

      const projection = yield* TradingAccountProjection;
      const view = yield* projection.view();

      assert.strictEqual(view.accounts.length, 2);
      const accountA = view.accounts.find((a) => a.accountId === "account_a")!;
      assert.strictEqual(accountA.balanceUsd, 1020);
      assert.strictEqual(accountA.balanceObservedAt, "1970-01-01T00:00:05.000Z");
      // Not persisted anywhere today; the honest answer is null.
      assert.strictEqual(accountA.withdrawableUsd, null);
      assert.strictEqual(accountA.openOrders.length, 1);
      const order = accountA.openOrders[0]!;
      assert.deepStrictEqual(order.market, { venue: "hyperliquid", asset: "ETH" });
      assert.strictEqual(order.orderId, 42);
      assert.strictEqual(order.reduceOnly, false);
      assert.deepStrictEqual(order.authority, {
        kind: "mission",
        missionId: TradingMissionId.make("mission_1"),
      });
      // An ordinary limit order has no trigger, and says so rather than
      // reporting its limit twice.
      assert.strictEqual(order.triggerPrice, null);

      // A flat account with no orders still exists in the view, so its balance
      // card does not vanish between trades.
      const accountB = view.accounts.find((a) => a.accountId === "account_b")!;
      assert.strictEqual(accountB.positions.length, 0);
      assert.strictEqual(accountB.openOrders.length, 0);
      assert.strictEqual(accountB.balanceUsd, 800);
    }),
  );

  // Finding 3 of the live pass: a protection stop's trigger sat at 2,472 and
  // the panel showed 2,447.3, its slippage cap, so the trader read their risk
  // twenty-five dollars looser than it was. The trigger is persisted (078) and
  // projected now, alongside the cap rather than instead of it.
  it.effect("serves a trigger order's trigger price, not just its slippage cap", () =>
    Effect.gen(function* () {
      yield* migrated;
      const sql = yield* SqlClient.SqlClient;
      yield* seedMission("mission_stop", "account_s");
      yield* sql`
        INSERT INTO trading_orders
          (mission_id, cloid, order_id, market, side, limit_price, remaining_size,
           reduce_only, trigger_price, observed_at, account_id)
        VALUES (
          'mission_stop', ${"b".repeat(32)}, 77, 'ETH', 'sell', 2447.3, 0.35,
          1, 2472, 2000, 'account_s'
        )
      `;

      const projection = yield* TradingAccountProjection;
      const view = yield* projection.view();

      const order = view.accounts.find((a) => a.accountId === "account_s")!.openOrders[0]!;
      assert.strictEqual(order.triggerPrice, 2472);
      // The cap is still carried, because it is still true and the panel
      // labels both.
      assert.strictEqual(order.limitPrice, 2447.3);
      assert.strictEqual(order.reduceOnly, true);
    }),
  );

  it.effect("carries MANUAL rows (mission_id NULL) under the manual authority", () =>
    Effect.gen(function* () {
      yield* migrated;
      const sql = yield* SqlClient.SqlClient;
      // No mission anywhere: the user's own position and resting order. The
      // account row comes from trading_accounts, not from mission history.
      yield* sql`DELETE FROM trading_accounts`;
      yield* sql`
        INSERT INTO trading_accounts (
          account_id, user_id, environment, master_wallet_json,
          execution_wallet_json, status, created_at, updated_at
        ) VALUES ('account_m', 'local', 'testnet', '{}', '{}', 'active', 0, 0)
      `;
      yield* sql`
        INSERT INTO trading_position_snapshots
          (mission_id, market, size, entry_price, unrealised_pnl, margin_used,
           protected_size, observed_at, account_id, venue, asset)
        VALUES (NULL, 'SOL', 2, 150, 1, 30, 2, 1000, 'account_m', 'hyperliquid', 'SOL')
      `;
      yield* sql`
        INSERT INTO trading_orders
          (mission_id, cloid, order_id, market, side, limit_price, remaining_size,
           reduce_only, observed_at, account_id)
        VALUES (NULL, ${"b".repeat(32)}, 7, 'SOL', 'sell', 160, 2, 1, 1000, 'account_m')
      `;

      const projection = yield* TradingAccountProjection;
      const view = yield* projection.view();
      const account = view.accounts.find((a) => a.accountId === "account_m")!;
      assert.ok(account, "the manual-only account must not vanish from its own view");
      assert.strictEqual(account.positions.length, 1);
      assert.deepStrictEqual(account.positions[0]?.authority, { kind: "manual" });
      assert.strictEqual(account.positions[0]?.protection, "resting_on_exchange");
      assert.strictEqual(account.openOrders.length, 1);
      assert.deepStrictEqual(account.openOrders[0]?.authority, { kind: "manual" });
    }),
  );

  it.effect("serves the manual balance observation when it is the newest (R2-4)", () =>
    Effect.gen(function* () {
      yield* migrated;
      const sql = yield* SqlClient.SqlClient;
      yield* seedMission("mission_1", "account_a");
      // The mission era's last observation, then a fresher one from the 5s
      // manual pass — stored under the `manual:<accountId>` token because the
      // observations table keys on mission_id alone. The frozen-balance bug
      // was exactly this row not existing: nothing wrote for a missionless
      // account, and the view served the mission era's stale number forever.
      yield* sql`
        INSERT INTO trading_account_observations (mission_id, account_value, observed_at)
        VALUES ('mission_1', 891.70, 4000), ('manual:account_a', 868.71, 9000)
      `;

      const projection = yield* TradingAccountProjection;
      const view = yield* projection.view();
      const account = view.accounts.find((a) => a.accountId === "account_a")!;
      assert.strictEqual(account.balanceUsd, 868.71);
      assert.strictEqual(account.balanceObservedAt, "1970-01-01T00:00:09.000Z");

      // And the reverse ordering: a newer mission row beats an older manual one.
      yield* sql`
        UPDATE trading_account_observations SET account_value = 900, observed_at = 12000
        WHERE mission_id = 'mission_1'
      `;
      const after = yield* projection.view();
      const accountAfter = after.accounts.find((a) => a.accountId === "account_a")!;
      assert.strictEqual(accountAfter.balanceUsd, 900);
    }),
  );

  it.effect("invalidate publishes one doorbell event to a live subscriber", () =>
    Effect.gen(function* () {
      yield* migrated;
      const projection = yield* TradingAccountProjection;

      // Subscribe before publishing — the bus has no replay, by design: the
      // view RPC is the snapshot, the stream is only the doorbell.
      const first = yield* projection.changes.pipe(Stream.runHead, Effect.forkScoped);
      yield* Effect.yieldNow;

      yield* projection.invalidate({ reason: "trading.execution-requested" });

      const event = yield* Fiber.join(first);
      assert.isTrue(Option.isSome(event));
      const received = Option.getOrThrow(event);
      assert.strictEqual(received.kind, "invalidated");
      assert.isAbove(received.revision, 0);
    }),
  );
});
