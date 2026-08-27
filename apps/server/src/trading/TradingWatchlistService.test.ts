import * as NodeServices from "@effect/platform-node/NodeServices";
import { HyperliquidGateway } from "@t3tools/hyperliquid/Gateway";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { TradingAccountProjectionLive } from "./TradingAccountProjection.ts";
import { TradingWatchlistService, TradingWatchlistServiceLive } from "./TradingWatchlistService.ts";

/** ETH and SOL are listed; anything else is unknown to the venue. */
const stubGateway = Layer.succeed(HyperliquidGateway, {
  resolveMarket: (symbol: string) =>
    symbol === "ETH" || symbol === "SOL"
      ? Effect.succeed({ symbol, assetIndex: 1, szDecimals: 4, maxLeverage: 50, available: true })
      : Effect.die(`unknown market ${symbol}`),
} as unknown as (typeof HyperliquidGateway)["Service"]);

const layer = it.layer(
  TradingWatchlistServiceLive.pipe(
    Layer.provideMerge(TradingAccountProjectionLive),
    Layer.provideMerge(stubGateway),
    Layer.provideMerge(NodeSqliteClient.layerMemory()),
    Layer.provideMerge(NodeServices.layer),
  ),
);

const migrated = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({});
  yield* sql`DELETE FROM trading_watchlist`;
});

layer("TradingWatchlistService", (it) => {
  it.effect("adds listed markets in order, refuses unknown ones, and de-dupes", () =>
    Effect.gen(function* () {
      yield* migrated;
      const watchlist = yield* TradingWatchlistService;

      const first = yield* watchlist.add({ venue: "hyperliquid", asset: "ETH" });
      assert.equal(first.outcome, "ok");
      const second = yield* watchlist.add({ venue: "hyperliquid", asset: "SOL" });
      assert.equal(second.outcome, "ok");

      // Adding a market twice keeps its place rather than duplicating it.
      const again = yield* watchlist.add({ venue: "hyperliquid", asset: "ETH" });
      assert.equal(again.outcome, "ok");

      const unknown = yield* watchlist.add({ venue: "hyperliquid", asset: "NOTREAL" });
      assert.equal(unknown.outcome, "rejected");

      const entries = yield* watchlist.list;
      assert.deepStrictEqual(
        entries.map((entry) => entry.market.asset),
        ["ETH", "SOL"],
      );
      assert.isTrue((entries[0]?.position ?? 0) < (entries[1]?.position ?? 0));
    }),
  );

  it.effect("removes an entry, and removing an absent one is a quiet no-op", () =>
    Effect.gen(function* () {
      yield* migrated;
      const watchlist = yield* TradingWatchlistService;
      yield* watchlist.add({ venue: "hyperliquid", asset: "ETH" });
      yield* watchlist.add({ venue: "hyperliquid", asset: "SOL" });

      const removed = yield* watchlist.remove({ venue: "hyperliquid", asset: "ETH" });
      assert.equal(removed.outcome, "ok");
      if (removed.outcome === "ok") {
        assert.deepStrictEqual(
          removed.entries.map((entry) => entry.market.asset),
          ["SOL"],
        );
      }

      const absent = yield* watchlist.remove({ venue: "hyperliquid", asset: "ETH" });
      assert.equal(absent.outcome, "ok");
    }),
  );
});
