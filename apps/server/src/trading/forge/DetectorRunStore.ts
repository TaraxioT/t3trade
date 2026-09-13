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

// ---------------------------------------------------------------------------
// Durable occurrences — the logical false→true transition store
// ---------------------------------------------------------------------------

/** The durable state of one logical occurrence, as its latest row reads it. */
export interface DetectorOccurrenceSnapshot {
  readonly occurrenceKey: string;
  readonly version: number;
  /** The program's reset discriminator recorded at detection ("null" when none). */
  readonly resetKey: string;
  /** `active` — detected, unreset, unconsumed; `consumed` — fired, never again; `reset` — closed by reset. */
  readonly status: "active" | "consumed" | "reset";
  readonly firstDetectedAtMs: number;
  readonly lastConfirmedAtMs: number;
  readonly validUntilMs: number;
  readonly evaluationId: string;
  readonly consumedAtMs: number | null;
  readonly resetAtMs: number | null;
}

/**
 * What `recordOccurrence` did with a detection:
 *
 * - `recorded` — this call IS the logical false→true transition: a first
 *   detection, the first after a reset, or the first after a consumed
 *   occurrence was reset. A new row exists; downstream may fire on it.
 * - `confirmed` — the active occurrence still holds (same reset
 *   discriminator); only `last_confirmed_at_ms` (and the validity horizon)
 *   advanced. A persistent condition emits ONCE; later windows confirm.
 * - `consumed` — this occurrence already fired and can never fire again.
 *   Nothing is written.
 * - refused `invalid-occurrence` — boundary validation failed.
 */
export type OccurrenceRecordOutcome =
  | { readonly status: "recorded" }
  | { readonly status: "confirmed" }
  | { readonly status: "consumed" }
  | { readonly status: "refused"; readonly reason: "invalid-occurrence"; readonly detail: string };

/** What `consumeOccurrence` did: the one-time, idempotent firing mark. */
export type OccurrenceConsumeOutcome =
  | { readonly status: "consumed" }
  | { readonly status: "already-consumed" }
  | { readonly status: "not-found" }
  | { readonly status: "reset" };

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

  /**
   * Record one detection of a logical occurrence (the `occurrenceKey` of a
   * committed `DetectionResult.matched`), durably, across windows and
   * restarts. The FIRST detection of an occurrence (its false→true
   * transition) is `recorded`; later windows while the condition still holds
   * only `confirm`; a consumed occurrence is never re-firable; a CHANGED
   * `resetKey` is the program's specified reset — the old row closes and the
   * detection opens a new occurrence.
   *
   * `version` keys the row to the program identity: a detector artifact
   * revision (a new version) is a new program with a fresh occurrence space;
   * the old version's rows are immutable history and its consumed state can
   * never be reset implicitly by upgrading.
   */
  readonly recordOccurrence: (input: {
    readonly environmentId: string;
    readonly capabilityId: string;
    readonly version: number;
    readonly occurrenceKey: string;
    /** The program's reset discriminator for this occurrence, or null when none. */
    readonly resetKey: string | null;
    readonly detectedAtMs: number;
    readonly validUntilMs: number;
    /** The committed evaluation whose result carried this occurrence. */
    readonly evaluationId: string;
  }) => Effect.Effect<OccurrenceRecordOutcome, PersistenceSqlError>;

  /**
   * The latest row for one occurrence, or null when never detected. Admission
   * re-checks (unexpired, unfired, current) read through this; the clock and
   * the policy judgment stay with the caller.
   */
  readonly readOccurrence: (
    environmentId: string,
    capabilityId: string,
    version: number,
    occurrenceKey: string,
  ) => Effect.Effect<DetectorOccurrenceSnapshot | null, PersistenceSqlError>;

  /**
   * Consume (fire) an occurrence — the one-time mark. Idempotent: consuming
   * an already-consumed occurrence is `already-consumed`, never a second
   * fire. A reset or unknown occurrence cannot be consumed.
   */
  readonly consumeOccurrence: (input: {
    readonly environmentId: string;
    readonly capabilityId: string;
    readonly version: number;
    readonly occurrenceKey: string;
    readonly consumedAtMs: number;
  }) => Effect.Effect<OccurrenceConsumeOutcome, PersistenceSqlError>;
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

interface OccurrenceRow {
  readonly occurrence_row_id: number;
  readonly version: number;
  readonly occurrence_key: string;
  readonly reset_key: string;
  readonly first_detected_at_ms: number;
  readonly last_confirmed_at_ms: number;
  readonly valid_until_ms: number;
  readonly evaluation_id: string;
  readonly consumed_at_ms: number | null;
  readonly reset_at_ms: number | null;
}

const toOccurrenceSnapshot = (row: OccurrenceRow): DetectorOccurrenceSnapshot => ({
  occurrenceKey: row.occurrence_key,
  version: row.version,
  resetKey: row.reset_key,
  status: row.reset_at_ms !== null ? "reset" : row.consumed_at_ms !== null ? "consumed" : "active",
  firstDetectedAtMs: row.first_detected_at_ms,
  lastConfirmedAtMs: row.last_confirmed_at_ms,
  validUntilMs: row.valid_until_ms,
  evaluationId: row.evaluation_id,
  consumedAtMs: row.consumed_at_ms,
  resetAtMs: row.reset_at_ms,
});

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

  // -- durable occurrences ---------------------------------------------------

  /** The latest occurrence row for one key, or null when never detected. */
  const readLatestOccurrenceRow = (
    environmentId: string,
    capabilityId: string,
    version: number,
    occurrenceKey: string,
  ) =>
    sql<OccurrenceRow>`
      SELECT occurrence_row_id, version, occurrence_key, reset_key,
             first_detected_at_ms, last_confirmed_at_ms, valid_until_ms,
             evaluation_id, consumed_at_ms, reset_at_ms
      FROM forge_detector_occurrences
      WHERE environment_id = ${environmentId} AND capability_id = ${capabilityId}
        AND version = ${version} AND occurrence_key = ${occurrenceKey}
      ORDER BY occurrence_row_id DESC
      LIMIT 1
    `.pipe(
      Effect.mapError(sqlFail("readOccurrence")),
      Effect.map((rows) => (rows[0] === undefined ? null : rows[0])),
    );

  const readOccurrence: DetectorRunStoreShape["readOccurrence"] = (
    environmentId,
    capabilityId,
    version,
    occurrenceKey,
  ) =>
    readLatestOccurrenceRow(environmentId, capabilityId, version, occurrenceKey).pipe(
      Effect.map((row) => (row === null ? null : toOccurrenceSnapshot(row))),
    );

  const recordOccurrence: DetectorRunStoreShape["recordOccurrence"] = (input) =>
    Effect.gen(function* () {
      const invalid =
        input.occurrenceKey.trim() === "" ||
        !Number.isSafeInteger(input.version) ||
        input.version < 1 ||
        !Number.isSafeInteger(input.detectedAtMs) ||
        input.detectedAtMs < 0 ||
        !Number.isSafeInteger(input.validUntilMs) ||
        input.validUntilMs < 0 ||
        input.evaluationId.trim() === ""
          ? "occurrenceKey and evaluationId must be non-empty, version ≥ 1, times non-negative integers"
          : null;
      if (invalid !== null) {
        return {
          status: "refused" as const,
          reason: "invalid-occurrence" as const,
          detail: invalid,
        };
      }
      // The stored reset discriminator: a literal "null" marker keeps the row
      // shape total (SQL null vs empty string would blur "no reset specified").
      const resetKey = input.resetKey ?? "null";

      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const latest = yield* readLatestOccurrenceRow(
            input.environmentId,
            input.capabilityId,
            input.version,
            input.occurrenceKey,
          );
          if (latest !== null && latest.reset_at_ms === null) {
            if (latest.consumed_at_ms !== null) {
              // A consumed occurrence never fires again. Only a CHANGED reset
              // discriminator (the program's specified reset) opens a new one,
              // and the consumed row itself stays untouched history.
              if (latest.reset_key === resetKey) {
                return { status: "consumed" as const };
              }
            } else if (latest.reset_key === resetKey) {
              // The condition still holds on the active occurrence: confirm,
              // never a second transition. The validity horizon may extend to
              // what this detection observed, never shorten.
              yield* sql`
                UPDATE forge_detector_occurrences
                SET last_confirmed_at_ms = ${input.detectedAtMs},
                    valid_until_ms = MAX(valid_until_ms, ${input.validUntilMs})
                WHERE occurrence_row_id = ${latest.occurrence_row_id}
                  AND consumed_at_ms IS NULL AND reset_at_ms IS NULL
              `;
              return { status: "confirmed" as const };
            } else {
              // Active row whose discriminator changed: the program's
              // specified reset. Close it — a reset occurrence can never fire
              // even though it never consumed.
              yield* sql`
                UPDATE forge_detector_occurrences
                SET reset_at_ms = ${input.detectedAtMs}
                WHERE occurrence_row_id = ${latest.occurrence_row_id}
                  AND consumed_at_ms IS NULL AND reset_at_ms IS NULL
              `;
            }
          }
          yield* sql`
            INSERT INTO forge_detector_occurrences (
              environment_id, capability_id, version, occurrence_key, reset_key,
              first_detected_at_ms, last_confirmed_at_ms, valid_until_ms,
              evaluation_id, consumed_at_ms, reset_at_ms
            ) VALUES (
              ${input.environmentId}, ${input.capabilityId}, ${input.version},
              ${input.occurrenceKey}, ${resetKey},
              ${input.detectedAtMs}, ${input.detectedAtMs}, ${input.validUntilMs},
              ${input.evaluationId}, NULL, NULL
            )
          `;
          return { status: "recorded" as const };
        }),
      );
    }).pipe(Effect.mapError(sqlFail("recordOccurrence")));

  const consumeOccurrence: DetectorRunStoreShape["consumeOccurrence"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const latest = yield* readLatestOccurrenceRow(
            input.environmentId,
            input.capabilityId,
            input.version,
            input.occurrenceKey,
          );
          if (latest === null) return { status: "not-found" as const };
          if (latest.reset_at_ms !== null) return { status: "reset" as const };
          if (latest.consumed_at_ms !== null) return { status: "already-consumed" as const };
          yield* sql`
            UPDATE forge_detector_occurrences
            SET consumed_at_ms = ${input.consumedAtMs}
            WHERE occurrence_row_id = ${latest.occurrence_row_id}
              AND consumed_at_ms IS NULL AND reset_at_ms IS NULL
          `;
          const verify = yield* readLatestOccurrenceRow(
            input.environmentId,
            input.capabilityId,
            input.version,
            input.occurrenceKey,
          );
          if (verify?.consumed_at_ms !== input.consumedAtMs) {
            return yield* new PersistenceSqlError({
              operation: "DetectorRunStore.consumeOccurrence",
              detail:
                "consume verification failed after update; the transaction rolled back and the occurrence is unfired",
            });
          }
          return { status: "consumed" as const };
        }),
      )
      .pipe(Effect.mapError(sqlFail("consumeOccurrence")));

  return {
    readState,
    commitRun,
    latestEvaluation,
    listEvaluations,
    recordOccurrence,
    readOccurrence,
    consumeOccurrence,
  } satisfies DetectorRunStoreShape;
});

export const DetectorRunStoreLive = Layer.effect(DetectorRunStore, makeDetectorRunStore);
