/**
 * TradingPlanDocument tests — GLM-2 slice: TRADE.md lifecycle.
 *
 * Covers resolution/refusal (size, encoding, symlink escape), activation with
 * optimistic concurrency, drift as observable state, the NEW-exposure drift
 * guard (and the proof that exposure-reducing actions stay permitted),
 * restart recovery on a reopened file-backed store, worktree isolation, the
 * projectless boundary, old-database migration, and that file edits alone
 * create no mission, watch, order or position.
 *
 * In-memory sqlite + full migrations for the suite; one file-backed store
 * for the restart-recovery case. Pattern from TradingBudgetReader.test.ts.
 */
// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - fixture files and JSON payloads by design in tests.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ThreadId } from "@t3tools/contracts";
import { isPermittedUnderPlanDrift } from "@t3tools/trading-contracts/plan-document";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import {
  guardPlanDocumentDrift,
  hashTradeContent,
  isContainedPath,
  makeTradingPlanDocumentService,
  readThreadWorkspaceRoot,
  readTradeDocument,
  TradingPlanDocumentError,
} from "./TradingPlanDocument.ts";
import {
  applyTradingTurnContractWithContext,
  readTradingPlanTurnContext,
  registerTradingPlanTurnContextReader,
} from "./TradingPlanTurnContext.ts";

const layer = it.layer(Layer.provideMerge(NodeSqliteClient.layerMemory(), NodeServices.layer));

const migrated = Effect.gen(function* () {
  yield* runMigrations({});
  const sql = yield* SqlClient.SqlClient;
  // The adapters' seam reads through the registered reader; install the one
  // the runtime layer would install, backed by this suite's database.
  registerTradingPlanTurnContextReader((threadId) =>
    readTradingPlanTurnContext(threadId).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
  );
  yield* sql`DELETE FROM trading_plan_documents`;
  yield* sql`DELETE FROM provider_session_runtime`;
  yield* sql`DELETE FROM trading_missions`;
  yield* sql`DELETE FROM trading_watches`;
  yield* sql`DELETE FROM trading_execution_records`;
  yield* sql`DELETE FROM trading_position_snapshots`;
});

/** A temp workspace with optional TRADE.md content. */
const makeWorkspace = (content?: string): string => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3trade-plan-doc-"));
  if (content !== undefined) NodeFS.writeFileSync(NodePath.join(dir, "TRADE.md"), content);
  return dir;
};

/** The persisted-cwd row the GLM-1 seam reads, with every NOT NULL column. */
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

/** A raw (non-JSON) payload row, for the malformed-payload case only. */
const seedThreadCwdRaw = (threadId: string, payload: string) =>
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
        NULL, ${payload}
      )
      ON CONFLICT (thread_id) DO UPDATE SET runtime_payload_json = excluded.runtime_payload_json
    `;
  });

const activateCurrent = (workspaceRoot: string, threadId = "thread_activate") =>
  Effect.gen(function* () {
    const documents = yield* makeTradingPlanDocumentService;
    const current = yield* readTradeDocument(workspaceRoot);
    assert.notEqual(current.status, "missing");
    if (current.status === "missing") return null;
    return yield* documents.activate({
      workspaceRoot,
      expectedContentHash: current.contentHash,
      threadId,
      provider: "codex",
      missionId: "mission_1",
      planReference: { version: 4, market: "ETH", intent: "long" },
    });
  });

layer("TradingPlanDocument — resolution and reading", (it) => {
  it.effect("missing file is a clean absence, not an error", () =>
    Effect.gen(function* () {
      yield* migrated;
      const dir = makeWorkspace();
      const current = yield* readTradeDocument(dir);
      assert.equal(current.status, "missing");
    }),
  );

  it.effect("valid load returns path, hash and content", () =>
    Effect.gen(function* () {
      yield* migrated;
      const dir = makeWorkspace("# Mandate\n\nHold testnet ETH only.\n");
      const current = yield* readTradeDocument(dir);
      assert.equal(current.status, "present");
      if (current.status !== "present") return;
      assert.equal(NodePath.basename(current.path), "TRADE.md");
      assert.equal(current.contentHash, hashTradeContent("# Mandate\n\nHold testnet ETH only.\n"));
      assert.include(current.content, "Hold testnet ETH only");
    }),
  );

  it.effect("oversized content is refused explicitly", () =>
    Effect.gen(function* () {
      yield* migrated;
      const dir = makeWorkspace("x".repeat(65_537));
      const result = yield* Effect.flip(readTradeDocument(dir));
      assert.instanceOf(result, TradingPlanDocumentError);
      assert.equal(result.reason, "oversized");
    }),
  );

  it.effect("non-UTF8 content is refused explicitly", () =>
    Effect.gen(function* () {
      yield* migrated;
      const dir = makeWorkspace();
      NodeFS.writeFileSync(NodePath.join(dir, "TRADE.md"), Buffer.from([0xff, 0xfe, 0x00]));
      const result = yield* Effect.flip(readTradeDocument(dir));
      assert.instanceOf(result, TradingPlanDocumentError);
      assert.equal(result.reason, "not_utf8");
    }),
  );

  it("path containment is a pure verdict that refuses escapes", () => {
    const root = NodePath.join(NodeOS.tmpdir(), "ws");
    assert.isTrue(isContainedPath(root, NodePath.join(root, "TRADE.md")));
    assert.isFalse(isContainedPath(root, NodePath.join(root, "..", "TRADE.md")));
    assert.isFalse(isContainedPath(root, root));
    assert.isFalse(isContainedPath(root, NodePath.join(`${root}-sibling`, "TRADE.md")));
  });

  it.effect("a symlinked document pointing outside the root is refused", () =>
    Effect.gen(function* () {
      yield* migrated;
      const outside = makeWorkspace("# outside the fence");
      const dir = makeWorkspace();
      NodeFS.symlinkSync(NodePath.join(outside, "TRADE.md"), NodePath.join(dir, "TRADE.md"));
      const result = yield* Effect.flip(readTradeDocument(dir));
      assert.instanceOf(result, TradingPlanDocumentError);
      assert.equal(result.reason, "symlink_escape");
    }),
  );

  it.effect("a symlinked document pointing inside the root is read", () =>
    Effect.gen(function* () {
      yield* migrated;
      const dir = makeWorkspace();
      NodeFS.mkdirSync(NodePath.join(dir, "docs"));
      NodeFS.writeFileSync(NodePath.join(dir, "docs", "TRADE.md"), "inner");
      NodeFS.symlinkSync(NodePath.join(dir, "docs", "TRADE.md"), NodePath.join(dir, "TRADE.md"));
      const current = yield* readTradeDocument(dir);
      assert.equal(current.status, "present");
      if (current.status === "present") assert.equal(current.content, "inner");
    }),
  );
});

layer("TradingPlanDocument — activation and drift", (it) => {
  it.effect("activation persists exactly one revision and no exchange-shaped state", () =>
    Effect.gen(function* () {
      yield* migrated;
      const sql = yield* SqlClient.SqlClient;
      const dir = makeWorkspace("# v1");
      const active = yield* activateCurrent(dir);
      assert.notEqual(active, null);
      const rows = yield* sql<{
        readonly n: number;
      }>`SELECT COUNT(*) AS n FROM trading_plan_documents`;
      assert.equal(rows[0]?.n, 1);
      assert.equal(active?.activatedContent, "# v1");
      assert.equal(active?.missionId, "mission_1");
      assert.deepEqual(active?.planReference, { version: 4, market: "ETH", intent: "long" });
      // No execution-shaped rows appeared: activation is bookkeeping only.
      const orders = yield* sql<{
        readonly n: number;
      }>`SELECT COUNT(*) AS n FROM trading_execution_records`;
      assert.equal(orders[0]?.n, 0);
    }),
  );

  it.effect("a stale hash refuses and leaves the active revision untouched", () =>
    Effect.gen(function* () {
      yield* migrated;
      const documents = yield* makeTradingPlanDocumentService;
      const dir = makeWorkspace("# v1");
      yield* activateCurrent(dir);
      // The file changes after the caller's read.
      NodeFS.writeFileSync(NodePath.join(dir, "TRADE.md"), "# v2, behind the caller's back");
      const result = yield* Effect.flip(
        documents.activate({
          workspaceRoot: dir,
          expectedContentHash: hashTradeContent("# v1"),
          threadId: "thread_activate",
          provider: "codex",
        }),
      );
      assert.equal(result.reason, "stale_hash");
      const still = yield* documents.readActive(dir);
      assert.equal(still?.activatedContent, "# v1");
      assert.equal(still?.contentHash, hashTradeContent("# v1"));
    }),
  );

  it.effect("drift is observable state: the file moves, the active revision does not", () =>
    Effect.gen(function* () {
      yield* migrated;
      const sql = yield* SqlClient.SqlClient;
      const documents = yield* makeTradingPlanDocumentService;
      const dir = makeWorkspace("# v1");
      yield* activateCurrent(dir);
      NodeFS.writeFileSync(NodePath.join(dir, "TRADE.md"), "# v1 but edited");
      const current = yield* documents.readCurrent(dir);
      assert.equal(current.status, "present");
      if (current.status !== "present") return;
      assert.equal(current.activation, "drifted");
      const active = yield* documents.readActive(dir);
      assert.equal(active?.activatedContent, "# v1");
      assert.equal(active?.contentHash, hashTradeContent("# v1"));
      // Observable only: no mission, watch, order or position was created or
      // mutated by the edit or the drift observation.
      for (const table of [
        "trading_missions",
        "trading_watches",
        "trading_execution_records",
        "trading_position_snapshots",
      ]) {
        const rows = yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM ${sql(table)}`;
        assert.equal(rows[0]?.n, 0, `${table} should be empty`);
      }
    }),
  );

  it.effect("unactivated file classifies as draft; hash match classifies as active", () =>
    Effect.gen(function* () {
      yield* migrated;
      const documents = yield* makeTradingPlanDocumentService;
      const dir = makeWorkspace("# fresh");
      const draft = yield* documents.readCurrent(dir);
      assert.equal(draft.status, "present");
      if (draft.status !== "present") return;
      assert.equal(draft.activation, "draft");
      yield* activateCurrent(dir);
      const activeNow = yield* documents.readCurrent(dir);
      assert.equal(activeNow.status, "present");
      if (activeNow.status !== "present") return;
      assert.equal(activeNow.activation, "active");
    }),
  );

  it.effect("a missing file after activation classifies as none", () =>
    Effect.gen(function* () {
      yield* migrated;
      const documents = yield* makeTradingPlanDocumentService;
      const dir = makeWorkspace("# v1");
      yield* activateCurrent(dir);
      NodeFS.rmSync(NodePath.join(dir, "TRADE.md"));
      const current = yield* documents.readCurrent(dir);
      assert.equal(current.status, "missing");
      // The persisted snapshot survives for the audit trail and GLM-4.
      const active = yield* documents.readActive(dir);
      assert.equal(active?.activatedContent, "# v1");
    }),
  );

  it.effect("two workspaces keep independent documents and activations", () =>
    Effect.gen(function* () {
      yield* migrated;
      const documents = yield* makeTradingPlanDocumentService;
      const a = makeWorkspace("# workspace A");
      const b = makeWorkspace("# workspace B");
      yield* activateCurrent(a);
      // A drifts, B was never activated.
      NodeFS.writeFileSync(NodePath.join(a, "TRADE.md"), "# workspace A, edited");
      const inA = yield* documents.readCurrent(a);
      const inB = yield* documents.readCurrent(b);
      assert.equal(inA.status, "present");
      if (inA.status === "present") assert.equal(inA.activation, "drifted");
      assert.equal(inB.status, "present");
      if (inB.status === "present") assert.equal(inB.activation, "draft");
      const activeB = yield* documents.readActive(b);
      assert.equal(activeB, null);
      // Same content in both does not merge state either: rows are per root.
      NodeFS.writeFileSync(NodePath.join(b, "TRADE.md"), "# workspace A, edited");
      yield* activateCurrent(b, "thread_b");
      const rows = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql<{ readonly root: string; readonly thread: string }>`
          SELECT workspace_root AS root, activated_by_thread_id AS thread FROM trading_plan_documents
        `;
      });
      assert.equal(rows.length, 2);
      assert.deepEqual(rows.map((row) => row.thread).sort(), ["thread_activate", "thread_b"]);
    }),
  );
});

layer("TradingPlanDocument — drift guard on new exposure", (it) => {
  it.effect("new exposure refuses on drift", () =>
    Effect.gen(function* () {
      yield* migrated;
      const dir = makeWorkspace("# v1");
      yield* seedThreadCwd("thread_guard", dir);
      yield* activateCurrent(dir);
      NodeFS.writeFileSync(NodePath.join(dir, "TRADE.md"), "# v1 edited");
      const refusal = yield* guardPlanDocumentDrift("open", "thread_guard");
      assert.notEqual(refusal, null);
      assert.equal(refusal?.reason, "plan_document_drifted");
      assert.include(refusal?.detail ?? "", "re-activate");
    }),
  );

  it.effect("no drift (active, draft, none) means no refusal", () =>
    Effect.gen(function* () {
      yield* migrated;
      const dir = makeWorkspace("# v1");
      yield* seedThreadCwd("thread_clean", dir);
      yield* activateCurrent(dir);
      assert.equal(yield* guardPlanDocumentDrift("open", "thread_clean"), null);
      // Draft: never activated.
      const draftDir = makeWorkspace("# draft only");
      yield* seedThreadCwd("thread_draft", draftDir);
      assert.equal(yield* guardPlanDocumentDrift("scale_in", "thread_draft"), null);
      // No workspace at all.
      assert.equal(yield* guardPlanDocumentDrift("open", "thread_nowhere"), null);
    }),
  );

  it.effect("exposure-reducing and protective actions stay permitted under drift", () =>
    Effect.gen(function* () {
      yield* migrated;
      const dir = makeWorkspace("# v1");
      yield* seedThreadCwd("thread_reduce", dir);
      yield* activateCurrent(dir);
      NodeFS.writeFileSync(NodePath.join(dir, "TRADE.md"), "# v1 edited");
      for (const actionType of ["cancel", "reduce", "close", "modify_stop", "move_stop"]) {
        assert.isTrue(isPermittedUnderPlanDrift(actionType), `${actionType} must be permitted`);
        assert.equal(yield* guardPlanDocumentDrift(actionType, "thread_reduce"), null);
      }
      for (const actionType of ["open", "scale_in"]) {
        assert.isFalse(isPermittedUnderPlanDrift(actionType));
        assert.notEqual(yield* guardPlanDocumentDrift(actionType, "thread_reduce"), null);
      }
    }),
  );

  it.effect("a drifted document that is re-activated unblocks new exposure", () =>
    Effect.gen(function* () {
      yield* migrated;
      const dir = makeWorkspace("# v1");
      yield* seedThreadCwd("thread_resync", dir);
      yield* activateCurrent(dir);
      NodeFS.writeFileSync(NodePath.join(dir, "TRADE.md"), "# v2");
      assert.notEqual(yield* guardPlanDocumentDrift("open", "thread_resync"), null);
      yield* activateCurrent(dir, "thread_resync");
      assert.equal(yield* guardPlanDocumentDrift("open", "thread_resync"), null);
    }),
  );
});

layer("TradingPlanDocument — turn context injection", (it) => {
  it.effect("no persisted cwd or no file means no block and no error", () =>
    Effect.gen(function* () {
      yield* migrated;
      assert.equal(yield* readTradingPlanTurnContext("thread_absent"), null);
      const dir = makeWorkspace();
      yield* seedThreadCwd("thread_empty_ws", dir);
      assert.equal(yield* readTradingPlanTurnContext("thread_empty_ws"), null);
    }),
  );

  it.effect("a present document injects one delimited, bounded block with facts", () =>
    Effect.gen(function* () {
      yield* migrated;
      const dir = makeWorkspace("# Mandate\n\nTrade the plan, not the mood.\n");
      yield* seedThreadCwd("thread_ctx", dir);
      const block = yield* readTradingPlanTurnContext("thread_ctx");
      assert.notEqual(block, null);
      assert.include(block, "[t3-trade plan document] path=");
      assert.include(
        block,
        `sha256=${hashTradeContent("# Mandate\n\nTrade the plan, not the mood.\n")}`,
      );
      assert.include(block, "activation=draft");
      assert.include(block, "--- TRADE.md begin ---");
      assert.include(block, "--- TRADE.md end ---");
      assert.include(block, "Trade the plan, not the mood.");
    }),
  );

  it.effect("the block rides the shared turn-contract seam, appended after the text", () =>
    Effect.gen(function* () {
      yield* migrated;
      const dir = makeWorkspace("# context");
      yield* seedThreadCwd("thread_seam", dir);
      const contract = yield* applyTradingTurnContractWithContext(
        ThreadId.make("thread_seam"),
        "user message",
      );
      assert.include(contract.text, "user message");
      assert.include(contract.text, "[t3-trade plan document]");
      // The grounding preamble (non-trading thread) still leads the turn.
      assert.isTrue(
        contract.text.indexOf("T3 Trade grounding:") < contract.text.indexOf("user message"),
      );
      // And the plan block arrives after the turn's own text.
      assert.isTrue(
        contract.text.indexOf("user message") < contract.text.indexOf("[t3-trade plan document]"),
      );
      contract.markDelivered();
    }),
  );

  it.effect("an oversized or escaping document degrades to no block, not a failed turn", () =>
    Effect.gen(function* () {
      yield* migrated;
      const dir = makeWorkspace("y".repeat(65_537));
      yield* seedThreadCwd("thread_bad", dir);
      assert.equal(yield* readTradingPlanTurnContext("thread_bad"), null);
    }),
  );
});

layer("TradingPlanDocument — persisted cwd and projectless boundary", (it) => {
  it.effect("the thread workspace root comes from the persisted runtime payload", () =>
    Effect.gen(function* () {
      yield* migrated;
      const sql = yield* SqlClient.SqlClient;
      yield* seedThreadCwd("thread_cwd", "/definitely/a/workspace");
      assert.equal(yield* readThreadWorkspaceRoot(sql, "thread_cwd"), "/definitely/a/workspace");
      // Malformed or absent payloads resolve to null, never a guess.
      assert.equal(yield* readThreadWorkspaceRoot(sql, "thread_never"), null);
      yield* sql`DELETE FROM provider_session_runtime WHERE thread_id = 'thread_cwd'`;
      yield* seedThreadCwdRaw("thread_cwd", "not json");
      assert.equal(yield* readThreadWorkspaceRoot(sql, "thread_cwd"), null);
    }),
  );

  it.effect("the server never writes the workspace document, and state holds no TRADE.md", () =>
    Effect.gen(function* () {
      yield* migrated;
      const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3trade-plan-state-"));
      // A projectless-style workspace under the state dir, as
      // prepareProjectlessWorkspace lays it out.
      const projectless = NodePath.join(stateDir, "projectless-workspaces", "thread_pl");
      NodeFS.mkdirSync(projectless, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(projectless, "TRADE.md"), "# projectless plan");
      const documents = yield* makeTradingPlanDocumentService;
      const before = NodeFS.readFileSync(NodePath.join(projectless, "TRADE.md"), "utf8");
      yield* documents.readCurrent(projectless);
      yield* activateCurrent(projectless, "thread_pl");
      assert.equal(NodeFS.readFileSync(NodePath.join(projectless, "TRADE.md"), "utf8"), before);
      // Reading and activating an absent document creates no file anywhere
      // in the state dir outside the workspace that already owned one.
      const emptyState = NodePath.join(stateDir, "projectless-workspaces", "thread_empty");
      NodeFS.mkdirSync(emptyState, { recursive: true });
      yield* documents.readCurrent(emptyState);
      const found: Array<string> = [];
      const walk = (current: string): void => {
        for (const name of NodeFS.readdirSync(current)) {
          const full = NodePath.join(current, name);
          if (NodeFS.statSync(full).isDirectory()) walk(full);
          else if (name === "TRADE.md") found.push(full);
        }
      };
      walk(stateDir);
      assert.deepEqual(found, [NodePath.join(projectless, "TRADE.md")]);
    }),
  );
});

layer("TradingPlanDocument — restart recovery and migration", (it) => {
  it.effect("a reopened store recovers the active revision, hash and drift", () =>
    Effect.gen(function* () {
      const fileDb = NodePath.join(
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3trade-plan-restart-")),
        "store.sqlite",
      );
      const firstStore = Layer.provideMerge(
        NodeSqliteClient.layer({ filename: fileDb }),
        NodeServices.layer,
      );
      const dir = makeWorkspace("# persisted v1");
      yield* Effect.gen(function* () {
        yield* runMigrations({});
        const documents = yield* makeTradingPlanDocumentService;
        yield* activateCurrent(dir, "thread_restart");
      }).pipe(Effect.provide(firstStore));

      // "Restart": a fresh client over the same file, migrations current.
      const secondStore = Layer.provideMerge(
        NodeSqliteClient.layer({ filename: fileDb }),
        NodeServices.layer,
      );
      yield* Effect.gen(function* () {
        yield* runMigrations({});
        const documents = yield* makeTradingPlanDocumentService;
        const active = yield* documents.readActive(dir);
        assert.notEqual(active, null);
        assert.equal(active?.activatedContent, "# persisted v1");
        assert.equal(active?.activatedByThreadId, "thread_restart");
        // Drift survives too: the file changed while the store was closed.
        NodeFS.writeFileSync(NodePath.join(dir, "TRADE.md"), "# persisted v1, edited later");
        const current = yield* documents.readCurrent(dir);
        assert.equal(current.status, "present");
        if (current.status === "present") assert.equal(current.activation, "drifted");
      }).pipe(Effect.provide(secondStore));
    }),
  );

  it.effect("a database at schema 88 migrates cleanly to 89", () =>
    Effect.gen(function* () {
      // A separate store, held at the previous schema version: the suite's
      // shared database is already current and must not be rolled back.
      const fileDb = NodePath.join(
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3trade-plan-migrate-")),
        "old.sqlite",
      );
      const oldStore = Layer.provideMerge(
        NodeSqliteClient.layer({ filename: fileDb }),
        NodeServices.layer,
      );
      yield* runMigrations({ toMigrationInclusive: 88 }).pipe(Effect.provide(oldStore));
      const check = Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql<{ readonly n: number }>`
          SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'trading_plan_documents'
        `;
      }).pipe(Effect.provide(oldStore));
      assert.equal((yield* check)[0]?.n, 0);

      const migratedStore = Layer.provideMerge(
        NodeSqliteClient.layer({ filename: fileDb }),
        NodeServices.layer,
      );
      yield* runMigrations({}).pipe(Effect.provide(migratedStore));
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const after = yield* sql<{ readonly n: number }>`
          SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'trading_plan_documents'
        `;
        assert.equal(after[0]?.n, 1);
        // And the migrated table is writable through the service.
        const documents = yield* makeTradingPlanDocumentService;
        const dir = makeWorkspace("# migrated");
        const active = yield* activateCurrent(dir, "thread_migrated");
        assert.equal(active?.activatedContent, "# migrated");
      }).pipe(Effect.provide(migratedStore));
    }),
  );
});
