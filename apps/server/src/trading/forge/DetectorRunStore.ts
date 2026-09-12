/**
 * DetectorRunStore — the durable boundary for committed v2 detector runs:
 * the append-only evaluation log and the versioned detector state it
 * advances, in SQL, with revision compare-and-set.
 *
 * One committed run writes exactly two rows in one transaction: its
 * immutable evaluation record, and the state row advanced to the revision the
 * record commits. The state row is the CAS point — a writer must hold the
 * revision it observed (or be first, at revision 0), so a stale writer can
 * never overwrite a newer detector state. Everything else is refusal-shaped:
 * an evaluation id is content-derived, so the same id arriving with different
 * record bytes is a collision that fails loudly (the ForgeSourceStore
 * discipline), and a replay of an already-committed run is a no-op success.
 *
 * v2 evaluation records never touch CapabilityStore's file history: its
 * readers drop what they cannot decode, so a separate collection is the only
 * honest home. SQL only — no network, no signer, no exchange.
 *
 * @module DetectorRunStore
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { Schema } from "effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  decodeDetectorState,
  DetectorEvaluationRecordV2,
  detectorEvaluationId,
} from "@t3tools/trading-contracts";
import { toPersistenceSqlError, PersistenceSqlError } from "../../persistence/Errors.ts";
import { forgeJsonEncode } from "./ForgeJsonEncode.ts";

/** The most evaluation rows one listing read will return. */
const MAX_LISTED_EVALUATIONS = 100;

/** The committed detector state, as the next run's prior state. */
export interface DetectorStateSnapshot {
  readonly version: number;
  readonly stateRevision: number;
  /** Canonical envelope bytes from `encodeDetectorState`, stored verbatim. */
  readonly stateBytes: string;
  readonly lastEvaluationId: string;
  readonly committedAtMs: number;
}

export type DetectorCommitRefusal =
  | {
      readonly status: "refused";
      /** A content-derived evaluation id arrived with different record bytes. */
      readonly reason: "evaluation-id-collision";
      readonly detail: string;
    }
  | {
      readonly status: "refused";
      /** The state row is not at the revision this commit expects to advance. */
      readonly reason: "state-revision-conflict";
      readonly detail: string;
    }
  | {
      readonly status: "refused";
      /** The record's evaluationId does not match its own identity fields. */
      readonly reason: "invalid-record";
      readonly detail: string;
    }
  | {
      readonly status: "refused";
      /** The state bytes do not decode through the envelope contract. */
      readonly reason: "invalid-state";
      readonly detail: string;
    };

export type DetectorCommitOutcome =
  | { readonly status: "committed" }
  | { readonly status: "replayed" }
  | DetectorCommitRefusal;

export interface DetectorRunStoreShape {
  /** The current state row, or null when the capability has never committed. */
  readonly readState: (
    environmentId: string,
    capabilityId: string,
  ) => Effect.Effect<DetectorStateSnapshot | null, PersistenceSqlError>;

  /**
   * Commit one validated run — evaluation row plus state advance, one
   * transaction, all-or-nothing. Outcomes, exactly:
   *
   * - `committed` — both rows written atomically at the record's revision.
   * - `replayed` — this exact evaluation (identical record bytes) is already
   *   committed and the state row still sits at its revision with its bytes;
   *   a no-op, nothing changes.
   * - refused `evaluation-id-collision` — the id exists with DIFFERENT record
   *   bytes; a content-derived id can never change meaning.
   * - refused `state-revision-conflict` — the state row is absent when the
   *   record advances it (revision > 0), or present at a revision other than
   *   `record.stateRevision - 1` (including a first commit racing an existing
   *   row). Nothing is written.
   * - refused `invalid-record` / `invalid-state` — boundary validation
   *   failed before any write was attempted.
   */
  readonly commitRun: (input: {
    readonly record: DetectorEvaluationRecordV2;
    readonly stateBytes: string;
  }) => Effect.Effect<DetectorCommitOutcome, PersistenceSqlError>;

  /** The newest committed record for the scope, or null. */
  readonly latestEvaluation: (
    environmentId: string,
    capabilityId: string,
  ) => Effect.Effect<DetectorEvaluationRecordV2 | null, PersistenceSqlError>;

  /** Committed records for the scope, newest first, at most `limit` (≤100). */
  readonly listEvaluations: (
    environmentId: string,
    capabilityId: string,
    limit?: number | undefined,
  ) => Effect.Effect<ReadonlyArray<DetectorEvaluationRecordV2>, PersistenceSqlError>;
}

export class DetectorRunStore extends Context.Service<DetectorRunStore, DetectorRunStoreShape>()(
  "t3/trading/forge/DetectorRunStore",
) {}

const sqlFail = (operation: string) => toPersistenceSqlError(`DetectorRunStore.${operation}`);

interface StateRow {
  readonly version: number;
  readonly state_revision: number;
  readonly state_json: string;
  readonly last_evaluation_id: string;
  readonly committed_at_ms: number;
}

interface EvaluationListRow {
  readonly record_json: string;
}

const toSnapshot = (row: StateRow): DetectorStateSnapshot => ({
  version: row.version,
  stateRevision: row.state_revision,
  stateBytes: row.state_json,
  lastEvaluationId: row.last_evaluation_id,
  committedAtMs: row.committed_at_ms,
});

/**
 * Decode a stored record row. Corrupt rows decode to null — a boundary that
 * surfaces absence rather than throwing (the row is still in SQL; repairing
 * it is an operational act, never a runtime guess).
 */
const decodeEvaluationRecord = (raw: string): DetectorEvaluationRecordV2 | null => {
  try {
    return Schema.decodeUnknownSync(DetectorEvaluationRecordV2)(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
};

export const makeDetectorRunStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const readState: DetectorRunStoreShape["readState"] = (environmentId, capabilityId) =>
    sql<StateRow>`
      SELECT version, state_revision, state_json, last_evaluation_id, committed_at_ms
      FROM forge_detector_state
      WHERE environment_id = ${environmentId} AND capability_id = ${capabilityId}
    `.pipe(
      Effect.mapError(sqlFail("readState")),
      Effect.map((rows) => (rows[0] === undefined ? null : toSnapshot(rows[0]))),
    );

  const commitRun: DetectorRunStoreShape["commitRun"] = ({ record, stateBytes }) =>
    Effect.gen(function* () {
      // Boundary validation, before any write: the id must state what was
      // evaluated (the schema pins this too; the store enforces it for every
      // caller), and the state bytes must decode under the envelope contract
      // so a committed state row is always readable back.
      const expectedId = detectorEvaluationId({
        environmentId: record.environmentId,
        capabilityId: record.capabilityId,
        version: record.version,
        stateRevision: record.stateRevision,
        inputDigest: record.inputDigest,
      });
      if (expectedId !== record.evaluationId) {
        return {
          status: "refused" as const,
          reason: "invalid-record" as const,
          detail:
            "evaluationId does not match the content identity over environmentId, capabilityId, version, stateRevision, and inputDigest",
        };
      }
      const decodedState = decodeDetectorState(stateBytes);
      if (!decodedState.ok) {
        return {
          status: "refused" as const,
          reason: "invalid-state" as const,
          detail: `stateBytes do not decode: ${decodedState.failure}`,
        };
      }
      // Persisted verbatim: record identity and replay comparison are both
      // byte-exact against these strings.
      const recordJson = forgeJsonEncode(record);
      const resultJson = forgeJsonEncode(record.result);

      return yield* sql.withTransaction(
        Effect.gen(function* () {
          // An existing evaluation row with this id decides replay vs
          // collision before anything is written.
          const existing = yield* sql<{ readonly record_json: string }>`
            SELECT record_json FROM forge_detector_evaluations
            WHERE evaluation_id = ${record.evaluationId}
          `;
          if (existing[0] !== undefined) {
            if (existing[0].record_json !== recordJson) {
              return {
                status: "refused" as const,
                reason: "evaluation-id-collision" as const,
                detail: "evaluation id collision: record differs",
              };
            }
            const replayState = yield* sql<StateRow>`
              SELECT version, state_revision, state_json, last_evaluation_id, committed_at_ms
              FROM forge_detector_state
              WHERE environment_id = ${record.environmentId} AND capability_id = ${record.capabilityId}
            `;
            const row = replayState[0];
            if (
              row !== undefined &&
              row.state_revision === record.stateRevision &&
              row.state_json === stateBytes
            ) {
              return { status: "replayed" as const };
            }
            // Identical record but the state row has moved on (a later
            // revision committed): fall through to the CAS, which refuses —
            // history is immutable, the state row only advances.
          }

          // Revision CAS: revision 0 inserts the first state row; any higher
          // revision must observe the row exactly one revision behind.
          const current = yield* sql<{ readonly state_revision: number }>`
            SELECT state_revision FROM forge_detector_state
            WHERE environment_id = ${record.environmentId} AND capability_id = ${record.capabilityId}
          `;
          const currentRow = current[0];
          if (record.stateRevision === 0) {
            if (currentRow !== undefined) {
              return {
                status: "refused" as const,
                reason: "state-revision-conflict" as const,
                detail: `expected no prior state for a first commit but found revision ${currentRow.state_revision}`,
              };
            }
          } else if (
            currentRow === undefined ||
            currentRow.state_revision !== record.stateRevision - 1
          ) {
            return {
              status: "refused" as const,
              reason: "state-revision-conflict" as const,
              detail: `expected state revision ${record.stateRevision - 1} but found ${currentRow === undefined ? "none" : currentRow.state_revision}`,
            };
          }

          // Win: both rows, atomically. The UPDATE stays conditioned on the
          // observed revision (defense in depth for the CAS), and the
          // read-back verifies the advance — a failed verification fails the
          // effect so the whole transaction rolls back rather than committing
          // an evaluation whose state did not advance.
          yield* sql`
            INSERT INTO forge_detector_evaluations (
              evaluation_id, environment_id, capability_id, version, state_revision,
              input_digest, result_json, record_json, committed_at_ms
            ) VALUES (
              ${record.evaluationId}, ${record.environmentId}, ${record.capabilityId},
              ${record.version}, ${record.stateRevision}, ${record.inputDigest},
              ${resultJson}, ${recordJson}, ${record.committedAtMs}
            )
          `;
          if (record.stateRevision === 0) {
            yield* sql`
              INSERT INTO forge_detector_state (
                environment_id, capability_id, version, state_revision,
                state_json, last_evaluation_id, committed_at_ms
              ) VALUES (
                ${record.environmentId}, ${record.capabilityId}, ${record.version},
                ${record.stateRevision}, ${stateBytes},
                ${record.evaluationId}, ${record.committedAtMs}
              )
            `;
          } else {
            yield* sql`
              UPDATE forge_detector_state SET
                version = ${record.version},
                state_revision = ${record.stateRevision},
                state_json = ${stateBytes},
                last_evaluation_id = ${record.evaluationId},
                committed_at_ms = ${record.committedAtMs}
              WHERE environment_id = ${record.environmentId}
                AND capability_id = ${record.capabilityId}
                AND state_revision = ${record.stateRevision - 1}
            `;
          }
          const verify = yield* sql<
            Pick<StateRow, "state_revision" | "state_json" | "last_evaluation_id">
          >`
            SELECT state_revision, state_json, last_evaluation_id FROM forge_detector_state
            WHERE environment_id = ${record.environmentId} AND capability_id = ${record.capabilityId}
          `;
          if (
            verify[0]?.state_revision !== record.stateRevision ||
            verify[0]?.state_json !== stateBytes ||
            verify[0]?.last_evaluation_id !== record.evaluationId
          ) {
            return yield* new PersistenceSqlError({
              operation: "DetectorRunStore.commitRun",
              detail:
                "state advance verification failed after upsert; the transaction rolled back and nothing was committed",
            });
          }
          return { status: "committed" as const };
        }),
      );
    }).pipe(Effect.mapError(sqlFail("commitRun")));

  const latestEvaluation: DetectorRunStoreShape["latestEvaluation"] = (
    environmentId,
    capabilityId,
  ) =>
    sql<EvaluationListRow>`
      SELECT record_json FROM forge_detector_evaluations
      WHERE environment_id = ${environmentId} AND capability_id = ${capabilityId}
      ORDER BY committed_at_ms DESC, rowid DESC
      LIMIT 1
    `.pipe(
      Effect.mapError(sqlFail("latestEvaluation")),
      // A corrupt newest row decodes to null; absence is the honest boundary.
      Effect.map((rows) =>
        rows[0] === undefined ? null : decodeEvaluationRecord(rows[0].record_json),
      ),
    );

  const listEvaluations: DetectorRunStoreShape["listEvaluations"] = (
    environmentId,
    capabilityId,
    limit,
  ) =>
    sql<EvaluationListRow>`
      SELECT record_json FROM forge_detector_evaluations
      WHERE environment_id = ${environmentId} AND capability_id = ${capabilityId}
      ORDER BY committed_at_ms DESC, rowid DESC
      LIMIT ${Math.min(Math.max(limit ?? 50, 1), MAX_LISTED_EVALUATIONS)}
    `.pipe(
      Effect.mapError(sqlFail("listEvaluations")),
      // Undecodable rows are skipped, never thrown: a listing stays usable
      // when one stored row is corrupt.
      Effect.map((rows) =>
        rows.flatMap((row) => {
          const decoded = decodeEvaluationRecord(row.record_json);
          return decoded === null ? [] : [decoded];
        }),
      ),
    );

  return {
    readState,
    commitRun,
    latestEvaluation,
    listEvaluations,
  } satisfies DetectorRunStoreShape;
});

export const DetectorRunStoreLive = Layer.effect(DetectorRunStore, makeDetectorRunStore);
