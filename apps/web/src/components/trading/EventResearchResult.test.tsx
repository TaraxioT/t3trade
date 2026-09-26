import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { EventResearchResult } from "./EventResearchResult";

it("keeps uncovered meetings visible beside measured horizons", () => {
  const html = renderToStaticMarkup(
    <EventResearchResult
      study={
        {
          studyId: "study-1",
          reportHash: "hash-1",
          recipe: {
            eventInventory: { status: "complete", occurrences: [], affectedPeriods: [] },
            source: { chain: "ethereum", poolAddress: "pool" },
            snapshotBlock: { number: 1 },
            horizonsMs: [3600000],
          },
          report: {
            rows: [
              {
                eventId: "a",
                event: {
                  meetingFrom: "2024-01-30",
                  meetingTo: "2024-01-31",
                  statementAt: 1706727600000,
                  sourceUrl: "https://www.federalreserve.gov/a",
                },
                horizons: [
                  {
                    horizonMs: 3600000,
                    status: "measured",
                    returnPct: 1,
                    referenceAt: 1,
                    horizonAt: 2,
                    referencePrice: 100,
                    horizonPrice: 101,
                  },
                ],
              },
              {
                eventId: "b",
                event: {
                  meetingFrom: "2024-03-19",
                  meetingTo: "2024-03-20",
                  statementAt: null,
                  sourceUrl: "https://www.federalreserve.gov/b",
                  missingTimeReason: "source_missing",
                },
                horizons: [
                  { horizonMs: 3600000, status: "uncovered", reason: "timestamp_unknown" },
                ],
              },
            ],
            summaries: [
              {
                horizonMs: 3600000,
                measuredCount: 1,
                eligibleCount: 1,
                pendingCount: 0,
                unknownTimeCount: 1,
                meanReturnPct: 1,
              },
            ],
          },
        } as never
      }
      mode="calendar"
      selectedEventId="a"
      onSelectEvent={() => {}}
      horizonMs={3600000}
      onSelectHorizon={() => {}}
      candles={[]}
    />,
  );
  expect(html).toContain("+1.00%");
  expect(html).toContain("2024-03-20");
  expect(html).toContain("time unavailable");
  expect(html).toContain("The Graph · Ethereum");
});
