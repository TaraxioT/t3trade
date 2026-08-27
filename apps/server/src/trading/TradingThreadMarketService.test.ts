import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import {
  TradingAccountProjection,
  TradingAccountProjectionLive,
} from "./TradingAccountProjection.ts";
import {
  TradingThreadMarketService,
  TradingThreadMarketServiceLive,
} from "./TradingThreadMarketService.ts";

const layer = it.layer(
  TradingThreadMarketServiceLive.pipe(
    Layer.provideMerge(TradingAccountProjectionLive),
    Layer.provideMerge(NodeSqliteClient.layerMemory()),
  ),
);

layer("TradingThreadMarketService", (it) => {
  it.effect("moves the thread's market and reads it back", () =>
    Effect.gen(function* () {
      yield* runMigrations({});
      const focus = yield* TradingThreadMarketService;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM trading_thread_market_focus`;

      // A thread that has never named a market has no panel to draw.
      assert.equal(yield* focus.read("thread_a"), null);

      const seeded = yield* focus.record({
        threadId: "thread_a",
        asset: "ETH",
        source: "seeded",
      });
      assert.equal(seeded.asset, "ETH");
      assert.equal(seeded.source, "seeded");
      assert.equal(seeded.venue, "hyperliquid");
      assert.deepEqual(yield* focus.read("thread_a"), seeded);

      // Most recent wins: the agent looking elsewhere moves the panel.
      const looked = yield* focus.record({ threadId: "thread_a", asset: "SOL", source: "look" });
      assert.equal(looked.asset, "SOL");
      assert.equal(looked.source, "look");

      // One row per thread, not a history.
      const rows = yield* sql<{ readonly asset: string }>`
        SELECT asset FROM trading_thread_market_focus WHERE thread_id = 'thread_a'
      `;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.asset, "SOL");

      // Threads do not share a market.
      yield* focus.record({ threadId: "thread_b", asset: "BTC", source: "bound" });
      assert.equal((yield* focus.read("thread_a"))?.asset, "SOL");
      assert.equal((yield* focus.read("thread_b"))?.asset, "BTC");
    }),
  );

  it.effect("rings the doorbell on a change and stays silent on a repeat", () =>
    Effect.gen(function* () {
      yield* runMigrations({});
      const focus = yield* TradingThreadMarketService;
      const projection = yield* TradingAccountProjection;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM trading_thread_market_focus`;

      // The bus has no replay, so each listener is forked before its write.
      const firstRing = yield* projection.changes.pipe(Stream.runHead, Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* focus.record({ threadId: "thread_c", asset: "ETH", source: "look" });
      const opened = Option.getOrThrow(yield* Fiber.join(firstRing));

      const secondRing = yield* projection.changes.pipe(Stream.runHead, Effect.forkScoped);
      yield* Effect.yieldNow;

      // The hot path: an agent looking at the same market on every wake writes
      // nothing and rings nothing. Identical row back, timestamp included.
      const before = yield* focus.read("thread_c");
      const repeat = yield* focus.record({ threadId: "thread_c", asset: "ETH", source: "look" });
      assert.deepEqual(repeat, before);

      yield* focus.record({ threadId: "thread_c", asset: "SOL", source: "look" });
      const moved = Option.getOrThrow(yield* Fiber.join(secondRing));

      // One revision apart, not two: the repeat in between never published.
      assert.strictEqual(moved.revision, opened.revision + 1);
    }),
  );
});
