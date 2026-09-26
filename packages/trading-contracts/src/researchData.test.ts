import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  GraphSourceRef,
  ResearchCandle,
  ResearchDatasetManifest,
  ResearchPriceSample,
} from "./researchData.ts";

describe("research data contracts", () => {
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
});
