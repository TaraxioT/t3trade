/**
 * The sweep: one window, one parameter, one table.
 *
 * The properties worth pinning are not the arithmetic (that is `runBacktest`,
 * tested against hand-computed trades elsewhere) but the ones a refinement
 * tool can quietly get wrong: that two identical sweeps give an identical
 * table, that a swept row is exactly the run you would have got by asking for
 * that value on its own, that the marked row is never a small sample, and that
 * every refusal fires before any bar is walked.
 */
import { describe, expect, it } from "@effect/vitest";

import {
  applySweepValue,
  BACKTEST_MAX_BARS,
  BACKTEST_SWEEP_MAX_BAR_WALKS,
  BACKTEST_SWEEP_MAX_VALUES,
  checkBacktestSweep,
  runBacktest,
  runBacktestSweep,
  type BacktestCosts,
  type BacktestCoverage,
} from "./backtest.ts";
import type { MarketCandle } from "./market.ts";
import { MIN_REPLAY_SETUPS } from "./replay.ts";
import type { TradingThesis } from "./thesis.ts";

const MINUTE = 60_000;

const candle = (
  index: number,
  open: number,
  high: number,
  low: number,
  close: number,
): MarketCandle =>
  ({
    openTime: index * MINUTE,
    closeTime: index * MINUTE + MINUTE - 1,
    open,
    high,
    low,
    close,
    volume: 100,
    trades: 1,
  }) as MarketCandle;

const costs: BacktestCosts = {
  takerFeeBpsPerSide: 5,
  slippageBpsPerSide: 1,
  slippageSource: "assumed",
};

const coverageOver = (candles: ReadonlyArray<MarketCandle>): BacktestCoverage => ({
  requestedFromT: candles[0]?.openTime ?? 0,
  requestedToT: candles[candles.length - 1]?.openTime ?? 0,
  servedFromT: candles[0]?.openTime ?? null,
  servedToT: candles[candles.length - 1]?.openTime ?? null,
  barsServed: candles.length,
  gaps: [],
  recordingSince: candles[0]?.openTime ?? null,
  fundingServed: false,
});

// The same four-bar cycle the engine's known-answer run uses: price closes
// below 100, crosses above it, the next bar opens at 101 and trades to 103.
const CYCLE = [
  (i: number) => candle(i, 99, 99.5, 98.5, 99),
  (i: number) => candle(i, 99, 101.5, 99, 101),
  (i: number) => candle(i, 101, 103, 100.5, 102),
  (i: number) => candle(i, 102, 102, 97.5, 98),
];
const candles = Array.from({ length: 240 }, (_, i) =>
  (CYCLE[i % 4] as (n: number) => MarketCandle)(i),
);

const base: TradingThesis = {
  market: "ETH",
  interval: "1m",
  side: "long",
  entry: {
    predicates: [
      {
        left: { source: "price" },
        comparator: "crosses_above",
        right: { source: "constant", value: 100 },
      },
    ],
  },
  exits: { target: { basis: "percent", value: 1 }, maxHoldBars: 8 },
};

const sweep = (path: string, values: ReadonlyArray<number>) =>
  runBacktestSweep({
    thesis: base,
    sweep: { path, values },
    candles,
    costs,
    coverage: coverageOver(candles),
  });

describe("running a sweep", () => {
  it("reports one row per value, in the order they were named", () => {
    const { report } = sweep("exits.target.value", [0.5, 1, 2]);
    expect(report.rows.map((row) => row.value)).toEqual([0.5, 1, 2]);
    expect(report.path).toBe("exits.target.value");
  });

  it("gives an identical table when run twice", () => {
    // Determinism is not free here: the engine reuses one candle array and one
    // set of indicator series across variations, so a variation leaking state
    // into the next would show up as a second run disagreeing with the first.
    const first = sweep("exits.maxHoldBars", [4, 8, 12, 16]);
    const second = sweep("exits.maxHoldBars", [4, 8, 12, 16]);
    expect(second.report.rows).toEqual(first.report.rows);
    expect(second.report.bestIndex).toBe(first.report.bestIndex);
  });

  it("puts one coverage on the report rather than one per row", () => {
    // The single-load property, as it is observable at this layer: every
    // variation was measured on the same window, so the window is reported
    // once. A sweep that re-read the archive per value could not say this.
    const { report } = sweep("exits.maxHoldBars", [4, 8, 12]);
    expect(report.coverage.barsServed).toBe(candles.length);
    expect(report.rows).toHaveLength(3);
  });

  it("matches the run you would have got by asking for that value alone", () => {
    const { report } = sweep("exits.maxHoldBars", [4, 12]);
    for (const value of [4, 12]) {
      const varied = applySweepValue(base, "exits.maxHoldBars", value);
      expect(typeof varied).not.toBe("string");
      const alone = runBacktest({
        thesis: varied as TradingThesis,
        candles,
        costs,
        coverage: coverageOver(candles),
      });
      const row = report.rows.find((candidate) => candidate.value === value);
      expect(row?.expectancyUsd).toBe(alone.report.stats.expectancyUsd);
      expect(row?.tradesTaken).toBe(alone.report.stats.tradesTaken);
      expect(row?.verdict).toBe(alone.report.verdict);
    }
  });

  it("marks the best row by expectancy, and never marks an ungraded sample", () => {
    const { report } = sweep("exits.target.value", [0.5, 1, 2]);
    expect(report.bestIndex).not.toBeNull();
    const best = report.rows[report.bestIndex as number];
    expect(best?.verdict).not.toBe("insufficient_sample");
    for (const row of report.rows) {
      if (row.verdict === "insufficient_sample") continue;
      expect(row.expectancyUsd).toBeLessThanOrEqual(best?.expectancyUsd as number);
    }
  });

  it("marks nothing when no variation reached a gradeable sample", () => {
    const thin = candles.slice(0, 12);
    const { report } = runBacktestSweep({
      thesis: base,
      sweep: { path: "exits.maxHoldBars", values: [4, 8] },
      candles: thin,
      costs,
      coverage: coverageOver(thin),
    });
    for (const row of report.rows) {
      expect(row.tradesTaken).toBeLessThan(MIN_REPLAY_SETUPS);
    }
    expect(report.bestIndex).toBeNull();
  });
});

describe("what a sweep refuses", () => {
  const check = (path: string, values: ReadonlyArray<number>, bars = 1_000) =>
    checkBacktestSweep({ sweep: { path, values }, thesis: base, bars });

  it("takes twelve values and refuses the thirteenth", () => {
    const twelve = Array.from({ length: BACKTEST_SWEEP_MAX_VALUES }, (_, i) => i + 1);
    expect(check("exits.maxHoldBars", twelve)).toBeNull();
    const reason = check("exits.maxHoldBars", [...twelve, 13]);
    expect(reason).toContain("13 values");
    expect(reason).toContain(String(BACKTEST_SWEEP_MAX_VALUES));
  });

  it("refuses a path outside the closed set, and lists the set", () => {
    const reason = check("thesis.side", [1, 2]);
    expect(reason).toContain('"thesis.side" is not a parameter a sweep can move');
    expect(reason).toContain("exits.maxHoldBars");
  });

  it("refuses a leaf this particular thesis does not have", () => {
    expect(check("after.withinBars", [4, 8])).toContain("no after clause");
    expect(check("exits.stop.value", [1, 2])).toContain("has no stop");
    // The target here is a percent, so its size is `.value`, not `.multiple`.
    expect(check("exits.target.multiple", [1, 2])).toContain("is a percent");
  });

  it("refuses a period on an operand that has none", () => {
    expect(check("entry.predicates[0].left.period", [10, 20])).toContain("only an indicator");
    // The entry has one comparison, so index 1 does not exist.
    expect(check("entry.predicates[1].right.value", [10, 20])).toContain("has 1 comparisons");
  });

  it("refuses a total bar walk past the budget, and shows the arithmetic", () => {
    // The budget bites exactly where it is meant to: the full bar cap times
    // the full value count is the combination it exists to stop.
    const twelve = Array.from({ length: BACKTEST_SWEEP_MAX_VALUES }, (_, i) => i + 1);
    const reason = check("exits.maxHoldBars", twelve, BACKTEST_MAX_BARS);
    expect(reason).toContain((BACKTEST_MAX_BARS * 12).toLocaleString("en-US"));
    expect(reason).toContain(BACKTEST_SWEEP_MAX_BAR_WALKS.toLocaleString("en-US"));

    // And it does not bite a window people actually sweep.
    expect(check("exits.maxHoldBars", twelve, 20_000)).toBeNull();
  });

  it("refuses an empty value list rather than reporting an empty table", () => {
    expect(check("exits.maxHoldBars", [])).toContain("at least one value");
  });
});

describe("moving one leaf", () => {
  it("leaves the rest of the thesis untouched", () => {
    const varied = applySweepValue(base, "exits.maxHoldBars", 40) as TradingThesis;
    expect(varied.exits.maxHoldBars).toBe(40);
    expect(varied.entry).toEqual(base.entry);
    expect(varied.exits.target).toEqual(base.exits.target);
    expect(base.exits.maxHoldBars, "the original is not mutated").toBe(8);
  });

  it("reaches into the after clause without disturbing the entry", () => {
    const sequenced: TradingThesis = {
      ...base,
      after: {
        condition: {
          predicates: [
            {
              left: { source: "indicator", indicator: "rsi", period: 14 },
              comparator: "below",
              right: { source: "constant", value: 30 },
            },
          ],
        },
        withinBars: 10,
      },
    };
    const period = applySweepValue(
      sequenced,
      "after.condition.predicates[0].left.period",
      21,
    ) as TradingThesis;
    expect(period.after?.condition.predicates[0]?.left).toMatchObject({ period: 21 });
    expect(period.after?.withinBars).toBe(10);

    const reach = applySweepValue(sequenced, "after.withinBars", 25) as TradingThesis;
    expect(reach.after?.withinBars).toBe(25);
    expect(reach.after?.condition).toEqual(sequenced.after?.condition);
  });
});

describe("what the sweep puts on the wire", () => {
  /**
   * A `trading_backtest` result is exempt from tool-result summarization, so
   * the sweep report has to stay small by construction rather than by luck.
   * The unbounded parts are the row count (capped at twelve) and the thesis
   * (capped at four predicates plus an antecedent), so the worst case is a
   * full sweep of the widest thesis the grammar allows.
   */
  it("stays under the summarization ceiling at full width", () => {
    const wide: TradingThesis = {
      market: "ETH",
      interval: "1m",
      side: "long",
      entry: {
        match: "all",
        predicates: [
          {
            left: { source: "price" },
            comparator: "crosses_above",
            right: { source: "constant", value: 100 },
          },
          {
            left: { source: "indicator", indicator: "rsi", period: 14 },
            comparator: "below",
            right: { source: "constant", value: 70 },
          },
          {
            left: { source: "metric", metric: "volume_ratio" },
            comparator: "above",
            right: { source: "constant", value: 1.2 },
          },
          {
            left: { source: "metric", metric: "funding_rate_8h" },
            comparator: "below",
            right: { source: "constant", value: 0.001 },
          },
        ],
      },
      after: {
        condition: {
          predicates: [
            {
              left: { source: "price" },
              comparator: "below",
              right: { source: "constant", value: 99 },
            },
          ],
        },
        withinBars: 10,
      },
      exits: {
        stop: { basis: "atr", multiple: 1.5, period: 14 },
        target: { basis: "r", multiple: 2 },
        maxHoldBars: 8,
        opposite: {
          predicates: [
            {
              left: { source: "price" },
              comparator: "below",
              right: { source: "constant", value: 98 },
            },
          ],
        },
      },
    };
    const { report } = runBacktestSweep({
      thesis: wide,
      sweep: {
        path: "after.withinBars",
        values: Array.from({ length: BACKTEST_SWEEP_MAX_VALUES }, (_, i) => i + 1),
      },
      candles,
      costs,
      coverage: coverageOver(candles),
    });
    expect(report.rows).toHaveLength(BACKTEST_SWEEP_MAX_VALUES);

    // Measuring the wire size IS the assertion; there is nothing to decode.
    const bytes = JSON.stringify(report).length;
    expect(bytes, `the sweep report was ${bytes} chars`).toBeLessThan(8_000);
  });
});
