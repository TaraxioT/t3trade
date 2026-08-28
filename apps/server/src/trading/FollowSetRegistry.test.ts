import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import {
  foldFollowSet,
  FollowSetRegistry,
  FollowSetRegistryLive,
  watchMarket,
  type FollowedMarket,
} from "./FollowSetRegistry.ts";

const market = (asset: string, reason: FollowedMarket["reason"]): FollowedMarket => ({
  venue: "hyperliquid",
  asset,
  reason,
});

describe("foldFollowSet", () => {
  it("follows a market once, for the strongest reason", () => {
    const folded = foldFollowSet([
      market("ETH", "chart"),
      market("ETH", "position"),
      market("ETH", "watchlist"),
    ]);
    assert.deepEqual(folded, [market("ETH", "position")]);
  });

  // The cap is what keeps attention-driven recording from becoming
  // universe-wide recording, so what it drops matters: never the thing
  // somebody has money in.
  it("drops glances before it drops positions", () => {
    const charts = Array.from({ length: 30 }, (_, index) => market(`ALT${index}`, "chart"));
    const folded = foldFollowSet([...charts, market("BTC", "position")], 3);
    assert.equal(folded.length, 3);
    assert.equal(folded[0]?.asset, "BTC");
  });

  it("keeps the venue as part of the identity", () => {
    const folded = foldFollowSet([
      { venue: "hyperliquid", asset: "ETH", reason: "watchlist" },
      { venue: "hyperliquid", asset: "BTC", reason: "watchlist" },
    ]);
    assert.deepEqual(folded.map((entry) => entry.asset).sort(), ["BTC", "ETH"]);
  });
});

describe("watchMarket", () => {
  it("reads the market out of a persisted watch", () => {
    assert.equal(watchMarket('{"type":"price_cross","market":"SOL"}'), "SOL");
  });

  it("answers null rather than throwing on anything else", () => {
    assert.isNull(watchMarket("not json"));
    assert.isNull(watchMarket("{}"));
    assert.isNull(watchMarket('{"market":""}'));
  });
});

/**
 * The database-backed read, for the one source whose absence would be silent.
 *
 * An armed thesis that is not followed gets no deep recording and no candle
 * subscription, so it would sit there looking armed while no bar ever arrived
 * for it. That failure produces no error and no empty state — just a
 * validation that never takes a trade — so it is worth a test rather than a
 * reading of the query.
 */
describe("FollowSetRegistry.list", () => {
  const layer = it.layer(
    FollowSetRegistryLive.pipe(
      Layer.provideMerge(NodeSqliteClient.layerMemory()),
      Layer.provideMerge(NodeServices.layer),
    ),
  );

  layer("follows the market of a thesis being validated", (it) => {
    it.effect("armed and paused validations both keep their market recorded", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({});

        const insert = (asset: string, status: string) => sql`
          INSERT INTO trading_thesis_validations (
            validation_id, thread_id, venue, asset, interval, thesis_json, label,
            status, armed_at, expires_at, ended_at, end_reason, notional_usd,
            costs_json, baseline_json, bars_watched, pending_entry_signal_time,
            pending_exit_reason, last_bar_time, created_at, updated_at
          ) VALUES (
            ${`v-${asset}`}, NULL, 'hyperliquid', ${asset}, '5m', '{}', NULL,
            ${status}, 0, 1, NULL, NULL, 1000, '{}', NULL, 0, NULL, NULL, NULL, 0, 0
          )
        `;
        yield* insert("ETH", "armed");
        yield* insert("SOL", "paused");
        // An ended validation is history; it must not keep a market recorded.
        yield* insert("DOGE", "ended");

        const registry = yield* FollowSetRegistry;
        const followed = yield* registry.list;
        const assets = followed.map((entry) => entry.asset).sort();

        assert.deepEqual(assets, ["ETH", "SOL"]);
        assert.equal(followed.find((entry) => entry.asset === "ETH")?.reason, "watch");
      }),
    );
  });
});
