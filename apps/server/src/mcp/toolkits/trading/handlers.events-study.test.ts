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
import * as NodeSqliteClient from "../../../persistence/NodeSqliteClient.ts";
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
import { TradingThreadMarketService } from "../../../trading/TradingThreadMarketService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { handlers } from "./handlers.ts";

const DAY = 24 * 60 * 60 * 1_000;

/** One-line diagnostics renderer for assertion messages, outside Effect code. */
const debugJson = (value: unknown): string =>
  Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(value);

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
