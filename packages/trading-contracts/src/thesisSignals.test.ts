/**
 * The widened grammar, pinned on series whose answer is arithmetic.
 *
 * Every expectation here is a number computed by hand off a synthesized
 * series, not a snapshot of what the engine currently returns. The metric
 * operands are bracketed rather than compared loosely - a rule that says the
 * reading is above 0.00007 AND below 0.00009 pins it to 0.00008, which is the
 * only way a comparison-only surface can assert an exact value.
 *
 * The sequence tests carry the one invariant the whole engine rests on: an
 * `after` clause looks backwards and only backwards, so adding one can never
 * make a signal depend on a bar that had not happened yet.
 */
import { describe, expect, it } from "@effect/vitest";

import { makeThesisSignals } from "./backtest.ts";
import type { MarketCandle } from "./market.ts";
import { THESIS_VOLUME_RATIO_BARS, type ThesisCondition, type TradingThesis } from "./thesis.ts";

const MINUTE = 60_000;

/** A bar that neither moves nor gaps, at a named volume. */
const bar = (index: number, price: number, volume = 1): MarketCandle =>
  ({
    openTime: index * MINUTE,
    closeTime: index * MINUTE + MINUTE - 1,
    open: price,
    high: price,
    low: price,
    close: price,
    volume,
    trades: 1,
  }) as MarketCandle;

/** The smallest thesis that carries a condition: the exits are never reached. */
const thesisWith = (entry: ThesisCondition, after?: TradingThesis["after"]): TradingThesis => ({
  market: "ETH",
  interval: "1m",
  side: "long",
  entry,
  ...(after === undefined ? {} : { after }),
  exits: { maxHoldBars: 1 },
});

const holdsAt = (
  thesis: TradingThesis,
  candles: ReadonlyArray<MarketCandle>,
  funding?: ReadonlyArray<{ readonly time: number; readonly fundingRate: number }>,
): ReadonlyArray<boolean> => {
  const signals = makeThesisSignals({
    thesis,
    candles,
    ...(funding === undefined ? {} : { funding }),
  });
  return candles.map((_, index) => signals.entryFires(index));
};

// ---------------------------------------------------------------------------
// funding_rate_8h
// ---------------------------------------------------------------------------
//
// The archive stores an HOURLY rate; the operand reports the 8h rate, which is
// eight of them. Held stepwise: the row at or before the bar's CLOSE time, and
// nothing at all before the first row.
//
// Rows at 120,000ms (rate 0.00001) and 300,000ms (rate -0.00002). Bar `i`
// closes at `i * 60,000 + 59,999`, so:
//
//   bar 0  closes  59,999  - before the first row      → undefined
//   bar 1  closes 119,999  - still before it           → undefined
//   bar 2  closes 179,999  - first row in force        → 0.00001 * 8 = 0.00008
//   bar 4  closes 299,999  - STILL the first row       → 0.00008
//   bar 5  closes 359,999  - second row in force       → -0.00002 * 8 = -0.00016

const FUNDING = [
  { time: 120_000, fundingRate: 0.00001 },
  { time: 300_000, fundingRate: -0.00002 },
];

describe("the funding_rate_8h operand", () => {
  const sixBars = Array.from({ length: 6 }, (_, i) => bar(i, 100));

  it("reads the archived hourly rate at the bar's close, times eight", () => {
    // Bracketed on both sides, so this asserts the value is exactly 0.00008
    // rather than merely positive. A missing x8 would read 0.00001 and fail
    // the lower bound; an interpolated rate would fail one of them on bar 4.
    const bracketed = thesisWith({
      match: "all",
      predicates: [
        {
          left: { source: "metric", metric: "funding_rate_8h" },
          comparator: "above",
          right: { source: "constant", value: 0.00007 },
        },
        {
          left: { source: "metric", metric: "funding_rate_8h" },
          comparator: "below",
          right: { source: "constant", value: 0.00009 },
        },
      ],
    });
    expect(holdsAt(bracketed, sixBars, FUNDING)).toEqual([
      false, // no row yet
      false, // no row yet
      true, //  0.00008
      true, //  0.00008
      true, //  0.00008, the row at 300,000 is not in force until bar 5
      false, // -0.00016
    ]);
  });

  it("carries the sign, and steps to the next row on the bar that closes after it", () => {
    const negative = thesisWith({
      match: "all",
      predicates: [
        {
          left: { source: "metric", metric: "funding_rate_8h" },
          comparator: "below",
          right: { source: "constant", value: -0.00015 },
        },
        {
          left: { source: "metric", metric: "funding_rate_8h" },
          comparator: "above",
          right: { source: "constant", value: -0.00017 },
        },
      ],
    });
    expect(holdsAt(negative, sixBars, FUNDING)).toEqual([
      false,
      false,
      false,
      false,
      false,
      true, // -0.00016
    ]);
  });

  it("reads nothing at all when the archive served no funding rows", () => {
    // Not zero. A rule comparing against a rate that was never recorded must
    // not fire on the number zero, which is a real funding rate.
    const anyRate = thesisWith({
      predicates: [
        {
          left: { source: "metric", metric: "funding_rate_8h" },
          comparator: "above",
          right: { source: "constant", value: -1 },
        },
      ],
    });
    expect(holdsAt(anyRate, sixBars)).toEqual([false, false, false, false, false, false]);
  });
});

// ---------------------------------------------------------------------------
// volume and volume_ratio
// ---------------------------------------------------------------------------

describe("the volume operands", () => {
  it("reads the bar's own volume", () => {
    const candles = [bar(0, 100, 500), bar(1, 100, 1_500), bar(2, 100, 900)];
    const busy = thesisWith({
      predicates: [
        {
          left: { source: "metric", metric: "volume" },
          comparator: "above",
          right: { source: "constant", value: 1_000 },
        },
      ],
    });
    expect(holdsAt(busy, candles)).toEqual([false, true, false]);
  });

  // Twenty bars of 100, then one of 300, then one of 100.
  //
  //   bar 19  only 19 priors exist                      → undefined
  //   bar 20  priors are bars 0..19, mean 100           → 300 / 100 = 3.0
  //   bar 21  priors are bars 1..20, sum 2,200, mean 110 → 100 / 110 = 0.909...
  const paced = [
    ...Array.from({ length: THESIS_VOLUME_RATIO_BARS }, (_, i) => bar(i, 100, 100)),
    bar(THESIS_VOLUME_RATIO_BARS, 100, 300),
    bar(THESIS_VOLUME_RATIO_BARS + 1, 100, 100),
  ];

  it("measures a bar against the mean of the previous twenty", () => {
    const surge = thesisWith({
      match: "all",
      predicates: [
        {
          left: { source: "metric", metric: "volume_ratio" },
          comparator: "above",
          right: { source: "constant", value: 2.99 },
        },
        {
          left: { source: "metric", metric: "volume_ratio" },
          comparator: "below",
          right: { source: "constant", value: 3.01 },
        },
      ],
    });
    const fired = holdsAt(surge, paced);
    expect(fired[THESIS_VOLUME_RATIO_BARS], "the 3x bar is the only one at 3.0").toBe(true);
    expect(fired.filter(Boolean)).toHaveLength(1);
  });

  it("moves the window forward: the surge bar raises the pace behind the next one", () => {
    const quiet = thesisWith({
      match: "all",
      predicates: [
        {
          left: { source: "metric", metric: "volume_ratio" },
          comparator: "above",
          right: { source: "constant", value: 0.9 },
        },
        {
          left: { source: "metric", metric: "volume_ratio" },
          comparator: "below",
          right: { source: "constant", value: 0.92 },
        },
      ],
    });
    const fired = holdsAt(quiet, paced);
    // 100 / 110 = 0.9090..., which only holds once the 300 bar is inside the
    // trailing mean. Every earlier bar sat at exactly 1.0.
    expect(fired[THESIS_VOLUME_RATIO_BARS + 1]).toBe(true);
    expect(fired.filter(Boolean)).toHaveLength(1);
  });

  it("is undefined until twenty priors exist, rather than reading a short mean", () => {
    const anyRatio = thesisWith({
      predicates: [
        {
          left: { source: "metric", metric: "volume_ratio" },
          comparator: "above",
          right: { source: "constant", value: 0 },
        },
      ],
    });
    const fired = holdsAt(anyRatio, paced);
    for (let index = 0; index < THESIS_VOLUME_RATIO_BARS; index += 1) {
      expect(fired[index], `bar ${index} has only ${index} priors`).toBe(false);
    }
    expect(fired[THESIS_VOLUME_RATIO_BARS]).toBe(true);
  });

  it("reads nothing when the priors did not trade at all", () => {
    const silent = [
      ...Array.from({ length: THESIS_VOLUME_RATIO_BARS }, (_, i) => bar(i, 100, 0)),
      bar(THESIS_VOLUME_RATIO_BARS, 100, 50),
    ];
    const anyRatio = thesisWith({
      predicates: [
        {
          left: { source: "metric", metric: "volume_ratio" },
          comparator: "above",
          right: { source: "constant", value: 0 },
        },
      ],
    });
    expect(holdsAt(anyRatio, silent).some(Boolean)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// the after clause
// ---------------------------------------------------------------------------
//
// A series that dips to 90 exactly once, on bar 2, and closes above 110 on
// bars 4 through 9. The antecedent is "price below 95" and the entry is
// "price above 105", so the only question each test asks is how far the entry
// is allowed to reach back for the dip.

const dipThenRally = [
  bar(0, 100),
  bar(1, 100),
  bar(2, 90), //  the antecedent, and the only bar that matches it
  bar(3, 100),
  bar(4, 110), // entry condition holds from here on
  bar(5, 110),
  bar(6, 110),
  bar(7, 110),
  bar(8, 110),
  bar(9, 110),
];

const ENTRY: ThesisCondition = {
  predicates: [
    {
      left: { source: "price" },
      comparator: "above",
      right: { source: "constant", value: 105 },
    },
  ],
};

const ANTECEDENT: ThesisCondition = {
  predicates: [
    {
      left: { source: "price" },
      comparator: "below",
      right: { source: "constant", value: 95 },
    },
  ],
};

const firedBars = (withinBars: number): ReadonlyArray<number> =>
  holdsAt(thesisWith(ENTRY, { condition: ANTECEDENT, withinBars }), dipThenRally)
    .map((fired, index) => (fired ? index : -1))
    .filter((index) => index >= 0);

describe("the after clause", () => {
  it("fires when the antecedent matched on the immediately previous bar", () => {
    // Bar 3 is the only bar whose immediately previous bar is the dip, and the
    // entry does not hold there. Reach of 2 puts the dip one bar further back
    // than bar 4's own predecessor, so 2 is the shortest reach that can fire.
    expect(firedBars(1)).toEqual([]);
    expect(firedBars(2)).toEqual([4]);
  });

  it("fires at the withinBars horizon exactly, and not one bar past it", () => {
    // The dip is on bar 2. Bar 7 is five bars later, bar 8 is six.
    expect(firedBars(5), "bar 7 is exactly five bars after the dip").toContain(7);
    expect(firedBars(5), "bar 8 is one bar beyond the reach").not.toContain(8);
    expect(firedBars(6), "widening the reach by one admits bar 8").toContain(8);
  });

  it("never counts the entry bar as its own antecedent", () => {
    // One bar that satisfies both rules at once. With no `after` it is a
    // signal; with one it must not be, because nothing preceded it.
    const both: ThesisCondition = {
      predicates: [
        {
          left: { source: "price" },
          comparator: "above",
          right: { source: "constant", value: 50 },
        },
      ],
    };
    const candles = [bar(0, 100), bar(1, 100), bar(2, 100)];
    expect(holdsAt(thesisWith(both), candles)).toEqual([true, true, true]);
    // The antecedent is the same condition, so it only ever matches the entry
    // bar itself and the bars before it. Bar 0 has no predecessor and must not
    // fire; the rest do, on their predecessors.
    expect(holdsAt(thesisWith(both, { condition: both, withinBars: 1 }), candles)).toEqual([
      false,
      true,
      true,
    ]);
  });

  it("still requires the entry condition itself", () => {
    // The dip precedes bars 3 through 9, but the entry only holds from bar 4.
    expect(firedBars(10)).toEqual([4, 5, 6, 7, 8, 9]);
  });
});

// ---------------------------------------------------------------------------
// no lookahead
// ---------------------------------------------------------------------------

describe("the sequence reads only backwards", () => {
  // A series with something happening on most bars, so the check is not
  // vacuous: the dip repeats, the entry level is crossed repeatedly, and the
  // volume pace moves.
  const mixed = Array.from({ length: 60 }, (_, i) =>
    bar(i, 100 + (i % 7) * 3 - (i % 11), 100 + (i % 5) * 40),
  );

  const sequenced = thesisWith(
    {
      match: "all",
      predicates: [
        {
          left: { source: "price" },
          comparator: "above",
          right: { source: "constant", value: 108 },
        },
        {
          left: { source: "metric", metric: "volume_ratio" },
          comparator: "above",
          right: { source: "constant", value: 0.8 },
        },
      ],
    },
    {
      condition: {
        predicates: [
          {
            left: { source: "price" },
            comparator: "below",
            right: { source: "constant", value: 96 },
          },
        ],
      },
      withinBars: 8,
    },
  );

  it("gives the same answer at a bar however much data comes after it", () => {
    const whole = holdsAt(sequenced, mixed, FUNDING);
    // Truncating the series after bar `end` must not change the verdict on any
    // bar at or before it. If the antecedent scan ever read forwards, or the
    // entry read its own future, a shorter window would disagree here.
    for (let end = 1; end < mixed.length; end += 1) {
      const prefix = holdsAt(sequenced, mixed.slice(0, end + 1), FUNDING);
      expect(prefix, `a window ending at bar ${end} must agree with the full run`).toEqual(
        whole.slice(0, end + 1),
      );
    }
  });

  it("fires somewhere, so the agreement above is not vacuous", () => {
    expect(holdsAt(sequenced, mixed, FUNDING).filter(Boolean).length).toBeGreaterThan(0);
  });
});
