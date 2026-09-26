import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vite-plus/test";

import { GraphResearchScene } from "./GraphResearchScene";

const AT = 1_706_727_600_000;
const source = {
  provider: "the_graph",
  chain: "ethereum",
  subgraphId: "subgraph",
  deployment: "deployment",
  poolAddress: "pool",
  baseTokenAddress: "base",
  quoteTokenAddress: "quote",
  feeTier: "3000",
  normalizationVersion: 1,
};
const study = {
  studyId: "study",
  environmentId: "env",
  threadId: "thread",
  reportHash: "hash",
  datasetIds: ["dataset"],
  recipe: {
    source,
    snapshotBlock: { number: 1 },
    horizonsMs: [3_600_000],
    eventInventory: { status: "complete", affectedPeriods: [] },
  },
  report: {
    rows: [
      {
        eventId: "event",
        event: {
          meetingFrom: "2024-01-30",
          meetingTo: "2024-01-31",
          statementAt: AT,
          sourceUrl: "https://www.federalreserve.gov/test",
        },
        horizons: [
          {
            horizonMs: 3_600_000,
            status: "measured",
            returnPct: 1,
            referenceAt: AT - 1,
            horizonAt: AT + 3_600_000,
            referencePrice: 100,
            horizonPrice: 101,
          },
        ],
      },
    ],
    summaries: [{ horizonMs: 3_600_000, measuredCount: 1, eligibleCount: 1, meanReturnPct: 1 }],
  },
};

vi.mock("../../lib/researchDatasetState", () => ({
  useSavedResearch: () => ({
    data: { kind: "event_study", study },
    loading: false,
    error: null,
    refresh: () => {},
  }),
  useResearchDatasetWindow: () => ({
    data: { manifest: { status: "complete" }, rows: [] },
    loading: false,
    error: null,
    stale: false,
  }),
  researchCandles: () => [],
}));
vi.mock("../../lib/tradingMarketChartState", () => ({
  useTradingMarketChart: () => {
    throw new Error("Graph scene used Hyperliquid archive");
  },
}));

it("renders saved Graph values without a Hyperliquid archive read", () => {
  const html = renderToStaticMarkup(
    <GraphResearchScene
      environmentId={"env" as never}
      mode="calendar"
      scene={
        {
          sceneId: "scene",
          threadId: "thread",
          graphResearch: {
            kind: "graph_event_study",
            studyId: "study",
            source,
            datasetIds: ["dataset"],
          },
        } as never
      }
    />,
  );
  expect(html).toContain("+1.00%");
  expect(html).toContain("The Graph · Ethereum");
});

it("refuses a scene that points at a different source or dataset", () => {
  for (const graphResearch of [
    {
      kind: "graph_event_study",
      studyId: "study",
      source: { ...source, poolAddress: "other-pool" },
      datasetIds: ["dataset"],
    },
    { kind: "graph_event_study", studyId: "study", source, datasetIds: ["other-dataset"] },
  ]) {
    const html = renderToStaticMarkup(
      <GraphResearchScene
        environmentId={"env" as never}
        mode="calendar"
        scene={{ sceneId: "scene", threadId: "thread", graphResearch } as never}
      />,
    );
    expect(html).toContain("Saved study source or scope does not match this scene");
  }
});
