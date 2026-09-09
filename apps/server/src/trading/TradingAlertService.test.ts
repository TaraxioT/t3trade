import * as NodeServices from "@effect/platform-node/NodeServices";
import { HyperliquidGateway } from "@t3tools/hyperliquid/Gateway";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { TradingAccountProjectionLive } from "./TradingAccountProjection.ts";
import { TradingAlertService, TradingAlertServiceLive } from "./TradingAlertService.ts";

/**
 * The resolver stub: ETH resolves and is tradable, OLDCOIN is delisted,
 * anything else is unknown. That is the whole D1 validation surface the arm
 * path leans on.
 */
const stubGateway = Layer.succeed(HyperliquidGateway, {
  resolveMarket: (symbol: string) =>
    symbol === "ETH"
      ? Effect.succeed({ symbol, assetIndex: 1, szDecimals: 4, maxLeverage: 50, available: true })
      : symbol === "OLDCOIN"
        ? Effect.succeed({
            symbol,
            assetIndex: 2,
            szDecimals: 0,
            maxLeverage: 3,
            available: false,
          })
        : Effect.die(`unknown market ${symbol}`),
} as unknown as (typeof HyperliquidGateway)["Service"]);

const layer = it.layer(
  TradingAlertServiceLive.pipe(
    Layer.provideMerge(TradingAccountProjectionLive),
    Layer.provideMerge(stubGateway),
    Layer.provideMerge(NodeSqliteClient.layerMemory()),
    Layer.provideMerge(NodeServices.layer),
  ),
);

const migrated = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({});
  yield* sql`DELETE FROM trading_watches`;
  yield* sql`DELETE FROM trading_alert_events`;
});

layer("TradingAlertService", (it) => {
  it.effect("arms a notify price watch on a listed asset with no mission anywhere", () =>
    Effect.gen(function* () {
      yield* migrated;
      const alerts = yield* TradingAlertService;

      const result = yield* alerts.armWatch({
        condition: { kind: "price", market: "ETH", direction: "above", price: 3_000 },
        rearm: { mode: "repeat", cooldownMs: 300_000 },
      });
      assert.equal(result.outcome, "armed");
      if (result.outcome !== "armed") return;
      assert.deepStrictEqual(result.watch.market, { venue: "hyperliquid", asset: "ETH" });
      assert.equal(result.watch.deliver, "notify");

      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{
        readonly mission_id: string | null;
        readonly asset: string | null;
        readonly deliver: string;
        readonly rearm_json: string | null;
        readonly status: string;
      }>`SELECT mission_id, asset, deliver, rearm_json, status FROM trading_watches`;
      assert.equal(rows.length, 1);
      assert.isNull(rows[0]?.mission_id);
      assert.equal(rows[0]?.asset, "ETH");
      assert.equal(rows[0]?.deliver, "notify");
      assert.equal(rows[0]?.status, "active");
      assert.equal(rows[0]?.rearm_json, '{"mode":"repeat","cooldownMs":300000}');

      const listed = yield* alerts.listWatches;
      assert.equal(listed.length, 1);
      assert.equal(listed[0]?.id, result.watch.id);
      assert.equal(listed[0]?.condition.kind, "price");
    }),
  );

  it.effect("refuses the conditions and routes an account watch cannot carry", () =>
    Effect.gen(function* () {
      yield* migrated;
      const alerts = yield* TradingAlertService;

      // A PnL line needs a mission position to measure.
      const pnl = yield* alerts.armWatch({
        condition: { kind: "pnl", market: "ETH", direction: "above", valueUsd: 10 },
      });
      assert.equal(pnl.outcome, "rejected");

      // A wake needs a mission thread to wake.
      const wake = yield* alerts.armWatch({
        condition: { kind: "price", market: "ETH", direction: "above", price: 3_000 },
        deliver: "wake",
      });
      assert.equal(wake.outcome, "rejected");

      // Unknown and delisted assets are refused by the live universe, not a schema.
      const unknown = yield* alerts.armWatch({
        condition: { kind: "price", market: "NOTREAL", direction: "above", price: 1 },
      });
      assert.equal(unknown.outcome, "rejected");
      const delisted = yield* alerts.armWatch({
        condition: { kind: "price", market: "OLDCOIN", direction: "above", price: 1 },
      });
      assert.equal(delisted.outcome, "rejected");

      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM trading_watches
      `;
      assert.equal(rows[0]?.n, 0);
    }),
  );

  it.effect("cancels only an active account watch, and says so honestly", () =>
    Effect.gen(function* () {
      yield* migrated;
      const alerts = yield* TradingAlertService;
      const armed = yield* alerts.armWatch({
        condition: { kind: "price", market: "ETH", direction: "below", price: 2_000 },
      });
      if (armed.outcome !== "armed") throw new Error("arm rejected");

      assert.isTrue(yield* alerts.cancelWatch(armed.watch.id));
      // Already terminal: a second cancel matches nothing.
      assert.isFalse(yield* alerts.cancelWatch(armed.watch.id));
      assert.isFalse(yield* alerts.cancelWatch("never-existed"));
    }),
  );

  it.effect("serves the alert feed newest first, with the limit clamped", () =>
    Effect.gen(function* () {
      yield* migrated;
      const alerts = yield* TradingAlertService;
      for (let i = 0; i < 5; i += 1) {
        yield* alerts.append({
          venue: "hyperliquid",
          asset: "ETH",
          accountId: null,
          watchId: `w${i}`,
          firedAt: 1_000 + i,
          summary: `alert ${i}`,
          payload: { index: i },
        });
      }

      const recent = yield* alerts.listAlerts({ limit: 3 });
      assert.deepStrictEqual(
        recent.map((alert) => alert.watchId),
        ["w4", "w3", "w2"],
      );
      assert.equal(recent[0]?.firedAt, 1_004);
      assert.deepStrictEqual(recent[0]?.market, { venue: "hyperliquid", asset: "ETH" });

      const all = yield* alerts.listAlerts({});
      assert.equal(all.length, 5);
    }),
  );
});
