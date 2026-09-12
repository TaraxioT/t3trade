/** Pure Graph price and flow transforms. Sparse buckets remain sparse. */
import type { ForgeSwapObservation } from "./forge.ts";
import type { MarketCandle } from "./market.ts";
import type { EventStudyReport, EventStudyRow } from "./eventSets.ts";

/** The micros scale every rendered quantity here uses (1e6 per whole unit). */
export const GRAPH_STUDY_MICROS_SCALE = 1_000_000;

// ---------------------------------------------------------------------------
// Candles from observations
// ---------------------------------------------------------------------------

// Same-second swaps need log order; response/id order is not execution order.
const compareSwaps = (a: ForgeSwapObservation, b: ForgeSwapObservation): number =>
  a.timestamp - b.timestamp ||
  a.logIndex - b.logIndex ||
  a.observationId.localeCompare(b.observationId);

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
  if (!Number.isSafeInteger(input.intervalMs) || input.intervalMs <= 0)
    throw new Error("intervalMs must be positive");
  const byBucket = new Map<number, Array<ForgeSwapObservation>>();
  for (const observation of [...observations].sort(compareSwaps)) {
    const bucket = Math.floor((observation.timestamp * 1000) / input.intervalMs) * input.intervalMs;
    const existing = byBucket.get(bucket);
    if (existing === undefined) byBucket.set(bucket, [observation]);
    else existing.push(observation);
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

/** Pool deltas are signed against the pool: a negative base delta is a buy. */
export function computeGraphWindowFeatures(input: {
  readonly observations: ReadonlyArray<ForgeSwapObservation>;
  readonly windowFromMs: number;
  readonly windowToMs: number;
  readonly quoteDecimals: number;
}): { readonly netFlowMicros: string; readonly participants: number; readonly tradeCount: number } {
  if (
    !Number.isSafeInteger(input.quoteDecimals) ||
    input.quoteDecimals < 0 ||
    input.quoteDecimals > 255
  ) {
    throw new Error("quoteDecimals must be an integer from 0 to 255");
  }
  let netFlowRaw = 0n;
  const participants = new Set<string>();
  let tradeCount = 0;
  for (const observation of input.observations) {
    const atMs = observation.timestamp * 1000;
    if (atMs < input.windowFromMs || atMs > input.windowToMs) continue;
    const baseDelta = BigInt(observation.baseIsToken1 ? observation.amount1 : observation.amount0);
    const quoteRaw = BigInt(observation.quoteVolumeRaw);
    if (baseDelta < 0n) netFlowRaw += quoteRaw;
    else if (baseDelta > 0n) netFlowRaw -= quoteRaw;
    participants.add(observation.sender.toLowerCase());
    tradeCount += 1;
  }
  return {
    netFlowMicros: ((netFlowRaw * 1_000_000n) / 10n ** BigInt(input.quoteDecimals)).toString(),
    participants: participants.size,
    tradeCount,
  };
}

/** Use the measured row, including truncation, rather than reconstructing its window. */
export function attachGraphStudyFeatures(
  report: EventStudyReport,
  observations: ReadonlyArray<ForgeSwapObservation>,
  quoteDecimals: number,
): EventStudyReport {
  return {
    ...report,
    rows: report.rows.map((row): EventStudyRow => {
      if (!row.covered || row.entryTime === undefined || row.exitTime === undefined) return row;
      const features = computeGraphWindowFeatures({
        observations,
        windowFromMs: row.entryTime,
        windowToMs: row.exitTime,
        quoteDecimals,
      });
      return {
        ...row,
        netFlowMicros: features.netFlowMicros,
        graphParticipants: features.participants,
        graphTradeCount: features.tradeCount,
      };
    }),
  };
}
