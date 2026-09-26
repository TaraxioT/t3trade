import { describe, expect, it } from "vite-plus/test";

import { calculateEventResearch, type EventResearchInput } from "./eventResearch.ts";

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
const eventAt = Date.parse("2026-01-28T19:00:00Z");
const event = {
  id: "fomc:scheduled:2026-01-28",
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
  minutesReleasedOn: "2026-02-18",
} as const;
const inventory = {
  id: "inventory",
  category: "scheduled",
  from: "2026-01-01",
  to: "2026-02-01",
  asOf: eventAt + 8 * 86_400_000,
  retrievedAt: eventAt + 8 * 86_400_000,
  status: "complete",
  affectedPeriods: [],
  occurrences: [event],
} as const;
const recipe = {
  environmentId: "env",
  threadId: "thread",
  eventInventory: inventory,
  source,
  snapshotBlock: { number: 1, hash: "0xblock" },
  from: "2026-01-01",
  to: "2026-02-01",
  horizonsMs: [3_600_000, 86_400_000, 7 * 86_400_000],
  referencePriceRule: { beforeMaxAgeMs: 300_000, afterMaxDelayMs: 300_000 },
  cutoffAt: eventAt + 8 * 86_400_000,
} as const;

function sample(id: string, at: number, price: number) {
  return { id, at, price, blockNumber: 1, transactionId: `0x${id}`, logIndex: 1 };
}

function input(samples: EventResearchInput["priceSamples"]): EventResearchInput {
  return { recipe, priceSamples: samples };
}

describe("calculateEventResearch", () => {
  it("computes clock-time +1h/+24h/+7d from traceable samples", () => {
    const report = calculateEventResearch(
      input([
        sample("pre", eventAt - 1_000, 100),
        sample("hour", eventAt + 3_600_000, 101),
        sample("day", eventAt + 86_400_000, 98),
        sample("week", eventAt + 7 * 86_400_000, 110),
      ]),
    );
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]?.horizons.map((outcome) => outcome.status)).toEqual([
      "measured",
      "measured",
      "measured",
    ]);
    expect(
      report.rows[0]?.horizons.map((outcome) =>
        outcome.status === "measured" ? outcome.returnPct : null,
      ),
    ).toEqual([1, -2, 10]);
    expect(report.rows[0]?.horizons[0]).toMatchObject({
      referenceSampleId: "pre",
      horizonSampleId: "hour",
      referencePrice: 100,
      horizonPrice: 101,
    });
  });

  it("leaves the one-hour result intact when seven-day data is missing", () => {
    const report = calculateEventResearch(
      input([sample("pre", eventAt - 1_000, 100), sample("hour", eventAt + 3_600_000, 101)]),
    );
    expect(report.rows[0]?.horizons[0]).toMatchObject({ status: "measured", returnPct: 1 });
    expect(report.rows[0]?.horizons[2]).toMatchObject({
      status: "uncovered",
      reason: "missing_horizon",
    });
    expect(report.summaries[2]).toMatchObject({
      eligibleCount: 1,
      measuredCount: 0,
      uncoveredCount: 1,
      meanReturnPct: null,
    });
  });

  it("keeps future endpoints pending and timestamp-unknown rows visible", () => {
    const unknownEvent = {
      ...event,
      id: "unknown",
      statementAt: null,
      missingTimeReason: "not_published" as const,
    };
    const futureRecipe = {
      ...recipe,
      cutoffAt: eventAt + 2 * 86_400_000,
      eventInventory: { ...inventory, occurrences: [event, unknownEvent] },
    };
    const report = calculateEventResearch({
      recipe: futureRecipe,
      priceSamples: [sample("pre", eventAt - 1_000, 100), sample("hour", eventAt + 3_600_000, 101)],
    });
    expect(report.rows).toHaveLength(2);
    expect(report.rows[0]?.horizons[0]?.status).toBe("measured");
    expect(report.rows[0]?.horizons[2]?.status).toBe("pending");
    expect(report.rows[1]?.horizons[0]).toMatchObject({
      status: "uncovered",
      reason: "timestamp_unknown",
    });
    expect(report.summaries[2]).toMatchObject({
      eligibleCount: 0,
      pendingCount: 1,
      unknownTimeCount: 1,
    });
  });

  it("does not change returns when the chart render resolution changes", () => {
    const samples = [sample("pre", eventAt - 1_000, 100), sample("hour", eventAt + 3_600_000, 101)];
    const a = calculateEventResearch({ ...input(samples), renderResolution: "1h" });
    const b = calculateEventResearch({ ...input(samples), renderResolution: "1d" });
    expect(a).toEqual(b);
  });

  it("excludes missing values from means and preserves one row per occurrence", () => {
    const secondAt = eventAt + 2 * 86_400_000;
    const secondEvent = {
      ...event,
      id: "second",
      meetingFrom: "2026-01-30",
      meetingTo: "2026-01-30",
      statementAt: secondAt,
    };
    const report = calculateEventResearch({
      recipe: { ...recipe, eventInventory: { ...inventory, occurrences: [event, secondEvent] } },
      priceSamples: [sample("pre", eventAt - 1_000, 100), sample("hour", eventAt + 3_600_000, 101)],
    });
    expect(report.rows.map((row) => row.eventId)).toEqual([event.id, secondEvent.id]);
    expect(report.summaries[0]).toMatchObject({
      eligibleCount: 2,
      measuredCount: 1,
      uncoveredCount: 1,
      meanReturnPct: 1,
    });
  });
});
