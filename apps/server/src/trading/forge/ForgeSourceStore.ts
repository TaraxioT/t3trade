/**
 * ForgeSourceStore — the durable evidence boundary for Forge observation
 * fetches.
 *
 * One retained fetch is one row: provenance in columns, the normalized
 * observations in `payload_json`. Consumers reference evidence by id and read
 * the payload back through this store; raw observations are never inlined
 * into events, evaluations, or read models. SQL only — no Hyperliquid, no
 * signer, no network.
 *
 * @module ForgeSourceStore
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { Schema } from "effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  ForgeEvidenceRecord,
  ForgeQueryCapture,
  ForgeSwapObservation,
  type ForgeSwapObservation as ForgeSwapObservationType,
} from "@t3tools/trading-contracts";
import { toPersistenceSqlError, PersistenceSqlError } from "../../persistence/Errors.ts";

/** The most evidence rows one listing read will return. */
const MAX_LISTED_EVIDENCE = 100;

export interface ForgeEvidenceInsert {
  readonly record: ForgeEvidenceRecord;
  readonly queryCapture?: ForgeQueryCapture;
  readonly observations: ReadonlyArray<ForgeSwapObservationType>;
}

export interface ForgeSourceStoreShape {
  /**
   * Persist one retained fetch. Immutable: an id already present is never
   * replaced. Re-inserting identical content is an idempotent no-op; the
   * same id with different payload bytes fails with an evidence-id
   * collision, so a content-derived id can never silently change meaning.
   */
  readonly insert: (evidence: ForgeEvidenceInsert) => Effect.Effect<void, PersistenceSqlError>;

  /** The provenance row, without the payload. */
  readonly readRecord: (
    evidenceId: string,
  ) => Effect.Effect<ForgeEvidenceRecord | null, PersistenceSqlError>;

  /**
   * The full evidence: provenance plus the normalized observations.
   * `payloadIntact` compares the decoded observation count against the
   * row's claim only — digest verification belongs to the consumer that
   * knows the digest formula, since ids and digests are content-derived
   * by callers and insert refuses collisions.
   */
  readonly readObservations: (evidenceId: string) => Effect.Effect<
    {
      readonly record: ForgeEvidenceRecord;
      readonly observations: ReadonlyArray<ForgeSwapObservationType>;
      /** What the row claims; a shortfall against `observations` is visible. */
      readonly claimedCount: number;
      /** True when the payload decoded exactly as many rows as claimed. */
      readonly payloadIntact: boolean;
      readonly queryCapture?: ForgeQueryCapture;
    } | null,
    PersistenceSqlError
  >;

  /** Newest evidence rows for a scope, payloads excluded. */
  readonly listRecent: (input: {
    readonly environmentId: string;
    readonly poolId?: string;
    readonly limit?: number;
  }) => Effect.Effect<ReadonlyArray<ForgeEvidenceRecord>, PersistenceSqlError>;
}

export class ForgeSourceStore extends Context.Service<ForgeSourceStore, ForgeSourceStoreShape>()(
  "t3/trading/forge/ForgeSourceStore",
) {}

const sqlFail = (operation: string) => toPersistenceSqlError(`ForgeSourceStore.${operation}`);

interface EvidenceRow {
  readonly evidence_id: string;
  readonly environment_id: string;
  readonly pool_id: string;
  readonly historical: number;
  readonly endpoint: string;
  readonly deployment: string;
  readonly pinned_block: number;
  readonly pinned_block_hash: string | null;
  readonly window_start: number;
  readonly window_end: number;
  readonly fetched_at_ms: number;
  readonly digest: string;
  readonly observation_count: number;
}

const toRecord = (row: EvidenceRow): ForgeEvidenceRecord => ({
  evidenceId: row.evidence_id,
  environmentId: row.environment_id,
  poolId: row.pool_id,
  historical: row.historical === 1,
  endpoint: row.endpoint,
  deployment: row.deployment,
  pinnedBlock: row.pinned_block,
  ...(row.pinned_block_hash === null ? {} : { pinnedBlockHash: row.pinned_block_hash }),
  windowStart: row.window_start,
  windowEnd: row.window_end,
  fetchedAtMs: row.fetched_at_ms,
  digest: row.digest,
  observationCount: row.observation_count,
});

const decodeObservation = (value: unknown): ForgeSwapObservationType | null => {
  try {
    return Schema.decodeUnknownSync(ForgeSwapObservation)(value);
  } catch {
    return null;
  }
};

const decodeQueryCapture = (value: unknown): ForgeQueryCapture | null => {
  try {
    return Schema.decodeUnknownSync(ForgeQueryCapture)(value);
  } catch {
    return null;
  }
};

/** The observations payload as stored — one deterministic JSON string. */
const encodeEvidencePayload = (
  observations: ReadonlyArray<ForgeSwapObservationType>,
  queryCapture: ForgeQueryCapture | undefined,
): string => JSON.stringify({ observations, queryCapture });

/** Parsed payload, or null when the row is corrupt. */
const parseEvidencePayload = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

export const makeForgeSourceStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const collisionError = (evidenceId: string) =>
    new PersistenceSqlError({
      operation: "ForgeSourceStore.insert",
      detail: `evidence id collision: payload differs under an existing id (${evidenceId})`,
    });

  const insert: ForgeSourceStoreShape["insert"] = ({ record, observations, queryCapture }) =>
    Effect.gen(function* () {
      const payload = encodeEvidencePayload(observations, queryCapture);
      // Immutability with idempotent retries: a conflict never writes, so
      // after the statement the row is either exactly this payload (no-op
      // success) or something else (a content-derived id changed meaning,
      // which must fail loudly rather than replace history).
      yield* sql`
        INSERT INTO forge_source_evidence (
          evidence_id, environment_id, pool_id, historical, endpoint, deployment,
          pinned_block, pinned_block_hash, window_start, window_end, fetched_at_ms,
          digest, observation_count, payload_json
        ) VALUES (
          ${record.evidenceId}, ${record.environmentId}, ${record.poolId},
          ${record.historical ? 1 : 0}, ${record.endpoint}, ${record.deployment},
          ${record.pinnedBlock}, ${record.pinnedBlockHash ?? null}, ${record.windowStart},
          ${record.windowEnd}, ${record.fetchedAtMs}, ${record.digest},
          ${observations.length}, ${payload}
        )
        ON CONFLICT (evidence_id) DO NOTHING
      `.pipe(Effect.asVoid, Effect.mapError(sqlFail("insert")));
      const existing = yield* sql<{ readonly payload_json: string }>`
        SELECT payload_json FROM forge_source_evidence WHERE evidence_id = ${record.evidenceId}
      `.pipe(Effect.mapError(sqlFail("insert")));
      if (existing[0]?.payload_json !== payload) {
        return yield* collisionError(record.evidenceId);
      }
    });

  const readRecord: ForgeSourceStoreShape["readRecord"] = (evidenceId) =>
    sql<EvidenceRow>`
      SELECT evidence_id, environment_id, pool_id, historical, endpoint, deployment,
             pinned_block, pinned_block_hash, window_start, window_end, fetched_at_ms,
             digest, observation_count
      FROM forge_source_evidence
      WHERE evidence_id = ${evidenceId}
    `.pipe(
      Effect.mapError(sqlFail("readRecord")),
      Effect.map((rows) => (rows[0] === undefined ? null : toRecord(rows[0]))),
    );

  const readObservations: ForgeSourceStoreShape["readObservations"] = (evidenceId) =>
    Effect.gen(function* () {
      const rows = yield* sql<EvidenceRow & { readonly payload_json: string }>`
        SELECT evidence_id, environment_id, pool_id, historical, endpoint, deployment,
               pinned_block, pinned_block_hash, window_start, window_end, fetched_at_ms,
               digest, observation_count, payload_json
        FROM forge_source_evidence
        WHERE evidence_id = ${evidenceId}
      `.pipe(Effect.mapError(sqlFail("readObservations")));
      const row = rows[0];
      if (row === undefined) return null;
      const record = toRecord(row);
      const payload = parseEvidencePayload(row.payload_json);
      // An unparseable payload is served as empty with the claimed count
      // still visible, so the shortfall is a fact rather than a mystery.
      const raw = payload === null ? [] : (payload as { observations?: unknown }).observations;
      const observations: Array<ForgeSwapObservationType> = [];
      if (Array.isArray(raw)) {
        for (const entry of raw) {
          const decoded = decodeObservation(entry);
          if (decoded !== null) observations.push(decoded);
        }
      }
      const rawCapture =
        payload === null ? undefined : (payload as { queryCapture?: unknown }).queryCapture;
      // A capture that fails to decode makes provenance unavailable without
      // hiding intact observations.
      const decodedCapture = rawCapture === undefined ? null : decodeQueryCapture(rawCapture);
      return {
        record,
        observations,
        claimedCount: row.observation_count,
        payloadIntact: observations.length === row.observation_count,
        ...(decodedCapture === null ? {} : { queryCapture: decodedCapture }),
      };
    });

  const listRecent: ForgeSourceStoreShape["listRecent"] = ({ environmentId, poolId, limit }) =>
    sql<EvidenceRow>`
      SELECT evidence_id, environment_id, pool_id, historical, endpoint, deployment,
             pinned_block, pinned_block_hash, window_start, window_end, fetched_at_ms,
             digest, observation_count
      FROM forge_source_evidence
      WHERE environment_id = ${environmentId}
      ${poolId === undefined ? sql`` : sql`AND pool_id = ${poolId}`}
      ORDER BY fetched_at_ms DESC
      LIMIT ${Math.min(limit ?? 20, MAX_LISTED_EVIDENCE)}
    `.pipe(
      Effect.mapError(sqlFail("listRecent")),
      Effect.map((rows) => rows.map(toRecord)),
    );

  return { insert, readRecord, readObservations, listRecent } satisfies ForgeSourceStoreShape;
});

export const ForgeSourceStoreLive = Layer.effect(ForgeSourceStore, makeForgeSourceStore);
