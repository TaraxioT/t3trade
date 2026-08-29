/**
 * The study, pinned on series whose answer is arithmetic.
 *
 * Every expectation is a number computed by hand: entry is the open of the
 * first bar at or after the occurrence's end, exit is the close a horizon
 * later, and the baseline asks the same question of every bar. The honesty
 * rows are the point as much as the math: an occurrence the archive cannot
 * see is a sentence, not a silent drop.
 */
import { describe, expect, it } from "@effect/vitest";

import {
  checkEventStudy,
  EVENT_STUDY_MAX_HORIZON_BARS,
  runEventStudy,
  validateEventOccurrence,
  type TradingEventOccurrence,
} from "./eventSets.ts";
import type { MarketCandle } from "./market.ts";

const MINUTE = 60_000;

/** A bar whose open and close are named, at 1m cadence. */
const bar = (index: number, open: number, close: number): MarketCandle =>
  ({
    openTime: index * MINUTE,
    closeTime: index * MINUTE + MINUTE - 1,
    open,
    high: Math.max(open, close),
    low: Math.min(open, close),
    close,
    volume: 1,
    trades: 1,
  }) as MarketCandle;

const occurrence = (startAt: number, endAt: number): TradingEventOccurrence => ({
  startAt,
  endAt,
  source: "https://example.com/dates",
});

describe("the study math", () => {
  // Ten bars opening at 100 and closing at 100 + i.
  const candles = Array.from({ length: 10 }, (_, i) => bar(i, 100, 100 + i));

  it("enters at the first bar at or after the end, exits a horizon later", () => {
    // The event ends exactly at bar 3's open. Horizon 3: entry open 100 (bar
    // 3), exit close 105 (bar 5). (105 - 100) / 100 = 5%.
    const study = runEventStudy({
      occurrences: [occurrence(0, 3 * MINUTE)],
      candles,
      intervalMs: MINUTE,
      horizonBars: 3,
    });
    expect(study.rows[0]?.covered).toBe(true);
    expect(study.rows[0]?.entryTime).toBe(3 * MINUTE);
    expect(study.rows[0]?.exitPrice).toBe(105);
    expect(study.rows[0]?.returnPct).toBe(5);
    expect(study.rows[0]?.truncated).toBe(false);
    expect(study.rows[0]?.barsCovered).toBe(3);
  });

  it("an end mid-bar enters on the NEXT bar, never the one it lands inside", () => {
    // The event ends halfway through bar 3. Bar 3 opened before the event
    // ended, so it is not a bar the event had happened by.
    const study = runEventStudy({
      occurrences: [occurrence(0, 3 * MINUTE + 30_000)],
      candles,
      intervalMs: MINUTE,
      horizonBars: 1,
    });
    expect(study.rows[0]?.entryTime).toBe(4 * MINUTE);
    expect(study.rows[0]?.returnPct).toBe(4);
  });

  it("truncates at the last served close and says how many bars it got", () => {
    // Horizon 5 from bar 8 wants bar 12; the window ends at bar 9.
    const study = runEventStudy({
      occurrences: [occurrence(0, 8 * MINUTE)],
      candles,
      intervalMs: MINUTE,
      horizonBars: 5,
    });
    expect(study.rows[0]?.covered).toBe(true);
    expect(study.rows[0]?.truncated).toBe(true);
    expect(study.rows[0]?.barsCovered).toBe(2);
    expect(study.rows[0]?.exitPrice).toBe(109);
  });

  it("aggregates the covered rows and samples the baseline at every bar", () => {
    // Bars that all open 100 and close 102: every horizon returns +2%, from
    // an event or from anywhere else, so the aggregate and the baseline are
    // both 2 and the comparison is not vacuous.
    const flat = Array.from({ length: 6 }, (_, i) => bar(i, 100, 102));
    const study = runEventStudy({
      occurrences: [occurrence(0, 1 * MINUTE), occurrence(0, 3 * MINUTE)],
      candles: flat,
      intervalMs: MINUTE,
      horizonBars: 2,
    });
    expect(study.n).toBe(2);
    expect(study.nCovered).toBe(2);
    expect(study.meanReturnPct).toBe(2);
    expect(study.medianReturnPct).toBe(2);
    expect(study.hitRatePercent).toBe(100);
    expect(study.bestReturnPct).toBe(2);
    expect(study.worstReturnPct).toBe(2);
    expect(study.baseline?.samples).toBe(5);
    expect(study.baseline?.meanReturnPct).toBe(2);
    expect(study.horizonMs).toBe(2 * MINUTE);
  });

  it("takes the median, the mean and the hit rate of a mixed spread literally", () => {
    // Opens all 100, closes dip then recover: an event ending at bar 1 reads
    // (90 - 100) / 100 = -10%, bar 4 reads -1%, bar 7 reads +5%.
    const closes = [100, 90, 95, 97, 99, 101, 103, 105, 107, 109];
    const mixed = closes.map((close, index) => bar(index, 100, close));
    const study = runEventStudy({
      occurrences: [
        occurrence(0, 1 * MINUTE),
        occurrence(0, 4 * MINUTE),
        occurrence(0, 7 * MINUTE),
      ],
      candles: mixed,
      intervalMs: MINUTE,
      horizonBars: 1,
    });
    expect(study.rows.map((row) => row.returnPct)).toEqual([-10, -1, 5]);
    expect(study.meanReturnPct).toBe(-2);
    expect(study.medianReturnPct).toBe(-1);
    expect(study.hitRatePercent).toBe(33.33);
    expect(study.bestReturnPct).toBe(5);
    expect(study.worstReturnPct).toBe(-10);
  });
});

describe("uncovered occurrences", () => {
  const candles = Array.from({ length: 5 }, (_, i) => bar(i, 100, 100 + i));

  it("reports one that predates the window rather than dropping it", () => {
    const study = runEventStudy({
      occurrences: [occurrence(0, -10 * MINUTE)],
      candles,
      intervalMs: MINUTE,
      horizonBars: 2,
    });
    expect(study.rows[0]?.covered).toBe(false);
    expect(study.rows[0]?.returnPct).toBeUndefined();
    expect(study.rows[0]?.reason).toContain("before the archived window");
  });

  it("reports one that has not ended yet rather than dropping it", () => {
    const study = runEventStudy({
      occurrences: [occurrence(99 * MINUTE, 100 * MINUTE)],
      candles,
      intervalMs: MINUTE,
      horizonBars: 2,
    });
    expect(study.rows[0]?.covered).toBe(false);
    expect(study.rows[0]?.reason).toContain("still in the future");
  });

  it("says what it measured when only some occurrences are inside", () => {
    const study = runEventStudy({
      occurrences: [
        occurrence(0, -10 * MINUTE),
        occurrence(0, 1 * MINUTE),
        occurrence(0, 2 * MINUTE),
      ],
      candles,
      intervalMs: MINUTE,
      horizonBars: 1,
    });
    expect(study.n).toBe(3);
    expect(study.nCovered).toBe(2);
    // The pinned shape: coverage stated as a fraction of the whole set.
    expect(study.verdict).toContain("2 of 3 occurrences fall inside archived data");
    // And never a claim of significance.
    expect(study.verdict).toContain("not evidence");
  });

  it("holds no bars against an empty archive and says so", () => {
    const study = runEventStudy({
      occurrences: [occurrence(0, MINUTE)],
      candles: [],
      intervalMs: MINUTE,
      horizonBars: 2,
    });
    expect(study.nCovered).toBe(0);
    expect(study.verdict).toContain("0 of 1 occurrence falls inside archived data");
  });

  it("refuses to invent a mean when nothing was covered", () => {
    const study = runEventStudy({
      occurrences: [occurrence(0, -10 * MINUTE)],
      candles,
      intervalMs: MINUTE,
      horizonBars: 2,
    });
    expect(study.meanReturnPct).toBeNull();
    expect(study.medianReturnPct).toBeNull();
    expect(study.hitRatePercent).toBeNull();
    expect(study.baseline).not.toBeNull();
  });
});

describe("the caps and the occurrence validator", () => {
  it("bounds the horizon at both ends before a bar is loaded", () => {
    expect(checkEventStudy({ horizonBars: 0 })).toContain("whole number of bars from 1");
    expect(checkEventStudy({ horizonBars: EVENT_STUDY_MAX_HORIZON_BARS + 1 })).toContain(
      `1 to ${EVENT_STUDY_MAX_HORIZON_BARS}`,
    );
    expect(checkEventStudy({ horizonBars: 2.5 })).toContain("whole number of bars from 1");
    expect(checkEventStudy({ horizonBars: 1 })).toBeNull();
    expect(checkEventStudy({ horizonBars: EVENT_STUDY_MAX_HORIZON_BARS })).toBeNull();
  });

  it("refuses an occurrence that ends before it starts", () => {
    expect(validateEventOccurrence(occurrence(100, 99))).toContain("cannot end before it begins");
    expect(validateEventOccurrence(occurrence(100, 100))).toBeNull();
  });

  it("refuses an occurrence with no source", () => {
    expect(validateEventOccurrence({ startAt: 0, endAt: 1, source: "  " })).toContain(
      "source cannot be empty",
    );
    expect(validateEventOccurrence({ startAt: 0, endAt: 1, source: "user provided" })).toBeNull();
  });
});
