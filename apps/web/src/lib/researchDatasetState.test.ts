import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { researchWindowIdentity, researchCandles } from "./researchDatasetState";

describe("retained Graph window selection", () => {
  it("keys reads by environment, result, dataset, and resolution", () => {
    const base = {
      environmentId: EnvironmentId.make("env-a"),
      threadId: ThreadId.make("thread-a"),
      studyId: "study-a",
      datasetId: "dataset-a",
      from: 10,
      to: 20,
      resolution: "1h" as const,
    };
    expect(researchWindowIdentity(base)).not.toBe(
      researchWindowIdentity({ ...base, environmentId: EnvironmentId.make("env-b") }),
    );
    expect(researchWindowIdentity(base)).not.toBe(
      researchWindowIdentity({ ...base, datasetId: "dataset-b" }),
    );
    expect(researchWindowIdentity(base)).not.toBe(
      researchWindowIdentity({ ...base, resolution: "1d" }),
    );
  });

  it("shows only retained candles from the requested resolution", () => {
    expect(
      researchCandles(
        [
          { id: "sample", at: 10, price: 100, blockNumber: 1, transactionId: "x", logIndex: 0 },
          {
            id: "hour",
            from: 10,
            to: 11,
            resolution: "1h",
            open: 100,
            high: 101,
            low: 99,
            close: 100,
          },
        ],
        "1h",
      ),
    ).toEqual([{ openTime: 10, open: 100, high: 101, low: 99, close: 100, volume: 0, trades: 0 }]);
  });
});
