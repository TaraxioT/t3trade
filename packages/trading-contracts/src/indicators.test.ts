/**
 * The on-demand indicator readings a look computes — the model pulls
 * `ema(20)` instead of deriving it from raw bars in context.
 *
 * The arithmetic is pinned against hand-computed values on tiny series; the
 * insufficient-bars cases pin that "could not be computed" is an absent
 * `value`, never a zero.
 */
import { describe, expect, it } from "@effect/vitest";

import {
  computeIndicator,
  computeIndicatorSeries,
  DEFAULT_INDICATOR_PERIODS,
  effectiveIndicatorPeriod,
  indicatorLookbackBars,
  INDICATOR_MAX_REQUESTS,
} from "./indicators.ts";
import type { MarketCandle } from "./market.ts";

/** A bar whose typical price is its close (high = low = close). */
const bar = (close: number, volume = 1): MarketCandle =>
  ({
    openTime: 0,
    closeTime: 0,
    open: close,
    close,
    high: close,
    low: close,
    volume,
    trades: 1,
  }) as MarketCandle;

describe("computeIndicator", () => {
  it("computes the SMA over the last `period` bars, and one bar back", () => {
    const candles = [1, 2, 3, 4, 5].map((close) => bar(close));
    const reading = computeIndicator({ kind: "sma", period: 3 }, candles);
    expect(reading.value).toBe(4); // (3+4+5)/3
    expect(reading.previous).toBe(3); // (2+3+4)/3
  });

  it("seeds the EMA with the first-period SMA, then smooths", () => {
    // Seed = SMA(1,2,3) = 2; k = 0.5. Then 4: 3; then 5: 4.
    const candles = [1, 2, 3, 4, 5].map((close) => bar(close));
    const reading = computeIndicator({ kind: "ema", period: 3 }, candles);
    expect(reading.value).toBe(4);
    expect(reading.previous).toBe(3);
  });

  it("computes Wilder's RSI, and reports 100 on a loss-free window", () => {
    const rising = [1, 2, 3, 4, 5].map((close) => bar(close));
    expect(computeIndicator({ kind: "rsi", period: 3 }, rising).value).toBe(100);

    // Alternating ±1 deltas: equal average gain and loss → RSI 50.
    const chop = [4, 5, 4, 5, 4, 5, 4, 5, 4].map((close) => bar(close));
    const reading = computeIndicator({ kind: "rsi", period: 4 }, chop);
    expect(reading.value).toBeGreaterThan(35);
    expect(reading.value).toBeLessThan(65);
  });

  it("volume-weights the VWAP, whole window by default", () => {
    // 10 on 3 volume, 20 on 1 volume: (30 + 20) / 4 = 12.5.
    const candles = [bar(10, 3), bar(20, 1)];
    const reading = computeIndicator({ kind: "vwap" }, candles);
    expect(reading.period).toBe(DEFAULT_INDICATOR_PERIODS.vwap);
    expect(reading.value).toBe(12.5);
    // One bar back only the first bar exists.
    expect(reading.previous).toBe(10);
  });

  it("windows the VWAP when the request names a period", () => {
    const candles = [bar(10, 1), bar(20, 1), bar(30, 1)];
    expect(computeIndicator({ kind: "vwap", period: 2 }, candles).value).toBe(25);
  });

  it("states 'could not be computed' as an absent value, never a zero", () => {
    const short = [bar(1), bar(2)].slice(0, 2);
    const reading = computeIndicator({ kind: "ema", period: 20 }, short);
    expect(reading.value).toBeUndefined();
    expect(reading.previous).toBeUndefined();
    expect(reading.period).toBe(20);

    // A window with volume 0 has no volume-weighted price.
    expect(computeIndicator({ kind: "vwap" }, [bar(10, 0)]).value).toBeUndefined();

    // Just enough bars for `value` but not for `previous`: the pair degrades
    // one side at a time.
    const exact = [1, 2, 3].map((close) => bar(close));
    const edge = computeIndicator({ kind: "sma", period: 3 }, exact);
    expect(edge.value).toBe(2);
    expect(edge.previous).toBeUndefined();
  });

  it("defaults the period per kind", () => {
    const candles = Array.from({ length: 30 }, (_, i) => bar(i + 1));
    expect(computeIndicator({ kind: "ema" }, candles).period).toBe(20);
    expect(computeIndicator({ kind: "rsi" }, candles).period).toBe(14);
  });

  it("caps one look at a handful of requests", () => {
    // The cap itself is enforced at the handler; the constant is the contract.
    expect(INDICATOR_MAX_REQUESTS).toBe(6);
  });
});

describe("indicatorLookbackBars", () => {
  it("asks for five periods of history, and never past the exchange's cap", () => {
    expect(indicatorLookbackBars([{ kind: "ema", period: 50 }])).toBe(250);
    // The longest request in the set decides for all of them.
    expect(
      indicatorLookbackBars([
        { kind: "ema", period: 20 },
        { kind: "ema", period: 50 },
      ]),
    ).toBe(250);
    // A missing period is the kind's default, not zero.
    expect(indicatorLookbackBars([{ kind: "ema" }])).toBe(100);
    // 200 is the longest period the schema admits; five of those is past 500.
    expect(indicatorLookbackBars([{ kind: "ema", period: 200 }])).toBe(500);
    // `vwap`'s whole-window read asks for nothing extra.
    expect(indicatorLookbackBars([{ kind: "vwap" }])).toBe(0);
  });

  it("gives an ema(50) enough seed decay to agree with the converged value", () => {
    // Two overlapping cycles — the shape real price has, and the one the SMA
    // seed reads wrong: the mean of the first 50 bars of a short window is not
    // where the EMA actually stood there.
    const closes = Array.from(
      { length: 600 },
      (_, i) => 1000 + 5 * Math.sin((2 * Math.PI * i) / 23) + 8 * Math.sin((2 * Math.PI * i) / 97),
    );
    const candles = closes.map((close) => bar(close));
    const at = (bars: number) =>
      computeIndicator({ kind: "ema", period: 50 }, candles.slice(-bars)).value ?? 0;

    const converged = at(600);
    // The old lookback: the seed is still in the answer.
    expect(Math.abs(at(120) - converged)).toBeGreaterThan(0.05);
    // The one `indicatorLookbackBars` asks for: two orders of magnitude closer.
    expect(Math.abs(at(250) - converged)).toBeLessThan(0.005);
    expect(indicatorLookbackBars([{ kind: "ema", period: 50 }])).toBe(250);
  });
});

// ---------------------------------------------------------------------------
// atr, macd, bollinger — the three the backtest engine added
// ---------------------------------------------------------------------------
//
// Every expectation below is hand-computed from the definition, not captured
// from a run. Where a closed form exists it is used: on a linear ramp the
// SMA-seeded EMA sits exactly `(period - 1) / 2` behind price for every bar it
// is defined on (the seed lands on the recursion's own fixed point), which
// makes MACD's 12/26/9 triple exactly computable without a spreadsheet.

/** A bar with an explicit range, for the true-range arithmetic ATR needs. */
const ohlc = (open: number, high: number, low: number, close: number): MarketCandle =>
  ({ openTime: 0, closeTime: 0, open, high, low, close, volume: 1, trades: 1 }) as MarketCandle;

describe("atr", () => {
  it("seeds on the mean of the first `period` true ranges, then smooths (Wilder)", () => {
    // Bar 0 has no previous close, so its range is unusable. Ranges 1..3 are
    // each exactly 10 (high - low = 10, and every gap is inside that), so the
    // seed is 10.
    const candles = [
      ohlc(100, 105, 95, 100),
      ohlc(100, 105, 95, 100),
      ohlc(100, 105, 95, 100),
      ohlc(100, 105, 95, 100),
    ];
    expect(computeIndicator({ kind: "atr", period: 3 }, candles).value).toBe(10);
  });

  it("counts the gap from the previous close, not just the bar's own range", () => {
    // Bars 1..3 each have a 2-wide body but open 8 above the previous close,
    // so the true range is |high - previousClose| = 10, not 2.
    const candles = [
      ohlc(100, 100, 100, 100),
      ohlc(108, 110, 108, 110),
      ohlc(118, 120, 118, 120),
      ohlc(128, 130, 128, 130),
    ];
    expect(computeIndicator({ kind: "atr", period: 3 }, candles).value).toBe(10);
  });

  it("smooths the seed toward a new range at 1/period", () => {
    // Seed over ranges 1..2 is 10. Bar 3's range is 20, so Wilder gives
    // (10 * 1 + 20) / 2 = 15.
    const candles = [
      ohlc(100, 105, 95, 100),
      ohlc(100, 105, 95, 100),
      ohlc(100, 105, 95, 100),
      ohlc(100, 110, 90, 100),
    ];
    expect(computeIndicator({ kind: "atr", period: 2 }, candles).value).toBe(15);
  });

  it("needs period + 1 bars, and says so with an absent value", () => {
    const candles = [ohlc(100, 105, 95, 100), ohlc(100, 105, 95, 100)];
    expect(computeIndicator({ kind: "atr", period: 3 }, candles).value).toBeUndefined();
    expect(computeIndicator({ kind: "atr" }, candles).period).toBe(14);
  });
});

describe("macd", () => {
  it("is fast minus slow on a ramp: exactly (26-1)/2 - (12-1)/2 = 7", () => {
    // On closes[i] = i the SMA-seeded EMA(p) equals i - (p - 1) / 2 exactly,
    // so the line is a constant 7, the EMA(9) of a constant is that constant,
    // and the histogram is exactly zero.
    const candles = Array.from({ length: 60 }, (_, i) => bar(i));
    const reading = computeIndicator({ kind: "macd" }, candles);
    expect(reading.period).toBe(12);
    expect(reading.value).toBe(7);
    expect(reading.signal).toBe(7);
    // Exactly zero by construction; the residue is float noise, not a drift.
    expect(reading.histogram).toBeCloseTo(0, 12);
    expect(reading.previous).toBe(7);
  });

  it("is flat at zero on a flat series", () => {
    const candles = Array.from({ length: 60 }, () => bar(100));
    const reading = computeIndicator({ kind: "macd" }, candles);
    expect(reading.value).toBe(0);
    expect(reading.signal).toBe(0);
    expect(reading.histogram).toBe(0);
  });

  it("defines the line nine bars before it can define the signal", () => {
    // The line needs the slow leg (26 bars); the signal needs nine line
    // values on top of it, so at 30 bars there is a line and no signal.
    const candles = Array.from({ length: 30 }, (_, i) => bar(i));
    const reading = computeIndicator({ kind: "macd" }, candles);
    expect(reading.value).toBe(7);
    expect(reading.signal).toBeUndefined();
    expect(reading.histogram).toBeUndefined();
  });

  it("has no reading at all below the slow leg", () => {
    const candles = Array.from({ length: 20 }, (_, i) => bar(i));
    expect(computeIndicator({ kind: "macd" }, candles).value).toBeUndefined();
  });
});

describe("bollinger", () => {
  it("puts the bands two population deviations either side of the SMA basis", () => {
    // Last three closes 2, 4, 6: mean 4, population variance
    // ((-2)^2 + 0 + 2^2) / 3 = 8/3, deviation sqrt(8/3) = 1.632993...
    const candles = [10, 2, 4, 6].map((close) => bar(close));
    const reading = computeIndicator({ kind: "bollinger", period: 3 }, candles);
    const deviation = Math.sqrt(8 / 3) * 2;
    expect(reading.value).toBe(4);
    expect(reading.upper).toBeCloseTo(4 + deviation, 4);
    expect(reading.lower).toBeCloseTo(4 - deviation, 4);
  });

  it("collapses both bands onto the basis when the window does not move", () => {
    const candles = Array.from({ length: 25 }, () => bar(100));
    const reading = computeIndicator({ kind: "bollinger" }, candles);
    expect(reading.period).toBe(20);
    expect(reading.value).toBe(100);
    expect(reading.upper).toBe(100);
    expect(reading.lower).toBe(100);
  });

  it("needs a full basis window before it reports anything", () => {
    const candles = [1, 2].map((close) => bar(close));
    expect(computeIndicator({ kind: "bollinger", period: 5 }, candles).value).toBeUndefined();
  });
});

describe("computeIndicatorSeries", () => {
  it("is the same arithmetic the two-value reading reports, at every bar", () => {
    const candles = Array.from({ length: 40 }, (_, i) => bar(100 + (i % 7)));
    for (const kind of ["ema", "sma", "rsi", "vwap", "atr", "macd", "bollinger"] as const) {
      const series = computeIndicatorSeries({ kind }, candles);
      const reading = computeIndicator({ kind }, candles);
      const latest = series[series.length - 1];
      // The reading rounds to six significant digits; the series does not.
      expect(latest === undefined ? undefined : Number(latest.value.toPrecision(6))).toBe(
        reading.value,
      );
    }
  });

  it("runs the same length as the bars, undefined where it is not yet defined", () => {
    const candles = Array.from({ length: 10 }, (_, i) => bar(i + 1));
    const series = computeIndicatorSeries({ kind: "sma", period: 3 }, candles);
    expect(series.length).toBe(10);
    expect(series[0]).toBeUndefined();
    expect(series[1]).toBeUndefined();
    expect(series[2]?.value).toBe(2);
    expect(series[9]?.value).toBe(9);
  });
});

describe("effectiveIndicatorPeriod", () => {
  it("sizes macd's history off its slow leg plus its signal, not its fast leg", () => {
    expect(effectiveIndicatorPeriod("macd", 12)).toBe(35);
    expect(effectiveIndicatorPeriod("ema", 12)).toBe(12);
    // Five of 35 is the history a macd request actually asks for.
    expect(indicatorLookbackBars([{ kind: "macd" }])).toBe(175);
    expect(indicatorLookbackBars([{ kind: "atr", period: 14 }])).toBe(70);
  });
});
