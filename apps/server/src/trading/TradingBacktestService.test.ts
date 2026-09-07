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
import { providerReachFloor } from "./archive/hydration.ts";
import {
  coarserIntervals,
  halfSpreadBps,
  makeTradingBacktestService,
} from "./TradingBacktestService.ts";
import type { TradingEventServiceShape } from "./TradingEventService.ts";
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
    ensureCoverage: () =>
      Effect.succeed({
        outcome: "already_covered",
        coverage: { recordingSince: NOW - 90 * 24 * 60 * MINUTE, gaps: [] },
        reason: null,
      }),
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

/** The calendar, stubbed: the service only reads it, never writes it. */
const stubEvents = (
  activeIds: ReadonlyArray<string> = ["set-devcon"],
  occurrences: ReadonlyArray<{ readonly eventSetId: string; readonly endAt: number }> = [],
): TradingEventServiceShape =>
  ({
    activeSetIds: () => Effect.succeed([...activeIds]),
    knownSetIds: () => Effect.succeed([...activeIds]),
    occurrencesFor: () => Effect.succeed([...occurrences]),
    upcomingFor: () => Effect.succeed([]),
  }) as unknown as TradingEventServiceShape;

const run = (
  archive: TradingMarketArchiveShape,
  input?: {
    readonly lookbackDays?: number;
    readonly sweep?: { readonly path: string; readonly values: ReadonlyArray<number> };
  },
) =>
  makeTradingBacktestService(archive, stubEvents()).run({
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
      const outcome = yield* makeTradingBacktestService(stubArchive({}), stubEvents()).run({
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
      const outcome = yield* makeTradingBacktestService(stubArchive({}), stubEvents()).run({
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

describe("on-demand hydration window", () => {
  const coverage = { recordingSince: NOW - 90 * 24 * 60 * MINUTE, gaps: [] };
  /** An archive that records what hydration was asked to recover. */
  const recordingArchive = () => {
    const asked: Array<{ fromT: number; toT: number; purpose: string; interval: string }> = [];
    return {
      asked,
      archive: stubArchive({
        ensureCoverage: (input) => {
          asked.push({
            fromT: input.fromT,
            toT: input.toT,
            purpose: input.purpose,
            interval: input.interval,
          });
          return Effect.succeed({ outcome: "already_covered", coverage, reason: null });
        },
      }),
    };
  };

  it.effect("a declared lookback hydrates exactly that window", () =>
    Effect.gen(function* () {
      const { archive, asked } = recordingArchive();
      const outcome = yield* run(archive, { lookbackDays: 30 });
      expect(outcome.status).toBe("ok");
      expect(asked).toEqual([
        { fromT: NOW - 30 * 24 * 60 * MINUTE, toT: NOW, purpose: "backtest", interval: "5m" },
      ]);
    }),
  );

  it.effect(
    "without a lookback, hydrates from the provider's recoverable reach — never the epoch",
    () =>
      Effect.gen(function* () {
        const { archive, asked } = recordingArchive();
        const outcome = yield* run(archive);
        expect(outcome.status).toBe("ok");
        expect(asked).toHaveLength(1);
        // One servable window back on the declared interval, not Unix epoch to
        // now: an impossible request the queue would rightly refuse.
        expect(asked[0]?.toT).toBe(NOW);
        expect(asked[0]?.fromT).toBe(providerReachFloor("5m", NOW));
        expect(asked[0]?.fromT).toBeGreaterThan(0);
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
      const outcome = yield* makeTradingBacktestService(stubArchive({}), stubEvents()).run({
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
        stubEvents(),
      ).run({ thesis: fundingThesis, now: NOW });
      expect(outcome.status).toBe("ok");
      if (outcome.status !== "ok") return;
      expect(outcome.report.coverage.fundingServed).toBe(true);
    }),
  );
});

describe("an event-anchored thesis", () => {
  // Bars of 5m. The event ends one millisecond into bar 50, so the operand
  // reads distance 0 on bar 51, 1 on 52, 2 on 53, and nothing anywhere else:
  // `below 3` holds on exactly 51, 52 and 53.
  const bars = archivedBars(100).map((candle, index) => ({
    ...candle,
    c: index >= 51 && index <= 53 ? 200 : 100,
  }));
  const endAt = (bars[50]?.t ?? 0) + 1;
  const anchored: TradingThesis = {
    ...thesis,
    entry: {
      predicates: [
        {
          left: { source: "event", eventSetId: "set-devcon", label: "Devcon" },
          comparator: "below",
          right: { source: "constant", value: 3 },
        },
      ],
    },
  };
  const handBuilt: TradingThesis = {
    ...thesis,
    entry: {
      predicates: [
        {
          left: { source: "price" },
          comparator: "above",
          right: { source: "constant", value: 150 },
        },
      ],
    },
  };
  const archive = stubArchive({ candlesInWindow: () => Effect.succeed(bars) });
  const events = stubEvents(["set-devcon"], [{ eventSetId: "set-devcon", endAt }]);

  it.effect("produces the same trades as the equivalent hand-built condition", () =>
    Effect.gen(function* () {
      const fromEvent = yield* makeTradingBacktestService(archive, events).run({
        thesis: anchored,
        now: NOW,
      });
      const fromPrice = yield* makeTradingBacktestService(archive, stubEvents()).run({
        thesis: handBuilt,
        now: NOW,
      });
      expect(fromEvent.status).toBe("ok");
      expect(fromPrice.status).toBe("ok");
      if (fromEvent.status !== "ok" || fromPrice.status !== "ok") return;

      expect(fromEvent.report.stats).toEqual(fromPrice.report.stats);
      expect(fromEvent.report.stats.tradesTaken).toBeGreaterThan(0);
    }),
  );

  it.effect("refuses an unknown set before any candle is read", () =>
    Effect.gen(function* () {
      let reads = 0;
      const counted = stubArchive({
        candlesInWindow: () => {
          reads += 1;
          return Effect.succeed(bars);
        },
      });
      const outcome = yield* makeTradingBacktestService(counted, stubEvents([], [])).run({
        thesis: anchored,
        now: NOW,
      });
      expect(outcome.status).toBe("refused");
      if (outcome.status !== "refused") return;
      expect(outcome.reason).toBe("thesis_invalid");
      expect(outcome.detail).toContain("Devcon");
      expect(outcome.detail).toContain("no active event set");
      expect(reads, "the refusal must cost no archive read").toBe(0);
    }),
  );
});

// -- forming bars and the funding settlement bound ------------------------------
//
// The archiver can store a bar that has not closed yet. A run cut off mid-bar
// must not trade on it: no entry on its numbers, no exit inside it, no
// window-end liquidation priced off a close that does not exist. And because
// exits settle at CLOSE times while `servedToT` reports the last bar's open,
// the funding read has to reach the final close or the last bar's own hours
// are silently free.

describe("forming bars never reach the engine", () => {
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
  // NOW sits one hour inside b3, so b3 is forming (closeTime > NOW) while
  // every bar before it has closed.
  const T0 = NOW - 3 * DAY - HOUR;

  const dailyBar = (t: number, o: number, h: number, l: number, c: number): CandleRow => ({
    coin: "ETH",
    interval: "1d",
    t,
    tClose: t + DAY - 1,
    o,
    h,
    l,
    c,
    v: 10,
    n: 5,
  });

  // b0 closes below 100; b1's close crosses above it, so the entry fills at
  // b2's open (101). b2's high/low never touch the 1% bracket (99.99/102.01),
  // so the trade runs to a window-end exit at b2's close. The forming b3 has
  // a low of 49: served, it would stop the trade out inside itself.
  const closedBars = (): ReadonlyArray<CandleRow> => [
    dailyBar(T0, 99, 99.5, 98.5, 99),
    dailyBar(T0 + DAY, 99, 101.5, 99, 101),
    dailyBar(T0 + 2 * DAY, 101, 102, 100, 101),
  ];
  const formingBar = (): CandleRow => dailyBar(T0 + 3 * DAY, 101, 101, 49, 50);

  const dailyThesis: TradingThesis = { ...thesis, interval: "1d" };

  it.effect("excludes the forming final bar: no entry, exit, or liquidation happens on it", () =>
    Effect.gen(function* () {
      const outcome = yield* makeTradingBacktestService(
        stubArchive({
          candlesInWindow: () => Effect.succeed([...closedBars(), formingBar()]),
        }),
        stubEvents(),
      ).run({ thesis: dailyThesis, lookbackDays: 7, notionalUsd: 1_000, now: NOW });
      expect(outcome.status).toBe("ok");
      if (outcome.status !== "ok") return;

      expect(outcome.report.coverage.barsServed).toBe(3);
      // The last bar actually served is b2 — an OPEN time of a CLOSED bar,
      // never the forming bar behind it.
      expect(outcome.report.coverage.servedToT).toBe(T0 + 2 * DAY);
      expect(outcome.trades).toHaveLength(1);
      // Had the forming bar leaked in, its low of 49 stops this trade out
      // inside it instead.
      expect(outcome.trades[0]?.exitReason).toBe("window_end");
      expect(outcome.trades[0]?.exitTime).toBe(T0 + 3 * DAY - 1);
      expect(outcome.trades[0]?.exitPrice).toBe(101);
    }),
  );

  it.effect("bounds the run cutoff to closed bars, close time inclusive", () =>
    Effect.gen(function* () {
      const bars = [...closedBars(), formingBar()];
      const service = makeTradingBacktestService(
        stubArchive({ candlesInWindow: () => Effect.succeed(bars) }),
        stubEvents(),
      );

      // Exactly at b2's close time: b2 has closed, so it is servable.
      const atClose = yield* service.run({
        thesis: dailyThesis,
        lookbackDays: 7,
        now: T0 + 3 * DAY - 1,
      });
      expect(atClose.status).toBe("ok");
      if (atClose.status === "ok") expect(atClose.report.coverage.barsServed).toBe(3);

      // One millisecond earlier b2 is forming: only b0 and b1 are servable,
      // and a signal on the new last bar has no next bar to fill at.
      const beforeClose = yield* service.run({
        thesis: dailyThesis,
        lookbackDays: 7,
        now: T0 + 3 * DAY - 2,
      });
      expect(beforeClose.status).toBe("ok");
      if (beforeClose.status !== "ok") return;
      expect(beforeClose.report.coverage.barsServed).toBe(2);
      expect(beforeClose.report.stats.tradesTaken).toBe(0);
    }),
  );

  it.effect("reports requested against served bounds over closed bars only", () =>
    Effect.gen(function* () {
      const outcome = yield* makeTradingBacktestService(
        stubArchive({
          candlesInWindow: () => Effect.succeed([...closedBars(), formingBar()]),
        }),
        stubEvents(),
      ).run({ thesis: dailyThesis, lookbackDays: 7, now: NOW });
      expect(outcome.status).toBe("ok");
      if (outcome.status !== "ok") return;

      // The forming bar's open (T0 + 3d) is inside the REQUESTED window, and
      // the served bounds say so was not served: servedToT is b2's open.
      expect(outcome.report.coverage.requestedFromT).toBe(NOW - 7 * DAY);
      expect(outcome.report.coverage.requestedToT).toBe(NOW);
      expect(outcome.report.coverage.servedFromT).toBe(T0);
      expect(outcome.report.coverage.servedToT).toBe(T0 + 2 * DAY);
      expect(outcome.report.coverage.barsServed).toBe(3);
    }),
  );
});

describe("funding through the final close", () => {
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
  const T0 = NOW - 3 * DAY - HOUR;

  const dailyBar = (t: number, o: number, h: number, l: number, c: number): CandleRow => ({
    coin: "ETH",
    interval: "1d",
    t,
    tClose: t + DAY - 1,
    o,
    h,
    l,
    c,
    v: 10,
    n: 5,
  });
  const closedBars = (): ReadonlyArray<CandleRow> => [
    dailyBar(T0, 99, 99.5, 98.5, 99),
    dailyBar(T0 + DAY, 99, 101.5, 99, 101),
    dailyBar(T0 + 2 * DAY, 101, 102, 100, 101),
  ];

  /** A funding double that records its query bounds and filters like the real read. */
  const fundingArchive = (
    rows: ReadonlyArray<{ readonly time: number; readonly fundingRate: number }>,
  ) => {
    const calls: Array<{ readonly fromT: number; readonly toT: number }> = [];
    return {
      calls,
      archive: stubArchive({
        candlesInWindow: () => Effect.succeed(closedBars()),
        fundingInWindow: (input: { readonly fromT: number; readonly toT: number }) => {
          calls.push({ fromT: input.fromT, toT: input.toT });
          return Effect.succeed(
            rows
              .filter((row) => row.time >= input.fromT && row.time <= input.toT)
              .map((row) => ({
                coin: "ETH",
                time: row.time,
                fundingRate: row.fundingRate,
                premium: 0,
              })),
          );
        },
      }),
    };
  };

  it.effect("charges hourly funding stamped after the final candle's open through its close", () =>
    Effect.gen(function* () {
      // Hourly rows across the whole window, plus one stamped exactly at the
      // final candle's close time.
      const rows = [
        ...Array.from({ length: 76 }, (_, k) => ({ time: T0 + k * HOUR, fundingRate: 0.0005 })),
        { time: T0 + 3 * DAY - 1, fundingRate: 0.0005 },
      ];
      const { archive, calls } = fundingArchive(rows);
      const outcome = yield* makeTradingBacktestService(archive, stubEvents()).run({
        thesis: { ...thesis, interval: "1d" },
        lookbackDays: 7,
        notionalUsd: 1_000,
        now: NOW,
      });
      expect(outcome.status).toBe("ok");
      if (outcome.status !== "ok") return;

      // Hand-derived: the entry fills at b2's open (T0 + 2d) and exits at its
      // close (T0 + 3d - 1). The rows in (entry, exit] are the 23 hourly
      // stamps T0+49h..T0+71h plus the boundary row at the exit stamp itself:
      // 24 rows x 0.0005 = 0.012 hourly rate. A long PAYS a positive rate,
      // so -0.012 x 1000 = -12.00.
      expect(outcome.trades[0]?.fundingUsd).toBe(-12);
      // The funding query reached the final close, not the final open: an
      // open-time bound serves only rows through T0+48h and charges nothing.
      expect(calls).toEqual([{ fromT: T0, toT: T0 + 3 * DAY - 1 }]);
    }),
  );

  it.effect("charges exactly (entry, exit]: the entry stamp is never double-billed", () =>
    Effect.gen(function* () {
      // One row at the entry instant, one at the exit instant. Only the exit
      // stamp is inside (entry, exit]: 0.002 x 1000 = 2.00, paid by a long.
      const { archive } = fundingArchive([
        { time: T0 + 2 * DAY, fundingRate: 0.001 },
        { time: T0 + 3 * DAY - 1, fundingRate: 0.002 },
      ]);
      const outcome = yield* makeTradingBacktestService(archive, stubEvents()).run({
        thesis: { ...thesis, interval: "1d" },
        lookbackDays: 7,
        notionalUsd: 1_000,
        now: NOW,
      });
      expect(outcome.status).toBe("ok");
      if (outcome.status !== "ok") return;
      // Charging the entry stamp too would read -3; charging neither, 0.
      expect(outcome.trades[0]?.fundingUsd).toBe(-2);
    }),
  );

  it.effect("flips the funding sign with the side: a short is paid what a long pays", () =>
    Effect.gen(function* () {
      const { archive } = fundingArchive([
        { time: T0 + 2 * DAY, fundingRate: 0.001 },
        { time: T0 + 3 * DAY - 1, fundingRate: 0.002 },
      ]);
      const outcome = yield* makeTradingBacktestService(archive, stubEvents()).run({
        thesis: { ...thesis, interval: "1d", side: "short" },
        lookbackDays: 7,
        notionalUsd: 1_000,
        now: NOW,
      });
      expect(outcome.status).toBe("ok");
      if (outcome.status !== "ok") return;
      expect(outcome.trades[0]?.fundingUsd).toBe(2);
    }),
  );
});
