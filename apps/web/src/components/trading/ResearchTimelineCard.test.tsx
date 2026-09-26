import { expect, it } from "vite-plus/test";

import { deriveResearchToolCard } from "./ResearchTimelineCard";

it("recognizes a typed saved chart action through the MCP tool result seam", () => {
  const action = {
    kind: "open_research_scene",
    environmentId: "env",
    threadId: "thread",
    sceneId: "scene",
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
    datasetIds: ["dataset"],
    resultKind: "event_study",
    studyId: "study",
    view: "calendar",
    label: "Open on graph",
  };
  expect(
    deriveResearchToolCard({
      tool: "trading_chart",
      result: { content: JSON.stringify({ openResearch: action }) },
    }),
  ).toEqual({ kind: "open", action });
  const summary = {
    kind: "long_simulation",
    simulationId: "long",
    parentStudyId: "study",
    eventCount: 2,
    coveredTrades: 1,
    totalNetPnlQuote: 98.51,
    totalFeesQuote: 1,
    totalSlippageCostQuote: 0.49,
  };
  const { studyId: _studyId, ...baseAction } = action;
  const longAction = { ...baseAction, resultKind: "long_simulation", simulationId: "long" };
  expect(
    deriveResearchToolCard({
      tool: "trading_chart",
      result: {
        content: JSON.stringify({ openResearch: longAction, savedResultSummary: summary }),
      },
    }),
  ).toEqual({ kind: "open", action: longAction, summary });
});
