/**
 * Direct service test for the explicit external-event import.
 *
 * What is pinned here is the honesty contract, not the happy path alone: an
 * import is ONE bounded capture over the real connector (fake transport at
 * the seam) projecting the retained revisions through the REAL
 * TradingEventService — author `agent`, whole-list replacement — with every
 * skip counted, every capture failure named, and the availability window
 * (first observed, never publication) carried in the result and the lineage.
 */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Schema } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../../persistence/Migrations.ts";
import { makeTradingEventService, TradingEventService } from "../TradingEventService.ts";
import {
  ExternalSourceConfig,
  ExternalSourceConnector,
  ExternalSourceTransport,
  makeExternalSourceConnector,
  resolveExternalSourceSettings,
  type ExternalSourceHttpResponse,
  type ExternalSourceTransportShape,
} from "./ExternalSourceConnector.ts";
import { ExternalSourceStore, makeExternalSourceStore } from "./ExternalSourceStore.ts";
import {
  makeExternalEventImportService,
  type ExternalEventImportResult,
} from "./ExternalEventImportService.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory(), NodeServices.layer));

const ENV = { T3_EXTERNAL_GITHUB_RELEASES: "o/r" };

// The repo forbids bare JSON.parse/stringify; fixtures and row decodes go
// through the codec.
const toJsonText = (value: unknown): string =>
  Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(value);

const fromJsonText = (text: string): unknown =>
  Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))(text);

const releaseFixture = (overrides?: Record<string, unknown>) => ({
  id: 1,
  tag_name: "v1.0.0",
  name: "First",
  body: "initial notes",
  published_at: "2026-01-02T03:04:05Z",
  html_url: "https://github.com/o/r/releases/tag/v1.0.0",
  ...overrides,
});

const jsonResponse = (body: unknown): ExternalSourceHttpResponse => ({
  status: 200,
  headers: { "content-type": "application/json; charset=utf-8" },
  bodyBytes: new TextEncoder().encode(toJsonText(body)),
});

/** The transport answer is state the test flips between captures. */
interface FlipTransport extends ExternalSourceTransportShape {
  setPage(body: unknown): void;
  failWith(reason: string): void;
}

const flipTransport = (initialPage: unknown): FlipTransport => {
  let page = jsonResponse(initialPage);
  let failure: string | null = null;
  return {
    setPage: (body) => {
      page = jsonResponse(body);
      failure = null;
    },
    failWith: (reason) => {
      failure = reason;
    },
    get: () => (failure === null ? Effect.succeed(page) : Effect.fail(failure)),
  };
};

const makeImporter = (
  env: Record<string, string | undefined>,
  transport: ExternalSourceTransportShape,
) =>
  Effect.gen(function* () {
    yield* runMigrations({});
    const store = yield* makeExternalSourceStore;
    const connector = yield* makeExternalSourceConnector.pipe(
      Effect.provideService(ExternalSourceStore, ExternalSourceStore.of(store)),
      Effect.provideService(
        ExternalSourceConfig,
        ExternalSourceConfig.of({ resolve: Effect.succeed(resolveExternalSourceSettings(env)) }),
      ),
      Effect.provideService(ExternalSourceTransport, ExternalSourceTransport.of(transport)),
    );
    const events = yield* makeTradingEventService;
    const importer = yield* makeExternalEventImportService.pipe(
      Effect.provideService(ExternalSourceConnector, ExternalSourceConnector.of(connector)),
      Effect.provideService(ExternalSourceStore, ExternalSourceStore.of(store)),
      Effect.provideService(TradingEventService, TradingEventService.of(events)),
    );
    return { store, events, importer };
  });

const expectOk = (result: ExternalEventImportResult) => {
  if (result.outcome !== "ok") {
    throw new Error(`expected an ok import, got refused: ${result.reason}`);
  }
  return result;
};

const expectRefused = (result: ExternalEventImportResult) => {
  if (result.outcome !== "refused") {
    throw new Error("expected a refused import, got ok");
  }
  return result;
};

/** Lineage rows for one imported set name, oldest first. */
const lineageFor = Effect.fn("lineageFor")(function* (eventSetName: string) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    readonly import_id: string;
    readonly revision_ids_json: string;
    readonly capture_status: string;
    readonly capture_note: string | null;
    readonly imported_at_ms: number;
  }>`
    SELECT import_id, revision_ids_json, capture_status, capture_note, imported_at_ms
    FROM trading_event_set_imports
    WHERE event_set_name = ${eventSetName}
    ORDER BY imported_at_ms ASC
  `;
});

layer("ExternalEventImportService import", (it) => {
  it.effect(
    "maps three fixture releases into a real event set: tag labels, release URLs, instant precision, agent author",
    () =>
      Effect.gen(function* () {
        const first = releaseFixture({ id: 1, body: "one" });
        const second = releaseFixture({
          id: 2,
          tag_name: "v1.1.0",
          body: "two",
          published_at: "2026-02-03T04:05:06Z",
          html_url: "https://github.com/o/r/releases/tag/v1.1.0",
        });
        const untagged = releaseFixture({
          id: 3,
          tag_name: null,
          published_at: null,
          body: "three",
        });
        const { store, events, importer } = yield* makeImporter(
          ENV,
          flipTransport([first, second, untagged]),
        );

        const result = expectOk(
          yield* importer.importExternalSource({
            environmentId: "env-imp-basic",
            eventSetName: "o/r releases basic",
            now: 10_000,
            threadId: "thread-imp-basic",
          }),
        );

        // The untagged, unpublished release is skipped and counted, never padded.
        assert.equal(result.skippedUnpublished, 1);
        assert.equal(result.skippedUnreadable, 0);
        assert.equal(result.correctionsObserved, 3);

        const set = result.eventSet;
        assert.equal(set.name, "o/r releases basic");
        assert.equal(set.occurrences.length, 2);
        // show() reads by start_at ascending: v1.0.0 then v1.1.0.
        const [rowOne, rowTwo] = set.occurrences;
        assert.equal(rowOne?.label, "v1.0.0");
        assert.equal(rowOne?.source, "https://github.com/o/r/releases/tag/v1.0.0");
        assert.equal(rowOne?.startAt, Date.parse("2026-01-02T03:04:05Z"));
        assert.equal(rowOne?.endAt, rowOne?.startAt);
        assert.equal(rowOne?.timePrecision, "instant");
        assert.equal(rowTwo?.label, "v1.1.0");
        assert.equal(rowTwo?.startAt, Date.parse("2026-02-03T04:05:06Z"));
        assert.equal(rowTwo?.timePrecision, "instant");

        // list/show through the real event service see the set.
        const listed = yield* events.list({ now: 10_000 });
        assert.ok(listed.some((row) => row.name === "o/r releases basic"));
        const shown = yield* events.show(set.eventSetId);
        assert.equal(shown?.occurrences.length, 2);

        // The authored path wrote author 'agent' on every occurrence row.
        const sql = yield* SqlClient.SqlClient;
        const authors = yield* sql<{ readonly author: string; readonly n: number }>`
          SELECT author, COUNT(*) AS n FROM trading_event_occurrences
          WHERE event_set_id = ${set.eventSetId} GROUP BY author
        `;
        assert.deepEqual(authors, [{ author: "agent", n: 2 }]);

        // Lineage: one row, projection-order revision ids, ok capture.
        const rows = yield* lineageFor("o/r releases basic");
        assert.equal(rows.length, 1);
        assert.equal(rows[0]?.capture_status, "ok");
        assert.equal(rows[0]?.capture_note, null);
        // Projection order is the store's listing order (newest first): the
        // unpublished document was skipped, so [second, first].
        const listedDocs = yield* store.listDocuments({
          environmentId: "env-imp-basic",
          sourceKind: "github-releases",
        });
        const expectedIds = listedDocs
          .filter(({ revision }) => revision.publishedAtMs !== null)
          .map(({ revision }) => revision.revisionId);
        assert.deepEqual(fromJsonText(rows[0]?.revision_ids_json ?? "null"), expectedIds);
        assert.equal(result.contentSha256.length, 64);

        // Availability: publication times came from the source; this server
        // first observed every document at the capture instant.
        assert.equal(result.firstObservedFromMs, 10_000);
        assert.equal(result.firstObservedToMs, 10_000);
        assert.match(result.availabilityNote, /not availability times/);
        assert.include(result.availabilityNote, "1970-01-01T00:00:10.000Z");
      }),
  );

  it.effect(
    "re-import after an edited release replaces the occurrences, adds a lineage row, and counts the correction",
    () =>
      Effect.gen(function* () {
        const original = [
          releaseFixture({ id: 1, body: "one" }),
          releaseFixture({
            id: 2,
            tag_name: "v1.1.0",
            body: "two",
            published_at: "2026-02-03T04:05:06Z",
            html_url: "https://github.com/o/r/releases/tag/v1.1.0",
          }),
        ];
        // A real correction: the body changed AND the publication date moved.
        const edited = original.map((release) =>
          release.tag_name === "v1.1.0"
            ? { ...release, body: "two (edited)", published_at: "2026-02-04T05:06:07Z" }
            : release,
        );
        const transport = flipTransport(original);
        const { events, importer } = yield* makeImporter(ENV, transport);

        const first = expectOk(
          yield* importer.importExternalSource({
            environmentId: "env-imp-edit",
            eventSetName: "o/r releases edit",
            now: 1_000,
            threadId: "thread-imp-edit",
          }),
        );
        const oldBTime = Date.parse("2026-02-03T04:05:06Z");
        const newBTime = Date.parse("2026-02-04T05:06:07Z");

        transport.setPage(edited);
        const second = expectOk(
          yield* importer.importExternalSource({
            environmentId: "env-imp-edit",
            eventSetName: "o/r releases edit",
            now: 9_000,
            threadId: "thread-imp-edit",
          }),
        );

        // Exactly one document changed at the source since the previous capture.
        assert.equal(second.correctionsObserved, 1);
        // record semantics: replacement, not accumulation — same set id, the
        // corrected time present, the superseded time gone.
        assert.equal(second.eventSet.eventSetId, first.eventSet.eventSetId);
        const starts = second.eventSet.occurrences.map((row) => row.startAt);
        assert.ok(starts.includes(newBTime));
        assert.ok(!starts.includes(oldBTime));
        assert.equal(second.eventSet.occurrences.length, 2);
        assert.notEqual(second.contentSha256, first.contentSha256);

        // Two lineage rows; the second names the edited document's NEW revision.
        const rows = yield* lineageFor("o/r releases edit");
        assert.equal(rows.length, 2);
        const firstIds = fromJsonText(
          rows[0]?.revision_ids_json ?? "null",
        ) as ReadonlyArray<string>;
        const secondIds = fromJsonText(
          rows[1]?.revision_ids_json ?? "null",
        ) as ReadonlyArray<string>;
        assert.equal(firstIds.length, 2);
        assert.equal(secondIds.length, 2);
        const corrected = secondIds.find((id) => !firstIds.includes(id));
        assert.isDefined(corrected);

        // The replacement really went through the event service's own tables.
        const shown = yield* events.show(second.eventSet.eventSetId);
        assert.equal(shown?.occurrences.length, 2);

        // Availability window now spans the two captures: the untouched
        // document was first observed at 1_000, the correction at 9_000.
        assert.equal(second.firstObservedFromMs, 1_000);
        assert.equal(second.firstObservedToMs, 9_000);
        assert.include(second.availabilityNote, "1970-01-01T00:00:01.000Z");
        assert.include(second.availabilityNote, "1970-01-01T00:00:09.000Z");
      }),
  );

  it.effect(
    "imports over retained revisions when the capture fails, naming the failure in result and lineage",
    () =>
      Effect.gen(function* () {
        const transport = flipTransport([releaseFixture({ id: 1, body: "one" })]);
        const { importer } = yield* makeImporter(ENV, transport);

        expectOk(
          yield* importer.importExternalSource({
            environmentId: "env-imp-stale",
            eventSetName: "o/r releases stale",
            now: 1_000,
            threadId: "thread-imp-stale",
          }),
        );

        transport.failWith("connection refused");
        const result = expectOk(
          yield* importer.importExternalSource({
            environmentId: "env-imp-stale",
            eventSetName: "o/r releases stale",
            now: 9_000,
            threadId: "thread-imp-stale",
          }),
        );
        assert.equal(result.capture.status, "unavailable");
        if (result.capture.status !== "unavailable") return;
        assert.match(result.capture.reason, /github releases fetch failed: connection refused/);
        assert.equal(result.eventSet.occurrences.length, 1);

        const rows = yield* lineageFor("o/r releases stale");
        assert.equal(rows.length, 2);
        assert.equal(rows[0]?.capture_status, "ok");
        assert.equal(rows[1]?.capture_status, "unavailable");
        assert.match(rows[1]?.capture_note ?? "", /connection refused/);

        // requireCapture refuses the same situation instead of importing.
        const strict = expectRefused(
          yield* importer.importExternalSource({
            environmentId: "env-imp-stale",
            eventSetName: "o/r releases stale",
            now: 10_000,
            threadId: "thread-imp-stale",
            requireCapture: true,
          }),
        );
        assert.match(strict.reason, /the capture before this import failed/);
      }),
  );

  it.effect("refuses with a named reason when the capture fails and nothing is retained", () =>
    Effect.gen(function* () {
      const { events, importer } = yield* makeImporter({}, flipTransport([releaseFixture()]));
      const refused = expectRefused(
        yield* importer.importExternalSource({
          environmentId: "env-imp-none",
          eventSetName: "o/r releases none",
          now: 1_000,
          threadId: "thread-imp-none",
        }),
      );
      assert.match(refused.reason, /no external revisions retained and the capture failed/);
      assert.match(refused.reason, /T3_EXTERNAL_GITHUB_RELEASES/);
      // Nothing was written: no set of that name, no lineage row.
      const listed = yield* events.list({ now: 1_000 });
      assert.ok(!listed.some((row) => row.name === "o/r releases none"));
      const rows = yield* lineageFor("o/r releases none");
      assert.equal(rows.length, 0);
    }),
  );

  it.effect("refuses when every retained document lacks a publication time — no empty set", () =>
    Effect.gen(function* () {
      const page = [
        releaseFixture({ id: 1, published_at: null }),
        releaseFixture({ id: 2, tag_name: "v1.1.0", published_at: null }),
      ];
      const { events, importer } = yield* makeImporter(ENV, flipTransport(page));
      const refused = expectRefused(
        yield* importer.importExternalSource({
          environmentId: "env-imp-unpub",
          eventSetName: "o/r releases unpub",
          now: 1_000,
          threadId: "thread-imp-unpub",
        }),
      );
      assert.match(refused.reason, /2 with no publication time/);
      assert.match(refused.reason, /cannot anchor a study window/);
      const listed = yield* events.list({ now: 1_000 });
      assert.ok(!listed.some((row) => row.name === "o/r releases unpub"));
      const rows = yield* lineageFor("o/r releases unpub");
      assert.equal(rows.length, 0);
    }),
  );

  it.effect("skips a document whose stored payload is corrupt, importing the rest", () =>
    Effect.gen(function* () {
      const page = [
        releaseFixture({ id: 1, body: "one" }),
        releaseFixture({
          id: 2,
          tag_name: "v2.0.0",
          body: "two",
          published_at: "2026-03-04T05:06:07Z",
          html_url: "https://github.com/o/r/releases/tag/v2.0.0",
        }),
      ];
      const { store, importer } = yield* makeImporter(ENV, flipTransport(page));

      const first = expectOk(
        yield* importer.importExternalSource({
          environmentId: "env-imp-corrupt",
          eventSetName: "o/r releases corrupt",
          now: 1_000,
          threadId: "thread-imp-corrupt",
        }),
      );
      assert.equal(first.eventSet.occurrences.length, 2);

      // Simulate storage corruption on one retained revision: the bytes under
      // a revision id stop parsing. The store's immutability guard is about
      // inserts; this row-level corruption is exactly what readDocument must
      // surface rather than guess around.
      const sql = yield* SqlClient.SqlClient;
      const docs = yield* store.listDocuments({
        environmentId: "env-imp-corrupt",
        sourceKind: "github-releases",
      });
      const victim = docs.find(({ revision }) => revision.documentIdentity.includes("v1.0.0"));
      assert.isDefined(victim);
      yield* sql`UPDATE external_source_revisions SET payload_json = 'not json at all'
        WHERE revision_id = ${victim?.revision.revisionId ?? ""}`;

      const second = expectOk(
        yield* importer.importExternalSource({
          environmentId: "env-imp-corrupt",
          eventSetName: "o/r releases corrupt",
          now: 9_000,
          threadId: "thread-imp-corrupt",
        }),
      );
      assert.equal(second.skippedUnreadable, 1);
      assert.equal(second.skippedUnpublished, 0);
      // The set was re-recorded with only the readable document.
      assert.equal(second.eventSet.occurrences.length, 1);
      assert.equal(second.eventSet.occurrences[0]?.label, "v2.0.0");
    }),
  );
});
