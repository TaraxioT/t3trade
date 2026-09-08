/**
 * TradingPlanDocument — resolve, read and pin a workspace's TRADE.md.
 *
 * TRADE.md is persistent human-readable trading context, the peer of
 * AGENTS.md: the agent reads it with its native tools and acts through the
 * typed trading tools. This module is the server's half of that contract and
 * nothing more — it resolves the document at a workspace root with
 * containment checks, reads it with a size and encoding bound, pins one
 * activated revision per workspace for stable background execution, and
 * classifies drift between the live file and that revision as observable
 * state. It never writes the workspace file, never parses the document into
 * an exchange call, and performs no exchange call itself.
 *
 * One row per workspace root (`trading_plan_documents`, migration 089), so
 * two checkouts of the same repository keep independent documents and
 * independent activations, and a restart recovers the active revision, hash
 * and snapshot from SQLite alone. The row also records the thread cwd it was
 * activated through (migration 091) so a pin stays discoverable — and the
 * drift fence enforceable — after the workspace directory itself is deleted.
 *
 * @module TradingPlanDocument
 */
// @effect-diagnostics nodeBuiltinImport:off - sync fs and crypto by design: a bounded document read at turn and guard seams, not an Effect filesystem pipeline.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { Schema } from "effect";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { type SqlError } from "effect/unstable/sql/SqlError";

import {
  classifyPlanDocument,
  isPermittedUnderPlanDrift,
  TRADE_MD_FILENAME,
  TRADE_MD_MAX_BYTES,
  type TradingPlanActivationState,
} from "@t3tools/trading-contracts/plan-document";

/** Why a plan-document operation refused. One name per rule, the server's own. */
export class TradingPlanDocumentError extends Schema.TaggedErrorClass<TradingPlanDocumentError>()(
  "TradingPlanDocumentError",
  {
    reason: Schema.Literals([
      /** The resolved document path would leave the workspace root. */
      "path_escape",
      /** The document (or a component of it) is a symlink pointing outside the root. */
      "symlink_escape",
      /** The file exceeds the readable size bound. */
      "oversized",
      /** The file is not valid UTF-8. */
      "not_utf8",
      /** The file (or the root) could not be read. */
      "read_failed",
      /** The file changed between the caller's read and this activation. */
      "stale_hash",
      /** No such file where the operation requires one. */
      "not_found",
    ]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `TradingPlanDocumentError(${this.reason}): ${this.detail}`;
  }
}

/** The persisted activated revision for one workspace root. */
export interface ActivePlanDocument {
  readonly workspaceRoot: string;
  readonly documentPath: string;
  readonly contentHash: string;
  /** The exact activated content — background execution reads this, never the live file. */
  readonly activatedContent: string;
  readonly activatedAt: string;
  readonly activatedByThreadId: string;
  readonly activatedByProvider: string;
  readonly missionId: string | null;
  /** The structured runtime plan reference recorded at activation, if any. */
  readonly planReference: unknown;
}

/**
 * One row of the append-only activation log (`migration 090`). Every
 * activation and deactivation appends; nothing here is ever updated, so the
 * revision a mission ran on last week stays queryable after the next one.
 */
export interface PlanDocumentRevision {
  readonly id: number;
  readonly workspaceRoot: string;
  /** `"activated"` or `"deactivated"`. */
  readonly kind: string;
  readonly contentHash: string | null;
  readonly activatedContent: string | null;
  readonly activatedAt: string;
  readonly activatedByThreadId: string;
  readonly activatedByProvider: string;
  readonly missionId: string | null;
  readonly changeNote: string | null;
}

/** What a raw read found: nothing, or the current file's facts. */
export type TradeDocumentRead =
  | { readonly status: "missing" }
  | {
      readonly status: "present";
      readonly path: string;
      readonly contentHash: string;
      readonly content: string;
    };

/** The raw read classified against the persisted activation. */
export type CurrentPlanDocument =
  | { readonly status: "missing" }
  | (TradeDocumentRead & { readonly status: "present" } extends infer _
      ? {
          readonly status: "present";
          readonly path: string;
          readonly contentHash: string;
          readonly content: string;
          readonly activation: TradingPlanActivationState;
          readonly activated: ActivePlanDocument | null;
        }
      : never);

/** A pure containment verdict: does `candidate` sit inside `root`? */
export function isContainedPath(root: string, candidate: string): boolean {
  if (root === candidate) return false; // the root itself is not a document inside it
  const rootWithSep = root.endsWith(NodePath.sep) ? root : root + NodePath.sep;
  return candidate.startsWith(rootWithSep);
}

/** The document path a workspace root resolves to, before containment checks. */
export function tradeDocumentPath(workspaceRoot: string): string {
  return NodePath.resolve(workspaceRoot, TRADE_MD_FILENAME);
}

/** SHA-256 of the document content, hex — the revision identity. */
export function hashTradeContent(content: string): string {
  return NodeCrypto.createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Size- and encoding-bounded decode. A file over the limit or not valid
 * UTF-8 is refused explicitly rather than truncated into a document the
 * agent would then act on believing it had read all of.
 */
export function decodeTradeDocument(bytes: Uint8Array): string {
  if (bytes.byteLength > TRADE_MD_MAX_BYTES) {
    throw new TradingPlanDocumentError({
      reason: "oversized",
      detail: `${TRADE_MD_FILENAME} is ${bytes.byteLength} bytes; the readable bound is ${TRADE_MD_MAX_BYTES}`,
    });
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new TradingPlanDocumentError({
      reason: "not_utf8",
      detail: `${TRADE_MD_FILENAME} is not valid UTF-8`,
    });
  }
}

/**
 * A thrown {@link TradingPlanDocumentError} passes through as itself;
 * anything else an fs/decode step threw is a read failure.
 */
const isDocumentError = Schema.is(TradingPlanDocumentError);

const asDocumentError = (cause: unknown): TradingPlanDocumentError =>
  isDocumentError(cause)
    ? cause
    : new TradingPlanDocumentError({
        reason: "read_failed",
        detail: cause instanceof Error ? cause.message : String(cause),
      });

/**
 * Resolve the real workspace root: the identity a plan-document row is keyed
 * by, so two spellings of one directory share one activation and a symlinked
 * root cannot fork state.
 */
const realRootOf = (workspaceRoot: string): string =>
  NodeFS.realpathSync(NodePath.resolve(workspaceRoot));

/**
 * The row identities a workspace root can be found by.
 *
 * While the directory exists, its real path is the key and the only one
 * consulted. Once the directory is gone the real path is unknowable, and the
 * lexical thread cwd — matched against the row key and the cwd spelling
 * recorded at activation — is what keeps a standing pin discoverable: the
 * fence's whole premise is that the pinned snapshot outlives the directory
 * it was read from.
 */
const planRowKeys = (
  workspaceRoot: string,
): { readonly lexical: string; readonly real: string | null } => {
  const lexical = NodePath.resolve(workspaceRoot);
  try {
    return { lexical, real: NodeFS.realpathSync(lexical) };
  } catch {
    return { lexical, real: null };
  }
};

/**
 * Read the CURRENT document under one workspace root, with every containment
 * and content check. Returns `missing` when no file exists; refuses on
 * escape, oversize and bad encoding.
 */
export const readTradeDocument = Effect.fn("TradingPlanDocument.readTradeDocument")(
  (workspaceRoot: string): Effect.Effect<TradeDocumentRead, TradingPlanDocumentError> =>
    Effect.gen(function* () {
      const realRoot = yield* Effect.try({
        try: () => realRootOf(workspaceRoot),
        catch: () =>
          new TradingPlanDocumentError({
            reason: "read_failed",
            detail: `the workspace root could not be resolved: ${workspaceRoot}`,
          }),
      });
      const documentPath = tradeDocumentPath(realRoot);
      const contained = yield* Effect.sync(() => isContainedPath(realRoot, documentPath));
      if (!contained) {
        return yield* new TradingPlanDocumentError({
          reason: "path_escape",
          detail: `${documentPath} resolves outside the workspace root ${realRoot}`,
        });
      }
      // A symlinked document (or one reached through symlinked directories)
      // is fine only while it still lands inside the real root — that is the
      // same containment, checked on the fully resolved path.
      const realDocumentPath = yield* Effect.sync(() => {
        try {
          return NodeFS.realpathSync(documentPath);
        } catch {
          return null;
        }
      });
      if (realDocumentPath === null) return { status: "missing" };
      if (
        NodePath.resolve(documentPath) !== realDocumentPath &&
        !isContainedPath(realRoot, realDocumentPath)
      ) {
        return yield* new TradingPlanDocumentError({
          reason: "symlink_escape",
          detail: `${TRADE_MD_FILENAME} resolves to ${realDocumentPath}, outside the workspace root ${realRoot}`,
        });
      }
      const bytes = yield* Effect.try({
        try: () =>
          NodeFS.statSync(realDocumentPath).isFile() ? NodeFS.readFileSync(realDocumentPath) : null,
        catch: (cause) =>
          new TradingPlanDocumentError({
            reason: "read_failed",
            detail: `${TRADE_MD_FILENAME} could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
          }),
      });
      if (bytes === null) return { status: "missing" };
      const content = yield* Effect.try({
        try: () => decodeTradeDocument(bytes),
        catch: asDocumentError,
      });
      return {
        status: "present",
        path: realDocumentPath,
        contentHash: hashTradeContent(content),
        content,
      };
    }),
);

/** The plan reference as a stored JSON value; undefined stores null. */
const planReferenceToJson = (planReference: unknown): string | null =>
  planReference === undefined
    ? null
    : Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(planReference);

const decodeActiveRow = (row: {
  workspace_root: string;
  document_path: string;
  content_hash: string;
  activated_content: string;
  activated_at: string;
  activated_by_thread_id: string;
  activated_by_provider: string;
  mission_id: string | null;
  plan_reference_json: string | null;
}): ActivePlanDocument => ({
  workspaceRoot: row.workspace_root,
  documentPath: row.document_path,
  contentHash: row.content_hash,
  activatedContent: row.activated_content,
  activatedAt: row.activated_at,
  activatedByThreadId: row.activated_by_thread_id,
  activatedByProvider: row.activated_by_provider,
  missionId: row.mission_id,
  planReference:
    row.plan_reference_json === null
      ? null
      : Exit.match(
          Schema.decodeUnknownExit(Schema.fromJsonString(Schema.Unknown))(row.plan_reference_json),
          { onFailure: () => null, onSuccess: (value) => value },
        ),
});

/**
 * The plan-document service. Depends only on SQL: the document itself is a
 * file read, and the pinned revisions are rows.
 */
export class TradingPlanDocumentService extends Context.Service<
  TradingPlanDocumentService,
  {
    /**
     * The current document at a workspace root, classified against the
     * persisted activation: none / draft / active / drifted. Drift is
     * observable state only — nothing is mutated here.
     */
    readonly readCurrent: (
      workspaceRoot: string,
    ) => Effect.Effect<CurrentPlanDocument, TradingPlanDocumentError>;

    /** The persisted activated revision for a workspace root, or null. */
    readonly readActive: (
      workspaceRoot: string,
    ) => Effect.Effect<ActivePlanDocument | null, TradingPlanDocumentError>;

    /**
     * Activate (or re-sync) the document at a workspace root.
     *
     * Optimistic concurrency: `expectedContentHash` is the hash the caller
     * read; a file that changed since refuses with `stale_hash` WITHOUT
     * altering the active revision. A successful activation persists exactly
     * one revision — the upsert replaces this workspace's previous activation
     * — and performs no exchange call.
     */
    readonly activate: (input: {
      readonly workspaceRoot: string;
      readonly expectedContentHash: string;
      readonly threadId: string;
      readonly provider: string;
      readonly missionId?: string | undefined;
      readonly planReference?: unknown;
      readonly changeNote?: string | undefined;
    }) => Effect.Effect<ActivePlanDocument, TradingPlanDocumentError>;

    /**
     * Stand the workspace's activated revision down: the main row is deleted
     * (activation returns to none/draft) and a `"deactivated"` revision row
     * appends the audit trail. Refuses `not_activated` when nothing is pinned.
     * Performs no exchange call and touches no mission state.
     */
    readonly deactivate: (input: {
      readonly workspaceRoot: string;
      readonly threadId: string;
      readonly provider: string;
      readonly note?: string | undefined;
    }) => Effect.Effect<void, TradingPlanDocumentError>;

    /** The append-only activation log for a workspace root, newest first. */
    readonly listRevisions: (
      workspaceRoot: string,
    ) => Effect.Effect<ReadonlyArray<PlanDocumentRevision>, TradingPlanDocumentError>;

    /**
     * Best-effort attribution refresh: an accepted plan publication on a
     * thread whose workspace holds an activated document records the new
     * structured plan reference against that activation. Never creates a row
     * and never fails the publication.
     */
    readonly notePlanPublication: (input: {
      readonly threadId: string;
      readonly missionId: string;
      readonly planReference: unknown;
    }) => Effect.Effect<void>;
  }
>()("t3/trading/TradingPlanDocument/TradingPlanDocumentService") {}

/**
 * What a thread's persisted runtime payload says about its workspace cwd.
 *
 * - `resolved` — the payload names a usable cwd.
 * - `absent` — no runtime row (or a NULL payload): the thread recorded no
 *   session, so no activation can have been reached through it.
 * - `unusable` — a row exists but cannot name a cwd (malformed JSON, a
 *   non-object, a wrong-typed or empty `cwd`). Migration 091's own test
 *   establishes such rows exist; a thread in this state may still hold a
 *   standing activation it can no longer name, so consumers that enforce a
 *   fence must treat this as unreadable, never as absence.
 */
export type ThreadWorkspaceRootResolution =
  | { readonly status: "resolved"; readonly cwd: string }
  | { readonly status: "absent" }
  | { readonly status: "unusable"; readonly cause: string };

/**
 * The thread's workspace root, from the same persisted cwd GLM-1 made
 * authoritative (`provider_session_runtime.runtime_payload_json`). No new cwd
 * source: projectless threads resolve to their per-thread scratch workspace,
 * project threads to their checkout.
 *
 * Strict and integrity-aware: a failed SQL read FAILS, and a row that exists
 * but cannot name a cwd resolves `unusable` rather than absent. The lenient
 * {@link readThreadWorkspaceRoot} below flattens both for enrichment callers;
 * the drift guard uses this strict form so neither an unreadable nor a
 * corrupt cwd can pass as "no workspace" and skip the fence.
 */
export const readThreadWorkspaceRootStrict = Effect.fn(
  "TradingPlanDocument.readThreadWorkspaceRootStrict",
)(
  (
    sql: SqlClient.SqlClient,
    threadId: string,
  ): Effect.Effect<ThreadWorkspaceRootResolution, SqlError> =>
    Effect.gen(function* () {
      const rows = yield* sql<{ readonly payload: string | null }>`
        SELECT runtime_payload_json AS payload
        FROM provider_session_runtime
        WHERE thread_id = ${threadId}
      `;
      const payload = rows[0]?.payload;
      if (payload === null || payload === undefined) return { status: "absent" };
      const parsed = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(
        payload,
      ).pipe(Effect.orElseSucceed(() => null));
      if (parsed === null) {
        return { status: "unusable", cause: "the persisted runtime payload is not valid JSON" };
      }
      if (typeof parsed !== "object" || Array.isArray(parsed)) {
        return { status: "unusable", cause: "the persisted runtime payload is not a JSON object" };
      }
      const rawCwd = "cwd" in parsed ? (parsed as { readonly cwd?: unknown }).cwd : undefined;
      if (typeof rawCwd !== "string") {
        return { status: "unusable", cause: "the persisted cwd is not a string" };
      }
      const cwd = rawCwd.trim();
      if (cwd.length === 0) {
        return { status: "unusable", cause: "the persisted cwd is empty" };
      }
      return { status: "resolved", cwd };
    }),
);

/**
 * The lenient historical form: a failed read, an absent row, and an unusable
 * payload are all an absent cwd, never a failed turn — the contract
 * enrichment callers (turn context, wakes, activation) have always had.
 */
export const readThreadWorkspaceRoot = Effect.fn("TradingPlanDocument.readThreadWorkspaceRoot")(
  (sql: SqlClient.SqlClient, threadId: string): Effect.Effect<string | null> =>
    readThreadWorkspaceRootStrict(sql, threadId).pipe(
      Effect.map((resolution) => (resolution.status === "resolved" ? resolution.cwd : null)),
      Effect.orElseSucceed(() => null),
    ),
);

export const makeTradingPlanDocumentService = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const readActive = (workspaceRoot: string) =>
    Effect.gen(function* () {
      const keys = yield* Effect.sync(() => planRowKeys(workspaceRoot));
      // The real path while the directory exists; once it is gone, the
      // lexical cwd spellings are the only keys that can still reach the
      // pinned row — a miss here must mean no pin stands, never a pin made
      // invisible by the filesystem's absence.
      const statement =
        keys.real === null
          ? sql<{
              workspace_root: string;
              document_path: string;
              content_hash: string;
              activated_content: string;
              activated_at: string;
              activated_by_thread_id: string;
              activated_by_provider: string;
              mission_id: string | null;
              plan_reference_json: string | null;
            }>`
            SELECT workspace_root, document_path, content_hash, activated_content,
                   activated_at, activated_by_thread_id, activated_by_provider,
                   mission_id, plan_reference_json
            FROM trading_plan_documents
            WHERE workspace_root = ${keys.lexical}
               OR thread_cwd = ${keys.lexical}
               OR thread_cwd = ${workspaceRoot}
            ORDER BY activated_at DESC, rowid DESC
          `
          : sql<{
              workspace_root: string;
              document_path: string;
              content_hash: string;
              activated_content: string;
              activated_at: string;
              activated_by_thread_id: string;
              activated_by_provider: string;
              mission_id: string | null;
              plan_reference_json: string | null;
            }>`
            SELECT workspace_root, document_path, content_hash, activated_content,
                   activated_at, activated_by_thread_id, activated_by_provider,
                   mission_id, plan_reference_json
            FROM trading_plan_documents
            WHERE workspace_root = ${keys.real}
          `;
      const rows = yield* statement.pipe(Effect.mapError(asDocumentError));
      const row = rows[0];
      return row === undefined ? null : decodeActiveRow(row);
    });

  const readCurrent: TradingPlanDocumentService["Service"]["readCurrent"] = (workspaceRoot) =>
    Effect.gen(function* () {
      const document = yield* readTradeDocument(workspaceRoot);
      if (document.status === "missing") return document;
      const active = yield* readActive(workspaceRoot);
      return {
        status: "present" as const,
        path: document.path,
        contentHash: document.contentHash,
        content: document.content,
        activated: active,
        activation: classifyPlanDocument({
          filePresent: true,
          currentHash: document.contentHash,
          activatedHash: active === null ? null : active.contentHash,
        }),
      };
    });

  const activate: TradingPlanDocumentService["Service"]["activate"] = (input) =>
    Effect.gen(function* () {
      // Read the file the activation will pin, and refuse the stale writer
      // before anything is written — the active revision is untouched.
      const document = yield* readTradeDocument(input.workspaceRoot);
      if (document.status === "missing") {
        return yield* new TradingPlanDocumentError({
          reason: "not_found",
          detail: `no ${TRADE_MD_FILENAME} exists at the workspace root to activate`,
        });
      }
      if (document.contentHash !== input.expectedContentHash) {
        return yield* new TradingPlanDocumentError({
          reason: "stale_hash",
          detail: `${TRADE_MD_FILENAME} changed since it was read (expected ${input.expectedContentHash}, found ${document.contentHash}); read it again and activate the revision you meant`,
        });
      }
      const realRoot = yield* Effect.try({
        try: () => realRootOf(input.workspaceRoot),
        catch: asDocumentError,
      });
      const activatedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
      const planReferenceJson = planReferenceToJson(input.planReference);
      // The cwd spelling this activation was reached through: the row's
      // deleted-root fallback key (migration 091).
      const threadCwd = NodePath.resolve(input.workspaceRoot);
      // Exactly one revision per workspace: the upsert IS the activation
      // audit's latest entry, and the activated_content column is the exact
      // snapshot background execution reads. One transaction: an activation
      // whose audit append fails must leave the previous pin standing, not a
      // changed pin the log cannot explain.
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`
              INSERT INTO trading_plan_documents (
                workspace_root, document_path, content_hash, activated_content,
                activated_at, activated_by_thread_id, activated_by_provider,
                mission_id, plan_reference_json, thread_cwd
              ) VALUES (
                ${realRoot}, ${document.path}, ${document.contentHash}, ${document.content},
                ${activatedAt}, ${input.threadId}, ${input.provider},
                ${input.missionId ?? null}, ${planReferenceJson}, ${threadCwd}
              )
              ON CONFLICT (workspace_root)
              DO UPDATE SET
                document_path = excluded.document_path,
                content_hash = excluded.content_hash,
                activated_content = excluded.activated_content,
                activated_at = excluded.activated_at,
                activated_by_thread_id = excluded.activated_by_thread_id,
                activated_by_provider = excluded.activated_by_provider,
                mission_id = excluded.mission_id,
                plan_reference_json = excluded.plan_reference_json,
                thread_cwd = excluded.thread_cwd
            `;
            // The append-only half of the audit: every activation logs, so
            // the revision this replaces stays queryable after the upsert
            // overwrites it.
            yield* sql`
              INSERT INTO trading_plan_document_revisions (
                workspace_root, kind, content_hash, activated_content,
                activated_at, activated_by_thread_id, activated_by_provider,
                mission_id, change_note
              ) VALUES (
                ${realRoot}, 'activated', ${document.contentHash}, ${document.content},
                ${activatedAt}, ${input.threadId}, ${input.provider},
                ${input.missionId ?? null}, ${input.changeNote ?? null}
              )
            `;
          }),
        )
        .pipe(Effect.mapError(asDocumentError));
      const active = yield* readActive(realRoot);
      // The row was just written; a miss here is a defect, not a refusal.
      if (active === null) {
        return yield* new TradingPlanDocumentError({
          reason: "read_failed",
          detail: "the activation did not persist",
        });
      }
      return active;
    });

  const deactivate: TradingPlanDocumentService["Service"]["deactivate"] = (input) =>
    Effect.gen(function* () {
      // Discovered through the same fallback as every other read: pausing a
      // plan must not require the workspace directory to still exist.
      const standing = yield* readActive(input.workspaceRoot);
      if (standing === null) {
        return yield* new TradingPlanDocumentError({
          reason: "not_found",
          detail: `no activated ${TRADE_MD_FILENAME} revision exists for this workspace to deactivate`,
        });
      }
      const deactivatedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
      // Keyed by the row's own identity, not a re-derived root. One
      // transaction: a deactivation either fully happens (the audit row
      // appended and the pin removed) or fully does not — never an audit
      // entry for a deactivation that left the pin standing.
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`
              INSERT INTO trading_plan_document_revisions (
                workspace_root, kind, content_hash, activated_content,
                activated_at, activated_by_thread_id, activated_by_provider,
                mission_id, change_note
              ) VALUES (
                ${standing.workspaceRoot}, 'deactivated', ${standing.contentHash}, ${standing.activatedContent},
                ${deactivatedAt}, ${input.threadId}, ${input.provider},
                ${standing.missionId}, ${input.note ?? null}
              )
            `;
            yield* sql`
              DELETE FROM trading_plan_documents WHERE workspace_root = ${standing.workspaceRoot}
            `;
          }),
        )
        .pipe(Effect.mapError(asDocumentError));
    });

  const listRevisions: TradingPlanDocumentService["Service"]["listRevisions"] = (workspaceRoot) =>
    Effect.gen(function* () {
      const realRoot = yield* Effect.try({
        try: () => realRootOf(workspaceRoot),
        catch: asDocumentError,
      });
      const rows = yield* sql<{
        id: number;
        workspace_root: string;
        kind: string;
        content_hash: string | null;
        activated_content: string | null;
        activated_at: string;
        activated_by_thread_id: string;
        activated_by_provider: string;
        mission_id: string | null;
        change_note: string | null;
      }>`
        SELECT id, workspace_root, kind, content_hash, activated_content,
               activated_at, activated_by_thread_id, activated_by_provider,
               mission_id, change_note
        FROM trading_plan_document_revisions
        WHERE workspace_root = ${realRoot}
        ORDER BY id DESC
      `.pipe(Effect.mapError(asDocumentError));
      return rows.map((row): PlanDocumentRevision => ({
        id: row.id,
        workspaceRoot: row.workspace_root,
        kind: row.kind,
        contentHash: row.content_hash,
        activatedContent: row.activated_content,
        activatedAt: row.activated_at,
        activatedByThreadId: row.activated_by_thread_id,
        activatedByProvider: row.activated_by_provider,
        missionId: row.mission_id,
        changeNote: row.change_note,
      }));
    });

  const notePlanPublication: TradingPlanDocumentService["Service"]["notePlanPublication"] = (
    input,
  ) =>
    Effect.gen(function* () {
      const workspaceRoot = yield* readThreadWorkspaceRoot(sql, input.threadId);
      if (workspaceRoot === null) return;
      // Keyed by the real root, the same identity activation used. A root
      // that no longer resolves is a workspace that is gone: nothing to
      // attribute to, and not this call's problem.
      const realRoot = yield* Effect.try({
        try: () => realRootOf(workspaceRoot),
        catch: asDocumentError,
      });
      yield* sql`
        UPDATE trading_plan_documents
        SET mission_id = ${input.missionId},
            plan_reference_json = ${planReferenceToJson(input.planReference)}
        WHERE workspace_root = ${realRoot}
      `.pipe(Effect.mapError(asDocumentError));
    }).pipe(
      // Attribution linkage, never authority: a failed refresh costs a stale
      // reference on an audit row, not the publication it follows.
      Effect.catch(() => Effect.void),
      Effect.catchCause((cause) =>
        Effect.logWarning("trading plan document attribution could not be refreshed", {
          threadId: input.threadId,
          cause: String(cause),
        }),
      ),
    );

  return TradingPlanDocumentService.of({
    readCurrent,
    readActive,
    activate,
    deactivate,
    listRevisions,
    notePlanPublication,
  });
});

export const TradingPlanDocumentServiceLive = Layer.effect(
  TradingPlanDocumentService,
  makeTradingPlanDocumentService,
);

/** What the drift guard refuses with: one reason, one instruction. */
export interface PlanDocumentDriftRefusal {
  readonly reason: "plan_document_drifted";
  readonly detail: string;
}

/**
 * The fail-closed refusal: the fence could not READ the state it enforces,
 * so it cannot prove there is no standing activation. Absence is a verdict;
 * a failed read is not — new exposure refuses until the state is readable,
 * while every exposure-reducing and protective path stays open (those never
 * pass through the guard at all).
 */
const planStateUnreadableRefusal = (cause: string): PlanDocumentDriftRefusal => ({
  reason: "plan_document_drifted",
  detail:
    `the workspace's plan-document state could not be read (${cause}), so new exposure is refused ` +
    "until it can be read. Reducing, closing, protecting, pausing and revoking remain available.",
});

/**
 * The one explanation every drift-classified refusal and wake note uses.
 *
 * The enter guard refuses with this text, and the wake composer carries the
 * same words in `driftNote`, so a woken turn can tell the operator why new
 * exposure is being refused (and what still works) instead of discovering the
 * refusal by trying. Shared rather than reworded: two texts that disagree is
 * how an agent learns to distrust both.
 *
 * `diskHash` is null for the missing/unreadable shapes, where there is no
 * current hash to name.
 */
export const planDocumentDriftDetail = (input: {
  readonly status: "drifted" | "missing" | "unreadable";
  readonly activatedHash: string;
  readonly diskHash: string | null;
  readonly path: string;
}): string => {
  const where =
    input.status === "missing"
      ? `${TRADE_MD_FILENAME} is missing at its recorded path ${input.path}`
      : input.status === "unreadable"
        ? `${TRADE_MD_FILENAME} at ${input.path} could not be read`
        : `${TRADE_MD_FILENAME} changed after the revision this mission runs on`;
  return (
    `${where} (activated sha256 ${input.activatedHash}` +
    (input.diskHash === null ? "" : `, file sha256 ${input.diskHash}`) +
    "). The activated revision still governs, and any new exposure (`trading_enter`) is refused " +
    "with `plan_document_drifted` until the current document is read and re-activated. " +
    "Reducing, closing, protecting, pausing and revoking remain available."
  );
};

/**
 * The NEW-exposure drift guard, in the style of `TradingExecutionGuard`.
 *
 * Read-only: it reads the thread workspace's current document and classifies
 * it against the persisted activation, and mutates nothing — not the mission,
 * not the plan, not the document. An action that INCREASES exposure on a
 * drifted document refuses; every exposure-reducing or protective action type
 * passes (`isPermittedUnderPlanDrift`), and the paths that never carry an
 * action type here — pause, emergency close, revoke — do not pass through
 * this guard at all and are structurally outside it.
 *
 * No activation means no verdict: the guard is a fence around drifted plans,
 * not a requirement that a plan document exist. While an activation stands,
 * every way the current file can fail to be the readable, pinned bytes is
 * drift-classified and fences new exposure — MISSING at the recorded path
 * (a rename included; the guard never follows the new file) or UNREADABLE
 * (oversize, bad encoding, symlink escape, read failure). The activated
 * snapshot was a valid readable file when pinned, so a refusing read means
 * the file changed or became unreadable since — epistemically identical to
 * drift, and new exposure on a document nobody can read is exactly what the
 * fence exists for.
 */
export const guardPlanDocumentDrift = Effect.fn("TradingPlanDocument.guardPlanDocumentDrift")(
  (
    actionType: string,
    threadId: string,
  ): Effect.Effect<PlanDocumentDriftRefusal | null, never, SqlClient.SqlClient> =>
    Effect.gen(function* () {
      if (isPermittedUnderPlanDrift(actionType)) return null;
      const sql = yield* SqlClient.SqlClient;
      // Fail closed on unreadable state: a cwd or pin read that errors cannot
      // prove there is no standing activation, so it refuses new exposure
      // instead of passing as though the fence had no standing. Absence
      // (null) is a verdict; a failed read is not.
      type CwdRead =
        | { readonly ok: true; readonly resolution: ThreadWorkspaceRootResolution }
        | {
            readonly ok: false;
            readonly cause: string;
          };
      const workspaceRoot = yield* readThreadWorkspaceRootStrict(sql, threadId).pipe(
        Effect.map((resolution): CwdRead => ({ ok: true, resolution })),
        Effect.orElseSucceed((): CwdRead => ({
          ok: false,
          cause: "the thread workspace row could not be read",
        })),
        Effect.catchCause((): Effect.Effect<CwdRead> =>
          Effect.succeed({ ok: false, cause: "the thread workspace read died" }),
        ),
      );
      if (!workspaceRoot.ok) return planStateUnreadableRefusal(workspaceRoot.cause);
      if (workspaceRoot.resolution.status === "unusable") {
        return planStateUnreadableRefusal(workspaceRoot.resolution.cause);
      }
      if (workspaceRoot.resolution.status === "absent") return null;

      const documents = yield* makeTradingPlanDocumentService;
      // The pin decides whether the guard has standing at all: a workspace
      // with no activated revision has nothing to drift against. A root that
      // no longer resolves still finds its pin through the recorded cwd
      // spellings, so a deleted workspace fences below as unreadable rather
      // than vanishing the activation the mission runs on. A pin read that
      // errors fences the same way — fail closed.
      type PinRead =
        | { readonly ok: true; readonly pin: ActivePlanDocument | null }
        | {
            readonly ok: false;
            readonly cause: string;
          };
      const activated = yield* documents.readActive(workspaceRoot.resolution.cwd).pipe(
        Effect.map((pin): PinRead => ({ ok: true, pin })),
        Effect.catch((error): Effect.Effect<PinRead> =>
          Effect.succeed({ ok: false, cause: error.message }),
        ),
        Effect.catchCause((): Effect.Effect<PinRead> =>
          Effect.succeed({ ok: false, cause: "the plan-document read died" }),
        ),
      );
      if (!activated.ok) return planStateUnreadableRefusal(activated.cause);
      if (activated.pin === null) return null;
      const active = activated.pin;

      const current = yield* documents.readCurrent(workspaceRoot.resolution.cwd).pipe(
        // A typed refusal (oversize, bad encoding, escape) or a defect is
        // carried as null here and fenced below: while a pin stands, a read
        // that refuses means the file is no longer the readable bytes that
        // were pinned.
        Effect.orElseSucceed(() => null),
        Effect.catchCause(() => Effect.succeed(null)),
      );
      // A deleted (or renamed-away) TRADE.md while an activation stands is
      // drift-classified: the pinned snapshot still governs, and new exposure
      // on a document nobody can read is exactly what the fence exists for.
      // A rename is treated as missing at the recorded path — the guard never
      // follows the new file.
      if (current === null) {
        return {
          reason: "plan_document_drifted",
          detail: planDocumentDriftDetail({
            status: "unreadable",
            activatedHash: active.contentHash,
            diskHash: null,
            path: active.documentPath,
          }),
        } satisfies PlanDocumentDriftRefusal;
      }
      if (current.status === "missing") {
        return {
          reason: "plan_document_drifted",
          detail: planDocumentDriftDetail({
            status: "missing",
            activatedHash: active.contentHash,
            diskHash: null,
            path: active.documentPath,
          }),
        } satisfies PlanDocumentDriftRefusal;
      }
      if (current.activation !== "drifted") return null;

      return {
        reason: "plan_document_drifted",
        detail: planDocumentDriftDetail({
          status: "drifted",
          activatedHash: active.contentHash,
          diskHash: current.contentHash,
          path: current.path,
        }),
      } satisfies PlanDocumentDriftRefusal;
    }),
);
