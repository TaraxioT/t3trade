import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vite-plus/test";

import { EventLongResult } from "./EventLongResult";

it("shows modeled net P&L, costs, and skips without compounding", () => {
  const html = renderToStaticMarkup(
    <EventLongResult
      study={
        {
          report: {
            rows: [
              {
                eventId: "a",
                event: { meetingTo: "2024-01-31", sourceUrl: "https://www.federalreserve.gov/a" },
              },
              {
                eventId: "b",
                event: { meetingTo: "2024-03-20", sourceUrl: "https://www.federalreserve.gov/b" },
              },
            ],
          },
          recipe: { source: { poolAddress: "pool" } },
        } as never
      }
      simulation={
        {
          simulationId: "sim-1",
          reportHash: "hash",
          scenario: {
            notionalQuote: 1000,
            entryDelayMs: 300000,
            holdMs: 86400000,
            feeBpsPerSide: 5,
            slippageBpsPerSide: 2,
          },
          report: {
            outcomes: [
              {
                eventId: "a",
                status: "traded",
                netPnlQuote: 98,
                netReturnPct: 9.8,
                entryAt: 1,
                exitAt: 2,
                entryPrice: 100,
                exitPrice: 110,
                entryFeeQuote: 0.5,
                exitFeeQuote: 0.5,
                slippageCostQuote: 1,
              },
              { eventId: "b", status: "skipped", reason: "exit_unavailable" },
            ],
            summary: {
              coveredTrades: 1,
              eventCount: 2,
              totalNetPnlQuote: 98,
              totalFeesQuote: 1,
              totalSlippageCostQuote: 1,
              isCompoundReturn: false,
            },
          },
        } as never
      }
      selectedEventId="a"
      onSelectEvent={() => {}}
      candles={[]}
    />,
  );
  expect(html).toContain("+98.00 USDC");
  expect(html).toContain("exit_unavailable");
  expect(html).toContain("Independent trades; returns are not compounded");
});
