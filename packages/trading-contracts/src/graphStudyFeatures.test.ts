/**
 * Graph-derived study inputs, held to their honesty rules.
 *
 * Sparse buckets stay sparse; net flow signs follow base direction; feature
 * windows are grid arithmetic, not wall clocks; and nothing outside an
 * occurrence's window can leak into its features.
 *
 * @module TradingGraphStudyFeatures.test
 */
import { describe, expect, it } from "@effect/vitest";

import type { ForgeSwapObservation } from "./forge.ts";
import { computeGraphWindowFeatures, observationsToCandles } from "./graphStudyFeatures.ts";

const MINUTE = 60_000;

const swap = (
  over: Partial<ForgeSwapObservation> & { timestamp: number },
): ForgeSwapObservation => ({
  chain: "ethereum-mainnet",
  poolId: "0xabc0000000000000000000000000000000000001",
  observationId: `0xtx:${over.timestamp}`,
  transactionHash: "0x" + "1".repeat(64),
  logIndex: 0,
  timestamp: over.timestamp,
  sender: over.sender ?? "0xsender1",
  recipient: "0xrecipient1",
  amount0: over.amount0 ?? "1000",
  amount1: over.amount1 ?? "-5000",
  sqrtPriceX96: "1",
  tick: 0,
  baseIsToken1: over.baseIsToken1 ?? false,
  priceQuotePerBase: { numerator: "2000", denominator: "1" },
  priceQuotePerBaseMicros: over.priceQuotePerBaseMicros ?? 2_000_000,
  quoteVolumeMicros: over.quoteVolumeMicros ?? 500,
  quoteVolumeRaw: "500",
});

describe("observationsToCandles", () => {
  it("aggregates per grid bucket with open/close by time and high/low extremes", () => {
    const candles = observationsToCandles(
      [
        swap({ timestamp: 60, priceQuotePerBaseMicros: 2_000_000, quoteVolumeMicros: 100 }),
        swap({ timestamp: 100, priceQuotePerBaseMicros: 3_000_000, quoteVolumeMicros: 200 }),
        swap({ timestamp: 110, priceQuotePerBaseMicros: 2_500_000, quoteVolumeMicros: 50 }),
      ],
      { intervalMs: MINUTE },
    );
    expect(candles).toHaveLength(1);
    const candle = candles[0]!;
    expect(candle.openTime).toBe(60_000);
    expect(candle.closeTime).toBe(2 * MINUTE - 1);
    expect(candle.open).toBeCloseTo(2.0, 6);
    expect(candle.close).toBeCloseTo(2.5, 6);
    expect(candle.high).toBeCloseTo(3.0, 6);
    expect(candle.low).toBeCloseTo(2.0, 6);
    expect(candle.volume).toBeCloseTo(0.00035, 9);
    expect(candle.trades).toBe(3);
  });

  it("leaves sparse buckets out — no forward fill, no zero candle", () => {
    const candles = observationsToCandles(
      [swap({ timestamp: 60 }), swap({ timestamp: 60 + 5 * 60 })],
      { intervalMs: MINUTE },
    );
    expect(candles).toHaveLength(2);
    expect(candles[1]!.openTime - candles[0]!.openTime).toBe(5 * MINUTE);
  });

  it("refuses non-positive intervals", () => {
    expect(() => observationsToCandles([], { intervalMs: 0 })).toThrow();
  });
});

describe("computeGraphWindowFeatures", () => {
  const occurrence = { startAt: 0, endAt: 1_000, source: "test" };

  it("signs net flow by base direction with exact micros and counts distinct senders", () => {
    // baseIsToken0: amount0 is the base delta. +2000 (buy), -800 (sell),
    // +100 (buy) from two different senders.
    const features = computeGraphWindowFeatures({
      occurrences: [occurrence],
      observations: [
        swap({ timestamp: 10, amount0: "2000", quoteVolumeMicros: 1000, sender: "0xa" }),
        swap({ timestamp: 20, amount0: "-800", quoteVolumeMicros: 400, sender: "0xb" }),
        swap({ timestamp: 30, amount0: "100", quoteVolumeMicros: 50, sender: "0xa" }),
      ],
      intervalMs: MINUTE,
      horizonBars: 1,
    });
    expect(features).toHaveLength(1);
    const feature = features[0]!;
    expect(feature.netFlowMicros).toBe(1000 - 400 + 50);
    expect(feature.participants).toBe(2);
    expect(feature.tradeCount).toBe(3);
    expect(feature.windowFromMs).toBe(0);
    expect(feature.windowToMs).toBe(MINUTE);
  });

  it("respects baseIsToken1: the base delta follows the declared slot", () => {
    const features = computeGraphWindowFeatures({
      occurrences: [occurrence],
      observations: [
        swap({
          timestamp: 10,
          amount0: "-5000",
          amount1: "2000",
          baseIsToken1: true,
          quoteVolumeMicros: 700,
        }),
      ],
      intervalMs: MINUTE,
      horizonBars: 1,
    });
    expect(features[0]!.netFlowMicros).toBe(700);
  });

  it("excludes swaps outside the grid window and stops early past it", () => {
    const features = computeGraphWindowFeatures({
      occurrences: [occurrence],
      observations: [
        swap({ timestamp: 0 }), // before ceil(0/1000) = 0 → included (boundary)
        swap({ timestamp: MINUTE / 1000 + 5 }), // past windowTo
        swap({ timestamp: 30 }),
      ],
      intervalMs: MINUTE,
      horizonBars: 1,
    });
    expect(features[0]!.tradeCount).toBe(2);
  });

  it("reports count-zero features for an occurrence with no swaps, never invented flow", () => {
    const features = computeGraphWindowFeatures({
      occurrences: [occurrence],
      observations: [],
      intervalMs: MINUTE,
      horizonBars: 1,
    });
    expect(features[0]!.netFlowMicros).toBe(0);
    expect(features[0]!.participants).toBe(0);
    expect(features[0]!.tradeCount).toBe(0);
  });

  it("aligns windows to the occurrence's grid slot, not its raw start", () => {
    const features = computeGraphWindowFeatures({
      occurrences: [{ ...occurrence, startAt: 90_000 }],
      observations: [swap({ timestamp: 60 })], // inside the aligned slot
      intervalMs: MINUTE,
      horizonBars: 1,
    });
    expect(features[0]!.windowFromMs).toBe(MINUTE);
    expect(features[0]!.tradeCount).toBe(1);
  });
});
