/**
 * On-demand indicator readings for `trading_look`'s `candles` scope.
 *
 * The model pulls the indicator it is reasoning with — `ema(9)`, `rsi(14)` —
 * instead of deriving it from raw bars in context or receiving a fixed panel
 * it may not read. The server computes on bars it already fetched for the
 * candle read, so a reading costs no extra exchange call.
 *
 * Each reading reports `value` (over every fetched bar, the in-progress one
 * included) and `previous` (the same computation one bar back). The pair is
 * what a crossover or slope check needs: `ema(9) > ema(21)` now and not one
 * bar ago IS the cross, with no series riding back in the response.
 *
 * The pair the `ema_cross` playbook actually trades is `EMA_FAST_PERIOD` /
 * `EMA_SLOW_PERIOD` from `./marketStructure.ts` — 9 and 21 — and the
 * structure read already serves it as its own `ema` block, cross age and
 * separation included. Nothing here recomputes that: these readings are for
 * the periods the structure read does NOT serve, and every example below names
 * the traded pair so a request modelled on one is never pointed at a pair the
 * doctrine has no gate for.
 *
 * Everything is computed once as a SERIES ({@link computeIndicatorSeries}) and
 * the two-value reading is the last two points of it. The backtest engine
 * walks the same series bar by bar, so a thesis tested here and a reading
 * served to the model are the same arithmetic rather than two implementations
 * that agree until they do not.
 *
 * @module indicators
 */
import * as Schema from "effect/Schema";

import { MARKET_FRESHNESS } from "./market.ts";
import type { MarketCandle } from "./market.ts";

export const IndicatorKind = Schema.Literals([
  "ema",
  "sma",
  "rsi",
  "vwap",
  "atr",
  "macd",
  "bollinger",
]);
export type IndicatorKind = typeof IndicatorKind.Type;

/**
 * The same kinds as a plain array, so the `indicators:<spec>` parser builds its
 * pattern from the schema rather than repeating the list. A kind added above
 * and forgotten below is the exact drift this exists to make impossible.
 */
export const INDICATOR_KINDS = [
  "ema",
  "sma",
  "rsi",
  "vwap",
  "atr",
  "macd",
  "bollinger",
] as const satisfies ReadonlyArray<IndicatorKind>;

/**
 * The period each kind computes with when the request names none.
 *
 * `vwap`'s 0 means "the whole fetched window" — a session-style read. A vwap
 * request may still name a period to read the volume-weighted price of just
 * the recent bars.
 *
 * `ema`'s 20 is a generic trend read and deliberately NOT `EMA_FAST_PERIOD`:
 * the 9/21 pair the `ema_cross` doctrine gates on is computed by the structure
 * read and served whole, so defaulting here to one half of it would offer a
 * second, differently-seeded copy of a number the mission already has. A
 * request that wants the traded pair names its period.
 *
 * `macd`'s 12 is its FAST leg only — see {@link MACD_SLOW_PERIOD}.
 */
export const DEFAULT_INDICATOR_PERIODS: Readonly<Record<IndicatorKind, number>> = {
  ema: 20,
  sma: 20,
  rsi: 14,
  vwap: 0,
  atr: 14,
  macd: 12,
  bollinger: 20,
};

/**
 * MACD's slow leg and its signal smoothing.
 *
 * A request's `period` names the FAST leg and nothing else. 26 and 9 are not
 * per-request knobs because "MACD" means this triple everywhere the model has
 * ever read the term, and letting a request move them would produce a number
 * called MACD that no chart agrees with. A thesis that wants a different pair
 * of moving averages composes two `ema` readings instead, which is what that
 * thesis actually is.
 */
export const MACD_SLOW_PERIOD = 26;
export const MACD_SIGNAL_PERIOD = 9;

/**
 * How many standard deviations the Bollinger bands sit from the basis. Two is
 * the universal convention, and the same reasoning as MACD's triple applies:
 * a band at some other multiple is a different indicator, not this one.
 *
 * The deviation is the POPULATION deviation over the basis window (divide by
 * `period`, not `period - 1`), which is what charting platforms plot.
 */
export const BOLLINGER_STDDEV_MULTIPLE = 2;

/**
 * The longest period a request may name. The candle read it computes on
 * fetches at most a few hundred bars; a period near or past that answers with
 * `insufficient bars` anyway, so the schema says so upfront.
 */
export const INDICATOR_MAX_PERIOD = 200;

/**
 * How many bars an indicator has to be computed over to be the number the
 * exchange's own chart shows.
 *
 * The recursion below is seeded with the SMA of the first `period` closes, so
 * a short window leaves that seed weighing on the answer. Measured on ETH 1m:
 * over 120 bars an `ema(50)` sits up to $0.15 away from its converged value,
 * and 1.1% of bars that is enough to put a two-EMA spread on the wrong side of
 * zero — a cross reported that the chart does not show. Five periods drives
 * the seed's remaining weight under 0.1%, at which point the reading and the
 * chart agree to display precision. The same multiple is what the structure
 * read gives `EMA_SLOW_PERIOD`, so the `ema_cross` gates and any indicator
 * request made beside them are converged alike.
 */
export const INDICATOR_LOOKBACK_MULTIPLE = 5;

/**
 * The span a kind actually reaches back over, which is not always the period
 * the request named.
 *
 * `macd(12)` reads 26 bars for its slow leg and another 9 to smooth the
 * signal, so sizing its history off 12 would hand it a window its signal line
 * cannot even be defined on. Every other kind reaches back exactly its own
 * period; `vwap`'s 0 (the whole window) reaches back nothing extra.
 */
export const effectiveIndicatorPeriod = (kind: IndicatorKind, period: number): number =>
  kind === "macd" ? Math.max(period, MACD_SLOW_PERIOD) + MACD_SIGNAL_PERIOD : period;

/**
 * The bars a set of requests needs fetched, capped at what the exchange
 * returns. Zero-period requests (`vwap`'s whole window) ask for nothing extra.
 */
export const indicatorLookbackBars = (
  requests: ReadonlyArray<{ readonly kind: IndicatorKind; readonly period?: number | undefined }>,
): number => {
  const longest = requests.reduce(
    (bars, request) =>
      Math.max(
        bars,
        effectiveIndicatorPeriod(
          request.kind,
          request.period ?? DEFAULT_INDICATOR_PERIODS[request.kind],
        ),
      ),
    0,
  );
  return Math.min(longest * INDICATOR_LOOKBACK_MULTIPLE, MARKET_FRESHNESS.candleHistoryMaxBars);
};

/** How many indicator requests one look computes. */
export const INDICATOR_MAX_REQUESTS = 6;

export const IndicatorRequest = Schema.Struct({
  kind: IndicatorKind,
  /** Bars the computation spans. Defaults per kind; 0 is only vwap's whole window. */
  period: Schema.optional(
    Schema.Number.check(
      Schema.isInt(),
      Schema.isBetween({ minimum: 0, maximum: INDICATOR_MAX_PERIOD }),
    ),
  ),
});
export type IndicatorRequest = typeof IndicatorRequest.Type;

/**
 * The parts a multi-value indicator reports beside its primary number.
 *
 * `macd` fills `signal` and `histogram` beside a `value` that is the MACD
 * line; `bollinger` fills `upper` and `lower` beside a `value` that is the
 * basis. The single-value kinds fill none of them. They are flat rather than a
 * nested block because the two kinds' parts do not overlap, so flatness costs
 * nothing in ambiguity and saves a level of nesting in every response.
 */
export const IndicatorComponent = Schema.Literals([
  "value",
  "signal",
  "histogram",
  "upper",
  "lower",
]);
export type IndicatorComponent = typeof IndicatorComponent.Type;

/** Which components a kind actually reports. `value` is always one of them. */
export const INDICATOR_COMPONENTS: Readonly<
  Record<IndicatorKind, ReadonlyArray<IndicatorComponent>>
> = {
  ema: ["value"],
  sma: ["value"],
  rsi: ["value"],
  vwap: ["value"],
  atr: ["value"],
  macd: ["value", "signal", "histogram"],
  bollinger: ["value", "upper", "lower"],
};

export const IndicatorReading = Schema.Struct({
  kind: IndicatorKind,
  /** The period actually computed with — the kind's default when unnamed. */
  period: Schema.Number,
  /**
   * The latest reading, over every fetched bar including the in-progress one.
   * Absent when the window holds too few bars (or, for vwap, no volume) —
   * absence states "could not be computed", never a zero that reads as a
   * value.
   *
   * For `macd` this is the MACD line; for `bollinger`, the basis.
   */
  value: Schema.optional(Schema.Number),
  /** The same computation one bar back. `value` against `previous` is this bar's cross or slope. */
  previous: Schema.optional(Schema.Number),
  /** `macd` only: the signal line, and the line minus it. */
  signal: Schema.optional(Schema.Number),
  histogram: Schema.optional(Schema.Number),
  /** `bollinger` only: the bands either side of the basis. */
  upper: Schema.optional(Schema.Number),
  lower: Schema.optional(Schema.Number),
});
export type IndicatorReading = typeof IndicatorReading.Type;

/**
 * One bar's worth of an indicator. `value` is the primary component; the rest
 * are present only for the kinds that report them, and only on bars where the
 * longer of their two recursions is defined — a `macd` line exists nine bars
 * before its signal does.
 */
export interface IndicatorPoint {
  readonly value: number;
  readonly signal?: number;
  readonly histogram?: number;
  readonly upper?: number;
  readonly lower?: number;
}

/** Six significant digits, matching the precision doctrine for derived prices. */
const round = (value: number): number =>
  Number.isFinite(value) ? Number(value.toPrecision(6)) : value;

/** A series the same length as the input, `undefined` where it is not yet defined. */
type Series = ReadonlyArray<number | undefined>;

const smaSeries = (closes: ReadonlyArray<number>, period: number): Series => {
  const out: Array<number | undefined> = new Array(closes.length).fill(undefined);
  if (period < 1) return out;
  let sum = 0;
  for (let i = 0; i < closes.length; i += 1) {
    sum += closes[i] as number;
    if (i >= period) sum -= closes[i - period] as number;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
};

/**
 * Standard seeding: the SMA of the first `period` closes, then the recursive
 * smoothing over everything after it.
 */
const emaSeries = (closes: ReadonlyArray<number>, period: number): Series => {
  const out: Array<number | undefined> = new Array(closes.length).fill(undefined);
  if (period < 1 || closes.length < period) return out;
  let seed = 0;
  for (let i = 0; i < period; i += 1) seed += closes[i] as number;
  let value = seed / period;
  out[period - 1] = value;
  const k = 2 / (period + 1);
  for (let i = period; i < closes.length; i += 1) {
    value = (closes[i] as number) * k + value * (1 - k);
    out[i] = value;
  }
  return out;
};

/**
 * The same recursion over a series that starts partway in — MACD's signal line
 * is an EMA of the MACD line, which is undefined for its first 25 bars.
 */
const emaOfSeries = (input: Series, period: number): Series => {
  const defined: Array<number> = [];
  const indices: Array<number> = [];
  for (let i = 0; i < input.length; i += 1) {
    const point = input[i];
    if (point !== undefined) {
      defined.push(point);
      indices.push(i);
    }
  }
  const smoothed = emaSeries(defined, period);
  const out: Array<number | undefined> = new Array(input.length).fill(undefined);
  for (let i = 0; i < indices.length; i += 1) out[indices[i] as number] = smoothed[i];
  return out;
};

/** Wilder's RSI: needs `period + 1` closes for the first `period` deltas. */
const rsiSeries = (closes: ReadonlyArray<number>, period: number): Series => {
  const out: Array<number | undefined> = new Array(closes.length).fill(undefined);
  if (period < 1 || closes.length < period + 1) return out;
  let averageGain = 0;
  let averageLoss = 0;
  for (let i = 1; i <= period; i += 1) {
    const delta = (closes[i] ?? 0) - (closes[i - 1] ?? 0);
    if (delta > 0) averageGain += delta / period;
    else averageLoss += -delta / period;
  }
  const level = (): number =>
    averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss);
  out[period] = level();
  for (let i = period + 1; i < closes.length; i += 1) {
    const delta = (closes[i] ?? 0) - (closes[i - 1] ?? 0);
    averageGain = (averageGain * (period - 1) + Math.max(0, delta)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(0, -delta)) / period;
    out[i] = level();
  }
  return out;
};

/**
 * Volume-weighted average of the typical price. `period` 0 spans everything up
 * to the bar; a named period spans the trailing window, using what history
 * there is when the bar is younger than the window.
 */
const vwapSeries = (candles: ReadonlyArray<MarketCandle>, period: number): Series => {
  const out: Array<number | undefined> = new Array(candles.length).fill(undefined);
  const typical = candles.map((candle) => (candle.high + candle.low + candle.close) / 3);
  let weighted = 0;
  let volume = 0;
  for (let i = 0; i < candles.length; i += 1) {
    const candle = candles[i] as MarketCandle;
    weighted += (typical[i] as number) * candle.volume;
    volume += candle.volume;
    if (period > 0 && i >= period) {
      const dropped = candles[i - period] as MarketCandle;
      weighted -= (typical[i - period] as number) * dropped.volume;
      volume -= dropped.volume;
    }
    // A window with no volume has no volume-weighted price. Absence, not zero.
    out[i] = volume === 0 ? undefined : weighted / volume;
  }
  return out;
};

/**
 * Wilder's ATR. The first bar has no previous close, so the first true range
 * is unusable and the seed is the mean of ranges 1..`period` — the same shape
 * as the RSI above, and the reason both need `period + 1` bars.
 */
const atrSeries = (candles: ReadonlyArray<MarketCandle>, period: number): Series => {
  const out: Array<number | undefined> = new Array(candles.length).fill(undefined);
  if (period < 1 || candles.length < period + 1) return out;
  const trueRange = (index: number): number => {
    const bar = candles[index] as MarketCandle;
    const previousClose = (candles[index - 1] as MarketCandle).close;
    return Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - previousClose),
      Math.abs(bar.low - previousClose),
    );
  };
  let value = 0;
  for (let i = 1; i <= period; i += 1) value += trueRange(i) / period;
  out[period] = value;
  for (let i = period + 1; i < candles.length; i += 1) {
    value = (value * (period - 1) + trueRange(i)) / period;
    out[i] = value;
  }
  return out;
};

/**
 * The whole series for one request, oldest first and the same length as the
 * bars given. `undefined` at an index means the indicator is not defined
 * there — too few bars behind it, or no volume in the vwap window.
 *
 * This is the one implementation. {@link computeIndicator} reads its last two
 * points and the backtest engine indexes it per bar, so a reading served to
 * the model and a reading a thesis was tested on can never disagree.
 */
export const computeIndicatorSeries = (
  request: IndicatorRequest,
  candles: ReadonlyArray<MarketCandle>,
): ReadonlyArray<IndicatorPoint | undefined> => {
  const period = request.period ?? DEFAULT_INDICATOR_PERIODS[request.kind];
  const closes = candles.map((candle) => candle.close);
  const empty: ReadonlyArray<IndicatorPoint | undefined> = new Array(candles.length).fill(
    undefined,
  );

  const single = (series: Series): ReadonlyArray<IndicatorPoint | undefined> =>
    series.map((value) => (value === undefined ? undefined : { value }));

  switch (request.kind) {
    case "ema":
      return single(emaSeries(closes, period));
    case "sma":
      return single(smaSeries(closes, period));
    case "rsi":
      return single(rsiSeries(closes, period));
    case "vwap":
      return single(vwapSeries(candles, period));
    case "atr":
      return single(atrSeries(candles, period));
    case "macd": {
      if (period < 1) return empty;
      const fast = emaSeries(closes, period);
      const slow = emaSeries(closes, MACD_SLOW_PERIOD);
      const line: Series = fast.map((value, index) => {
        const other = slow[index];
        return value === undefined || other === undefined ? undefined : value - other;
      });
      const signal = emaOfSeries(line, MACD_SIGNAL_PERIOD);
      return line.map((value, index) => {
        if (value === undefined) return undefined;
        const signalValue = signal[index];
        return signalValue === undefined
          ? { value }
          : { value, signal: signalValue, histogram: value - signalValue };
      });
    }
    case "bollinger": {
      if (period < 1 || candles.length < period) return empty;
      const basis = smaSeries(closes, period);
      return basis.map((value, index) => {
        if (value === undefined) return undefined;
        let squared = 0;
        for (let i = index - period + 1; i <= index; i += 1) {
          const delta = (closes[i] as number) - value;
          squared += delta * delta;
        }
        const deviation = Math.sqrt(squared / period) * BOLLINGER_STDDEV_MULTIPLE;
        return { value, upper: value + deviation, lower: value - deviation };
      });
    }
  }
};

/**
 * One reading: the request's indicator over the fetched bars, and the primary
 * component's value one bar back. Pure — the caller supplies the bars it
 * already fetched, oldest first.
 */
export const computeIndicator = (
  request: IndicatorRequest,
  candles: ReadonlyArray<MarketCandle>,
): IndicatorReading => {
  const period = request.period ?? DEFAULT_INDICATOR_PERIODS[request.kind];
  const series = computeIndicatorSeries(request, candles);
  const latest = series[series.length - 1];
  const previous = series[series.length - 2];
  return {
    kind: request.kind,
    period,
    ...(latest === undefined ? {} : { value: round(latest.value) }),
    ...(previous === undefined ? {} : { previous: round(previous.value) }),
    ...(latest?.signal === undefined ? {} : { signal: round(latest.signal) }),
    ...(latest?.histogram === undefined ? {} : { histogram: round(latest.histogram) }),
    ...(latest?.upper === undefined ? {} : { upper: round(latest.upper) }),
    ...(latest?.lower === undefined ? {} : { lower: round(latest.lower) }),
  };
};
