/**
 * ExternalSourceStore — the durable revision boundary for external
 * (non-chain) research evidence.
 *
 * One document revision is one row: provenance in columns, the retained
 * document bytes in `payload_json`. Revisions are immutable: a correction or
 * a retraction is a NEW row linked through `correctionOf`/`retracted`, never
 * an update, so no capture can rewrite what an earlier capture recorded.
 * Revision ids are content-derived by the CALLER (the connector); this store
 * refuses a different payload under an existing id instead of silently
 * changing what the id means.
 *
 * SQL only — no network, no signer, nothing that could reach an order. The
 * payload bytes stay inert for every write and every list read; `readDocument`
 * is the one deterministic extraction boundary that parses them, and only the
 * connector's own retained JSON ever crosses it.
 *
 * @module ExternalSourceStore
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { Schema } from "effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ExternalSourceManifest, type SourceTimePrecision } from "@t3tools/trading-contracts";
import { toPersistenceSqlError, PersistenceSqlError } from "../../persistence/Errors.ts";

/** The most documents one listing read will return. */
const MAX_LISTED_DOCUMENTS = 100;

/**
 * What the document's own time claim is shaped like — the event-set
 * vocabulary (`instant`, `window`, `date`), shared with occurrence rows so a
 * later event-set projection round-trips without re-derivation.
 */
export type ExternalSourceTimePrecision = "instant" | "window" | "date";

/** One immutable revision, decoded from its row. */
export interface ExternalSourceRevision {
  readonly revisionId: string;
  readonly environmentId: string;
  readonly sourceKind: string;
  readonly documentIdentity: string;
  readonly sourceUrl: string;
  readonly contentSha256: string;
  readonly publishedAtMs: number | null;
  readonly timePrecision: ExternalSourceTimePrecision;
  readonly firstObservedAtMs: number;
  readonly captureMs: number;
  readonly correctionOf: string | null;
  readonly retracted: boolean;
}

export interface ExternalSourceRevisionInsert {
  readonly revision: ExternalSourceRevision;
  /** The document's retained bytes, verbatim and inert. */
  readonly payloadJson: string;
}

export interface ExternalSourceStoreShape {
  /**
   * Persist one revision. Immutable: an id already present is never replaced.
   * Re-inserting identical payload bytes is an idempotent no-op; the same id
   * with different bytes fails with a revision-id collision, so a
   * content-derived id can never silently change meaning.
   */
  readonly insert: (
    input: ExternalSourceRevisionInsert,
  ) => Effect.Effect<void, PersistenceSqlError>;

  /**
   * The newest revision that is not itself a retraction, plus the newest
   * retraction row when the chain currently ends in one — that pair is the
   * document's current content and its retraction status. Null when the
   * document has no non-retracted revision at all.
   */
  readonly latestRevision: (input: {
    readonly environmentId: string;
    readonly sourceKind: string;
    readonly documentIdentity: string;
  }) => Effect.Effect<
    {
      readonly revision: ExternalSourceRevision;
      readonly retraction: ExternalSourceRevision | null;
    } | null,
    PersistenceSqlError
  >;

  /** The full chain oldest → newest, retraction rows included. */
  readonly history: (input: {
    readonly environmentId: string;
    readonly sourceKind: string;
    readonly documentIdentity: string;
  }) => Effect.Effect<ReadonlyArray<ExternalSourceRevision>, PersistenceSqlError>;

  /** Distinct document identities with their newest revision, newest first. */
  readonly listDocuments: (input: {
    readonly environmentId: string;
    readonly sourceKind: string;
    readonly limit?: number;
  }) => Effect.Effect<
    ReadonlyArray<{
      readonly documentIdentity: string;
      readonly revision: ExternalSourceRevision;
    }>,
    PersistenceSqlError
  >;

  /**
   * One revision with its retained payload parsed as JSON — the deterministic
   * extraction boundary. This is the ONLY read that interprets payload bytes;
   * every other surface keeps them inert. `document` is null when the payload
   * is not decodable JSON (or is the JSON null literal): the connector only
   * retains object payloads, so both cases mean "not decodable" and the caller
   * skips the document rather than guessing. Null overall when no row carries
   * that revision id.
   */
  readonly readDocument: (input: { readonly revisionId: string }) => Effect.Effect<
    {
      readonly revision: ExternalSourceRevision;
      readonly document: unknown;
    } | null,
    PersistenceSqlError
  >;
}

export class ExternalSourceStore extends Context.Service<
  ExternalSourceStore,
  ExternalSourceStoreShape
>()("t3/trading/research/ExternalSourceStore") {}

const sqlFail = (operation: string) => toPersistenceSqlError(`ExternalSourceStore.${operation}`);

interface RevisionRow {
  readonly revision_id: string;
  readonly environment_id: string;
  readonly source_kind: string;
  readonly document_identity: string;
  readonly source_url: string;
  readonly content_sha256: string;
  readonly published_at_ms: number | null;
  readonly time_precision: string;
  readonly first_observed_at_ms: number;
  readonly capture_ms: number;
  readonly correction_of: string | null;
  readonly retracted: number;
}

const toTimePrecision = (value: string): ExternalSourceTimePrecision => {
  if (value === "instant" || value === "window" || value === "date") return value;
  // Unreachable while the CHECK constraint holds; loud rather than guessed.
  throw new Error(`external_source_revisions row has a corrupt time_precision '${value}'`);
};

const toRevision = (row: RevisionRow): ExternalSourceRevision => ({
  revisionId: row.revision_id,
  environmentId: row.environment_id,
  sourceKind: row.source_kind,
  documentIdentity: row.document_identity,
  sourceUrl: row.source_url,
  contentSha256: row.content_sha256,
  publishedAtMs: row.published_at_ms,
  timePrecision: toTimePrecision(row.time_precision),
  firstObservedAtMs: row.first_observed_at_ms,
  captureMs: row.capture_ms,
  correctionOf: row.correction_of,
  retracted: row.retracted === 1,
});

/**
 * The manifest precision each document precision can honestly claim at the
 * contract boundary. `instant` and `window` boundaries are exact moments a
 * host family recorded (web APIs publish second-precision ISO timestamps);
 * `date` carries whole days and nothing finer.
 */
const MANIFEST_TIME_PRECISION: Record<ExternalSourceTimePrecision, SourceTimePrecision> = {
  instant: "second",
  window: "second",
  date: "day",
};

// decodeUnknownSync stays inside this module-level (non-generator) helper.
const decodeManifest = (value: unknown): ExternalSourceManifest => {
  try {
    return Schema.decodeUnknownSync(ExternalSourceManifest)(value);
  } catch (cause) {
    throw new Error(
      `external source revision does not project into ExternalSourceManifest: ${String(cause)}`,
    );
  }
};

/**
 * Parse one retained payload as JSON, or null when it is not decodable. Retained
 * bytes are only ever parsed at this boundary, and a corrupt payload surfaces as
 * `null` rather than a throw so one bad row cannot take a whole projection down.
 * (decodeSync stays outside Effect generators, per the repo rule.)
 */
const decodeRetainedPayload = (payloadJson: string): unknown => {
  try {
    return Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(payloadJson);
  } catch {
    return null;
  }
};

/**
 * Project a revision into the `ExternalSourceManifest` contract shape. Pure;
 * throws (a defect, surfaced loudly) only when a row is too corrupt to
 * project — which the insert boundary and the CHECK constraints prevent.
 */
export const toManifest = (revision: ExternalSourceRevision): ExternalSourceManifest =>
  decodeManifest({
    id: revision.revisionId,
    environmentId: revision.environmentId,
    providerKind: revision.sourceKind,
    documentIdentity: revision.documentIdentity,
    sourceUrl: revision.sourceUrl,
    contentSha256: revision.contentSha256,
    publishedAtMs: revision.publishedAtMs,
    timePrecision: MANIFEST_TIME_PRECISION[revision.timePrecision],
    firstObservedAtMs: revision.firstObservedAtMs,
    correctionOf: revision.correctionOf,
    retracted: revision.retracted,
  });

export const makeExternalSourceStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insert: ExternalSourceStoreShape["insert"] = ({ revision, payloadJson }) =>
    Effect.gen(function* () {
      // Immutability with idempotent retries: a conflict never writes, so
      // after the statement the row is either exactly this payload (no-op
      // success) or something else (a content-derived id changed meaning,
      // which must fail loudly rather than replace history).
      yield* sql`
        INSERT INTO external_source_revisions (
          revision_id, environment_id, source_kind, document_identity, source_url,
          content_sha256, published_at_ms, time_precision, first_observed_at_ms,
          capture_ms, correction_of, retracted, payload_json
        ) VALUES (
          ${revision.revisionId}, ${revision.environmentId}, ${revision.sourceKind},
          ${revision.documentIdentity}, ${revision.sourceUrl}, ${revision.contentSha256},
          ${revision.publishedAtMs}, ${revision.timePrecision}, ${revision.firstObservedAtMs},
          ${revision.captureMs}, ${revision.correctionOf}, ${revision.retracted ? 1 : 0},
          ${payloadJson}
        )
        ON CONFLICT (revision_id) DO NOTHING
      `.pipe(Effect.asVoid, Effect.mapError(sqlFail("insert")));
      const existing = yield* sql<{ readonly payload_json: string }>`
        SELECT payload_json FROM external_source_revisions
        WHERE revision_id = ${revision.revisionId}
      `.pipe(Effect.mapError(sqlFail("insert")));
      if (existing[0]?.payload_json !== payloadJson) {
        return yield* new PersistenceSqlError({
          operation: "ExternalSourceStore.insert",
          detail: `revision id collision: payload differs under an existing revision id (${revision.revisionId})`,
        });
      }
    });

  // The revision-chain read surfaces never select payload_json; readDocument
  // below is the single by-id read that does, so the bytes stay inert for
  // every listing and only an explicitly named revision is ever parsed.
  const latestRevision: ExternalSourceStoreShape["latestRevision"] = ({
    environmentId,
    sourceKind,
    documentIdentity,
  }) =>
    sql<RevisionRow>`
      SELECT revision_id, environment_id, source_kind, document_identity, source_url,
             content_sha256, published_at_ms, time_precision, first_observed_at_ms,
             capture_ms, correction_of, retracted
      FROM external_source_revisions
      WHERE environment_id = ${environmentId}
        AND source_kind = ${sourceKind}
        AND document_identity = ${documentIdentity}
      ORDER BY first_observed_at_ms DESC, rowid DESC
    `.pipe(
      Effect.mapError(sqlFail("latestRevision")),
      Effect.map((rows) => {
        const newest = rows[0];
        const revisionRow = rows.find((row) => row.retracted === 0);
        if (revisionRow === undefined) return null;
        return {
          revision: toRevision(revisionRow),
          retraction: newest !== undefined && newest.retracted === 1 ? toRevision(newest) : null,
        };
      }),
    );

  const history: ExternalSourceStoreShape["history"] = ({
    environmentId,
    sourceKind,
    documentIdentity,
  }) =>
    sql<RevisionRow>`
      SELECT revision_id, environment_id, source_kind, document_identity, source_url,
             content_sha256, published_at_ms, time_precision, first_observed_at_ms,
             capture_ms, correction_of, retracted
      FROM external_source_revisions
      WHERE environment_id = ${environmentId}
        AND source_kind = ${sourceKind}
        AND document_identity = ${documentIdentity}
      ORDER BY first_observed_at_ms ASC, rowid ASC
    `.pipe(
      Effect.mapError(sqlFail("history")),
      Effect.map((rows) => rows.map(toRevision)),
    );

  const listDocuments: ExternalSourceStoreShape["listDocuments"] = ({
    environmentId,
    sourceKind,
    limit,
  }) =>
    sql<RevisionRow>`
      SELECT revision_id, environment_id, source_kind, document_identity, source_url,
             content_sha256, published_at_ms, time_precision, first_observed_at_ms,
             capture_ms, correction_of, retracted
      FROM external_source_revisions
      WHERE environment_id = ${environmentId}
        AND source_kind = ${sourceKind}
      ORDER BY first_observed_at_ms DESC, rowid DESC
    `.pipe(
      Effect.mapError(sqlFail("listDocuments")),
      Effect.map((rows) => {
        // Grouped in TypeScript rather than SQL: "newest row per document"
        // with the rowid tie-break is clearer than a window-function
        // round-trip, and a scope's document count is bounded by the
        // connector's capture caps. Retraction rows count as the newest
        // revision — a retracted document's current state IS its retraction.
        const wanted = Math.min(limit ?? MAX_LISTED_DOCUMENTS, MAX_LISTED_DOCUMENTS);
        const latestByDocument = new Map<string, RevisionRow>();
        for (const row of rows) {
          if (latestByDocument.has(row.document_identity)) continue;
          if (latestByDocument.size >= wanted) break;
          latestByDocument.set(row.document_identity, row);
        }
        return [...latestByDocument.entries()].map(([documentIdentity, row]) => ({
          documentIdentity,
          revision: toRevision(row),
        }));
      }),
    );

  const readDocument: ExternalSourceStoreShape["readDocument"] = ({ revisionId }) =>
    sql<RevisionRow & { readonly payload_json: string }>`
      SELECT revision_id, environment_id, source_kind, document_identity, source_url,
             content_sha256, published_at_ms, time_precision, first_observed_at_ms,
             capture_ms, correction_of, retracted, payload_json
      FROM external_source_revisions
      WHERE revision_id = ${revisionId}
    `.pipe(
      Effect.mapError(sqlFail("readDocument")),
      Effect.map((rows) => {
        const row = rows[0];
        if (row === undefined) return null;
        return { revision: toRevision(row), document: decodeRetainedPayload(row.payload_json) };
      }),
    );

  return {
    insert,
    latestRevision,
    history,
    listDocuments,
    readDocument,
  } satisfies ExternalSourceStoreShape;
});

export const ExternalSourceStoreLive = Layer.effect(ExternalSourceStore, makeExternalSourceStore);
