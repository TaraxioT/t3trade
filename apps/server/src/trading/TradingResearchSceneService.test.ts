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
import { assert, describe, it } from "@effect/vitest";
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
  composeSceneViews,
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

// The one decoration every read path shares. The graph polls
// getTradingResearchScenes after a reload while the tool results carry the
// same scene at publish time: if the polling read served rows without their
// composed layers, the calendar view would silently downgrade to anonymous
// bands (or nothing at all) the moment the publish response scrolled away.
// composeSceneViews is pinned directly, with the event-set lookup injected,
// so the regression is caught without a browser.
describe("composeSceneViews", () => {
  const DAY = 24 * 60 * 60 * 1_000;
  const studyView = {
    sceneId: "scene-1",
    threadId: "thread-1",
    status: "active",
    referenceStatus: "unknown",
    kind: "event_study",
    title: "ETH upgrades on ETH, 1d bars, 30 forward",
    createdAt: START,
    updatedAt: START,
    calculationVersion: RESEARCH_CALCULATION_VERSIONS.eventStudy,
    disclaimer: RESEARCH_DISCLAIMER,
    eventStudy: {
      priceSource: "hyperliquid",
      entryBasis: "first_closed_bar_after_event",
      illustrativeNotionalUsd: 1_000,
      eventSetId: "set-1",
      eventSetName: "ETH upgrades",
      market: "ETH",
      interval: "1d",
      horizonBars: 30,
      report: {
        horizonBars: 30,
        horizonMs: 30 * DAY,
        n: 1,
        nCovered: 1,
        meanReturnPct: 5,
        medianReturnPct: 5,
        hitRatePercent: 100,
        bestReturnPct: 5,
        worstReturnPct: 5,
        baseline: null,
        rows: [
          {
            startAt: START,
            endAt: START,
            label: "Dencun",
            source: "https://example.org/forks",
            covered: true,
            entryTime: START + DAY - 1,
            entryPrice: 3900.5,
            exitTime: START + 31 * DAY - 1,
            exitPrice: 4095.5,
            returnPct: 5,
            truncated: false,
            barsCovered: 30,
          },
        ],
        verdict: "1 of 1 occurrence falls inside archived data.",
      },
      occurrenceWindows: [],
      archiveBounds: { recordingSince: null, fromT: START, toT: START + 31 * DAY },
    },
  } as never;

  it.effect("attaches the composed semantic layers and the resolved reference status", () =>
    Effect.gen(function* () {
      const views = yield* composeSceneViews({
        views: [studyView],
        showEventSet: () => Effect.succeed({ retiredAt: null }),
      });
      const scene = (views[0] as { scene?: { deterministic: ReadonlyArray<{ kind: string }> } })
        .scene;
      const kinds = scene?.deterministic.map((layer) => layer.kind) ?? [];
      for (const kind of ["event_span", "study_entry", "study_exit", "return_span"]) {
        assert.include(kinds, kind);
      }
      assert.equal((views[0] as { referenceStatus: string }).referenceStatus, "ok");
    }),
  );

  it.effect("says retired when the event set is gone or retired, and never invents layers", () =>
    Effect.gen(function* () {
      for (const set of [null, { retiredAt: START + 1 }]) {
        const views = yield* composeSceneViews({
          views: [studyView],
          showEventSet: () => Effect.succeed(set),
        });
        assert.equal((views[0] as { referenceStatus: string }).referenceStatus, "retired");
        assert.notEqual((views[0] as { scene?: unknown }).scene, undefined);
      }
    }),
  );

  it.effect("leaves a non-study view exactly as it is", () =>
    Effect.gen(function* () {
      const annotationView = {
        sceneId: "scene-2",
        threadId: "thread-1",
        status: "active",
        referenceStatus: "unknown",
        kind: "annotated_market",
        title: "note",
        createdAt: START,
        updatedAt: START,
        calculationVersion: RESEARCH_CALCULATION_VERSIONS.annotation,
        disclaimer: RESEARCH_DISCLAIMER,
      } as never;
      const views = yield* composeSceneViews({
        views: [annotationView],
        showEventSet: () => Effect.die("must not be called"),
      });
      assert.equal((views[0] as { sceneId: string }).sceneId, "scene-2");
      assert.equal((views[0] as { referenceStatus: string }).referenceStatus, "unknown");
    }),
  );
});
