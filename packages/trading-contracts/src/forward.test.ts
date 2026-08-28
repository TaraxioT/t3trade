/**
 * Forward validation, pinned against the engine it is scored on.
 *
 * The headline test here is `agrees with the batch engine bar for bar`. Every
 * claim the feature makes — "forward is running worse than the backtest" — is
 * a comparison between two runs of arithmetic, and it means nothing unless the
 * incremental walk and the batch walk take the same trades at the same prices.
 * So the incremental machine is driven one bar at a time over a series the
 * batch engine has already walked, and the two trade lists are compared whole.
 */
import { describe, expect, it } from "@effect/vitest";

import { runBacktest, type BacktestCosts, type BacktestCoverage } from "./backtest.ts";
import {
  EMPTY_FORWARD_STATE,
  FORWARD_TRACKING_BAND,
  forwardWarmupBars,
  isForwardInterval,
  judgeForward,
  renderForwardMenu,
  stepForward,
  type ForwardState,
} from "./forward.ts";
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
    volume: 1,
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

/**
 * A series with enough shape to make a rule fire repeatedly: a slow drift with
 * a sawtooth on it, so price crosses its own average many times and the swings
 * are wide enough to reach a percent stop and target.
 */
const wavyCandles = (count: number): ReadonlyArray<MarketCandle> => {
  const bars: Array<MarketCandle> = [];
  for (let i = 0; i < count; i += 1) {
    const base = 100 + Math.sin(i / 7) * 6 + Math.sin(i / 23) * 3 + i * 0.01;
    const next = 100 + Math.sin((i + 1) / 7) * 6 + Math.sin((i + 1) / 23) * 3 + (i + 1) * 0.01;
    const open = Number(base.toFixed(4));
    const close = Number(next.toFixed(4));
    const high = Number((Math.max(open, close) + 0.35).toFixed(4));
    const low = Number((Math.min(open, close) - 0.35).toFixed(4));
    bars.push(candle(i, open, high, low, close));
  }
  return bars;
};

/**
 * Drive the incremental machine over a whole series, exactly as the service
 * does: one closed bar at a time, reading only a trailing window.
 *
 * Returns the settled trades in the shape the batch engine reports them, so
 * the two lists can be compared field by field.
 */
const walkForward = (
  thesis: TradingThesis,
  candles: ReadonlyArray<MarketCandle>,
  windowBars: number,
): ReadonlyArray<{
  readonly entryTime: number;
  readonly entryPrice: number;
  readonly exitTime: number;
  readonly exitPrice: number;
  readonly exitReason: string;
  readonly barsHeld: number;
}> => {
  let state: ForwardState = EMPTY_FORWARD_STATE;
  const settled: Array<{
    readonly entryTime: number;
    readonly entryPrice: number;
    readonly exitTime: number;
    readonly exitPrice: number;
    readonly exitReason: string;
    readonly barsHeld: number;
  }> = [];
  let sequence = 0;
  // The batch engine reports prices at four decimals; the service persists
  // paper fills the same way. Rounding here makes the comparison below exact
  // rather than approximate, which is the claim worth pinning.
  const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;

  for (let index = 0; index < candles.length; index += 1) {
    const from = Math.max(0, index - windowBars + 1);
    const window = candles.slice(from, index + 1);
    sequence += 1;
    const step = stepForward({
      thesis,
      candles: window,
      state,
      notionalUsd: 1_000,
      nextTradeId: `paper-${sequence}`,
    });
    state = step.state;
    if (step.exited !== null) {
      settled.push({
        entryTime: step.exited.entryTime,
        entryPrice: round4(step.exited.entryPrice),
        exitTime: step.exited.exitTime,
        exitPrice: round4(step.exited.exitPrice),
        exitReason: step.exited.exitReason,
        barsHeld: step.exited.barsHeld,
      });
    }
  }
  return settled;
};

describe("stepForward", () => {
  // The load-bearing test. If this ever fails, every "forward is tracking the
  // backtest" sentence the product says is unfounded, because the two engines
  // are no longer answering the same question.
  it.each([
    {
      name: "a percent stop and target on a price/SMA cross",
      tolerance: 0,
      thesis: {
        market: "ETH",
        interval: "1m",
        side: "long",
        entry: {
          predicates: [
            {
              left: { source: "price" },
              comparator: "crosses_above",
              right: { source: "indicator", indicator: "sma", period: 10 },
            },
          ],
        },
        exits: {
          stop: { basis: "percent", value: 0.4 },
          target: { basis: "percent", value: 0.6 },
        },
      } satisfies TradingThesis as TradingThesis,
    },
    {
      name: "a bar limit with no levels at all",
      tolerance: 0,
      thesis: {
        market: "ETH",
        interval: "1m",
        side: "long",
        entry: {
          predicates: [
            {
              left: { source: "price" },
              comparator: "crosses_below",
              right: { source: "indicator", indicator: "sma", period: 14 },
            },
          ],
        },
        exits: { maxHoldBars: 5 },
      } satisfies TradingThesis as TradingThesis,
    },
    {
      name: "an opposite condition, which exits at the next bar's open",
      tolerance: 0,
      thesis: {
        market: "ETH",
        interval: "1m",
        side: "long",
        entry: {
          predicates: [
            {
              left: { source: "price" },
              comparator: "crosses_above",
              right: { source: "indicator", indicator: "sma", period: 8 },
            },
          ],
        },
        exits: {
          opposite: {
            predicates: [
              {
                left: { source: "price" },
                comparator: "crosses_below",
                right: { source: "indicator", indicator: "sma", period: 8 },
              },
            ],
          },
        },
      } satisfies TradingThesis as TradingThesis,
    },
    {
      name: "a short with an ATR stop, whose distance is read at the signal bar",
      // The one case that cannot be exact, and the reason is the design's
      // rather than the test's. ATR is a Wilder average seeded by an SMA, so
      // the batch engine reading 600 bars and a forward step reading its
      // trailing warm-up window converge on very slightly different values.
      // `INDICATOR_LOOKBACK_MULTIPLE` bounds that gap to under 0.1% of the
      // reading, which lands well inside display precision — and it moves the
      // stop PRICE, never which trade is taken or why it ended. This asserts
      // the bound rather than pretending the gap is not there.
      tolerance: 5e-4,
      thesis: {
        market: "ETH",
        interval: "1m",
        side: "short",
        entry: {
          predicates: [
            {
              left: { source: "price" },
              comparator: "crosses_below",
              right: { source: "indicator", indicator: "sma", period: 12 },
            },
          ],
        },
        exits: {
          stop: { basis: "atr", multiple: 1.5, period: 14 },
          target: { basis: "r", multiple: 2 },
          maxHoldBars: 40,
        },
      } satisfies TradingThesis as TradingThesis,
    },
    {
      name: "a stop and a target reachable in the same bar, where the stop wins",
      tolerance: 0,
      thesis: {
        market: "ETH",
        interval: "1m",
        side: "long",
        entry: {
          predicates: [
            {
              left: { source: "price" },
              comparator: "crosses_above",
              right: { source: "indicator", indicator: "sma", period: 5 },
            },
          ],
        },
        exits: {
          stop: { basis: "percent", value: 0.1 },
          target: { basis: "percent", value: 0.1 },
        },
      } satisfies TradingThesis as TradingThesis,
    },
  ])("agrees with the batch engine bar for bar: $name", ({ thesis, tolerance }) => {
    const candles = wavyCandles(600);
    const batch = runBacktest({ thesis, candles, costs, coverage: coverageOver(candles) });

    // The batch engine's last trade may be left open by the window ending; a
    // forward walk has no window end, so it simply has not exited yet. Compare
    // the trades both engines actually settled on their own terms.
    const expected = batch.trades.filter((trade) => trade.exitReason !== "window_end");
    const forward = walkForward(thesis, candles, forwardWarmupBars(thesis));

    expect(expected.length, "the series must actually fire the rule").toBeGreaterThan(5);
    expect(forward.length).toBe(expected.length);
    for (const [index, trade] of expected.entries()) {
      const paper = forward[index];
      expect(paper, `trade ${index}`).toBeDefined();
      expect(paper?.entryTime, `trade ${index} entry time`).toBe(trade.entryTime);
      // The entry is always exact: it is a bar's own open, not a computed
      // level, so no indicator convergence can reach it.
      expect(paper?.entryPrice, `trade ${index} entry price`).toBe(trade.entryPrice);
      expect(paper?.exitTime, `trade ${index} exit time`).toBe(trade.exitTime);
      const exitGap = Math.abs((paper?.exitPrice ?? 0) - trade.exitPrice) / trade.exitPrice;
      expect(exitGap, `trade ${index} exit price, relative gap`).toBeLessThanOrEqual(tolerance);
      expect(paper?.exitReason, `trade ${index} exit reason`).toBe(trade.exitReason);
      expect(paper?.barsHeld, `trade ${index} bars held`).toBe(trade.barsHeld);
    }
  });

  it("fills at the next bar's open, never at the signal bar's close", () => {
    const thesis: TradingThesis = {
      market: "ETH",
      interval: "1m",
      side: "long",
      entry: {
        predicates: [
          {
            left: { source: "price" },
            comparator: "above",
            right: { source: "constant", value: 100 },
          },
        ],
      },
      exits: { maxHoldBars: 1 },
    };
    // Bar 0 closes at 101, so the rule holds there. The fill must be bar 1's
    // open of 200 — a number that exists nowhere on the signal bar.
    const candles = [
      candle(0, 99, 101, 99, 101),
      candle(1, 200, 201, 199, 200),
      candle(2, 300, 301, 299, 300),
    ];

    let state: ForwardState = EMPTY_FORWARD_STATE;
    const first = stepForward({
      thesis,
      candles: candles.slice(0, 1),
      state,
      notionalUsd: 1_000,
      nextTradeId: "a",
    });
    expect(first.entered, "nothing fills on the signal bar itself").toBeNull();
    expect(first.state.pendingEntrySignalTime).toBe(0);

    state = first.state;
    const second = stepForward({
      thesis,
      candles: candles.slice(0, 2),
      state,
      notionalUsd: 1_000,
      nextTradeId: "a",
    });
    expect(second.entered?.entryPrice).toBe(200);
    expect(second.entered?.entryTime).toBe(MINUTE);
    expect(second.entered?.signalTime).toBe(0);
  });

  it("does not enter on a setup whose stop cannot be priced yet", () => {
    // An ATR(14) stop inside the indicator's own warm-up has no distance, so
    // the setup is skipped rather than entered without a stop.
    const thesis: TradingThesis = {
      market: "ETH",
      interval: "1m",
      side: "long",
      entry: {
        predicates: [
          {
            left: { source: "price" },
            comparator: "above",
            right: { source: "constant", value: 1 },
          },
        ],
      },
      exits: { stop: { basis: "atr", multiple: 1, period: 14 } },
    };
    const candles = [candle(0, 100, 101, 99, 100), candle(1, 100, 101, 99, 100)];
    const first = stepForward({
      thesis,
      candles: candles.slice(0, 1),
      state: EMPTY_FORWARD_STATE,
      notionalUsd: 1_000,
      nextTradeId: "a",
    });
    const second = stepForward({
      thesis,
      candles,
      state: first.state,
      notionalUsd: 1_000,
      nextTradeId: "a",
    });
    expect(second.entered).toBeNull();
    expect(second.state.open).toBeNull();
  });
});

describe("forwardWarmupBars", () => {
  it("reaches back the indicator library's own convergence window", () => {
    const thesis: TradingThesis = {
      market: "ETH",
      interval: "5m",
      side: "long",
      entry: {
        predicates: [
          {
            left: { source: "price" },
            comparator: "above",
            right: { source: "indicator", indicator: "ema", period: 50 },
          },
        ],
      },
      exits: { maxHoldBars: 10 },
    };
    // Five periods is the library's convergence multiple; the margin covers
    // the previous bar a cross compares against.
    expect(forwardWarmupBars(thesis)).toBe(50 * 5 + 10);
  });
});

describe("isForwardInterval", () => {
  it("accepts the intervals candles are delivered on and refuses the rest", () => {
    expect(isForwardInterval("1m")).toBe(true);
    expect(isForwardInterval("1h")).toBe(true);
    // Archived and backtestable, but no delivery arrives for them, so a
    // validation armed on one would be permanently deaf.
    expect(isForwardInterval("4h")).toBe(false);
    expect(isForwardInterval("1d")).toBe(false);
  });
});

describe("judgeForward", () => {
  const stats = (over: Partial<Record<string, number>>) =>
    ({
      setupsFound: 0,
      tradesTaken: 0,
      setupsUnpriced: 0,
      wins: 0,
      losses: 0,
      breakEven: 0,
      winRatePercent: 0,
      averageWinUsd: 0,
      averageLossUsd: 0,
      expectancyUsd: 0,
      totalGrossUsd: 0,
      totalFeesUsd: 0,
      totalFundingUsd: 0,
      totalNetUsd: 0,
      maxDrawdownUsd: 0,
      timeInMarketPercent: 0,
      buyAndHoldNetUsd: 0,
      buyAndHoldReturnPercent: 0,
      ...over,
    }) as never;

  it("refuses a verdict under the sample floor but still prints the numbers", () => {
    const judged = judgeForward({
      stats: stats({ tradesTaken: MIN_REPLAY_SETUPS - 1, expectancyUsd: 5, winRatePercent: 90 }),
      baselineExpectancyUsd: 1,
      baselineTradesTaken: 100,
      barsWatched: 4_000,
      hasOpenTrade: false,
      status: "armed",
    });
    expect(judged.comparison).toBe("too_few_trades");
    expect(judged.verdictReason).toContain(`under the ${MIN_REPLAY_SETUPS}`);
    // The measured figures are still there — withholding them would be its
    // own dishonesty.
    expect(judged.verdictReason).toContain("$5.00 per trade");
    expect(judged.verdictReason).toContain("not evidence of an edge");
  });

  it("calls a difference inside the band tracking rather than a change", () => {
    const judged = judgeForward({
      stats: stats({ tradesTaken: MIN_REPLAY_SETUPS, expectancyUsd: 1.2 }),
      baselineExpectancyUsd: 1,
      baselineTradesTaken: 100,
      barsWatched: 9_000,
      hasOpenTrade: false,
      status: "armed",
    });
    expect(judged.comparison).toBe("tracking");
  });

  it("calls a fall past the band worse than the backtest", () => {
    const baseline = 1;
    const judged = judgeForward({
      stats: stats({
        tradesTaken: MIN_REPLAY_SETUPS,
        expectancyUsd: baseline - baseline * FORWARD_TRACKING_BAND - 0.01,
      }),
      baselineExpectancyUsd: baseline,
      baselineTradesTaken: 100,
      barsWatched: 9_000,
      hasOpenTrade: false,
      status: "armed",
    });
    expect(judged.comparison).toBe("worse_than_backtest");
    expect(judged.verdictReason).toContain("overfit");
  });

  it("says so when bars are passing under a paused validation", () => {
    const judged = judgeForward({
      stats: stats({ tradesTaken: 2 }),
      baselineExpectancyUsd: null,
      baselineTradesTaken: null,
      barsWatched: 100,
      hasOpenTrade: true,
      status: "paused",
    });
    expect(judged.verdictReason).toContain("paused");
    expect(judged.verdictReason).toContain("still open");
  });
});

describe("renderForwardMenu", () => {
  // The menu is served on demand rather than riding in every turn's system
  // prompt, which is only worth doing while it stays small. Measured rather
  // than eyeballed, and printed so the number is watched instead of drifting.
  it("stays lean and names every action and bound", () => {
    const menu = renderForwardMenu();
    process.stdout.write(`FORWARD_MENU_CHARS ${menu.length}\n`);
    expect(menu.length, "the forward menu must stay under 600 chars").toBeLessThan(600);

    for (const action of ["arm", "list", "pause", "resume", "end", "report"]) {
      expect(menu, `the menu must name the ${action} action`).toContain(action);
    }
    // The two facts a caller cannot infer and must not get wrong.
    expect(menu).toContain("durationHours");
    expect(menu, "the menu must say no order is ever placed").toContain("no order is ever placed");
  });
});
