import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { Schema } from "effect";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ExternalSourceManifest } from "@t3tools/trading-contracts";
import createRevisionsTable from "../../persistence/Migrations/103_ExternalSourceRevisions.ts";
import {
  makeExternalSourceStore,
  toManifest,
  type ExternalSourceRevision,
  type ExternalSourceStoreShape,
} from "./ExternalSourceStore.ts";

// The memory layer is built once per describe block, so every test scopes its
// rows under its own environmentId instead of expecting an empty database.
const layer = it.layer(NodeSqliteClient.layerMemory());

const revision = (overrides?: Partial<ExternalSourceRevision>): ExternalSourceRevision => ({
  revisionId: "rev-1",
  environmentId: "env-1",
  sourceKind: "github-releases",
  documentIdentity: "github-release:o/r:v1.0.0",
  sourceUrl: "https://github.com/o/r/releases/tag/v1.0.0",
  contentSha256: "a".repeat(64),
  publishedAtMs: 1_000,
  timePrecision: "instant",
  firstObservedAtMs: 2_000,
  captureMs: 2_000,
  correctionOf: null,
  retracted: false,
  ...overrides,
});

const history = (store: ExternalSourceStoreShape, environmentId: string) =>
  store.history({
    environmentId,
    sourceKind: "github-releases",
    documentIdentity: "github-release:o/r:v1.0.0",
  });

const latest = (store: ExternalSourceStoreShape, environmentId: string) =>
  store.latestRevision({
    environmentId,
    sourceKind: "github-releases",
    documentIdentity: "github-release:o/r:v1.0.0",
  });

// decodeUnknownSync stays outside Effect generators (repo lint rule).
const decodeManifest = (value: unknown) => Schema.decodeUnknownSync(ExternalSourceManifest)(value);

layer("ExternalSourceStore insert immutability", (it) => {
  it.effect("persists the first insert and treats an identical re-insert as a no-op", () =>
    Effect.gen(function* () {
      yield* createRevisionsTable;
      const store = yield* makeExternalSourceStore;
      const row = revision({ environmentId: "env-immut-a" });
      yield* store.insert({ revision: row, payloadJson: '{"id":1}' });
      yield* store.insert({ revision: row, payloadJson: '{"id":1}' });
      const rows = yield* history(store, "env-immut-a");
      assert.equal(rows.length, 1);
      assert.deepEqual(rows[0], row);
    }),
  );

  it.effect("refuses different bytes under an existing id and keeps the original payload", () =>
    Effect.gen(function* () {
      yield* createRevisionsTable;
      const store = yield* makeExternalSourceStore;
      const row = revision({ environmentId: "env-immut-b", revisionId: "rev-immut-b" });
      yield* store.insert({ revision: row, payloadJson: '{"id":1}' });
      const error = yield* store
        .insert({ revision: row, payloadJson: '{"id":2}' })
        .pipe(Effect.flip);
      assert.match(
        error.message,
        /revision id collision: payload differs under an existing revision id/,
      );
      const sql = yield* SqlClient.SqlClient;
      const payload = yield* sql<{ readonly payload_json: string }>`
        SELECT payload_json FROM external_source_revisions WHERE revision_id = 'rev-immut-b'
      `;
      // The refused insert must not have replaced or widened the row.
      assert.equal(payload[0]?.payload_json, '{"id":1}');
      const rows = yield* history(store, "env-immut-b");
      assert.equal(rows.length, 1);
    }),
  );

  it.effect("round-trips null publishedAtMs and the date precision", () =>
    Effect.gen(function* () {
      yield* createRevisionsTable;
      const store = yield* makeExternalSourceStore;
      const dated = revision({
        revisionId: "rev-date",
        environmentId: "env-immut-c",
        publishedAtMs: null,
        timePrecision: "date",
      });
      yield* store.insert({ revision: dated, payloadJson: "{}" });
      const found = yield* latest(store, "env-immut-c");
      assert.deepEqual(found?.revision, dated);
    }),
  );
});

layer("ExternalSourceStore revision chains", (it) => {
  it.effect(
    "keeps the full history oldest→newest and prefers the newest non-retracted revision",
    () =>
      Effect.gen(function* () {
        yield* createRevisionsTable;
        const store = yield* makeExternalSourceStore;
        yield* store.insert({
          revision: revision({
            environmentId: "env-chains-a",
            revisionId: "rev-chains-a-1",
            firstObservedAtMs: 2_000,
            captureMs: 2_000,
          }),
          payloadJson: "one",
        });
        yield* store.insert({
          revision: revision({
            environmentId: "env-chains-a",
            revisionId: "rev-chains-a-2",
            contentSha256: "b".repeat(64),
            firstObservedAtMs: 3_000,
            captureMs: 3_000,
            correctionOf: "rev-chains-a-1",
          }),
          payloadJson: "two",
        });

        const rows = yield* history(store, "env-chains-a");
        assert.deepEqual(
          rows.map((entry) => entry.revisionId),
          ["rev-chains-a-1", "rev-chains-a-2"],
        );
        assert.equal(rows[1]?.correctionOf, "rev-chains-a-1");

        const found = yield* latest(store, "env-chains-a");
        assert.equal(found?.revision.revisionId, "rev-chains-a-2");
        assert.equal(found?.retraction, null);
      }),
  );

  it.effect("exposes the retraction row without ever losing the retracted content", () =>
    Effect.gen(function* () {
      yield* createRevisionsTable;
      const store = yield* makeExternalSourceStore;
      yield* store.insert({
        revision: revision({
          environmentId: "env-chains-b",
          revisionId: "rev-chains-b-1",
          firstObservedAtMs: 2_000,
          captureMs: 2_000,
        }),
        payloadJson: "one",
      });
      yield* store.insert({
        revision: revision({
          environmentId: "env-chains-b",
          revisionId: "rev-chains-b-2",
          contentSha256: "b".repeat(64),
          firstObservedAtMs: 3_000,
          captureMs: 3_000,
          correctionOf: "rev-chains-b-1",
        }),
        payloadJson: "two",
      });
      yield* store.insert({
        revision: revision({
          environmentId: "env-chains-b",
          revisionId: "rev-chains-b-3",
          firstObservedAtMs: 4_000,
          captureMs: 4_000,
          correctionOf: "rev-chains-b-2",
          retracted: true,
        }),
        payloadJson: "two",
      });

      const found = yield* latest(store, "env-chains-b");
      assert.equal(found?.revision.revisionId, "rev-chains-b-2");
      assert.equal(found?.retraction?.revisionId, "rev-chains-b-3");

      const rows = yield* history(store, "env-chains-b");
      assert.deepEqual(
        rows.map((entry) => entry.revisionId),
        ["rev-chains-b-1", "rev-chains-b-2", "rev-chains-b-3"],
      );
      assert.equal(rows[2]?.retracted, true);
    }),
  );

  it.effect("latestRevision is null when the document is unknown or only retracted", () =>
    Effect.gen(function* () {
      yield* createRevisionsTable;
      const store = yield* makeExternalSourceStore;
      const unknown = yield* latest(store, "env-chains-c");
      assert.equal(unknown, null);
      yield* store.insert({
        revision: revision({
          environmentId: "env-chains-c",
          revisionId: "rev-only",
          retracted: true,
        }),
        payloadJson: "x",
      });
      const retractedOnly = yield* latest(store, "env-chains-c");
      assert.equal(retractedOnly, null);
    }),
  );
});

layer("ExternalSourceStore listDocuments", (it) => {
  it.effect("returns the newest revision per distinct document, capped at 100", () =>
    Effect.gen(function* () {
      yield* createRevisionsTable;
      const store = yield* makeExternalSourceStore;
      for (let index = 0; index < 105; index += 1) {
        yield* store.insert({
          revision: revision({
            environmentId: "env-list",
            revisionId: `rev-${index}`,
            documentIdentity: `github-release:o/r:doc-${index}`,
            firstObservedAtMs: index,
            captureMs: index,
          }),
          payloadJson: String(index),
        });
      }
      // A second, newer revision on one document must be the listed one.
      yield* store.insert({
        revision: revision({
          environmentId: "env-list",
          revisionId: "rev-3-correction",
          documentIdentity: "github-release:o/r:doc-3",
          contentSha256: "b".repeat(64),
          firstObservedAtMs: 500,
          captureMs: 500,
          correctionOf: "rev-3",
        }),
        payloadJson: "corrected",
      });

      const listed = yield* store.listDocuments({
        environmentId: "env-list",
        sourceKind: "github-releases",
        limit: 200,
      });
      assert.equal(listed.length, 100);
      // The document with a correction lists its newest revision, newest-first.
      assert.equal(listed[0]?.documentIdentity, "github-release:o/r:doc-3");
      assert.equal(listed[0]?.revision.revisionId, "rev-3-correction");
      assert.equal(listed[0]?.revision.correctionOf, "rev-3");
      assert.equal(listed[1]?.documentIdentity, "github-release:o/r:doc-104");

      const uncapped = yield* store.listDocuments({
        environmentId: "env-list",
        sourceKind: "github-releases",
      });
      assert.equal(uncapped.length, 100);
    }),
  );
});

layer("ExternalSourceStore toManifest projection", (it) => {
  it.effect("projects rows into the ExternalSourceManifest contract shape", () =>
    Effect.gen(function* () {
      const manifest = toManifest(revision());
      assert.deepEqual(manifest, {
        id: "rev-1",
        environmentId: "env-1",
        providerKind: "github-releases",
        documentIdentity: "github-release:o/r:v1.0.0",
        sourceUrl: "https://github.com/o/r/releases/tag/v1.0.0",
        contentSha256: "a".repeat(64),
        publishedAtMs: 1_000,
        timePrecision: "second",
        firstObservedAtMs: 2_000,
        correctionOf: null,
        retracted: false,
      });
      // The projection is decodable through the P1 contract schema.
      assert.deepEqual(decodeManifest(manifest), manifest);
      // Date documents carry day precision at the contract boundary.
      const dated = toManifest(revision({ timePrecision: "date" }));
      assert.equal(dated.timePrecision, "day");
    }),
  );
});
