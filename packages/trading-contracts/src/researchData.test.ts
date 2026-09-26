import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  FomcEventOccurrence,
  GraphSourceRef,
  ResearchCandle,
  ResearchDatasetManifest,
  ResearchJobView,
  ResearchPriceSample,
} from "./researchData.ts";

describe("research data contracts", () => {
  it("requires either a sourced timestamp or an explicit missing-time reason", () => {
    const row = {
      id: "fomc:scheduled:2026-01-28",
      meetingFrom: "2026-01-27",
      meetingTo: "2026-01-28",
      classification: "scheduled",
      sourceUrl: "https://www.federalreserve.gov/statement",
      sourceHash: "hash",
      sourceExcerpt: "For release at 2:00 p.m. EST",
      calendarUrl: "https://www.federalreserve.gov/calendar",
      calendarHash: "calendar-hash",
      retrievedAt: 1,
      timezoneInterpretation: "America/New_York (EST, UTC-05:00)",
      minutesReleasedOn: null,
    };
    expect(() =>
      Schema.decodeUnknownSync(FomcEventOccurrence)({
        ...row,
        statementAt: null,
        missingTimeReason: null,
      }),
    ).toThrow();
    expect(
      Schema.decodeUnknownSync(FomcEventOccurrence)({
        ...row,
        statementAt: 1,
        missingTimeReason: null,
      }).statementAt,
    ).toBe(1);
  });

  it("decodes a source and complete manifest with explicit provenance", () => {
    const source = Schema.decodeUnknownSync(GraphSourceRef)({
      provider: "the_graph",
      chain: "ethereum",
      subgraphId: "id",
      deployment: "Qm123",
      poolAddress: "0xpool",
      baseTokenAddress: "0xbase",
      quoteTokenAddress: "0xquote",
      feeTier: "3000",
      normalizationVersion: 1,
    });
    const manifest = Schema.decodeUnknownSync(ResearchDatasetManifest)({
      datasetId: "dataset",
      source,
      snapshotBlock: { number: 1, hash: "0xabc" },
      entityKind: "swaps",
      from: 1,
      to: 2,
      rowCount: 1,
      status: "complete",
      completedAt: 3,
    });
    expect(manifest.source.deployment).toBe("Qm123");
    expect(manifest.status).toBe("complete");
  });

  it("rejects nonfinite prices at the wire boundary", () => {
    const sample = {
      id: "sample",
      at: 1,
      price: Number.NaN,
      blockNumber: 1,
      transactionId: "0xtx",
      logIndex: 1,
    };
    expect(() => Schema.decodeUnknownSync(ResearchPriceSample)(sample)).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ResearchCandle)({
        id: "candle",
        from: 1,
        to: 2,
        resolution: "1h",
        open: 0,
        high: 2,
        low: 1,
        close: 1,
      }),
    ).toThrow();
  });

  it("keeps a paused job distinct from an immutable completed manifest", () => {
    const source = {
      provider: "the_graph",
      chain: "ethereum",
      subgraphId: "id",
      deployment: "Qm123",
      poolAddress: "0xpool",
      baseTokenAddress: "0xbase",
      quoteTokenAddress: "0xquote",
      feeTier: "3000",
      normalizationVersion: 1,
    };
    const paused = Schema.decodeUnknownSync(ResearchJobView)({
      jobId: "job",
      datasetId: "dataset",
      environmentId: "env",
      threadId: "thread",
      source,
      snapshotBlock: { number: 1, hash: "0xabc" },
      entityKind: "swaps",
      from: 1,
      to: 2,
      status: "paused",
      rowCount: 100,
      requestCount: 2,
      storedBytes: 500,
      cursor: "last",
      updatedAt: 3,
      failureReason: "request budget reached",
    });
    expect(paused.status).toBe("paused");
    expect(paused.cursor).toBe("last");
    expect(() =>
      Schema.decodeUnknownSync(ResearchDatasetManifest)({
        datasetId: "dataset",
        source,
        snapshotBlock: { number: 1, hash: "0xabc" },
        entityKind: "swaps",
        from: 1,
        to: 2,
        rowCount: 100,
        status: "complete",
      }),
    ).toThrow();
  });
});
