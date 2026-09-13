/**
 * Direct handler test for the `trading_events` study_graph action — the
 * multi-variant pre/post-event window study over Graph pool prices.
 *
 * The service engine has its own test (GraphEventWindowStudyService.test.ts);
 * what is pinned here is the tool BOUNDARY: the variant mapping (the anchor's
 * own offset crossing, the other side 0, the entry-basis default), the
 * next-occurrence derivation (the soonest upcoming start, with its label and
 * source), the refusal BEFORE any acquisition for a malformed variant, and
 * the result relay (the retained study plus an outcome sentence that carries
 * the applies-now verdict).
 */
// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off - a temp SQLite database is seeded wall-clock anchored.
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
import {
  TradingEventService,
  TradingEventServiceLive,
} from "../../../trading/TradingEventService.ts";
import { TradingThreadMarketService } from "../../../trading/TradingThreadMarketService.ts";
import { TradingToolRejectedError } from "@t3tools/trading-contracts/tools";
import { TradingMarketArchive } from "../../../trading/TradingMarketArchive.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { handlers } from "./handlers.ts";
import {
  GraphEventWindowStudyService,
  type GraphEventWindowStudyInput,
  type GraphEventWindowStudyResult,
  type GraphEventWindowStudyServiceShape,
} from "../../../trading/research/GraphEventWindowStudyService.ts";

const DAY = 24 * 60 * 60 * 1_000;

/** One-line diagnostics renderer for assertion messages, outside Effect code. */
const debugJson = (value: unknown): string =>
  Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(value);

const invocationScope = (suffix: string): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make(`env-study-graph-${suffix}`),
  threadId: ThreadId.make(`thread-study-graph-${suffix}`),
  providerSessionId: `session-study-graph-${suffix}`,
  providerInstanceId: ProviderInstanceId.make(`instance-study-graph-${suffix}`),
  capabilities: new Set<McpInvocationContext.McpCapability>(["trading"]),
  issuedAt: 0,
});

/** A service fake that fails loudly if any acquisition path is reached. */
const dieIfAcquiredService: GraphEventWindowStudyServiceShape = {
  runStudy: () => Effect.die("this path must refuse or read back before acquisition"),
  readStudy: () => Effect.succeed(null),
};

/** The handler TYPE requires the archive (the archive-study path); the
 *  study_graph path must never touch it — a die-if-touched stub satisfies
 *  the context and proves the separation. */
const archiveStub = Layer.succeed(TradingMarketArchive, {
  ensureCoverage: () => Effect.die("study_graph must not hydrate the archive"),
  candlesInWindow: () => Effect.die("study_graph must not read archive candles"),
} as unknown as TradingMarketArchive["Service"]);

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

/** The canned engine result: one measured variant, one applies-now verdict. */
const cannedResult = (): GraphEventWindowStudyResult => ({
  studyId: "ges_test0000000000000000",
  createdAtMs: 1_000,
  eventSetName: "devcon",
  poolId: "0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8",
  intervalMs: DAY,
  variants: [
    {
      label: "pre-7d-hold-7d",
      anchor: "pre-start",
      leadMs: 7 * DAY,
      tailMs: 0,
      horizonBars: 7,
      entryBasis: "first_closed_bar_after_event",
      occurrences: [
        {
          label: "Devcon 6",
          startAt: 100,
          endAt: 200,
          anchorAt: 50,
          source: "https://archive.devcon.org/",
          covered: true,
          datasetId: "ds_one",
          returnPct: -6.17,
          entryDayNetBaseRaw: "9502100000000000000000",
          entryLeadNetBaseRaw: "1234",
        },
      ],
      aggregates: {
        nRequested: 1,
        nCovered: 1,
        nComplete: 1,
        meanReturnPct: -6.17,
        bestReturnPct: -6.17,
        worstReturnPct: -6.17,
        meanBaselineReturnPct: -6.17,
      },
      disclosure: "n=1; the baseline samples within the occurrence's own dataset window",
    },
  ],
  appliesNow: [
    {
      label: "pre-7d-hold-7d",
      entryWindowStartMs: 2_000,
      entryWindowEndMs: 3_000,
      withinWindow: false,
      note: "the entry window opens in the future",
    },
  ],
  earliestRetainedObservationMs: 90,
  declaredPoolDataStartMs: 80,
  uncertainty: "n=1 per variant is no evidence; treat inconclusive as the honest outcome.",
});

it.live("maps variants, derives the next occurrence, and relays the retained study", () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-events-study-graph-"));
  const previousHome = process.env["T3CODE_HOME"];
  process.env["T3CODE_HOME"] = NodePath.join(dir, "home");
  const now = Date.now();
  const soonestStart = now + 10 * DAY;
  const laterStart = now + 40 * DAY;

  return Effect.gen(function* () {
    yield* runMigrations({});
    const events = yield* TradingEventService;
    const recorded = yield* events.record({
      name: "devcon",
      occurrences: [
        // One measurable past occurrence, then TWO future ones: the applies-now
        // derivation must pick the SOONEST upcoming start, not the latest.
        {
          startAt: now - 400 * DAY,
          endAt: now - 396 * DAY,
          label: "Devcon 6",
          source: "https://archive.devcon.org/",
        },
        {
          startAt: laterStart,
          endAt: laterStart + 4 * DAY,
          label: "Far event",
          source: "https://example.com/far",
        },
        {
          startAt: soonestStart,
          endAt: soonestStart + 4 * DAY,
          label: "Devcon 8",
          source: "https://devcon.org/en/",
        },
      ],
      threadId: "thread-study-graph-run",
      author: "agent",
      now,
    });
    assert.equal(recorded.outcome, "ok");

    const captured: Array<GraphEventWindowStudyInput> = [];
    const recordingService: GraphEventWindowStudyServiceShape = {
      runStudy: (input) =>
        Effect.sync(() => {
          captured.push(input);
          return { status: "ok" as const, result: cannedResult() };
        }),
      readStudy: () => Effect.succeed(null),
    };
    const result = yield* handlers
      .trading_events({
        action: "study_graph",
        eventSetId: recorded.outcome === "ok" ? recorded.set.eventSetId : "",
        market: "ETH",
        graphStudy: {
          poolId: "0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8",
          variants: [
            { label: "pre-7d-hold-7d", anchor: "pre-start", leadMs: 7 * DAY, horizonBars: 7 },
            {
              label: "post-end-1d-hold-14d",
              anchor: "post-end",
              tailMs: DAY,
              horizonBars: 14,
              entryBasis: "first_closed_bar_after_event",
            },
          ],
        },
      })
      .pipe(Effect.provideService(GraphEventWindowStudyService, recordingService));

    // The engine saw the mapped request: this environment, the set's name,
    // every occurrence, the daily default, and both variants with the
    // anchor's own offset crossed and the other side zero.
    assert.equal(captured.length, 1, `the engine ran once: ${debugJson(result)}`);
    const engineInput = captured[0]!;
    assert.equal(engineInput.environmentId, "env-study-graph-run");
    assert.equal(engineInput.eventSetName, "devcon");
    assert.equal(engineInput.occurrences.length, 3);
    assert.equal(engineInput.intervalMs, DAY);
    assert.deepEqual(engineInput.variants, [
      {
        label: "pre-7d-hold-7d",
        anchor: "pre-start",
        leadMs: 7 * DAY,
        tailMs: 0,
        horizonBars: 7,
        entryBasis: "first_closed_bar_after_event",
      },
      {
        label: "post-end-1d-hold-14d",
        anchor: "post-end",
        leadMs: 0,
        tailMs: DAY,
        horizonBars: 14,
        entryBasis: "first_closed_bar_after_event",
      },
    ]);
    // The next occurrence is the SOONEST upcoming start, label and source kept.
    assert.isDefined(engineInput.nextOccurrence);
    assert.equal(engineInput.nextOccurrence?.startAt, soonestStart);
    assert.equal(engineInput.nextOccurrence?.label, "Devcon 8");
    assert.equal(engineInput.nextOccurrence?.source, "https://devcon.org/en/");

    // The result relay: the retained study verbatim plus the outcome sentence
    // carrying the study id and the applies-now verdict.
    const graphStudy = "graphStudy" in result ? result.graphStudy : undefined;
    assert.isDefined(graphStudy, debugJson(result));
    assert.equal(graphStudy?.studyId, "ges_test0000000000000000");
    const outcome = "outcome" in result ? result.outcome : undefined;
    assert.include(outcome, "ges_test0000000000000000");
    assert.include(outcome, "outside the entry window");
    assert.include(outcome, "1/1 complete");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(McpInvocationContext.McpInvocationContext, invocationScope("run")),
        TradingEventServiceLive.pipe(
          Layer.provideMerge(NodeSqliteClient.layerMemory()),
          Layer.provideMerge(NodeServices.layer),
        ),
        threadMarketRecorder,
        archiveStub,
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

it.live("refuses a malformed variant before any acquisition runs", () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-events-study-graph-"));
  const previousHome = process.env["T3CODE_HOME"];
  process.env["T3CODE_HOME"] = NodePath.join(dir, "home");
  const now = Date.now();

  return Effect.gen(function* () {
    yield* runMigrations({});
    const events = yield* TradingEventService;
    const recorded = yield* events.record({
      name: "devcon",
      occurrences: [
        { startAt: now - 400 * DAY, endAt: now - 396 * DAY, source: "https://example.com/a" },
      ],
      threadId: "thread-study-graph-refuse",
      author: "agent",
      now,
    });
    assert.equal(recorded.outcome, "ok");
    const eventSetId = recorded.outcome === "ok" ? recorded.set.eventSetId : "";

    // The die-if-called engine (provided below) proves both refusals happen
    // at the boundary, before any acquisition: a pre-start variant without
    // leadMs, and a post-end horizon of zero.
    const noLead = yield* Effect.flip(
      handlers.trading_events({
        action: "study_graph",
        eventSetId,
        market: "ETH",
        graphStudy: {
          poolId: "0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8",
          variants: [{ label: "no-lead", anchor: "pre-start", horizonBars: 7 }],
        },
      }),
    );
    assert.instanceOf(noLead, TradingToolRejectedError, debugJson(noLead));
    assert.include((noLead as TradingToolRejectedError).detail, "leadMs");

    const zeroHorizon = yield* Effect.flip(
      handlers.trading_events({
        action: "study_graph",
        eventSetId,
        market: "ETH",
        graphStudy: {
          poolId: "0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8",
          variants: [{ label: "zero-horizon", anchor: "post-end", tailMs: DAY, horizonBars: 0 }],
        },
      }),
    );
    assert.instanceOf(zeroHorizon, TradingToolRejectedError, debugJson(zeroHorizon));
    assert.include((zeroHorizon as TradingToolRejectedError).detail, "horizonBars");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(GraphEventWindowStudyService, dieIfAcquiredService),
        Layer.succeed(McpInvocationContext.McpInvocationContext, invocationScope("refuse")),
        TradingEventServiceLive.pipe(
          Layer.provideMerge(NodeSqliteClient.layerMemory()),
          Layer.provideMerge(NodeServices.layer),
        ),
        threadMarketRecorder,
        archiveStub,
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

it.live("reads a retained study back by id without re-acquiring", () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-events-study-graph-"));
  const previousHome = process.env["T3CODE_HOME"];
  process.env["T3CODE_HOME"] = NodePath.join(dir, "home");
  const now = Date.now();

  return Effect.gen(function* () {
    yield* runMigrations({});
    const events = yield* TradingEventService;
    const recorded = yield* events.record({
      name: "devcon",
      occurrences: [
        { startAt: now - 400 * DAY, endAt: now - 396 * DAY, source: "https://example.com/a" },
      ],
      threadId: "thread-study-graph-readback",
      author: "agent",
      now,
    });
    assert.equal(recorded.outcome, "ok");
    const retained = cannedResult();

    // The engine is never called on a read-back: the fake dies if it runs.
    const result = yield* handlers
      .trading_events({
        action: "study_graph",
        eventSetId: recorded.outcome === "ok" ? recorded.set.eventSetId : "",
        market: "ETH",
        graphStudy: { studyId: retained.studyId },
      })
      .pipe(
        Effect.provideService(GraphEventWindowStudyService, {
          runStudy: () => Effect.die("a read-back must not acquire"),
          readStudy: (studyId) =>
            Effect.succeed(
              studyId === retained.studyId
                ? { specJson: "{}", resultJson: JSON.stringify(retained) }
                : null,
            ),
        } satisfies GraphEventWindowStudyServiceShape),
      );
    assert.equal("graphStudy" in result ? result.graphStudy?.studyId : undefined, retained.studyId);
    const outcome = "outcome" in result ? result.outcome : undefined;
    assert.include(outcome, `Read back retained window study ${retained.studyId}`);
    assert.include(outcome, retained.uncertainty);

    // An unknown id refuses with the id named, changing nothing.
    const missing = yield* Effect.flip(
      handlers
        .trading_events({
          action: "study_graph",
          eventSetId: recorded.outcome === "ok" ? recorded.set.eventSetId : "",
          market: "ETH",
          graphStudy: { studyId: "ges_doesnotexist000000000000" },
        })
        .pipe(Effect.provideService(GraphEventWindowStudyService, dieIfAcquiredService)),
    );
    assert.instanceOf(missing, TradingToolRejectedError, debugJson(missing));
    assert.include((missing as TradingToolRejectedError).detail, "ges_doesnotexist000000000000");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(McpInvocationContext.McpInvocationContext, invocationScope("readback")),
        TradingEventServiceLive.pipe(
          Layer.provideMerge(NodeSqliteClient.layerMemory()),
          Layer.provideMerge(NodeServices.layer),
        ),
        threadMarketRecorder,
        archiveStub,
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
