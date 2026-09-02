/**
 * The range/bars policy, pinned: the Range rail and the Bars menu are two
 * controls with two vocabularies that can never be read as each other, every
 * range has an automatic interval in both contexts, a manual interval that
 * cannot serve a range falls back loudly rather than silently, and the
 * scene-fit arithmetic is pure dates.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  INTERVAL_MENU_LABELS,
  MENU_INTERVALS,
  RANGES,
  RANGE_LABELS,
  autoInterval,
  intervalMenuLabel,
  promoteAllToMonthly,
  rangeDurationMillis,
  rangeMaxBars,
  resolvedBarsLabel,
  resolveBars,
  sceneAutoFit,
  servable,
} from "./tradingChartRangePolicy";
import { STUDY_CHART_MAX_WINDOW_BARS } from "@t3tools/contracts";
import type { TradingChartInterval, TradingChartRange } from "@t3tools/contracts";

const MIN = 60 * 1_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

// A fixed mid-year instant so YTD arithmetic is deterministic: 2024-06-15T12:00:00Z.
const NOW = Date.UTC(2024, 5, 15, 12);
const YTD_AT_NOW = NOW - Date.UTC(2024, 0, 1);

describe("the Range rail vocabulary", () => {
  it("offers the seven ranges in rail order with their short labels", () => {
    expect(RANGES).toEqual(["1d", "1w", "1m", "6m", "ytd", "1y", "all"]);
    expect(RANGES.map((range) => RANGE_LABELS[range])).toEqual([
      "1D",
      "1W",
      "1M",
      "6M",
      "YTD",
      "1Y",
      "All",
    ]);
  });

  it("never offers a bare 1m/1mo token: menu labels are spelled out and unambiguous", () => {
    expect(INTERVAL_MENU_LABELS).toEqual({
      "1m": "1 min",
      "3m": "3 min",
      "5m": "5 min",
      "15m": "15 min",
      "1h": "1 hour",
      "4h": "4 hours",
      "1d": "1 day",
      "1w": "1 week",
      "1mo": "1 month",
    });
    for (const label of Object.values(INTERVAL_MENU_LABELS)) {
      // Spelled out, never a bare token like 1m or 1mo.
      expect(label).toMatch(/^\d+ (min|hour|hours|day|week|month)$/);
    }
    expect(MENU_INTERVALS).toEqual(["1m", "3m", "5m", "15m", "1h", "4h", "1d", "1w", "1mo"]);
    expect(resolvedBarsLabel("5m")).toBe("5 min bars");
    expect(resolvedBarsLabel("1w")).toBe("1 week bars");
    expect(resolvedBarsLabel("1mo")).toBe("1 month bars");
    expect(intervalMenuLabel("1m")).toBe("1 min");
  });

  it("Range labels and Bars labels are disjoint vocabularies", () => {
    // The one collision the old single row invited was 1m/1M; the two control
    // vocabularies must never share a string.
    const rangeLabels = new Set(RANGES.map((range) => RANGE_LABELS[range]));
    for (const label of Object.values(INTERVAL_MENU_LABELS)) {
      expect(rangeLabels.has(label)).toBe(false);
    }
  });
});

describe("autoInterval", () => {
  const browsing: Readonly<Record<TradingChartRange, TradingChartInterval>> = {
    "1d": "5m",
    "1w": "15m",
    "1m": "4h",
    "6m": "1d",
    ytd: "1w",
    "1y": "1w",
    all: "1w",
  };

  it("covers every range in the browsing context", () => {
    for (const range of RANGES) {
      expect(autoInterval(range, "browsing")).toBe(browsing[range]);
    }
  });

  it("an event-study fit is identical except 6m stays on weekly bars", () => {
    for (const range of RANGES) {
      const expected = range === "6m" ? "1w" : browsing[range];
      expect(autoInterval(range, "event_study_fit")).toBe(expected);
    }
  });
});

describe("rangeDurationMillis", () => {
  it("spans the fixed ranges and measures ytd from the UTC year start", () => {
    expect(rangeDurationMillis("1d", NOW)).toBe(DAY);
    expect(rangeDurationMillis("1w", NOW)).toBe(7 * DAY);
    expect(rangeDurationMillis("1m", NOW)).toBe(30 * DAY);
    expect(rangeDurationMillis("6m", NOW)).toBe(183 * DAY);
    expect(rangeDurationMillis("1y", NOW)).toBe(365 * DAY);
    expect(rangeDurationMillis("ytd", NOW)).toBe(YTD_AT_NOW);
    // The year boundary itself: ytd is zero exactly at midnight, UTC.
    const newYear = Date.UTC(2025, 0, 1);
    expect(rangeDurationMillis("ytd", newYear)).toBe(0);
  });

  it("all is unbounded (null): only the server knows what the archive holds", () => {
    expect(rangeDurationMillis("all", NOW)).toBeNull();
  });
});

describe("servable", () => {
  it("a manual interval is servable when the range spans at least two buckets", () => {
    // 24h spans 480 three-minute buckets and exactly two 12-hour ones; two
    // buckets is the floor for honesty, not a comfortable read.
    expect(servable("1d", "1m", NOW)).toBe(true);
    expect(servable("1d", "3m", NOW)).toBe(true);
    expect(servable("1d", "15m", NOW)).toBe(true);
    // A week of history on fifteen-minute bars is servable; on weekly bars a
    // week is a single bucket and must refuse.
    expect(servable("1w", "15m", NOW)).toBe(true);
    expect(servable("1w", "1w", NOW)).toBe(false);
    expect(servable("1d", "1d", NOW)).toBe(false);
    expect(servable("1d", "4h", NOW)).toBe(true);
  });

  it("all is always servable", () => {
    for (const interval of MENU_INTERVALS) {
      expect(servable("all", interval, NOW)).toBe(true);
    }
  });
});

describe("resolveBars", () => {
  it("keeps a servable manual choice as manual", () => {
    expect(resolveBars("1m", "1d", NOW)).toEqual({ interval: "1d", mode: "manual" });
  });

  it("Auto resolves to the browsing interval for the range", () => {
    expect(resolveBars("1d", null, NOW)).toEqual({ interval: "5m", mode: "auto" });
    expect(resolveBars("all", null, NOW)).toEqual({ interval: "1w", mode: "auto" });
  });

  it("an unservable manual choice falls back to Auto, loudly", () => {
    // 15 min bars cannot serve a 1D range? They can; a weekly bar cannot even
    // serve 1W. The fallback case the UI actually hits: a manual interval
    // left behind after the range shrank.
    expect(resolveBars("1d", "1w", NOW)).toEqual({ interval: "5m", mode: "auto-fallback" });
    expect(resolveBars("1w", "1mo", NOW)).toEqual({ interval: "15m", mode: "auto-fallback" });
    expect(resolveBars("1d", "1mo", NOW)).toEqual({ interval: "5m", mode: "auto-fallback" });
  });
});

describe("rangeMaxBars", () => {
  it("asks for the buckets the range spans, capped by the server's ceiling", () => {
    expect(rangeMaxBars("1d", "5m", NOW)).toBe(Math.ceil(DAY / (5 * MIN)));
    // A week on 15m bars is 672 buckets — past the cap, so the cap it is.
    expect(rangeMaxBars("1w", "15m", NOW)).toBe(STUDY_CHART_MAX_WINDOW_BARS);
    expect(rangeMaxBars("ytd", "1w", NOW)).toBe(Math.ceil(YTD_AT_NOW / WEEK));
  });

  it("never asks below one bar and never above the cap", () => {
    expect(rangeMaxBars("ytd", "1mo", Date.UTC(2025, 0, 1))).toBeGreaterThanOrEqual(1);
    // A 1y range on 1m bars is 525,600 buckets: the cap, not the calendar.
    expect(rangeMaxBars("1y", "1m", NOW)).toBe(STUDY_CHART_MAX_WINDOW_BARS);
    expect(STUDY_CHART_MAX_WINDOW_BARS).toBe(512);
  });

  it("all asks for the whole cap", () => {
    expect(rangeMaxBars("all", "1w", NOW)).toBe(STUDY_CHART_MAX_WINDOW_BARS);
  });
});

describe("promoteAllToMonthly", () => {
  it("promotes when the recorded weeks no longer fit the budget", () => {
    const budget = STUDY_CHART_MAX_WINDOW_BARS;
    // 512 weeks of history: 513 weekly buckets (counting the partial week) is
    // already over; 511 weeks is not.
    expect(promoteAllToMonthly(NOW - 512 * WEEK, NOW, budget)).toBe(true);
    expect(promoteAllToMonthly(NOW - 511 * WEEK, NOW, budget)).toBe(false);
    expect(promoteAllToMonthly(NOW - 100 * WEEK, NOW, budget)).toBe(false);
  });
});

describe("sceneAutoFit", () => {
  it("picks the smallest fixed range that holds both instants", () => {
    // Both instants inside the last half year: 6m.
    expect(sceneAutoFit(NOW - 90 * DAY, NOW - 10 * DAY, NOW)).toBe("6m");
    // YTD only outranks 6m late in the year, when the year has run longer
    // than 183 days: mid-October, an occurrence 200 days back fits the year
    // but not half a year.
    const october = Date.UTC(2024, 9, 15);
    expect(sceneAutoFit(october - 200 * DAY, october - 10 * DAY, october)).toBe("ytd");
    // Inside 1y but before this year started: 1y.
    expect(sceneAutoFit(NOW - 300 * DAY, NOW - 10 * DAY, NOW)).toBe("1y");
  });

  it("falls back to all when no fixed range holds the scene", () => {
    // The Ethereum-style multi-year scene: first occurrence years back.
    expect(sceneAutoFit(NOW - 3 * 365 * DAY, NOW - 30 * DAY, NOW)).toBe("all");
    // An upcoming occurrence sits after now, which no closed span contains.
    expect(sceneAutoFit(NOW - 30 * DAY, NOW + 45 * DAY, NOW)).toBe("all");
  });

  it("a scene entirely inside the year boundary edge still measures honestly", () => {
    // Exactly 183 days back is inside 6m (>= now - duration).
    expect(sceneAutoFit(NOW - 183 * DAY, NOW, NOW)).toBe("6m");
    expect(sceneAutoFit(NOW - 183 * DAY - 1, NOW, NOW)).not.toBe("6m");
  });
});
