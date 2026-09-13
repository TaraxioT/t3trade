/**
 * CapabilityBuilder — the host's orchestration of a capability an in-app
 * agent authors.
 *
 * The flow is deliberately split so the AGENT does the writing and the HOST
 * does everything that grants anything:
 *
 *   prepare → the host inspects sources and hands back an authoring brief
 *             (the typed SDK contract, the data schema, the staging
 *             directory). No detector semantics ship in the brief.
 *   the agent writes the artifacts with its own file tools, in its own
 *             workspace — there is no hidden finished detector here.
 *   check   → the host reads the staged files (flat, regular, bounded,
 *             contract-set), compiles and typechecks them, runs the generated
 *             tests, then runs host-owned acceptance cases and determinism
 *             checks — all inside the sealed sandbox — and computes the
 *             sealed report and every hash itself. Which pipeline runs is
 *             dispatched on the staged manifest's manifestVersion: 1 is the
 *             pool-signal contract, 2 the detector-program contract over
 *             sealed facts with carried state.
 *   install → a separate CAS step in the store (never part of check).
 *
 * A "pass" string from inside the container grants nothing: the host reads
 * structured results, compares readings itself, and hashes the exact bytes it
 * tested.
 *
 * @module CapabilityBuilder
 */
// @effect-diagnostics nodeBuiltinImport:off - reads the authoring workspace from the real filesystem: readdir/lstat are the validation being performed.
// @effect-diagnostics globalDate:off globalDateInEffect:off - version creation timestamps are wall-clock instants persisted as data.
// @effect-diagnostics preferSchemaOverJson:off - the four artifacts are foreign files; JSON.parse feeds schemas, it is not the validation itself.
// @effect-diagnostics tryCatchInEffectGen:off - workspace reads and staging refusals are host verdicts; try/catch states the refusal exactly.
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Schema } from "effect";
import * as Layer from "effect/Layer";
import * as NodeFs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import * as NodePath from "node:path";
import { randomUUID } from "node:crypto";

import {
  CapabilityManifestV2,
  detectorArtifactPaths,
  v2BundleKind,
  DETECTOR_V2_ARTIFACT_ROLES,
  DetectorProgramInputV2,
  DetectorProgramOutputV2,
  FORGE_CAPABILITY_ARTIFACT_PATHS,
  FORGE_MAX_BUNDLE_BYTES,
  FORGE_MAX_SEMANTICS_CHARS,
  FORGE_SDK_SCHEMA_VERSION,
  FORGE_SANDBOX_BUILD_BUDGET_MS,
  ForgeCapabilityManifest,
  ForgeSignalOutput,
  type ForgeAcceptanceCase,
  type ForgeAcceptanceCaseV2,
  type ForgeBuildReceipt,
  type ForgeCapabilityVersion,
  type ForgeCheckOutcome,
  type ForgeSignalInput,
  type ForgeSignalReading,
} from "@t3tools/trading-contracts";

import {
  forgeSha256Hex,
  ForgeCapabilitySandbox,
  ForgeSandboxError,
  type ForgeCapabilitySandboxShape,
  type ForgeSandboxFile,
} from "./CapabilitySandbox.ts";
import { ForgeCapabilityStore, type ForgeCapabilityStoreShape } from "./CapabilityStore.ts";
import { validateForgeCapabilityQuery } from "./CapabilityQuery.ts";

// ---------------------------------------------------------------------------
// The typed SDK the artifacts import — host-owned, semantics-free
// ---------------------------------------------------------------------------

/**
 * The SDK source mounted beside the artifacts in containment as `sdk.ts`.
 *
 * Types, bounded decode helpers, and the entry signature ONLY. There is no
 * aggregation, no thresholds, no coordination branch — a detector is whatever
 * the authored `signal.ts` makes of these types. Changing this contract is a
 * schema-version bump, never an in-place edit.
 */
export const FORGE_SDK_SOURCE = `/**
 * T3 Forge capability SDK — schema version ${FORGE_SDK_SCHEMA_VERSION}.
 * Host-owned contract; a capability imports nothing else.
 */
export type SourceEvidence = {
  readonly mode: "live" | "historical";
  readonly provider: "the-graph";
  readonly deploymentId: string;
  readonly blockNumber: string;
  readonly blockHash: string;
  readonly fetchedAtMs: number;
  readonly windowEndMs: number;
  readonly querySha256: string;
  readonly responseSha256: string;
  readonly complete: boolean;
};

export type PoolAnchor = {
  readonly observationId: string;
  readonly priceQuotePerBaseMicros: number;
  readonly ageBeforeWindowSeconds: number;
};

export type SourceTrade = {
  readonly observationId: string;
  readonly transactionHash: string;
  readonly timestamp: number;
  readonly logIndex: number;
  readonly priceQuotePerBaseMicros: number;
  readonly quoteVolumeMicros: number;
  readonly quoteVolumeRaw: string;
  readonly amount0: string;
  readonly amount1: string;
};

export type PoolWindow = {
  readonly poolId: string;
  readonly moveBps: number | null;
  readonly observations?: ReadonlyArray<SourceTrade>;
  readonly anchorCandidates?: ReadonlyArray<SourceTrade>;
  readonly quoteVolumeMicros: string;
  readonly tradeCount: number;
  readonly observationIds: ReadonlyArray<string>;
  readonly anchor?: PoolAnchor;
};

export type SignalInput = {
  readonly evidence: SourceEvidence;
  readonly pools: ReadonlyArray<PoolWindow>;
};

export type Regime = "coordinated" | "isolated" | "quiet";

export type SignalReading =
  | { readonly kind: "ready"; readonly regime: Regime; readonly agreement: number; readonly eligiblePoolIds: ReadonlyArray<string> }
  | { readonly kind: "insufficient"; readonly reason: string };

export type PoolDiagnostics = {
  readonly poolId: string;
  readonly qualifyingCount: number;
  readonly excludedCount: number;
  readonly quoteVolumeMicros: string;
  readonly anchorObservationId?: string;
  readonly tradeIds: ReadonlyArray<string>;
};

export type SignalOutput = {
  readonly reading: SignalReading;
  readonly diagnostics: ReadonlyArray<PoolDiagnostics>;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Minimal structural check of one input window; exactness is the host's. */
export function assertSignalInput(value: unknown): asserts value is SignalInput {
  if (!isPlainObject(value) || !isPlainObject(value.evidence) || !Array.isArray(value.pools)) {
    throw new Error("SignalInput must be { evidence, pools[] }");
  }
}

const registeredTests: Array<() => void | Promise<void>> = [];
export function describe(_name: string, body: () => void): void { body(); }
export function test(_name: string, body: () => void | Promise<void>): void { registeredTests.push(body); }
export const it = test;
export function expect(actual: unknown) {
  return {
    toBe(expected: unknown): void { if (!Object.is(actual, expected)) throw new Error("values differ"); },
    toEqual(expected: unknown): void { if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("values differ"); },
    toBeDefined(): void { if (actual === undefined) throw new Error("value is undefined"); },
    toBeTruthy(): void { if (!actual) throw new Error("value is not truthy"); },
    toBeFalsy(): void { if (actual) throw new Error("value is not falsy"); },
  };
}
export async function runRegisteredTests(): Promise<number> {
  for (const body of registeredTests) await body();
  return registeredTests.length;
}

/** The entrypoint every capability exports. Pure: same input, same output. */
export type ReadSignal = (input: SignalInput) => SignalOutput;
`;

/** The data schema context handed to the authoring brief, rendered once. */
export const FORGE_DATA_SCHEMA_CONTEXT = [
  "Forge observation data schema (host-normalized, exact):",
  "- Every observation is one mainnet Uniswap v3 WETH/USDC swap: chain (ethereum-mainnet), poolId,",
  "  observationId ('txHash:logIndex'), transactionHash, logIndex, timestamp (unix seconds), sender,",
  "  recipient, amount0/amount1 (signed decimal integer strings, raw units), sqrtPriceX96 (decimal",
  "  integer string), tick, baseIsToken1, priceQuotePerBase (exact rational {numerator, denominator}),",
  "  priceQuotePerBaseMicros (integer, 1e6 scale), quoteVolumeRaw / quoteVolumeMicros (absolute USDC leg).",
  "- The host aggregates each pool window into PoolWindow: moveBps (integer basis points vs the anchor),",
  "  quoteVolumeMicros (summed absolute USDC leg, integer micro-units), tradeCount, observationIds",
  "  (every source trade id), observations, all anchorCandidates, and the resolved pre-window anchor. Missing anchor means moveBps=null; never treat it as zero movement.",
  "- Numbers with units ride strings when exactness matters (raw/micros) and numbers when display-grade.",
  "- Your capability receives SignalInput and must return SignalOutput; diagnostics must reference only",
  "  observationIds present in the input window.",
].join("\n");

// ---------------------------------------------------------------------------
// The detector-program (v2) SDK — sealed facts, carried state
// ---------------------------------------------------------------------------

/**
 * The detector-program SDK generation. The v1 `FORGE_SDK_SCHEMA_VERSION`
 * stays 1: two SDK generations live side by side, and every consumer
 * dispatches on the manifest's `manifestVersion` before choosing one.
 */
export const DETECTOR_SDK_SCHEMA_VERSION = 2;

/**
 * The v2 SDK source mounted beside the artifacts in containment as `sdk.ts`.
 *
 * Types, the state-envelope helpers, the toy test harness, and the SYNC entry
 * signature ONLY — mirroring `detectorProgram.ts` in trading-contracts field
 * for field, plus (since P5.3) the execution-policy vocabulary mirroring
 * `executionPolicy.ts`: the envelope, the proposal union, the bounded
 * detector-result summary, the prior-proposal summary, `PolicyInput` /
 * `PolicyOutput`, and the SYNC `Propose` entry the optional `policy.ts`
 * artifact exports. The state-envelope helpers are shared between the two
 * entries — same wrapper, same byte cap, separate lineages.
 *
 * The invariants containment enforces and this SDK assumes: NO
 * clock (`asOfMs` is the only time a detector ever sees), NO network or fetch,
 * NO environment or process access, NO host callbacks. `detect` and `propose`
 * are synchronous and pure over the sealed input — the same input, including
 * `priorState`, must produce the same output. Changing this contract is a
 * detector SDK schema-version bump, never an in-place edit; the policy
 * additions below are additive types, so a bundle that declares the sdk
 * artifact hash against these bytes is simply a newer-generation bundle.
 */
export const FORGE_SDK_SOURCE_V2 = `/**
 * T3 Forge detector-program SDK — schema version ${DETECTOR_SDK_SCHEMA_VERSION}.
 * Host-owned contract; a detector (and, when your bundle declares one, your
 * execution policy) imports nothing else.
 *
 * Invariants: you have NO clock (asOfMs is the only time you will ever see),
 * NO network or fetch, NO environment or process access, and NO host
 * callbacks. Your detect is synchronous and pure over the sealed input: the
 * same input — including priorState — must produce the same result and
 * nextState. Facts arrive sealed as-of asOfMs; treat an unqualified or
 * incomplete source as unknown, never as silent absence of evidence.
 */
export type EvidenceMode = "live" | "historical-replay" | "fixture";
export type AvailabilityBasis = "recorded" | "conservative-estimate" | "unknown";
export type SourceTimePrecision = "millisecond" | "second" | "minute" | "day";

/** One observed value: a boolean, an exact decimal with its unit, or text. */
export type FactValue =
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "decimal"; readonly value: string; readonly unit: string }
  | { readonly kind: "text"; readonly value: string };

export type EvidenceRef = {
  readonly id: string;
  readonly environmentId: string;
  readonly sourceId: string;
  readonly mode: EvidenceMode;
  readonly contentSha256: string;
  readonly eventAtMs: number;
  readonly availableAtMs: number | null;
  readonly availabilityBasis: AvailabilityBasis;
  readonly timePrecision: SourceTimePrecision;
  readonly capturedAtMs: number;
  readonly expiresAtMs: number;
  readonly sourceRevision: string;
};

export type CapturedFact = {
  readonly id: string;
  readonly key: string;
  readonly entityId: string;
  readonly value: FactValue;
  readonly evidence: ReadonlyArray<EvidenceRef>;
};

/** One required source's completeness, as sealed by the host beside the facts. */
export type SealedSourceRecord = {
  readonly sourceId: string;
  readonly evidenceId: string;
  readonly mode: EvidenceMode;
  readonly contentSha256: string;
  readonly complete: boolean;
  readonly eventAtMs?: number;
  readonly availableAtMs?: number;
  readonly availabilityBasis: AvailabilityBasis;
  readonly expiresAtMs?: number;
  readonly sourceRevision?: string;
};

export type DetectionResult =
  | { readonly status: "matched"; readonly occurrenceKey: string; readonly evidenceIds: ReadonlyArray<string>; readonly facts: ReadonlyArray<CapturedFact>; readonly validUntilMs: number }
  | { readonly status: "not-matched"; readonly evidenceIds: ReadonlyArray<string>; readonly explanation: string }
  | { readonly status: "unknown"; readonly missingSourceIds: ReadonlyArray<string>; readonly explanation: string };

export type DetectorProgramInput = {
  readonly programSchemaVersion: ${DETECTOR_SDK_SCHEMA_VERSION};
  readonly asOfMs: number;
  readonly inputDigest: string;
  readonly facts: ReadonlyArray<CapturedFact>;
  readonly sources: ReadonlyArray<SealedSourceRecord>;
  readonly priorState?: unknown;
};

export type DetectorProgramOutput = {
  readonly result: DetectionResult;
  readonly nextState: unknown;
};

/** The wrapper around state you carry between runs. stateSchemaVersion is
 *  YOUR version tag for the shape you understand, so a later revision can
 *  refuse (or migrate) an older state instead of misreading it. */
export type DetectorStateEnvelope = {
  readonly stateSchemaVersion: number;
  readonly state: unknown;
};

/** The ceiling on committed state, in bytes of the canonical serialization. */
export const DETECTOR_STATE_MAX_BYTES = 262144;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Minimal structural check of one sealed input; exactness is the host's. */
export function assertDetectorInput(value: unknown): asserts value is DetectorProgramInput {
  if (
    !isPlainObject(value) ||
    value.programSchemaVersion !== ${DETECTOR_SDK_SCHEMA_VERSION} ||
    !Array.isArray(value.facts) ||
    !Array.isArray(value.sources)
  ) {
    throw new Error("DetectorProgramInput must be { programSchemaVersion: ${DETECTOR_SDK_SCHEMA_VERSION}, asOfMs, inputDigest, facts[], sources[] }");
  }
}

// Key-sorted, undefined-dropping canonical JSON: an envelope's serialization
// is a function of its content, not of which caller built the object.
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

// UTF-8 byte length without TextEncoder (not in the runner's ES2022 lib).
const byteLength = (value: string): number => {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
};

const isStateEnvelope = (value: unknown): value is DetectorStateEnvelope =>
  isPlainObject(value) &&
  typeof value.stateSchemaVersion === "number" &&
  Number.isInteger(value.stateSchemaVersion) &&
  value.stateSchemaVersion > 0 &&
  "state" in value;

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

/** Validate a state envelope and serialize it canonically under the byte cap. */
export function encodeDetectorState(envelope: unknown): EncodeDetectorStateResult {
  if (!isStateEnvelope(envelope)) return { ok: false, failure: "state-envelope-invalid" };
  let serialized: string;
  try {
    serialized = JSON.stringify(canonical(envelope));
  } catch {
    return { ok: false, failure: "state-not-serializable" };
  }
  if (byteLength(serialized) > DETECTOR_STATE_MAX_BYTES)
    return { ok: false, failure: "state-exceeds-max-bytes" };
  return { ok: true, serialized };
}

/** Parse and validate a serialized state envelope under the same byte cap. */
export function decodeDetectorState(serialized: string): DecodeDetectorStateResult {
  if (byteLength(serialized) > DETECTOR_STATE_MAX_BYTES)
    return { ok: false, failure: "state-exceeds-max-bytes" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return { ok: false, failure: "state-json-invalid" };
  }
  if (!isStateEnvelope(parsed)) return { ok: false, failure: "state-envelope-invalid" };
  return { ok: true, envelope: parsed };
}

// -- base64 document decoding (source-adapter transforms) --------------------
// The sandbox compiles with lib ES2022 only: no Buffer, no atob, no
// TextDecoder. A generated external-source transform receives its document as
// the envelope's bodyBase64 and decodes it with THIS helper — the only byte
// channel in or out beside the JSON stdin/stdout.

const BASE64_SEXTET = (() => {
  const table = new Array<number>(256).fill(-1);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (let i = 0; i < alphabet.length; i += 1) table[alphabet.charCodeAt(i)] = i;
  return table;
})();

export type Base64Failure = "base64-empty" | "base64-length-invalid" | "base64-padding-invalid" | "base64-character-invalid" | "utf8-invalid";

export type DecodeBase64Utf8Result =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly failure: Base64Failure };

/** Strictly decode standard (RFC 4648) base64 with UTF-8 payload validation.
 *  ASCII whitespace is ignored; every other deviation refuses by name. */
export function decodeBase64Utf8(input: string): DecodeBase64Utf8Result {
  let cleaned = "";
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if (code === 32 || code === 9 || code === 10 || code === 13) continue;
    cleaned += input[i];
  }
  if (cleaned.length === 0) return { ok: false, failure: "base64-empty" };
  if (cleaned.length % 4 !== 0) return { ok: false, failure: "base64-length-invalid" };
  let padding = 0;
  if (cleaned.endsWith("==")) padding = 2;
  else if (cleaned.endsWith("=")) padding = 1;
  const body = padding > 0 ? cleaned.slice(0, cleaned.length - padding) : cleaned;
  if (body.includes("=")) return { ok: false, failure: "base64-padding-invalid" };
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < body.length; i += 1) {
    const code = body.charCodeAt(i);
    const value = code < 256 ? BASE64_SEXTET[code] : -1;
    if (value < 0) return { ok: false, failure: "base64-character-invalid" };
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >>> bits) & 0xff);
    }
  }
  // The leftover bit count pins the padding shape: '=', 0, 2, or 4 bits.
  if ((padding === 0 && bits !== 0) || (padding === 1 && bits !== 2) || (padding === 2 && bits !== 4)) {
    return { ok: false, failure: "base64-length-invalid" };
  }
  let text = "";
  let i = 0;
  while (i < out.length) {
    const b0 = out[i];
    if (b0 < 0x80) {
      text += String.fromCharCode(b0);
      i += 1;
      continue;
    }
    let len: number;
    let cp: number;
    if (b0 >= 0xc2 && b0 <= 0xdf) {
      len = 2;
      cp = b0 & 0x1f;
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      len = 3;
      cp = b0 & 0x0f;
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      len = 4;
      cp = b0 & 0x07;
    } else {
      return { ok: false, failure: "utf8-invalid" };
    }
    if (i + len > out.length) return { ok: false, failure: "utf8-invalid" };
    for (let j = 1; j < len; j += 1) {
      const b = out[i + j];
      if ((b & 0xc0) !== 0x80) return { ok: false, failure: "utf8-invalid" };
      cp = (cp << 6) | (b & 0x3f);
    }
    if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return { ok: false, failure: "utf8-invalid" };
    text += String.fromCodePoint(cp);
    i += len;
  }
  return { ok: true, text };
}

const registeredTests: Array<() => void | Promise<void>> = [];
export function describe(_name: string, body: () => void): void { body(); }
export function test(_name: string, body: () => void | Promise<void>): void { registeredTests.push(body); }
export const it = test;
export function expect(actual: unknown) {
  return {
    toBe(expected: unknown): void { if (!Object.is(actual, expected)) throw new Error("values differ"); },
    toEqual(expected: unknown): void { if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("values differ"); },
    toBeDefined(): void { if (actual === undefined) throw new Error("value is undefined"); },
    toBeTruthy(): void { if (!actual) throw new Error("value is not truthy"); },
    toBeFalsy(): void { if (actual) throw new Error("value is not falsy"); },
  };
}
export async function runRegisteredTests(): Promise<number> {
  for (const body of registeredTests) await body();
  return registeredTests.length;
}

/** The entrypoint every detector exports. Synchronous and pure: the same
 *  input — including priorState — must produce the same result and nextState. */
export type Detect = (input: DetectorProgramInput) => DetectorProgramOutput;

// -- execution-policy vocabulary (mirrors trading-contracts executionPolicy) --

/** An EVM address the execution vocabulary keys on: 0x + exactly 40 hex chars. */
export type ExecutionEvmAddress = string;

/** One predeclared swap an envelope authorizes. Amount-free: caps live on the envelope. */
export type SwapCandidate = {
  readonly candidateId: string;
  readonly chainId: string;
  readonly tokenIn: ExecutionEvmAddress;
  readonly tokenOut: ExecutionEvmAddress;
  readonly recipient: ExecutionEvmAddress;
  readonly label?: string;
};

/** The immutable user-approved grant the policy proposes INSIDE. The host
 *  verifies every field before the input reaches you; you can never widen it. */
export type ExecutionEnvelope = {
  readonly revision: number;
  readonly environmentId: string;
  readonly accountId: string;
  readonly expiresAtMs: number;
  readonly detectorBundleSha256: string;
  readonly policyBundleSha256: string;
  readonly candidates: ReadonlyArray<SwapCandidate>;
  readonly inputCapTotalRaw: string;
  readonly inputCapPerSwapRaw: string;
  readonly maxGasWei: string;
  readonly maxSlippageBps: number;
  readonly maxTransactions: number;
  readonly maxConcurrentIntents: number;
};

/** One decision you emit. The host validates it against the envelope and the
 *  budget before persisting; a swap proposal carries no spending authority of
 *  its own — never expect the host to clamp an out-of-cap amount to fit. */
export type ExecutionProposal =
  | { readonly kind: "wait" }
  | { readonly kind: "price"; readonly candidateId: string; readonly reason: string }
  | {
      readonly kind: "swap";
      readonly candidateId: string;
      readonly amountInRaw: string;
      readonly quoteId: string;
      readonly occurrenceKey: string;
      readonly stageKey: string;
      readonly detectorEvaluationId: string;
    }
  | { readonly kind: "stop-future-actions"; readonly reason: string }
  | { readonly kind: "complete"; readonly summary: string };

/** The bounded three-shape detector summary you receive. Only a matched
 *  evaluation ever reaches propose(); the other outcomes are valid
 *  non-actions the host returns without running you. */
export type DetectorResultForPolicy =
  | { readonly status: "matched"; readonly occurrenceKey: string; readonly validUntilMs: number }
  | { readonly status: "not-matched"; readonly explanation: string }
  | { readonly status: "unknown"; readonly explanation: string };

/** One already-persisted proposal, newest-last, at most 20 of them. */
export type PersistedProposalSummary = {
  readonly stageKey: string;
  readonly kind: "wait" | "price" | "swap" | "stop-future-actions" | "complete";
  readonly amountInRaw?: string;
  readonly occurredAtMs: number;
};

/** Everything you are fed, exactly (policy schema version 2). */
export type PolicyInput = {
  readonly policySchemaVersion: 2;
  readonly asOfMs: number;
  readonly envelope: ExecutionEnvelope;
  readonly detectorEvaluation: {
    readonly evaluationId: string;
    readonly asOfMs: number;
    readonly result: DetectorResultForPolicy;
  };
  readonly priorProposals: ReadonlyArray<PersistedProposalSummary>;
  readonly remainingInputCapRaw: string;
  readonly priorState?: unknown;
};

/** What you return: one proposal plus the state carried to your next run.
 *  nextState is a DetectorStateEnvelope — the SAME wrapper and byte cap the
 *  detector uses, but a SEPARATE lineage: your state rows never mix with the
 *  detector's. */
export type PolicyOutput = {
  readonly proposal: ExecutionProposal;
  readonly nextState: unknown;
};

/** The entrypoint every execution policy exports. Synchronous and pure: the
 *  same input — including priorState — must produce the same proposal and
 *  nextState. No clock (asOfMs is the only time you see), no network or fetch,
 *  no environment or process access, no host callbacks. */
export type Propose = (input: PolicyInput) => PolicyOutput;
`;

/** The v2 authoring brief's data-schema prose, rendered once. */
export const FORGE_DATA_SCHEMA_CONTEXT_V2 = [
  "Detector-program data contract (host-sealed, exact):",
  "- Facts arrive SEALED as-of the host clock: programSchemaVersion pins the SDK generation,",
  "  asOfMs is the only time your detector ever sees, and inputDigest is the host-computed",
  "  digest over facts+sources that you may echo but never recompute the meaning of.",
  "- Each CapturedFact carries its evidence references; keys and entityIds are opaque strings",
  "  pinned by your manifest's outputFactKeys.",
  '- Sources may be incomplete or unqualified (complete: false, availabilityBasis "unknown").',
  "  Treat an unqualified or incomplete source as unknown — never as absence of evidence.",
  "  An unknown conclusion blocks new exposure; it is a first-class outcome, not an error.",
  "- State is yours: priorState is what your previous run committed (absent on the first run),",
  "  nextState is what this run commits, envelope-bounded through the SDK helpers at",
  "  DETECTOR_STATE_MAX_BYTES. A program that outgrows the cap must re-derive, not remember.",
  "- Return exactly one DetectionResult (matched | not-matched | unknown) beside nextState.",
].join("\n");

/**
 * Entrypoints — the pinned runner image's contract. Distinct heads so a
 * scripted runner (and the image itself) can never confuse one step for
 * another.
 */
export const FORGE_RUNNER_TYPECHECK = ["forge-typecheck"] as const;
export const FORGE_RUNNER_TEST = ["forge-test"] as const;
export const FORGE_RUNNER_EVALUATE = ["forge-evaluate"] as const;
/** The detector-program (v2) evaluation head — a distinct shim, so a scripted
 *  runner (and the image itself) can never confuse the two generations. */
export const FORGE_RUNNER_EVALUATE_V2 = ["forge-evaluate-v2"] as const;

// ---------------------------------------------------------------------------
// Static artifact validation (host, before anything executes)
// ---------------------------------------------------------------------------

/** Import specifiers generated TypeScript may reference. Nothing else. */
const ALLOWED_IMPORT_SPECIFIERS = new Set(["./sdk", "./signal"]);

const IMPORT_PATTERN =
  /(?:import|export)\s[^;]*?from\s*["']([^"']+)["']|require\s*\(\s*["']([^"']+)["']\s*\)|import\s*\(\s*["']([^"']+)["']\s*\)/g;

/** Every import an artifact declares — used to refuse anything outside the SDK. */
export function declaredImports(source: string): ReadonlyArray<string> {
  const found: Array<string> = [];
  for (const match of source.matchAll(IMPORT_PATTERN)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (specifier !== undefined) found.push(specifier);
  }
  return found;
}

export interface ForgeArtifactSet {
  readonly contents: Readonly<Record<string, string>>;
}

export type ForgeArtifactValidation =
  | { readonly status: "ok"; readonly artifacts: ForgeArtifactSet }
  | { readonly status: "refused"; readonly reason: string };

/**
 * The four-artifact contract, enforced before any code runs: exactly the four
 * names, no extras, bounded size, no imports outside the typed SDK, a
 * `query.graphql` that is structurally the pinned source query, and a
 * manifest that decodes and matches the requested identity.
 */
export function validateAuthoredArtifacts(input: {
  readonly contents: Readonly<Record<string, string>>;
  readonly expectedCapabilityId: string;
  readonly expectedVersion: number;
}): ForgeArtifactValidation {
  const names = Object.keys(input.contents).sort();
  const expected = [...FORGE_CAPABILITY_ARTIFACT_PATHS].sort();
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
    return {
      status: "refused",
      reason: `the bundle must be exactly ${expected.join(", ")} — found ${names.join(", ") || "nothing"}`,
    };
  }
  const totalBytes = expected.reduce(
    (sum, path) => sum + Buffer.byteLength(input.contents[path] ?? "", "utf8"),
    0,
  );
  if (totalBytes > FORGE_MAX_BUNDLE_BYTES) {
    return {
      status: "refused",
      reason: `the four artifacts total ${totalBytes} bytes, over the ${FORGE_MAX_BUNDLE_BYTES} byte cap`,
    };
  }
  for (const path of ["signal.ts", "signal.test.ts"]) {
    if ((input.contents[path] ?? "").trim() === "") {
      return { status: "refused", reason: `${path} is empty` };
    }
    for (const specifier of declaredImports(input.contents[path] ?? "")) {
      if (!ALLOWED_IMPORT_SPECIFIERS.has(specifier)) {
        return {
          status: "refused",
          reason: `${path} imports ${JSON.stringify(specifier)}; only the typed SDK (./sdk, ./signal) is allowed`,
        };
      }
    }
  }
  // The authored query is validated structurally here — at authoring time —
  // so a bad query fails the build long before any evaluation could run it.
  const queryCheck = validateForgeCapabilityQuery(input.contents["query.graphql"] ?? "");
  if (!queryCheck.ok) {
    return { status: "refused", reason: `query.graphql: ${queryCheck.reason}` };
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(input.contents["manifest.json"] ?? "");
  } catch {
    return { status: "refused", reason: "manifest.json is not valid JSON" };
  }
  try {
    const parsed = Schema.decodeUnknownSync(ForgeCapabilityManifest)(manifest);
    if (parsed.capabilityId !== input.expectedCapabilityId) {
      return {
        status: "refused",
        reason: `manifest names capability ${parsed.capabilityId}, the build is for ${input.expectedCapabilityId}`,
      };
    }
    if (parsed.version !== input.expectedVersion) {
      return {
        status: "refused",
        reason: `manifest declares v${parsed.version}, the build is for v${input.expectedVersion}`,
      };
    }
  } catch (error) {
    return {
      status: "refused",
      reason: `manifest.json does not satisfy the contract: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return { status: "ok", artifacts: { contents: input.contents } };
}

// ---------------------------------------------------------------------------
// Static validation — detector-program (v2)
// ---------------------------------------------------------------------------

/**
 * Tags the staged version header's description so any reader of the current
 * (v1-typed) store record can see the bundle is a detector-program v2 one.
 * The authoritative v2 manifest stays byte-exact in the bundle contents.
 */
const DETECTOR_V2_MANIFEST_TAG = "[detector-program v2] ";

/**
 * The paths whose hashes the staged v2 version record carries — exactly four,
 * because the current store's `stageVersion` accepts only a four-entry
 * artifact array (see the staging note in `check`). Optional artifacts ride
 * in the bundle contents and the authored manifest; P4.3's role-aware store
 * supersedes this shape.
 */
const DETECTOR_V2_REQUIRED_HASH_PATHS = [
  "detector.test.ts",
  "detector.ts",
  "manifest.json",
  "sdk.ts",
] as const;

/** The source-adapter bundle's staged hash paths (same four-entry shape). */
const SOURCE_ADAPTER_V2_REQUIRED_HASH_PATHS = [
  "manifest.json",
  "sample-document.json",
  "sdk.ts",
  "transform.ts",
] as const;

/**
 * The parse head: the runner image's `parse-v2` shim (compiled `transform.ts`,
 * sync `parseDocument` export, document envelope JSON on stdin, `{ records }`
 * stdout). Kept structurally identical to the research service's envelope.
 */
export const FORGE_RUNNER_PARSE_V2 = ["forge-parse-v2"] as const;

/**
 * The detector-program (v2) artifact contract, enforced before any code runs.
 *
 * Dispatch happens on the manifest's `manifestVersion` BEFORE any v1 decode
 * (the v1 `ForgeCapabilityManifest` filter would reject a v2 manifest — the
 * discriminator trap). The file set is role-derived through
 * `detectorArtifactPaths`: the manifest's declared paths plus `manifest.json`,
 * with the host-mounted `sdk.ts` validated by its declared hash against the
 * exact bytes this server mounts. The v1 four-path constant is never touched.
 */
export function validateAuthoredDetectorArtifacts(input: {
  readonly contents: Readonly<Record<string, string>>;
  readonly expectedCapabilityId: string;
  readonly expectedVersion: number;
}): ForgeArtifactValidation {
  let manifest: unknown;
  try {
    manifest = JSON.parse(input.contents["manifest.json"] ?? "");
  } catch {
    return { status: "refused", reason: "manifest.json is not valid JSON" };
  }
  let parsed: CapabilityManifestV2;
  try {
    parsed = Schema.decodeUnknownSync(CapabilityManifestV2)(manifest);
  } catch (error) {
    return {
      status: "refused",
      reason: `manifest.json does not satisfy the detector-program v2 contract: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (parsed.capabilityId !== input.expectedCapabilityId) {
    return {
      status: "refused",
      reason: `manifest names capability ${parsed.capabilityId}, the build is for ${input.expectedCapabilityId}`,
    };
  }
  if (parsed.version !== input.expectedVersion) {
    return {
      status: "refused",
      reason: `manifest declares v${parsed.version}, the build is for v${input.expectedVersion}`,
    };
  }
  const paths = detectorArtifactPaths(parsed);
  if ("refusal" in paths) {
    return { status: "refused", reason: `manifest artifacts: ${paths.refusal}` };
  }
  // sdk.ts is host-mounted, never authored: the file set is the declared
  // paths without it, plus the manifest itself.
  const expected = [...paths.paths.filter((path) => path !== "sdk.ts"), "manifest.json"].sort();
  const names = Object.keys(input.contents).sort();
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
    return {
      status: "refused",
      reason: `the detector bundle must be exactly ${expected.join(", ")} — found ${names.join(", ") || "nothing"}`,
    };
  }
  const totalBytes = expected.reduce(
    (sum, path) => sum + Buffer.byteLength(input.contents[path] ?? "", "utf8"),
    0,
  );
  if (totalBytes > FORGE_MAX_BUNDLE_BYTES) {
    return {
      status: "refused",
      reason: `the detector bundle totals ${totalBytes} bytes, over the ${FORGE_MAX_BUNDLE_BYTES} byte cap`,
    };
  }
  // Kind-aware program checks: a detector bundle centers detector.ts with its
  // generated test; a source-adapter bundle centers transform.ts with a real
  // sample document the host parses at check time. The exact file-set
  // comparison above already excludes a detector file from a source-adapter
  // bundle and vice versa.
  if (v2BundleKind(parsed) === "source-adapter") {
    if ((input.contents["transform.ts"] ?? "").trim() === "") {
      return { status: "refused", reason: "transform.ts is empty" };
    }
    const sample = input.contents["sample-document.json"] ?? "";
    if (sample.trim() === "") {
      return { status: "refused", reason: "sample-document.json is empty" };
    }
    let parsedSample: unknown;
    try {
      parsedSample = JSON.parse(sample);
    } catch {
      return { status: "refused", reason: "sample-document.json is not valid JSON" };
    }
    const sampleRecord =
      typeof parsedSample === "object" && parsedSample !== null && !Array.isArray(parsedSample)
        ? (parsedSample as Record<string, unknown>)
        : null;
    if (
      sampleRecord === null ||
      typeof sampleRecord["bodyBase64"] !== "string" ||
      sampleRecord["bodyBase64"] === ""
    ) {
      return {
        status: "refused",
        reason:
          "sample-document.json must be an object carrying the captured document as bodyBase64",
      };
    }
  } else {
    for (const path of ["detector.ts", "detector.test.ts"]) {
      if ((input.contents[path] ?? "").trim() === "") {
        return { status: "refused", reason: `${path} is empty` };
      }
    }
  }
  // A declared execution policy is a program too: empty bytes are not one.
  // Generated tests for policy.ts stay OPTIONAL (the artifact closure does
  // not require them) — only the program file itself must be non-empty.
  const declaresPolicy = parsed.artifacts.some((artifact) => artifact.role === "execution-policy");
  if (declaresPolicy && (input.contents["policy.ts"] ?? "").trim() === "") {
    return { status: "refused", reason: "policy.ts is empty" };
  }
  // The sdk role pins the SDK generation: its declared hash must be the exact
  // bytes this server mounts at sdk.ts.
  const sdkArtifact = parsed.artifacts.find((artifact) => artifact.role === "sdk");
  if (sdkArtifact === undefined || sdkArtifact.sha256 !== forgeSha256Hex(FORGE_SDK_SOURCE_V2)) {
    return {
      status: "refused",
      reason:
        "the sdk artifact hash does not pin this server's detector SDK; declare the sha256 from the authoring brief",
    };
  }
  // Every other declared hash must match the authored bytes the host just read.
  for (const artifact of parsed.artifacts) {
    if (artifact.role === "sdk") continue;
    if (artifact.sha256 !== forgeSha256Hex(input.contents[artifact.path] ?? "")) {
      return { status: "refused", reason: `${artifact.path} does not match its declared sha256` };
    }
  }
  // Imports: the authored program may reference the SDK, the detector entry,
  // and the optional modules its manifest declared — nothing else. A declared
  // execution policy widens the set with ./policy exactly as a declared
  // transform widens it with ./transform (policy.ts imports ./sdk; other
  // authored files may import ./policy).
  const allowedImports = new Set<string>(["./sdk", "./detector"]);
  if (parsed.artifacts.some((artifact) => artifact.role === "transform")) {
    allowedImports.add("./transform");
  }
  if (parsed.artifacts.some((artifact) => artifact.role === "state-schema")) {
    allowedImports.add("./state-schema");
  }
  if (declaresPolicy) {
    allowedImports.add("./policy");
  }
  for (const path of names) {
    if (!path.endsWith(".ts")) continue;
    for (const specifier of declaredImports(input.contents[path] ?? "")) {
      if (!allowedImports.has(specifier)) {
        return {
          status: "refused",
          reason: `${path} imports ${JSON.stringify(specifier)}; only the detector SDK modules (${[...allowedImports].sort().join(", ")}) are allowed`,
        };
      }
    }
  }
  // A declared query rides the same structural validator as v1 — v2 never
  // weakens the query contract.
  const query = input.contents["query.graphql"];
  if (query !== undefined) {
    const queryCheck = validateForgeCapabilityQuery(query);
    if (!queryCheck.ok) {
      return { status: "refused", reason: `query.graphql: ${queryCheck.reason}` };
    }
  }
  // The staged version header renders `[detector-program v2] <semantics>` into
  // a v1-typed description field bounded by FORGE_MAX_SEMANTICS_CHARS.
  const semanticsLimit = FORGE_MAX_SEMANTICS_CHARS - DETECTOR_V2_MANIFEST_TAG.length;
  if (parsed.semantics.length > semanticsLimit) {
    return {
      status: "refused",
      reason: `manifest semantics must be at most ${semanticsLimit} characters`,
    };
  }
  return { status: "ok", artifacts: { contents: input.contents } };
}

/**
 * Every workspace name the reader accepts: the v1 four plus the detector-v2
 * role paths (sdk.ts among them, so a v2 workspace that copied the SDK is
 * still read — the per-version validators then decide the exact set). Which
 * bundle a workspace actually is gets decided AFTER the read, on the staged
 * manifest's manifestVersion.
 */
export const FORGE_WORKSPACE_READ_PATHS: ReadonlyArray<string> = [
  ...new Set([
    ...FORGE_CAPABILITY_ARTIFACT_PATHS,
    ...Object.values(DETECTOR_V2_ARTIFACT_ROLES).map((role) => role.path),
  ]),
];

/**
 * Read the authoring workspace: exactly the allowed flat files, all regular
 * files (a symlink is a refusal, not a shortcut), nothing else alongside.
 * The default allowlist is the v1 four; the check pipeline reads with the
 * v1∪v2 union and dispatches on the staged manifest afterwards.
 */
export const readAuthoringWorkspace = async (
  stagingDir: string,
  allowedPaths: readonly string[] = FORGE_CAPABILITY_ARTIFACT_PATHS,
): Promise<Record<string, string>> => {
  if ((await NodeFs.lstat(stagingDir)).isSymbolicLink())
    throw new Error("refusing a symlink authoring workspace");
  const entries = await NodeFs.readdir(stagingDir, { withFileTypes: true });
  let totalBytes = 0;
  const contents: Record<string, string> = {};
  for (const entry of entries) {
    if (!allowedPaths.includes(entry.name)) {
      throw new Error(`unexpected file in the authoring workspace: ${entry.name}`);
    }
    if (entry.isSymbolicLink()) {
      throw new Error(`refusing symlink in the authoring workspace: ${entry.name}`);
    }
    if (!entry.isFile()) {
      throw new Error(`refusing non-file entry in the authoring workspace: ${entry.name}`);
    }
    const resolved = NodePath.resolve(stagingDir, entry.name);
    if (!resolved.startsWith(NodePath.resolve(stagingDir) + NodePath.sep)) {
      throw new Error(`refusing path traversal in the authoring workspace: ${entry.name}`);
    }
    const handle = await NodeFs.open(resolved, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      totalBytes += stat.size;
      if (!stat.isFile() || totalBytes > FORGE_MAX_BUNDLE_BYTES)
        throw new Error("bundle exceeds its file or size bounds");
      const buffer = Buffer.alloc(stat.size + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead !== stat.size) throw new Error("artifact changed during read");
      contents[entry.name] = buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  }
  return contents;
};

// ---------------------------------------------------------------------------
// The sealed report the host computes
// ---------------------------------------------------------------------------

export interface ForgeSealedBundle {
  readonly version: ForgeCapabilityVersion;
  readonly contents: Record<string, string>;
}

/** Canonical bundle hash: the four artifacts, in contract order, joined. */
export function forgeBundleSha256(contents: Readonly<Record<string, string>>): string {
  return forgeSha256Hex(
    FORGE_CAPABILITY_ARTIFACT_PATHS.map((path) => contents[path] ?? "").join(
      "\n---forge-artifact---\n",
    ),
  );
}

/**
 * Canonical detector-bundle hash: every bundle path (authored files plus the
 * host-mounted sdk.ts, optionals included), sorted, joined with the same
 * separator as v1 — the identity a v2 install pins.
 */
export function forgeDetectorBundleSha256(contents: Readonly<Record<string, string>>): string {
  return forgeSha256Hex(
    Object.keys(contents)
      .sort()
      .map((path) => contents[path] ?? "")
      .join("\n---forge-artifact---\n"),
  );
}

/** Validate a capability's own diagnostics against its input window. */
export function validateDiagnosticsAgainstInput(
  output: {
    readonly reading: ForgeSignalReading;
    readonly diagnostics: ReadonlyArray<{
      readonly poolId: string;
      readonly tradeIds: ReadonlyArray<string>;
    }>;
  },
  input: ForgeSignalInput,
): string | null {
  const knownIds = new Set<string>();
  const knownPools = new Set<string>();
  for (const pool of input.pools) {
    knownPools.add(pool.poolId);
    for (const id of pool.observationIds) knownIds.add(id);
  }
  if (
    output.reading.kind === "ready" &&
    output.reading.eligiblePoolIds.some((id) => !knownPools.has(id))
  )
    return "reading names an unknown eligible pool";
  const seenPools = new Set<string>();
  for (const diagnostic of output.diagnostics) {
    if (seenPools.has(diagnostic.poolId)) return "duplicate pool diagnostics";
    seenPools.add(diagnostic.poolId);
    const pool = input.pools.find((candidate) => candidate.poolId === diagnostic.poolId);
    const poolIds = new Set(pool?.observationIds ?? []);
    if (!knownPools.has(diagnostic.poolId)) {
      return `diagnostics name pool ${diagnostic.poolId}, which the input window does not hold`;
    }
    for (const tradeId of diagnostic.tradeIds) {
      if (!poolIds.has(tradeId)) {
        return `diagnostics reference trade ${tradeId}, which the input window does not hold`;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The builder service
// ---------------------------------------------------------------------------

export interface ForgeAuthoringBrief {
  readonly schemaVersion: number;
  readonly sdkSource: string;
  readonly dataSchema: string;
  readonly stagingDir: string;
  readonly artifactContract: string;
}

export type ForgeBuilderFailure =
  | { readonly kind: "invalid_request"; readonly reason: string }
  | { readonly kind: "sandbox"; readonly reason: string }
  | { readonly kind: "store"; readonly reason: string };

export class ForgeBuilderError extends Data.TaggedError("ForgeBuilderError")<{
  readonly failure: ForgeBuilderFailure;
}> {
  constructor(failure: ForgeBuilderFailure) {
    super({ failure });
  }

  override get message(): string {
    return `forge builder: ${this.failure.kind}: ${this.failure.reason}`;
  }
}

export interface ForgeCapabilityBuilderShape {
  /** Start a build and hand back the authoring brief (stages: requested → inspecting → authoring). */
  readonly prepare: (input: {
    readonly environmentId: string;
    readonly threadId?: string | undefined;
    readonly capabilityId: string;
    readonly requestedSemantics: string;
    /** The directory in the caller's workspace where the four artifacts must land. */
    readonly stagingDir: string;
    /**
     * Which SDK generation the brief targets: 1 (pool signal, the default) or
     * 2 (detector program over sealed facts). Additive — every existing v1
     * caller omits it and gets the v1 brief unchanged.
     */
    readonly manifestVersion?: 1 | 2 | undefined;
  }) => Effect.Effect<
    { readonly build: ForgeBuildReceipt; readonly brief: ForgeAuthoringBrief },
    ForgeBuilderError
  >;
  /**
   * Read the authored workspace, validate, and run the full containment
   * pipeline. On success the version is staged READY — never installed.
   *
   * The pipeline dispatches on the staged manifest's `manifestVersion`: a v1
   * manifest runs the pool-signal path byte-identically; a v2 manifest runs
   * the detector-program path with v2 acceptance cases (`acceptanceV2`,
   * host-reviewed data the handler layer reads from the stateDir — the
   * reader wiring lands with the handler slice).
   */
  readonly check: (input: {
    readonly buildId: string;
    readonly environmentId: string;
    readonly stagingDir: string;
    readonly acceptanceCases: ReadonlyArray<ForgeAcceptanceCase>;
    /** Host-reviewed v2 acceptance cases; required (≥1) when the staged manifest is v2. */
    readonly acceptanceV2?: ReadonlyArray<ForgeAcceptanceCaseV2> | undefined;
  }) => Effect.Effect<
    { readonly build: ForgeBuildReceipt; readonly staged: ForgeSealedBundle | null },
    ForgeBuilderError
  >;
}

export class ForgeCapabilityBuilder extends Context.Service<
  ForgeCapabilityBuilder,
  ForgeCapabilityBuilderShape
>()("t3/trading/forge/CapabilityBuilder/ForgeCapabilityBuilder") {}

const toBuilderError = (error: unknown): ForgeBuilderError =>
  error instanceof ForgeBuilderError
    ? error
    : new ForgeBuilderError({
        kind: "store",
        reason: error instanceof Error ? error.message : String(error),
      });

/** The manifest decode, hoisted out of the generator: a refused manifest is
 * already handled by static validation; this read-back is a belt-and-braces
 * decode of bytes the host itself just validated. */
const decodeManifest = (raw: string): ForgeCapabilityManifest =>
  Schema.decodeUnknownSync(ForgeCapabilityManifest)(parseJsonOr(raw, {}));

/** The v2 counterpart of decodeManifest: bytes static validation already decoded. */
const decodeManifestV2 = (raw: string): CapabilityManifestV2 =>
  Schema.decodeUnknownSync(CapabilityManifestV2)(parseJsonOr(raw, {}));

/** The one decoder every contained evaluation runs: the SDK's output contract. */
const decodeForgeSignalOutput = (value: unknown): unknown =>
  Schema.decodeUnknownSync(ForgeSignalOutput)(value);

/** The v2 evaluation decoder: the detector-program output contract. */
const decodeDetectorProgramOutputV2 = (value: unknown): unknown =>
  Schema.decodeUnknownSync(DetectorProgramOutputV2)(value);

/** JSON.parse whose failure degrades to a value the manifest decode refuses. */
const parseJsonOr = (raw: string, fallback: unknown): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
};

export const makeForgeCapabilityBuilder = Effect.gen(function* () {
  const store: ForgeCapabilityStoreShape = yield* ForgeCapabilityStore;
  const sandbox: ForgeCapabilitySandboxShape = yield* ForgeCapabilitySandbox;

  const failStage = (buildId: string, reason: string): Effect.Effect<never, ForgeBuilderError> =>
    store
      .appendBuildStage({
        buildId,
        stage: "failed",
        detail: reason,
        patch: { failureReason: reason },
      })
      .pipe(
        Effect.mapError(toBuilderError),
        Effect.andThen(new ForgeBuilderError({ kind: "sandbox", reason })),
      );

  /** The reason line out of a failed contained run — never a pass string. */
  const sandboxFailureReason = (cause: Cause.Cause<ForgeSandboxError>): string => {
    const squashed = Cause.squash(cause);
    return squashed instanceof ForgeSandboxError
      ? squashed.failure.reason
      : String(squashed).slice(0, 200);
  };

  const prepare: ForgeCapabilityBuilderShape["prepare"] = ({
    environmentId,
    threadId,
    capabilityId,
    requestedSemantics,
    stagingDir,
    manifestVersion = 1,
  }) =>
    Effect.gen(function* () {
      if (
        requestedSemantics.trim() === "" ||
        requestedSemantics.length > FORGE_MAX_SEMANTICS_CHARS
      ) {
        return yield* new ForgeBuilderError({
          kind: "invalid_request",
          reason: `requestedSemantics must be 1..${FORGE_MAX_SEMANTICS_CHARS} characters`,
        });
      }
      const started = yield* store
        .startBuild({
          environmentId,
          ...(threadId === undefined ? {} : { threadId }),
          capabilityId,
          requestedSemantics,
        })
        .pipe(Effect.mapError(toBuilderError));
      yield* store
        .appendBuildStage({
          buildId: started.buildId,
          stage: "inspecting",
          detail: "host inspected the configured sources",
        })
        .pipe(Effect.mapError(toBuilderError));
      const authoring = yield* store
        .appendBuildStage({
          buildId: started.buildId,
          stage: "authoring",
          detail: "authoring brief handed to the calling agent's workspace",
        })
        .pipe(Effect.mapError(toBuilderError));
      const version = yield* store
        .nextVersion({ environmentId, capabilityId })
        .pipe(Effect.mapError(toBuilderError));
      const brief: ForgeAuthoringBrief =
        manifestVersion === 2
          ? {
              schemaVersion: DETECTOR_SDK_SCHEMA_VERSION,
              sdkSource: FORGE_SDK_SOURCE_V2,
              dataSchema: [
                `${FORGE_DATA_SCHEMA_CONTEXT_V2}\nAuthor manifest.version as ${version}; immutable retained versions are never reused.`,
                `The manifest is detector-program v2: manifestVersion 2, your capabilityId, this version,`,
                `requiredSourceIds, outputFactKeys, createdAtMs, and one artifact entry per declared file.`,
                `Declare the sdk artifact as { "role": "sdk", "path": "sdk.ts", "sha256": "${forgeSha256Hex(FORGE_SDK_SOURCE_V2)}" };`,
                `the host mounts those exact bytes — never author sdk.ts yourself.`,
              ].join("\n"),
              stagingDir,
              artifactContract:
                "detector program: manifest.json, detector.ts, detector.test.ts (plus each optional transform.ts / state-schema.ts / query.graphql / policy.ts you declare). SOURCE ADAPTER instead of a detector: manifest.json, transform.ts (exports sync parseDocument(envelope) -> {records}), and sample-document.json ({bodyBase64: a real captured document}) as the acceptance artifact — declare NO detector role; transform imports only ./sdk (decodeBase64Utf8 lives there); the host parses your sample through the transform in containment at check time",
            }
          : {
              schemaVersion: FORGE_SDK_SCHEMA_VERSION,
              sdkSource: FORGE_SDK_SOURCE,
              dataSchema: `${FORGE_DATA_SCHEMA_CONTEXT}\nAuthor manifest.version as ${version}; immutable retained versions are never reused.`,
              stagingDir,
              artifactContract: FORGE_CAPABILITY_ARTIFACT_PATHS.join(", "),
            };
      return { build: authoring, brief };
    });

  /**
   * The detector-program (v2) check pipeline: static validation, the shared
   * typecheck and generated-test runs, HOST-owned v2 acceptance (a sealed
   * input → exactly one DetectionResult + nextState, both compared by the
   * host), a determinism double-run over the WHOLE output including state,
   * and staging under the current store's shape.
   *
   * The v2 acceptance-case reader from the stateDir lands with the handler
   * slice; here the cases arrive as a parameter, and ≥1 is required — a
   * module nothing exercised cannot be certified.
   */
  const checkDetectorV2 = (input: {
    readonly buildId: string;
    readonly environmentId: string;
    readonly capabilityId: string;
    readonly nextVersion: number;
    readonly contents: Record<string, string>;
    readonly acceptanceV2: ReadonlyArray<ForgeAcceptanceCaseV2>;
  }): Effect.Effect<
    { readonly build: ForgeBuildReceipt; readonly staged: ForgeSealedBundle | null },
    ForgeBuilderError
  > =>
    Effect.gen(function* () {
      const { buildId, environmentId, capabilityId, nextVersion, contents, acceptanceV2 } = input;
      const validated = validateAuthoredDetectorArtifacts({
        contents,
        expectedCapabilityId: capabilityId,
        expectedVersion: nextVersion,
      });
      if (validated.status === "refused") {
        return yield* failStage(buildId, validated.reason);
      }
      yield* store
        .appendBuildStage({
          buildId,
          stage: "checking",
          detail: "detector bundle accepted for containment",
        })
        .pipe(Effect.mapError(toBuilderError));

      const manifest = decodeManifestV2(contents["manifest.json"] ?? "{}");
      const bundleKind = v2BundleKind(manifest);
      // The sealed bundle the runs mount and the store stages: the authored
      // files plus the exact host SDK bytes mounted at sdk.ts.
      const bundleContents: Record<string, string> = {
        ...contents,
        "sdk.ts": FORGE_SDK_SOURCE_V2,
      };
      const bundlePaths = Object.keys(bundleContents).sort();
      const artifactSha256 = bundlePaths.map((path) => ({
        path,
        sha256: forgeSha256Hex(bundleContents[path] ?? ""),
      }));
      const bundleSha256 = forgeDetectorBundleSha256(bundleContents);
      const files: Array<ForgeSandboxFile> = bundlePaths.map((path) => ({
        path,
        content: bundleContents[path] ?? "",
      }));

      const checks: Array<ForgeCheckOutcome> = [];

      // -- compile + typecheck (host-run, contained; entrypoint shared) ------
      const typecheck = yield* sandbox
        .runBuildStep({ files, entrypoint: [...FORGE_RUNNER_TYPECHECK] })
        .pipe(Effect.exit);
      if (typecheck._tag === "Failure") {
        return yield* failStage(
          buildId,
          `typecheck failed closed: ${sandboxFailureReason(typecheck.cause)}`,
        );
      }
      checks.push({ name: "typecheck", passed: true, exitCode: typecheck.value.exitCode });

      // The acceptance summary the ready patch reports; the source-adapter
      // branch fills its own below.
      let detectorAcceptance: {
        total: number;
        passed: number;
        failed: Array<{ name: string; reason: string }>;
      } = { total: acceptanceV2.length, passed: acceptanceV2.length, failed: [] };

      if (bundleKind === "source-adapter") {
        // -- source-adapter acceptance: parse the REAL staged sample ----------
        // The sample document IS the acceptance case: the transform must turn
        // the captured bytes into a records array, deterministically, inside
        // containment. No generated test file exists for a parse.
        const envelope = JSON.stringify({
          schemaVersion: 1,
          sourceId: capabilityId,
          url: "sample",
          contentType: "application/json",
          capturedAtMs: Date.now(),
          bodyBase64: (
            JSON.parse(contents["sample-document.json"] ?? "{}") as {
              bodyBase64?: unknown;
            }
          )["bodyBase64"],
        });
        const decodeParseOutput = (value: unknown): unknown => {
          if (typeof value !== "object" || value === null || Array.isArray(value)) {
            throw new ForgeSandboxError({
              kind: "invalid_result",
              reason: "adapter output must be a JSON object",
            });
          }
          if (!Array.isArray((value as Record<string, unknown>)["records"])) {
            throw new ForgeSandboxError({
              kind: "invalid_result",
              reason: "adapter output must carry a records array",
            });
          }
          return value;
        };
        const parseChecks = [
          yield* sandbox
            .runEvaluation({
              files,
              entrypoint: [...FORGE_RUNNER_PARSE_V2],
              stdinJson: envelope,
              decodeResult: decodeParseOutput,
            })
            .pipe(Effect.exit),
          yield* sandbox
            .runEvaluation({
              files,
              entrypoint: [...FORGE_RUNNER_PARSE_V2],
              stdinJson: envelope,
              decodeResult: decodeParseOutput,
            })
            .pipe(Effect.exit),
        ];
        if (parseChecks.some((outcome) => outcome._tag === "Failure")) {
          const firstFailure = parseChecks.find((outcome) => outcome._tag === "Failure");
          return yield* failStage(
            buildId,
            `sample parse failed closed: ${
              firstFailure && firstFailure._tag === "Failure"
                ? sandboxFailureReason(firstFailure.cause)
                : "unknown"
            }`,
          );
        }
        const determinismPassed =
          parseChecks[0]?._tag === "Success" &&
          parseChecks[1]?._tag === "Success" &&
          JSON.stringify(parseChecks[0].value) === JSON.stringify(parseChecks[1].value);
        checks.push({ name: "parse-acceptance", passed: true });
        checks.push({ name: "determinism", passed: determinismPassed });
        if (!determinismPassed) {
          return yield* failStage(
            buildId,
            "the source adapter was not deterministic on the identical sample document",
          );
        }
      } else {
        // -- the generated tests (detector.test.ts, their own run) ------------
        const tests = yield* sandbox
          .runBuildStep({ files, entrypoint: [...FORGE_RUNNER_TEST] })
          .pipe(Effect.exit);
        if (tests._tag === "Failure") {
          return yield* failStage(
            buildId,
            `generated tests failed closed: ${sandboxFailureReason(tests.cause)}`,
          );
        }
        checks.push({ name: "generated-tests", passed: true, exitCode: tests.value.exitCode });

        // -- host-owned acceptance (v2): the host compares result AND state ----
        const failedCases: Array<{ name: string; reason: string }> = [];
        for (const example of acceptanceV2) {
          if (!Schema.is(DetectorProgramInputV2)(example.input)) {
            failedCases.push({
              name: example.name,
              reason: "the case input is not a sealed DetectorProgramInputV2",
            });
            continue;
          }
          const actual = yield* sandbox
            .runEvaluation({
              files,
              entrypoint: [...FORGE_RUNNER_EVALUATE_V2],
              stdinJson: JSON.stringify(example.input),
              decodeResult: decodeDetectorProgramOutputV2,
            })
            .pipe(Effect.exit);
          if (actual._tag === "Failure") {
            failedCases.push({ name: example.name, reason: sandboxFailureReason(actual.cause) });
            continue;
          }
          const output = actual.value as DetectorProgramOutputV2;
          const expectedResult = JSON.stringify(example.expected.result);
          const gotResult = JSON.stringify(output.result);
          if (expectedResult !== gotResult) {
            failedCases.push({
              name: example.name,
              reason: `expected result ${expectedResult}, got ${gotResult}`,
            });
            continue;
          }
          const expectedState = JSON.stringify(example.expected.nextState);
          const gotState = JSON.stringify(output.nextState);
          if (expectedState !== gotState) {
            failedCases.push({
              name: example.name,
              reason: `expected nextState ${expectedState}, got ${gotState}`,
            });
          }
        }
        const acceptancePassed = acceptanceV2.length - failedCases.length;
        checks.push({
          name: "acceptance",
          passed: failedCases.length === 0,
          ...(failedCases.length === 0
            ? {}
            : {
                detail: failedCases
                  .map((failure) => `${failure.name}: ${failure.reason}`)
                  .join("; ")
                  .slice(0, 2_000),
              }),
        });

        // Empty caller cases cannot certify a module without exercising it —
        // the same rule the v1 path holds.
        const determinismInput = acceptanceV2[0]?.input;
        if (determinismInput === undefined)
          return yield* failStage(
            buildId,
            "at least one independent host acceptance case is required",
          );
        const first = yield* sandbox
          .runEvaluation({
            files,
            entrypoint: [...FORGE_RUNNER_EVALUATE_V2],
            stdinJson: JSON.stringify(determinismInput),
            decodeResult: decodeDetectorProgramOutputV2,
          })
          .pipe(Effect.exit);
        const second = yield* sandbox
          .runEvaluation({
            files,
            entrypoint: [...FORGE_RUNNER_EVALUATE_V2],
            stdinJson: JSON.stringify(determinismInput),
            decodeResult: decodeDetectorProgramOutputV2,
          })
          .pipe(Effect.exit);
        // The double-run covers the WHOLE output JSON: result and nextState
        // together — a detector whose state drifts is not deterministic.
        const determinismPassed =
          first._tag === "Success" &&
          second._tag === "Success" &&
          JSON.stringify(first.value) === JSON.stringify(second.value);
        checks.push({ name: "determinism", passed: determinismPassed });

        const allPassed = failedCases.length === 0 && determinismPassed;
        if (!allPassed) {
          return yield* failStage(
            buildId,
            failedCases.length > 0
              ? `acceptance failed: ${failedCases.map((failure) => failure.name).join(", ")}`
              : "the detector was not deterministic on identical input",
          );
        }
        detectorAcceptance = {
          total: acceptanceV2.length,
          passed: acceptancePassed,
          failed: failedCases,
        };
      } // end detector-program acceptance branch

      // -- stage the immutable version (READY — installation is separate) ----
      //
      // Staging route-around (the role-aware store lands in P4.3): the
      // current store accepts only a v1-typed version header — an artifacts
      // array of EXACTLY four entries and a manifest whose schemaVersion is 1
      // — and re-reads the record through a strict decode. The v2 record
      // therefore hashes exactly the four required paths (optional artifacts
      // live in the bundle contents and are covered by bundleSha256) and
      // carries a v1-decodable header whose description tags the bundle as
      // detector-program v2. The authoritative v2 manifest stays byte-exact
      // in contents["manifest.json"]; P4.3 supersedes this scaffolding.
      const version: ForgeCapabilityVersion = {
        capabilityId,
        version: nextVersion,
        bundleSha256,
        artifacts: (bundleKind === "source-adapter"
          ? SOURCE_ADAPTER_V2_REQUIRED_HASH_PATHS
          : DETECTOR_V2_REQUIRED_HASH_PATHS
        ).map((path) => ({
          path,
          sha256: forgeSha256Hex(bundleContents[path] ?? ""),
          bytes: Buffer.byteLength(bundleContents[path] ?? "", "utf8"),
        })),
        manifest: {
          capabilityId,
          version: nextVersion,
          // Forced by the store's v1-typed field (see the note above).
          schemaVersion: FORGE_SDK_SCHEMA_VERSION,
          description: `${DETECTOR_V2_MANIFEST_TAG}${manifest.semantics}`,
        },
        createdAtMs: Date.now(),
      };
      const stagedResult = yield* store
        .stageVersion(environmentId, version, bundleContents)
        .pipe(Effect.mapError(toBuilderError));
      if (stagedResult.status === "refused") {
        return yield* failStage(buildId, `the store refused the version: ${stagedResult.detail}`);
      }
      const ready = yield* store
        .appendBuildStage({
          buildId,
          stage: "ready",
          detail: `v${nextVersion} sealed and staged; installation is a separate CAS step`,
          patch: {
            checks,
            acceptance:
              bundleKind === "source-adapter"
                ? { total: 1, passed: 1, failed: [] }
                : detectorAcceptance,
            artifactSha256,
            bundleSha256,
          },
        })
        .pipe(Effect.mapError(toBuilderError));
      return { build: ready, staged: { version, contents: bundleContents } };
    });

  const check: ForgeCapabilityBuilderShape["check"] = ({
    buildId,
    environmentId,
    stagingDir,
    acceptanceCases,
    acceptanceV2,
  }) =>
    Effect.gen(function* () {
      const existing = yield* store.getBuild(buildId).pipe(Effect.mapError(toBuilderError));
      if (existing === null) {
        return yield* new ForgeBuilderError({
          kind: "invalid_request",
          reason: `no build ${buildId}`,
        });
      }
      if (existing.environmentId !== environmentId) {
        return yield* new ForgeBuilderError({
          kind: "invalid_request",
          reason: "build belongs to another environment",
        });
      }
      if (
        existing.stage === "cancelled" ||
        existing.stage === "installed" ||
        existing.stage === "failed"
      ) {
        return yield* new ForgeBuilderError({
          kind: "invalid_request",
          reason: `build ${buildId} is ${existing.stage}; a cancelled build can never install`,
        });
      }
      const capabilityId = existing.capabilityId;
      if (capabilityId === undefined) {
        return yield* failStage(buildId, "the build never named a capability");
      }
      const nextVersion = yield* store
        .nextVersion({ environmentId, capabilityId })
        .pipe(Effect.mapError(toBuilderError));

      // -- read the authored workspace (the v1∪v2 name union; which bundle
      //    this is gets decided immediately after, on the manifest) ----------
      const contents = yield* Effect.tryPromise({
        try: () => readAuthoringWorkspace(stagingDir, FORGE_WORKSPACE_READ_PATHS),
        catch: (error) => (error instanceof Error ? error.message : String(error)),
      }).pipe(Effect.catch((reason) => failStage(buildId, `authoring workspace: ${reason}`)));

      // Dispatch on the staged manifest's manifestVersion BEFORE any v1
      // decode: the v1 ForgeCapabilityManifest filter rejects a v2 manifest,
      // so the discriminator must be read first (and a v1 manifest, whatever
      // else it says, keeps running the untouched v1 path below).
      const manifestPeek: unknown = parseJsonOr(contents["manifest.json"] ?? "", {});
      const manifestVersion =
        typeof manifestPeek === "object" && manifestPeek !== null
          ? (manifestPeek as Record<string, unknown>)["manifestVersion"]
          : undefined;
      if (manifestVersion === 2) {
        return yield* checkDetectorV2({
          buildId,
          environmentId,
          capabilityId,
          nextVersion,
          contents,
          acceptanceV2: acceptanceV2 ?? [],
        });
      }

      const validated = validateAuthoredArtifacts({
        contents,
        expectedCapabilityId: capabilityId,
        expectedVersion: nextVersion,
      });
      if (validated.status === "refused") {
        return yield* failStage(buildId, validated.reason);
      }
      yield* store
        .appendBuildStage({
          buildId,
          stage: "checking",
          detail: "four artifacts accepted for containment",
        })
        .pipe(Effect.mapError(toBuilderError));

      // -- the host's hashes, over the exact bytes it is about to test -------
      const artifactSha256 = FORGE_CAPABILITY_ARTIFACT_PATHS.map((path) => ({
        path,
        sha256: forgeSha256Hex(contents[path] ?? ""),
      }));
      const bundleSha256 = forgeBundleSha256(contents);
      const files: Array<ForgeSandboxFile> = [
        ...FORGE_CAPABILITY_ARTIFACT_PATHS.map((path) => ({ path, content: contents[path] ?? "" })),
        { path: "sdk.ts", content: FORGE_SDK_SOURCE },
      ];

      const checks: Array<ForgeCheckOutcome> = [];

      // -- compile + typecheck (host-run, contained) --------------------------
      const typecheck = yield* sandbox
        .runBuildStep({ files, entrypoint: [...FORGE_RUNNER_TYPECHECK] })
        .pipe(Effect.exit);
      if (typecheck._tag === "Failure") {
        return yield* failStage(
          buildId,
          `typecheck failed closed: ${sandboxFailureReason(typecheck.cause)}`,
        );
      }
      checks.push({ name: "typecheck", passed: true, exitCode: typecheck.value.exitCode });

      // -- the generated tests (their own file, their own run) ---------------
      const tests = yield* sandbox
        .runBuildStep({ files, entrypoint: [...FORGE_RUNNER_TEST] })
        .pipe(Effect.exit);
      if (tests._tag === "Failure") {
        return yield* failStage(
          buildId,
          `generated tests failed closed: ${sandboxFailureReason(tests.cause)}`,
        );
      }
      checks.push({ name: "generated-tests", passed: true, exitCode: tests.value.exitCode });

      // -- host-owned acceptance cases ----------------------------------------
      const failedCases: Array<{ name: string; reason: string }> = [];
      for (const example of acceptanceCases) {
        const actual = yield* sandbox
          .runEvaluation({
            files,
            entrypoint: [...FORGE_RUNNER_EVALUATE],
            stdinJson: JSON.stringify(example.input),
            decodeResult: decodeForgeSignalOutput,
          })
          .pipe(Effect.exit);
        if (actual._tag === "Failure") {
          failedCases.push({
            name: example.name,
            reason: sandboxFailureReason(actual.cause),
          });
          continue;
        }
        const output = actual.value as {
          reading: ForgeSignalReading;
          diagnostics: ReadonlyArray<{ poolId: string; tradeIds: ReadonlyArray<string> }>;
        };
        const referenceError = validateDiagnosticsAgainstInput(
          { reading: output.reading, diagnostics: output.diagnostics },
          example.input,
        );
        if (referenceError !== null) {
          failedCases.push({ name: example.name, reason: referenceError });
          continue;
        }
        const expected = JSON.stringify(example.expected);
        const got = JSON.stringify(output.reading);
        if (expected !== got) {
          failedCases.push({ name: example.name, reason: `expected ${expected}, got ${got}` });
        }
      }
      const acceptancePassed = acceptanceCases.length - failedCases.length;
      checks.push({
        name: "acceptance",
        passed: failedCases.length === 0,
        ...(failedCases.length === 0
          ? {}
          : {
              detail: failedCases
                .map((failure) => `${failure.name}: ${failure.reason}`)
                .join("; ")
                .slice(0, 2_000),
            }),
      });

      // Empty caller cases cannot certify a module without exercising it.
      const determinismInput = acceptanceCases[0]?.input;
      if (determinismInput === undefined)
        return yield* failStage(
          buildId,
          "at least one independent host acceptance case is required",
        );
      const first = yield* sandbox
        .runEvaluation({
          files,
          entrypoint: [...FORGE_RUNNER_EVALUATE],
          stdinJson: JSON.stringify(determinismInput),
          decodeResult: decodeForgeSignalOutput,
        })
        .pipe(Effect.exit);
      const second = yield* sandbox
        .runEvaluation({
          files,
          entrypoint: [...FORGE_RUNNER_EVALUATE],
          stdinJson: JSON.stringify(determinismInput),
          decodeResult: decodeForgeSignalOutput,
        })
        .pipe(Effect.exit);
      const determinismPassed =
        first._tag === "Success" &&
        second._tag === "Success" &&
        JSON.stringify(first.value) === JSON.stringify(second.value);
      checks.push({ name: "determinism", passed: determinismPassed });

      const allPassed = failedCases.length === 0 && determinismPassed;
      if (!allPassed) {
        return yield* failStage(
          buildId,
          failedCases.length > 0
            ? `acceptance failed: ${failedCases.map((failure) => failure.name).join(", ")}`
            : "the capability was not deterministic on identical input",
        );
      }

      // -- stage the immutable version (READY — installation is separate) ----
      const manifest = decodeManifest(validated.artifacts.contents["manifest.json"] ?? "{}");
      const version: ForgeCapabilityVersion = {
        capabilityId,
        version: nextVersion,
        bundleSha256,
        artifacts: artifactSha256.map((artifact) => ({
          path: artifact.path,
          sha256: artifact.sha256,
          bytes: Buffer.byteLength(contents[artifact.path] ?? "", "utf8"),
        })),
        manifest,
        createdAtMs: Date.now(),
      };
      const stagedResult = yield* store
        .stageVersion(environmentId, version, contents)
        .pipe(Effect.mapError(toBuilderError));
      if (stagedResult.status === "refused") {
        return yield* failStage(buildId, `the store refused the version: ${stagedResult.detail}`);
      }
      const ready = yield* store
        .appendBuildStage({
          buildId,
          stage: "ready",
          detail: `v${nextVersion} sealed and staged; installation is a separate CAS step`,
          patch: {
            checks,
            acceptance: {
              total: acceptanceCases.length,
              passed: acceptancePassed,
              failed: failedCases,
            },
            artifactSha256,
            bundleSha256,
          },
        })
        .pipe(Effect.mapError(toBuilderError));
      return { build: ready, staged: { version, contents } };
    }).pipe(
      Effect.timeoutOrElse({
        duration: `${FORGE_SANDBOX_BUILD_BUDGET_MS} millis`,
        orElse: () =>
          failStage(buildId, "the complete build/check pipeline exceeded its wall-clock budget"),
      }),
    );

  return { prepare, check } satisfies ForgeCapabilityBuilderShape;
});

export const ForgeCapabilityBuilderLive = Layer.effect(
  ForgeCapabilityBuilder,
  makeForgeCapabilityBuilder,
);
