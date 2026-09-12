/**
 * Direct handler test for the `trading_events` study action.
 *
 * What is pinned here is the bounded-read rule: the study hydrates, budget-
 * checks, and reads one window — its own, from the first required entry bar
 * to the last required exit bar — so a small study over two recent
 * occurrences succeeds against an archive holding years of additional bars.
 * The served window is proven through the baseline's sample count, which
 * counts horizon-length windows across exactly the bars the study read: a
 * full-archive read would sample thousands, the bounded window a handful.
 */
// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off - temp files for a temp database; the seeded archive is wall-clock anchored.
import { assert, it } from "@effect/vitest";
import { Schema } from "effect";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { runMigrations } from "../../../persistence/Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { openArchiveDatabase } from "../../../trading/archive/db.ts";
import { upsertCandles, type CandleRow } from "../../../trading/archive/candles.ts";
import {
  makeTradingMarketArchive,
  TradingMarketArchive,
} from "../../../trading/TradingMarketArchive.ts";
import {
  TradingEventService,
  TradingEventServiceLive,
} from "../../../trading/TradingEventService.ts";
import {
  TradingResearchSceneService,
  TradingResearchSceneServiceLive,
} from "../../../trading/TradingResearchSceneService.ts";
import { TradingBacktestService } from "../../../trading/TradingBacktestService.ts";
import { TradingHypothesisService } from "../../../trading/TradingHypothesisService.ts";
import { TradingToolRejectedError } from "@t3tools/trading-contracts/tools";
import { RESEARCH_CALCULATION_VERSIONS } from "@t3tools/trading-contracts/researchScenes";
import { TradingThreadMarketService } from "../../../trading/TradingThreadMarketService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { handlers } from "./handlers.ts";
import {
  GraphResearchService,
  type GraphResearchServiceShape,
  type GraphStudyDataset,
} from "../../../trading/research/GraphResearchService.ts";
import { observationsToCandles, type ForgeSwapObservation } from "@t3tools/trading-contracts";

const DAY = 24 * 60 * 60 * 1_000;

/** One-line diagnostics renderer for assertion messages, outside Effect code. */
const debugJson = (value: unknown): string =>
  Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(value);

/**
 * Drops keys whose value is undefined, recursively: the tool result carries
 * explicit undefined optionals while the persisted scene's report crossed a
 * serialization that omits them, and parity is about the values a reader
 * sees, not key presence.
 */
const withoutUndefinedKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withoutUndefinedKeys);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) out[key] = withoutUndefinedKeys(item);
    }
    return out;
  }
  return value;
};

it.live("a small study reads its bounded window over a much larger archive", () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-events-study-"));
  const archivePath = NodePath.join(dir, "market-archive.sqlite");
  const hydrationPath = NodePath.join(dir, "queue.json");

  // Years of daily bars — far more than the study needs — seeded through the
  // archive's own writer so the read side sees a real file.
  const nowDay = Math.floor(Date.now() / DAY) * DAY;
  const writer = openArchiveDatabase(archivePath);
  const bar = (open: number): CandleRow => ({
    coin: "ETH",
    interval: "1d",
    t: open,
    tClose: open + DAY - 1,
    o: 100,
    h: 101,
    l: 99,
    c: 100.5,
    v: 1,
    n: 3,
  });
  const seeded: number[] = [];
  for (let back = 1100; back >= 1; back -= 1) seeded.push(nowDay - back * DAY);
  upsertCandles(writer, seeded.map(bar));
  writer.close();

  // The writer-lock gate inside the handler reads the archive path from
  // T3CODE_HOME; point it at the disposable base so no real state is
  // consulted and no live writer lock can refuse the run.
  const previousHome = process.env["T3CODE_HOME"];
  process.env["T3CODE_HOME"] = NodePath.join(dir, "home");

  const invocationScope: McpInvocationContext.McpInvocationScope = {
    environmentId: EnvironmentId.make("env-study-test"),
    threadId: ThreadId.make("thread-study-test"),
    providerSessionId: "session-study-test",
    providerInstanceId: ProviderInstanceId.make("instance-study-test"),
    capabilities: new Set<McpInvocationContext.McpCapability>(["trading"]),
    issuedAt: 0,
  };

  return Effect.gen(function* () {
    yield* runMigrations({});
    const events = yield* TradingEventService;
    // Two recent occurrences, 40 and 15 days back, on a five-bar horizon:
    // the study's own window is [now-40d, now-11d] — thirty bars.
    const recorded = yield* events.record({
      name: "Recent devcons",
      occurrences: [
        { startAt: nowDay - 41 * DAY, endAt: nowDay - 40 * DAY, source: "https://example.com/a" },
        { startAt: nowDay - 16 * DAY, endAt: nowDay - 15 * DAY, source: "https://example.com/b" },
      ],
      threadId: "thread-study-test",
      author: "agent",
      now: Date.now(),
    });
    assert.equal(recorded.outcome, "ok");

    const result = yield* handlers.trading_events({
      action: "study",
      eventSetId: recorded.outcome === "ok" ? recorded.set.eventSetId : "",
      market: "ETH",
      interval: "1d",
      horizonBars: 5,
    });

    const study = "study" in result ? result.study : undefined;
    assert.isDefined(study, `the study ran: ${debugJson(result)}`);
    if (study === undefined) return;
    // Both occurrences are inside the bounded window and fully measured; the
    // rows the archive cannot reach simply do not exist in this set.
    assert.equal(study.n, 2);
    assert.equal(study.nCovered, 2);
    // The proof the read was bounded: 30 served bars hold 26 horizon-length
    // baseline windows. A full-archive read of the 1100 seeded bars would
    // sample 1096.
    assert.isDefined(study.baseline);
    assert.equal(study.baseline?.samples, 26);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(
          TradingMarketArchive,
          // Per-test temp paths; the seeded window is already whole, so the
          // study never queues a hydration request.
          makeTradingMarketArchive(archivePath, "hyperliquid", hydrationPath),
        ),
        Layer.succeed(McpInvocationContext.McpInvocationContext, invocationScope),
        TradingEventServiceLive.pipe(
          Layer.provideMerge(NodeSqliteClient.layerMemory()),
          Layer.provideMerge(NodeServices.layer),
        ),
        // The study notes the thread's market so the graph has a panel to
        // draw in; a no-op recorder answers the note.
        Layer.succeed(TradingThreadMarketService, {
          record: (input) =>
            Effect.succeed({
              threadId: input.threadId,
              venue: "hyperliquid",
              asset: input.asset,
              source: input.source,
              updatedAt: 0,
            }),
          read: () => Effect.succeed(null),
        }),
      ),
    ),
    Effect.onExit(() =>
      Effect.sync(() => {
        if (previousHome === undefined) {
          delete process.env["T3CODE_HOME"];
        } else {
          process.env["T3CODE_HOME"] = previousHome;
        }
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }),
    ),
  );
});

/**
 * The path_extrema harness: the same bounded archive as the first test, with
 * named dips — one distinctive low inside each measured horizon — so the
 * extremum assertions are hand-checked numbers, not mirrors of the engine.
 */
type SeededDip = { readonly back: number; readonly low: number };

const seedExtremaArchive = (dir: string, nowDay: number, dips: ReadonlyArray<SeededDip>) => {
  const archivePath = NodePath.join(dir, "market-archive.sqlite");
  const writer = openArchiveDatabase(archivePath);
  const bars: CandleRow[] = [];
  for (let back = 1100; back >= 1; back -= 1) {
    const dip = dips.find((candidate) => candidate.back === back);
    bars.push({
      coin: "ETH",
      interval: "1d",
      t: nowDay - back * DAY,
      tClose: nowDay - back * DAY + DAY - 1,
      o: 100,
      h: 101,
      l: dip === undefined ? 99 : dip.low,
      c: 100,
      v: 1,
      n: 3,
    });
  }
  upsertCandles(writer, bars);
  writer.close();
  return archivePath;
};

const invocationScopeFor = (suffix: string): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make(`env-study-${suffix}`),
  threadId: ThreadId.make(`thread-study-${suffix}`),
  providerSessionId: `session-study-${suffix}`,
  providerInstanceId: ProviderInstanceId.make(`instance-study-${suffix}`),
  capabilities: new Set<McpInvocationContext.McpCapability>(["trading"]),
  issuedAt: 0,
});

const threadMarketRecorder = Layer.succeed(TradingThreadMarketService, {
  record: (input: { readonly threadId: string; readonly asset: string }) =>
    Effect.succeed({
      threadId: input.threadId,
      venue: "hyperliquid",
      asset: input.asset,
      source: "look",
      updatedAt: 0,
    }),
  read: () => Effect.succeed(null),
});

/**
 * The trading_chart handler's TYPE carries the replay path's services even
 * though the publish path never touches them; two die-stubs satisfy the
 * context so the publish tests can run without the backtest engine.
 */
const replayPathStubs = Layer.mergeAll(
  Layer.succeed(TradingBacktestService, {
    run: () => Effect.die("the backtest engine is not used by this test"),
  } as never),
  Layer.succeed(TradingHypothesisService, {
    show: () => Effect.die("the hypothesis service is not used by this test"),
  } as never),
);

it.live("a path_extrema study measures the lowest low and names the publish continuation", () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-events-study-"));
  const nowDay = Math.floor(Date.now() / DAY) * DAY;
  // Occurrence A ends at the nowDay-40d boundary (an instant there); its
  // close-basis entry is the bar opening at that boundary and the horizon 5
  // covers backs 40..35, with the dip (low 50) at back 38. Occurrence B ends
  // at nowDay-15d; horizon 5 covers backs 15..10, dip (low 60) at back 12.
  const archivePath = seedExtremaArchive(dir, nowDay, [
    { back: 38, low: 50 },
    { back: 12, low: 60 },
  ]);
  const hydrationPath = NodePath.join(dir, "queue.json");

  const previousHome = process.env["T3CODE_HOME"];
  process.env["T3CODE_HOME"] = NodePath.join(dir, "home");

  return Effect.gen(function* () {
    yield* runMigrations({});
    const events = yield* TradingEventService;
    const recorded = yield* events.record({
      name: "Fork days",
      occurrences: [
        {
          startAt: nowDay - 40 * DAY,
          endAt: nowDay - 40 * DAY,
          timePrecision: "instant",
          source: "https://example.com/a",
        },
        { startAt: nowDay - 16 * DAY, endAt: nowDay - 15 * DAY, source: "https://example.com/b" },
      ],
      threadId: "thread-study-extrema",
      author: "agent",
      now: Date.now(),
    });
    assert.equal(recorded.outcome, "ok");
    const eventSetId = recorded.outcome === "ok" ? recorded.set.eventSetId : "";

    const result = yield* handlers.trading_events({
      action: "study",
      eventSetId,
      market: "ETH",
      interval: "1d",
      horizonBars: 5,
      metric: "path_extrema",
      direction: "short",
    });

    const study = "study" in result ? result.study : undefined;
    assert.isDefined(study, `the study ran: ${debugJson(result)}`);
    if (study === undefined) return;
    assert.equal(study.metric, "path_extrema");
    assert.equal(study.nCovered, 2);
    const [rowA, rowB] = study.rows;
    // Row A: entry close 100 (the boundary bar), lowest low 50 at back 38.
    assert.equal(rowA?.extremumPrice, 50);
    assert.equal(rowA?.extremumTime, nowDay - 38 * DAY);
    assert.equal(rowA?.excursionReturnPct, -50);
    assert.equal(rowA?.returnPct, 0); // the terminal close return, separately
    // Row B: entry close 100, lowest low 60 at back 12.
    assert.equal(rowB?.extremumPrice, 60);
    assert.equal(rowB?.extremumTime, nowDay - 12 * DAY);
    assert.equal(rowB?.excursionReturnPct, -40);
    // The read stayed bounded: same 31-bar window as the forward-return study
    // of the same two occurrences, proven by the baseline sample count.
    assert.isDefined(study.baseline);
    assert.equal(study.baseline?.samples, 26);
    // The outcome names the only path to "shown".
    const outcome = "outcome" in result ? result.outcome : undefined;
    assert.match(
      outcome ?? "",
      /To show this on the graph, call trading_chart publish_event_study/,
    );
    assert.include(outcome ?? "", "hindsight-perfect");

    // A contradictory direction and price field refuses before any read.
    const contradiction = yield* Effect.flip(
      handlers.trading_events({
        action: "study",
        eventSetId,
        market: "ETH",
        interval: "1d",
        horizonBars: 5,
        metric: "path_extrema",
        direction: "short",
        priceField: "high",
      }),
    );
    assert.instanceOf(contradiction, TradingToolRejectedError);
    assert.include(
      (contradiction as TradingToolRejectedError).detail,
      "contradicts direction short",
    );
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(
          TradingMarketArchive,
          makeTradingMarketArchive(archivePath, "hyperliquid", hydrationPath),
        ),
        Layer.succeed(McpInvocationContext.McpInvocationContext, invocationScopeFor("extrema")),
        TradingEventServiceLive.pipe(
          Layer.provideMerge(NodeSqliteClient.layerMemory()),
          Layer.provideMerge(NodeServices.layer),
        ),
        threadMarketRecorder,
      ),
    ),
    Effect.onExit(() =>
      Effect.sync(() => {
        if (previousHome === undefined) {
          delete process.env["T3CODE_HOME"];
        } else {
          process.env["T3CODE_HOME"] = previousHome;
        }
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }),
    ),
  );
});

it.live(
  "publish_event_study with the metric returns a scene carrying extrema and event-study-3",
  () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-events-study-"));
    const nowDay = Math.floor(Date.now() / DAY) * DAY;
    const archivePath = seedExtremaArchive(dir, nowDay, [{ back: 38, low: 50 }]);
    const hydrationPath = NodePath.join(dir, "queue.json");

    const previousHome = process.env["T3CODE_HOME"];
    process.env["T3CODE_HOME"] = NodePath.join(dir, "home");

    // One memory database shared by the event and scene services, so the
    // migrations the body runs and the rows both services write land in the
    // same place — two layerMemory() instances would be two databases.
    const memory = NodeSqliteClient.layerMemory();

    return Effect.gen(function* () {
      yield* runMigrations({});
      const events = yield* TradingEventService;
      const recorded = yield* events.record({
        name: "The fork",
        occurrences: [
          {
            startAt: nowDay - 40 * DAY,
            endAt: nowDay - 40 * DAY,
            timePrecision: "instant",
            source: "https://example.com/fork",
          },
        ],
        threadId: "thread-study-publish",
        author: "agent",
        now: Date.now(),
      });
      assert.equal(recorded.outcome, "ok");

      const result = yield* handlers.trading_chart({
        action: "publish_event_study",
        eventSetId: recorded.outcome === "ok" ? recorded.set.eventSetId : "",
        market: "ETH",
        interval: "1d",
        horizonBars: 5,
        metric: "path_extrema",
        direction: "short",
        illustrativeNotionalUsd: 2_000,
      });

      const scene = "scene" in result ? result.scene : undefined;
      assert.isDefined(scene, `the scene published: ${debugJson(result)}`);
      if (scene === undefined) return;
      assert.equal(scene.calculationVersion, "event-study-4");
      assert.equal(scene.calculationVersion, RESEARCH_CALCULATION_VERSIONS.eventStudy);
      const study = scene.eventStudy;
      assert.isDefined(study);
      // The payload carries the recipe and the extrema; the notional rides as
      // the illustration the presentation layer labels its money against.
      assert.equal(study?.metric, "path_extrema");
      assert.equal(study?.direction, "short");
      assert.equal(study?.priceField, "low");
      assert.equal(study?.illustrativeNotionalUsd, 2_000);
      assert.equal(study?.report.metric, "path_extrema");
      assert.equal(study?.report.rows[0]?.extremumPrice, 50);
      assert.equal(study?.report.rows[0]?.excursionReturnPct, -50);
      assert.equal(study?.report.meanExcursionPct, -50);
      // The instant's precision rides the window, so the graph never guesses.
      assert.equal(study?.occurrenceWindows[0]?.timePrecision, "instant");
      // The composed scene keeps the instant's entry marker and draws no
      // zero-width band for it (composition itself is pinned in the contracts
      // suite; this proves the published view carries composed layers at all).
      assert.isDefined(scene.scene);
      const outcome = "outcome" in result ? result.outcome : undefined;
      assert.include(outcome ?? "", "Published to this thread's graph");
      assert.include(outcome ?? "", "Open on graph");
      // The open action names the exact scene the reader can focus: the
      // bridge from "a record exists" to "I am looking at it".
      assert.isDefined("open" in result ? result.open : undefined);
      assert.include(outcome ?? "", "hindsight-perfect");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(
            TradingMarketArchive,
            makeTradingMarketArchive(archivePath, "hyperliquid", hydrationPath),
          ),
          Layer.succeed(McpInvocationContext.McpInvocationContext, invocationScopeFor("publish")),
          TradingEventServiceLive.pipe(
            Layer.provideMerge(memory),
            Layer.provideMerge(NodeServices.layer),
          ),
          TradingResearchSceneServiceLive.pipe(
            Layer.provideMerge(memory),
            Layer.provideMerge(NodeServices.layer),
          ),
          threadMarketRecorder,
          replayPathStubs,
        ),
      ),
      Effect.onExit(() =>
        Effect.sync(() => {
          if (previousHome === undefined) {
            delete process.env["T3CODE_HOME"];
          } else {
            process.env["T3CODE_HOME"] = previousHome;
          }
          NodeFS.rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  },
);

it.live(
  "study and publish_event_study report identical rows and statistics for identical input",
  () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-events-study-"));
    const nowDay = Math.floor(Date.now() / DAY) * DAY;
    // One covered occurrence with a distinctive post-entry dip, one future
    // occurrence the archive cannot measure yet: both surfaces must report the
    // same covered row, the same uncovered row with its reason, and the same
    // aggregates for the same parameters.
    const archivePath = seedExtremaArchive(dir, nowDay, [{ back: 12, low: 60 }]);
    const hydrationPath = NodePath.join(dir, "queue.json");

    const previousHome = process.env["T3CODE_HOME"];
    process.env["T3CODE_HOME"] = NodePath.join(dir, "home");

    return Effect.gen(function* () {
      yield* runMigrations({});
      const events = yield* TradingEventService;
      const recorded = yield* events.record({
        name: "Parity days",
        occurrences: [
          {
            startAt: nowDay - 16 * DAY,
            endAt: nowDay - 15 * DAY,
            source: "https://example.com/covered",
          },
          {
            startAt: nowDay + 10 * DAY,
            endAt: nowDay + 11 * DAY,
            source: "https://example.com/future",
          },
        ],
        threadId: "thread-study-parity",
        author: "agent",
        now: Date.now(),
      });
      assert.equal(recorded.outcome, "ok");
      const eventSetId = recorded.outcome === "ok" ? recorded.set.eventSetId : "";

      const studyParams = {
        eventSetId,
        market: "ETH",
        interval: "1d",
        horizonBars: 5,
        metric: "path_extrema",
        direction: "short",
      } as const;

      const studied = yield* handlers.trading_events({ action: "study", ...studyParams });
      const published = yield* handlers.trading_chart({
        action: "publish_event_study",
        ...studyParams,
      });

      const study = "study" in studied ? studied.study : undefined;
      const scene = "scene" in published ? published.scene : undefined;
      assert.isDefined(study, `the study ran: ${debugJson(studied)}`);
      assert.isDefined(scene, `the scene published: ${debugJson(published)}`);
      if (study === undefined || scene === undefined) return;
      assert.equal(scene.calculationVersion, RESEARCH_CALCULATION_VERSIONS.eventStudy);
      // The same engine, the same window, the same cutoff: the tool result and
      // the persisted scene carry one report, never two answers that drift. The
      // scene's report crossed persistence, which omits undefined optionals the
      // engine sets explicitly; normalizing both sides compares the report the
      // reader sees, not key presence.
      assert.deepStrictEqual(
        withoutUndefinedKeys(scene.eventStudy?.report),
        withoutUndefinedKeys(study),
      );
      // Both surfaces saw the same rows: one covered with its extremum, one
      // future with its reason — the counts agree with the denominators.
      assert.equal(study.n, 2);
      assert.equal(study.nCovered, 1);
      assert.equal(study.nComplete, 1);
      assert.equal(study.nUnavailable, 1);
      assert.equal(
        study.rows[1]?.reason,
        "still in the future: it ends after the last archived bar",
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(
            TradingMarketArchive,
            makeTradingMarketArchive(archivePath, "hyperliquid", hydrationPath),
          ),
          Layer.succeed(McpInvocationContext.McpInvocationContext, invocationScopeFor("parity")),
          (() => {
            const memory = NodeSqliteClient.layerMemory();
            return Layer.mergeAll(
              TradingEventServiceLive.pipe(
                Layer.provideMerge(memory),
                Layer.provideMerge(NodeServices.layer),
              ),
              TradingResearchSceneServiceLive.pipe(
                Layer.provideMerge(memory),
                Layer.provideMerge(NodeServices.layer),
              ),
            );
          })(),
          threadMarketRecorder,
          replayPathStubs,
        ),
      ),
      Effect.onExit(() =>
        Effect.sync(() => {
          if (previousHome === undefined) {
            delete process.env["T3CODE_HOME"];
          } else {
            process.env["T3CODE_HOME"] = previousHome;
          }
          NodeFS.rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  },
);

it.live("a failed publish surfaces as a refusal, never as graph success", () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-events-study-"));
  const nowDay = Math.floor(Date.now() / DAY) * DAY;
  const archivePath = seedExtremaArchive(dir, nowDay, []);
  const hydrationPath = NodePath.join(dir, "queue.json");

  const previousHome = process.env["T3CODE_HOME"];
  process.env["T3CODE_HOME"] = NodePath.join(dir, "home");

  // The scene service fails exactly the way a real one can: the write did not
  // land, so nothing is on the graph. The handler must reject the call with
  // that reason; a chart result claiming "Shown on graph" would be a lie.
  const failingScenes = Layer.succeed(TradingResearchSceneService, {
    publish: () =>
      Effect.succeed({
        outcome: "refused" as const,
        reason: "the scene was written but could not be read back; nothing is on the graph",
      }),
    show: () => Effect.succeed(null),
    list: () => Effect.succeed([]),
    clear: () => Effect.succeed(0),
  });

  return Effect.gen(function* () {
    yield* runMigrations({});
    const events = yield* TradingEventService;
    const recorded = yield* events.record({
      name: "The fork",
      occurrences: [
        {
          startAt: nowDay - 40 * DAY,
          endAt: nowDay - 40 * DAY,
          timePrecision: "instant",
          source: "https://example.com/fork",
        },
      ],
      threadId: "thread-study-fail",
      author: "agent",
      now: Date.now(),
    });
    assert.equal(recorded.outcome, "ok");

    const rejection = yield* Effect.flip(
      handlers.trading_chart({
        action: "publish_event_study",
        eventSetId: recorded.outcome === "ok" ? recorded.set.eventSetId : "",
        market: "ETH",
        interval: "1d",
        horizonBars: 5,
        metric: "path_extrema",
        direction: "short",
      }),
    );
    assert.instanceOf(rejection, TradingToolRejectedError, debugJson(rejection));
    assert.include((rejection as TradingToolRejectedError).detail, "nothing is on the graph");
    // The failure is a rejection, not a chart result: flip only succeeds
    // because the handler failed, so no "Shown on graph" outcome can exist.
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(
          TradingMarketArchive,
          makeTradingMarketArchive(archivePath, "hyperliquid", hydrationPath),
        ),
        Layer.succeed(McpInvocationContext.McpInvocationContext, invocationScopeFor("fail")),
        TradingEventServiceLive.pipe(
          Layer.provideMerge(NodeSqliteClient.layerMemory()),
          Layer.provideMerge(NodeServices.layer),
        ),
        failingScenes,
        threadMarketRecorder,
        replayPathStubs,
      ),
    ),
    Effect.onExit(() =>
      Effect.sync(() => {
        if (previousHome === undefined) {
          delete process.env["T3CODE_HOME"];
        } else {
          process.env["T3CODE_HOME"] = previousHome;
        }
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }),
    ),
  );
});

/** The Graph handler seam must never hydrate or read the market archive. */
const graphHandlerLayers = (graph: GraphResearchServiceShape) => {
  const memory = NodeSqliteClient.layerMemory();
  const archive = makeTradingMarketArchive(
    "/unused/graph-test.sqlite",
    "hyperliquid",
    "/unused/queue.json",
  );
  return Layer.mergeAll(
    Layer.succeed(TradingMarketArchive, {
      ...archive,
      ensureCoverage: () => Effect.die("Graph study must not hydrate the archive"),
      candlesInWindow: () => Effect.die("Graph study must not read archive candles"),
      coverage: () => Effect.die("Graph study must not read archive coverage"),
    }),
    Layer.succeed(GraphResearchService, graph),
    Layer.succeed(McpInvocationContext.McpInvocationContext, invocationScopeFor("graph")),
    TradingEventServiceLive.pipe(
      Layer.provideMerge(memory),
      Layer.provideMerge(NodeServices.layer),
    ),
    TradingResearchSceneServiceLive.pipe(
      Layer.provideMerge(memory),
      Layer.provideMerge(NodeServices.layer),
    ),
    threadMarketRecorder,
    replayPathStubs,
  );
};

const GRAPH_HOUR = 3_600_000;
const GRAPH_START = 1_699_920_000_000;
const GRAPH_POOL = ("0x" + "11".repeat(20)) as `0x${string}`;
const graphHandlerDataset = (): GraphStudyDataset => {
  const observations: ForgeSwapObservation[] = [100, 110, 120, 130].map((price, index) => ({
    chain: "ethereum-mainnet",
    poolId: GRAPH_POOL,
    observationId: `swap-${index}`,
    transactionHash: "0x" + String(index + 1).repeat(64),
    logIndex: 0,
    timestamp: (GRAPH_START + index * GRAPH_HOUR) / 1000 + 1,
    sender: "0x" + "22".repeat(20),
    recipient: "0x" + "33".repeat(20),
    amount0: "-1000000000000000000",
    amount1: String(price * 1_000_000),
    sqrtPriceX96: "1",
    tick: 0,
    baseIsToken1: false,
    priceQuotePerBase: { numerator: String(price), denominator: "1" },
    priceQuotePerBaseMicros: price * 1_000_000,
    quoteVolumeMicros: price * 1_000_000,
    quoteVolumeRaw: String(price * 1_000_000),
  }));
  return {
    observations,
    candles: observationsToCandles(observations, { intervalMs: GRAPH_HOUR }),
    quoteDecimals: 6,
    quoteSymbol: "USDC",
    manifest: {
      id: "dataset-graph-handler",
      environmentId: "env-study-graph",
      provider: "the-graph",
      transport: "subgraph",
      chainId: "1",
      deploymentOrPackageId: "Qmgraphfixture",
      schemaSha256: "a".repeat(64),
      programSha256: "b".repeat(64),
      variablesSha256: "c".repeat(64),
      contentSha256: "d".repeat(64),
      requested: { fromMs: GRAPH_START, toMs: GRAPH_START + 4 * GRAPH_HOUR },
      coverage: { fromMs: GRAPH_START, toMs: GRAPH_START + 4 * GRAPH_HOUR, rows: 4 },
      status: "complete",
      pin: { blockNumber: "18000000", blockHash: "0x" + "e".repeat(64) },
      cursor: null,
      normalizedSchemaVersion: 1,
      capturedAtMs: GRAPH_START + 5 * GRAPH_HOUR,
      availabilityBasis: "recorded",
      mode: "historical-replay",
    },
  };
};

it.live(
  "Graph study and publish use the same retained prices and flow without archive reads",
  () => {
    const calls: Array<Parameters<GraphResearchServiceShape["loadStudyDataset"]>[0]> = [];
    const dataset = graphHandlerDataset();
    return Effect.gen(function* () {
      yield* runMigrations({});
      const events = yield* TradingEventService;
      const recorded = yield* events.record({
        name: "Graph release",
        occurrences: [
          {
            startAt: GRAPH_START - 1000,
            endAt: GRAPH_START,
            source: "https://example.com/release",
          },
        ],
        threadId: "thread-study-graph",
        author: "agent",
        now: GRAPH_START + 5 * GRAPH_HOUR,
      });
      assert.equal(recorded.outcome, "ok");
      const params = {
        eventSetId: recorded.outcome === "ok" ? recorded.set.eventSetId : "",
        market: "ETH",
        interval: "1h",
        horizonBars: 2,
        entryBasis: "first_bar_open_after_event",
        graphSource: { poolId: GRAPH_POOL },
      } as const;
      const studied = yield* handlers.trading_events({ action: "study", ...params });
      const published = yield* handlers.trading_chart({ action: "publish_event_study", ...params });
      const study = "study" in studied ? studied.study : undefined;
      const scene = "scene" in published ? published.scene : undefined;
      assert.isDefined(study, debugJson(studied));
      assert.isDefined(scene, debugJson(published));
      if (study === undefined || scene === undefined) return;
      assert.equal(calls.length, 2);
      for (const call of calls) {
        assert.equal(call.market, "ETH");
        assert.equal(call.environmentId, "env-study-graph");
        assert.equal(call.entryBasis, params.entryBasis);
        assert.equal(call.poolId, GRAPH_POOL);
        assert.equal(call.intervalMs, GRAPH_HOUR);
        assert.equal(call.horizonBars, 2);
      }
      assert.equal(study.nCovered, 1);
      assert.equal(study.rows[0]?.entryPrice, 100);
      assert.isAbove(study.rows[0]?.graphTradeCount ?? 0, 0);
      assert.equal(study.rows[0]?.graphParticipants, 1);
      assert.isDefined(study.rows[0]?.netFlowMicros);
      assert.deepStrictEqual(
        withoutUndefinedKeys(scene.eventStudy?.report),
        withoutUndefinedKeys(study),
      );
      assert.equal(scene.eventStudy?.priceSource, "the-graph");
      assert.equal(scene.eventStudy?.graphDataset?.datasetId, dataset.manifest.id);
    }).pipe(
      Effect.provide(
        graphHandlerLayers({
          loadStudyDataset: (input) =>
            Effect.sync(() => {
              calls.push(input);
              return { status: "ok" as const, dataset };
            }),
        }),
      ),
    );
  },
);

it.live("both Graph study handlers refuse unavailable evidence without archive fallback", () =>
  Effect.gen(function* () {
    yield* runMigrations({});
    const events = yield* TradingEventService;
    const recorded = yield* events.record({
      name: "Unavailable Graph release",
      occurrences: [
        { startAt: GRAPH_START - 1000, endAt: GRAPH_START, source: "https://example.com/release" },
      ],
      threadId: "thread-study-graph",
      author: "agent",
      now: GRAPH_START + 5 * GRAPH_HOUR,
    });
    assert.equal(recorded.outcome, "ok");
    const params = {
      eventSetId: recorded.outcome === "ok" ? recorded.set.eventSetId : "",
      market: "ETH",
      interval: "1h",
      horizonBars: 2,
      graphSource: { poolId: GRAPH_POOL },
    } as const;
    const studyRefusal = yield* Effect.flip(
      handlers.trading_events({ action: "study", ...params }),
    );
    const publishRefusal = yield* Effect.flip(
      handlers.trading_chart({ action: "publish_event_study", ...params }),
    );
    for (const refusal of [studyRefusal, publishRefusal]) {
      assert.instanceOf(refusal, TradingToolRejectedError);
      assert.include(
        (refusal as TradingToolRejectedError).detail,
        "graph study unavailable: pinned capture missing",
      );
    }
  }).pipe(
    Effect.provide(
      graphHandlerLayers({
        loadStudyDataset: () =>
          Effect.succeed({ status: "unavailable", reason: "pinned capture missing" }),
      }),
    ),
  ),
);
