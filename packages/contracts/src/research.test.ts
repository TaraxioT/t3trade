import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { ThreadId } from "./baseSchemas.ts";

import {
  GetResearchDatasetWindowInput,
  GetResearchJobInput,
  GetSavedResearchInput,
  OpenResearchSceneAction,
} from "./research.ts";

it("requires a saved result identity when reading retained research", () => {
  const decode = Schema.decodeUnknownSync(GetResearchDatasetWindowInput);
  assert.throws(() => decode({ datasetId: "dataset-1", from: 0, to: 1, resolution: "1h" }));
  assert.deepStrictEqual(
    decode({
      threadId: ThreadId.make("thread-1"),
      studyId: "study-1",
      datasetId: "dataset-1",
      from: 0,
      to: 1,
      resolution: "1h",
    }),
    {
      threadId: ThreadId.make("thread-1"),
      studyId: "study-1",
      datasetId: "dataset-1",
      from: 0,
      to: 1,
      resolution: "1h",
    },
  );
  const simulationWindow = decode({
    threadId: "thread-1",
    simulationId: "simulation-1",
    datasetId: "dataset-2",
    from: 0,
    to: 1,
    resolution: "swaps",
  });
  assert.strictEqual(
    "simulationId" in simulationWindow && simulationWindow.simulationId,
    "simulation-1",
  );
});

it("decodes job and saved result requests with thread scope", () => {
  assert.throws(() => Schema.decodeUnknownSync(GetResearchJobInput)({ jobId: "job-1" }));
  assert.throws(() => Schema.decodeUnknownSync(GetSavedResearchInput)({ studyId: "study-1" }));
  assert.strictEqual(
    Schema.decodeUnknownSync(GetSavedResearchInput)({ threadId: "thread-1", studyId: "study-1" })
      .studyId,
    "study-1",
  );
});

it("a chart action retains environment, thread, source and saved result identity", () => {
  const decode = Schema.decodeUnknownSync(OpenResearchSceneAction);
  assert.throws(() =>
    decode({
      kind: "open_research_scene",
      threadId: "thread-1",
      sceneId: "scene-1",
      market: "ETH",
      view: "calendar",
      label: "Open on graph",
    }),
  );
});
