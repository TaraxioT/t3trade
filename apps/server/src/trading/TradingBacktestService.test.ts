/**
 * The archive read behind `trading_backtest`.
 *
 * The engine's own arithmetic is pinned in `backtest.test.ts`. What is pinned
 * here is everything that only exists because the archive is real: the window
 * the user asked for against the window that was recorded, the refusals, and
 * the crossing cost being measured off recorded books rather than assumed
 * whenever it can be.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { BACKTEST_FALLBACK_SLIPPAGE_BPS_PER_SIDE } from "@t3tools/trading-contracts/backtest";
import type { TradingThesis } from "@t3tools/trading-contracts/thesis";

import type { CandleRow } from "./archive/candles.ts";
import {
  coarserIntervals,
  halfSpreadBps,
  makeTradingBacktestService,
} from "./TradingBacktestService.ts";
import type { TradingMarketArchiveShape } from "./TradingMarketArchive.ts";

const MINUTE = 60_000;
const NOW = 1_800_000_000_000;

const row = (index: number, base: number, high: number, low: number, close: number): CandleRow => ({
  coin: "ETH",
  interval: "5m",
  t: NOW - (200 - index) * 5 * MINUTE,
  tClose: NOW - (200 - index) * 5 * MINUTE + 5 * MINUTE - 1,
  o: base,
  h: high,
  l: low,
  c: close,
  v: 10,
  n: 5,
});

/** A repeating cross of 100, the same shape the engine's fixtures use. */
const archivedBars = (count: number): ReadonlyArray<CandleRow> =>
  Array.from({ length: count }, (_, i) => {
    switch (i % 4) {
      case 0:
        return row(i, 99, 99.5, 98.5, 99);
      case 1:
        return row(i, 99, 101.5, 99, 101);
      case 2:
        return row(i, 101, 103, 100.5, 102);
      default:
        return row(i, 102, 102, 97.5, 98);
    }
  });

const stubArchive = (overrides: Partial<TradingMarketArchiveShape>): TradingMarketArchiveShape =>
  ({
    coverage: () => Effect.succeed({ recordingSince: NOW - 90 * 24 * 60 * MINUTE, gaps: [] }),
    candlesInWindow: () => Effect.succeed(archivedBars(100)),
    fundingInWindow: () => Effect.succeed([]),
    bookHistory: () => Effect.succeed({ status: "unavailable", reason: "no rows" }),
    ...overrides,
  }) as TradingMarketArchiveShape;

const thesis: TradingThesis = {
  market: "ETH",
  interval: "5m",
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
  exits: { stop: { basis: "percent", value: 1 }, target: { basis: "percent", value: 1 } },
};

const run = (
  archive: TradingMarketArchiveShape,
  input?: {
    readonly lookbackDays?: number;
    readonly sweep?: { readonly path: string; readonly values: ReadonlyArray<number> };
  },
) =>
  makeTradingBacktestService(archive).run({
    thesis,
    now: NOW,
    ...(input?.lookbackDays === undefined ? {} : { lookbackDays: input.lookbackDays }),
    ...(input?.sweep === undefined ? {} : { sweep: input.sweep }),
  });

describe("TradingBacktestService", () => {
  it.effect("walks the archived bars and reports what it served", () =>
    Effect.gen(function* () {
      const outcome = yield* run(stubArchive({}));
      expect(outcome.status).toBe("ok");
      if (outcome.status !== "ok") return;

      expect(outcome.report.stats.tradesTaken).toBe(25);
      expect(outcome.report.verdict).toBe("positive_after_fees");
      expect(outcome.report.coverage.barsServed).toBe(100);
      expect(outcome.report.coverage.servedFromT).toBe(archivedBars(100)[0]?.t);
      // No funding rows were served, and the report says so rather than
      // letting a zero read as "funding cost nothing".
      expect(outcome.report.coverage.fundingServed).toBe(false);
    }),
  );

  it.effect("refuses a thesis the engine cannot run, in the validator's own words", () =>
    Effect.gen(function* () {
      const outcome = yield* makeTradingBacktestService(stubArchive({})).run({
        thesis: { ...thesis, exits: {} },
        now: NOW,
      });
      expect(outcome.status).toBe("refused");
      if (outcome.status !== "refused") return;
      expect(outcome.reason).toBe("thesis_invalid");
      expect(outcome.detail).toContain("cannot be scored");
    }),
  );

  it.effect("refuses a window past the bar cap and names a coarser interval", () =>
    Effect.gen(function* () {
      const outcome = yield* makeTradingBacktestService(stubArchive({})).run({
        thesis: { ...thesis, interval: "1m" },
        // A year of one-minute bars.
        lookbackDays: 365,
        now: NOW,
      });
      expect(outcome.status).toBe("refused");
      if (outcome.status !== "refused") return;
      expect(outcome.reason).toBe("window_too_large");
      expect(outcome.detail).toContain("3m");
    }),
  );

  it.effect("refuses an empty archive by saying how far back recording reaches", () =>
    Effect.gen(function* () {
      const outcome = yield* run(stubArchive({ candlesInWindow: () => Effect.succeed([]) }));
      expect(outcome.status).toBe("refused");
      if (outcome.status !== "refused") return;
      expect(outcome.reason).toBe("no_archived_bars");
      expect(outcome.detail).toContain("90 days");
    }),
  );

  it.effect("prices the crossing off recorded books when the archive has them", () =>
    Effect.gen(function* () {
      const outcome = yield* run(
        stubArchive({
          bookHistory: () =>
            Effect.succeed({
              status: "ok",
              count: 3,
              // A 0.02 spread on a 100 mid is 1 bp of half-spread.
              rows: [
                { bidPx: 99.99, askPx: 100.01 },
                { bidPx: 99.99, askPx: 100.01 },
                { bidPx: 99.99, askPx: 100.01 },
              ],
            } as never),
        }),
      );
      expect(outcome.status).toBe("ok");
      if (outcome.status !== "ok") return;
      expect(outcome.report.costs.slippageSource).toBe("archived_book");
      expect(outcome.report.costs.slippageBpsPerSide).toBeCloseTo(1, 6);
    }),
  );

  it.effect("says `assumed` when there is no book to measure, never a silent default", () =>
    Effect.gen(function* () {
      const outcome = yield* run(stubArchive({}));
      expect(outcome.status).toBe("ok");
      if (outcome.status !== "ok") return;
      expect(outcome.report.costs.slippageSource).toBe("assumed");
      expect(outcome.report.costs.slippageBpsPerSide).toBe(BACKTEST_FALLBACK_SLIPPAGE_BPS_PER_SIDE);
    }),
  );
});

describe("halfSpreadBps", () => {
  it("takes the median, so one wide print does not price the whole run", () => {
    const rows = [
      { bidPx: 99.99, askPx: 100.01 },
      { bidPx: 99.99, askPx: 100.01 },
      { bidPx: 90, askPx: 110 },
    ];
    expect(halfSpreadBps(rows)).toBeCloseTo(1, 6);
  });

  it("is null when nothing was recorded, so the caller can say `assumed`", () => {
    expect(halfSpreadBps([])).toBeNull();
    expect(halfSpreadBps([{ bidPx: 0, askPx: 0 }])).toBeNull();
  });
});

describe("coarserIntervals", () => {
  it("names the archive's own next intervals up, for the refusal to suggest", () => {
    expect(coarserIntervals("1m")).toEqual(["3m", "5m"]);
    expect(coarserIntervals("4h")).toEqual(["1d"]);
    expect(coarserIntervals("1d")).toEqual([]);
  });
});

describe("sweeping a parameter", () => {
  /** An archive that counts what was asked of it. */
  const countingArchive = () => {
    const reads = { candles: 0, funding: 0 };
    return {
      reads,
      archive: stubArchive({
        candlesInWindow: () => {
          reads.candles += 1;
          return Effect.succeed(archivedBars(100));
        },
        fundingInWindow: () => {
          reads.funding += 1;
          return Effect.succeed([]);
        },
      }),
    };
  };

  it.effect("reads the window once however many values it walks", () =>
    Effect.gen(function* () {
      // The whole performance argument for the feature. Six variations used to
      // be six calls and six archive reads; here they are one of each.
      const { archive, reads } = countingArchive();
      const outcome = yield* run(archive, {
        sweep: { path: "exits.target.value", values: [0.5, 1, 1.5, 2, 2.5, 3] },
      });
      expect(outcome.status).toBe("ok");
      if (outcome.status !== "ok") return;

      expect(reads.candles, "one candle read for the whole sweep").toBe(1);
      expect(reads.funding, "one funding read for the whole sweep").toBe(1);
      expect(outcome.sweep?.rows).toHaveLength(6);
      expect(outcome.sweepRuns).toHaveLength(6);
    }),
  );

  it.effect("answers the base thesis as well as the table", () =>
    Effect.gen(function* () {
      const outcome = yield* run(stubArchive({}), {
        sweep: { path: "exits.target.value", values: [1, 2] },
      });
      expect(outcome.status).toBe("ok");
      if (outcome.status !== "ok") return;
      // The submitted thesis is still run: the table is read against it.
      expect(outcome.report.thesis.exits.target).toEqual({ basis: "percent", value: 1 });
      expect(outcome.sweep?.thesis.exits.target).toEqual({ basis: "percent", value: 1 });
    }),
  );

  it.effect("refuses a bad sweep before it reads a single bar", () =>
    Effect.gen(function* () {
      const { archive, reads } = countingArchive();
      const outcome = yield* run(archive, {
        sweep: { path: "thesis.side", values: [1, 2] },
      });
      expect(outcome.status).toBe("refused");
      if (outcome.status !== "refused") return;
      expect(outcome.reason).toBe("sweep_invalid");
      expect(outcome.detail).toContain("is not a parameter a sweep can move");
      expect(reads.candles, "a refused sweep costs no archive read").toBe(0);
    }),
  );

  it.effect("refuses a thirteenth value", () =>
    Effect.gen(function* () {
      const outcome = yield* run(stubArchive({}), {
        sweep: {
          path: "exits.target.value",
          values: Array.from({ length: 13 }, (_, i) => (i + 1) / 2),
        },
      });
      expect(outcome.status).toBe("refused");
      if (outcome.status !== "refused") return;
      expect(outcome.detail).toContain("13 values");
    }),
  );
});

describe("a funding rule on an unfunded market", () => {
  const fundingThesis: TradingThesis = {
    ...thesis,
    entry: {
      predicates: [
        {
          left: { source: "metric", metric: "funding_rate_8h" },
          comparator: "below",
          right: { source: "constant", value: 0 },
        },
      ],
    },
  };

  it.effect("refuses rather than reporting zero trades", () =>
    Effect.gen(function* () {
      // Zero trades would read as "the idea does not work". It was never
      // testable here, and the refusal is the honest answer.
      const outcome = yield* makeTradingBacktestService(stubArchive({})).run({
        thesis: fundingThesis,
        now: NOW,
      });
      expect(outcome.status).toBe("refused");
      if (outcome.status !== "refused") return;
      expect(outcome.reason).toBe("thesis_invalid");
      expect(outcome.detail).toContain("no funding history for ETH");
    }),
  );

  it.effect("runs it when the archive does fund the market", () =>
    Effect.gen(function* () {
      const outcome = yield* makeTradingBacktestService(
        stubArchive({
          fundingInWindow: () =>
            Effect.succeed(
              Array.from({ length: 20 }, (_, i) => ({
                coin: "ETH",
                time: NOW - (20 - i) * 60 * MINUTE,
                fundingRate: -0.00001,
                premium: 0,
              })),
            ),
        }),
      ).run({ thesis: fundingThesis, now: NOW });
      expect(outcome.status).toBe("ok");
      if (outcome.status !== "ok") return;
      expect(outcome.report.coverage.fundingServed).toBe(true);
    }),
  );
});
