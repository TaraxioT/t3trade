/**
 * GeneratedExternalSourceService — held to its contract against scripted
 * fakes: a fake transport at the existing seam, the REAL ExternalSourceStore
 * over in-memory SQLite (migrations 103 + 109), a fake capability store
 * (activeState/readArtifact), and a fake sandbox implementing the documented
 * forge-parse-v2 head contract (envelope in, validated records out) serving
 * the capability's declared transform.ts artifact.
 *
 * Properties under test: spec validation refusals, install-time transform
 * pinning, the URL allowlist, capture-policy intervals, redirect/size/status
 * refusals, whole-capture schema validation, honest publication times and
 * precision, corrections through correctionOf, no-op identical content,
 * retractions for vanished records, providerKind `generated:<sourceId>`, and
 * the credential never appearing in any reason, envelope, or retained row.
 */
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { Schema } from "effect";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import createRevisionsTable from "../../persistence/Migrations/103_ExternalSourceRevisions.ts";
import createAdapterSourcesTable from "../../persistence/Migrations/109_ExternalAdapterSources.ts";
import {
  ForgeCapabilitySandbox,
  ForgeSandboxError,
  type ForgeCapabilitySandboxShape,
} from "../forge/CapabilitySandbox.ts";
import { ForgeCapabilityStore, type ForgeCapabilityStoreShape } from "../forge/CapabilityStore.ts";
import { ExternalSourceStore, makeExternalSourceStore } from "./ExternalSourceStore.ts";
import { ExternalSourceTransport } from "./ExternalSourceConnector.ts";
import {
  FORGE_RUNNER_PARSE_V2,
  GeneratedExternalSourceConfig,
  makeGeneratedExternalSourceService,
  validateExternalAdapterSourceSpec,
  validateRecordAgainstSchema,
  type ExternalAdapterSourceSpec,
  type ExternalAdapterEventSchema,
  type AdapterParseEnvelope,
  type GeneratedExternalSourceServiceShape,
  type GeneratedSourceCapture,
} from "./GeneratedExternalSourceService.ts";

const layer = it.layer(NodeSqliteClient.layerMemory());

// The memory layer is shared across the describe block: every test scopes
// its rows under its own environmentId.
let envCounter = 0;
const envFor = (name: string): string => `env_gen_${name}_${(envCounter += 1)}`;
const CAPABILITY = "devcon-calendar";
const BUNDLE = "c".repeat(64);
const TRANSFORM_SOURCE = `import type {} from "./sdk";\nexport function parseDocument(envelope: { bodyBase64: string }): { records: unknown[] } {\n  return { records: [] };\n}\n`;
const URL = "https://devcon.org/en/schedule/";

const calendarSchema: ExternalAdapterEventSchema = {
  recordKind: "devcon-edition",
  identityField: "name",
  publishedAtField: "announcedDate",
  fields: [
    { name: "name", type: "text", required: true },
    { name: "announcedDate", type: "iso8601-date", required: false },
    { name: "startDate", type: "iso8601-date", required: true },
    { name: "endDate", type: "iso8601-date", required: true },
    { name: "url", type: "url", required: true },
    { name: "edition", type: "integer", required: false },
  ],
};

const spec = (overrides?: Partial<ExternalAdapterSourceSpec>): ExternalAdapterSourceSpec => ({
  sourceId: "devcon-calendar",
  kind: "http-document",
  url: URL,
  method: "GET",
  credentialEnvName: null,
  transformRef: { capabilityId: CAPABILITY, version: 3, bundleSha256: BUNDLE },
  outputEventSchema: calendarSchema,
  capturePolicy: { minIntervalMs: 60_000, maxDocumentBytes: 65_536 },
  ...overrides,
});

const record = (name: string, overrides?: Record<string, unknown>): Record<string, unknown> => ({
  name,
  announcedDate: "2026-08-01",
  startDate: "2026-11-03",
  endDate: "2026-11-06",
  url: "https://devcon.org/",
  edition: 8,
  ...overrides,
});

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface ScriptedParse {
  /** What the fake sandbox's parseDocument returns; defaults to decoding the
   * envelope body as JSON and mapping its `records` array. */
  readonly recordsFor?: (envelope: AdapterParseEnvelope) => unknown[];
  readonly failWith?: string;
}

const makeFakes = (parse: ScriptedParse) => {
  const envelopes: Array<AdapterParseEnvelope> = [];
  // Decoding stays outside Effect generators (repo lint rule).
  const decodeEnvelope = (stdinJson: string): AdapterParseEnvelope | string => {
    try {
      const value = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))(
        stdinJson,
      ) as AdapterParseEnvelope;
      return value;
    } catch (cause) {
      return `fake sandbox could not decode its input: ${String(cause)}`;
    }
  };
  const decodeBody = (bodyBase64: string): unknown[] => {
    const body = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))(
      Buffer.from(bodyBase64, "base64").toString("utf8"),
    ) as { records?: unknown[] };
    return body.records ?? [];
  };
  const sandboxShape: ForgeCapabilitySandboxShape = {
    available: Effect.succeed(true),
    runBuildStep: () => Effect.die("build steps are not part of this service"),
    runEvaluation: ({ stdinJson, decodeResult }) => {
      const envelope = decodeEnvelope(stdinJson);
      if (typeof envelope === "string") {
        return new ForgeSandboxError({ kind: "invalid_result", reason: envelope });
      }
      envelopes.push(envelope);
      if (parse.failWith !== undefined) {
        return new ForgeSandboxError({ kind: "invalid_result", reason: parse.failWith });
      }
      const records = parse.recordsFor?.(envelope) ?? decodeBody(envelope.bodyBase64);
      try {
        return Effect.succeed(decodeResult({ records }));
      } catch (cause) {
        return new ForgeSandboxError({
          kind: "invalid_result",
          reason: `host decoder refused: ${String(cause)}`,
        });
      }
    },
  };
  return { envelopes, sandboxShape };
};

const capabilityStoreShape = (input?: {
  readonly version?: number;
  readonly bundleSha256?: string;
  readonly adapterSource?: string | null;
}): ForgeCapabilityStoreShape =>
  ({
    activeState: () =>
      Effect.succeed({
        version: input?.version ?? 3,
        bundleSha256: input?.bundleSha256 ?? BUNDLE,
        status: "active",
        armed: false,
      }),
    readArtifact: () =>
      Effect.succeed(input?.adapterSource === undefined ? TRANSFORM_SOURCE : input.adapterSource),
  }) as unknown as ForgeCapabilityStoreShape;

interface TransportScript {
  readonly status: number;
  readonly headers?: Record<string, string>;
  readonly body?: string | null;
}

const transportFor = (script: TransportScript) => ({
  get: () =>
    Effect.succeed({
      status: script.status,
      headers: { "content-type": "text/html", ...(script.headers ?? {}) },
      bodyBytes:
        script.body === null || script.body === undefined
          ? null
          : new TextEncoder().encode(script.body),
    }),
});

interface Harness {
  readonly service: GeneratedExternalSourceServiceShape;
  readonly store: import("./ExternalSourceStore.ts").ExternalSourceStoreShape;
  readonly envelopes: Array<AdapterParseEnvelope>;
}

const makeHarness = (input: {
  readonly hosts?: string;
  readonly transport: ReturnType<typeof transportFor>;
  readonly parse?: ScriptedParse;
  readonly capabilities?: Parameters<typeof capabilityStoreShape>[0];
}): Effect.Effect<Harness, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const revisions = yield* makeExternalSourceStore;
    const fakes = makeFakes(input.parse ?? {});
    const service = yield* makeGeneratedExternalSourceService.pipe(
      Effect.provideService(ExternalSourceStore, ExternalSourceStore.of(revisions)),
      Effect.provideService(ExternalSourceTransport, ExternalSourceTransport.of(input.transport)),
      Effect.provideService(ForgeCapabilitySandbox, ForgeCapabilitySandbox.of(fakes.sandboxShape)),
      Effect.provideService(
        ForgeCapabilityStore,
        ForgeCapabilityStore.of(capabilityStoreShape(input.capabilities)),
      ),
      Effect.provideService(
        GeneratedExternalSourceConfig,
        GeneratedExternalSourceConfig.of({
          hosts: new Set((input.hosts ?? "devcon.org").split(",").filter((host) => host !== "")),
        }),
      ),
    );
    return { service, store: revisions, envelopes: fakes.envelopes };
  });

// encodeSync stays outside Effect generators (repo lint rule).
const toJsonText = (value: unknown): string =>
  Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(value);

const okPage = (records: ReadonlyArray<Record<string, unknown>>): string => toJsonText({ records });

const expectOk = (capture: GeneratedSourceCapture) => {
  if (capture.status !== "ok")
    throw new Error(`expected ok capture, got unavailable: ${capture.reason}`);
  return capture;
};

const expectUnavailable = (capture: GeneratedSourceCapture) => {
  if (capture.status !== "unavailable") throw new Error(`expected unavailable capture, got ok`);
  return capture;
};

/** Validate once and surface the refusal reason, or "" when accepted. */
const refusalOf = (value: unknown): string => {
  const validated = validateExternalAdapterSourceSpec(value);
  return validated.ok ? "" : validated.reason;
};

// ---------------------------------------------------------------------------
// Pure validation
// ---------------------------------------------------------------------------

it.effect("spec validation accepts the calendar spec and refuses each corruption", () =>
  Effect.sync(() => {
    assert.deepEqual(validateExternalAdapterSourceSpec(spec()).ok, true);
    assert.match(refusalOf(spec({ url: "http://insecure.example" })), /https/);
    assert.match(refusalOf(spec({ method: "POST" as "GET" })), /GET/);
    assert.match(refusalOf(spec({ credentialEnvName: "not-an-env" })), /credentialEnvName/);
    assert.match(
      refusalOf(spec({ outputEventSchema: { ...calendarSchema, identityField: "edition" } })),
      /identityField/,
    );
    assert.match(
      refusalOf(spec({ outputEventSchema: { ...calendarSchema, publishedAtField: "name" } })),
      /publishedAtField/,
    );
  }),
);

it.effect(
  "record validation: declared order canonicalization, publication honesty, integer strings",
  () =>
    Effect.sync(() => {
      const validated = validateRecordAgainstSchema(record("Devcon 8"), calendarSchema);
      assert.equal(typeof validated === "string", false);
      if (typeof validated !== "string") {
        assert.equal(validated.publishedAtMs, Date.parse("2026-08-01T00:00:00Z"));
        assert.equal(validated.timePrecision, "date");
        assert.equal(validated.identityValue, "Devcon 8");
        assert.match(validated.canonical, /"edition":"8"/);
      }
      const unpublished = validateRecordAgainstSchema(
        record("Devcon 8", { announcedDate: undefined }),
        calendarSchema,
      );
      if (typeof unpublished !== "string") {
        assert.equal(unpublished.publishedAtMs, null);
      }
      const extra = validateRecordAgainstSchema({ ...record("X"), surprise: 1 }, calendarSchema);
      assert.match(typeof extra === "string" ? extra : "", /undeclared field/);
      const missing = validateRecordAgainstSchema({ name: "X" }, calendarSchema);
      assert.match(typeof missing === "string" ? missing : "", /required field/);
    }),
);

// ---------------------------------------------------------------------------
// Install + capture
// ---------------------------------------------------------------------------

layer("GeneratedExternalSourceService", (it) => {
  it.effect(
    "installs a valid spec and refuses one whose transform is not pinned to the active version",
    () =>
      Effect.gen(function* () {
        yield* createRevisionsTable;
        yield* createAdapterSourcesTable;
        const env = envFor("install");
        const harness = yield* makeHarness({
          transport: transportFor({ status: 200, body: okPage([record("Devcon 8")]) }),
        });
        const installed = yield* harness.service.installSource({
          environmentId: env,
          spec: spec(),
          now: 1_000,
        });
        assert.equal(installed.status, "ok");
        const drifted = yield* harness.service.installSource({
          environmentId: env,
          spec: spec({
            transformRef: { capabilityId: CAPABILITY, version: 4, bundleSha256: BUNDLE },
          }),
          now: 1_100,
        });
        assert.equal(drifted.status, "refused");
        assert.match(drifted.status === "refused" ? drifted.reason : "", /transform capability/);
      }),
  );

  it.effect("refuses an adapter artifact that imports anything beyond the host SDK", () =>
    Effect.gen(function* () {
      yield* createRevisionsTable;
      yield* createAdapterSourcesTable;
      const env = envFor("imports");
      const harness = yield* makeHarness({
        transport: transportFor({ status: 200, body: okPage([record("Devcon 8")]) }),
        capabilities: {
          adapterSource:
            'import fs from "node:fs";\nexport function parseDocument() { return { records: [] }; }\n',
        },
      });
      const installed = yield* harness.service.installSource({
        environmentId: env,
        spec: spec(),
        now: 1_000,
      });
      assert.equal(installed.status, "refused");
      assert.match(installed.status === "refused" ? installed.reason : "", /node:fs/);
    }),
  );

  it.effect("refuses captures for hosts outside the allowlist and URLs that redirect", () =>
    Effect.gen(function* () {
      yield* createRevisionsTable;
      yield* createAdapterSourcesTable;
      const env = envFor("allowlist");
      const allowed = yield* makeHarness({
        transport: transportFor({ status: 200, body: okPage([record("Devcon 8")]) }),
      });
      yield* allowed.service.installSource({ environmentId: env, spec: spec(), now: 1_000 });
      const offAllowlist = yield* makeHarness({
        hosts: "other.org",
        transport: transportFor({ status: 200, body: okPage([record("Devcon 8")]) }),
      });
      yield* offAllowlist.service.installSource({
        environmentId: env,
        spec: spec({ sourceId: "off-host" }),
        now: 1_000,
      });
      const refused = expectUnavailable(
        yield* offAllowlist.service.captureLatest({
          environmentId: env,
          sourceId: "off-host",
          now: 2_000,
        }),
      );
      assert.match(refused.reason, /not on the generated-source allowlist/);

      const redirect = yield* makeHarness({
        transport: transportFor({
          status: 302,
          headers: { location: "https://elsewhere.example/" },
          body: "",
        }),
      });
      yield* redirect.service.installSource({
        environmentId: env,
        spec: spec({ sourceId: "redirected" }),
        now: 1_000,
      });
      const redirected = expectUnavailable(
        yield* redirect.service.captureLatest({
          environmentId: env,
          sourceId: "redirected",
          now: 2_000,
        }),
      );
      assert.match(redirected.reason, /redirects are refused/);
    }),
  );

  it.effect(
    "refuses a capture inside the minimum interval and non-200/empty/oversized responses",
    () =>
      Effect.gen(function* () {
        yield* createRevisionsTable;
        yield* createAdapterSourcesTable;
        const env = envFor("policy");
        const harness = yield* makeHarness({
          transport: transportFor({ status: 200, body: okPage([record("Devcon 8")]) }),
        });
        yield* harness.service.installSource({ environmentId: env, spec: spec(), now: 1_000 });
        const first = expectOk(
          yield* harness.service.captureLatest({
            environmentId: env,
            sourceId: "devcon-calendar",
            now: 10_000,
          }),
        );
        assert.equal(first.documents.length, 1);
        const early = expectUnavailable(
          yield* harness.service.captureLatest({
            environmentId: env,
            sourceId: "devcon-calendar",
            now: 10_500,
          }),
        );
        assert.match(early.reason, /capture policy refuses/);

        const badStatus = yield* makeHarness({
          transport: transportFor({ status: 500, body: "oops" }),
        });
        yield* badStatus.service.installSource({
          environmentId: env,
          spec: spec({ sourceId: "status" }),
          now: 1_000,
        });
        assert.match(
          expectUnavailable(
            yield* badStatus.service.captureLatest({
              environmentId: env,
              sourceId: "status",
              now: 2_000,
            }),
          ).reason,
          /HTTP 500/,
        );

        const empty = yield* makeHarness({ transport: transportFor({ status: 200, body: null }) });
        yield* empty.service.installSource({
          environmentId: env,
          spec: spec({ sourceId: "empty" }),
          now: 1_000,
        });
        assert.match(
          expectUnavailable(
            yield* empty.service.captureLatest({
              environmentId: env,
              sourceId: "empty",
              now: 2_000,
            }),
          ).reason,
          /empty body/,
        );

        const oversized = yield* makeHarness({
          transport: transportFor({ status: 200, body: "x".repeat(70_000) }),
        });
        yield* oversized.service.installSource({
          environmentId: env,
          spec: spec({
            sourceId: "big",
            capturePolicy: { minIntervalMs: 1, maxDocumentBytes: 1_024 },
          }),
          now: 1_000,
        });
        assert.match(
          expectUnavailable(
            yield* oversized.service.captureLatest({
              environmentId: env,
              sourceId: "big",
              now: 2_000,
            }),
          ).reason,
          /over the 1024-byte cap/,
        );
      }),
  );

  it.effect("capture writes honest revisions with corrections, no-ops, and retractions", () =>
    Effect.gen(function* () {
      yield* createRevisionsTable;
      yield* createAdapterSourcesTable;
      const env = envFor("revisions");
      const harness = yield* makeHarness({
        transport: transportFor({
          status: 200,
          body: okPage([record("Devcon 7"), record("Devcon 8")]),
        }),
      });
      yield* harness.service.installSource({ environmentId: env, spec: spec(), now: 1_000 });
      const first = expectOk(
        yield* harness.service.captureLatest({
          environmentId: env,
          sourceId: "devcon-calendar",
          now: 10_000,
        }),
      );
      assert.equal(first.documents.length, 2);
      const devcon8 = first.documents.find((document) =>
        document.documentIdentity.includes("Devcon 8"),
      )!;
      assert.equal(devcon8.changed, true);
      assert.equal(devcon8.manifest.providerKind, "generated:devcon-calendar");
      assert.equal(devcon8.manifest.publishedAtMs, Date.parse("2026-08-01T00:00:00Z"));
      assert.equal(devcon8.manifest.timePrecision, "day");
      assert.equal(devcon8.manifest.sourceUrl, URL);

      // Identical content: a no-op with the same revision id.
      const same = expectOk(
        yield* harness.service.captureLatest({
          environmentId: env,
          sourceId: "devcon-calendar",
          now: 80_000,
        }),
      );
      const sameDevcon8 = same.documents.find((document) =>
        document.documentIdentity.includes("Devcon 8"),
      )!;
      assert.equal(sameDevcon8.changed, false);
      assert.equal(sameDevcon8.revisionId, devcon8.revisionId);

      // A corrected date and a vanished edition: correction + retraction.
      const updated = yield* makeHarness({
        transport: transportFor({
          status: 200,
          body: okPage([record("Devcon 8", { startDate: "2026-11-04" })]),
        }),
      });
      // The second harness re-creates its own fakes but shares the store.
      const corrected = expectOk(
        yield* (yield* makeHarness({
          transport: transportFor({
            status: 200,
            body: okPage([record("Devcon 8", { startDate: "2026-11-04" })]),
          }),
        })).service.captureLatest({
          environmentId: env,
          sourceId: "devcon-calendar",
          now: 200_000,
        }),
      );
      void updated;
      const correctedDevcon8 = corrected.documents.find((document) =>
        document.documentIdentity.includes("Devcon 8"),
      )!;
      assert.equal(correctedDevcon8.changed, true);
      assert.notEqual(correctedDevcon8.revisionId, devcon8.revisionId);
      const retracted = corrected.documents.find((document) =>
        document.documentIdentity.includes("Devcon 7"),
      )!;
      assert.equal(retracted.retracted, true);
      assert.equal(retracted.changed, true);

      // Store chain: the correction links through correctionOf; the retraction
      // is a row with retracted set, never a destructive edit.
      const history = yield* harness.store.history({
        environmentId: env,
        sourceKind: "generated:devcon-calendar",
        documentIdentity: "devcon-calendar:devcon-edition:Devcon 8",
      });
      assert.equal(history.length, 2);
      assert.equal(history[1]?.correctionOf, history[0]?.revisionId);
      const vanishedHistory = yield* harness.store.history({
        environmentId: env,
        sourceKind: "generated:devcon-calendar",
        documentIdentity: "devcon-calendar:devcon-edition:Devcon 7",
      });
      assert.equal(vanishedHistory.length, 2);
      assert.equal(vanishedHistory[1]?.retracted, true);
    }),
  );

  it.effect(
    "the sandbox envelope carries the exact bytes and never the credential; schema failures refuse wholly",
    () =>
      Effect.gen(function* () {
        yield* createRevisionsTable;
        yield* createAdapterSourcesTable;
        const env = envFor("credential");
        const harness = yield* makeHarness({
          transport: transportFor({ status: 200, body: okPage([record("Devcon 8")]) }),
        });
        process.env.T3_TEST_CAL_CREDENTIAL = "secret-token-value";
        yield* harness.service.installSource({
          environmentId: env,
          spec: spec({ sourceId: "cred", credentialEnvName: "T3_TEST_CAL_CREDENTIAL" }),
          now: 1_000,
        });
        const capture = expectOk(
          yield* harness.service.captureLatest({
            environmentId: env,
            sourceId: "cred",
            now: 2_000,
          }),
        );
        assert.equal(capture.documents.length, 1);
        const envelope = harness.envelopes[0]!;
        assert.equal(
          Buffer.from(envelope.bodyBase64, "base64").toString("utf8"),
          okPage([record("Devcon 8")]),
        );
        // Serialized through the house codec; the credential must not appear.
        assert.equal(toJsonText(envelope).includes("secret-token-value"), false);

        // A record that fails the declared schema refuses the whole capture.
        const invalid = yield* makeHarness({
          transport: transportFor({
            status: 200,
            body: okPage([
              {
                name: "Broken",
                startDate: "not-a-date",
                endDate: "2026-11-06",
                url: "https://devcon.org/",
              },
            ]),
          }),
          parse: {
            recordsFor: () => [
              {
                name: "Broken",
                startDate: "not-a-date",
                endDate: "2026-11-06",
                url: "https://devcon.org/",
              },
            ],
          },
        });
        yield* invalid.service.installSource({
          environmentId: env,
          spec: spec({ sourceId: "broken" }),
          now: 1_000,
        });
        const refused = expectUnavailable(
          yield* invalid.service.captureLatest({
            environmentId: env,
            sourceId: "broken",
            now: 2_000,
          }),
        );
        assert.match(refused.reason, /schema validation/);
        const documents = yield* harness.store.listDocuments({
          environmentId: env,
          sourceKind: "generated:broken",
        });
        assert.equal(documents.length, 0);
        delete process.env.T3_TEST_CAL_CREDENTIAL;
      }),
  );

  it.effect("a failing contained parse is a named unavailable state with a redacted reason", () =>
    Effect.gen(function* () {
      yield* createRevisionsTable;
      yield* createAdapterSourcesTable;
      const env = envFor("sandboxfail");
      const harness = yield* makeHarness({
        transport: transportFor({ status: 200, body: okPage([record("Devcon 8")]) }),
        parse: { failWith: "adapter exploded" },
      });
      process.env.T3_TEST_CAL_CREDENTIAL2 = "secret-token-value";
      yield* harness.service.installSource({
        environmentId: env,
        spec: spec({ sourceId: "fails", credentialEnvName: "T3_TEST_CAL_CREDENTIAL2" }),
        now: 1_000,
      });
      // The fake sandbox fails with a plain error; the service surfaces its
      // message and redacts any credential bytes.
      const refused = expectUnavailable(
        yield* harness.service.captureLatest({ environmentId: env, sourceId: "fails", now: 2_000 }),
      );
      assert.match(refused.reason, /generated transform failed in containment/);
      assert.equal(refused.reason.includes("secret-token-value"), false);
      delete process.env.T3_TEST_CAL_CREDENTIAL2;
    }),
  );
});

// The SqlClient import is used by the migrations through the layer; keep the
// reference explicit so the import is not tree-shaken in typecheck.
void SqlClient;
void Context;
