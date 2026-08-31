/**
 * Plan-aware wakes — GLM-4 slice: the activated TRADE.md revision governs a
 * background wake.
 *
 * Covers: restart recovery (a reopened store recomposes the same activated
 * revision), the wake carrying the activated snapshot with the CURRENT disk
 * facts reported separately (drift never silently swaps the file in), the
 * drift/missing refusal split between the wake note and the enter guard, the
 * unreadable document, a workspace script executed by the AGENT (the test
 * simulating the agent's native run) with the server executing nothing, the
 * data-failure blocked reason at the wake seam, and the plan-less mission
 * staying plan-less.
 *
 * In-memory sqlite + full migrations, mirroring TradingPlanDocument.test.ts;
 * one file-backed store for the restart case. Composer stubs from
 * TradingWakeupComposer.test.ts.
 */
// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - temp workspaces, a fixture script, and the persisted-cwd JSON column by design in tests.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { spawnSync } from "node:child_process";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";

import { HyperliquidGateway } from "@t3tools/hyperliquid/Gateway";
import { pocAuthorityDefaults } from "@t3tools/trading-contracts/authority";
import { TRADE_MD_MAX_BYTES } from "@t3tools/trading-contracts/plan-document";

import type { TradingMission, PersistedWatch } from "./Schemas.ts";
import {
  guardPlanDocumentDrift,
  hashTradeContent,
  makeTradingPlanDocumentService,
  readTradeDocument,
} from "./TradingPlanDocument.ts";
import { TradingCostEstimator } from "./TradingCostEstimator.ts";
import { TradingMissionService } from "./TradingMissionService.ts";
import { TradingStrategyService } from "./TradingStrategyService.ts";
import { TradingWakeupComposer, TradingWakeupComposerLive } from "./TradingWakeupComposer.ts";
import { TradingWatchService } from "./TradingWatchService.ts";

const MARK = 4_000;
const NOW = 2_000_000;
const THREAD = "thread_wake";
const freshness = { observedAt: NOW, source: "websocket", staleAfterMillis: 2_000 };

const DOC = `# TRADE.md

## Mandate

Momentum continuation on ETH, testnet only, max 1x.

## Strategies

- ema-continuation: when the 5m EMA cross confirms, run scripts/signal.sh
  inside the workspace and decide with its output.
`;

const mission = {
  id: "mission_1",
  userId: "user_1",
  tradingAccountId: "acct_1",
  instruction: "trade the 5m EMA continuation",
  market: "ETH",
  markets: ["ETH"],
  status: "waiting",
  purpose: "trade",
  authorityVersion: 1,
  authority: pocAuthorityDefaults(1_000),
  control: {},
  harness: { threadId: THREAD },
  createdAt: 0,
  updatedAt: 0,
} as unknown as TradingMission;

/** The durable watch that fired — an EMA-style level on the mission market. */
const firedWatch = {
  id: "watch_ema",
  missionId: "mission_1",
  watch: {
    type: "price_cross",
    market: "ETH",
    priceSource: "mark",
    direction: "above",
    price: 4_010,
  },
  status: "triggered",
  createdAt: 0,
  updatedAt: 0,
} as PersistedWatch;

/** Whether the market-data half of the gateway answers this test. */
let snapshotFails = false;

const stubGateway = Layer.succeed(HyperliquidGateway)({
  getMarketSnapshot: () =>
    snapshotFails
      ? Effect.fail({ _tag: "GatewayError", reason: "info unreachable" } as never)
      : Effect.succeed({
          market: "ETH",
          markPrice: MARK,
          midPrice: MARK,
          oraclePrice: MARK,
          fundingRate8h: 0.0001,
          openInterest: 10,
          dayVolumeUsd: 1_000,
          bestBidOffer: { bidPrice: 3_999, bidSize: 1, askPrice: 4_001, askSize: 1, freshness },
          freshness,
          change24hPercent: 1.2,
        } as never),
  getAccountSnapshot: () =>
    Effect.succeed({
      address: "0x00000000000000000000000000000000000000ff",
      accountValue: 1_000,
      marginUsed: 0,
      withdrawable: 1_000,
      positions: [],
      freshness,
    } as never),
} as unknown as HyperliquidGateway["Service"]);

const stubCosts = Layer.succeed(TradingCostEstimator)({
  // A dying estimate is the shape the composer's enrichment recovery expects:
  // `catchCause` costs the field, never the wake.
  estimate: () => Effect.die(new Error("no cost read on these wakes")) as never,
} as unknown as TradingCostEstimator["Service"]);

const stubMissions = Layer.succeed(TradingMissionService)({
  getMasterWalletAddress: () =>
    Effect.succeed("0x00000000000000000000000000000000000000ff" as `0x${string}`),
  readPeakUnrealisedPnl: () => Effect.succeed(null),
} as unknown as TradingMissionService["Service"]);

const stubWatches = Layer.succeed(TradingWatchService)({
  getWatch: (id: string) => Effect.succeed(id === "watch_ema" ? firedWatch : null),
} as unknown as TradingWatchService["Service"]);

const stubStrategies = Layer.succeed(TradingStrategyService)({
  listWatches: () => Effect.succeed([firedWatch]),
} as unknown as TradingStrategyService["Service"]);

const composerOver = (store: Layer.Layer<SqlClient.SqlClient, SqlError>) =>
  TradingWakeupComposerLive.pipe(
    Layer.provideMerge(stubGateway),
    Layer.provideMerge(stubCosts),
    Layer.provideMerge(stubMissions),
    Layer.provideMerge(stubWatches),
    Layer.provideMerge(stubStrategies),
    Layer.provideMerge(store),
    Layer.provideMerge(NodeServices.layer),
  );

const layer = it.layer(composerOver(NodeSqliteClient.layerMemory()));

const migrated = Effect.gen(function* () {
  yield* runMigrations({});
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM provider_session_runtime`;
  yield* sql`DELETE FROM trading_plan_documents`;
  yield* sql`DELETE FROM trading_execution_records`;
  snapshotFails = false;
});

/** A temp workspace with TRADE.md content and the thread's persisted cwd. */
const seedWorkspace = (content: string, threadId = THREAD): string => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3trade-plan-wake-"));
  NodeFS.writeFileSync(NodePath.join(dir, "TRADE.md"), content);
  return dir;
};

const seedThreadCwd = (threadId: string, cwd: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO provider_session_runtime (
        thread_id, provider_name, provider_instance_id, adapter_key,
        runtime_mode, workspace_mode, status, last_seen_at,
        resume_cursor_json, runtime_payload_json
      ) VALUES (
        ${threadId}, 'claude', 'instance_1', 'claude',
        'full-access', 'default', 'stopped', '2026-08-31T00:00:00Z',
        NULL, ${JSON.stringify({ cwd })}
      )
    `;
  });

/** Activate the workspace's current document for the thread. */
const activateCurrent = (workspaceRoot: string, threadId = THREAD) =>
  Effect.gen(function* () {
    const documents = yield* makeTradingPlanDocumentService;
    const current = yield* readTradeDocument(workspaceRoot);
    if (current.status !== "present") throw new Error("fixture TRADE.md missing");
    return yield* documents.activate({
      workspaceRoot,
      expectedContentHash: current.contentHash,
      threadId,
      provider: "claude",
      missionId: "mission_1",
    });
  });

const composeWake = (threadId = THREAD) =>
  Effect.gen(function* () {
    const composer = yield* TradingWakeupComposer;
    return yield* composer.compose({
      mission,
      threadId,
      harnessRunId: "run_1",
      cause: "market_watch_triggered",
      occurredAt: NOW,
      triggeringWatchId: "watch_ema",
      pendingEvents: [],
    });
  });

layer("TradingPlanWake — the activated revision governs the wake", (it) => {
  it.effect("a fired watch carries the activated snapshot, hash and path", () =>
    Effect.gen(function* () {
      yield* migrated;
      const dir = seedWorkspace(DOC);
      yield* seedThreadCwd(THREAD, dir);
      const activated = yield* activateCurrent(dir);
      assert.notEqual(activated, null);

      const { wakeup, text } = yield* composeWake();
      const doc = wakeup.planDocument;
      assert.isDefined(doc, "the wake carries the plan document");
      if (doc === undefined) return;
      assert.equal(doc.activatedHash, hashTradeContent(DOC));
      assert.equal(doc.status, "active");
      assert.equal(doc.diskHash, hashTradeContent(DOC));
      assert.isTrue(doc.path.endsWith("TRADE.md"));
      assert.isTrue(doc.activatedExcerpt.includes("ema-continuation"));
      assert.isFalse(doc.excerptTruncated);
      assert.isUndefined(doc.driftNote);
      // Rendered too: the document rides the wake text as facts plus excerpt.
      assert.include(text, "planDocument:");
      assert.include(text, doc.activatedHash);
      assert.include(text, "status=active");
    }),
  );

  it.effect("drift reports the disk beside the snapshot, never in place of it", () =>
    Effect.gen(function* () {
      yield* migrated;
      const dir = seedWorkspace(DOC);
      yield* seedThreadCwd(THREAD, dir);
      yield* activateCurrent(dir);
      // The file changes while the mission sleeps.
      NodeFS.writeFileSync(NodePath.join(dir, "TRADE.md"), `${DOC}\n## EDITED LIVE\n`);

      const { wakeup, text } = yield* composeWake();
      const doc = wakeup.planDocument;
      assert.isDefined(doc);
      if (doc === undefined) return;
      assert.equal(doc.status, "drifted");
      assert.equal(doc.activatedHash, hashTradeContent(DOC), "the pin still governs");
      assert.equal(doc.diskHash, hashTradeContent(`${DOC}\n## EDITED LIVE\n`));
      // The excerpt is the ACTIVATED snapshot; the disk edit never rides the
      // wake as content.
      assert.isTrue(doc.activatedExcerpt.includes("ema-continuation"));
      assert.isFalse(doc.activatedExcerpt.includes("EDITED LIVE"));
      assert.notInclude(text, "EDITED LIVE");
      // The note explains the refusal in the guard's own words, so the turn
      // communicates it instead of discovering it by trying.
      assert.isDefined(doc.driftNote);
      assert.include(doc.driftNote, "plan_document_drifted");
      assert.include(
        doc.driftNote,
        "Reducing, closing, protecting, pausing and revoking remain available",
      );
      assert.include(text, "status=drifted");
    }),
  );

  it.effect("a missing file is a drift-classified blocked reason; the snapshot governs", () =>
    Effect.gen(function* () {
      yield* migrated;
      const dir = seedWorkspace(DOC);
      yield* seedThreadCwd(THREAD, dir);
      yield* activateCurrent(dir);
      NodeFS.rmSync(NodePath.join(dir, "TRADE.md"));

      const { wakeup } = yield* composeWake();
      const doc = wakeup.planDocument;
      assert.isDefined(doc);
      if (doc === undefined) return;
      assert.equal(doc.status, "missing");
      assert.isNull(doc.diskHash);
      // The persisted snapshot still feeds the wake.
      assert.isTrue(doc.activatedExcerpt.includes("ema-continuation"));
      assert.include(doc.driftNote, "missing at its recorded path");

      // And the enter guard refuses new exposure while the pin stands —
      // exposure-reducing actions pass, so the controls stay usable.
      const refused = yield* guardPlanDocumentDrift("open", THREAD);
      assert.equal(refused?.reason, "plan_document_drifted");
      assert.include(refused?.detail, "missing");
      const permitted = yield* guardPlanDocumentDrift("close", THREAD);
      assert.equal(permitted, null);
      // A rename is missing at the recorded path: the guard never follows the
      // new file.
      NodeFS.writeFileSync(NodePath.join(dir, "PLAN.md"), DOC);
      const renamed = yield* guardPlanDocumentDrift("open", THREAD);
      assert.equal(renamed?.reason, "plan_document_drifted");
    }),
  );

  it.effect("an unreadable document is reported, never fatal to the wake", () =>
    Effect.gen(function* () {
      yield* migrated;
      const dir = seedWorkspace(DOC);
      yield* seedThreadCwd(THREAD, dir);
      yield* activateCurrent(dir);
      // Invalid UTF-8: the read refuses, which is a fact about the file.
      NodeFS.writeFileSync(NodePath.join(dir, "TRADE.md"), Buffer.from([0xff, 0xfe, 0x00]));

      const { wakeup } = yield* composeWake();
      const doc = wakeup.planDocument;
      assert.isDefined(doc);
      if (doc === undefined) return;
      assert.equal(doc.status, "unreadable");
      assert.isNull(doc.diskHash);
      assert.isTrue(doc.activatedExcerpt.includes("ema-continuation"), "snapshot still governs");
    }),
  );

  it.effect(
    "a deleted workspace root keeps the pin: the wake carries the snapshot and the guard fences",
    () =>
      Effect.gen(function* () {
        yield* migrated;
        const dir = seedWorkspace(DOC);
        yield* seedThreadCwd(THREAD, dir);
        yield* activateCurrent(dir);
        // The whole workspace disappears (a removed worktree). The pin is a
        // SQLite row and must outlive the directory it was read from.
        NodeFS.rmSync(dir, { recursive: true, force: true });

        const { wakeup } = yield* composeWake();
        const doc = wakeup.planDocument;
        assert.isDefined(doc, "the persisted activation survives the workspace");
        if (doc === undefined) return;
        assert.equal(doc.status, "unreadable");
        assert.isNull(doc.diskHash);
        assert.isTrue(doc.activatedExcerpt.includes("ema-continuation"), "snapshot still governs");
        assert.isDefined(doc.driftNote);
        assert.include(doc.driftNote, "could not be read");

        const refused = yield* guardPlanDocumentDrift("open", THREAD);
        assert.equal(refused?.reason, "plan_document_drifted");
        assert.equal(yield* guardPlanDocumentDrift("close", THREAD), null);
        assert.equal(yield* guardPlanDocumentDrift("reduce", THREAD), null);
      }),
  );

  it.effect("an oversize file while a pin stands fences new exposure", () =>
    // The pinned snapshot was a valid readable file at activation; a read
    // that now refuses means the file changed. Unreadable is drift-classified
    // while a pin stands — same reason, same escape hatch for controls.
    Effect.gen(function* () {
      yield* migrated;
      const dir = seedWorkspace(DOC);
      yield* seedThreadCwd(THREAD, dir);
      yield* activateCurrent(dir);
      NodeFS.writeFileSync(
        NodePath.join(dir, "TRADE.md"),
        `# TRADE.md\n\n${"x".repeat(TRADE_MD_MAX_BYTES + 1)}`,
      );

      const refused = yield* guardPlanDocumentDrift("open", THREAD);
      assert.equal(refused?.reason, "plan_document_drifted");
      assert.include(refused?.detail, "could not be read");
      assert.equal(yield* guardPlanDocumentDrift("reduce", THREAD), null);
      assert.equal(yield* guardPlanDocumentDrift("close", THREAD), null);
    }),
  );

  it.effect("a symlink-escape file while a pin stands fences new exposure", () =>
    Effect.gen(function* () {
      yield* migrated;
      const dir = seedWorkspace(DOC);
      yield* seedThreadCwd(THREAD, dir);
      yield* activateCurrent(dir);
      const outside = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3trade-plan-wake-out-"));
      NodeFS.writeFileSync(NodePath.join(outside, "TRADE.md"), "# escaped");
      NodeFS.rmSync(NodePath.join(dir, "TRADE.md"));
      NodeFS.symlinkSync(NodePath.join(outside, "TRADE.md"), NodePath.join(dir, "TRADE.md"));

      const refused = yield* guardPlanDocumentDrift("open", THREAD);
      assert.equal(refused?.reason, "plan_document_drifted");
      assert.equal(yield* guardPlanDocumentDrift("close", THREAD), null);
    }),
  );

  it.effect("an unreadable file with no pin is no verdict", () =>
    // Without an activation there is nothing to fence against: the guard is a
    // fence around drifted plans, not a requirement that a document exist.
    Effect.gen(function* () {
      yield* migrated;
      const dir = seedWorkspace(DOC);
      yield* seedThreadCwd(THREAD, dir);
      NodeFS.writeFileSync(NodePath.join(dir, "TRADE.md"), Buffer.from([0xff, 0xfe, 0x00]));

      assert.equal(yield* guardPlanDocumentDrift("open", THREAD), null);
    }),
  );

  it.effect("a thread with no activated revision wakes plan-less", () =>
    Effect.gen(function* () {
      yield* migrated;
      const dir = seedWorkspace(DOC);
      yield* seedThreadCwd(THREAD, dir);
      // No activation: the document is a draft, and the wake says nothing.

      const { wakeup, text } = yield* composeWake();
      assert.isUndefined(wakeup.planDocument);
      assert.notInclude(text, "planDocument");
    }),
  );

  it.effect("a data failure blocks the wake with the explicit compose reason", () =>
    Effect.gen(function* () {
      yield* migrated;
      const dir = seedWorkspace(DOC);
      yield* seedThreadCwd(THREAD, dir);
      yield* activateCurrent(dir);
      snapshotFails = true;

      const exit = yield* Effect.result(composeWake());
      assert.equal(exit._tag, "Failure");
      if (exit._tag === "Failure") {
        assert.equal(exit.failure._tag, "ComposeWakeupError");
        assert.equal(exit.failure.reason, "snapshot_read_failed");
      }
    }),
  );

  it.effect("the workspace script runs as the agent's untrusted input, not a server hook", () =>
    // Devcon-style: the activated snapshot names scripts/signal.sh. The
    // server never executes it — the agent does, inside its wake turn, with
    // its native tools. This test plays the agent: it runs the fixture script
    // exactly as a native tool would, records the result, and proves no
    // trading execution record exists (no exchange call was attempted by the
    // server on the document's say-so).
    Effect.gen(function* () {
      yield* migrated;
      const dir = seedWorkspace(DOC);
      NodeFS.mkdirSync(NodePath.join(dir, "scripts"));
      NodeFS.writeFileSync(
        NodePath.join(dir, "scripts", "signal.sh"),
        '#!/bin/sh\necho "ema_cross=confirmed mark=$T3_MARK" > signal-result.txt\n',
        { mode: 0o755 },
      );
      yield* seedThreadCwd(THREAD, dir);
      yield* activateCurrent(dir);

      const { wakeup } = yield* composeWake();
      assert.include(
        wakeup.planDocument?.activatedExcerpt ?? "",
        "scripts/signal.sh",
        "the activated snapshot names the workspace utility",
      );

      // The agent's half: run the named script inside the workspace, then
      // read the result back — before any trading call is attempted.
      const run = spawnSync("sh", ["scripts/signal.sh"], {
        cwd: dir,
        env: { ...process.env, T3_MARK: String(MARK) },
      });
      assert.equal(run.status, 0, `fixture script failed: ${String(run.stderr)}`);
      const result = NodeFS.readFileSync(NodePath.join(dir, "signal-result.txt"), "utf8");
      assert.include(result, `ema_cross=confirmed mark=${MARK}`);

      // The server's half: nothing was executed on the document's authority.
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM trading_execution_records WHERE mission_id = 'mission_1'
      `;
      assert.equal(rows[0]?.n, 0);
    }),
  );
});

// Plain `it`, not the layered one: this case builds its own file-backed
// store, and an ambient memory-store composer would answer the service
// lookup instead of the store under test.
it.effect("a reopened store recomposes the same activated revision", () =>
  Effect.gen(function* () {
    const fileDb = NodePath.join(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3trade-plan-wake-restart-")),
      "store.sqlite",
    );
    const dir = seedWorkspace(DOC);
    const firstStore = Layer.provideMerge(
      NodeSqliteClient.layer({ filename: fileDb }),
      NodeServices.layer,
    );
    yield* Effect.gen(function* () {
      yield* runMigrations({});
      yield* seedThreadCwd(THREAD, dir);
      yield* activateCurrent(dir);
    }).pipe(Effect.provide(firstStore));

    // The file drifts while the store is closed, the way a restart really
    // finds it.
    NodeFS.writeFileSync(NodePath.join(dir, "TRADE.md"), `${DOC}\n## LATER EDIT\n`);

    // "Restart": a fresh store over the same file, and the wake recomposed
    // from persisted identity alone — thread row (provider instance + cwd)
    // and the pinned document revision.
    const secondStore = Layer.provideMerge(
      NodeSqliteClient.layer({ filename: fileDb }),
      NodeServices.layer,
    );
    yield* Effect.gen(function* () {
      yield* runMigrations({});
      const { wakeup, text } = yield* composeWake();
      const doc = wakeup.planDocument;
      assert.isDefined(doc);
      if (doc === undefined) return;
      assert.equal(doc.activatedHash, hashTradeContent(DOC));
      assert.equal(doc.status, "drifted");
      assert.isTrue(doc.activatedExcerpt.includes("ema-continuation"));
      assert.notInclude(text, "LATER EDIT");
    }).pipe(Effect.provide(composerOver(secondStore)));
  }),
);
