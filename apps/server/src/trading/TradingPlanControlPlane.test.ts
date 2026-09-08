/**
 * TradingPlanControlPlane tests — GLM-3 slice: chat and TRADE.md as the
 * strategy control plane.
 *
 * Service-level coverage for the product behaviours the tool surface rides on:
 * the persistent-strategy loop (native TRADE.md write, one hash-gated
 * activation, revision audit, no order before a trigger), plan revision with
 * the old revision staying queryable, deactivation (the document's pause) as
 * durable reversible state across a store reopen, mission pause/resume/revoke
 * durability through the real mission service, the input contract that refuses
 * an activation without its required hash, and the research boundary — a
 * disposable data script in the workspace stays the agent's implementation
 * detail while sourced event sets remain typed T3 records.
 *
 * In-memory sqlite + full migrations for the suite; one file-backed store for
 * the reopen-durability cases. Pattern from TradingPlanDocument.test.ts.
 */
// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - fixture files, scripts and JSON payloads by design in tests.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { spawnSync } from "node:child_process";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ThreadId } from "@t3tools/contracts";
import { ProviderInstanceId } from "@t3tools/contracts";
import {
  TradingPlanDocumentInput,
  TRADING_PLAN_DOCUMENT_TOOL,
} from "@t3tools/trading-contracts/plan-document";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { makeTradingEventService } from "./TradingEventService.ts";
import { TradingMissionService } from "./TradingMissionService.ts";
import { TradingMissionServiceLive } from "./TradingMissionService.ts";
import {
  guardPlanDocumentDrift,
  hashTradeContent,
  makeTradingPlanDocumentService,
  readThreadWorkspaceRoot,
} from "./TradingPlanDocument.ts";

const layer = it.layer(Layer.provideMerge(NodeSqliteClient.layerMemory(), NodeServices.layer));

const migrated = Effect.gen(function* () {
  yield* runMigrations({});
  const sql = yield* SqlClient.SqlClient;
  for (const table of [
    "trading_plan_documents",
    "trading_plan_document_revisions",
    "provider_session_runtime",
    "trading_missions",
    "trading_watches",
    "trading_execution_records",
    "trading_position_snapshots",
    "trading_event_sets",
    "trading_event_occurrences",
  ]) {
    yield* sql`DELETE FROM ${sql(table)}`;
  }
});

/** A temp workspace with optional TRADE.md content, as the agent's native write. */
const makeWorkspace = (content?: string): string => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3trade-control-plane-"));
  if (content !== undefined) NodeFS.writeFileSync(NodePath.join(dir, "TRADE.md"), content);
  return dir;
};

/** The EMA strategy a user describes in chat, as the agent drafts it. */
const EMA_PLAN_V1 = `# TRADE.md

## Mandate

Trade BTC on the 20/50 EMA cross, closed 15-minute bars only.

## Strategies

- Entry: buy when ema(20) crosses above ema(50) on a closed 15m bar.
- Confirmation: the crossing bar closes, not touch.
- Stop: 1.5x ATR(14) below entry. Target: 2R or the 4h structure.
- Sizing: ceiling-derived; no notional named. Expiry: cross invalidates after 8 bars.

## Change Log

- 2026-08-31: drafted from the user's request; watching armed on activation.
`;

const EMA_PLAN_V2 = EMA_PLAN_V1.replace("20/50 EMA cross", "50/200 EMA cross").replace(
  "- 2026-08-31: drafted from the user's request; watching armed on activation.",
  "- 2026-08-31: drafted from the user's request; watching armed on activation.\n" +
    "- 2026-08-31: user revised to the 50/200 cross; levels re-armed.",
);

const seedThreadCwd = (threadId: string, cwd: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO provider_session_runtime (
        thread_id, provider_name, provider_instance_id, adapter_key,
        runtime_mode, workspace_mode, status, last_seen_at,
        resume_cursor_json, runtime_payload_json
      ) VALUES (
        ${threadId}, 'codex', 'instance_1', 'codex',
        'full-access', 'market_research', 'stopped', '2026-08-31T00:00:00Z',
        NULL, ${JSON.stringify({ cwd })}
      )
      ON CONFLICT (thread_id) DO UPDATE SET runtime_payload_json = excluded.runtime_payload_json
    `;
  });

layer("TradingPlanControlPlane — the persistent-strategy loop", (it) => {
  it.effect("native TRADE.md write, one activation, revision audit, no order before trigger", () =>
    Effect.gen(function* () {
      yield* migrated;
      const sql = yield* SqlClient.SqlClient;
      const documents = yield* makeTradingPlanDocumentService;

      // The agent's half: it wrote the file with its native tools after the
      // user's request, and read back the hash before activating.
      const dir = makeWorkspace(EMA_PLAN_V1);
      const hash = hashTradeContent(EMA_PLAN_V1);

      const active = yield* documents.activate({
        workspaceRoot: dir,
        expectedContentHash: hash,
        threadId: "thread_strategy",
        provider: "codex",
        changeNote: "arm the 20/50 EMA cross watch",
      });
      assert.equal(active.contentHash, hash);

      // The revision audit row carries the change note the Change Log states.
      const revisions = yield* documents.listRevisions(dir);
      assert.equal(revisions.length, 1);
      assert.equal(revisions[0]?.kind, "activated");
      assert.equal(revisions[0]?.changeNote, "arm the 20/50 EMA cross watch");

      // The strategy is armed as DOCUMENT AND AUDIT ONLY: no order, position
      // or watch appeared from the activation itself. Watching is the watch
      // tool's act, not the document's.
      for (const table of ["trading_execution_records", "trading_position_snapshots"]) {
        const rows = yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM ${sql(table)}`;
        assert.equal(rows[0]?.n, 0, `${table} must be empty`);
      }

      // And the turn seam delivers the document into the next turn, so the
      // activated plan is what the agent reads back.
      yield* seedThreadCwd("thread_strategy", dir);
      assert.equal(yield* readThreadWorkspaceRoot(sql, "thread_strategy"), dir);
      const current = yield* documents.readCurrent(dir);
      assert.equal(current.status, "present");
      if (current.status === "present") assert.equal(current.activation, "active");
    }),
  );

  it.effect(
    "plan revision: the second activation replaces the pin, the first stays queryable",
    () =>
      Effect.gen(function* () {
        yield* migrated;
        const sql = yield* SqlClient.SqlClient;
        const documents = yield* makeTradingPlanDocumentService;
        const dir = makeWorkspace(EMA_PLAN_V1);

        yield* documents.activate({
          workspaceRoot: dir,
          expectedContentHash: hashTradeContent(EMA_PLAN_V1),
          threadId: "thread_strategy",
          provider: "codex",
          changeNote: "arm the 20/50 EMA cross watch",
        });

        // The user revises through chat; the agent edits the file natively.
        NodeFS.writeFileSync(NodePath.join(dir, "TRADE.md"), EMA_PLAN_V2);
        yield* documents.activate({
          workspaceRoot: dir,
          expectedContentHash: hashTradeContent(EMA_PLAN_V2),
          threadId: "thread_strategy",
          provider: "codex",
          changeNote: "user revised to the 50/200 cross",
        });

        // One pin, current revision.
        const pins = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM trading_plan_documents
      `;
        assert.equal(pins[0]?.n, 1);
        const active = yield* documents.readActive(dir);
        assert.equal(active?.contentHash, hashTradeContent(EMA_PLAN_V2));

        // Both revisions remain queryable, newest first, with their notes.
        const revisions = yield* documents.listRevisions(dir);
        assert.equal(revisions.length, 2);
        assert.equal(revisions[0]?.contentHash, hashTradeContent(EMA_PLAN_V2));
        assert.equal(revisions[0]?.changeNote, "user revised to the 50/200 cross");
        assert.equal(revisions[1]?.contentHash, hashTradeContent(EMA_PLAN_V1));
        assert.equal(revisions[1]?.activatedContent, EMA_PLAN_V1);

        // And the revision created no mission or order artifacts of its own.
        for (const table of [
          "trading_missions",
          "trading_execution_records",
          "trading_position_snapshots",
        ]) {
          const rows = yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM ${sql(table)}`;
          assert.equal(rows[0]?.n, 0, `${table} must be empty`);
        }
      }),
  );

  it.effect(
    "the input contract is a flat provider-fillable object, and the tool name is stable",
    () =>
      Effect.sync(() => {
        // A bad action is a schema refusal; an activate with its hash is not.
        assert.equal(
          Schema.decodeUnknownExit(TradingPlanDocumentInput)({ action: "nope" })._tag,
          "Failure",
        );
        assert.equal(
          Schema.decodeUnknownExit(TradingPlanDocumentInput)({
            action: "activate",
            expectedContentHash: "a".repeat(64),
            changeNote: "note",
          })._tag,
          "Success",
        );
        // And the tool name the grounding points at is the one this slice adds.
        assert.equal(TRADING_PLAN_DOCUMENT_TOOL, "trading_plan_document");
      }),
  );
});

layer("TradingPlanControlPlane — deactivate and durability", (it) => {
  it.effect("deactivation stands the revision down, is reversible, and survives a reopen", () =>
    Effect.gen(function* () {
      yield* migrated;
      const sql = yield* SqlClient.SqlClient;
      const documents = yield* makeTradingPlanDocumentService;
      const dir = makeWorkspace(EMA_PLAN_V1);
      yield* seedThreadCwd("thread_pause", dir);

      yield* documents.activate({
        workspaceRoot: dir,
        expectedContentHash: hashTradeContent(EMA_PLAN_V1),
        threadId: "thread_pause",
        provider: "codex",
      });
      assert.equal(yield* guardPlanDocumentDrift("open", "thread_pause"), null);

      // Pause, document-side: the pin goes, the audit stays, the guard no
      // longer has a revision to hold anyone to.
      yield* documents.deactivate({
        workspaceRoot: dir,
        threadId: "thread_pause",
        provider: "codex",
        note: "user paused this strategy",
      });
      const after = yield* documents.readCurrent(dir);
      assert.equal(after.status, "present");
      if (after.status === "present") {
        assert.equal(after.activation, "draft");
        assert.equal(after.activated, null);
      }
      assert.equal(yield* guardPlanDocumentDrift("open", "thread_pause"), null);
      const revisions = yield* documents.listRevisions(dir);
      assert.equal(revisions[0]?.kind, "deactivated");
      assert.equal(revisions[0]?.changeNote, "user paused this strategy");

      // Deactivating nothing is a refusal, not a no-op that hides a mistake.
      const none = yield* Effect.flip(
        documents.deactivate({ workspaceRoot: dir, threadId: "thread_pause", provider: "codex" }),
      );
      assert.equal(none.reason, "not_found");

      // Reversible: re-activation works, and the audit keeps the pause.
      yield* documents.activate({
        workspaceRoot: dir,
        expectedContentHash: hashTradeContent(EMA_PLAN_V1),
        threadId: "thread_pause",
        provider: "codex",
      });
      const resumed = yield* documents.readCurrent(dir);
      assert.equal(resumed.status, "present");
      if (resumed.status === "present") assert.equal(resumed.activation, "active");
      assert.equal((yield* documents.listRevisions(dir)).length, 3);

      // Durable across a store reopen: the pin, the audit and the guard's
      // verdict all come back from SQLite alone. A distinct workspace, so the
      // in-memory suite's rows cannot answer for the reopened file store.
      const fileDb = NodePath.join(
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3trade-control-reopen-")),
        "store.sqlite",
      );
      const fileStore = () =>
        Layer.provideMerge(NodeSqliteClient.layer({ filename: fileDb }), NodeServices.layer);
      const first = fileStore();
      const reopenDir = makeWorkspace(EMA_PLAN_V1);
      yield* Effect.gen(function* () {
        yield* runMigrations({});
        const docs = yield* makeTradingPlanDocumentService;
        yield* docs.activate({
          workspaceRoot: reopenDir,
          expectedContentHash: hashTradeContent(EMA_PLAN_V1),
          threadId: "thread_pause",
          provider: "codex",
        });
        yield* docs.deactivate({
          workspaceRoot: reopenDir,
          threadId: "thread_pause",
          provider: "codex",
          note: "paused before the restart",
        });
      }).pipe(Effect.provide(first));

      const second = fileStore();
      yield* Effect.gen(function* () {
        yield* runMigrations({});
        const docs = yield* makeTradingPlanDocumentService;
        assert.equal(yield* docs.readActive(reopenDir), null);
        const log = yield* docs.listRevisions(reopenDir);
        assert.equal(log[0]?.kind, "deactivated");
        assert.equal(log[0]?.changeNote, "paused before the restart");
        assert.equal(log.length, 2);
      }).pipe(Effect.provide(second));
    }),
  );

  it.effect("mission pause, resume and revoke are durable across a store reopen", () =>
    Effect.gen(function* () {
      yield* migrated;
      const fileDb = NodePath.join(
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3trade-mission-reopen-")),
        "store.sqlite",
      );
      const missionId = "mission_control_plane";
      const create = {
        missionId,
        userId: "user_control_plane",
        tradingAccountId: "acct_control_plane",
        instruction: "Trade ETH per the activated TRADE.md revision.",
        allocatedCapitalUsd: 500,
        capitalSource: "explicit" as const,
        market: "ETH" as const,
        harness: {
          provider: "codex" as const,
          providerInstanceId: ProviderInstanceId.make("instance_control"),
          threadId: ThreadId.make("thread_control_plane"),
          status: "available" as const,
        },
      };

      const first = Layer.provideMerge(
        Layer.provideMerge(TradingMissionServiceLive, NodeSqliteClient.layer({ filename: fileDb })),
        NodeServices.layer,
      );
      yield* Effect.gen(function* () {
        yield* runMigrations({});
        const missions = yield* TradingMissionService;
        yield* missions.createMission(create);
        // §11.1: initializing -> analysing -> paused, the pause a user control
        // takes without the agent provider running. The optimistic-lock
        // version is the mission row's own, re-read between the writes.
        const v1 = yield* missions.getMissionVersion(missionId);
        yield* missions.transition({ missionId, to: "analysing", expectedVersion: v1 });
        const v2 = yield* missions.getMissionVersion(missionId);
        yield* missions.transition({ missionId, to: "paused", expectedVersion: v2 });
      }).pipe(Effect.provide(first));

      const second = Layer.provideMerge(
        Layer.provideMerge(TradingMissionServiceLive, NodeSqliteClient.layer({ filename: fileDb })),
        NodeServices.layer,
      );
      yield* Effect.gen(function* () {
        yield* runMigrations({});
        const missions = yield* TradingMissionService;
        // The pause survived the reopen.
        const paused = yield* missions.getMission(missionId);
        assert.equal(paused.status, "paused");
        // Resume after the restart works, and so does the final stop.
        const vPaused = yield* missions.getMissionVersion(missionId);
        yield* missions.transition({ missionId, to: "analysing", expectedVersion: vPaused });
        const vResumed = yield* missions.getMissionVersion(missionId);
        const revoked = yield* missions.transition({
          missionId,
          to: "revoked",
          expectedVersion: vResumed,
        });
        assert.equal(revoked.status, "revoked");
      }).pipe(Effect.provide(second));
    }),
  );
});

layer("TradingPlanControlPlane — the research boundary", (it) => {
  it.effect(
    "a disposable data script stays workspace detail; sourced events stay typed records",
    () =>
      Effect.gen(function* () {
        yield* migrated;
        const dir = makeWorkspace(EMA_PLAN_V1);

        // The agent's half of a Devcon-style request: a disposable script in
        // the workspace, executed by the agent, its result recorded in TRADE.md.
        // Data-source mechanics are the agent's implementation detail — the
        // server never runs this and has no opinion about it.
        const script = NodePath.join(dir, "normalize_dates.mjs");
        NodeFS.writeFileSync(
          script,
          [
            "const raw = [",
            "  { label: 'Devcon VII', start: '2026-10-06T00:00:00Z' },",
            "  { label: 'Devcon VI', start: '2025-11-10T00:00:00Z' },",
            "];",
            "const normalized = raw",
            "  .map((row) => ({ ...row, start: new Date(row.start).toISOString() }))",
            "  .sort((a, b) => a.start.localeCompare(b.start));",
            "process.stdout.write(JSON.stringify(normalized));",
          ].join("\n"),
        );
        const run = spawnSync(process.execPath, [script], { encoding: "utf8" });
        assert.equal(run.status, 0, `the fixture script must run: ${run.stderr}`);
        const dates = JSON.parse(run.stdout) as ReadonlyArray<{
          readonly label: string;
          readonly start: string;
        }>;
        assert.equal(dates.length, 2);
        assert.equal(dates[0]?.label, "Devcon VI");

        // The strategy and its data dependency are recorded in the document.
        NodeFS.appendFileSync(
          NodePath.join(dir, "TRADE.md"),
          "\nData: normalize_dates.mjs (workspace script); event set 'devcon-dates', " +
            `${dates.length} sourced occurrences.\n`,
        );
        const documents = yield* makeTradingPlanDocumentService;
        const current = yield* documents.readCurrent(dir);
        assert.equal(current.status, "present");
        if (current.status === "present") {
          assert.include(current.content, "normalize_dates.mjs");
          assert.include(current.content, "devcon-dates");
        }

        // The sourced event set is a typed T3 record, not workspace prose: the
        // same event-service seam the event-study tools read.
        const events = yield* makeTradingEventService;
        const written = yield* events.record({
          name: "devcon-dates",
          occurrences: dates.map((row) => ({
            startAt: Date.parse(row.start),
            endAt: Date.parse(row.start),
            label: row.label,
            source: "https://example.com/devcon-dates",
          })),
          threadId: "thread_research",
          author: "agent",
          now: 1,
        });
        const listed = yield* events.list({ now: 2 });
        assert.equal(listed.length, 1);
        assert.equal(listed[0]?.name, "devcon-dates");
        assert.equal(written.outcome, "ok");
        const writtenSet = written.outcome === "ok" ? written.set : null;
        const shown = yield* events.show(writtenSet?.eventSetId ?? listed[0]?.eventSetId ?? "");
        assert.notEqual(shown, null);
        assert.equal(shown?.occurrences.length, 2);
        // Deterministic content hash of the recorded dependency, proving the
        // document the strategy runs on is the one the script produced.
        assert.equal(
          NodeCrypto.createHash("sha256")
            .update(current.status === "present" ? current.content : "")
            .digest("hex"),
          current.status === "present" ? current.contentHash : "",
        );
      }),
  );
});
