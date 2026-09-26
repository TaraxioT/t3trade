import { assert, it } from "@effect/vitest";
import { canReadResearchResult } from "./ResearchAccess.ts";

const saved = { environmentId: "env-1", threadId: "thread-1", datasetIds: ["dataset-1"] };

it("requires the connection environment, thread and saved dataset lineage", () => {
  assert.equal(canReadResearchResult(saved, "env-1", "thread-1", "dataset-1"), true);
  assert.equal(canReadResearchResult(saved, "env-2", "thread-1", "dataset-1"), false);
  assert.equal(canReadResearchResult(saved, "env-1", "thread-2", "dataset-1"), false);
  assert.equal(canReadResearchResult(saved, "env-1", "thread-1", "dataset-2"), false);
});
