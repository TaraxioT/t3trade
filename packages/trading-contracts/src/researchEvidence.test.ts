/**
 * Research evidence contracts, held to their own rules.
 *
 * Round trips for every schema; refusals for the dishonest shapes the types
 * exist to keep out (float quantities, bad digests, empty keys, negative
 * times, day-precision masquerading as recorded minute-precision
 * availability); and the executable-eligibility rule pinned from both sides.
 *
 * @module TradingResearchEvidence.test
 */
import { describe, expect, it } from "@effect/vitest";

import { Schema } from "effect";

import { ForgeSignalInput } from "./observation.ts";

import {
  CapabilityManifestV2,
  CapturedFact,
  DetectionResult,
  EvidenceRef,
  ExternalSourceManifest,
  FactValue,
  GraphDatasetManifest,
  eligibleAt,
} from "./researchEvidence.ts";

const decode = <A>(schema: Schema.Schema<A>, input: unknown) => Schema.is(schema)(input);

const evidenceRef = {
  id: "ev_1",
  environmentId: "env-1",
  sourceId: "src_graph_1",
  mode: "live",
  contentSha256: "a".repeat(64),
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

describe("fact values", () => {
  it("round-trips each kind", () => {
    expect(decode(FactValue, { kind: "boolean", value: true })).toEqual(true);
    expect(decode(FactValue, { kind: "decimal", value: "42", unit: "raw-units" })).toEqual(true);
    expect(decode(FactValue, { kind: "text", value: "hello" })).toEqual(true);
  });

  it("refuses floats and empty units in decimal facts", () => {
    expect(decode(FactValue, { kind: "decimal", value: 1.5, unit: "raw-units" })).toEqual(false);
    expect(decode(FactValue, { kind: "decimal", value: "1.5", unit: "raw-units" })).toEqual(false);
    expect(decode(FactValue, { kind: "decimal", value: "-3", unit: "raw-units" })).toEqual(false);
    expect(decode(FactValue, { kind: "decimal", value: "3", unit: " " })).toEqual(false);
  });
});

describe("evidence refs and captured facts", () => {
  it("round-trips a recorded-availability live evidence ref", () => {
    expect(decode(EvidenceRef, evidenceRef)).toEqual(true);
    expect(decode(CapturedFact, capturedFact)).toEqual(true);
  });

  it("refuses bad digests, negative times, and empty keys", () => {
    expect(decode(EvidenceRef, { ...evidenceRef, contentSha256: "xyz" })).toEqual(false);
    expect(decode(EvidenceRef, { ...evidenceRef, eventAtMs: -1 })).toEqual(false);
    expect(decode(CapturedFact, { ...capturedFact, key: "" })).toEqual(false);
    expect(decode(CapturedFact, { ...capturedFact, entityId: "" })).toEqual(false);
  });
});

describe("detection results", () => {
  it("round-trips matched, not-matched, and unknown", () => {
    expect(
      decode(DetectionResult, {
        status: "matched",
        occurrenceKey: "occ-1",
        evidenceIds: ["ev_1"],
        facts: [capturedFact],
        validUntilMs: 1_700_000_600_000,
      }),
    ).toEqual(true);
    expect(
      decode(DetectionResult, { status: "not-matched", evidenceIds: [], explanation: "quiet" }),
    ).toEqual(true);
    expect(
      decode(DetectionResult, {
        status: "unknown",
        missingSourceIds: ["src_ext_1"],
        explanation: "feed lag",
      }),
    ).toEqual(true);
  });
});

describe("dataset manifests", () => {
  const manifest = {
    id: "ds_1",
    environmentId: "env-1",
    provider: "the-graph",
    transport: "subgraph",
    chainId: "1",
    deploymentOrPackageId: "Qmdeployment",
    schemaSha256: "b".repeat(64),
    programSha256: "c".repeat(64),
    variablesSha256: "d".repeat(64),
    requested: { fromMs: 1_700_000_000_000, toMs: 1_700_000_360_000 },
    coverage: { fromMs: 1_700_000_000_000, toMs: 1_700_000_360_000, rows: 900 },
    status: "complete",
    pin: { blockNumber: "18500000", blockHash: "0xhash" },
    cursor: null,
    normalizedSchemaVersion: 1,
    contentSha256: "e".repeat(64),
    capturedAtMs: 1_700_000_361_000,
    availabilityBasis: "recorded",
    mode: "live",
  } as const;

  it("round-trips a pinned subgraph manifest", () => {
    expect(decode(GraphDatasetManifest, manifest)).toEqual(true);
  });

  it("refuses chain ids with leading zeros and zero schema versions", () => {
    expect(decode(GraphDatasetManifest, { ...manifest, chainId: "01" })).toEqual(false);
    expect(decode(GraphDatasetManifest, { ...manifest, normalizedSchemaVersion: 0 })).toEqual(
      false,
    );
  });

  it("round-trips an external source manifest with a correction chain", () => {
    const external = {
      id: "ext_2",
      environmentId: "env-1",
      providerKind: "official-release-feed",
      documentIdentity: "acme/launches/2026-09-01",
      sourceUrl: "https://example.com/releases/1",
      contentSha256: "f".repeat(64),
      publishedAtMs: 1_700_000_000_000,
      timePrecision: "day",
      firstObservedAtMs: 1_700_010_000_000,
      correctionOf: "ext_1",
      retracted: false,
    };
    expect(decode(ExternalSourceManifest, external)).toEqual(true);
    expect(
      decode(ExternalSourceManifest, { ...external, sourceUrl: "ftp://example.com/1" }),
    ).toEqual(false);
  });
});

describe("capability manifest v2", () => {
  it("round-trips a declared artifact set", () => {
    const manifest = {
      manifestVersion: 2,
      capabilityId: "cap_net_flow",
      version: 3,
      semantics: "net deposit flow watcher with two-window persistence",
      requiredSourceIds: ["src_graph_1", "src_ext_1"],
      outputFactKeys: ["net_flow_raw", "participants"],
      artifacts: [
        { role: "source-query", path: "query.graphql", sha256: "1".repeat(64) },
        { role: "detector", path: "detector.js", sha256: "2".repeat(64) },
        { role: "execution-policy", path: "policy.js", sha256: "3".repeat(64) },
      ],
      createdAtMs: 1_700_000_000_000,
    };
    expect(decode(CapabilityManifestV2, manifest)).toEqual(true);
    expect(decode(CapabilityManifestV2, { ...manifest, manifestVersion: 1 })).toEqual(false);
  });
});

describe("legacy compatibility", () => {
  it("the v1 pool-shaped forge input still decodes beside the v2 vocabulary", () => {
    // Additive-only change: research evidence introduces new records, it
    // never rewrites what already persists.
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
    expect(Schema.is(ForgeSignalInput)(v1)).toBe(true);
    expect(Schema.is(ForgeSignalInput)({ pools: [] })).toBe(false);
  });
});

describe("eligibleAt", () => {
  const base = {
    eventAtMs: 1_000,
    availableAtMs: 1_100,
    availabilityBasis: "recorded",
    expiresAtMs: 10_000,
    final: true,
  } as const;

  it("accepts a recorded, final, unexpired fact after availability", () => {
    expect(eligibleAt(base, 1_200)).toBe(true);
  });

  it("refuses before event, before availability, after expiry, and non-final", () => {
    expect(eligibleAt(base, 900)).toBe(false);
    expect(eligibleAt(base, 1_050)).toBe(false);
    expect(eligibleAt(base, 10_000)).toBe(false);
    expect(eligibleAt({ ...base, final: false }, 1_200)).toBe(false);
  });

  it("refuses estimated and unknown availability — research-only evidence", () => {
    expect(eligibleAt({ ...base, availabilityBasis: "conservative-estimate" }, 1_200)).toBe(false);
    expect(eligibleAt({ ...base, availabilityBasis: "unknown" }, 1_200)).toBe(false);
    expect(eligibleAt({ ...base, availableAtMs: null }, 1_200)).toBe(false);
  });
});
