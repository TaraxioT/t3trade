/**
 * What the chart may and may not draw about a running validation.
 *
 * The rules are small but each one exists because breaking it would put a
 * false statement on a price chart: markers at times a rule never fired, a
 * paper trade coloured like a fill, or an exit drawn for a position that is
 * still open.
 */
import { describe, expect, it } from "vite-plus/test";

import { thesisChartBadge, thesisChartMarkers } from "./thesisChartMarkers";

const thesis = (over: Partial<Parameters<typeof thesisChartMarkers>[0]> = {}) =>
  ({
    validationId: "v1",
    headline: "Buy ETH 5m when RSI(14) is below 30",
    interval: "5m",
    status: "armed",
    expiresAt: 9_000,
    intervalMatches: true,
    trades: [],
    ...over,
  }) as Parameters<typeof thesisChartMarkers>[0];

describe("thesisChartMarkers", () => {
  it("draws an entry and an exit for a settled paper trade", () => {
    const markers = thesisChartMarkers(
      thesis({
        trades: [
          {
            id: "t1",
            entryTime: 1_000,
            entryPrice: 3_000,
            exitTime: 2_000,
            exitPrice: 3_030,
            netUsd: 9.4,
            exitReason: "target",
          },
        ],
      }),
    );

    expect(markers).toHaveLength(2);
    expect(markers[0]?.kind).toBe("paper_open");
    expect(markers[0]?.at).toBe(1_000);
    expect(markers[1]?.kind).toBe("paper_profit");
    expect(markers[1]?.at).toBe(2_000);
    // The label says paper in words, not only in colour — a screen reader and
    // a hover both have to be able to tell.
    expect(markers[0]?.label).toContain("Paper entry");
    expect(markers[1]?.label).toContain("Paper exit");
    expect(markers[1]?.label).toContain("target");
  });

  it("colours the exit by what it netted after fees, not by the price move", () => {
    // Up in price, down after costs. The chart must show the loss, because
    // after-fee net is the number the validation is judged on.
    const markers = thesisChartMarkers(
      thesis({
        trades: [
          {
            id: "t1",
            entryTime: 1_000,
            entryPrice: 3_000,
            exitTime: 2_000,
            exitPrice: 3_001,
            netUsd: -0.6,
            exitReason: "max_hold",
          },
        ],
      }),
    );
    expect(markers[1]?.kind).toBe("paper_loss");
  });

  it("draws only the entry of a paper trade that is still open", () => {
    const markers = thesisChartMarkers(
      thesis({
        trades: [
          {
            id: "t1",
            entryTime: 1_000,
            entryPrice: 3_000,
            exitTime: null,
            exitPrice: null,
            netUsd: null,
            exitReason: null,
          },
        ],
      }),
    );
    expect(markers).toHaveLength(1);
    expect(markers[0]?.kind).toBe("paper_open");
  });

  it("draws nothing when the chart is on another timeframe", () => {
    // A 5m thesis's entries are 5m bar opens. On a 1m chart they would land at
    // times the rule never fired, which is a picture of trades that did not
    // happen where it says they did.
    expect(
      thesisChartMarkers(
        thesis({
          intervalMatches: false,
          trades: [
            {
              id: "t1",
              entryTime: 1_000,
              entryPrice: 3_000,
              exitTime: 2_000,
              exitPrice: 3_030,
              netUsd: 9.4,
              exitReason: "target",
            },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it("never emits a real fill kind", () => {
    const markers = thesisChartMarkers(
      thesis({
        trades: [
          {
            id: "t1",
            entryTime: 1_000,
            entryPrice: 3_000,
            exitTime: 2_000,
            exitPrice: 3_030,
            netUsd: 9.4,
            exitReason: "target",
          },
          {
            id: "t2",
            entryTime: 3_000,
            entryPrice: 3_030,
            exitTime: 4_000,
            exitPrice: 3_000,
            netUsd: -30,
            exitReason: "stop",
          },
        ],
      }),
    );
    for (const marker of markers) {
      expect(marker.kind, "a paper trade must never draw as a fill").toMatch(/^paper_/);
    }
  });
});

describe("thesisChartBadge", () => {
  it("says paper and no orders when the markers are on screen", () => {
    const badge = thesisChartBadge(thesis());
    expect(badge.showsMarkers).toBe(true);
    expect(badge.note).toContain("paper");
    expect(badge.note).toContain("no orders");
    expect(badge.paused).toBe(false);
  });

  it("names the timeframe to switch to instead of explaining the absence", () => {
    const badge = thesisChartBadge(thesis({ intervalMatches: false }));
    expect(badge.showsMarkers).toBe(false);
    // The reader wants the next action, not a note about hidden markers.
    expect(badge.note).toContain("switch to 5m");
    expect(badge.note).toContain("paper");
  });

  it("says a paused validation is paused", () => {
    const badge = thesisChartBadge(thesis({ status: "paused" }));
    expect(badge.paused).toBe(true);
    expect(badge.note).toContain("Paused");
  });

  it("carries the headline through unchanged", () => {
    const badge = thesisChartBadge(thesis({ headline: "The 5m fade" }));
    expect(badge.headline).toBe("The 5m fade");
  });
});
