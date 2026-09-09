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
// @effect-diagnostics globalConsole:off - the char-budget tests print their
// measured sizes so the number is watched instead of drifting.
import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { runBacktest, type BacktestCosts, type BacktestCoverage } from "./backtest.ts";
import {
  baselineCoverageIncomplete,
  EMPTY_FORWARD_STATE,
  FORWARD_CALCULATION_VERSION,
  FORWARD_TRACKING_BAND,
  forwardWarmupBars,
  isForwardInterval,
  forwardEndSummary,
  ForwardReport,
  judgeForward,
  renderForwardMenu,
  serializeForwardBaselineContent,
  stepForward,
  type ForwardState,
} from "./forward.ts";
import type { MarketCandle } from "./market.ts";
import { MIN_REPLAY_SETUPS, settleOnBars } from "./replay.ts";
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
    for (const exit of step.exits) {
      settled.push({
        entryTime: exit.entryTime,
        entryPrice: round4(exit.entryPrice),
        exitTime: exit.exitTime,
        exitPrice: round4(exit.exitPrice),
        exitReason: exit.exitReason,
        barsHeld: exit.barsHeld,
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

  // ---------------------------------------------------------------------
  // the E1 repair: the baseline's own sample and coverage gate the
  // comparison, a heuristic band is called one, and a losing baseline is
  // never worded or read as success.
  // ---------------------------------------------------------------------

  it("refuses a zero-trade baseline as a comparison rather than calling the run better", () => {
    const judged = judgeForward({
      stats: stats({ tradesTaken: MIN_REPLAY_SETUPS, expectancyUsd: 5 }),
      baselineExpectancyUsd: 0,
      baselineTradesTaken: 0,
      barsWatched: 9_000,
      hasOpenTrade: false,
      status: "armed",
    });
    expect(judged.comparison).not.toBe("better_than_backtest");
    expect(judged.comparison).toBe("no_baseline");
    expect(judged.verdictReason).toContain("took only 0 trades");
  });

  it("refuses a baseline under the sample floor the same way", () => {
    const judged = judgeForward({
      stats: stats({ tradesTaken: MIN_REPLAY_SETUPS, expectancyUsd: 5 }),
      baselineExpectancyUsd: 1,
      baselineTradesTaken: MIN_REPLAY_SETUPS - 1,
      barsWatched: 9_000,
      hasOpenTrade: false,
      status: "armed",
    });
    expect(judged.comparison).toBe("no_baseline");
    expect(judged.verdictReason).toContain(`under the ${MIN_REPLAY_SETUPS} a comparison needs`);
  });

  it("refuses a baseline whose window was served too incompletely", () => {
    const judged = judgeForward({
      stats: stats({ tradesTaken: MIN_REPLAY_SETUPS, expectancyUsd: 5 }),
      baselineExpectancyUsd: 1,
      baselineTradesTaken: 100,
      barsWatched: 9_000,
      hasOpenTrade: false,
      status: "armed",
      baselineCoverage: {
        requestedFromT: 0,
        requestedToT: 1_000,
        servedFromT: 0,
        servedToT: 200,
        barsServed: 200,
        gaps: [],
        recordingSince: 0,
        fundingServed: false,
      },
    });
    expect(judged.comparison).toBe("no_baseline");
    expect(judged.verdictReason).toContain("served too little");
  });

  it("compares normally against a gradeable baseline whose coverage was recorded", () => {
    const judged = judgeForward({
      stats: stats({ tradesTaken: MIN_REPLAY_SETUPS, expectancyUsd: 1.2 }),
      baselineExpectancyUsd: 1,
      baselineTradesTaken: 100,
      barsWatched: 9_000,
      hasOpenTrade: false,
      status: "armed",
      baselineCoverage: {
        requestedFromT: 0,
        requestedToT: 1_000,
        servedFromT: 0,
        servedToT: 1_000,
        barsServed: 1_000,
        gaps: [],
        recordingSince: 0,
        fundingServed: false,
      },
    });
    expect(judged.comparison).toBe("tracking");
  });

  it("calls the tracking band a heuristic, never the noise of this sample", () => {
    const judged = judgeForward({
      stats: stats({ tradesTaken: MIN_REPLAY_SETUPS, expectancyUsd: 1.2 }),
      baselineExpectancyUsd: 1,
      baselineTradesTaken: 100,
      barsWatched: 9_000,
      hasOpenTrade: false,
      status: "armed",
    });
    expect(judged.verdictReason).toContain("heuristic");
    expect(judged.verdictReason).toContain("not a computed sampling distribution");
    expect(judged.verdictReason).not.toContain("noise of this sample");
  });

  it("does not word tracking a losing baseline as success", () => {
    const judged = judgeForward({
      stats: stats({ tradesTaken: MIN_REPLAY_SETUPS, expectancyUsd: -2.05 }),
      baselineExpectancyUsd: -2,
      baselineTradesTaken: 100,
      barsWatched: 9_000,
      hasOpenTrade: false,
      status: "armed",
    });
    expect(judged.comparison).toBe("tracking");
    expect(judged.verdictReason).toContain("Both figures lose money after fees");
    expect(judged.verdictReason).toContain("replication, not a result");
  });

  it("notes when a run better than its baseline still loses money", () => {
    const judged = judgeForward({
      stats: stats({ tradesTaken: MIN_REPLAY_SETUPS, expectancyUsd: -1 }),
      baselineExpectancyUsd: -5,
      baselineTradesTaken: 100,
      barsWatched: 9_000,
      hasOpenTrade: false,
      status: "armed",
    });
    expect(judged.comparison).toBe("better_than_backtest");
    expect(judged.verdictReason).toContain("still loses money after fees");
  });

  it("says waiting, not failing, for an event-anchored run whose next occurrence is ahead", () => {
    const judged = judgeForward({
      stats: stats({ tradesTaken: 0 }),
      baselineExpectancyUsd: null,
      baselineTradesTaken: null,
      barsWatched: 500,
      hasOpenTrade: false,
      status: "armed",
      awaitingEvent: true,
    });
    expect(judged.comparison).toBe("too_few_trades");
    expect(judged.verdictReason).toContain("waiting, not failing");
  });
});

describe("baseline provenance (the E1 repair)", () => {
  const stats = (over: Partial<Record<string, number>>) =>
    ({
      setupsFound: 0,
      tradesTaken: 30,
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

  const thesis = {
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
    exits: { maxHoldBars: 5 },
  } as never;

  /** A report as this build composes it, minus the fields under test. */
  const report = (extra: Record<string, unknown> = {}) => ({
    validationId: "v1",
    thesis,
    headline: "h",
    status: "armed",
    armedAt: 0,
    expiresAt: 1,
    endedAt: null,
    endReason: null,
    notionalUsd: 1_000,
    barsWatched: 10,
    stats: stats({}),
    openTrade: null,
    baselineExpectancyUsd: null,
    baselineWinRatePercent: null,
    baselineTradesTaken: null,
    comparison: "too_few_trades",
    verdictReason: "r",
    paperOnly: true,
    ...extra,
  });

  it("decodes a report written before provenance fields existed, lacking them", () => {
    const decoded = Schema.decodeUnknownSync(ForwardReport)(report());
    // Absent, not null and not defaulted: a legacy record explicitly has no
    // provenance, and a surface says "not recorded" rather than showing a
    // fabricated one.
    expect(decoded.calculationVersion).toBeUndefined();
    expect(decoded.baselineSource).toBeUndefined();
  });

  it("round-trips a report carrying its baseline source and calculation version", () => {
    const decoded = Schema.decodeUnknownSync(ForwardReport)(
      report({
        calculationVersion: FORWARD_CALCULATION_VERSION,
        baselineSource: {
          runId: "run-1",
          digest: "d1",
          computedAt: 123,
          coverage: {
            requestedFromT: 0,
            requestedToT: 100,
            servedFromT: 0,
            servedToT: 100,
            barsServed: 100,
            gaps: [],
            recordingSince: 0,
            fundingServed: false,
          },
          eventSetContentDigests: [{ eventSetId: "s1", digest: "abc" }],
        },
      }),
    );
    expect(decoded.calculationVersion).toBe(FORWARD_CALCULATION_VERSION);
    expect(decoded.baselineSource?.runId).toBe("run-1");
    expect(decoded.baselineSource?.coverage?.barsServed).toBe(100);
    expect(decoded.baselineSource?.eventSetContentDigests?.[0]?.digest).toBe("abc");
  });

  it("serializes baseline content canonically: key order is free, a changed figure is not", () => {
    const base = {
      thesis,
      notionalUsd: 1_000,
      costs: { takerFeeBpsPerSide: 5, slippageBpsPerSide: 1, slippageSource: "assumed" },
      coverage: {
        requestedFromT: 0,
        requestedToT: 100,
        servedFromT: 0,
        servedToT: 100,
        barsServed: 100,
        gaps: [],
        recordingSince: 0,
        fundingServed: false,
      },
      stats: stats({ expectancyUsd: 1.5 }),
      verdict: "positive_after_fees",
    };
    // The same content with every key written in a different order, and an
    // optional spelled as undefined rather than left out.
    const reordered = {
      verdict: base.verdict,
      stats: base.stats,
      coverage: {
        fundingServed: false,
        recordingSince: 0,
        gaps: [],
        barsServed: 100,
        servedToT: 100,
        servedFromT: 0,
        requestedToT: 100,
        requestedFromT: 0,
      },
      costs: { slippageSource: "assumed", slippageBpsPerSide: 1, takerFeeBpsPerSide: 5 },
      notionalUsd: base.notionalUsd,
      thesis: base.thesis,
    };
    expect(serializeForwardBaselineContent({ report: reordered })).toBe(
      serializeForwardBaselineContent({ report: base }),
    );
    const amended = { ...base, stats: stats({ expectancyUsd: 1.6 }) };
    expect(serializeForwardBaselineContent({ report: amended })).not.toBe(
      serializeForwardBaselineContent({ report: base }),
    );
  });

  it("marks a baseline window incomplete when nothing was served or a majority is missing", () => {
    const complete = {
      requestedFromT: 0,
      requestedToT: 1_000,
      servedFromT: 0,
      servedToT: 1_000,
      barsServed: 1_000,
      gaps: [],
      recordingSince: 0,
      fundingServed: false,
    } satisfies BacktestCoverage;
    expect(baselineCoverageIncomplete(complete)).toBe(false);
    expect(baselineCoverageIncomplete({ ...complete, servedFromT: null, servedToT: null })).toBe(
      true,
    );
    // 300 of 1000 missing at the tail, plus a 200 gap: exactly half the
    // window missing still compares; more than half does not.
    expect(
      baselineCoverageIncomplete({
        ...complete,
        servedToT: 700,
        gaps: [{ fromT: 300, toT: 500 }],
      }),
    ).toBe(false);
    expect(
      baselineCoverageIncomplete({
        ...complete,
        servedToT: 700,
        gaps: [{ fromT: 300, toT: 600 }],
      }),
    ).toBe(true);
  });
});

describe("string budgets", () => {
  const measured = (over: Record<string, number> = {}) =>
    ({
      setupsFound: 90,
      tradesTaken: 34,
      setupsUnpriced: 0,
      wins: 19,
      losses: 15,
      breakEven: 0,
      winRatePercent: 55.88,
      averageWinUsd: 4.1,
      averageLossUsd: -3.4,
      expectancyUsd: 0.79,
      totalGrossUsd: 61,
      totalFeesUsd: 34.1,
      totalFundingUsd: 0,
      totalNetUsd: 26.9,
      maxDrawdownUsd: 12.4,
      timeInMarketPercent: 31,
      buyAndHoldNetUsd: 0,
      buyAndHoldReturnPercent: 0,
      ...over,
    }) as never;

  // Everything this feature puts in front of a model or into a feed, measured
  // rather than eyeballed, and printed so the numbers are watched instead of
  // rediscovered the next time one of them grows a clause.
  it("keeps every served sentence inside its budget", () => {
    const verdict = judgeForward({
      stats: measured(),
      baselineExpectancyUsd: 1.1,
      baselineTradesTaken: 197,
      barsWatched: 20_160,
      hasOpenTrade: true,
      status: "armed",
    });
    const belowFloor = judgeForward({
      stats: measured({ tradesTaken: 4 }),
      baselineExpectancyUsd: -1.17,
      baselineTradesTaken: 197,
      barsWatched: 300,
      hasOpenTrade: false,
      status: "armed",
    });
    const summary = forwardEndSummary({
      headline: "ETH 1m EMA20 cross-above, 0.2%/0.3%/30bar",
      endReason: "expired",
      verdictReason: verdict.verdictReason,
    } as never);

    console.log(`MEASURED verdict_with_sample ${verdict.verdictReason.length}`);
    console.log(`MEASURED verdict_below_floor ${belowFloor.verdictReason.length}`);
    console.log(`MEASURED alert_summary ${summary.length}`);

    // The alert lands in a feed beside one-line price alerts, so it is the
    // tightest of these; the report card carries everything else.
    expect(summary.length, "the expiry alert must stay under 400 chars").toBeLessThan(400);
    expect(verdict.verdictReason.length, "a verdict sentence stays under 400").toBeLessThan(400);
    expect(belowFloor.verdictReason.length, "so does the below-floor one").toBeLessThan(400);
  });
});

describe("renderForwardMenu", () => {
  // The menu is served on demand rather than riding in every turn's system
  // prompt, which is only worth doing while it stays small. Measured rather
  // than eyeballed, and printed so the number is watched instead of drifting.
  it("stays lean and names every action and bound", () => {
    const menu = renderForwardMenu();
    console.log(`FORWARD_MENU_CHARS ${menu.length}`);
    expect(menu.length, "the forward menu must stay under 600 chars").toBeLessThan(600);

    for (const action of ["arm", "list", "pause", "resume", "end", "report"]) {
      expect(menu, `the menu must name the ${action} action`).toContain(action);
    }
    // The two facts a caller cannot infer and must not get wrong.
    expect(menu).toContain("durationHours");
    expect(menu, "the menu must say no order is ever placed").toContain("no order is ever placed");
  });
});

describe("one causal re-entry policy, batch and forward (the B3 repair)", () => {
  const parity = (thesis: TradingThesis, candles: ReadonlyArray<MarketCandle>) => {
    const batch = runBacktest({ thesis, candles, costs, coverage: coverageOver(candles) });
    const expected = batch.trades.filter((trade) => trade.exitReason !== "window_end");
    const forward = walkForward(thesis, candles, forwardWarmupBars(thesis));
    return { expected, forward };
  };

  it("a persistent condition with maxHoldBars 1 trades every bar in both engines", () => {
    // No cross anywhere: the entry condition is simply ALWAYS true, so the
    // sequence is the pure re-entry question — exit at one bar's open, enter
    // at the same open, repeat. Cross-only fixtures could never expose a
    // disagreement here because a cross fires once per crossing.
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
      exits: { maxHoldBars: 1 },
    };
    const { expected, forward } = parity(thesis, wavyCandles(300));
    expect(expected.length).toBeGreaterThan(10);
    expect(forward.length).toBe(expected.length);
    for (const [index, trade] of expected.entries()) {
      const paper = forward[index];
      expect(paper?.entryTime, `trade ${index} entry time`).toBe(trade.entryTime);
      expect(paper?.exitTime, `trade ${index} exit time`).toBe(trade.exitTime);
      expect(paper?.exitReason, `trade ${index} exit reason`).toBe(trade.exitReason);
      expect(paper?.barsHeld, `trade ${index} bars held`).toBe(trade.barsHeld);
    }
  });

  it("after an intrabar level exit, batch re-enters no earlier than forward", () => {
    // The defect this pins: a level exit happens INSIDE its bar, after the
    // open, so the position was not flat at that open. Batch used to resume
    // scanning one bar earlier and re-entered at the exit bar's own open — a
    // bar where the position was demonstrably still held — while forward
    // correctly waited for the next bar. Entry always true + a tight stop
    // makes every trade a level exit, so any disagreement shows immediately.
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
      exits: { stop: { basis: "percent", value: 0.2 }, maxHoldBars: 30 },
    };
    const { expected, forward } = parity(thesis, wavyCandles(400));
    expect(expected.some((trade) => trade.exitReason === "stop")).toBe(true);
    expect(forward.length).toBe(expected.length);
    for (const [index, trade] of expected.entries()) {
      const paper = forward[index];
      expect(paper?.entryTime, `trade ${index} entry time`).toBe(trade.entryTime);
      expect(paper?.exitTime, `trade ${index} exit time`).toBe(trade.exitTime);
      expect(paper?.exitPrice, `trade ${index} exit price`).toBe(trade.exitPrice);
      expect(paper?.exitReason, `trade ${index} exit reason`).toBe(trade.exitReason);
    }
  });
});

describe("gap-through fills: one documented fill model (the B4 repair)", () => {
  it("a long stop at 95 followed by a bar opening at 90 fills at 90, never 95", () => {
    const settlement = settleOnBars({
      long: true,
      entryPrice: 100,
      stopPrice: 95,
      size: 10,
      bars: [candle(0, 90, 91, 88, 89)],
    });
    expect(settlement.outcome).toBe("stop");
    expect(settlement.exitPrice).toBe(90);
  });

  it("the short symmetry: a short's stop at 105 with a bar opening at 110 fills at 110", () => {
    const settlement = settleOnBars({
      long: false,
      entryPrice: 100,
      stopPrice: 105,
      size: 10,
      bars: [candle(0, 110, 112, 109, 111)],
    });
    expect(settlement.outcome).toBe("stop");
    expect(settlement.exitPrice).toBe(110);
  });

  it("a stop reached inside a bar without a gap still fills at the stop level", () => {
    const settlement = settleOnBars({
      long: true,
      entryPrice: 100,
      stopPrice: 95,
      size: 10,
      bars: [candle(0, 99, 100, 94, 96)],
    });
    expect(settlement.outcome).toBe("stop");
    expect(settlement.exitPrice).toBe(95);
  });

  it("a long target with a bar opening above it fills at the open — a limit's better price", () => {
    const settlement = settleOnBars({
      long: true,
      entryPrice: 100,
      targetPrice: 105,
      size: 10,
      bars: [candle(0, 108, 109, 107, 108)],
    });
    expect(settlement.outcome).toBe("target");
    expect(settlement.exitPrice).toBe(108);
  });

  it("a bar holding both levels with a gap through the stop settles as the stop at the open", () => {
    // Tie policy unchanged — the stop wins a bar holding both — but the stop
    // leg pays the gap-through price when the bar opened beyond it.
    const settlement = settleOnBars({
      long: true,
      entryPrice: 100,
      stopPrice: 95,
      targetPrice: 105,
      size: 10,
      bars: [candle(0, 90, 106, 89, 104)],
    });
    expect(settlement.outcome).toBe("stop");
    expect(settlement.exitPrice).toBe(90);
  });

  it("the forward engine applies the same gap-through model to a held position", () => {
    // Enter at bar 0's open (signal armed on a fabricated prior state), hold
    // through bar 1 which OPENS below the stop: the exit fills at bar 1's
    // open, not at the stop level.
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
      exits: { stop: { basis: "percent", value: 5 } },
    };
    const step = stepForward({
      thesis,
      candles: [candle(0, 100, 101, 99, 100), candle(1, 90, 91, 88, 89)],
      state: {
        open: {
          id: "paper-gap",
          entryTime: 0,
          entryPrice: 100,
          signalTime: -MINUTE,
          stopPrice: 95,
          targetPrice: null,
          barsHeld: 1,
          adverseExcursionUsd: 0,
        },
        pendingEntrySignalTime: null,
        pendingExitReason: null,
      },
      notionalUsd: 1_000,
      nextTradeId: "unused",
    });
    expect(step.exits.length).toBe(1);
    expect(step.exits[0]?.exitPrice).toBe(90);
    expect(step.exits[0]?.exitReason).toBe("stop");
  });
});

describe("one bar can settle two trades (the F1 repair)", () => {
  it("a pending exit and a same-bar stop on the new entry both survive the step", () => {
    // Bar 0's close armed both: the exit of the held position (max hold) and
    // the entry signal (condition always true). Bar 1 then settles the OLD
    // trade at its open, fills the NEW trade at the same open, and the new
    // position's stop is hit inside bar 1. The single-exit shape used to
    // overwrite the old exit with the new one; both must come back, in
    // causal order.
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
      exits: { stop: { basis: "percent", value: 5 }, maxHoldBars: 1 },
    };
    const bar0 = candle(0, 100, 101, 99, 100);
    const bar1 = candle(1, 100, 101, 92, 93);
    const state: ForwardState = {
      open: {
        id: "old-trade",
        entryTime: 0,
        entryPrice: 100,
        signalTime: -MINUTE,
        stopPrice: 80,
        targetPrice: null,
        barsHeld: 1,
        adverseExcursionUsd: 0,
      },
      pendingEntrySignalTime: 0,
      pendingExitReason: "max_hold",
    };
    const step = stepForward({
      thesis,
      candles: [bar0, bar1],
      state,
      notionalUsd: 1_000,
      nextTradeId: "new-trade",
    });
    expect(step.exits.length).toBe(2);
    // Causal order: the old trade settles first, at bar 1's open...
    expect(step.exits[0]?.tradeId).toBe("old-trade");
    expect(step.exits[0]?.exitPrice).toBe(100);
    expect(step.exits[0]?.exitReason).toBe("max_hold");
    // ...then the new trade, entered at the same open and stopped inside it.
    expect(step.entered?.entryTime).toBe(bar1.openTime);
    expect(step.exits[1]?.tradeId).toBe("new-trade");
    expect(step.exits[1]?.exitPrice).toBe(95);
    expect(step.exits[1]?.exitReason).toBe("stop");
    expect(step.state.open).toBeNull();
    expect(step.state.pendingEntrySignalTime).not.toBeNull();
  });
});
