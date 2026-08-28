/**
 * Running a thesis over bars that already happened.
 *
 * This is research. Nothing here places an order, sizes a live position, or
 * touches an execution path — it reads archived candles and returns arithmetic.
 * The whole point is that a user can ask "does this idea actually pay?" and get
 * an answer that is allowed to be no.
 *
 * ## The invariant everything else rests on: no lookahead
 *
 * A rule is evaluated ONLY on closed bars, and a fill happens only on bars
 * strictly after the one that produced the signal.
 *
 *   - The entry condition for bar `t` reads bar `t`'s own close and every bar
 *     before it. It never reads bar `t + 1`.
 *   - A signal on bar `t` fills at bar `t + 1`'s OPEN. Not at `t`'s close,
 *     which is a price nobody could have traded at once the bar was known to
 *     be closed.
 *   - The stop and target distances are measured from readings at bar `t`, the
 *     signal bar, never at the fill bar — at the moment of the fill that bar
 *     has not closed and its ATR does not exist yet.
 *   - The same for the exit side: a close-based exit signalled on bar `u`
 *     fills at bar `u + 1`'s open.
 *
 * Level exits are the one intrabar event, because a stop and a target are
 * resting orders and a bar's high and low really were traded. When one bar
 * contains both, the STOP wins — see `settleOnBars`, shared with the fixture
 * replay so the two never grow separate answers to that question.
 *
 * ## Costs are not optional
 *
 * Every trade pays the taker fee both sides plus a crossing allowance, and
 * every held bar pays (or receives) the archived funding for its hours. A
 * backtest that reports gross is a backtest that lies, and this fork has
 * already killed one strategy — `ema_cross` — on exactly the gap between gross
 * and net.
 *
 * ## And it is allowed to refuse
 *
 * Below {@link MIN_REPLAY_SETUPS} settled trades the verdict is
 * `insufficient_sample`. The numbers are still shown, because hiding them
 * would be its own kind of dishonesty, but nothing calls them evidence.
 *
 * @module TradingBacktest
 */
import * as Schema from "effect/Schema";

import { pocRiskPolicyDefaults } from "./authority.ts";
import {
  computeIndicatorSeries,
  DEFAULT_INDICATOR_PERIODS,
  INDICATOR_COMPONENTS,
  INDICATOR_KINDS,
  type IndicatorComponent,
  type IndicatorPoint,
  type IndicatorRequest,
} from "./indicators.ts";
import type { MarketCandle } from "./market.ts";
import { MIN_REPLAY_SETUPS, settleOnBars } from "./replay.ts";
import {
  BacktestInterval,
  THESIS_MAX_HOLD_BARS,
  THESIS_MAX_PREDICATES,
  thesisIndicators,
  TradingThesis,
  type ThesisCondition,
  type ThesisDistance,
  type ThesisOperand,
  type ThesisPredicate,
} from "./thesis.ts";

/**
 * The most bars one run walks.
 *
 * A month of 1m bars is 43,200 and has to work — that is the shortest window
 * anybody can ask a 1m idea about and learn anything. A year of 1m bars is
 * 525,600 and is refused, not because the arithmetic could not finish but
 * because a year of one-minute bars is almost never the question somebody
 * means: the same year on 15m bars is 35,040, inside the cap, and answers it.
 * The refusal says so rather than just failing.
 */
export const BACKTEST_MAX_BARS = 60_000;

/**
 * The notional every trade is taken at, unless the caller names another.
 *
 * Fixed rather than compounding, and deliberately: expectancy per trade is the
 * number a thesis lives or dies on, and a compounding size turns it into a
 * statement about the order the trades happened to arrive in.
 */
export const DEFAULT_BACKTEST_NOTIONAL_USD = 1_000;

/**
 * The taker fee a backtest charges, per side — the same rate the live sizer
 * falls back to, so a thesis is costed at what the account actually pays.
 */
export const BACKTEST_TAKER_FEE_BPS_PER_SIDE = pocRiskPolicyDefaults.fallbackTakerFeeBpsPerSide;

/**
 * The crossing cost assumed per side when the archive holds no book to measure
 * one from.
 *
 * Deliberately NOT the 50 bps IOC slippage allowance the executor prices with.
 * That number is the limit-price cushion — how far past the touch the order is
 * allowed to fill so it does not rest — and it bounds the fill rather than
 * describing it. Charging it as realised cost would put 100 bps of round-trip
 * friction on every backtested trade and report a loss on ideas that make
 * money, which is a dishonest engine pointed the other way. One basis point is
 * roughly the half-spread on the majors this archive records, and the served
 * report always says whether the number was measured or assumed.
 */
export const BACKTEST_FALLBACK_SLIPPAGE_BPS_PER_SIDE = 1;

/** Where the crossing cost in a run came from. */
export const BacktestSlippageSource = Schema.Literals(["archived_book", "assumed"]);
export type BacktestSlippageSource = typeof BacktestSlippageSource.Type;

export const BacktestCosts = Schema.Struct({
  takerFeeBpsPerSide: Schema.Number,
  slippageBpsPerSide: Schema.Number,
  slippageSource: BacktestSlippageSource,
});
export type BacktestCosts = typeof BacktestCosts.Type;

/** What the archive could and could not serve for the window asked about. */
export const BacktestCoverage = Schema.Struct({
  requestedFromT: Schema.Number,
  requestedToT: Schema.Number,
  /** Open time of the first bar actually served, null when none were. */
  servedFromT: Schema.NullOr(Schema.Number),
  /** Open time of the last bar actually served. */
  servedToT: Schema.NullOr(Schema.Number),
  barsServed: Schema.Number,
  /** Stretches `known_gaps` says the archive is missing, clipped to the window. */
  gaps: Schema.Array(Schema.Struct({ fromT: Schema.Number, toT: Schema.Number })),
  /** When the archive started recording this series at all. */
  recordingSince: Schema.NullOr(Schema.Number),
  /** True when the archive holds funding rows covering the window. */
  fundingServed: Schema.Boolean,
});
export type BacktestCoverage = typeof BacktestCoverage.Type;

export type BacktestExitReason = "stop" | "target" | "exit_condition" | "max_hold" | "window_end";

export interface BacktestTrade {
  readonly entryTime: number;
  readonly entryPrice: number;
  readonly exitTime: number;
  readonly exitPrice: number;
  readonly exitReason: BacktestExitReason;
  readonly barsHeld: number;
  readonly grossUsd: number;
  readonly feesUsd: number;
  /** Positive when funding paid the position, negative when it charged it. */
  readonly fundingUsd: number;
  readonly netUsd: number;
  readonly adverseExcursionUsd: number;
}

export const BacktestStats = Schema.Struct({
  /** Bars where the entry rule held and a next-bar fill existed. */
  setupsFound: Schema.Number,
  /** Setups actually entered — the rest overlapped an open position. */
  tradesTaken: Schema.Number,
  /**
   * Setups skipped because a reading the exits needed was not defined yet —
   * an ATR stop inside the indicator's own warm-up, usually.
   */
  setupsUnpriced: Schema.Number,
  wins: Schema.Number,
  losses: Schema.Number,
  breakEven: Schema.Number,
  winRatePercent: Schema.Number,
  averageWinUsd: Schema.Number,
  /** Reported negative, the way the loss reads on a statement. */
  averageLossUsd: Schema.Number,
  /** Net per trade after every fee and funding payment. The headline. */
  expectancyUsd: Schema.Number,
  totalGrossUsd: Schema.Number,
  totalFeesUsd: Schema.Number,
  totalFundingUsd: Schema.Number,
  totalNetUsd: Schema.Number,
  /** Deepest peak-to-trough fall of the cumulative net curve, in USD. */
  maxDrawdownUsd: Schema.Number,
  /** Share of the served bars spent holding a position. */
  timeInMarketPercent: Schema.Number,
  /** Holding the asset from the first open to the last close, same notional. */
  buyAndHoldNetUsd: Schema.Number,
  buyAndHoldReturnPercent: Schema.Number,
});
export type BacktestStats = typeof BacktestStats.Type;

/**
 * `insufficient_sample` is not a hedge. It is the engine declining to grade a
 * thesis on a sample too small to grade one on, while still printing what it
 * measured.
 */
export const BacktestVerdict = Schema.Literals([
  "positive_after_fees",
  "negative_after_fees",
  "insufficient_sample",
]);
export type BacktestVerdict = typeof BacktestVerdict.Type;

export const BacktestReport = Schema.Struct({
  thesis: TradingThesis,
  notionalUsd: Schema.Number,
  costs: BacktestCosts,
  coverage: BacktestCoverage,
  stats: BacktestStats,
  verdict: BacktestVerdict,
  /** Why the verdict is what it is, in one line of prose. */
  verdictReason: Schema.String,
});
export type BacktestReport = typeof BacktestReport.Type;

/** The report plus the trades behind it. Tests read the trades; the wire does not. */
export interface BacktestRun {
  readonly report: BacktestReport;
  readonly trades: ReadonlyArray<BacktestTrade>;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;
const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;

const requestKey = (request: IndicatorRequest): string =>
  `${request.kind}:${request.period ?? "default"}`;

const componentOf = (
  point: IndicatorPoint | undefined,
  component: IndicatorComponent | undefined,
): number | undefined => {
  if (point === undefined) return undefined;
  switch (component ?? "value") {
    case "value":
      return point.value;
    case "signal":
      return point.signal;
    case "histogram":
      return point.histogram;
    case "upper":
      return point.upper;
    case "lower":
      return point.lower;
  }
};

/**
 * Evaluate a thesis over one contiguous run of bars.
 *
 * `candles` is oldest first and is whatever the archive served — the caller
 * has already clipped it to the window and to {@link BACKTEST_MAX_BARS}, and
 * reports in `coverage` what it could not serve. `funding` is the archive's
 * hourly rows, oldest first; an empty series means funding is not accounted
 * for, which `coverage.fundingServed` states rather than hiding behind a zero.
 */
export function runBacktest(input: {
  readonly thesis: TradingThesis;
  readonly candles: ReadonlyArray<MarketCandle>;
  readonly funding?: ReadonlyArray<{ readonly time: number; readonly fundingRate: number }>;
  readonly costs: BacktestCosts;
  readonly coverage: BacktestCoverage;
  readonly notionalUsd?: number;
}): BacktestRun {
  const { thesis, candles, coverage, costs } = input;
  const notionalUsd = input.notionalUsd ?? DEFAULT_BACKTEST_NOTIONAL_USD;
  const funding = input.funding ?? [];
  const long = thesis.side === "long";
  const bars = candles.length;

  // -- indicator series, computed once over the whole run ---------------------
  const series = new Map<string, ReadonlyArray<IndicatorPoint | undefined>>();
  for (const request of thesisIndicators(thesis)) {
    series.set(requestKey(request), computeIndicatorSeries(request, candles));
  }
  const seriesFor = (request: IndicatorRequest): ReadonlyArray<IndicatorPoint | undefined> => {
    const existing = series.get(requestKey(request));
    if (existing !== undefined) return existing;
    const computed = computeIndicatorSeries(request, candles);
    series.set(requestKey(request), computed);
    return computed;
  };

  const operandValue = (operand: ThesisOperand, index: number): number | undefined => {
    switch (operand.source) {
      case "constant":
        return operand.value;
      case "price": {
        const bar = candles[index];
        if (bar === undefined) return undefined;
        switch (operand.field ?? "close") {
          case "open":
            return bar.open;
          case "high":
            return bar.high;
          case "low":
            return bar.low;
          case "close":
            return bar.close;
        }
        return bar.close;
      }
      case "indicator": {
        const points = seriesFor({
          kind: operand.indicator,
          ...(operand.period === undefined ? {} : { period: operand.period }),
        });
        return componentOf(points[index], operand.component);
      }
    }
  };

  /**
   * The relation underneath a comparator, at one bar. `above` and
   * `crosses_above` both rest on `left > right`; `below` and `crosses_below`
   * on `left < right`. Strict both ways, so an exact tie satisfies neither and
   * a series that sits flat against a level does not read as a signal.
   */
  const relationAt = (predicate: ThesisPredicate, index: number): boolean | undefined => {
    const left = operandValue(predicate.left, index);
    const right = operandValue(predicate.right, index);
    if (left === undefined || right === undefined) return undefined;
    return predicate.comparator === "above" || predicate.comparator === "crosses_above"
      ? left > right
      : left < right;
  };

  const predicateHolds = (predicate: ThesisPredicate, index: number): boolean => {
    const now = relationAt(predicate, index);
    if (now !== true) return false;
    if (predicate.comparator === "above" || predicate.comparator === "below") return true;
    // A cross is the relation holding here and not one bar ago. An undefined
    // previous bar is not a cross: a reading that did not exist cannot have
    // been on the other side of anything.
    if (index === 0) return false;
    const before = relationAt(predicate, index - 1);
    return before === false;
  };

  const conditionHolds = (condition: ThesisCondition, index: number): boolean =>
    condition.match === "any"
      ? condition.predicates.some((predicate) => predicateHolds(predicate, index))
      : condition.predicates.every((predicate) => predicateHolds(predicate, index));

  /**
   * A distance in price, measured from readings at the SIGNAL bar. Never at
   * the fill bar: at the moment of the fill that bar has not closed.
   */
  const distanceInPrice = (
    distance: ThesisDistance | undefined,
    signalIndex: number,
    entryPrice: number,
    stopDistance: number | undefined,
  ): number | undefined => {
    if (distance === undefined) return undefined;
    switch (distance.basis) {
      case "percent":
        return (entryPrice * distance.value) / 100;
      case "atr": {
        const points = seriesFor({
          kind: "atr",
          period: distance.period ?? DEFAULT_INDICATOR_PERIODS.atr,
        });
        const atr = points[signalIndex]?.value;
        return atr === undefined ? undefined : atr * distance.multiple;
      }
      case "r":
        return stopDistance === undefined ? undefined : stopDistance * distance.multiple;
    }
  };

  // -- funding, as a prefix sum so a hold costs one subtraction ---------------
  const fundingTimes = funding.map((row) => row.time);
  const fundingPrefix: Array<number> = new Array(funding.length + 1).fill(0);
  for (let i = 0; i < funding.length; i += 1) {
    fundingPrefix[i + 1] = (fundingPrefix[i] as number) + (funding[i]?.fundingRate ?? 0);
  }
  /** Index of the first funding row at or after `time`. */
  const fundingLowerBound = (time: number): number => {
    let lo = 0;
    let hi = fundingTimes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((fundingTimes[mid] as number) < time) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  /**
   * What funding did to a position held across `(from, to]`, in USD.
   *
   * Half-open on purpose: a payment stamped at the exact instant of the entry
   * belongs to whoever held the position through the hour before it, and one
   * stamped at the exit is the last one this position was open for.
   *
   * Positive means funding paid the position. A long pays a positive rate, so
   * the sign flips on the side. The rate is the archive's hourly rate and the
   * rows are hourly, so summing them is the payment, not an approximation of
   * one.
   */
  const fundingUsdOver = (from: number, to: number): number => {
    if (funding.length === 0) return 0;
    const start = fundingLowerBound(from + 1);
    const end = fundingLowerBound(to + 1);
    const rate = (fundingPrefix[end] as number) - (fundingPrefix[start] as number);
    return (long ? -1 : 1) * rate * notionalUsd;
  };

  // -- pass one: where the rules fire ----------------------------------------
  //
  // Every bar is classified before a single trade is taken, so "the entry rule
  // held here" is a fact about the series rather than a function of whether a
  // position happened to be open. `setupsFound` counts them all; the trades
  // below take the ones that were not already inside one.
  const entrySignal: Array<boolean> = new Array(bars).fill(false);
  const exitSignal: Array<boolean> = new Array(bars).fill(false);
  for (let index = 0; index < bars; index += 1) {
    entrySignal[index] = conditionHolds(thesis.entry, index);
    if (thesis.exits.opposite !== undefined) {
      exitSignal[index] = conditionHolds(thesis.exits.opposite, index);
    }
  }
  // A signal on the last bar has no next bar to fill at, so it is not a setup
  // this window could have traded.
  let setupsFound = 0;
  for (let index = 0; index <= bars - 2; index += 1) {
    if (entrySignal[index] === true) setupsFound += 1;
  }

  // -- pass two: take the trades ---------------------------------------------
  const trades: Array<BacktestTrade> = [];
  let setupsUnpriced = 0;
  const maxHoldBars = thesis.exits.maxHoldBars;

  for (let signalIndex = 0; signalIndex <= bars - 2; signalIndex += 1) {
    if (entrySignal[signalIndex] !== true) continue;

    const entryIndex = signalIndex + 1;
    const entryBar = candles[entryIndex] as MarketCandle;
    const entryPrice = entryBar.open;
    if (!(entryPrice > 0)) continue;

    const stopDistance = distanceInPrice(thesis.exits.stop, signalIndex, entryPrice, undefined);
    if (thesis.exits.stop !== undefined && stopDistance === undefined) {
      setupsUnpriced += 1;
      continue;
    }
    const targetDistance = distanceInPrice(
      thesis.exits.target,
      signalIndex,
      entryPrice,
      stopDistance,
    );
    if (thesis.exits.target !== undefined && targetDistance === undefined) {
      setupsUnpriced += 1;
      continue;
    }

    const stopPrice =
      stopDistance === undefined
        ? undefined
        : long
          ? entryPrice - stopDistance
          : entryPrice + stopDistance;
    const targetPrice =
      targetDistance === undefined
        ? undefined
        : long
          ? entryPrice + targetDistance
          : entryPrice - targetDistance;

    // The bar whose OPEN a close-based exit would fill at: the bar after the
    // first exit signal, or the bar the hold limit lands on, whichever is
    // first. Both are capped at the last bar there is.
    let closeExitIndex: number | undefined;
    let closeExitReason: BacktestExitReason | undefined;
    if (thesis.exits.opposite !== undefined) {
      for (let u = entryIndex; u <= bars - 2; u += 1) {
        if (exitSignal[u] === true) {
          closeExitIndex = u + 1;
          closeExitReason = "exit_condition";
          break;
        }
      }
    }
    if (maxHoldBars !== undefined) {
      const limit = entryIndex + maxHoldBars;
      if (limit <= bars - 1 && (closeExitIndex === undefined || limit < closeExitIndex)) {
        closeExitIndex = limit;
        closeExitReason = "max_hold";
      }
    }

    // Level exits are checked over the bars fully held. The bar a close-based
    // exit fills on is NOT one of them — the position left at its open.
    const walkEnd = closeExitIndex === undefined ? bars - 1 : closeExitIndex - 1;
    const size = notionalUsd / entryPrice;
    const settlement = settleOnBars({
      long,
      entryPrice,
      ...(stopPrice === undefined ? {} : { stopPrice }),
      ...(targetPrice === undefined ? {} : { targetPrice }),
      size,
      bars: candles.slice(entryIndex, walkEnd + 1),
    });

    let exitIndex: number;
    let exitPrice: number;
    let exitTime: number;
    let exitReason: BacktestExitReason;
    let barsHeld: number;
    if (settlement.outcome !== "open") {
      exitIndex = entryIndex + settlement.barsHeld - 1;
      exitPrice = settlement.exitPrice;
      // The level was touched somewhere inside the bar and OHLC cannot say
      // where, so the bar's close time is the honest stamp for the funding it
      // has to pay.
      exitTime = (candles[exitIndex] as MarketCandle).closeTime;
      exitReason = settlement.outcome;
      barsHeld = settlement.barsHeld;
    } else if (closeExitIndex !== undefined) {
      exitIndex = closeExitIndex;
      exitPrice = (candles[exitIndex] as MarketCandle).open;
      exitTime = (candles[exitIndex] as MarketCandle).openTime;
      exitReason = closeExitReason as BacktestExitReason;
      barsHeld = exitIndex - entryIndex;
    } else {
      exitIndex = bars - 1;
      exitPrice = (candles[exitIndex] as MarketCandle).close;
      exitTime = (candles[exitIndex] as MarketCandle).closeTime;
      exitReason = "window_end";
      barsHeld = exitIndex - entryIndex + 1;
    }

    const grossUsd = (long ? exitPrice - entryPrice : entryPrice - exitPrice) * size;
    const costBps = costs.takerFeeBpsPerSide + costs.slippageBpsPerSide;
    // Each leg pays on its own notional, which is what the exchange charges.
    const feesUsd = (notionalUsd + size * exitPrice) * (costBps / 10_000);
    const fundingUsd = fundingUsdOver(entryBar.openTime, exitTime);

    trades.push({
      entryTime: entryBar.openTime,
      entryPrice: round4(entryPrice),
      exitTime,
      exitPrice: round4(exitPrice),
      exitReason,
      barsHeld,
      grossUsd: round2(grossUsd),
      feesUsd: round2(feesUsd),
      fundingUsd: round2(fundingUsd),
      netUsd: round2(grossUsd - feesUsd + fundingUsd),
      adverseExcursionUsd: round2(settlement.adverseExcursionUsd),
    });

    // Resume from the exit bar: a signal on it can fill at the bar after.
    signalIndex = Math.max(signalIndex, exitIndex - 1);
  }

  // -- totals ----------------------------------------------------------------
  const wins = trades.filter((trade) => trade.netUsd > 0);
  const losses = trades.filter((trade) => trade.netUsd < 0);
  const totalGrossUsd = trades.reduce((sum, trade) => sum + trade.grossUsd, 0);
  const totalFeesUsd = trades.reduce((sum, trade) => sum + trade.feesUsd, 0);
  const totalFundingUsd = trades.reduce((sum, trade) => sum + trade.fundingUsd, 0);
  const totalNetUsd = trades.reduce((sum, trade) => sum + trade.netUsd, 0);

  let peak = 0;
  let cumulative = 0;
  let maxDrawdownUsd = 0;
  for (const trade of trades) {
    cumulative += trade.netUsd;
    peak = Math.max(peak, cumulative);
    maxDrawdownUsd = Math.max(maxDrawdownUsd, peak - cumulative);
  }

  const barsHeldTotal = trades.reduce((sum, trade) => sum + trade.barsHeld, 0);

  // Buy and hold: the asset, from the first open to the last close, at the same
  // notional and one round trip of the same costs. No funding — the comparison
  // is the unlevered hold, which pays none.
  const first = candles[0];
  const last = candles[bars - 1];
  let buyAndHoldNetUsd = 0;
  let buyAndHoldReturnPercent = 0;
  if (first !== undefined && last !== undefined && first.open > 0) {
    const holdSize = notionalUsd / first.open;
    const holdGross = (last.close - first.open) * holdSize;
    const holdFees =
      (notionalUsd + holdSize * last.close) *
      ((costs.takerFeeBpsPerSide + costs.slippageBpsPerSide) / 10_000);
    buyAndHoldNetUsd = holdGross - holdFees;
    buyAndHoldReturnPercent = (buyAndHoldNetUsd / notionalUsd) * 100;
  }

  const expectancyUsd = trades.length === 0 ? 0 : totalNetUsd / trades.length;
  const stats: BacktestStats = {
    setupsFound,
    tradesTaken: trades.length,
    setupsUnpriced,
    wins: wins.length,
    losses: losses.length,
    breakEven: trades.length - wins.length - losses.length,
    winRatePercent: trades.length === 0 ? 0 : round2((wins.length / trades.length) * 100),
    averageWinUsd:
      wins.length === 0 ? 0 : round2(wins.reduce((sum, t) => sum + t.netUsd, 0) / wins.length),
    averageLossUsd:
      losses.length === 0
        ? 0
        : round2(losses.reduce((sum, t) => sum + t.netUsd, 0) / losses.length),
    expectancyUsd: round2(expectancyUsd),
    totalGrossUsd: round2(totalGrossUsd),
    totalFeesUsd: round2(totalFeesUsd),
    totalFundingUsd: round2(totalFundingUsd),
    totalNetUsd: round2(totalNetUsd),
    maxDrawdownUsd: round2(maxDrawdownUsd),
    timeInMarketPercent: bars === 0 ? 0 : round2((barsHeldTotal / bars) * 100),
    buyAndHoldNetUsd: round2(buyAndHoldNetUsd),
    buyAndHoldReturnPercent: round2(buyAndHoldReturnPercent),
  };

  const { verdict, verdictReason } = judgeBacktest(stats);

  return {
    report: { thesis, notionalUsd, costs, coverage, stats, verdict, verdictReason },
    trades,
  };
}

/**
 * The verdict, and the sentence that justifies it.
 *
 * The sample gate comes first and is not negotiable: nineteen trades that made
 * money is an anecdote, and calling it an edge is how a fork talks itself into
 * a strategy. `MIN_REPLAY_SETUPS` is the same floor the policy comparison uses,
 * for the same reason.
 */
export function judgeBacktest(stats: BacktestStats): {
  readonly verdict: BacktestVerdict;
  readonly verdictReason: string;
} {
  // The sentence is read by a person. A bare `-1.51` next to the word "trade"
  // reads as a count of something; the sign belongs outside the currency.
  const usd = (value: number): string => `${value < 0 ? "-" : ""}$${Math.abs(value).toFixed(2)}`;
  if (stats.tradesTaken < MIN_REPLAY_SETUPS) {
    return {
      verdict: "insufficient_sample",
      verdictReason:
        `${stats.tradesTaken} trades over this window, under the ${MIN_REPLAY_SETUPS} ` +
        "a verdict needs. The numbers below are what happened, not evidence of an edge. " +
        "Widen the window or loosen the entry rule and run it again.",
    };
  }
  if (stats.expectancyUsd > 0) {
    return {
      verdict: "positive_after_fees",
      verdictReason:
        `${usd(stats.expectancyUsd)} per trade after fees and funding across ${stats.tradesTaken} trades. ` +
        "A backtest is not a soak: confirm on testnet before this trades live.",
    };
  }
  return {
    verdict: "negative_after_fees",
    verdictReason:
      `${usd(stats.expectancyUsd)} per trade after fees and funding across ${stats.tradesTaken} trades. ` +
      `Gross was ${usd(stats.totalGrossUsd)} and costs took ${usd(stats.totalFeesUsd)}, so this idea does not pay as written.`,
  };
}

/**
 * Whether a window can be walked, and what to say when it cannot.
 *
 * The suggestion is the point. "Too many bars" tells the user nothing they can
 * act on; "that is 525,600 one-minute bars, try 15m for the same window" is the
 * next call they should make.
 */
export function checkBacktestBarBudget(input: {
  readonly interval: string;
  readonly bars: number;
  readonly coarser: ReadonlyArray<string>;
}): string | null {
  if (input.bars <= BACKTEST_MAX_BARS) return null;
  const suggestion =
    input.coarser.length === 0
      ? "shorten the window"
      : `run it on ${input.coarser.join(" or ")} bars over the same window, or shorten the window`;
  return (
    `that window is ${input.bars.toLocaleString("en-US")} ${input.interval} bars and the cap is ` +
    `${BACKTEST_MAX_BARS.toLocaleString("en-US")}, so ${suggestion}`
  );
}

// ---------------------------------------------------------------------------
// the tool surface
// ---------------------------------------------------------------------------

export const TRADING_BACKTEST_TOOL = "trading_backtest";

/**
 * The window a run covers, and the notional it prices at.
 *
 * `thesis` is optional for one reason: a call without it returns the menu.
 * That is the plan 38 disclosure pattern `trading_look({})` already
 * establishes — the tool description stays a few hundred characters and the
 * vocabulary is served on demand, to the one call that asked for it, instead
 * of riding in every turn's system prompt.
 */
export const TradingBacktestInput = Schema.Struct({
  /**
   * The mission this research is for, when there is one. A backtest reads the
   * archive and touches no mission state, so it is optional — but a call made
   * inside a mission names it, so the run is attributable.
   */
  missionId: Schema.optional(Schema.String),
  thesis: Schema.optional(TradingThesis),
  /** How far back to test. Defaults to everything the archive holds. */
  lookbackDays: Schema.optional(Schema.Number),
  /** The notional each trade is priced at. Fixed, never compounded. */
  notionalUsd: Schema.optional(Schema.Number),
});
export type TradingBacktestInput = typeof TradingBacktestInput.Type;

export const TradingBacktestResult = Schema.Struct({
  report: Schema.optional(BacktestReport),
  /** How long the archive read and the walk took together. */
  elapsedMillis: Schema.optional(Schema.Number),
  /** The vocabulary, when this call was the menu call. */
  menu: Schema.optional(Schema.String),
});
export type TradingBacktestResult = typeof TradingBacktestResult.Type;

/**
 * Everything a thesis can say, rendered from the constants that enforce it.
 *
 * Rendered rather than written out so the menu cannot drift from the schema:
 * an indicator kind added to the library, or a cap moved, changes this line
 * without anybody remembering to.
 */
export function renderTradingBacktestMenu(): string {
  const components = (["macd", "bollinger"] as const)
    .map((kind) => `${kind}=${INDICATOR_COMPONENTS[kind].join("|")}`)
    .join(" ");
  return [
    `thesis={market, interval, side, entry, exits}; interval=${BacktestInterval.literals.join("|")}; side=long|short`,
    `entry and exits.opposite = {match: all|any, predicates: [{left, comparator, right}]}, at most ${THESIS_MAX_PREDICATES}, one level deep, no nesting`,
    "operand = {source:price, field:open|high|low|close} | {source:indicator, indicator, period?, component?} | {source:constant, value}",
    `indicator = ${INDICATOR_KINDS.join(" ")}; component ${components}, every other kind reports value only`,
    "comparator = crosses_above crosses_below above below; a cross means the relation holds on this closed bar and did not on the one before",
    "exits, at least one = stop/target {basis:percent, value} | {basis:atr, multiple, period?}; target also {basis:r, multiple}, which needs a stop; " +
      `maxHoldBars up to ${THESIS_MAX_HOLD_BARS}; opposite = a condition`,
    `lookbackDays defaults to everything archived; ${BACKTEST_MAX_BARS.toLocaleString("en-US")} bars a run, so ask a long 1m window on a coarser interval`,
    `signals read closed bars and fill at the next bar open; every trade pays ${BACKTEST_TAKER_FEE_BPS_PER_SIDE} bps taker a side plus crossing plus archived funding`,
    `under ${MIN_REPLAY_SETUPS} trades there is no verdict, only the numbers; this is research and never places an order`,
  ].join(" · ");
}
