import { describe, expect, it } from "vite-plus/test";

import { calculateEventResearch, type SavedEventStudy } from "./eventResearch.ts";
import { simulateEventLongs, type EventLongScenario } from "./eventLongSimulation.ts";

const eventAt = Date.parse("2026-01-28T19:00:00Z");
const source = {
  provider: "the_graph",
  chain: "ethereum",
  subgraphId: "v3",
  deployment: "QmDeployment",
  poolAddress: "0xpool",
  baseTokenAddress: "0xweth",
  quoteTokenAddress: "0xusdc",
  feeTier: "3000",
  normalizationVersion: 1,
} as const;
const event = {
  id: "event",
  meetingFrom: "2026-01-27",
  meetingTo: "2026-01-28",
  classification: "scheduled",
  statementAt: eventAt,
  missingTimeReason: null,
  sourceUrl: "https://www.federalreserve.gov/statement",
  sourceHash: "statement-hash",
  sourceExcerpt: "For release at 2:00 p.m. EST",
  calendarUrl: "https://www.federalreserve.gov/calendar",
  calendarHash: "calendar-hash",
  retrievedAt: eventAt + 1,
  timezoneInterpretation: "America/New_York (EST, UTC-05:00)",
  minutesReleasedOn: null,
} as const;
const recipe = {
  environmentId: "env",
  threadId: "thread",
  eventInventory: {
    id: "inventory",
    category: "scheduled",
    from: "2026-01-01",
    to: "2026-02-01",
    asOf: eventAt + 2 * 86_400_000,
    retrievedAt: eventAt + 2 * 86_400_000,
    status: "complete",
    affectedPeriods: [],
    occurrences: [event],
  },
  source,
  snapshotBlock: { number: 1, hash: "0xblock" },
  from: "2026-01-01",
  to: "2026-02-01",
  horizonsMs: [86_400_000],
  referencePriceRule: { beforeMaxAgeMs: 300_000, afterMaxDelayMs: 300_000 },
  cutoffAt: eventAt + 2 * 86_400_000,
} as const;
const sample = (id: string, at: number, price: number) => ({
  id,
  at,
  price,
  blockNumber: 1,
  transactionId: `0x${id}`,
  logIndex: 1,
});
const parent: SavedEventStudy = {
  studyId: "study",
  environmentId: "env",
  threadId: "thread",
  recipe,
  report: calculateEventResearch({ recipe, priceSamples: [] }),
  reportHash: "parent-report-hash",
  datasetIds: ["dataset"],
  priceSamples: [
    sample("entry", eventAt + 300_000, 100),
    sample("exit", eventAt + 300_000 + 86_400_000, 110),
  ],
  createdAt: eventAt + 2 * 86_400_000,
};
const scenario: EventLongScenario = {
  notionalQuote: 1_000,
  entryDelayMs: 300_000,
  holdMs: 86_400_000,
  maxEntryWaitMs: 300_000,
  maxExitWaitMs: 300_000,
  feeBpsPerSide: 0,
  slippageBpsPerSide: 0,
};

describe("simulateEventLongs", () => {
  it("makes 100 quote units on a zero-cost 100-to-110 long", () => {
    const report = simulateEventLongs({ parentStudy: parent, scenario });
    expect(report.outcomes[0]).toMatchObject({
      status: "traded",
      entrySampleId: "entry",
      exitSampleId: "exit",
      grossPnlQuote: 100,
      netPnlQuote: 100,
    });
    if (report.outcomes[0]?.status === "traded") {
      expect(report.outcomes[0].entryAt).toBeLessThan(report.outcomes[0].exitAt);
      expect(report.outcomes[0].exitAt).toBeLessThanOrEqual(parent.recipe.cutoffAt);
    }
    expect(report.summary).toMatchObject({
      coveredTrades: 1,
      skippedEvents: 0,
      totalNetPnlQuote: 100,
      isCompoundReturn: false,
    });
  });

  it("loses money at equal prices when fees or slippage are positive", () => {
    const equal = {
      ...parent,
      priceSamples: [
        sample("entry", eventAt + 300_000, 100),
        sample("exit", eventAt + 300_000 + 86_400_000, 100),
      ],
    };
    const report = simulateEventLongs({
      parentStudy: equal,
      scenario: { ...scenario, feeBpsPerSide: 10, slippageBpsPerSide: 10 },
    });
    expect(report.outcomes[0]?.status).toBe("traded");
    if (report.outcomes[0]?.status === "traded")
      expect(report.outcomes[0].netPnlQuote).toBeLessThan(0);
  });

  it("rejects negative, zero, or nonfinite trade inputs", () => {
    for (const bad of [
      { ...scenario, notionalQuote: -1 },
      { ...scenario, notionalQuote: 0 },
      { ...scenario, feeBpsPerSide: Number.NaN },
      { ...scenario, holdMs: 0 },
    ])
      expect(() => simulateEventLongs({ parentStudy: parent, scenario: bad })).toThrow();
  });

  it("rejects arithmetic overflow instead of saving a nonfinite trade", () => {
    const extreme = {
      ...parent,
      priceSamples: [
        sample("entry", eventAt + 300_000, 1e-300),
        sample("exit", eventAt + 300_000 + 86_400_000, 1e-300),
      ],
    };
    expect(() =>
      simulateEventLongs({ parentStudy: extreme, scenario: { ...scenario, notionalQuote: 1e308 } }),
    ).toThrow();
  });

  it("skips unavailable exits and enforces sample wait limits and cutoff", () => {
    const missing = simulateEventLongs({
      parentStudy: { ...parent, priceSamples: parent.priceSamples.slice(0, 1) },
      scenario,
    });
    expect(missing.outcomes[0]).toMatchObject({ status: "skipped", reason: "exit_unavailable" });
    const late = simulateEventLongs({
      parentStudy: parent,
      scenario: { ...scenario, maxExitWaitMs: 0, holdMs: 86_400_000 - 1 },
    });
    expect(late.outcomes[0]).toMatchObject({ status: "skipped", reason: "exit_unavailable" });
    const pending = simulateEventLongs({
      parentStudy: { ...parent, recipe: { ...recipe, cutoffAt: eventAt + 3_600_000 } },
      scenario,
    });
    expect(pending.outcomes[0]).toMatchObject({ status: "skipped", reason: "future_endpoint" });
  });

  it("obeys long cost and notional invariants without claiming compounding", () => {
    const base = simulateEventLongs({ parentStudy: parent, scenario });
    const moreFees = simulateEventLongs({
      parentStudy: parent,
      scenario: { ...scenario, feeBpsPerSide: 25 },
    });
    const moreSlip = simulateEventLongs({
      parentStudy: parent,
      scenario: { ...scenario, slippageBpsPerSide: 25 },
    });
    const doubleSize = simulateEventLongs({
      parentStudy: parent,
      scenario: { ...scenario, notionalQuote: 2_000 },
    });
    expect(moreFees.summary.totalNetPnlQuote).toBeLessThanOrEqual(base.summary.totalNetPnlQuote);
    expect(moreSlip.summary.totalNetPnlQuote).toBeLessThanOrEqual(base.summary.totalNetPnlQuote);
    expect(doubleSize.summary.totalNetPnlQuote).toBe(2 * base.summary.totalNetPnlQuote);
    expect(base.summary.isCompoundReturn).toBe(false);
  });

  it("keeps net P&L monotone under higher modeled costs across price directions", () => {
    for (const exitPrice of [50, 100, 110, 200]) {
      const varied = {
        ...parent,
        priceSamples: [
          sample("entry", eventAt + 300_000, 100),
          sample("exit", eventAt + 300_000 + 86_400_000, exitPrice),
        ],
      };
      const zero = simulateEventLongs({ parentStudy: varied, scenario });
      const fees = simulateEventLongs({
        parentStudy: varied,
        scenario: { ...scenario, feeBpsPerSide: 100 },
      });
      const slip = simulateEventLongs({
        parentStudy: varied,
        scenario: { ...scenario, slippageBpsPerSide: 100 },
      });
      expect(fees.summary.totalNetPnlQuote).toBeLessThanOrEqual(zero.summary.totalNetPnlQuote);
      expect(slip.summary.totalNetPnlQuote).toBeLessThanOrEqual(zero.summary.totalNetPnlQuote);
    }
  });

  it("counts overlapping events independently and handles zero covered trades", () => {
    const second = { ...event, id: "second" };
    const overlapping = {
      ...parent,
      recipe: {
        ...recipe,
        eventInventory: { ...recipe.eventInventory, occurrences: [event, second] },
      },
    };
    const report = simulateEventLongs({ parentStudy: overlapping, scenario });
    expect(report.summary).toMatchObject({
      coveredTrades: 2,
      totalNetPnlQuote: 200,
      isCompoundReturn: false,
    });
    const empty = simulateEventLongs({ parentStudy: { ...parent, priceSamples: [] }, scenario });
    expect(empty.summary).toMatchObject({
      coveredTrades: 0,
      totalNetPnlQuote: 0,
      meanNetReturnPct: null,
    });
  });
});
