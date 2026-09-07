/**
 * chartAggregation unit tests.
 *
 * The module is pure, so every case is arithmetic on pinned UTC dates: weeks
 * anchor Monday 00:00 UTC (including across a year boundary), months anchor
 * calendar-month boundaries of varying length, OHLCV folds first/max/min/
 * last/sum in time order, and the output cap applies after aggregation with
 * the newest buckets winning.
 */
import { assert, describe, it } from "@effect/vitest";

import {
  aggregateDailyBars,
  aggregationBucketStart,
  aggregationSourceCeiling,
  type AggregationDailyBar,
} from "./chartAggregation.ts";

const DAY_MS = 24 * 60 * 60 * 1_000;

/** A daily bar at a UTC calendar day, priced so each field is distinguishable. */
const day = (
  year: number,
  month: number,
  date: number,
  price: number,
  volume = 10,
): AggregationDailyBar => ({
  t: Date.UTC(year, month, date),
  o: price,
  h: price + 2,
  l: price - 3,
  c: price + 1,
  v: volume,
});

describe("aggregationBucketStart", () => {
  it("anchors a week at Monday 00:00 UTC for every day inside it", () => {
    // 2026-12-28 is a Monday; the days after it through Sunday 2027-01-03 all
    // belong to that week, across the year boundary.
    const monday = Date.UTC(2026, 11, 28);
    for (let offset = 0; offset < 7; offset += 1) {
      assert.equal(aggregationBucketStart("1w", monday + offset * DAY_MS), monday);
    }
    // The next Monday starts the next bucket.
    assert.equal(aggregationBucketStart("1w", Date.UTC(2027, 0, 4)), Date.UTC(2027, 0, 4));
  });

  it("rolls a week spanning a year boundary back to its own Monday", () => {
    // 2027-01-01 is a Friday: its week began Monday 2026-12-28, not Jan 1.
    assert.equal(aggregationBucketStart("1w", Date.UTC(2027, 0, 1)), Date.UTC(2026, 11, 28));
  });

  it("anchors a month at its calendar boundary and follows its variable length", () => {
    // February 2027 is 28 days; every day of it buckets to Feb 1, and March 1
    // — not Feb 29 — starts the next bucket.
    assert.equal(aggregationBucketStart("1mo", Date.UTC(2027, 1, 1)), Date.UTC(2027, 1, 1));
    assert.equal(aggregationBucketStart("1mo", Date.UTC(2027, 1, 28)), Date.UTC(2027, 1, 1));
    assert.equal(aggregationBucketStart("1mo", Date.UTC(2027, 2, 1)), Date.UTC(2027, 2, 1));
    // A 31-day month buckets its last day correctly too.
    assert.equal(aggregationBucketStart("1mo", Date.UTC(2027, 0, 31)), Date.UTC(2027, 0, 1));
  });

  it("rolls a month spanning a year boundary back to its own December", () => {
    assert.equal(aggregationBucketStart("1mo", Date.UTC(2026, 11, 31)), Date.UTC(2026, 11, 1));
    assert.equal(aggregationBucketStart("1mo", Date.UTC(2027, 0, 1)), Date.UTC(2027, 0, 1));
  });
});

describe("aggregationSourceCeiling", () => {
  it("derives the daily ceiling from the output cap and the widest bucket", () => {
    // (maxBars + 1) * widthMax + 1: weeks at 7, months at 31.
    assert.equal(aggregationSourceCeiling("1w", 512), 513 * 7 + 1);
    assert.equal(aggregationSourceCeiling("1mo", 512), 513 * 31 + 1);
    assert.equal(aggregationSourceCeiling("1w", 8), 9 * 7 + 1);
    assert.equal(aggregationSourceCeiling("1mo", 3), 4 * 31 + 1);
  });

  it("clamps to the hard ceiling", () => {
    assert.equal(aggregationSourceCeiling("1mo", 5_000), 20_000);
  });
});

describe("aggregateDailyBars", () => {
  it("folds one week's OHLCV as first/max/min/last/sum in time order", () => {
    const bars = [
      day(2027, 0, 4, 100, 100), // Monday
      day(2027, 0, 5, 110, 200), // Tuesday
      day(2027, 0, 6, 90, 300), // Wednesday
      day(2027, 0, 7, 105, 400), // Thursday
      day(2027, 0, 8, 120, 500), // Friday
      day(2027, 0, 9, 115, 600), // Saturday
      day(2027, 0, 10, 108, 700), // Sunday
    ];
    const [week] = aggregateDailyBars({ bars, kind: "1w", maxBars: 10 });
    assert.isDefined(week);
    assert.equal(week?.openTime, Date.UTC(2027, 0, 4));
    assert.equal(week?.open, 100, "open is the FIRST daily open");
    assert.equal(week?.high, 122, "high is the max daily high");
    assert.equal(week?.low, 87, "low is the min daily low");
    assert.equal(week?.close, 109, "close is the LAST daily close");
    assert.equal(week?.volume, 2_800, "volume is the sum");
  });

  it("folds calendar months of variable length across a year boundary", () => {
    const dec1 = day(2026, 11, 1, 50);
    const dec31 = day(2026, 11, 31, 60);
    const jan1 = day(2027, 0, 1, 70);
    const feb28 = day(2027, 1, 28, 80);
    const buckets = aggregateDailyBars({
      bars: [dec1, dec31, jan1, feb28],
      kind: "1mo",
      maxBars: 10,
    });
    assert.deepEqual(
      buckets.map((bucket) => bucket.openTime),
      [Date.UTC(2026, 11, 1), Date.UTC(2027, 0, 1), Date.UTC(2027, 1, 1)],
    );
    // December spans 31 days but only the bars it actually holds; January
    // bridges the year boundary as its own bucket.
    assert.deepEqual(
      buckets.map((bucket) => [bucket.open, bucket.close]),
      [
        [50, 61],
        [70, 71],
        [80, 81],
      ],
    );
  });

  it("serves the newest bucket incomplete, aggregated from what closed so far", () => {
    // The running week holds only Monday and Tuesday of it.
    const buckets = aggregateDailyBars({
      bars: [
        day(2027, 0, 4, 100),
        day(2027, 0, 5, 110),
        day(2027, 0, 11, 130),
        day(2027, 0, 12, 140),
      ],
      kind: "1w",
      maxBars: 10,
    });
    assert.equal(buckets.length, 2);
    const running = buckets[1];
    assert.isDefined(running);
    assert.equal(running?.openTime, Date.UTC(2027, 0, 11));
    assert.equal(running?.open, 130);
    assert.equal(running?.close, 141);
    assert.equal(running?.volume, 20, "two days of volume, not a week's");
    // Deterministic: the same input folds to the same answer.
    assert.deepEqual(
      aggregateDailyBars({
        bars: [
          day(2027, 0, 4, 100),
          day(2027, 0, 5, 110),
          day(2027, 0, 11, 130),
          day(2027, 0, 12, 140),
        ],
        kind: "1w",
        maxBars: 10,
      }),
      buckets,
    );
  });

  it("sorts unordered bars defensively before folding", () => {
    const ordered = [day(2027, 0, 4, 100), day(2027, 0, 5, 110), day(2027, 0, 11, 130)];
    const shuffled = [ordered[2]!, ordered[0]!, ordered[1]!];
    assert.deepEqual(
      aggregateDailyBars({ bars: shuffled, kind: "1w", maxBars: 10 }),
      aggregateDailyBars({ bars: ordered, kind: "1w", maxBars: 10 }),
    );
  });

  it("applies the output cap after aggregation, keeping the newest buckets", () => {
    // Five distinct weeks; a cap of three must drop the OLDEST two after the
    // fold, not clip the source bars before it.
    const bars = [
      day(2026, 11, 28, 10),
      day(2027, 0, 4, 20),
      day(2027, 0, 11, 30),
      day(2027, 0, 18, 40),
      day(2027, 0, 25, 50),
    ];
    const capped = aggregateDailyBars({ bars, kind: "1w", maxBars: 3 });
    assert.deepEqual(
      capped.map((bucket) => bucket.openTime),
      [Date.UTC(2027, 0, 11), Date.UTC(2027, 0, 18), Date.UTC(2027, 0, 25)],
    );
    // The newest bucket is the newest week, with its own values intact.
    assert.equal(capped[capped.length - 1]?.open, 50);
  });

  it("returns nothing when there is nothing to fold, or nothing may be served", () => {
    assert.deepEqual(aggregateDailyBars({ bars: [], kind: "1mo", maxBars: 10 }), []);
    assert.deepEqual(
      aggregateDailyBars({ bars: [day(2027, 0, 1, 100)], kind: "1w", maxBars: 0 }),
      [],
    );
  });
});
