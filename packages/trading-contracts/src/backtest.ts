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
  THESIS_MAX_WITHIN_BARS,
  THESIS_VOLUME_RATIO_BARS,
  ThesisMetricName,
  thesisIndicators,
  TradingThesis,
  type ThesisCondition,
  validateThesis,
  type ThesisDistance,
  type ThesisOperand,
  type ThesisPredicate,
  type ThesisSequence,
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

/**
 * How many funding rows are stamped at or before `time`, by binary search over
 * their times.
 *
 * The one number both funding readers want. The rate in force at an instant is
 * the row before this index, and what a hold paid is the rows between two of
 * them, so writing the search once keeps the stepwise lookup and the half-open
 * window from drifting apart.
 */
const fundingRowsThrough = (times: ReadonlyArray<number>, time: number): number => {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((times[mid] as number) <= time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

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
 * Every figure a run reports, from the trades it took.
 *
 * Split out of {@link runBacktest} for the same reason the signals were: a
 * forward validation is scored against the backtest that armed it, and two
 * expectancies computed by two pieces of arithmetic are not a comparison. Both
 * paths reduce their trades here.
 *
 * `bars` is the run's own bar count, which `timeInMarketPercent` is a share
 * of. Buy-and-hold is passed in rather than computed: it needs the price
 * series, and a forward run's series is read separately from its trades.
 */
export function summarizeTrades(input: {
  readonly trades: ReadonlyArray<BacktestTrade>;
  readonly setupsFound: number;
  readonly setupsUnpriced: number;
  readonly bars: number;
  readonly buyAndHoldNetUsd: number;
  readonly buyAndHoldReturnPercent: number;
}): BacktestStats {
  const { trades, bars } = input;
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
  const expectancyUsd = trades.length === 0 ? 0 : totalNetUsd / trades.length;

  return {
    setupsFound: input.setupsFound,
    tradesTaken: trades.length,
    setupsUnpriced: input.setupsUnpriced,
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
    buyAndHoldNetUsd: round2(input.buyAndHoldNetUsd),
    buyAndHoldReturnPercent: round2(input.buyAndHoldReturnPercent),
  };
}

/**
 * The rule half of the engine: what a thesis says about one run of bars.
 *
 * Split out of {@link runBacktest} so forward validation cannot drift from it.
 * A forward run evaluates the same thesis on a trailing window of the same
 * archive, one closed bar at a time, and the whole comparison it is for — did
 * the idea keep working — is worthless if "the entry fired" means something
 * different on the two paths. There is one definition, and both call it.
 *
 * `candles` is oldest first. Every returned function indexes into it.
 */
export function makeThesisSignals(input: {
  readonly thesis: TradingThesis;
  readonly candles: ReadonlyArray<MarketCandle>;
  /**
   * The archive's hourly funding rows for this market, oldest first. Only a
   * `funding_rate_8h` operand reads them; every other thesis ignores the
   * argument entirely, and omitting it leaves that operand undefined rather
   * than guessing a rate.
   */
  readonly funding?: ReadonlyArray<{ readonly time: number; readonly fundingRate: number }>;
}): {
  /** Whether a condition holds on the closed bar at `index`. */
  readonly conditionHolds: (condition: ThesisCondition, index: number) => boolean;
  /**
   * Whether the ENTRY fires on the closed bar at `index` - the entry condition
   * plus the `after` clause when the thesis carries one. This, not
   * `conditionHolds(thesis.entry, ...)`, is what both engines ask.
   */
  readonly entryFires: (index: number) => boolean;
  /**
   * A stop or target distance in price, measured from readings at the SIGNAL
   * bar. `undefined` means a reading the distance needs is not defined there
   * yet, which is a setup that cannot be priced rather than one that lost.
   */
  readonly distanceInPrice: (
    distance: ThesisDistance | undefined,
    signalIndex: number,
    entryPrice: number,
    stopDistance: number | undefined,
  ) => number | undefined;
} {
  const { thesis, candles } = input;
  const funding = input.funding ?? [];

  // -- funding, as a stepwise lookup ------------------------------------------
  //
  // The rate in force at an instant is the one from the most recent row at or
  // before it. The rows are hourly and the bars are usually shorter, so many
  // bars share a rate; that is the point, and interpolating between rows would
  // invent a number the exchange never quoted. Rows before the first one are
  // undefined rather than zero: "no rate was recorded yet" and "the rate was
  // zero" are different facts and only one of them should fire a rule.
  const fundingTimesForRead = funding.map((row) => row.time);
  const fundingRateAt = (time: number): number | undefined => {
    const through = fundingRowsThrough(fundingTimesForRead, time);
    return through === 0 ? undefined : funding[through - 1]?.fundingRate;
  };

  // -- volume pace, as a rolling prefix sum -----------------------------------
  //
  // Built once so `volume_ratio` costs a subtraction per read rather than a
  // twenty-bar loop, which matters when a sweep walks the same window twelve
  // times.
  let volumePrefix: Array<number> | null = null;
  const volumePrefixSums = (): Array<number> => {
    if (volumePrefix !== null) return volumePrefix;
    const sums: Array<number> = new Array(candles.length + 1).fill(0);
    for (let i = 0; i < candles.length; i += 1) {
      sums[i + 1] = (sums[i] as number) + (candles[i]?.volume ?? 0);
    }
    volumePrefix = sums;
    return sums;
  };
  /**
   * The bar's volume against the mean of the {@link THESIS_VOLUME_RATIO_BARS}
   * bars BEFORE it. Undefined until that many priors exist, and undefined when
   * they sum to zero - a ratio against no trading is not a large number, it is
   * not a number.
   */
  const volumeRatioAt = (index: number): number | undefined => {
    if (index < THESIS_VOLUME_RATIO_BARS) return undefined;
    const bar = candles[index];
    if (bar === undefined) return undefined;
    const sums = volumePrefixSums();
    const priorSum = (sums[index] as number) - (sums[index - THESIS_VOLUME_RATIO_BARS] as number);
    if (!(priorSum > 0)) return undefined;
    return bar.volume / (priorSum / THESIS_VOLUME_RATIO_BARS);
  };

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
      }
      case "indicator": {
        const points = seriesFor({
          kind: operand.indicator,
          ...(operand.period === undefined ? {} : { period: operand.period }),
        });
        return componentOf(points[index], operand.component);
      }
      case "metric": {
        const bar = candles[index];
        if (bar === undefined) return undefined;
        switch (operand.metric) {
          case "funding_rate_8h": {
            // The archive stores the HOURLY rate - `fundingUsdOver` sums those
            // rows directly to price a hold. The watch metric, and therefore
            // this operand, is the 8h rate, so eight hourly hours of it.
            const hourly = fundingRateAt(bar.closeTime);
            return hourly === undefined ? undefined : hourly * 8;
          }
          case "volume":
            return bar.volume;
          case "volume_ratio":
            return volumeRatioAt(index);
        }
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
   * The entry, with its `after` clause applied.
   *
   * The antecedent window is `[index - withinBars, index - 1]`: closed bars
   * strictly BEFORE the entry bar, clipped at the start of the series. The
   * entry bar is excluded on purpose (see {@link ThesisSequence}), and because
   * the window only ever looks backwards, adding an `after` clause cannot make
   * a signal depend on a bar the engine had not reached yet.
   */
  const entryFires = (index: number): boolean => {
    if (!conditionHolds(thesis.entry, index)) return false;
    const after = thesis.after;
    if (after === undefined) return true;
    const earliest = Math.max(0, index - after.withinBars);
    for (let prior = index - 1; prior >= earliest; prior -= 1) {
      if (conditionHolds(after.condition, prior)) return true;
    }
    return false;
  };

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
          ...(distance.period === undefined ? {} : { period: distance.period }),
        });
        const atr = points[signalIndex]?.value;
        return atr === undefined ? undefined : atr * distance.multiple;
      }
      case "r":
        return stopDistance === undefined ? undefined : stopDistance * distance.multiple;
    }
  };

  return { conditionHolds, entryFires, distanceInPrice };
}

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

  const { conditionHolds, entryFires, distanceInPrice } = makeThesisSignals({
    thesis,
    candles,
    funding,
  });

  // -- funding, as a prefix sum so a hold costs one subtraction ---------------
  const fundingTimes = funding.map((row) => row.time);
  const fundingPrefix: Array<number> = new Array(funding.length + 1).fill(0);
  for (let i = 0; i < funding.length; i += 1) {
    fundingPrefix[i + 1] = (fundingPrefix[i] as number) + (funding[i]?.fundingRate ?? 0);
  }
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
    const start = fundingRowsThrough(fundingTimes, from);
    const end = fundingRowsThrough(fundingTimes, to);
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
  for (let index = 0; index < bars; index += 1) {
    entrySignal[index] = entryFires(index);
  }
  // `nextExitAt[i]` is the first bar at or after `i` whose close fires the exit
  // condition, or -1 when none does. Built backwards in one pass so a trade
  // reads its exit rather than scanning forward for it, which on a rule that
  // rarely fires cost a walk of the rest of the window per trade.
  const opposite = thesis.exits.opposite;
  let nextExitAt: Array<number> | null = null;
  if (opposite !== undefined) {
    const found: Array<number> = new Array(bars).fill(-1);
    for (let index = bars - 1; index >= 0; index -= 1) {
      found[index] = conditionHolds(opposite, index) ? index : (found[index + 1] ?? -1);
    }
    nextExitAt = found;
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
    let closeExit: { readonly index: number; readonly reason: BacktestExitReason } | undefined;
    if (nextExitAt !== null) {
      const signalled = nextExitAt[entryIndex] as number;
      // A signal on the last bar has no next bar to fill at, which is why the
      // forward scan this replaced stopped at `bars - 2`.
      if (signalled >= 0 && signalled <= bars - 2) {
        closeExit = { index: signalled + 1, reason: "exit_condition" };
      }
    }
    if (maxHoldBars !== undefined) {
      const limit = entryIndex + maxHoldBars;
      if (limit <= bars - 1 && (closeExit === undefined || limit < closeExit.index)) {
        closeExit = { index: limit, reason: "max_hold" };
      }
    }

    // Level exits are checked over the bars fully held. The bar a close-based
    // exit fills on is NOT one of them — the position left at its open.
    const walkEnd = closeExit === undefined ? bars - 1 : closeExit.index - 1;
    const size = notionalUsd / entryPrice;
    const settlement = settleOnBars({
      long,
      entryPrice,
      ...(stopPrice === undefined ? {} : { stopPrice }),
      ...(targetPrice === undefined ? {} : { targetPrice }),
      size,
      bars: candles.slice(entryIndex, walkEnd + 1),
    });

    const exitIndex =
      settlement.outcome !== "open"
        ? entryIndex + settlement.barsHeld - 1
        : (closeExit?.index ?? bars - 1);
    const exitBar = candles[exitIndex] as MarketCandle;
    let exitPrice: number;
    let exitTime: number;
    let exitReason: BacktestExitReason;
    let barsHeld: number;
    if (settlement.outcome !== "open") {
      exitPrice = settlement.exitPrice;
      // The level was touched somewhere inside the bar and OHLC cannot say
      // where, so the bar's close time is the honest stamp for the funding it
      // has to pay.
      exitTime = exitBar.closeTime;
      exitReason = settlement.outcome;
      barsHeld = settlement.barsHeld;
    } else if (closeExit !== undefined) {
      exitPrice = exitBar.open;
      exitTime = exitBar.openTime;
      exitReason = closeExit.reason;
      barsHeld = exitIndex - entryIndex;
    } else {
      exitPrice = exitBar.close;
      exitTime = exitBar.closeTime;
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
  //
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

  const stats = summarizeTrades({
    trades,
    setupsFound,
    setupsUnpriced,
    bars,
    buyAndHoldNetUsd,
    buyAndHoldReturnPercent,
  });

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
// the sweep
// ---------------------------------------------------------------------------
//
// Testing "does 12 bars work better than 8" used to mean twelve calls, twelve
// archive reads, and twelve reports the user had to hold in their head at
// once. A sweep is one call: one window loaded, one parameter moved, one
// table. It is a refinement tool and not a search - twelve values is a
// question, and a thousand is a curve being fitted to noise.

/**
 * Values one sweep may name.
 *
 * Twelve is enough to walk a period from 5 to 60 in fives, or a stop from 0.5
 * to 3.0 in quarters, which is the shape of the question people actually ask.
 * It is deliberately small: the more variations a run reports, the better the
 * best of them looks by luck alone, and a cap is the cheapest defence against
 * reading that luck as an edge.
 */
export const BACKTEST_SWEEP_MAX_VALUES = 12;

/**
 * How much more work a sweep may do than a single run, in bars walked.
 *
 * A sweep loads the window ONCE and walks it once per value, so the archive
 * read does not multiply but the arithmetic does. Four single runs' worth is
 * the budget: it leaves the whole twelve values available on the windows
 * people sweep in practice (20,000 bars and under) while refusing the
 * combination that would sit far past the documented sync budget - twelve
 * variations over the full 60,000 bar cap.
 */
export const BACKTEST_SWEEP_BAR_BUDGET_FACTOR = 4;

/** Total bars a sweep may walk across every variation. */
export const BACKTEST_SWEEP_MAX_BAR_WALKS = BACKTEST_MAX_BARS * BACKTEST_SWEEP_BAR_BUDGET_FACTOR;

/**
 * Which number a sweep moves.
 *
 * A path, not an expression: it addresses one numeric leaf of the thesis by
 * name, and the set of addressable leaves is closed. Anything else refuses.
 * Written the way the thesis object reads, so the model can point at a field
 * it just wrote rather than learn a second naming scheme:
 *
 *   entry.predicates[0].left.period        an indicator period in the entry
 *   entry.predicates[1].right.value        a constant the entry compares to
 *   after.condition.predicates[0].left.period    the same, in the antecedent
 *   after.withinBars                       how far back the antecedent counts
 *   exits.stop.value | exits.stop.multiple       the stop size
 *   exits.target.value | exits.target.multiple   the target size
 *   exits.maxHoldBars                      the bar limit
 */
export const BacktestSweep = Schema.Struct({
  path: Schema.String,
  values: Schema.Array(Schema.Number),
});
export type BacktestSweep = typeof BacktestSweep.Type;

/** One variation's line in the table. Deliberately narrow: the report has a ceiling. */
export const BacktestSweepRow = Schema.Struct({
  value: Schema.Number,
  tradesTaken: Schema.Number,
  winRatePercent: Schema.Number,
  /** Net per trade after every fee and funding payment. What the table sorts on. */
  expectancyUsd: Schema.Number,
  maxDrawdownUsd: Schema.Number,
  totalNetUsd: Schema.Number,
  verdict: BacktestVerdict,
});
export type BacktestSweepRow = typeof BacktestSweepRow.Type;

export const BacktestSweepReport = Schema.Struct({
  path: Schema.String,
  rows: Schema.Array(BacktestSweepRow),
  /**
   * The row with the highest expectancy among those with a gradeable sample,
   * or null when none had one.
   *
   * "Best in sample" and nothing more. It is the top of twelve numbers measured
   * on one window of one market, which is exactly the quantity a sweep is most
   * likely to overfit; every surface that shows it says so in words beside it,
   * and neither the field nor that line ever calls it an edge.
   */
  bestIndex: Schema.NullOr(Schema.Number),
  /** The window every variation was measured on. Reported once, not per row. */
  coverage: BacktestCoverage,
  costs: BacktestCosts,
  notionalUsd: Schema.Number,
  /** The thesis the sweep started from, before the path was moved. */
  thesis: TradingThesis,
});
export type BacktestSweepReport = typeof BacktestSweepReport.Type;

/** One addressable leaf, parsed. `null` is a path outside the closed set. */
const parseSweepPath = (
  path: string,
):
  | {
      readonly kind: "predicate";
      readonly where: "entry" | "after";
      readonly index: number;
      readonly side: "left" | "right";
      readonly leaf: "period" | "value";
    }
  | { readonly kind: "withinBars" }
  | { readonly kind: "maxHoldBars" }
  | {
      readonly kind: "distance";
      readonly which: "stop" | "target";
      readonly leaf: "value" | "multiple";
    }
  | null => {
  if (path === "after.withinBars") return { kind: "withinBars" };
  if (path === "exits.maxHoldBars") return { kind: "maxHoldBars" };
  for (const which of ["stop", "target"] as const) {
    for (const leaf of ["value", "multiple"] as const) {
      if (path === `exits.${which}.${leaf}`) return { kind: "distance", which, leaf };
    }
  }
  const predicate =
    /^(entry|after\.condition)\.predicates\[(\d+)\]\.(left|right)\.(period|value)$/.exec(path);
  if (predicate === null) return null;
  const index = Number(predicate[2]);
  if (!Number.isInteger(index)) return null;
  return {
    kind: "predicate",
    where: predicate[1] === "entry" ? "entry" : "after",
    index,
    side: predicate[3] === "left" ? "left" : "right",
    leaf: predicate[4] === "period" ? "period" : "value",
  };
};

/** A path in the words a table heading uses. */
export function describeSweepPath(path: string): string {
  const parsed = parseSweepPath(path);
  if (parsed === null) return path;
  switch (parsed.kind) {
    case "withinBars":
      return "withinBars";
    case "maxHoldBars":
      return "maxHoldBars";
    case "distance":
      return parsed.which;
    case "predicate":
      return `${parsed.where} ${parsed.side} ${parsed.leaf}`;
  }
}

/**
 * The thesis with one leaf moved to `value`, or a refusal naming why not.
 *
 * Refuses rather than silently doing nothing when the leaf the path names does
 * not exist on THIS thesis - sweeping the ATR multiple of a percent stop is a
 * question with no answer, and returning twelve identical rows would be a
 * worse answer than saying so.
 */
export function applySweepValue(
  thesis: TradingThesis,
  path: string,
  value: number,
): TradingThesis | string {
  const parsed = parseSweepPath(path);
  if (parsed === null) {
    return `vary.path "${path}" is not a parameter a sweep can move. Name one of entry.predicates[n].left|right.period|value, after.condition.predicates[n].left|right.period|value, after.withinBars, exits.stop|target.value|multiple, or exits.maxHoldBars`;
  }
  switch (parsed.kind) {
    case "withinBars": {
      if (thesis.after === undefined)
        return "vary.path after.withinBars: this thesis has no after clause";
      return { ...thesis, after: { ...thesis.after, withinBars: value } };
    }
    case "maxHoldBars": {
      if (thesis.exits.maxHoldBars === undefined) {
        return "vary.path exits.maxHoldBars: this thesis names no bar limit";
      }
      return { ...thesis, exits: { ...thesis.exits, maxHoldBars: value } };
    }
    case "distance": {
      const distance = thesis.exits[parsed.which];
      if (distance === undefined)
        return `vary.path exits.${parsed.which}: this thesis has no ${parsed.which}`;
      if (parsed.leaf === "value") {
        if (distance.basis !== "percent") {
          return `vary.path exits.${parsed.which}.value: that ${parsed.which} is measured in ${distance.basis}, so its size is .multiple`;
        }
        return { ...thesis, exits: { ...thesis.exits, [parsed.which]: { ...distance, value } } };
      }
      if (distance.basis === "percent") {
        return `vary.path exits.${parsed.which}.multiple: that ${parsed.which} is a percent, so its size is .value`;
      }
      return {
        ...thesis,
        exits: { ...thesis.exits, [parsed.which]: { ...distance, multiple: value } },
      };
    }
    case "predicate": {
      const condition = parsed.where === "entry" ? thesis.entry : thesis.after?.condition;
      if (condition === undefined)
        return "vary.path after.condition: this thesis has no after clause";
      const predicate = condition.predicates[parsed.index];
      if (predicate === undefined) {
        return `vary.path ${path}: that condition has ${condition.predicates.length} comparisons`;
      }
      const operand = predicate[parsed.side];
      if (parsed.leaf === "period" && operand.source !== "indicator") {
        return `vary.path ${path}: that operand is a ${operand.source}, and only an indicator has a period`;
      }
      if (parsed.leaf === "value" && operand.source !== "constant") {
        return `vary.path ${path}: that operand is a ${operand.source}, and only a constant has a value`;
      }
      const moved =
        parsed.leaf === "period" ? { ...operand, period: value } : { ...operand, value };
      const predicates = condition.predicates.map((existing, index) =>
        index === parsed.index ? { ...existing, [parsed.side]: moved } : existing,
      );
      const next = { ...condition, predicates };
      return parsed.where === "entry"
        ? { ...thesis, entry: next }
        : { ...thesis, after: { ...(thesis.after as ThesisSequence), condition: next } };
    }
  }
}

/**
 * Everything a sweep can be refused for before a bar is loaded. `null` to run.
 *
 * `bars` is the window the run would walk, so the budget refusal can say the
 * arithmetic rather than just quoting a cap.
 */
export function checkBacktestSweep(input: {
  readonly sweep: BacktestSweep;
  readonly thesis: TradingThesis;
  readonly bars: number;
}): string | null {
  const { sweep, bars } = input;
  if (sweep.values.length === 0) return "vary.values: name at least one value to try";
  if (sweep.values.length > BACKTEST_SWEEP_MAX_VALUES) {
    return `vary.values: ${sweep.values.length} values, at most ${BACKTEST_SWEEP_MAX_VALUES}. A sweep is a refinement, not a search`;
  }
  const applied = applySweepValue(input.thesis, sweep.path, sweep.values[0] as number);
  if (typeof applied === "string") return applied;
  const walks = bars * sweep.values.length;
  if (walks > BACKTEST_SWEEP_MAX_BAR_WALKS) {
    return (
      `that sweep walks ${walks.toLocaleString("en-US")} bars (${bars.toLocaleString("en-US")} x ` +
      `${sweep.values.length}) and the budget is ${BACKTEST_SWEEP_MAX_BAR_WALKS.toLocaleString("en-US")}, ` +
      `so try fewer values or a shorter window`
    );
  }
  return null;
}

/**
 * One window, walked once per value.
 *
 * The candles and funding are loaded by the caller and passed in whole, which
 * is the entire performance argument for the feature: twelve variations cost
 * twelve walks and ONE archive read. Every variation is a complete
 * {@link BacktestRun}, so the caller can persist each as its own row rather
 * than inventing a second, thinner record for swept runs.
 *
 * A variation whose value the thesis cannot take is not silently dropped - the
 * whole sweep is refused up front by {@link checkBacktestSweep}, and a value
 * the grammar refuses individually is reported through `refusals`.
 */
export function runBacktestSweep(input: {
  readonly thesis: TradingThesis;
  readonly sweep: BacktestSweep;
  readonly candles: ReadonlyArray<MarketCandle>;
  readonly funding?: ReadonlyArray<{ readonly time: number; readonly fundingRate: number }>;
  readonly costs: BacktestCosts;
  readonly coverage: BacktestCoverage;
  readonly notionalUsd?: number;
}): {
  readonly report: BacktestSweepReport;
  /** Every variation's full run, in the order the values were named. */
  readonly runs: ReadonlyArray<{ readonly value: number; readonly run: BacktestRun }>;
  /** Values the grammar would not take, each with the reason. */
  readonly refusals: ReadonlyArray<{ readonly value: number; readonly reason: string }>;
} {
  const notionalUsd = input.notionalUsd ?? DEFAULT_BACKTEST_NOTIONAL_USD;
  const runs: Array<{ readonly value: number; readonly run: BacktestRun }> = [];
  const refusals: Array<{ readonly value: number; readonly reason: string }> = [];

  for (const value of input.sweep.values) {
    const varied = applySweepValue(input.thesis, input.sweep.path, value);
    if (typeof varied === "string") {
      refusals.push({ value, reason: varied });
      continue;
    }
    const invalid = validateThesis(varied);
    if (invalid !== null) {
      refusals.push({ value, reason: invalid });
      continue;
    }
    runs.push({
      value,
      run: runBacktest({
        thesis: varied,
        candles: input.candles,
        ...(input.funding === undefined ? {} : { funding: input.funding }),
        costs: input.costs,
        coverage: input.coverage,
        notionalUsd,
      }),
    });
  }

  const rows: Array<BacktestSweepRow> = runs.map(({ value, run }) => ({
    value,
    tradesTaken: run.report.stats.tradesTaken,
    winRatePercent: run.report.stats.winRatePercent,
    expectancyUsd: run.report.stats.expectancyUsd,
    maxDrawdownUsd: run.report.stats.maxDrawdownUsd,
    totalNetUsd: run.report.stats.totalNetUsd,
    verdict: run.report.verdict,
  }));

  // The best row is chosen only among gradeable samples. A variation that took
  // three trades can post the highest expectancy in the table and mean nothing
  // by it, and marking it would be the sweep telling its own worst lie.
  let bestIndex: number | null = null;
  for (const [index, row] of rows.entries()) {
    if (row.verdict === "insufficient_sample") continue;
    if (
      bestIndex === null ||
      row.expectancyUsd > (rows[bestIndex] as BacktestSweepRow).expectancyUsd
    ) {
      bestIndex = index;
    }
  }

  return {
    report: {
      path: input.sweep.path,
      rows,
      bestIndex,
      coverage: input.coverage,
      costs: input.costs,
      notionalUsd,
      thesis: input.thesis,
    },
    runs,
    refusals,
  };
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
  /**
   * The filed idea this run tests, so the numbers attach to the version they
   * were measured on rather than floating free. The submitted thesis has to be
   * identical to that version's - otherwise the run would be filed under a
   * version it did not measure, which is the one thing the link exists to
   * prevent, and it is refused.
   */
  hypothesisId: Schema.optional(Schema.String),
  /**
   * Run the same window once per value of one parameter, and report the table.
   *
   * The refinement tool. Without it, asking whether a 12 bar reach beats an 8
   * bar one is two calls and two archive reads, and comparing them is the
   * user's job; with it the comparison IS the answer.
   */
  vary: Schema.optional(BacktestSweep),
});
export type TradingBacktestInput = typeof TradingBacktestInput.Type;

export const TradingBacktestResult = Schema.Struct({
  report: Schema.optional(BacktestReport),
  /** Set when the call named `vary`. The single `report` is then the base run. */
  sweep: Schema.optional(BacktestSweepReport),
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
    `metric operand = {source:metric, metric: ${ThesisMetricName.literals.join("|")}}; funding_rate_8h is the archived 8h rate at the bar close (0.0001 = 1bp/8h, signed), volume_ratio is the bar against its previous ${THESIS_VOLUME_RATIO_BARS} bars`,
    `after = {condition, withinBars 1-${THESIS_MAX_WITHIN_BARS}} makes the entry fire only when the condition matched within that many CLOSED bars before it; the entry bar never counts as its own antecedent, and after cannot nest`,
    `vary = {path, values} runs one window once per value, at most ${BACKTEST_SWEEP_MAX_VALUES}; path = entry.predicates[n].left|right.period|value, after.condition.predicates[n]..., after.withinBars, exits.stop|target.value|multiple, exits.maxHoldBars`,
    "a sweep marks its best row BEST IN SAMPLE, which is the value most likely fitted to the window; validate it forward before believing it",
    `lookbackDays defaults to everything archived; ${BACKTEST_MAX_BARS.toLocaleString("en-US")} bars a run, ${BACKTEST_SWEEP_MAX_BAR_WALKS.toLocaleString("en-US")} across a sweep, so ask a long 1m window on a coarser interval`,
    `signals read closed bars and fill at the next bar open; every trade pays ${BACKTEST_TAKER_FEE_BPS_PER_SIDE} bps taker a side plus crossing plus archived funding`,
    `under ${MIN_REPLAY_SETUPS} trades there is no verdict, only the numbers; this is research and never places an order`,
  ].join(" · ");
}
