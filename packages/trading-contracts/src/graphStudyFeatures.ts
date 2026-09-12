/**
 * Graph-derived study inputs — pure transforms from retained swap
 * observations into the two things an event study consumes.
 *
 * The study engine (`runEventStudy`) is source-agnostic: it wants candles on
 * a regular grid and occurrences. This module is the Graph half of that
 * contract: it aggregates retained Uniswap swap observations into sparse
 * grid-aligned candles, and computes the per-occurrence blockchain features
 * (net flow, participants, trade count) that make a Graph-backed study
 * materially different from an archive-backed one — the features come from
 * the SAME retained bytes as the prices, under the SAME pinned block, so a
 * row's price and its flow can never disagree about what was known.
 *
 * Honesty rules encoded here:
 *
 * - Sparse swaps stay sparse. A bucket with no swaps produces no candle; the
 *   study engine already truncates windows at interior grid gaps, so a
 *   thinly traded pool measures short, visibly, instead of being silently
 *   forward-filled into a continuous-looking price.
 * - Prices are integer-division renderings of the exact observation ratios
 *   (micros at 1e6), the same display tier the archive's bars occupy; the
 *   exact ratios stay in the retained observations for anyone who needs
 *   more than the chart's precision.
 * - `netFlowMicros` is the signed sum of quote legs by base direction:
 *   swaps that moved base TO the recipient (buys) add their quote volume,
 *   swaps that moved base AWAY (sells) subtract it. Exact integers in micro
 *   units; no float touches the value until a surface renders it.
 * - Feature windows are the occurrence's own measurement window on the same
 *   grid arithmetic family as the study — start slot through the horizon's
 *   last slot — and a window with no observations reports zeros only for
 *   COUNTS while the absence itself stays visible through the row's
 *   coverage fields computed elsewhere.
 *
 * Pure module: no services, no IO, no clocks.
 *
 * @module TradingGraphStudyFeatures
 */
import type { ForgeSwapObservation } from "./forge.ts";
import type { MarketCandle } from "./market.ts";
import type { TradingEventOccurrence } from "./eventSets.ts";

/** The micros scale every rendered quantity here uses (1e6 per whole unit). */
export const GRAPH_STUDY_MICROS_SCALE = 1_000_000;

// ---------------------------------------------------------------------------
// Candles from observations
// ---------------------------------------------------------------------------

/**
 * Aggregate retained swaps into grid-aligned candles.
 *
 * Buckets with no swaps produce no candle (sparse stays sparse). Prices are
 * the observations' `priceQuotePerBaseMicros` renderings; a bucket's open is
 * its first swap by timestamp, close the last, high/low the extremes; volume
 * is the summed quote leg in whole units (display tier, like the archive's).
 * Output is oldest-first and deduplicated by bucket.
 */
export function observationsToCandles(
  observations: ReadonlyArray<ForgeSwapObservation>,
  input: { readonly intervalMs: number },
): ReadonlyArray<MarketCandle> {
  if (input.intervalMs <= 0) throw new Error("intervalMs must be positive");
  const byBucket = new Map<number, ReadonlyArray<ForgeSwapObservation>>();
  for (const observation of [...observations].sort((a, b) => a.timestamp - b.timestamp)) {
    const bucket = Math.floor((observation.timestamp * 1000) / input.intervalMs) * input.intervalMs;
    const existing = byBucket.get(bucket);
    byBucket.set(bucket, existing === undefined ? [observation] : [...existing, observation]);
  }
  const candles: Array<MarketCandle> = [];
  for (const [openTime, bucket] of [...byBucket.entries()].sort((a, b) => a[0] - b[0])) {
    const prices = bucket.map((o) => o.priceQuotePerBaseMicros / GRAPH_STUDY_MICROS_SCALE);
    const volumeMicros = bucket.reduce((total, o) => total + o.quoteVolumeMicros, 0);
    candles.push({
      openTime,
      closeTime: openTime + input.intervalMs - 1,
      open: prices[0]!,
      close: prices[prices.length - 1]!,
      high: Math.max(...prices),
      low: Math.min(...prices),
      volume: volumeMicros / GRAPH_STUDY_MICROS_SCALE,
      trades: bucket.length,
    });
  }
  return candles;
}

// ---------------------------------------------------------------------------
// Per-occurrence features
// ---------------------------------------------------------------------------

/** One occurrence's Graph-derived features over its measurement window. */
export interface GraphWindowFeatures {
  /** The occurrence's own start, carried for row matching. */
  readonly startAt: number;
  readonly endAt: number;
  /** Window actually measured on the grid: start slot to horizon's last slot. */
  readonly windowFromMs: number;
  readonly windowToMs: number;
  /** Signed quote value of base purchases minus base sales, exact micros. */
  readonly netFlowMicros: number;
  /** Distinct transacting senders in the window. */
  readonly participants: number;
  /** Swap count in the window. */
  readonly tradeCount: number;
}

/** Signed base delta of one observation in raw integer units (BigInt). */
const signedBaseDelta = (observation: ForgeSwapObservation): bigint =>
  BigInt(observation.baseIsToken1 ? observation.amount1 : observation.amount0);

/**
 * Compute each occurrence's Graph-derived features over its measurement
 * window on the study grid.
 *
 * The window starts at the grid slot containing the occurrence's `startAt`
 * and runs `horizonBars` slots — the same family of arithmetic the study's
 * entry/exit location uses, so a feature and its row's price window describe
 * the same span of grid. Observations are filtered to the window by their
 * own timestamps; nothing outside can leak in, and an occurrence with no
 * observations reports count-zero features rather than an invented value.
 */
export function computeGraphWindowFeatures(input: {
  readonly occurrences: ReadonlyArray<TradingEventOccurrence>;
  readonly observations: ReadonlyArray<ForgeSwapObservation>;
  readonly intervalMs: number;
  readonly horizonBars: number;
}): ReadonlyArray<GraphWindowFeatures> {
  if (input.intervalMs <= 0) throw new Error("intervalMs must be positive");
  if (input.horizonBars <= 0) throw new Error("horizonBars must be positive");
  const sorted = [...input.observations].sort((a, b) => a.timestamp - b.timestamp);
  return input.occurrences.map((occurrence) => {
    const windowFromMs = Math.floor(occurrence.startAt / input.intervalMs) * input.intervalMs;
    const windowToMs = windowFromMs + input.intervalMs * input.horizonBars;
    const fromSec = Math.ceil(windowFromMs / 1000);
    const toSec = Math.floor((windowToMs - 1) / 1000);
    let netFlowMicros = 0;
    const participants = new Set<string>();
    let tradeCount = 0;
    for (const observation of sorted) {
      if (observation.timestamp < fromSec) continue;
      if (observation.timestamp > toSec) break;
      tradeCount += 1;
      participants.add(observation.sender);
      const delta = signedBaseDelta(observation);
      if (delta > 0n) netFlowMicros += observation.quoteVolumeMicros;
      else if (delta < 0n) netFlowMicros -= observation.quoteVolumeMicros;
    }
    return {
      startAt: occurrence.startAt,
      endAt: occurrence.endAt,
      windowFromMs,
      windowToMs,
      netFlowMicros,
      participants: participants.size,
      tradeCount,
    };
  });
}
