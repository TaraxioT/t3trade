/**
 * The backtest engine, pinned on series whose answer is known before the run.
 *
 * Nothing here is a snapshot. Every expected number is arithmetic done by hand
 * off a synthesized series: a rule that fires an exact number of times, a fill
 * whose price is a bar field rather than a computed one, and a cost that is the
 * fee model evaluated on paper. A snapshot would pin whatever the engine does;
 * these pin what it is supposed to do.
 */
import { describe, expect, it } from "@effect/vitest";

import {
  BACKTEST_MAX_BARS,
  BACKTEST_TAKER_FEE_BPS_PER_SIDE,
  checkBacktestBarBudget,
  runBacktest,
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
    volume: 1,
    trades: 1,
  }) as MarketCandle;

/** A bar that neither moves nor gaps. */
const flat = (index: number, price: number): MarketCandle =>
  candle(index, price, price, price, price);

/** No book to measure a crossing cost from, so both figures are named here. */
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

const run = (
  thesis: TradingThesis,
  candles: ReadonlyArray<MarketCandle>,
  extra?: {
    readonly funding?: ReadonlyArray<{ readonly time: number; readonly fundingRate: number }>;
    readonly costs?: BacktestCosts;
  },
) =>
  runBacktest({
    thesis,
    candles,
    coverage: coverageOver(candles),
    costs: extra?.costs ?? costs,
    ...(extra?.funding === undefined ? {} : { funding: extra.funding }),
  });

// ---------------------------------------------------------------------------
// the known-answer run
// ---------------------------------------------------------------------------
//
// A four-bar cycle repeated 25 times. Price closes below 100, closes above it
// (the cross), then the NEXT bar opens at 101 and trades up through 103 before
// coming back down. So the rule fires exactly 25 times, the fill is exactly 101
// every time, and the 1% target at 102.01 is reached on the fill bar itself.
//
// Per trade, entirely by hand:
//   size    = 1000 / 101                    = 9.900990... base units
//   gross   = 1.01 * 1000 / 101             = $10.00 exactly
//   exit notional = 102.01 * 1000 / 101     = $1,010.00 exactly
//   fees    = (1000 + 1010) * 6bps          = $1.206
//   net     = 10.00 - 1.206                 = $8.794 → $8.79 at cents

const CYCLE = [
  (i: number) => candle(i, 99, 99.5, 98.5, 99),
  (i: number) => candle(i, 99, 101.5, 99, 101),
  (i: number) => candle(i, 101, 103, 100.5, 102),
  (i: number) => candle(i, 102, 102, 97.5, 98),
];

const cycles = (count: number): ReadonlyArray<MarketCandle> =>
  Array.from({ length: count * 4 }, (_, i) => (CYCLE[i % 4] as (n: number) => MarketCandle)(i));

const crossThesis: TradingThesis = {
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
  exits: {
    stop: { basis: "percent", value: 1 },
    target: { basis: "percent", value: 1 },
  },
};

describe("runBacktest — the known answer", () => {
  it("fires the exact number of times the series was built to fire", () => {
    const candles = cycles(25);
    const { report, trades } = run(crossThesis, candles);

    expect(report.stats.setupsFound).toBe(25);
    expect(report.stats.tradesTaken).toBe(25);
    expect(report.stats.setupsUnpriced).toBe(0);
    // Every cross is at index 1, 5, 9 ...; every fill is the bar after it.
    expect(trades.map((trade) => trade.entryTime / MINUTE).slice(0, 4)).toEqual([2, 6, 10, 14]);
  });

  it("pays exactly what the fee model says, on the notional of each leg", () => {
    const { trades } = run(crossThesis, cycles(25));
    const first = trades[0];
    expect(first?.entryPrice).toBe(101);
    expect(first?.exitPrice).toBe(102.01);
    expect(first?.exitReason).toBe("target");
    expect(first?.barsHeld).toBe(1);
    expect(first?.grossUsd).toBe(10);
    // (1000 entry notional + 1010 exit notional) x 6 bps.
    expect(first?.feesUsd).toBe(1.21); // 1.206 at cents
    expect(first?.netUsd).toBe(8.79); // 10.000 - 1.206
    expect(first?.fundingUsd).toBe(0);
  });

  it("totals to the hand-computed run, and grades it", () => {
    const { report } = run(crossThesis, cycles(25));
    const stats = report.stats;

    expect(stats.wins).toBe(25);
    expect(stats.losses).toBe(0);
    expect(stats.winRatePercent).toBe(100);
    expect(stats.averageWinUsd).toBe(8.79);
    expect(stats.expectancyUsd).toBe(8.79);
    expect(stats.totalGrossUsd).toBe(250); // 25 x $10
    expect(stats.totalNetUsd).toBe(219.75); // 25 x $8.79
    // Every trade won, so the cumulative curve never falls.
    expect(stats.maxDrawdownUsd).toBe(0);
    // One bar held per trade, 100 bars served.
    expect(stats.timeInMarketPercent).toBe(25);
    expect(report.verdict).toBe("positive_after_fees");
  });

  it("compares against holding the asset over the same window", () => {
    const { report } = run(crossThesis, cycles(25));
    // The series ends 1 below where it started, so the hold loses its round
    // trip on top of the drift. The thesis beating it is the whole point of
    // printing them side by side.
    expect(report.stats.buyAndHoldNetUsd).toBeLessThan(0);
    expect(report.stats.totalNetUsd).toBeGreaterThan(report.stats.buyAndHoldNetUsd);
  });
});

// ---------------------------------------------------------------------------
// no lookahead
// ---------------------------------------------------------------------------

describe("runBacktest — no lookahead", () => {
  it("fills at the next bar's open, never at the signal bar's close", () => {
    // The cross closes at 101 and the next bar gaps to 150. A lookahead engine
    // fills at 101 and books the gap as profit; this one pays 150 for it.
    const candles = [
      flat(0, 99),
      flat(1, 101),
      candle(2, 150, 152, 149, 151),
      candle(3, 151, 151, 151, 151),
    ];
    const { trades } = run(
      {
        ...crossThesis,
        exits: { maxHoldBars: 1 },
      },
      candles,
    );
    expect(trades.length).toBe(1);
    expect(trades[0]?.entryPrice).toBe(150);
    expect(trades[0]?.entryTime).toBe(2 * MINUTE);
  });

  it("decides bar t without any bar after t existing at all", () => {
    // The strongest form of the invariant: truncating the series immediately
    // after the fill bar must not change the decision or the fill. If bar t's
    // rule read anything past t, these two runs would differ.
    const candles = cycles(25);
    const full = run(crossThesis, candles);
    const truncated = run(crossThesis, candles.slice(0, 3));

    expect(truncated.trades.length).toBe(1);
    expect(truncated.trades[0]?.entryTime).toBe(full.trades[0]?.entryTime);
    expect(truncated.trades[0]?.entryPrice).toBe(full.trades[0]?.entryPrice);
  });

  it("does not count a signal on the last bar, because nothing could fill it", () => {
    // The rule holds on the final bar. There is no next-bar open, so it is not
    // a setup this window could have traded, and it is not counted as one.
    const candles = [flat(0, 99), flat(1, 101)];
    const { report, trades } = run(crossThesis, candles);
    expect(report.stats.setupsFound).toBe(0);
    expect(trades.length).toBe(0);
  });

  it("prices the stop off the signal bar's ATR, not the fill bar's", () => {
    // The fill bar is enormous. Sizing the stop off it would be reading a bar
    // that had not closed when the stop was placed, so the stop must sit at
    // the pre-gap ATR distance and be taken out inside that same bar.
    const warmup = Array.from({ length: 20 }, (_, i) => candle(i, 99, 99.5, 98.5, 99));
    const candles = [
      ...warmup,
      candle(20, 99, 101.5, 99, 101), // the cross
      candle(21, 101, 101.5, 80, 81), // a bar with a vastly larger range
      flat(22, 81),
    ];
    const { trades } = run(
      {
        ...crossThesis,
        exits: { stop: { basis: "atr", multiple: 1, period: 14 } },
      },
      candles,
    );
    // Wilder ATR(14) sits at 1 through the warm-up (every range is 99.5 -
    // 98.5), and the signal bar's own range of 2.5 lifts it to 15.5 / 14 =
    // 1.107142..., so the stop is 101 - 1.107142... = 99.8929. The fill bar's
    // 21.5-wide range would have moved the ATR to ~2.56 and put the stop near
    // 98.44 — the exit PRICE is what separates the two readings, since a bar
    // that trades down to 80 takes out either of them.
    expect(trades[0]?.entryPrice).toBe(101);
    expect(trades[0]?.exitReason).toBe("stop");
    expect(trades[0]?.exitPrice).toBeCloseTo(99.8929, 4);
  });
});

// ---------------------------------------------------------------------------
// costs
// ---------------------------------------------------------------------------

describe("runBacktest — the costs are the whole story on a zero-edge series", () => {
  // Price never moves, so every trade's gross is exactly zero and the net is
  // exactly the fee model. `above 0` holds on every bar, and a one-bar hold
  // takes a trade every other bar.
  const alwaysIn: TradingThesis = {
    market: "ETH",
    interval: "1m",
    side: "long",
    entry: {
      predicates: [
        {
          left: { source: "price" },
          comparator: "above",
          right: { source: "constant", value: 0 },
        },
      ],
    },
    exits: { maxHoldBars: 1 },
  };
  const flatSeries = Array.from({ length: 61 }, (_, i) => flat(i, 100));

  it("nets negative by exactly the fee model, never by a rounding of it", () => {
    const { report, trades } = run(alwaysIn, flatSeries);
    expect(trades.length).toBe(30);
    for (const trade of trades) {
      expect(trade.grossUsd).toBe(0);
      // (1000 in + 1000 out) x (5 + 1) bps = $1.20.
      expect(trade.feesUsd).toBe(1.2);
      expect(trade.netUsd).toBe(-1.2);
    }
    expect(report.stats.totalGrossUsd).toBe(0);
    expect(report.stats.totalFeesUsd).toBe(36);
    expect(report.stats.totalNetUsd).toBe(-36);
    expect(report.stats.expectancyUsd).toBe(-1.2);
    expect(report.verdict).toBe("negative_after_fees");
    // The verdict sentence is read by a person, so the numbers in it carry
    // their currency and their sign the way a statement would.
    expect(report.verdictReason).toContain("-$1.20 per trade");
    expect(report.verdictReason).toContain("costs took $36.00");
  });

  it("charges the live taker rate when the caller does not override it", () => {
    const { trades } = run(alwaysIn, flatSeries, {
      costs: {
        takerFeeBpsPerSide: BACKTEST_TAKER_FEE_BPS_PER_SIDE,
        slippageBpsPerSide: 0,
        slippageSource: "assumed",
      },
    });
    // 5 bps per side on $1,000 each way, and nothing else.
    expect(BACKTEST_TAKER_FEE_BPS_PER_SIDE).toBe(5);
    expect(trades[0]?.feesUsd).toBe(1);
    expect(trades[0]?.netUsd).toBe(-1);
  });

  it("charges a long the funding it paid over the bars it held", () => {
    // The hold runs from bar 1's open to bar 2's open, half-open: a payment
    // stamped at the entry instant itself belongs to whoever held the position
    // before it, so it is excluded. Two rows land strictly inside, at 0.001
    // each on $1,000 of notional, so the long pays $2.
    const funding = [
      { time: MINUTE, fundingRate: 0.001 }, // exactly at entry — excluded
      { time: MINUTE + 1, fundingRate: 0.001 },
      { time: MINUTE + 2, fundingRate: 0.001 },
      // Well outside the hold, so it must not be counted.
      { time: 50 * MINUTE, fundingRate: 0.5 },
    ];
    const { trades } = run(alwaysIn, flatSeries, { funding });
    expect(trades[0]?.fundingUsd).toBe(-2);
    expect(trades[0]?.netUsd).toBe(-3.2); // -1.20 of fees, -2.00 of funding
  });

  it("pays a short the same funding it charged the long", () => {
    const funding = [
      { time: MINUTE + 1, fundingRate: 0.001 },
      { time: MINUTE + 2, fundingRate: 0.001 },
    ];
    const { trades } = run({ ...alwaysIn, side: "short" }, flatSeries, { funding });
    expect(trades[0]?.fundingUsd).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// the refusal
// ---------------------------------------------------------------------------

describe("runBacktest — the setup floor", () => {
  it("declines a verdict under the floor while still printing the numbers", () => {
    const { report } = run(crossThesis, cycles(MIN_REPLAY_SETUPS - 1));
    expect(report.stats.tradesTaken).toBe(MIN_REPLAY_SETUPS - 1);
    expect(report.verdict).toBe("insufficient_sample");
    expect(report.verdictReason).toContain(String(MIN_REPLAY_SETUPS));
    // The numbers are still there. Withholding them would be its own lie.
    expect(report.stats.expectancyUsd).toBe(8.79);
    expect(report.stats.totalNetUsd).toBeGreaterThan(0);
  });

  it("grades once the sample reaches the floor", () => {
    const { report } = run(crossThesis, cycles(MIN_REPLAY_SETUPS));
    expect(report.stats.tradesTaken).toBe(MIN_REPLAY_SETUPS);
    expect(report.verdict).toBe("positive_after_fees");
  });
});

describe("runBacktest — settlement", () => {
  it("counts a bar holding both levels as the stop, not the target", () => {
    // The fill bar reaches 102.01 and 99.99 both. OHLC cannot say which came
    // first, so it settles as the loss.
    const candles = [flat(0, 99), flat(1, 101), candle(2, 101, 103, 99, 100), flat(3, 100)];
    const { trades } = run(crossThesis, candles);
    expect(trades[0]?.exitReason).toBe("stop");
    expect(trades[0]?.exitPrice).toBe(99.99);
  });

  it("marks a position still open at the end of the window to the last close", () => {
    const candles = [flat(0, 99), flat(1, 101), flat(2, 101), flat(3, 101.5)];
    const { trades } = run({ ...crossThesis, exits: { maxHoldBars: 100 } }, candles);
    expect(trades[0]?.exitReason).toBe("window_end");
    expect(trades[0]?.exitPrice).toBe(101.5);
  });

  it("leaves on the opposite condition, at the open after it holds", () => {
    const candles = [
      flat(0, 99),
      flat(1, 101),
      flat(2, 101),
      flat(3, 98),
      candle(4, 97, 97, 97, 97),
    ];
    const { trades } = run(
      {
        ...crossThesis,
        exits: {
          opposite: {
            predicates: [
              {
                left: { source: "price" },
                comparator: "below",
                right: { source: "constant", value: 100 },
              },
            ],
          },
        },
      },
      candles,
    );
    // Price closes below 100 on bar 3, so the exit fills at bar 4's open.
    expect(trades[0]?.exitReason).toBe("exit_condition");
    expect(trades[0]?.exitPrice).toBe(97);
  });
});

describe("checkBacktestBarBudget", () => {
  it("lets a month of one-minute bars through", () => {
    expect(checkBacktestBarBudget({ interval: "1m", bars: 43_200, coarser: ["5m"] })).toBeNull();
    expect(BACKTEST_MAX_BARS).toBeGreaterThan(43_200);
  });

  it("refuses a year of one-minute bars, and names the interval that would work", () => {
    const refusal = checkBacktestBarBudget({
      interval: "1m",
      bars: 525_600,
      coarser: ["15m", "1h"],
    });
    expect(refusal).toContain("525,600");
    expect(refusal).toContain("15m");
    // The refusal has to be actionable, not just a wall.
    expect(refusal).toContain("shorten the window");
    // No em dash reaches a person reading a refusal.
    expect(refusal).not.toContain("—");
  });
});
