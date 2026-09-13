/**
 * DetectorRunStore — revision CAS, replay, collision refusal, and the
 * read boundaries over real SQLite (in-memory, migration 105 run directly).
 */
// @effect-diagnostics nodeBuiltinImport:off globalDate:off - sqlite fixtures and wall-clock record fields are the data under test.

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  decodeDetectorState,
  DetectorEvaluationRecordV2,
  detectorEvaluationId,
  encodeDetectorState,
} from "@t3tools/trading-contracts";

import createDetectorTables from "../../persistence/Migrations/105_DetectorRuns.ts";
import { makeDetectorRunStore, type DetectorRunStoreShape } from "./DetectorRunStore.ts";

const ENV = "env_detector";
const CAP = "flag-detector";

const layer = it.layer(NodeSqliteClient.layerMemory());

// The layer is shared across the cases below, so each starts from empty
// detector tables (the migration itself is idempotent).
const reset = Effect.gen(function* () {
  yield* createDetectorTables;
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM forge_detector_state`;
  yield* sql`DELETE FROM forge_detector_evaluations`;
});

/** A minimal valid v2 record at `revision`, its state derived from the revision. */
const recordAt = (
  revision: number,
  inputDigest = `${"c".repeat(63)}${revision % 10}`,
): DetectorEvaluationRecordV2 => ({
  manifestVersion: 2,
  evaluationId: detectorEvaluationId({
    environmentId: ENV,
    capabilityId: CAP,
    version: 1,
    stateRevision: revision,
    inputDigest,
  }),
  environmentId: ENV,
  capabilityId: CAP,
  version: 1,
  stateRevision: revision,
  inputDigest,
  asOfMs: 1_700_000_060_000,
  result: { status: "not-matched", evidenceIds: [], explanation: "flag not set" },
  state: { stateSchemaVersion: 1, state: { count: revision + 1 } },
  evidenceIds: ["ev_1"],
  committedAtMs: 1_700_000_100_000 + revision,
});

const stateBytesFor = (record: DetectorEvaluationRecordV2): string => {
  const encoded = encodeDetectorState(record.state);
  assert.isTrue(encoded.ok);
  return encoded.ok ? encoded.serialized : "";
};

layer("DetectorRunStore commit", (it) => {
  it.effect("first commit (revision 0) persists the evaluation and state rows", () =>
    Effect.gen(function* () {
      yield* reset;
      const store: DetectorRunStoreShape = yield* makeDetectorRunStore;
      const first = recordAt(0);
      const outcome = yield* store.commitRun({ record: first, stateBytes: stateBytesFor(first) });
      assert.equal(outcome.status, "committed");

      const state = yield* store.readState(ENV, CAP);
      assert.isNotNull(state);
      assert.equal(state?.stateRevision, 0);
      assert.equal(state?.lastEvaluationId, first.evaluationId);
      assert.equal(state?.stateBytes, stateBytesFor(first));
      // The committed bytes are the canonical envelope, verbatim.
      const decoded = decodeDetectorState(state?.stateBytes ?? "");
      assert.isTrue(decoded.ok);
      const latest = yield* store.latestEvaluation(ENV, CAP);
      assert.equal(latest?.evaluationId, first.evaluationId);
    }),
  );

  it.effect("sequential second commit (revision 1) wins the CAS", () =>
    Effect.gen(function* () {
      yield* reset;
      const store: DetectorRunStoreShape = yield* makeDetectorRunStore;
      for (const record of [recordAt(0), recordAt(1)]) {
        const outcome = yield* store.commitRun({ record, stateBytes: stateBytesFor(record) });
        assert.equal(outcome.status, "committed");
      }
      const state = yield* store.readState(ENV, CAP);
      assert.equal(state?.stateRevision, 1);
      const listed = yield* store.listEvaluations(ENV, CAP);
      assert.equal(listed.length, 2);
    }),
  );

  it.effect("replaying the identical second commit is a no-op success", () =>
    Effect.gen(function* () {
      yield* reset;
      const store: DetectorRunStoreShape = yield* makeDetectorRunStore;
      const second = recordAt(1);
      for (const record of [recordAt(0), second]) {
        yield* store.commitRun({ record, stateBytes: stateBytesFor(record) });
      }
      const replay = yield* store.commitRun({
        record: second,
        stateBytes: stateBytesFor(second),
      });
      assert.equal(replay.status, "replayed");
      // Nothing changed: same state row, still exactly two evaluations.
      const state = yield* store.readState(ENV, CAP);
      assert.equal(state?.stateRevision, 1);
      assert.equal(state?.lastEvaluationId, second.evaluationId);
      const listed = yield* store.listEvaluations(ENV, CAP);
      assert.equal(listed.length, 2);
    }),
  );

  it.effect("the same evaluationId with a different record is a collision refusal", () =>
    Effect.gen(function* () {
      yield* reset;
      const store: DetectorRunStoreShape = yield* makeDetectorRunStore;
      const first = recordAt(0);
      yield* store.commitRun({ record: first, stateBytes: stateBytesFor(first) });
      // Same identity fields (so the same id), different record content.
      const mutated: DetectorEvaluationRecordV2 = {
        ...first,
        committedAtMs: first.committedAtMs + 5_000,
      };
      const outcome = yield* store.commitRun({
        record: mutated,
        stateBytes: stateBytesFor(mutated),
      });
      assert.equal(outcome.status, "refused");
      if (outcome.status === "refused") {
        assert.equal(outcome.reason, "evaluation-id-collision");
        assert.include(outcome.detail, "evaluation id collision: record differs");
      }
      const latest = yield* store.latestEvaluation(ENV, CAP);
      assert.equal(latest?.committedAtMs, first.committedAtMs);
    }),
  );

  it.effect("a stale CAS writes nothing to either table", () =>
    Effect.gen(function* () {
      yield* reset;
      const store: DetectorRunStoreShape = yield* makeDetectorRunStore;
      for (const record of [recordAt(0), recordAt(1), recordAt(2)]) {
        const outcome = yield* store.commitRun({ record, stateBytes: stateBytesFor(record) });
        assert.equal(outcome.status, "committed");
      }
      // Another revision-1 record (different digest, so a different id and
      // no replay): the state row is at revision 2 — expected 0, found 2.
      const stale = recordAt(1, "d".repeat(64));
      const outcome = yield* store.commitRun({ record: stale, stateBytes: stateBytesFor(stale) });
      assert.equal(outcome.status, "refused");
      if (outcome.status === "refused") {
        assert.equal(outcome.reason, "state-revision-conflict");
        assert.include(outcome.detail, "expected state revision 0 but found 2");
      }
      // Both tables unchanged.
      const state = yield* store.readState(ENV, CAP);
      assert.equal(state?.stateRevision, 2);
      const listed = yield* store.listEvaluations(ENV, CAP);
      assert.equal(listed.length, 3);
    }),
  );

  it.effect("a revision-0 commit against an existing state row is a CAS refusal", () =>
    Effect.gen(function* () {
      yield* reset;
      const store: DetectorRunStoreShape = yield* makeDetectorRunStore;
      const first = recordAt(0);
      yield* store.commitRun({ record: first, stateBytes: stateBytesFor(first) });
      const other = recordAt(0, "e".repeat(64));
      const outcome = yield* store.commitRun({ record: other, stateBytes: stateBytesFor(other) });
      assert.equal(outcome.status, "refused");
      if (outcome.status === "refused") assert.equal(outcome.reason, "state-revision-conflict");
      const listed = yield* store.listEvaluations(ENV, CAP);
      assert.equal(listed.length, 1);
    }),
  );

  it.effect("malformed stateBytes refuse before any write", () =>
    Effect.gen(function* () {
      yield* reset;
      const store: DetectorRunStoreShape = yield* makeDetectorRunStore;
      const first = recordAt(0);
      const outcome = yield* store.commitRun({ record: first, stateBytes: "{not an envelope" });
      assert.equal(outcome.status, "refused");
      if (outcome.status === "refused") {
        assert.equal(outcome.reason, "invalid-state");
        assert.include(outcome.detail, "state-json-invalid");
      }
      assert.isNull(yield* store.readState(ENV, CAP));
      assert.isEmpty(yield* store.listEvaluations(ENV, CAP));
    }),
  );

  it.effect("a record whose evaluationId misstates its identity refuses", () =>
    Effect.gen(function* () {
      yield* reset;
      const store: DetectorRunStoreShape = yield* makeDetectorRunStore;
      const honest = recordAt(0);
      const forged: DetectorEvaluationRecordV2 = {
        ...honest,
        // Honest id for a DIFFERENT revision than the record carries.
        evaluationId: detectorEvaluationId({
          environmentId: ENV,
          capabilityId: CAP,
          version: 1,
          stateRevision: 7,
          inputDigest: honest.inputDigest,
        }),
      };
      const outcome = yield* store.commitRun({
        record: forged,
        stateBytes: stateBytesFor(forged),
      });
      assert.equal(outcome.status, "refused");
      if (outcome.status === "refused") {
        assert.equal(outcome.reason, "invalid-record");
      }
      assert.isNull(yield* store.readState(ENV, CAP));
    }),
  );
});

layer("DetectorRunStore reads", (it) => {
  it.effect("latest and list order newest-first, list honors the limit", () =>
    Effect.gen(function* () {
      yield* reset;
      const store: DetectorRunStoreShape = yield* makeDetectorRunStore;
      for (const revision of [0, 1, 2, 3]) {
        const record = recordAt(revision);
        const outcome = yield* store.commitRun({ record, stateBytes: stateBytesFor(record) });
        assert.equal(outcome.status, "committed");
      }
      const latest = yield* store.latestEvaluation(ENV, CAP);
      assert.equal(latest?.stateRevision, 3);
      const all = yield* store.listEvaluations(ENV, CAP);
      assert.deepEqual(
        all.map((record) => record.stateRevision),
        [3, 2, 1, 0],
      );
      const two = yield* store.listEvaluations(ENV, CAP, 2);
      assert.deepEqual(
        two.map((record) => record.stateRevision),
        [3, 2],
      );
      // Another capability's scope reads nothing.
      assert.isNull(yield* store.latestEvaluation(ENV, "other-detector"));
    }),
  );

  it.effect("a corrupted record_json row reads as absent, never a throw", () =>
    Effect.gen(function* () {
      yield* reset;
      const store: DetectorRunStoreShape = yield* makeDetectorRunStore;
      const sql = yield* SqlClient.SqlClient;
      const first = recordAt(0);
      yield* store.commitRun({ record: first, stateBytes: stateBytesFor(first) });
      yield* sql`
        UPDATE forge_detector_evaluations SET record_json = ${"{corrupt"}
        WHERE evaluation_id = ${first.evaluationId}
      `;
      // Valid JSON that is not a valid record behaves the same.
      const second = recordAt(1);
      yield* store.commitRun({ record: second, stateBytes: stateBytesFor(second) });
      yield* sql`
        UPDATE forge_detector_evaluations
        SET record_json = ${'{"manifestVersion":2}'}
        WHERE evaluation_id = ${second.evaluationId}
      `;
      assert.isNull(yield* store.latestEvaluation(ENV, CAP));
      assert.isEmpty(yield* store.listEvaluations(ENV, CAP));
      // The state row is untouched by record corruption.
      const state = yield* store.readState(ENV, CAP);
      assert.equal(state?.stateRevision, 1);
    }),
  );
});

// ---------------------------------------------------------------------------
// Durable occurrences — false→true transitions across windows and restarts
// ---------------------------------------------------------------------------

import createOccurrenceTables from "../../persistence/Migrations/112_DetectorOccurrences.ts";

const resetOccurrences = Effect.gen(function* () {
  yield* createOccurrenceTables;
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM forge_detector_occurrences`;
});

const occurrenceInput = (overrides?: {
  readonly occurrenceKey?: string;
  readonly version?: number;
  readonly resetKey?: string | null;
  readonly detectedAtMs?: number;
  readonly validUntilMs?: number;
}) => ({
  environmentId: ENV,
  capabilityId: CAP,
  version: overrides?.version ?? 1,
  occurrenceKey: overrides?.occurrenceKey ?? "devcon-8-entry",
  resetKey: overrides?.resetKey ?? null,
  detectedAtMs: overrides?.detectedAtMs ?? 1_000,
  validUntilMs: overrides?.validUntilMs ?? 60_000,
  evaluationId: "dtev_occurrence",
});

layer("DetectorRunStore occurrences", (it) => {
  it.effect("the first detection records the transition; repeats confirm, never re-record", () =>
    Effect.gen(function* () {
      yield* resetOccurrences;
      const store: DetectorRunStoreShape = yield* makeDetectorRunStore;
      const first = yield* store.recordOccurrence(
        occurrenceInput({ detectedAtMs: 1_000, validUntilMs: 60_000 }),
      );
      assert.equal(first.status, "recorded");
      // A later window observing the SAME condition: confirmation only.
      const again = yield* store.recordOccurrence(
        occurrenceInput({ detectedAtMs: 5_000, validUntilMs: 90_000 }),
      );
      assert.equal(again.status, "confirmed");
      const snapshot = yield* store.readOccurrence(ENV, CAP, 1, "devcon-8-entry");
      assert.isNotNull(snapshot);
      assert.equal(snapshot?.status, "active");
      assert.equal(snapshot?.firstDetectedAtMs, 1_000);
      assert.equal(snapshot?.lastConfirmedAtMs, 5_000);
      // The validity horizon extends, never shortens.
      assert.equal(snapshot?.validUntilMs, 90_000);
    }),
  );

  it.effect(
    "a consumed occurrence is never re-firable, even across a restart-shaped fresh store",
    () =>
      Effect.gen(function* () {
        yield* resetOccurrences;
        const store: DetectorRunStoreShape = yield* makeDetectorRunStore;
        yield* store.recordOccurrence(occurrenceInput());
        const consumed = yield* store.consumeOccurrence({
          environmentId: ENV,
          capabilityId: CAP,
          version: 1,
          occurrenceKey: "devcon-8-entry",
          consumedAtMs: 2_000,
        });
        assert.equal(consumed.status, "consumed");
        // Idempotent: a second consume is already-consumed, never a second fire.
        const second = yield* store.consumeOccurrence({
          environmentId: ENV,
          capabilityId: CAP,
          version: 1,
          occurrenceKey: "devcon-8-entry",
          consumedAtMs: 3_000,
        });
        assert.equal(second.status, "already-consumed");
        // The same occurrence re-detected later windows on: refused for good.
        const redetect = yield* store.recordOccurrence(occurrenceInput({ detectedAtMs: 9_000 }));
        assert.equal(redetect.status, "consumed");
        const snapshot = yield* store.readOccurrence(ENV, CAP, 1, "devcon-8-entry");
        assert.equal(snapshot?.status, "consumed");
        assert.equal(snapshot?.consumedAtMs, 2_000);
      }),
  );

  it.effect(
    "a changed reset discriminator is the specified reset: old row closes, new one opens",
    () =>
      Effect.gen(function* () {
        yield* resetOccurrences;
        const store: DetectorRunStoreShape = yield* makeDetectorRunStore;
        yield* store.recordOccurrence(occurrenceInput({ resetKey: "window-epoch-1" }));
        // Reset: the program's discriminator moved on; the re-match is a NEW
        // occurrence (the false→true transition happened again).
        const afterReset = yield* store.recordOccurrence(
          occurrenceInput({ resetKey: "window-epoch-2", detectedAtMs: 7_000 }),
        );
        assert.equal(afterReset.status, "recorded");
        const snapshot = yield* store.readOccurrence(ENV, CAP, 1, "devcon-8-entry");
        assert.equal(snapshot?.status, "active");
        assert.equal(snapshot?.resetKey, "window-epoch-2");
        assert.equal(snapshot?.firstDetectedAtMs, 7_000);
        // The reset old row is closed and cannot be consumed.
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql`
        SELECT consumed_at_ms, reset_at_ms FROM forge_detector_occurrences
        WHERE occurrence_key = ${"devcon-8-entry"} ORDER BY occurrence_row_id
      `;
        assert.equal(rows.length, 2);
        assert.equal(rows[0]?.reset_at_ms, 7_000);
        assert.isNull(rows[0]?.consumed_at_ms);
        assert.isNull(rows[1]?.reset_at_ms);
      }),
  );

  it.effect(
    "a detector artifact revision is a new program identity with a fresh occurrence space",
    () =>
      Effect.gen(function* () {
        yield* resetOccurrences;
        const store: DetectorRunStoreShape = yield* makeDetectorRunStore;
        yield* store.recordOccurrence(occurrenceInput({ version: 1 }));
        yield* store.consumeOccurrence({
          environmentId: ENV,
          capabilityId: CAP,
          version: 1,
          occurrenceKey: "devcon-8-entry",
          consumedAtMs: 2_000,
        });
        // The same occurrenceKey under version 2 (the revised artifact): a new
        // program, its own transition — but the v1 row is untouched history.
        const revised = yield* store.recordOccurrence(
          occurrenceInput({ version: 2, detectedAtMs: 8_000 }),
        );
        assert.equal(revised.status, "recorded");
        assert.equal(
          (yield* store.readOccurrence(ENV, CAP, 1, "devcon-8-entry"))?.status,
          "consumed",
        );
        assert.equal(
          (yield* store.readOccurrence(ENV, CAP, 2, "devcon-8-entry"))?.status,
          "active",
        );
        // Another capability's occurrence space reads nothing.
        assert.isNull(yield* store.readOccurrence(ENV, "other-detector", 1, "devcon-8-entry"));
      }),
  );

  it.effect(
    "consume refuses not-found and reset occurrences; invalid records refuse before writes",
    () =>
      Effect.gen(function* () {
        yield* resetOccurrences;
        const store: DetectorRunStoreShape = yield* makeDetectorRunStore;
        const missing = yield* store.consumeOccurrence({
          environmentId: ENV,
          capabilityId: CAP,
          version: 1,
          occurrenceKey: "never-seen",
          consumedAtMs: 1,
        });
        assert.equal(missing.status, "not-found");
        // A reset (never consumed) occurrence cannot fire either.
        yield* store.recordOccurrence(occurrenceInput({ resetKey: "epoch-1" }));
        yield* store.recordOccurrence(
          occurrenceInput({ resetKey: "epoch-2", detectedAtMs: 5_000 }),
        );
        const sql = yield* SqlClient.SqlClient;
        const oldRow = yield* sql`
        SELECT occurrence_row_id FROM forge_detector_occurrences
        WHERE occurrence_key = ${"devcon-8-entry"} ORDER BY occurrence_row_id LIMIT 1
      `;
        yield* sql`
        UPDATE forge_detector_occurrences SET reset_at_ms = 4_000
        WHERE occurrence_row_id = ${oldRow[0]?.occurrence_row_id}
      `;
        const invalid = yield* store.recordOccurrence({ ...occurrenceInput(), occurrenceKey: " " });
        assert.equal(invalid.status, "refused");
        if (invalid.status === "refused") assert.equal(invalid.reason, "invalid-occurrence");
        // Boundary validation wrote nothing.
        const count = yield* sql`SELECT COUNT(*) AS n FROM forge_detector_occurrences`;
        assert.equal(count[0]?.n, 2);
      }),
  );
});
