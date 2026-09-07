/**
 * What the chart may and may not draw about a running validation.
 *
 * The rules are small but each one exists because breaking it would put a
 * false statement on a price chart: markers at times a rule never fired, a
 * paper trade coloured like a fill, or an exit drawn for a position that is
 * still open.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  thesisChartBadge,
  thesisChartConditions,
  thesisChartMarkers,
  thesisChartZones,
} from "./thesisChartMarkers";

const thesis = (over: Partial<Parameters<typeof thesisChartMarkers>[0]> = {}) =>
  ({
    validationId: "v1",
    headline: "Buy ETH 5m when RSI(14) is below 30",
    interval: "5m",
    status: "armed",
    expiresAt: 9_000,
    intervalMatches: true,
    trades: [],
    side: "long",
    comparison: "tracking",
    entryLevels: [],
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
            stopPrice: null,
            targetPrice: null,
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
            stopPrice: null,
            targetPrice: null,
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
            stopPrice: null,
            targetPrice: null,
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
              stopPrice: null,
              targetPrice: null,
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
            stopPrice: null,
            targetPrice: null,
          },
          {
            id: "t2",
            entryTime: 3_000,
            entryPrice: 3_030,
            exitTime: 4_000,
            exitPrice: 3_000,
            netUsd: -30,
            exitReason: "stop",
            stopPrice: null,
            targetPrice: null,
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

describe("thesisChartZones", () => {
  const open = (over: Record<string, unknown> = {}) => ({
    id: "t9",
    entryTime: 5_000,
    entryPrice: 3_000,
    exitTime: null,
    exitPrice: null,
    netUsd: null,
    exitReason: null,
    stopPrice: 2_950,
    targetPrice: 3_090,
    ...over,
  });

  it("splits the open trade's bracket at the entry, so the boundary is the entry", () => {
    const zones = thesisChartZones(thesis({ trades: [open()] }));
    expect(zones.map((zone) => [zone.tone, zone.priceLow, zone.priceHigh])).toEqual([
      ["risk", 2_950, 3_000],
      ["reward", 3_000, 3_090],
    ]);
    // Nothing is resting at either price: the whole band is a claim.
    expect(zones.every((zone) => zone.register === "hypothetical")).toBe(true);
  });

  it("draws the half of the bracket the thesis named and no more", () => {
    const zones = thesisChartZones(thesis({ trades: [open({ targetPrice: null })] }));
    expect(zones.map((zone) => zone.tone)).toEqual(["risk"]);
  });

  it("draws nothing for a settled trade", () => {
    const zones = thesisChartZones(
      thesis({ trades: [open({ exitTime: 6_000, exitPrice: 3_090, netUsd: 8 })] }),
    );
    expect(zones).toEqual([]);
  });

  it("withholds the bands on the wrong interval, as it withholds the markers", () => {
    const zones = thesisChartZones(thesis({ intervalMatches: false, trades: [open()] }));
    expect(zones).toEqual([]);
  });
});

describe("thesisChartConditions", () => {
  it("draws the entry constants as claimed levels named after the thesis", () => {
    const conditions = thesisChartConditions(
      thesis({ entryLevels: [{ price: 3_900, direction: "above" }] }),
    );
    expect(conditions).toEqual([
      {
        price: 3_900,
        direction: "above",
        met: false,
        label: "Buy ETH 5m when RSI(14) is below 30",
        register: "hypothetical",
      },
    ]);
  });

  it("draws them on the wrong interval too: a price is a price on any bars", () => {
    const conditions = thesisChartConditions(
      thesis({ intervalMatches: false, entryLevels: [{ price: 3_900, direction: "above" }] }),
    );
    expect(conditions).toHaveLength(1);
  });

  it("draws nothing for a rule with no constant in it", () => {
    expect(thesisChartConditions(thesis({ entryLevels: [] }))).toEqual([]);
  });
});

describe("thesisChartBadge comparison", () => {
  it("carries the running verdict and its tone", () => {
    expect(thesisChartBadge(thesis({ comparison: "worse_than_backtest" }))).toMatchObject({
      comparisonLabel: "worse than backtest",
      comparisonTone: "negative",
    });
    expect(thesisChartBadge(thesis({ comparison: "tracking" })).comparisonTone).toBe("positive");
    expect(thesisChartBadge(thesis({ comparison: "too_few_trades" })).comparisonTone).toBe(
      "neutral",
    );
  });

  it("does not colour tracking of a losing ledger as success", () => {
    // The badge payload carries no baseline figure, so "tracking" is judged
    // against the settled paper trades' own net: matching a losing backtest
    // is replication, not a green badge.
    const losing = thesis({
      trades: [
        {
          id: "t1",
          entryTime: 1_000,
          entryPrice: 3_000,
          exitTime: 2_000,
          exitPrice: 2_950,
          netUsd: -32.5,
          exitReason: "stop",
          stopPrice: null,
          targetPrice: null,
        },
      ],
    });
    expect(thesisChartBadge(losing).comparisonTone).toBe("neutral");
  });
});
