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
import {
  attachGraphStudyFeatures,
  computeGraphWindowFeatures,
  observationsToCandles,
} from "./graphStudyFeatures.ts";

import { runEventStudy } from "./eventSets.ts";

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
  quoteVolumeRaw: over.quoteVolumeRaw ?? "500",
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

describe("Graph study flow", () => {
  it("counts buys positive using the pool-signed base leg and exact raw sums", () => {
    const features = computeGraphWindowFeatures({
      observations: [
        swap({ timestamp: 10, amount0: "-2", quoteVolumeRaw: "9007199254740993", sender: "0xAb" }),
        swap({ timestamp: 20, amount0: "1", quoteVolumeRaw: "2", sender: "0xab" }),
        swap({ timestamp: 30, amount1: "-1", baseIsToken1: true, quoteVolumeRaw: "10" }),
        swap({ timestamp: 60, quoteVolumeRaw: "999" }),
      ],
      windowFromMs: 0,
      windowToMs: MINUTE - 1,
      quoteDecimals: 6,
    });
    expect(features.netFlowMicros).toBe("9007199254741001");
    expect(features.participants).toBe(2);
    expect(features.tradeCount).toBe(3);
  });

  it("uses the actual close-entry and truncated exit, excluding pre-entry swaps and gaps", () => {
    const observations = [
      swap({ timestamp: 60, amount0: "-1", quoteVolumeRaw: "900" }),
      swap({ timestamp: 120, amount0: "-1", quoteVolumeRaw: "10" }),
      swap({ timestamp: 240, amount0: "-1", quoteVolumeRaw: "1000" }),
    ];
    const report = runEventStudy({
      occurrences: [
        { startAt: 0, endAt: 90_000, source: "test" },
        { startAt: 900_000, endAt: 900_000, source: "future" },
      ],
      candles: observationsToCandles(observations, { intervalMs: MINUTE }),
      intervalMs: MINUTE,
      horizonBars: 3,
      entryBasis: "first_closed_bar_after_event",
      now: 600_000,
    });
    const result = attachGraphStudyFeatures(report, observations, 6);
    expect(result.rows[0]?.truncated).toBe(true);
    expect(result.rows[0]?.netFlowMicros).toBe("10");
    expect(result.rows[0]?.graphTradeCount).toBe(1);
    expect(result.rows[1]?.netFlowMicros).toBeUndefined();
  });

  it("orders same-second swaps by log index for candle open and close", () => {
    const first = { ...swap({ timestamp: 60, priceQuotePerBaseMicros: 1_000_000 }), logIndex: 1 };
    const last = { ...swap({ timestamp: 60, priceQuotePerBaseMicros: 3_000_000 }), logIndex: 2 };
    const candles = observationsToCandles([last, first], { intervalMs: MINUTE });
    expect(candles[0]?.open).toBe(1);
    expect(candles[0]?.close).toBe(3);
  });
});
