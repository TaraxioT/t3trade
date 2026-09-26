import { expect, it } from "vite-plus/test";

import { matchingResearchAction, sameResearchActionIdentity } from "./ResearchOpenAction";

const action = {
  kind: "open_research_scene",
  environmentId: "env-a",
  threadId: "thread-a",
  sceneId: "scene-a",
  market: "ETH",
  source: {
    provider: "the_graph",
    chain: "ethereum",
    subgraphId: "subgraph",
    deployment: "deployment",
    poolAddress: "pool",
    baseTokenAddress: "base",
    quoteTokenAddress: "quote",
    feeTier: "3000",
    normalizationVersion: 1,
  },
  datasetIds: ["dataset-a"],
  resultKind: "event_study",
  studyId: "study-a",
  view: "calendar",
  label: "Open on graph",
};

it("refuses actions from another environment, thread, or saved result", () => {
  expect(matchingResearchAction(action, "env-a", "thread-a", "study-a")).toBe(true);
  expect(matchingResearchAction(action, "env-b", "thread-a", "study-a")).toBe(false);
  expect(matchingResearchAction(action, "env-a", "thread-b", "study-a")).toBe(false);
  expect(matchingResearchAction(action, "env-a", "thread-a", "study-b")).toBe(false);
});

it("rejects a chart action whose source or retained dataset differs from the server result", () => {
  expect(sameResearchActionIdentity(action as never, action as never)).toBe(true);
  expect(
    sameResearchActionIdentity(action as never, { ...action, datasetIds: ["other"] } as never),
  ).toBe(false);
  expect(
    sameResearchActionIdentity(
      action as never,
      { ...action, source: { ...action.source, deployment: "other" } } as never,
    ),
  ).toBe(false);
});
