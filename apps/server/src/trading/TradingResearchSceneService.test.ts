/**
 * The scene record as a record: thread scoping, the cap, and the round trip.
 *
 * A scene that leaked across threads would decorate another conversation's
 * graph with research it never asked for, and a thread that could accumulate
 * scenes without bound would turn its chart into a landfill. What this file
 * pins is that neither happens, and that what is written is what is read
 * back.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  RESEARCH_CALCULATION_VERSIONS,
  RESEARCH_DISCLAIMER,
  RESEARCH_SCENES_MAX_PER_THREAD,
} from "@t3tools/trading-contracts/researchScenes";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import {
  TradingResearchSceneService,
  TradingResearchSceneServiceLive,
} from "./TradingResearchSceneService.ts";

const START = 1_800_000_000_000;

const annotation = (market: string, at: number) => ({
  kind: "annotation" as const,
  document: { market, at, text: "the note" },
});

const layer = it.layer(
  TradingResearchSceneServiceLive.pipe(
    Layer.provideMerge(NodeSqliteClient.layerMemory()),
    Layer.provideMerge(NodeServices.layer),
  ),
);

const migrated = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({});
  yield* sql`DELETE FROM trading_research_scenes`;
});

const publish = Effect.fn("publish")(function* (threadId: string, index: number, market = "ETH") {
  const service = yield* TradingResearchSceneService;
  const result = yield* service.publish({
    threadId,
    kind: "annotated_market",
    title: `note ${index}`,
    market,
    interval: null,
    calculationVersion: RESEARCH_CALCULATION_VERSIONS.annotation,
    payload: annotation(market, START + index),
    now: START + index,
  });
  assert.equal(result.outcome, "ok");
  if (result.outcome !== "ok") return yield* Effect.die("publish refused");
  return result.scene;
});

layer("TradingResearchSceneService", (it) => {
  it.effect("round-trips a scene with the disclaimer and the calculation version", () =>
    Effect.gen(function* () {
      yield* migrated;
      const service = yield* TradingResearchSceneService;
      const scene = yield* publish("thread-1", 0);
      assert.equal(scene.title, "note 0");
      assert.equal(scene.disclaimer, RESEARCH_DISCLAIMER);
      assert.equal(scene.calculationVersion, RESEARCH_CALCULATION_VERSIONS.annotation);
      assert.equal(scene.annotation?.text, "the note");

      const read = yield* service.show(scene.sceneId);
      assert.notEqual(read, null);
      assert.equal(read?.annotation?.at, START);
      assert.equal(read?.threadId, "thread-1");
      assert.equal(read?.status, "active");
      assert.equal(read?.referenceStatus, "unknown");
    }),
  );

  it.effect("scopes every read and clear to the owning thread", () =>
    Effect.gen(function* () {
      yield* migrated;
      const service = yield* TradingResearchSceneService;
      const mine = yield* publish("thread-1", 0);
      yield* publish("thread-2", 1);

      const mineList = yield* service.list("thread-1");
      assert.equal(mineList.length, 1);
      assert.equal(mineList[0]?.status, "active");

      // clear on another thread cannot remove it: the id alone is not authority.
      const crossClear = yield* service.clear({ threadId: "thread-2", sceneId: mine.sceneId });
      assert.equal(crossClear, 0);
      const stillThere = yield* service.show(mine.sceneId);
      assert.notEqual(stillThere, null);

      const removed = yield* service.clear({ threadId: "thread-1", sceneId: mine.sceneId });
      assert.equal(removed, 1);
      // Clearing is a status change, not a deletion: history survives it.
      const clearedRow = yield* service.show(mine.sceneId);
      assert.notEqual(clearedRow, null);
      assert.equal(clearedRow?.status, "cleared");
    }),
  );

  it.effect(
    "holds the cap across same-market publishes (each supersedes), pruning only history",
    () =>
      Effect.gen(function* () {
        yield* migrated;
        const service = yield* TradingResearchSceneService;
        for (let index = 0; index <= RESEARCH_SCENES_MAX_PER_THREAD; index += 1) {
          yield* publish("thread-1", index);
        }
        const held = yield* service.list("thread-1");
        assert.equal(held.length, RESEARCH_SCENES_MAX_PER_THREAD);
        // Exactly one active row, the newest; the rest is history, oldest pruned.
        assert.equal(held.filter((scene) => scene.status === "active").length, 1);
        assert.equal(held[0]?.status, "active");
        assert.equal(
          held.some((scene) => scene.title === `note ${RESEARCH_SCENES_MAX_PER_THREAD}`),
          true,
        );
        assert.equal(
          held.some((scene) => scene.title === "note 0"),
          false,
        );
      }),
  );

  it.effect("supersedes per thread and market, keeping other markets active", () =>
    Effect.gen(function* () {
      yield* migrated;
      const service = yield* TradingResearchSceneService;
      const eth1 = yield* publish("thread-1", 0, "ETH");
      const eth2 = yield* publish("thread-1", 1, "ETH");
      yield* publish("thread-1", 2, "BTC");

      // The prior ETH scene survives as history, clearly superseded.
      const superseded = yield* service.show(eth1.sceneId);
      assert.equal(superseded?.status, "superseded");
      const activeEth = yield* service.show(eth2.sceneId);
      assert.equal(activeEth?.status, "active");

      // A different market is untouched: one active row per thread AND market.
      const rows = yield* service.list("thread-1");
      const activeMarkets = rows
        .filter((scene) => scene.status === "active")
        .map((scene) => scene.annotation?.market ?? "");
      assert.deepEqual([...new Set(activeMarkets)].sort(), ["BTC", "ETH"]);
    }),
  );

  it.effect("clear with no sceneId clears the thread's presentation and keeps history", () =>
    Effect.gen(function* () {
      yield* migrated;
      const service = yield* TradingResearchSceneService;
      yield* publish("thread-1", 0);
      yield* publish("thread-1", 1);
      const removed = yield* service.clear({ threadId: "thread-1" });
      assert.equal(removed, 1);
      // Both rows stay as history. The active presentation is cleared while
      // its already-superseded predecessor keeps the lifecycle it earned.
      const history = yield* service.list("thread-1");
      assert.equal(history.length, 2);
      assert.deepEqual(history.map((scene) => scene.status).sort(), ["cleared", "superseded"]);
    }),
  );
});
