/**
 * chartAggregation — the chart-only weekly/monthly candles, derived server-side.
 *
 * `1w` and `1mo` are not archive intervals and never gateway intervals: the
 * archive records daily bars, and a weekly or monthly candle is a pure
 * reduction of them. Week buckets start Monday 00:00:00 UTC; month buckets are
 * UTC calendar months, so their widths vary (28–31 days). Boundaries come from
 * UTC calendar arithmetic on Effect's `DateTime` parts only — no date library,
 * no local-time hazards.
 *
 * Pure by design: no Effect, no clock, no archive. The serving path in
 * `TradingMarketChart` owns how far back to read and whether the record is
 * fresh enough to trust; this module only folds what it is given, so identical
 * input always yields identical output.
 *
 * @module chartAggregation
 */

import * as DateTime from "effect/DateTime";

/** One archived daily bar, reduced to the fields aggregation reads. */
export interface AggregationDailyBar {
  /** Bar open time, epoch millis. */
  readonly t: number;
  readonly o: number;
  readonly h: number;
  readonly l: number;
  readonly c: number;
  readonly v: number;
}

/** The chart-only intervals this module derives: weekly and monthly buckets. */
export type AggregationKind = "1w" | "1mo";

/** One aggregated bucket, shaped exactly like a wire chart candle. */
export interface AggregatedCandle {
  /** Epoch millis, start of the bucket (Monday 00:00 UTC or month boundary). */
  readonly openTime: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * The widest a bucket can be, in daily bars. Weeks are fixed at 7; months vary
 * 28–31, so 31 is the safe bound for ceiling arithmetic.
 */
const BUCKET_WIDTH_DAYS_MAX: Readonly<Record<AggregationKind, number>> = {
  "1w": 7,
  "1mo": 31,
};

/** Hard ceiling for the daily source read feeding aggregation. */
const SOURCE_CEILING_HARD_CAP = 20_000;

/**
 * The open time of the `kind` bucket that `t` falls in.
 *
 * `weekDay` is 0=Sunday (the `Date#getUTCDay` numbering), so `(+6) % 7` makes
 * Monday day 0 of the week. Building from parts normalizes out-of-range days,
 * which is what makes a week or month straddling a year boundary land on the
 * right instant without any carry arithmetic of our own.
 */
export function aggregationBucketStart(kind: AggregationKind, t: number): number {
  const { year, month, day, weekDay } = DateTime.toPartsUtc(DateTime.makeUnsafe(t));
  if (kind === "1mo") {
    return DateTime.makeUnsafe({ year, month, day: 1 }).epochMilliseconds;
  }
  const daysSinceMonday = (weekDay + 6) % 7;
  return DateTime.makeUnsafe({ year, month, day: day - daysSinceMonday }).epochMilliseconds;
}

/**
 * How many daily bars a read must fetch to fill `maxBars` output buckets:
 * `maxBars` full buckets plus the partial one an aligned window start can add,
 * at the bucket kind's widest width, plus one bar of slack.
 *
 * This bounds the SOURCE read only. The output cap is applied after
 * aggregation, so clamping the source read to the output cap instead would
 * drop the oldest buckets before they could be aggregated — the exact
 * truncation this ceiling exists to prevent (the archive keeps the NEWEST
 * bars when it must cut).
 */
export function aggregationSourceCeiling(kind: AggregationKind, maxBars: number): number {
  const ceiling = (maxBars + 1) * BUCKET_WIDTH_DAYS_MAX[kind] + 1;
  return Math.min(ceiling, SOURCE_CEILING_HARD_CAP);
}

/**
 * Fold daily bars into `kind` buckets, oldest first.
 *
 * Bars may arrive unordered and are sorted defensively by `t`. Within each
 * bucket: open is the first daily open, high the max high, low the min low,
 * close the last daily close, volume the sum — in time order. The newest
 * bucket may be incomplete (aggregated from the daily bars closed so far) and
 * is still served, so a live weekly chart carries the running week. `maxBars`
 * applies AFTER aggregation: the newest buckets win, matching how the
 * archive's own window cap keeps the newest bars.
 */
export function aggregateDailyBars(input: {
  readonly bars: ReadonlyArray<AggregationDailyBar>;
  readonly kind: AggregationKind;
  readonly maxBars: number;
}): ReadonlyArray<AggregatedCandle> {
  const sorted = [...input.bars].sort((a, b) => a.t - b.t);
  const buckets: Array<AggregatedCandle> = [];
  // Bucket starts are monotone in `t` and the bars are sorted, so every bucket's
  // bars are consecutive and one streaming pass completes the fold.
  let current: {
    openTime: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  } | null = null;
  for (const bar of sorted) {
    const openTime = aggregationBucketStart(input.kind, bar.t);
    if (current === null || current.openTime !== openTime) {
      if (current !== null) buckets.push(current);
      current = { openTime, open: bar.o, high: bar.h, low: bar.l, close: bar.c, volume: bar.v };
      continue;
    }
    current.high = Math.max(current.high, bar.h);
    current.low = Math.min(current.low, bar.l);
    current.close = bar.c;
    current.volume += bar.v;
  }
  if (current !== null) buckets.push(current);
  return buckets.length <= input.maxBars ? buckets : buckets.slice(buckets.length - input.maxBars);
}
