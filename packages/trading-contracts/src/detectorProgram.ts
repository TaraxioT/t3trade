/**
 * Detector-program contracts (SDK v2) — the sealed vocabulary a generated
 * detector runs under, and the records its host commits around each run.
 *
 * The v1 Forge contracts (see `observation.ts` / `forge.ts`) are pool-shaped
 * and stateless: one input window, one reading, nothing remembered. The v2
 * pivot (see `researchEvidence.ts` for the shared evidence vocabulary) makes
 * the generated program a DETECTOR over sealed facts with carried state, so
 * this module seals the boundary in both directions:
 *
 * - The INPUT is sealed by the host: `programSchemaVersion` pins the SDK
 *   generation, `asOfMs` is the ONLY clock the program ever sees (it has none
 *   of its own), `inputDigest` is the host-computed digest over facts+sources
 *   that programs echo but never recompute the meaning of, and `priorState`
 *   is the previous run's committed state, opaque to the host except through
 *   the {@link DetectorStateEnvelope}.
 * - Facts arrive as-of `asOfMs` under the `eligibleAt` rule of
 *   `researchEvidence.ts`: sources whose availability does not qualify are
 *   marked or excluded by the reactor, and the program treats an unqualified
 *   or incomplete source as unknown — never as silent absence of evidence.
 * - The OUTPUT is one `DetectionResult` plus the next state, bounded in
 *   COUNT on input facts and in BYTES on committed state, because both
 *   cross containment boundaries with fixed budgets.
 * - An evaluation's identity is CONTENT-derived (environment + capability +
 *   version + state revision + input digest), so a replay of the same
 *   revision over the same sealed input collapses to the same id instead of
 *   double-committing — the trap the v1 `evaluationIdFor` lacks.
 *
 * Schemas and pure helpers only; the reactor, store, scheduler, and runner
 * live in the server and later slices. The module is a sibling of the v1
 * contracts: nothing here edits them, and consumers dispatch on
 * `manifestVersion` / `programSchemaVersion` before choosing a vocabulary.
 *
 * @module TradingDetectorProgram
 */
import { Schema } from "effect";
import { sha256 } from "@noble/hashes/sha2";

import { TradingId, UnixMillis } from "./primitives.ts";
import { FORGE_CAPABILITY_ID_PATTERN } from "./observation.ts";
import {
  AvailabilityBasis,
  CapabilityArtifactRole,
  CapabilityManifestV2,
  CapturedFact,
  DetectionResult,
  EvidenceMode,
  Sha256Hex,
} from "./researchEvidence.ts";

// ---------------------------------------------------------------------------
// Sealed source completeness
// ---------------------------------------------------------------------------

/**
 * One required source's completeness and availability, as the reactor hands
 * it to the program beside the facts drawn from it.
 *
 * `complete: false` means the window could NOT be proven complete — the
 * program must treat facts from that source accordingly (an incomplete
 * window can ground `unknown`, never a confident `matched`). The time fields
 * mirror `EvidenceRef` but are optional here: a source that never became
 * available has no event time to cite, and the availability basis says why.
 */
export const SealedSourceRecord = Schema.Struct({
  sourceId: Schema.String.check(Schema.isNonEmpty()),
  evidenceId: TradingId,
  mode: EvidenceMode,
  contentSha256: Sha256Hex,
  complete: Schema.Boolean,
  eventAtMs: Schema.optional(UnixMillis),
  availableAtMs: Schema.optional(UnixMillis),
  availabilityBasis: AvailabilityBasis,
  expiresAtMs: Schema.optional(UnixMillis),
  /** Mirrors `EvidenceRef.sourceRevision`: a non-empty revision tag when the source has one. */
  sourceRevision: Schema.optional(Schema.String.check(Schema.isNonEmpty())),
});
export type SealedSourceRecord = typeof SealedSourceRecord.Type;

// ---------------------------------------------------------------------------
// Sealed program input / output
// ---------------------------------------------------------------------------

/**
 * The ceiling on committed detector state, in bytes of the canonical
 * envelope serialization. State crosses containment boundaries with fixed
 * budgets; a program that outgrows this must re-derive, not remember.
 */
export const DETECTOR_STATE_MAX_BYTES = 262_144;

/**
 * The ceiling on the facts array of one sealed input. Facts are the unit of
 * evidence the host seals and the program reasons over; a window needing
 * more than this is a mis-declared query, not a bigger input.
 */
export const DETECTOR_FACTS_MAX_COUNT = 10_000;

/**
 * Everything a detector program is fed, exactly. The host seals this; the
 * program has no clock, no fetch, and no view outside it.
 *
 * - `asOfMs` — the host-provided evaluation clock. The program has NO clock
 *   of its own; every time-derived decision must flow from this value.
 * - `inputDigest` — the host-computed canonical digest over facts+sources.
 *   Programs may echo it; they never recompute its meaning.
 * - `priorState` — the previous run's committed state envelope payload.
 *   Null or absent means first run.
 */
export const DetectorProgramInputV2 = Schema.Struct({
  programSchemaVersion: Schema.Literal(2),
  asOfMs: UnixMillis,
  inputDigest: Sha256Hex,
  facts: Schema.Array(CapturedFact).check(Schema.isMaxLength(DETECTOR_FACTS_MAX_COUNT)),
  sources: Schema.Array(SealedSourceRecord),
  priorState: Schema.optional(Schema.Unknown),
});
export type DetectorProgramInputV2 = typeof DetectorProgramInputV2.Type;

/**
 * What a detector program returns: one detection conclusion and the state it
 * wants carried to the next run. The host validates the result against the
 * input, and the next state against the byte cap, before committing either.
 */
export const DetectorProgramOutputV2 = Schema.Struct({
  result: DetectionResult,
  nextState: Schema.Unknown,
});
export type DetectorProgramOutputV2 = typeof DetectorProgramOutputV2.Type;

// ---------------------------------------------------------------------------
// Committed state envelope
// ---------------------------------------------------------------------------

/**
 * The wrapper around a detector's carried state. `state` is opaque to the
 * host; `stateSchemaVersion` is the PROGRAM's own version tag for the shape
 * it understands, so a version N+1 program can refuse (or migrate) the state
 * a version N run committed instead of misreading it.
 */
export const DetectorStateEnvelope = Schema.Struct({
  stateSchemaVersion: Schema.Int.check(Schema.isGreaterThan(0)),
  state: Schema.Unknown,
});
export type DetectorStateEnvelope = typeof DetectorStateEnvelope.Type;

/** Why a state envelope could not be encoded or decoded — named, never thrown. */
export type DetectorStateFailure =
  | "state-envelope-invalid"
  | "state-not-serializable"
  | "state-exceeds-max-bytes"
  | "state-json-invalid";

export type EncodeDetectorStateResult =
  | { readonly ok: true; readonly serialized: string }
  | { readonly ok: false; readonly failure: DetectorStateFailure };

export type DecodeDetectorStateResult =
  | { readonly ok: true; readonly envelope: DetectorStateEnvelope }
  | { readonly ok: false; readonly failure: DetectorStateFailure };

/**
 * Key-sorted, undefined-dropping canonical JSON — the same normalization
 * `forward.ts` and `hypothesis.ts` apply (module-private there, restated
 * here) so that an envelope's serialization is a function of its content,
 * not of which caller built the object.
 */
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object" && value !== null) {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] === undefined) continue;
      out[key] = canonical(source[key]);
    }
    return out;
  }
  return value;
};

/** UTF-8 byte length — the honest unit for the byte cap, not UTF-16 code units. */
const byteLength = (value: string): number => new TextEncoder().encode(value).length;

/**
 * Validate a state envelope and serialize it canonically under the byte cap.
 * Pure and total: every failure is a named {@link DetectorStateFailure}.
 */
export function encodeDetectorState(envelope: unknown): EncodeDetectorStateResult {
  if (!Schema.is(DetectorStateEnvelope)(envelope)) {
    return { ok: false, failure: "state-envelope-invalid" };
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(canonical(envelope));
  } catch {
    // Circular structures and BigInt values throw; state is `unknown`, so
    // total means refusing them by name rather than crashing the host.
    return { ok: false, failure: "state-not-serializable" };
  }
  if (byteLength(serialized) > DETECTOR_STATE_MAX_BYTES) {
    return { ok: false, failure: "state-exceeds-max-bytes" };
  }
  return { ok: true, serialized };
}

/**
 * Parse and validate a serialized state envelope under the same byte cap.
 * The mirror of {@link encodeDetectorState}: every failure is named.
 */
export function decodeDetectorState(serialized: string): DecodeDetectorStateResult {
  if (byteLength(serialized) > DETECTOR_STATE_MAX_BYTES) {
    return { ok: false, failure: "state-exceeds-max-bytes" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return { ok: false, failure: "state-json-invalid" };
  }
  if (!Schema.is(DetectorStateEnvelope)(parsed)) {
    return { ok: false, failure: "state-envelope-invalid" };
  }
  return { ok: true, envelope: parsed };
}

// ---------------------------------------------------------------------------
// Host-reviewed acceptance cases (v2)
// ---------------------------------------------------------------------------

/**
 * One host-owned acceptance case for a v2 capability: a sealed input and the
 * expected outcome, including the expected next state — data, not code, kept
 * in the stateDir keyed (capabilityId, version) exactly like the v1 cases.
 * The reader is a later slice; this is the shape it will decode.
 */
export const ForgeAcceptanceCaseV2 = Schema.Struct({
  name: Schema.String.check(Schema.isNonEmpty()),
  input: DetectorProgramInputV2,
  expected: Schema.Struct({
    result: DetectionResult,
    nextState: Schema.Unknown,
  }),
});
export type ForgeAcceptanceCaseV2 = typeof ForgeAcceptanceCaseV2.Type;

/** The v2 acceptance file: at least one case, at most 32 — the same bounds as v1. */
export const ForgeAcceptanceCasesV2 = Schema.Array(ForgeAcceptanceCaseV2).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(32),
);
export type ForgeAcceptanceCasesV2 = typeof ForgeAcceptanceCasesV2.Type;

// ---------------------------------------------------------------------------
// Committed evaluation record (v2)
// ---------------------------------------------------------------------------

/**
 * The canonical serialization an evaluation's content identity is taken
 * over: a fixed-shape array under a version tag (the `eventSets.ts`
 * precedent — never an object, whose key order a serializer could reorder).
 * The store hashes this string to mint {@link detectorEvaluationId}.
 */
export function serializeDetectorEvaluationIdentity(input: {
  readonly environmentId: string;
  readonly capabilityId: string;
  readonly version: number;
  readonly stateRevision: number;
  readonly inputDigest: string;
}): string {
  return JSON.stringify([
    "trading_detector.evaluation.v1",
    input.environmentId,
    input.capabilityId,
    input.version,
    input.stateRevision,
    input.inputDigest,
  ]);
}

// -- pure SHA-256 ------------------------------------------------------------
//
// The evaluation id is a content identity. The contracts package is shared
// with the browser, so `node:crypto` is not available here; hashing goes
// through @noble/hashes, the same audited dependency the web client already
// uses, and the tests pin it against Web Crypto.

/** SHA-256 over the UTF-8 encoding of `value`, as lowercase hex. */
function sha256Hex(value: string): string {
  const digest = sha256(new TextEncoder().encode(value));
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/**
 * The content identity of one committed detector evaluation: `dtev_` plus the
 * first 24 hex characters of the SHA-256 over the canonical identity
 * serialization. Same environment + capability + version + state revision +
 * input digest always collapses to the same id, so a replayed commit
 * deduplicates instead of double-recording; any changed component does not.
 */
export function detectorEvaluationId(input: {
  readonly environmentId: string;
  readonly capabilityId: string;
  readonly version: number;
  readonly stateRevision: number;
  readonly inputDigest: string;
}): string {
  return `dtev_${sha256Hex(serializeDetectorEvaluationIdentity(input)).slice(0, 24)}`;
}

/**
 * One committed v2 detector evaluation — the record the store appends when a
 * contained run's result and next state have both been validated. The
 * schema-level check pins the invariant the id exists for: `evaluationId`
 * must equal the content identity over the identity fields, so a record can
 * never decode with an id that misstates what was evaluated.
 */
export const DetectorEvaluationRecordV2 = Schema.Struct({
  manifestVersion: Schema.Literal(2),
  evaluationId: TradingId,
  environmentId: TradingId,
  capabilityId: Schema.String.check(Schema.isPattern(FORGE_CAPABILITY_ID_PATTERN)),
  version: Schema.Int.check(Schema.isGreaterThan(0)),
  stateRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  inputDigest: Sha256Hex,
  asOfMs: UnixMillis,
  result: DetectionResult,
  state: DetectorStateEnvelope,
  evidenceIds: Schema.Array(TradingId),
  committedAtMs: UnixMillis,
}).check(
  Schema.makeFilter((input) =>
    input.evaluationId ===
    detectorEvaluationId({
      environmentId: input.environmentId,
      capabilityId: input.capabilityId,
      version: input.version,
      stateRevision: input.stateRevision,
      inputDigest: input.inputDigest,
    })
      ? true
      : "evaluationId must be the content identity over environmentId, capabilityId, version, stateRevision, and inputDigest",
  ),
);
export type DetectorEvaluationRecordV2 = typeof DetectorEvaluationRecordV2.Type;

// ---------------------------------------------------------------------------
// v2 bundle path validation
// ---------------------------------------------------------------------------

/**
 * The v2 role-to-path mapping: each artifact role declares exactly one
 * bundle path. Required roles: `sdk`, `detector`, `acceptance` (the
 * generated test file, mirroring v1's `signal.test.ts`). Optional roles:
 * `transform`, `state-schema`, `source-query`, `execution-policy`.
 */
export const DETECTOR_V2_ARTIFACT_ROLES: Readonly<
  Record<CapabilityArtifactRole, { readonly path: string; readonly required: boolean }>
> = {
  sdk: { path: "sdk.ts", required: true },
  detector: { path: "detector.ts", required: true },
  acceptance: { path: "detector.test.ts", required: true },
  transform: { path: "transform.ts", required: false },
  "state-schema": { path: "state-schema.ts", required: false },
  "source-query": { path: "query.graphql", required: false },
  "execution-policy": { path: "policy.ts", required: false },
};

/**
 * The v2 SOURCE-ADAPTER role-to-path mapping: a transform-primary bundle with
 * no detector program. Required: `sdk` (host-mounted), `transform` (the
 * network-less parse), and `acceptance` as `sample-document.json` — a real
 * captured document body the host parses through the transform at check time;
 * there is no generated test file for a parse. The kind discriminator is the
 * declared role set itself: `transform` without `detector`.
 */
export const SOURCE_ADAPTER_V2_ARTIFACT_ROLES: Readonly<
  Record<CapabilityArtifactRole, { readonly path: string; readonly required: boolean }>
> = {
  sdk: { path: "sdk.ts", required: true },
  detector: { path: "detector.ts", required: false },
  acceptance: { path: "sample-document.json", required: true },
  transform: { path: "transform.ts", required: true },
  "state-schema": { path: "state-schema.ts", required: false },
  "source-query": { path: "query.graphql", required: false },
  "execution-policy": { path: "policy.ts", required: false },
};

/**
 * Which v2 bundle shape a manifest declares: a detector program (the
 * `detector` role present), or a source adapter (`transform` present and no
 * `detector`). A manifest with neither has no program to run and refuses path
 * validation through the required-role check.
 */
export function v2BundleKind(
  manifest: CapabilityManifestV2,
): "detector-program" | "source-adapter" {
  const roles = new Set(manifest.artifacts.map((artifact) => artifact.role));
  return roles.has("detector") ? "detector-program" : "source-adapter";
}

/** The validated v2 bundle path set, or a named refusal. */
export type DetectorArtifactPathsResult =
  | { readonly paths: string[] }
  | { readonly refusal: string };

/**
 * Validate a v2 manifest's declared artifacts into the bundle path set the
 * store stages and the sandbox mounts. Rules, each a named refusal:
 *
 * - every REQUIRED role present exactly once, at its declared path;
 * - every OPTIONAL role at most once, at its declared path when present;
 * - no two artifacts share a path (a duplicate would make the bundle's
 *   content hash ambiguous about which bytes a path means);
 * - no role outside the mapping (the role vocabulary itself is closed).
 *
 * Paths come back sorted, so the set is byte-stable for hashing and listing.
 */
export function detectorArtifactPaths(manifest: CapabilityManifestV2): DetectorArtifactPathsResult {
  const roleMap =
    v2BundleKind(manifest) === "source-adapter"
      ? SOURCE_ADAPTER_V2_ARTIFACT_ROLES
      : DETECTOR_V2_ARTIFACT_ROLES;
  const seenRoles = new Map<CapabilityArtifactRole, number>();
  const seenPaths = new Map<string, CapabilityArtifactRole>();
  // "No other roles" is structural: `CapabilityArtifactRole` is a closed
  // literal union and the mapping covers every member, so a decoded manifest
  // cannot carry a role this switch does not know.
  for (const artifact of manifest.artifacts) {
    const declared = roleMap[artifact.role];
    if (seenRoles.has(artifact.role)) {
      return { refusal: `duplicate artifact role: ${artifact.role}` };
    }
    if (seenPaths.has(artifact.path)) {
      return { refusal: `duplicate artifact path: ${artifact.path}` };
    }
    if (artifact.path !== declared.path) {
      return {
        refusal: `artifact role ${artifact.role} must be at path ${declared.path}`,
      };
    }
    seenRoles.set(artifact.role, 1);
    seenPaths.set(artifact.path, artifact.role);
  }
  for (const [role, declared] of Object.entries(roleMap) as Array<
    [CapabilityArtifactRole, { readonly path: string; readonly required: boolean }]
  >) {
    if (declared.required && !seenRoles.has(role)) {
      return { refusal: `missing required artifact role: ${role}` };
    }
  }
  // A source adapter is exactly transform-primary: a detector role beside the
  // transform makes it a detector bundle (which allows transform as an
  // optional module), and v2BundleKind already routed on that — so reaching
  // here with the source-adapter map means `detector` is correctly absent.
  return { paths: [...seenPaths.keys()].sort() };
}
