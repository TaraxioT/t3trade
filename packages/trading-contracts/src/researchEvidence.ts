/**
 * Research evidence contracts — the versioned, source-agnostic vocabulary
 * that research, detectors, and generated execution share.
 *
 * The Forge v1 contracts (see `forge.ts`) are pool-shaped: one Graph source,
 * three fee regimes, a hardcoded five-minute capture. The pivot to
 * general-purpose research needs a vocabulary that no scenario can exhaust:
 * evidence MODES (live, replay, fixture) that never blur, availability that
 * is recorded or explicitly unknown, dataset manifests that pin exactly what
 * was asked and what was covered, and versioned generated artifacts whose
 * identity is a hash, not a filename.
 *
 * Rules this module enforces by construction:
 *
 * - Every quantity is an exact decimal integer string with a named unit;
 *   floats never appear in a fact value.
 * - Every timestamp is epoch milliseconds, and every record says what time
 *   precision its SOURCE can actually support — a date-only publication can
 *   never masquerade as minute-precise evidence.
 * - Availability is a first-class field: a fact whose availability is unknown
 *   can support retrospective research, never an as-of executable claim
 *   (`eligibleAt` encodes that rule).
 * - Coverage is honest: a dataset that hit its row cap is `partial`, never
 *   `complete`, and the requested window is kept beside the covered one.
 * - No scenario names, no fee regimes, no pool counts. Keys and entity ids
 *   are opaque strings declared by the versioned program that produces them.
 *
 * Schemas and pure helpers only; hosts and adapters live in the server.
 *
 * @module TradingResearchEvidence
 */
import { Schema } from "effect";

import { TradingId, UnixMillis } from "./primitives.ts";

// ---------------------------------------------------------------------------
// Shared value primitives
// ---------------------------------------------------------------------------

/** A 64-character lowercase-or-uppercase hex SHA-256 digest. */
export const Sha256Hex = Schema.String.check(Schema.isPattern(/^[0-9a-fA-F]{64}$/));
export type Sha256Hex = typeof Sha256Hex.Type;

/** An exact non-negative decimal integer, carried as its decimal string. */
export const DecimalIntegerString = Schema.String.check(Schema.isPattern(/^(0|[1-9][0-9]*)$/));
export type DecimalIntegerString = typeof DecimalIntegerString.Type;

/** Signed exact quantities, such as net flow and returns in scaled units. */
export const SignedDecimalIntegerString = Schema.String.check(
  Schema.isPattern(/^(0|-?[1-9][0-9]*)$/),
);
export type SignedDecimalIntegerString = typeof SignedDecimalIntegerString.Type;

/** A chain id as the chain itself reports it (decimal string, e.g. "1"). */
export const ChainIdString = Schema.String.check(Schema.isPattern(/^[1-9][0-9]*$/));
export type ChainIdString = typeof ChainIdString.Type;

/** A deployment, package, document, or feed identity — opaque but non-empty. */
export const SourceDeploymentId = TradingId;

/** How precise a source's own timestamps can honestly claim to be. */
export const SourceTimePrecision = Schema.Literals(["millisecond", "second", "minute", "day"]);
export type SourceTimePrecision = typeof SourceTimePrecision.Type;

/**
 * Whether an observation's availability time is known.
 *
 * `recorded` — the source itself states when the fact became observable
 * (a block timestamp, a feed's publication instant). `conservative-estimate`
 * — research uses a modeled delay and must label it as an assumption.
 * `unknown` — nothing is known; retrospective research only.
 */
export const AvailabilityBasis = Schema.Literals(["recorded", "conservative-estimate", "unknown"]);
export type AvailabilityBasis = typeof AvailabilityBasis.Type;

// ---------------------------------------------------------------------------
// Evidence modes
// ---------------------------------------------------------------------------

/**
 * How a piece of evidence was obtained. The three modes are never conflated:
 * a replay result can never be presented as live detection, and a fixture can
 * never be presented as either. Every captured record carries its mode, and
 * execution admission only ever consumes `live`.
 */
export const EvidenceMode = Schema.Literals(["live", "historical-replay", "fixture"]);
export type EvidenceMode = typeof EvidenceMode.Type;

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

/** One observed value: a boolean, an exact decimal with its unit, or text. */
export const FactValue = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("boolean"),
    value: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("decimal"),
    value: SignedDecimalIntegerString,
    unit: Schema.String.check(Schema.isPattern(/\S/)),
  }),
  Schema.Struct({
    kind: Schema.Literal("text"),
    value: Schema.String,
  }),
]);
export type FactValue = typeof FactValue.Type;

/**
 * A reference to retained evidence backing a fact.
 *
 * The evidence BYTES live in the host's evidence store under
 * `contentSha256`; this record is the citable handle. `eventAtMs` is when
 * the fact happened; `availableAtMs` is when an observer could first have
 * known it — null when the basis is unknown. `expiresAtMs` bounds how long
 * the evidence may be treated as current (reorg horizons, feed corrections).
 */
export const EvidenceRef = Schema.Struct({
  id: TradingId,
  environmentId: TradingId,
  sourceId: TradingId,
  mode: EvidenceMode,
  contentSha256: Sha256Hex,
  eventAtMs: UnixMillis,
  availableAtMs: Schema.NullOr(UnixMillis),
  availabilityBasis: AvailabilityBasis,
  timePrecision: SourceTimePrecision,
  capturedAtMs: UnixMillis,
  expiresAtMs: UnixMillis,
  sourceRevision: TradingId,
});
export type EvidenceRef = typeof EvidenceRef.Type;

/**
 * One captured fact, keyed by the producing program's declared output schema.
 * `key` and `entityId` are opaque to the host: their meaning is pinned by the
 * versioned program whose manifest declared them.
 */
export const CapturedFact = Schema.Struct({
  id: TradingId,
  key: Schema.String.check(Schema.isNonEmpty()),
  entityId: Schema.String.check(Schema.isNonEmpty()),
  value: FactValue,
  evidence: Schema.Array(EvidenceRef),
});
export type CapturedFact = typeof CapturedFact.Type;

// ---------------------------------------------------------------------------
// Detection results
// ---------------------------------------------------------------------------

/**
 * What a detector evaluation concluded. `unknown` is a first-class outcome,
 * not an error: missing sources, indexing lag, reorg invalidation, or
 * ambiguous extraction produce unknown, and unknown blocks new exposure.
 */
export const DetectionResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("matched"),
    occurrenceKey: TradingId,
    evidenceIds: Schema.Array(TradingId),
    facts: Schema.Array(CapturedFact),
    validUntilMs: UnixMillis,
  }),
  Schema.Struct({
    status: Schema.Literal("not-matched"),
    evidenceIds: Schema.Array(TradingId),
    explanation: Schema.String,
  }),
  Schema.Struct({
    status: Schema.Literal("unknown"),
    missingSourceIds: Schema.Array(TradingId),
    explanation: Schema.String,
  }),
]);
export type DetectionResult = typeof DetectionResult.Type;

// ---------------------------------------------------------------------------
// Dataset manifests
// ---------------------------------------------------------------------------

/**
 * What a capture asked for and what it actually got. `coverage` never claims
 * more than `requested`, and `status` is `partial` — never `complete` — when
 * any cap stopped the walk.
 */
export const DatasetCoverage = Schema.Struct({
  requested: Schema.Struct({ fromMs: UnixMillis, toMs: UnixMillis }),
  coverage: Schema.Struct({ fromMs: UnixMillis, toMs: UnixMillis, rows: Schema.Number }),
  status: Schema.Literals(["complete", "partial", "unavailable"]),
});
export type DatasetCoverage = typeof DatasetCoverage.Type;

/**
 * The immutable manifest of one Graph dataset capture. The actual query and
 * variables are retained in the host's evidence store, linked by the hashes
 * here; the manifest itself never carries credentials.
 */
export const GraphDatasetManifest = Schema.Struct({
  id: TradingId,
  environmentId: TradingId,
  provider: Schema.Literals(["the-graph"]),
  transport: Schema.Literals(["subgraph", "substreams"]),
  chainId: ChainIdString,
  deploymentOrPackageId: SourceDeploymentId,
  schemaSha256: Sha256Hex,
  programSha256: Sha256Hex,
  variablesSha256: Sha256Hex,
  requested: Schema.Struct({ fromMs: UnixMillis, toMs: UnixMillis }),
  coverage: Schema.Struct({ fromMs: UnixMillis, toMs: UnixMillis, rows: Schema.Number }),
  status: Schema.Literals(["complete", "partial", "unavailable"]),
  pin: Schema.NullOr(
    Schema.Struct({ blockNumber: DecimalIntegerString, blockHash: Schema.String }),
  ),
  cursor: Schema.NullOr(TradingId),
  normalizedSchemaVersion: Schema.Number.check(Schema.isGreaterThan(0)),
  contentSha256: Sha256Hex,
  capturedAtMs: UnixMillis,
  availabilityBasis: AvailabilityBasis,
  mode: EvidenceMode,
});
export type GraphDatasetManifest = typeof GraphDatasetManifest.Type;

/**
 * The manifest of one external (non-chain) source revision: an official feed
 * entry, a schedule document, a statement. Corrections and retractions are
 * new revisions that supersede, never in-place edits.
 */
export const ExternalSourceManifest = Schema.Struct({
  id: TradingId,
  environmentId: TradingId,
  providerKind: Schema.String.check(Schema.isNonEmpty()),
  documentIdentity: Schema.String.check(Schema.isNonEmpty()),
  sourceUrl: Schema.String.check(Schema.isPattern(/^https?:\/\//)),
  contentSha256: Sha256Hex,
  publishedAtMs: Schema.NullOr(UnixMillis),
  timePrecision: SourceTimePrecision,
  firstObservedAtMs: UnixMillis,
  correctionOf: Schema.NullOr(TradingId),
  retracted: Schema.Boolean,
});
export type ExternalSourceManifest = typeof ExternalSourceManifest.Type;

// ---------------------------------------------------------------------------
// Versioned generated artifacts (SDK v2 manifests)
// ---------------------------------------------------------------------------

/**
 * The role one generated artifact plays in a capability. The v1 bundle's
 * four-file allowlist becomes this open-but-declared set: adding a file
 * kind means declaring its role and hash here, never a silent filename.
 */
export const CapabilityArtifactRole = Schema.Literals([
  "source-query",
  "transform",
  "detector",
  "execution-policy",
  "sdk",
  "state-schema",
  "acceptance",
]);
export type CapabilityArtifactRole = typeof CapabilityArtifactRole.Type;

/** One versioned artifact: its role, its path in the bundle, its hash. */
export const CapabilityArtifact = Schema.Struct({
  role: CapabilityArtifactRole,
  path: Schema.String.check(Schema.isNonEmpty()),
  sha256: Sha256Hex,
});
export type CapabilityArtifact = typeof CapabilityArtifact.Type;

/**
 * The SDK v2 capability manifest. Version 2 replaces the v1 pool-shaped
 * input contract with declared source/fact sets and generated programs; the
 * version discriminator is how every reader dispatches instead of guessing.
 */
export const CapabilityManifestV2 = Schema.Struct({
  manifestVersion: Schema.Literal(2),
  capabilityId: TradingId,
  version: Schema.Number.check(Schema.isGreaterThan(0)),
  semantics: Schema.String.check(Schema.isNonEmpty()),
  requiredSourceIds: Schema.Array(TradingId),
  outputFactKeys: Schema.Array(Schema.String.check(Schema.isNonEmpty())),
  artifacts: Schema.Array(CapabilityArtifact),
  createdAtMs: UnixMillis,
});
export type CapabilityManifestV2 = typeof CapabilityManifestV2.Type;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** The join-input shape `eligibleAt` decides over. */
export interface EligibilityFact {
  readonly eventAtMs: number;
  readonly availableAtMs: number | null;
  readonly availabilityBasis: AvailabilityBasis;
  readonly expiresAtMs: number;
  readonly final: boolean;
}

/**
 * Whether a fact may enter an as-of decision at `asOfMs`.
 *
 * One predicate, not a join: the caller still validates finiteness and
 * precision before this, and still enforces window completeness separately.
 * The rule it does encode: only RECORDED availability counts for executable
 * claims — an estimate or an unknown may inform retrospective research, never
 * an action. A fact is eligible when it happened by the as-of time, was
 * observable by the as-of time, has not expired, and is final.
 */
export function eligibleAt(fact: EligibilityFact, asOfMs: number): boolean {
  return (
    fact.availabilityBasis === "recorded" &&
    fact.availableAtMs !== null &&
    fact.eventAtMs <= asOfMs &&
    fact.availableAtMs <= asOfMs &&
    asOfMs < fact.expiresAtMs &&
    fact.final
  );
}
