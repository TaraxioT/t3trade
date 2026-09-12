/**
 * Detector-program contracts v2, held to their own rules.
 *
 * Round trips for every schema; discriminator refusals (a v1-shaped payload
 * is not a v2 input); the facts-count and state-bytes caps from both sides
 * of their boundaries; acceptance-case bounds; the evaluation content
 * identity (deterministic, component-sensitive, and agreeing with
 * node:crypto over the canonical serialization); the role-to-path bundle
 * validation; and the smoke that the v1/v2 vocabularies still coexist.
 *
 * @module TradingDetectorProgram.test
 */
import { assert, describe, it } from "@effect/vitest";

import { Schema } from "effect";

import { ForgeSignalInput } from "./observation.ts";
import {
  CapabilityArtifactRole,
  CapabilityManifestV2,
  DetectionResult,
  EvidenceRef,
} from "./researchEvidence.ts";
import {
  DETECTOR_FACTS_MAX_COUNT,
  DETECTOR_STATE_MAX_BYTES,
  DETECTOR_V2_ARTIFACT_ROLES,
  DetectorEvaluationRecordV2,
  DetectorProgramInputV2,
  DetectorProgramOutputV2,
  DetectorStateEnvelope,
  ForgeAcceptanceCaseV2,
  ForgeAcceptanceCasesV2,
  SealedSourceRecord,
  decodeDetectorState,
  detectorArtifactPaths,
  detectorEvaluationId,
  encodeDetectorState,
  serializeDetectorEvaluationIdentity,
} from "./detectorProgram.ts";

const decode = <A>(schema: Schema.Schema<A>, input: unknown): boolean => Schema.is(schema)(input);

const hex64 = (char: string): string => char.repeat(64);

const evidenceRef = {
  id: "ev_1",
  environmentId: "env-1",
  sourceId: "src_graph_1",
  mode: "live",
  contentSha256: hex64("a"),
  eventAtMs: 1_700_000_000_000,
  availableAtMs: 1_700_000_001_000,
  availabilityBasis: "recorded",
  timePrecision: "second",
  capturedAtMs: 1_700_000_002_000,
  expiresAtMs: 1_700_000_600_000,
  sourceRevision: "rev-1",
} as const;

const capturedFact = {
  id: "fact_1",
  key: "net_flow_raw",
  entityId: "0xabc0000000000000000000000000000000000001",
  value: { kind: "decimal", value: "1500", unit: "raw-units" },
  evidence: [evidenceRef],
} as const;

const sealedSource = {
  sourceId: "src_graph_1",
  evidenceId: "ev_1",
  mode: "live",
  contentSha256: hex64("a"),
  complete: true,
  eventAtMs: 1_700_000_000_000,
  availableAtMs: 1_700_000_001_000,
  availabilityBasis: "recorded",
  expiresAtMs: 1_700_000_600_000,
  sourceRevision: "rev-1",
} as const;

const programInput = {
  programSchemaVersion: 2,
  asOfMs: 1_700_000_060_000,
  inputDigest: hex64("b"),
  facts: [capturedFact],
  sources: [sealedSource],
  priorState: null,
} as const;

const matchedResult = {
  status: "matched",
  occurrenceKey: "occ-1",
  evidenceIds: ["ev_1"],
  facts: [capturedFact],
  validUntilMs: 1_700_000_600_000,
} as const;

const notMatchedResult = {
  status: "not-matched",
  evidenceIds: ["ev_1"],
  explanation: "flow below threshold",
} as const;

const unknownResult = {
  status: "unknown",
  missingSourceIds: ["src_ext_1"],
  explanation: "feed lag",
} as const;

const v2Manifest = (
  artifacts: ReadonlyArray<{
    readonly role: CapabilityArtifactRole;
    readonly path: string;
    readonly sha256: string;
  }>,
): CapabilityManifestV2 => {
  const manifest = {
    manifestVersion: 2,
    capabilityId: "net-flow-detector",
    version: 3,
    semantics: "net deposit flow watcher with two-window persistence",
    requiredSourceIds: ["src_graph_1", "src_ext_1"],
    outputFactKeys: ["net_flow_raw"],
    artifacts: artifacts.map((artifact) => ({ ...artifact, sha256: hex64(artifact.sha256[0]!) })),
    createdAtMs: 1_700_000_000_000,
  };
  if (!Schema.is(CapabilityManifestV2)(manifest)) {
    throw new Error("test fixture: manifest under construction is not a valid v2 manifest");
  }
  return manifest;
};

describe("sealed source records", () => {
  it("round-trips a complete, recorded-availability source", () => {
    assert.isTrue(decode(SealedSourceRecord, sealedSource));
  });

  it("round-trips a never-available source with every optional time absent", () => {
    assert.isTrue(
      decode(SealedSourceRecord, {
        sourceId: "src_ext_1",
        evidenceId: "ev_2",
        mode: "historical-replay",
        contentSha256: hex64("c"),
        complete: false,
        availabilityBasis: "unknown",
      }),
    );
  });

  it("refuses empty source ids and malformed digests", () => {
    assert.isFalse(decode(SealedSourceRecord, { ...sealedSource, sourceId: "" }));
    assert.isFalse(decode(SealedSourceRecord, { ...sealedSource, contentSha256: "abc" }));
  });
});

describe("the sealed program input", () => {
  it("round-trips with a null prior state (first run after a reset)", () => {
    assert.isTrue(decode(DetectorProgramInputV2, programInput));
  });

  it("round-trips with an absent prior state (first run) and with a carried one", () => {
    const { priorState: _absent, ...withoutPrior } = programInput;
    assert.isTrue(decode(DetectorProgramInputV2, withoutPrior));
    assert.isTrue(
      decode(DetectorProgramInputV2, {
        ...programInput,
        priorState: { stateSchemaVersion: 1, state: { windowHigh: 12 } },
      }),
    );
  });

  it("refuses any other program schema version and any v1-shaped payload", () => {
    assert.isFalse(decode(DetectorProgramInputV2, { ...programInput, programSchemaVersion: 1 }));
    const { programSchemaVersion: _missing, ...withoutVersion } = programInput;
    assert.isFalse(decode(DetectorProgramInputV2, withoutVersion));
    // The v1 pool-shaped input is a different vocabulary entirely.
    const v1 = {
      evidence: {
        mode: "live",
        provider: "the-graph",
        deploymentId: "Qmdeployment",
        blockNumber: "18500000",
        blockHash: "0xhash",
        fetchedAtMs: 1_700_000_060_000,
        windowEndMs: 1_700_000_060_000,
        querySha256: "q".repeat(16),
        responseSha256: "r".repeat(16),
        complete: true,
      },
      pools: [],
    };
    assert.isTrue(decode(ForgeSignalInput, v1));
    assert.isFalse(decode(DetectorProgramInputV2, v1));
  });

  it("enforces the facts-count cap at its exact boundary", () => {
    const factAt = (index: number) => ({ ...capturedFact, id: `fact_${index}` });
    const full = {
      ...programInput,
      facts: Array.from({ length: DETECTOR_FACTS_MAX_COUNT }, (_, index) => factAt(index)),
    };
    assert.isTrue(decode(DetectorProgramInputV2, full));
    const over = {
      ...programInput,
      facts: Array.from({ length: DETECTOR_FACTS_MAX_COUNT + 1 }, (_, index) => factAt(index)),
    };
    assert.isFalse(decode(DetectorProgramInputV2, over));
  });
});

describe("the program output", () => {
  it("round-trips every detection result member, with and without state", () => {
    assert.isTrue(
      decode(DetectorProgramOutputV2, { result: matchedResult, nextState: { seen: 1 } }),
    );
    assert.isTrue(decode(DetectorProgramOutputV2, { result: notMatchedResult, nextState: null }));
    assert.isTrue(decode(DetectorProgramOutputV2, { result: unknownResult, nextState: null }));
  });

  it("refuses a result that is not a detection result", () => {
    assert.isFalse(
      decode(DetectorProgramOutputV2, { result: { status: "ready" }, nextState: null }),
    );
  });
});

describe("the detector state envelope", () => {
  it("round-trips and refuses non-positive or non-integer schema versions", () => {
    assert.isTrue(decode(DetectorStateEnvelope, { stateSchemaVersion: 1, state: { high: 0 } }));
    assert.isFalse(decode(DetectorStateEnvelope, { stateSchemaVersion: 0, state: null }));
    assert.isFalse(decode(DetectorStateEnvelope, { stateSchemaVersion: 1.5, state: null }));
    assert.isFalse(decode(DetectorStateEnvelope, { state: null }));
  });

  it("encodes canonically: key order does not change the committed bytes", () => {
    const encoded = encodeDetectorState({ stateSchemaVersion: 1, state: { a: 1, b: 2 } });
    assert.ok(encoded.ok);
    const reordered = encodeDetectorState({ state: { b: 2, a: 1 }, stateSchemaVersion: 1 });
    assert.ok(reordered.ok);
    assert.strictEqual(encoded.serialized, reordered.serialized);
    assert.strictEqual(encoded.serialized, '{"state":{"a":1,"b":2},"stateSchemaVersion":1}');
  });

  it("decode is the mirror of encode", () => {
    const encoded = encodeDetectorState({ stateSchemaVersion: 2, state: { windows: [1, 2] } });
    assert.ok(encoded.ok);
    const decoded = decodeDetectorState(encoded.serialized);
    assert.ok(decoded.ok);
    assert.deepStrictEqual(decoded.envelope, { stateSchemaVersion: 2, state: { windows: [1, 2] } });
  });

  it("refuses invalid envelopes, unserializable state, and bad JSON by name", () => {
    const invalid = encodeDetectorState({ stateSchemaVersion: 0, state: null });
    assert.ok(!invalid.ok && invalid.failure === "state-envelope-invalid");

    const circular: Record<string, unknown> = { stateSchemaVersion: 1, state: null };
    circular.state = circular;
    const unserializable = encodeDetectorState(circular);
    assert.ok(!unserializable.ok && unserializable.failure === "state-not-serializable");

    const badJson = decodeDetectorState("{not json");
    assert.ok(!badJson.ok && badJson.failure === "state-json-invalid");

    const wrongShape = decodeDetectorState('{"stateSchemaVersion":1}');
    assert.ok(!wrongShape.ok && wrongShape.failure === "state-envelope-invalid");
  });

  it("enforces the byte cap at its exact boundary, on encode and on decode", () => {
    const envelopeOf = (state: unknown) => ({ stateSchemaVersion: 1, state });
    // ASCII-only filler, so code units are bytes and the boundary is exact.
    const skeleton = JSON.stringify(envelopeOf(""));
    const filler = DETECTOR_STATE_MAX_BYTES - skeleton.length;

    const exact = encodeDetectorState(envelopeOf("x".repeat(filler)));
    assert.ok(exact.ok);
    assert.strictEqual(new TextEncoder().encode(exact.serialized).length, DETECTOR_STATE_MAX_BYTES);

    const over = encodeDetectorState(envelopeOf("x".repeat(filler + 1)));
    assert.ok(!over.ok && over.failure === "state-exceeds-max-bytes");

    const decodedExact = decodeDetectorState(exact.serialized);
    assert.ok(decodedExact.ok);
    // A valid-JSON envelope one byte over the cap: refused before parsing.
    const decodedOver = decodeDetectorState(JSON.stringify(envelopeOf("x".repeat(filler + 1))));
    assert.ok(!decodedOver.ok && decodedOver.failure === "state-exceeds-max-bytes");
  });
});

describe("host acceptance cases v2", () => {
  const caseAt = (index: number) => ({
    name: `case-${index}`,
    input: programInput,
    expected: { result: notMatchedResult, nextState: null },
  });

  it("round-trips one case", () => {
    assert.isTrue(decode(ForgeAcceptanceCaseV2, caseAt(0)));
    assert.isFalse(decode(ForgeAcceptanceCaseV2, { ...caseAt(0), name: "" }));
  });

  it("accepts 1 and 32 cases, refuses 0 and 33", () => {
    const cases = (count: number) => Array.from({ length: count }, (_, index) => caseAt(index));
    assert.isTrue(decode(ForgeAcceptanceCasesV2, cases(1)));
    assert.isTrue(decode(ForgeAcceptanceCasesV2, cases(32)));
    assert.isFalse(decode(ForgeAcceptanceCasesV2, cases(0)));
    assert.isFalse(decode(ForgeAcceptanceCasesV2, cases(33)));
  });
});

describe("the evaluation content identity", () => {
  const identity = {
    environmentId: "env-1",
    capabilityId: "net-flow-detector",
    version: 3,
    stateRevision: 7,
    inputDigest: hex64("b"),
  } as const;

  it("is deterministic", () => {
    assert.strictEqual(detectorEvaluationId(identity), detectorEvaluationId(identity));
    assert.match(detectorEvaluationId(identity), /^dtev_[0-9a-f]{24}$/);
  });

  it("changes when any identity component changes", () => {
    const baseline = detectorEvaluationId(identity);
    const changed = (patch: {
      readonly environmentId?: string;
      readonly capabilityId?: string;
      readonly version?: number;
      readonly stateRevision?: number;
      readonly inputDigest?: string;
    }): string => detectorEvaluationId({ ...identity, ...patch });
    assert.notStrictEqual(changed({ environmentId: "env-2" }), baseline);
    assert.notStrictEqual(changed({ capabilityId: "other-detector" }), baseline);
    assert.notStrictEqual(changed({ version: 4 }), baseline);
    assert.notStrictEqual(changed({ stateRevision: 8 }), baseline);
    assert.notStrictEqual(changed({ inputDigest: hex64("c") }), baseline);
  });

  it("agrees with the platform SHA-256 over the canonical identity serialization", async () => {
    // Varied lengths cross the single-block/multi-block padding boundaries of
    // the pure implementation; Web Crypto (no node builtin import — this
    // package keeps node out of its type environment) is the reference.
    const referenceSha256Hex = async (value: string): Promise<string> => {
      const digest = await globalThis.crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(value),
      );
      return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    };
    const samples = [
      identity,
      {
        environmentId: "e",
        capabilityId: "d",
        version: 1,
        stateRevision: 0,
        inputDigest: hex64("0"),
      },
      {
        environmentId: "environment-with-a-considerably-longer-name",
        capabilityId: "a-capability-id-that-is-also-fairly-long-for-boundaries",
        version: 99,
        stateRevision: 123_456,
        inputDigest: hex64("f"),
      },
    ];
    for (const sample of samples) {
      const expected = `dtev_${(await referenceSha256Hex(serializeDetectorEvaluationIdentity(sample))).slice(0, 24)}`;
      assert.strictEqual(detectorEvaluationId(sample), expected);
    }
  });
});

describe("the committed evaluation record", () => {
  const recordIdentity = {
    environmentId: "env-1",
    capabilityId: "net-flow-detector",
    version: 3,
    stateRevision: 7,
    inputDigest: hex64("b"),
  } as const;

  const evaluationRecord = {
    manifestVersion: 2,
    evaluationId: detectorEvaluationId(recordIdentity),
    ...recordIdentity,
    asOfMs: 1_700_000_060_000,
    result: unknownResult,
    state: { stateSchemaVersion: 1, state: { high: 0 } },
    evidenceIds: ["ev_1"],
    committedAtMs: 1_700_000_061_000,
  } as const;

  it("round-trips with its content-derived id", () => {
    assert.isTrue(decode(DetectorEvaluationRecordV2, evaluationRecord));
  });

  it("refuses an id that misstates what was evaluated", () => {
    assert.isFalse(
      decode(DetectorEvaluationRecordV2, {
        ...evaluationRecord,
        inputDigest: hex64("c"),
      }),
    );
    assert.isFalse(
      decode(DetectorEvaluationRecordV2, {
        ...evaluationRecord,
        stateRevision: 8,
      }),
    );
  });

  it("refuses a v1 manifest discriminator and out-of-range versions and revisions", () => {
    assert.isFalse(decode(DetectorEvaluationRecordV2, { ...evaluationRecord, manifestVersion: 1 }));
    assert.isFalse(decode(DetectorEvaluationRecordV2, { ...evaluationRecord, version: 0 }));
    assert.isFalse(
      decode(DetectorEvaluationRecordV2, {
        ...evaluationRecord,
        stateRevision: -1,
        evaluationId: detectorEvaluationId({ ...recordIdentity, stateRevision: -1 }),
      }),
    );
  });
});

describe("the v2 artifact path validation", () => {
  it("documents one declared path per role, three of them required", () => {
    assert.deepStrictEqual(DETECTOR_V2_ARTIFACT_ROLES.sdk, { path: "sdk.ts", required: true });
    assert.deepStrictEqual(DETECTOR_V2_ARTIFACT_ROLES.detector, {
      path: "detector.ts",
      required: true,
    });
    assert.deepStrictEqual(DETECTOR_V2_ARTIFACT_ROLES.acceptance, {
      path: "detector.test.ts",
      required: true,
    });
    for (const role of ["transform", "state-schema", "source-query", "execution-policy"] as const) {
      assert.strictEqual(DETECTOR_V2_ARTIFACT_ROLES[role].required, false);
    }
  });

  it("accepts the minimal required bundle and returns its paths sorted", () => {
    const result = detectorArtifactPaths(
      v2Manifest([
        { role: "detector", path: "detector.ts", sha256: "2" },
        { role: "acceptance", path: "detector.test.ts", sha256: "3" },
        { role: "sdk", path: "sdk.ts", sha256: "1" },
      ]),
    );
    assert.deepStrictEqual(result, {
      paths: ["detector.test.ts", "detector.ts", "sdk.ts"],
    });
  });

  it("accepts every optional role at its declared path", () => {
    const result = detectorArtifactPaths(
      v2Manifest([
        { role: "sdk", path: "sdk.ts", sha256: "1" },
        { role: "detector", path: "detector.ts", sha256: "2" },
        { role: "acceptance", path: "detector.test.ts", sha256: "3" },
        { role: "transform", path: "transform.ts", sha256: "4" },
        { role: "state-schema", path: "state-schema.ts", sha256: "5" },
        { role: "source-query", path: "query.graphql", sha256: "6" },
        { role: "execution-policy", path: "policy.ts", sha256: "7" },
      ]),
    );
    assert.deepStrictEqual(result, {
      paths: [
        "detector.test.ts",
        "detector.ts",
        "policy.ts",
        "query.graphql",
        "sdk.ts",
        "state-schema.ts",
        "transform.ts",
      ],
    });
  });

  it("refuses a missing required role, a wrong path per role, and duplicates", () => {
    const missing = detectorArtifactPaths(
      v2Manifest([
        { role: "sdk", path: "sdk.ts", sha256: "1" },
        { role: "acceptance", path: "detector.test.ts", sha256: "3" },
      ]),
    );
    assert.deepStrictEqual(missing, { refusal: "missing required artifact role: detector" });

    const wrongPath = detectorArtifactPaths(
      v2Manifest([
        { role: "sdk", path: "sdk.js", sha256: "1" },
        { role: "detector", path: "detector.ts", sha256: "2" },
        { role: "acceptance", path: "detector.test.ts", sha256: "3" },
      ]),
    );
    assert.deepStrictEqual(wrongPath, {
      refusal: "artifact role sdk must be at path sdk.ts",
    });

    const wrongOptional = detectorArtifactPaths(
      v2Manifest([
        { role: "sdk", path: "sdk.ts", sha256: "1" },
        { role: "detector", path: "detector.ts", sha256: "2" },
        { role: "acceptance", path: "detector.test.ts", sha256: "3" },
        { role: "transform", path: "transform.js", sha256: "4" },
      ]),
    );
    assert.deepStrictEqual(wrongOptional, {
      refusal: "artifact role transform must be at path transform.ts",
    });

    // Same role twice lands on the same path: whichever guard fires first,
    // the bundle is refused as ambiguous, never half-accepted.
    const duplicated = detectorArtifactPaths(
      v2Manifest([
        { role: "sdk", path: "sdk.ts", sha256: "1" },
        { role: "detector", path: "detector.ts", sha256: "2" },
        { role: "detector", path: "detector.ts", sha256: "9" },
        { role: "acceptance", path: "detector.test.ts", sha256: "3" },
      ]),
    );
    assert.ok("refusal" in duplicated && duplicated.refusal.includes("duplicate"));
  });
});

describe("legacy compatibility", () => {
  it("the research evidence vocabulary still decodes beside the program contracts", () => {
    // Additive-only change: these schemas have their own suite; this is the
    // smoke that the program contracts did not disturb them.
    assert.isTrue(decode(EvidenceRef, evidenceRef));
    assert.isTrue(decode(DetectionResult, matchedResult));
    assert.isTrue(decode(DetectionResult, notMatchedResult));
    assert.isTrue(decode(DetectionResult, unknownResult));
  });
});
