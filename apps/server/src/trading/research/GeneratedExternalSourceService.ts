/**
 * GeneratedExternalSourceService — the host boundary for AGENT-GENERATED
 * external-source adapters.
 *
 * Where ExternalSourceConnector is one hardcoded host connector
 * (github-releases), this service runs any adapter an in-app agent authored
 * through the capability-builder flow and the store installed by CAS. The
 * division of labor is absolute:
 *
 * - The HOST performs every network I/O: the spec's URL must parse https and
 *   sit on the host-configured exact-host allowlist; the optional credential
 *   is read from its named env var by the host and injected as one
 *   `Authorization: Bearer` header — never into generated code, never into a
 *   URL, never into a log line (every reason passes through `redact`).
 * - The GENERATED TRANSFORM (the capability's declared optional `transform`
 *   artifact at `transform.ts` — the exact artifact the frozen
 *   ExternalAdapterSourceSpec's `transformRef` points at) runs network-less
 *   inside the sealed sandbox under the `forge-parse-v2` runner head:
 *   document bytes in (base64 over stdin, the container has no network at
 *   all), parsed records out (JSON stdout under the standard output cap). It
 *   receives no credential and no socket and may import nothing but the host
 *   SDK (./sdk), so the parse run's staged file set is self-contained.
 * - The HOST validates every parsed record against the spec's declared event
 *   schema (exact field set, declared types, required fields) before anything
 *   is persisted; an over-cap or invalid record set refuses the WHOLE capture
 *   — never a partial parse.
 * - Revisions land in the EXISTING ExternalSourceStore with sourceKind
 *   `generated:<sourceId>`: content-derived ids, corrections through
 *   `correctionOf`, records that disappeared from the latest snapshot become
 *   retraction rows, `firstObservedAtMs` written only on first sighting.
 *   `publishedAtMs` is filled ONLY from the record's own declared
 *   publication field, and its declared type decides the honest
 *   `timePrecision` — nothing is ever invented.
 *
 * Nothing here can reach a signer, Hyperliquid, or an order. Failures are
 * named `unavailable` states; only genuine persistence failures stay in the
 * error channel.
 *
 * The spec/record contract shapes come from the ratified
 * `ExternalAdapterSourceSpec` contract in packages/trading-contracts
 * (researchEvidence.ts); the host validation below stays here and is
 * deliberately stricter than the contract where the product needs it
 * (sourceId vocabulary, field-count cap, safe-integer bounds).
 *
 * @module GeneratedExternalSourceService
 */
// @effect-diagnostics preferSchemaOverJson:off - payload_json here is the storage codec the store already uses; schemas validate the shapes that cross boundaries.
// @effect-diagnostics tryCatchInEffectGen:off - the URL-parse refusal is a host verdict (a named unavailable state), not an exception to recover; try/catch states that exactly.
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Schema } from "effect";
import * as Layer from "effect/Layer";
import * as NodeCrypto from "node:crypto";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ExternalSourceManifest } from "@t3tools/trading-contracts";
import type {
  ExternalAdapterCapturePolicy,
  ExternalAdapterEventSchema,
  ExternalAdapterFieldSchema,
  ExternalAdapterSourceSpec,
} from "@t3tools/trading-contracts";

import { toPersistenceSqlError, type PersistenceSqlError } from "../../persistence/Errors.ts";
import {
  ExternalSourceStore,
  toManifest,
  type ExternalSourceRevision,
} from "./ExternalSourceStore.ts";
import { ExternalSourceTransport } from "./ExternalSourceConnector.ts";
import { FORGE_SDK_SOURCE_V2, declaredImports } from "../forge/CapabilityBuilder.ts";
import { ForgeCapabilitySandbox } from "../forge/CapabilitySandbox.ts";
import { ForgeCapabilityStore } from "../forge/CapabilityStore.ts";

// ---------------------------------------------------------------------------
// The contract shapes (ratified in trading-contracts researchEvidence.ts)
// ---------------------------------------------------------------------------

// Re-exported so existing importers keep one swap point; the shapes are the
// contract's own Schema types now, not local mirrors.
export type {
  ExternalAdapterCapturePolicy,
  ExternalAdapterEventSchema,
  ExternalAdapterFieldSchema,
  ExternalAdapterSourceSpec,
};

/** The runner-head argv the pinned image exposes for source-adapter parses. */
export const FORGE_RUNNER_PARSE_V2 = ["forge-parse-v2"] as const;

/** The one document precision vocabulary the external-source rows accept. */
type DocumentTimePrecision = "instant" | "window" | "date";

const FIELD_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const RECORD_KIND_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const SOURCE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CREDENTIAL_ENV_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const SHA256_PATTERN = /^[0-9a-fA-F]{64}$/;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** The most parsed records one capture may write; over this refuses wholly. */
export const MAX_RECORDS_PER_CAPTURE = 200;

/** The byte ceiling for the sandbox document envelope's base64 payload. */
const MAX_BODY_BYTES = 1_048_576;

// ---------------------------------------------------------------------------
// Spec validation (pure)
// ---------------------------------------------------------------------------

export type SpecValidation =
  | { readonly ok: true; readonly spec: ExternalAdapterSourceSpec }
  | { readonly ok: false; readonly reason: string };

/** Validate an adapter spec against the closed contract. Pure, total. */
export function validateExternalAdapterSourceSpec(value: unknown): SpecValidation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, reason: "spec is not a JSON object" };
  }
  const record = value as Record<string, unknown>;
  const sourceId = record["sourceId"];
  if (typeof sourceId !== "string" || !SOURCE_ID_PATTERN.test(sourceId)) {
    return { ok: false, reason: "sourceId must match ^[a-z0-9][a-z0-9-]{0,63}$" };
  }
  if (record["kind"] !== "http-document") {
    return { ok: false, reason: 'kind must be "http-document"' };
  }
  const url = record["url"];
  if (typeof url !== "string" || !/^https:\/\/[^\s]+$/.test(url)) {
    return { ok: false, reason: "url must be an https URL with no whitespace" };
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return { ok: false, reason: "url does not parse" };
  }
  if (parsedUrl.username !== "" || parsedUrl.password !== "") {
    return { ok: false, reason: "url must not carry embedded credentials" };
  }
  if (record["method"] !== "GET") {
    return { ok: false, reason: 'method must be "GET"' };
  }
  const credentialEnvName = record["credentialEnvName"];
  if (
    credentialEnvName !== null &&
    (typeof credentialEnvName !== "string" || !CREDENTIAL_ENV_PATTERN.test(credentialEnvName))
  ) {
    return { ok: false, reason: "credentialEnvName must be null or match ^[A-Z][A-Z0-9_]{0,63}$" };
  }
  const transformRef = record["transformRef"];
  if (typeof transformRef !== "object" || transformRef === null || Array.isArray(transformRef)) {
    return { ok: false, reason: "transformRef is not an object" };
  }
  const transform = transformRef as Record<string, unknown>;
  const capabilityId = transform["capabilityId"];
  if (typeof capabilityId !== "string" || capabilityId.trim() === "") {
    return { ok: false, reason: "transformRef.capabilityId must be a non-empty string" };
  }
  const version = transform["version"];
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version <= 0) {
    return { ok: false, reason: "transformRef.version must be a positive safe integer" };
  }
  const bundleSha256 = transform["bundleSha256"];
  if (typeof bundleSha256 !== "string" || !SHA256_PATTERN.test(bundleSha256)) {
    return { ok: false, reason: "transformRef.bundleSha256 must be a 64-hex sha256" };
  }
  const schemaValue = record["outputEventSchema"];
  if (typeof schemaValue !== "object" || schemaValue === null || Array.isArray(schemaValue)) {
    return { ok: false, reason: "outputEventSchema is not an object" };
  }
  const schema = schemaValue as Record<string, unknown>;
  const recordKind = schema["recordKind"];
  if (typeof recordKind !== "string" || !RECORD_KIND_PATTERN.test(recordKind)) {
    return { ok: false, reason: "outputEventSchema.recordKind must match ^[a-z][a-z0-9-]{0,63}$" };
  }
  const fieldsValue = schema["fields"];
  if (!Array.isArray(fieldsValue) || fieldsValue.length === 0 || fieldsValue.length > 64) {
    return { ok: false, reason: "outputEventSchema.fields must hold 1..64 fields" };
  }
  const fields: Array<ExternalAdapterFieldSchema> = [];
  const seenNames = new Set<string>();
  for (const entry of fieldsValue) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return { ok: false, reason: "outputEventSchema.fields entries must be objects" };
    }
    const field = entry as Record<string, unknown>;
    const name = field["name"];
    if (typeof name !== "string" || !FIELD_NAME_PATTERN.test(name)) {
      return {
        ok: false,
        reason: `field name ${JSON.stringify(name)} must match ^[A-Za-z][A-Za-z0-9_]{0,63}$`,
      };
    }
    if (seenNames.has(name)) return { ok: false, reason: `duplicate field name ${name}` };
    seenNames.add(name);
    const type = field["type"];
    if (
      type !== "text" &&
      type !== "url" &&
      type !== "iso8601-instant" &&
      type !== "iso8601-date" &&
      type !== "integer"
    ) {
      return { ok: false, reason: `field ${name} has unknown type ${JSON.stringify(type)}` };
    }
    if (typeof field["required"] !== "boolean") {
      return { ok: false, reason: `field ${name} must declare required as a boolean` };
    }
    fields.push({ name, type, required: field["required"] });
  }
  const identityField = schema["identityField"];
  if (typeof identityField !== "string" || !seenNames.has(identityField)) {
    return { ok: false, reason: "identityField must name a declared field" };
  }
  const identitySchema = fields.find((field) => field.name === identityField);
  if (identitySchema === undefined || identitySchema.type !== "text" || !identitySchema.required) {
    return { ok: false, reason: "identityField must be a required text field" };
  }
  const publishedAtField = schema["publishedAtField"];
  if (publishedAtField !== null) {
    if (typeof publishedAtField !== "string" || !seenNames.has(publishedAtField)) {
      return { ok: false, reason: "publishedAtField must be null or name a declared field" };
    }
    const publishedSchema = fields.find((field) => field.name === publishedAtField);
    if (
      publishedSchema === undefined ||
      (publishedSchema.type !== "iso8601-instant" && publishedSchema.type !== "iso8601-date")
    ) {
      return {
        ok: false,
        reason: "publishedAtField must be an iso8601-instant or iso8601-date field",
      };
    }
  }
  const policyValue = record["capturePolicy"];
  if (typeof policyValue !== "object" || policyValue === null || Array.isArray(policyValue)) {
    return { ok: false, reason: "capturePolicy is not an object" };
  }
  const policy = policyValue as Record<string, unknown>;
  const minIntervalMs = policy["minIntervalMs"];
  if (
    typeof minIntervalMs !== "number" ||
    !Number.isSafeInteger(minIntervalMs) ||
    minIntervalMs <= 0
  ) {
    return { ok: false, reason: "capturePolicy.minIntervalMs must be a positive safe integer" };
  }
  const maxDocumentBytes = policy["maxDocumentBytes"];
  if (
    typeof maxDocumentBytes !== "number" ||
    !Number.isSafeInteger(maxDocumentBytes) ||
    maxDocumentBytes < 1 ||
    maxDocumentBytes > MAX_BODY_BYTES
  ) {
    return { ok: false, reason: `capturePolicy.maxDocumentBytes must be 1..${MAX_BODY_BYTES}` };
  }
  return {
    ok: true,
    spec: {
      sourceId,
      kind: "http-document",
      url,
      method: "GET",
      credentialEnvName,
      transformRef: { capabilityId, version, bundleSha256 },
      outputEventSchema: { recordKind, identityField, publishedAtField, fields },
      capturePolicy: { minIntervalMs, maxDocumentBytes },
    },
  };
}

// ---------------------------------------------------------------------------
// Record validation against the declared schema (pure)
// ---------------------------------------------------------------------------

const isoInstantToMs = (value: string): number | null => {
  if (!ISO_INSTANT_PATTERN.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

const isoDateToMs = (value: string): number | null => {
  if (!ISO_DATE_PATTERN.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : null;
};

export type ValidatedRecord = {
  /** Canonical serialization: declared fields, declared order, absent → null. */
  readonly canonical: string;
  readonly identityValue: string;
  readonly publishedAtMs: number | null;
  readonly timePrecision: DocumentTimePrecision;
};

export function validateRecordAgainstSchema(
  value: unknown,
  schema: ExternalAdapterEventSchema,
): ValidatedRecord | string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "record is not a JSON object";
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!schema.fields.some((field) => field.name === key)) {
      return `record carries undeclared field ${JSON.stringify(key)}`;
    }
  }
  const canonicalRecord: Record<string, unknown> = {};
  for (const field of schema.fields) {
    const raw = record[field.name];
    if (raw === undefined || raw === null) {
      if (field.required) return `required field ${field.name} is missing`;
      canonicalRecord[field.name] = null;
      continue;
    }
    switch (field.type) {
      case "text":
        if (typeof raw !== "string" || raw === "") {
          return `field ${field.name} must be a non-empty string`;
        }
        canonicalRecord[field.name] = raw;
        break;
      case "url":
        if (typeof raw !== "string" || !/^https?:\/\/[^\s]+$/.test(raw)) {
          return `field ${field.name} must be an http(s) URL string`;
        }
        canonicalRecord[field.name] = raw;
        break;
      case "iso8601-instant":
        if (isoInstantToMs(String(raw)) === null || typeof raw !== "string") {
          return `field ${field.name} must be a second-precision UTC ISO instant (YYYY-MM-DDTHH:MM:SSZ)`;
        }
        canonicalRecord[field.name] = raw;
        break;
      case "iso8601-date":
        if (typeof raw !== "string" || isoDateToMs(raw) === null) {
          return `field ${field.name} must be a UTC ISO date (YYYY-MM-DD)`;
        }
        canonicalRecord[field.name] = raw;
        break;
      case "integer": {
        if (typeof raw === "number") {
          if (!Number.isSafeInteger(raw)) return `field ${field.name} is not a safe integer`;
          canonicalRecord[field.name] = String(raw);
          break;
        }
        if (typeof raw !== "string" || !/^-?\d+$/.test(raw)) {
          return `field ${field.name} must be an integer (safe number or decimal string)`;
        }
        canonicalRecord[field.name] = raw;
        break;
      }
    }
  }
  const identityValue = canonicalRecord[schema.identityField];
  if (typeof identityValue !== "string") return "identity value is not a string";
  let publishedAtMs: number | null = null;
  let timePrecision: DocumentTimePrecision = "instant";
  if (schema.publishedAtField !== null) {
    const declared = canonicalRecord[schema.publishedAtField];
    if (typeof declared === "string" && declared !== "") {
      const field = schema.fields.find((entry) => entry.name === schema.publishedAtField);
      if (field?.type === "iso8601-date") {
        publishedAtMs = isoDateToMs(declared);
        timePrecision = "date";
      } else {
        publishedAtMs = isoInstantToMs(declared);
        timePrecision = "instant";
      }
    }
  }
  return {
    canonical: JSON.stringify(canonicalRecord),
    identityValue,
    publishedAtMs,
    timePrecision,
  };
}

// ---------------------------------------------------------------------------
// Host configuration: the URL allowlist
// ---------------------------------------------------------------------------

/** Read variable NAMES only; values are never logged. */
export interface GeneratedSourceAllowlistSettings {
  /** Exact lowercase hostnames the host may fetch from. Empty = refuse all. */
  readonly hosts: ReadonlySet<string>;
}

export const resolveGeneratedSourceAllowlist = (
  env: Record<string, string | undefined>,
): GeneratedSourceAllowlistSettings => {
  const raw = env.T3_GENERATED_SOURCE_HOSTS ?? "";
  const hosts = new Set(
    raw
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter((host) => host !== "" && /^[a-z0-9.*-]+$/.test(host)),
  );
  return { hosts };
};

export class GeneratedExternalSourceConfig extends Context.Service<
  GeneratedExternalSourceConfig,
  GeneratedSourceAllowlistSettings
>()("t3/trading/research/GeneratedExternalSourceService/GeneratedExternalSourceConfig") {}

export const GeneratedExternalSourceConfigLive = Layer.effect(
  GeneratedExternalSourceConfig,
  Effect.sync(() => resolveGeneratedSourceAllowlist(process.env)),
);

// ---------------------------------------------------------------------------
// Failures and the service contract
// ---------------------------------------------------------------------------

export class GeneratedExternalSourceError extends Data.TaggedError("GeneratedExternalSourceError")<{
  readonly operation: string;
  readonly reason: string;
}> {}

export type GeneratedSourceCapture =
  | {
      readonly status: "ok";
      readonly documents: ReadonlyArray<{
        readonly documentIdentity: string;
        readonly revisionId: string;
        readonly changed: boolean;
        readonly retracted: boolean;
        readonly manifest: ExternalSourceManifest;
      }>;
    }
  | { readonly status: "unavailable"; readonly reason: string };

export interface GeneratedExternalSourceServiceShape {
  /**
   * Install (or replace) one adapter source spec. The transformRef must
   * resolve to the environment's ACTIVE installed capability version with a
   * matching bundle hash and a non-empty `transform.ts` artifact whose
   * imports are limited to the host SDK (./sdk). Refusals are values;
   * persistence failures
   * are errors.
   */
  readonly installSource: (input: {
    readonly environmentId: string;
    readonly spec: unknown;
    readonly now: number;
  }) => Effect.Effect<
    { readonly status: "ok" } | { readonly status: "refused"; readonly reason: string },
    PersistenceSqlError
  >;
  /** One bounded capture against the installed spec. Never throws. */
  readonly captureLatest: (input: {
    readonly environmentId: string;
    readonly sourceId: string;
    readonly now: number;
  }) => Effect.Effect<GeneratedSourceCapture, PersistenceSqlError>;
}

export class GeneratedExternalSourceService extends Context.Service<
  GeneratedExternalSourceService,
  GeneratedExternalSourceServiceShape
>()("t3/trading/research/GeneratedExternalSourceService") {}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const sqlFail = (operation: string) =>
  toPersistenceSqlError(`GeneratedExternalSourceService.${operation}`);

const sha256Hex = (value: string): string =>
  NodeCrypto.createHash("sha256").update(value, "utf8").digest("hex");

// encodeSync/decodeSync stay inside these module-level (non-generator)
// helpers — the repo lint rule.
const encodeJsonText = (value: unknown): string =>
  Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(value);

const decodeJsonText = (text: string): unknown =>
  Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))(text);

const redact = (message: string, secret: string | undefined): string =>
  secret === undefined || secret === "" ? message : message.split(secret).join("[redacted]");

const sourceKindFor = (sourceId: string): string => `generated:${sourceId}`;

const deriveRevisionId = (input: {
  readonly environmentId: string;
  readonly documentIdentity: string;
  readonly contentSha256: string;
  readonly firstObservedAtMs: number;
}): string =>
  `extrev_${sha256Hex(
    `${input.environmentId}\n${input.documentIdentity}\n${input.contentSha256}\n${input.firstObservedAtMs}`,
  )}`;

interface InstalledSpecRow {
  readonly spec_json: string;
}

interface AdapterSpecRecord {
  readonly environmentId: string;
  readonly sourceId: string;
  readonly spec: ExternalAdapterSourceSpec;
}

/** The sandbox document envelope for the forge-parse-v2 head. */
export interface AdapterParseEnvelope {
  readonly schemaVersion: 1;
  readonly sourceId: string;
  readonly url: string;
  readonly contentType: string;
  readonly capturedAtMs: number;
  readonly bodyBase64: string;
}

/** Structural decoder for the head's stdout; per-record checks follow in-host. */
const decodeAdapterParseOutput = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("adapter output must be a JSON object");
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record["records"])) {
    throw new Error("adapter output must carry a records array");
  }
  return value;
};

export const makeGeneratedExternalSourceService = Effect.gen(function* () {
  const transport = yield* ExternalSourceTransport;
  const revisions = yield* ExternalSourceStore;
  const sandbox = yield* ForgeCapabilitySandbox;
  const capabilities = yield* ForgeCapabilityStore;
  const sql = yield* SqlClient.SqlClient;
  const allowlist = yield* GeneratedExternalSourceConfig;

  const unavailable = (reason: string): GeneratedSourceCapture => ({
    status: "unavailable",
    reason,
  });

  /** Load and re-validate the installed spec for one source. */
  const loadSpec = (
    environmentId: string,
    sourceId: string,
  ): Effect.Effect<AdapterSpecRecord | null, PersistenceSqlError> =>
    sql<InstalledSpecRow>`
      SELECT spec_json FROM external_adapter_sources
      WHERE environment_id = ${environmentId} AND source_id = ${sourceId}
    `.pipe(
      Effect.mapError(sqlFail("loadSpec")),
      Effect.map((rows): AdapterSpecRecord | null => {
        const row = rows[0];
        if (row === undefined) return null;
        const validated = validateExternalAdapterSourceSpec(
          Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))(row.spec_json),
        );
        // A row this server wrote was valid at install time; a row that no
        // longer validates is corrupt and treated as absent (fail closed).
        if (!validated.ok) return null;
        return { environmentId, sourceId, spec: validated.spec };
      }),
    );

  /**
   * Resolve the pinned transform: the environment's ACTIVE installed version
   * must match the spec's transformRef exactly (version AND bundle hash), and
   * its declared `transform` artifact (transform.ts) must be present,
   * non-empty, and import nothing outside the host SDK.
   */
  const resolveTransform = (
    environmentId: string,
    spec: ExternalAdapterSourceSpec,
    credential: string | undefined,
  ): Effect.Effect<
    | { readonly ok: true; readonly transformSource: string }
    | { readonly ok: false; readonly reason: string },
    PersistenceSqlError
  > =>
    Effect.gen(function* () {
      const active = yield* capabilities
        .activeState({ environmentId, capabilityId: spec.transformRef.capabilityId })
        .pipe(Effect.mapError(sqlFail("resolveTransform")));
      if (active === null) {
        return {
          ok: false,
          reason: `transform capability ${spec.transformRef.capabilityId} is not installed`,
        };
      }
      if (
        active.version !== spec.transformRef.version ||
        active.bundleSha256 !== spec.transformRef.bundleSha256
      ) {
        return {
          ok: false,
          reason: redact(
            `transform capability ${spec.transformRef.capabilityId} active version is v${active.version} bundle ${active.bundleSha256.slice(0, 12)}, the spec pins v${spec.transformRef.version} bundle ${spec.transformRef.bundleSha256.slice(0, 12)}`,
            credential,
          ),
        };
      }
      const artifact = yield* capabilities
        .readArtifact({
          environmentId,
          capabilityId: spec.transformRef.capabilityId,
          version: spec.transformRef.version,
          path: "transform.ts",
        })
        .pipe(Effect.mapError(sqlFail("resolveTransform")));
      if (artifact === null || artifact.trim() === "") {
        return {
          ok: false,
          reason: redact(
            `transform capability v${spec.transformRef.version} has no transform.ts artifact`,
            credential,
          ),
        };
      }
      for (const specifier of declaredImports(artifact)) {
        if (specifier !== "./sdk") {
          return {
            ok: false,
            reason: redact(
              `transform.ts imports ${JSON.stringify(specifier)}; only the host SDK (./sdk) is allowed`,
              credential,
            ),
          };
        }
      }
      return { ok: true, transformSource: artifact };
    });

  const installSource: GeneratedExternalSourceServiceShape["installSource"] = ({
    environmentId,
    spec,
    now,
  }) =>
    Effect.gen(function* () {
      const validated = validateExternalAdapterSourceSpec(spec);
      if (!validated.ok) {
        return { status: "refused" as const, reason: validated.reason };
      }
      // Refuse at install when the pinned transform is not resolvable — an
      // unresolvable spec can never capture anything honestly.
      const resolved = yield* resolveTransform(environmentId, validated.spec, undefined);
      if (!resolved.ok) {
        return {
          status: "refused" as const,
          reason: `the pinned transform is not usable: ${resolved.reason}`,
        };
      }
      const specJson = encodeJsonText(validated.spec);
      yield* sql`
        INSERT INTO external_adapter_sources (
          environment_id, source_id, spec_json, spec_sha256, installed_at_ms, updated_at_ms
        ) VALUES (
          ${environmentId}, ${validated.spec.sourceId}, ${specJson}, ${sha256Hex(specJson)}, ${now}, ${now}
        )
        ON CONFLICT (environment_id, source_id) DO UPDATE SET
          spec_json = excluded.spec_json,
          spec_sha256 = excluded.spec_sha256,
          updated_at_ms = excluded.updated_at_ms
      `.pipe(Effect.asVoid, Effect.mapError(sqlFail("installSource")));
      return { status: "ok" as const };
    });

  const captureLatest: GeneratedExternalSourceServiceShape["captureLatest"] = ({
    environmentId,
    sourceId,
    now,
  }) =>
    Effect.gen(function* () {
      const loaded = yield* loadSpec(environmentId, sourceId);
      if (loaded === null) {
        return unavailable(
          `no generated source ${JSON.stringify(sourceId)} is installed for this environment`,
        );
      }
      const spec = loaded.spec;
      const credential =
        spec.credentialEnvName === null ? undefined : process.env[spec.credentialEnvName]?.trim();

      // --- URL allowlist: exact host match against host configuration -------
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(spec.url);
      } catch {
        return unavailable("the installed spec url does not parse");
      }
      if (!allowlist.hosts.has(parsedUrl.hostname.toLowerCase())) {
        return unavailable(
          `host ${parsedUrl.hostname} is not on the generated-source allowlist (T3_GENERATED_SOURCE_HOSTS)`,
        );
      }

      // --- capture policy: minimum interval since the last capture ----------
      const lastCapture = yield* sql<{ readonly last: number | null }>`
        SELECT MAX(capture_ms) AS last FROM external_source_revisions
        WHERE environment_id = ${environmentId} AND source_kind = ${sourceKindFor(sourceId)}
      `.pipe(Effect.mapError(sqlFail("captureLatest")));
      const lastMs = lastCapture[0]?.last ?? null;
      if (lastMs !== null && now - lastMs < spec.capturePolicy.minIntervalMs) {
        return unavailable(
          `capture policy refuses: only ${now - lastMs}ms since the last capture, minimum interval is ${spec.capturePolicy.minIntervalMs}ms`,
        );
      }

      // --- transform resolution: pinned version, pinned bundle bytes --------
      const resolved = yield* resolveTransform(environmentId, spec, credential);
      if (!resolved.ok) return unavailable(resolved.reason);

      // --- the one host-side fetch ------------------------------------------
      const headers: Record<string, string> = { accept: "*/*" };
      if (credential !== undefined && credential !== "") {
        headers["authorization"] = `Bearer ${credential}`;
      }
      const fetched = yield* transport.get({ url: spec.url, headers }).pipe(
        Effect.map((response) => ({ ok: true as const, response })),
        Effect.catch((cause) =>
          Effect.succeed({
            ok: false as const,
            capture: unavailable(redact(`generated source fetch failed: ${cause}`, credential)),
          }),
        ),
      );
      if (!fetched.ok) return fetched.capture;
      const response = fetched.response;
      if (response.status >= 300 && response.status < 400) {
        return unavailable(
          `generated source endpoint answered HTTP ${response.status}; redirects are refused, never followed`,
        );
      }
      if (response.status !== 200) {
        return unavailable(
          redact(`generated source endpoint answered HTTP ${response.status}`, credential),
        );
      }
      if (response.bodyBytes === null || response.bodyBytes.byteLength === 0) {
        return unavailable("generated source response had an empty body");
      }
      if (response.bodyBytes.byteLength > spec.capturePolicy.maxDocumentBytes) {
        return unavailable(
          `generated source document is ${response.bodyBytes.byteLength} bytes, over the ${spec.capturePolicy.maxDocumentBytes}-byte cap`,
        );
      }

      // --- sandbox parse: bytes in, records out, network-less ---------------
      const contentType = (() => {
        for (const [name, value] of Object.entries(response.headers)) {
          if (name.toLowerCase() === "content-type") return value;
        }
        return "";
      })();
      const envelope: AdapterParseEnvelope = {
        schemaVersion: 1,
        sourceId,
        url: spec.url,
        contentType,
        capturedAtMs: now,
        bodyBase64: Buffer.from(response.bodyBytes).toString("base64"),
      };
      const parsed = yield* sandbox
        .runEvaluation({
          files: [
            { path: "sdk.ts", content: FORGE_SDK_SOURCE_V2 },
            { path: "transform.ts", content: resolved.transformSource },
          ],
          entrypoint: [...FORGE_RUNNER_PARSE_V2],
          stdinJson: encodeJsonText(envelope),
          decodeResult: decodeAdapterParseOutput,
        })
        .pipe(
          Effect.map((value): { readonly ok: true; readonly records: ReadonlyArray<unknown> } => ({
            ok: true,
            records: (value as { records: ReadonlyArray<unknown> }).records,
          })),
          Effect.catch((cause) =>
            Effect.succeed({
              ok: false as const,
              capture: unavailable(
                redact(
                  `generated transform failed in containment: ${cause instanceof Error ? cause.message : String(cause)}`,
                  credential,
                ),
              ),
            }),
          ),
        );
      if (!parsed.ok) return parsed.capture;
      if (parsed.records.length > MAX_RECORDS_PER_CAPTURE) {
        return unavailable(
          `generated transform emitted ${parsed.records.length} records, over the ${MAX_RECORDS_PER_CAPTURE}-record cap; the capture refuses wholly rather than persist a partial parse`,
        );
      }

      // --- host-side schema validation over every record --------------------
      const validated: Array<{ record: ValidatedRecord; payloadJson: string }> = [];
      for (let index = 0; index < parsed.records.length; index += 1) {
        const checked = validateRecordAgainstSchema(parsed.records[index], spec.outputEventSchema);
        if (typeof checked === "string") {
          return unavailable(
            `generated transform record ${index} failed schema validation: ${checked}`,
          );
        }
        validated.push({
          record: checked,
          payloadJson: encodeJsonText({
            schemaVersion: 1,
            kind: "generated-adapter-record",
            documentSha256: sha256Hex(envelope.bodyBase64),
            transform: spec.transformRef,
            record: decodeJsonText(checked.canonical),
          }),
        });
      }

      // --- revisions: corrections, no-ops, and honest retractions ------------
      const sourceKind = sourceKindFor(sourceId);
      const documentIdentityFor = (identityValue: string): string =>
        `${sourceId}:${spec.outputEventSchema.recordKind}:${identityValue}`;
      const documents: Array<{
        documentIdentity: string;
        revisionId: string;
        changed: boolean;
        retracted: boolean;
        manifest: ExternalSourceManifest;
      }> = [];

      const previous = yield* revisions.listDocuments({
        environmentId,
        sourceKind,
        limit: MAX_RECORDS_PER_CAPTURE,
      });
      const latestByIdentity = new Map(
        previous.map((entry) => [entry.revision.documentIdentity, entry.revision]),
      );
      const seenIdentities = new Set<string>();

      const documentSha256 = sha256Hex(envelope.bodyBase64);
      for (const { record, payloadJson } of validated) {
        const documentIdentity = documentIdentityFor(record.identityValue);
        seenIdentities.add(documentIdentity);
        const contentSha256 = sha256Hex(record.canonical);
        const latest = latestByIdentity.get(documentIdentity) ?? null;
        if (latest !== null && !latest.retracted && latest.contentSha256 === contentSha256) {
          documents.push({
            documentIdentity,
            revisionId: latest.revisionId,
            changed: false,
            retracted: false,
            manifest: toManifest(latest),
          });
          continue;
        }
        const revision: ExternalSourceRevision = {
          revisionId: deriveRevisionId({
            environmentId,
            documentIdentity,
            contentSha256,
            firstObservedAtMs: now,
          }),
          environmentId,
          sourceKind,
          documentIdentity,
          sourceUrl: spec.url,
          contentSha256,
          publishedAtMs: record.publishedAtMs,
          timePrecision: record.timePrecision,
          firstObservedAtMs: now,
          captureMs: now,
          correctionOf: latest === null ? null : latest.revisionId,
          retracted: false,
        };
        yield* revisions.insert({ revision, payloadJson });
        documents.push({
          documentIdentity,
          revisionId: revision.revisionId,
          changed: true,
          retracted: false,
          manifest: toManifest(revision),
        });
      }

      // A document that vanished from the latest snapshot is retracted: a NEW
      // row linked to its predecessor, never a destructive edit.
      for (const [documentIdentity, latest] of latestByIdentity) {
        if (seenIdentities.has(documentIdentity) || latest.retracted) continue;
        const contentSha256 = sha256Hex(`retracted\n${latest.contentSha256}\n${documentSha256}`);
        const revision: ExternalSourceRevision = {
          revisionId: deriveRevisionId({
            environmentId,
            documentIdentity,
            contentSha256,
            firstObservedAtMs: now,
          }),
          environmentId,
          sourceKind,
          documentIdentity,
          sourceUrl: spec.url,
          contentSha256,
          publishedAtMs: null,
          timePrecision: latest.timePrecision,
          firstObservedAtMs: now,
          captureMs: now,
          correctionOf: latest.revisionId,
          retracted: true,
        };
        yield* revisions.insert({
          revision,
          payloadJson: encodeJsonText({
            schemaVersion: 1,
            kind: "generated-adapter-retraction",
            documentSha256,
            supersededContentSha256: latest.contentSha256,
            transform: spec.transformRef,
          }),
        });
        documents.push({
          documentIdentity,
          revisionId: revision.revisionId,
          changed: true,
          retracted: true,
          manifest: toManifest(revision),
        });
      }

      return { status: "ok", documents };
    });

  return { installSource, captureLatest } satisfies GeneratedExternalSourceServiceShape;
});

export const GeneratedExternalSourceServiceLive = Layer.effect(
  GeneratedExternalSourceService,
  makeGeneratedExternalSourceService,
).pipe(Layer.provide(GeneratedExternalSourceConfigLive));
