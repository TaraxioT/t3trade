/**
 * TradingBacktestService — the archive read behind `trading_backtest`.
 *
 * The arithmetic is in `@t3tools/trading-contracts/backtest` and is pure. What
 * lives here is everything that needs the machine: resolving the window the
 * user asked for against the window the archive actually holds, refusing a run
 * too large to walk, pricing the crossing cost off recorded books rather than
 * off an assumption, and reporting all of it back so the numbers are read with
 * their provenance attached.
 *
 * Read-only, and structurally so: every call goes through
 * {@link TradingMarketArchive}, which opens the archive file read-only, and
 * the event calendar service, which this reads but never writes. There is no
 * path from here to an order, a position, or a mission's state. That is
 * not a convention to be careful about — it is the absence of a dependency.
 *
 * ## Why there is no queue behind this
 *
 * The brief asked for a reactor-and-receipt path for runs that overrun a
 * synchronous budget. Measured, the engine walks 60,000 bars — the cap, and
 * well past a month of one-minute bars — in about 19 ms, because every
 * indicator is computed once as a series and the bar loop indexes into it.
 * With the SQLite read on top, a run at the cap is still comfortably inside
 * {@link BACKTEST_SYNC_BUDGET_MILLIS}. A queue would therefore be a branch
 * that could not be taken and a receipt nobody would ever wait on, which is
 * machinery for its own sake. What is here instead is the measurement: every
 * run reports `elapsedMillis`, and a run that does breach the budget says so
 * in its coverage notes, so the assumption is checked continuously rather than
 * trusted. If that ever fires in the wild, the queue is the fix and the
 * evidence for it will already be recorded.
 *
 * @module TradingBacktestService
 */
import { Context, Effect } from "effect";
import * as Clock from "effect/Clock";
import * as Layer from "effect/Layer";

import {
  BACKTEST_FALLBACK_SLIPPAGE_BPS_PER_SIDE,
  BACKTEST_TAKER_FEE_BPS_PER_SIDE,
  BACKTEST_MAX_BARS,
  checkBacktestBarBudget,
  checkBacktestSweep,
  runBacktest,
  runBacktestSweep,
  type BacktestCosts,
  type BacktestReport,
  type BacktestSweep,
  type BacktestSweepReport,
} from "@t3tools/trading-contracts/backtest";
import type { MarketCandle } from "@t3tools/trading-contracts/market";
import {
  validateThesis,
  thesisEventSets,
  type TradingThesis,
} from "@t3tools/trading-contracts/thesis";

import { ARCHIVE_INTERVALS, INTERVAL_MS, type ArchiveInterval } from "./archive/config.ts";
import type { CandleRow } from "./archive/candles.ts";
import { TradingEventService, type TradingEventServiceShape } from "./TradingEventService.ts";
import { TradingMarketArchive } from "./TradingMarketArchive.ts";

/**
 * How long a run may take before it is worth saying something about.
 *
 * Not a timeout — nothing is cancelled at it. It is the assumption the
 * synchronous design rests on, written down where a breach becomes visible in
 * the served report rather than in nobody's log.
 */
export const BACKTEST_SYNC_BUDGET_MILLIS = 2_000;

/** How many recorded book samples the crossing cost is measured over. */
const SLIPPAGE_SAMPLE_ROWS = 200;

/** A run that could not be set up. `detail` is what the model is told. */
export interface BacktestRefusal {
  readonly status: "refused";
  readonly reason:
    | "thesis_invalid"
    | "interval_not_archived"
    | "window_too_large"
    | "no_archived_bars"
    /** The `vary` clause names a parameter, a value count or a budget it cannot have. */
    | "sweep_invalid";
  readonly detail: string;
}

export interface BacktestOk {
  readonly status: "ok";
  /**
   * The run of the thesis as submitted. Present with or without a sweep: a
   * swept call still answers "and what does the idea itself do", which is the
   * baseline every row in the table is read against.
   */
  readonly report: BacktestReport;
  /** Set when the call named `vary`. */
  readonly sweep?: BacktestSweepReport;
  /** Every variation's own run, for the caller that persists them. */
  readonly sweepRuns?: ReadonlyArray<{ readonly value: number; readonly report: BacktestReport }>;
  /** Values the grammar would not take, each with its reason. */
  readonly sweepRefusals?: ReadonlyArray<{ readonly value: number; readonly reason: string }>;
  readonly elapsedMillis: number;
}

export type BacktestOutcome = BacktestOk | BacktestRefusal;

export interface TradingBacktestServiceShape {
  readonly run: (input: {
    readonly thesis: TradingThesis;
    readonly lookbackDays?: number | undefined;
    readonly notionalUsd?: number | undefined;
    readonly now: number;
    /** Run the same window once per value of one parameter. */
    readonly sweep?: BacktestSweep | undefined;
  }) => Effect.Effect<BacktestOutcome>;
}

export class TradingBacktestService extends Context.Service<
  TradingBacktestService,
  TradingBacktestServiceShape
>()("t3/trading/TradingBacktestService") {}

const DAY_MS = 24 * 60 * 60 * 1_000;

/** The archive's own intervals, coarser than the one asked for. */
export const coarserIntervals = (interval: string): ReadonlyArray<string> => {
  const width = INTERVAL_MS[interval as ArchiveInterval];
  if (width === undefined) return [];
  return ARCHIVE_INTERVALS.filter((candidate) => INTERVAL_MS[candidate] > width).slice(0, 2);
};

/** The archive's row shape, in the shape the pure engine reads. */
export const toCandle = (row: CandleRow): MarketCandle =>
  ({
    openTime: row.t,
    closeTime: row.tClose,
    open: row.o,
    high: row.h,
    low: row.l,
    close: row.c,
    volume: row.v,
    trades: row.n,
  }) as MarketCandle;

/**
 * The crossing cost, in bps of one side, measured rather than assumed where it
 * can be.
 *
 * The archive samples the top of book once a minute, so the median half-spread
 * over those samples is what crossing actually cost on this market. The median
 * rather than the mean because one wide print during a halt should not price
 * every trade in the run. When no book was recorded the fallback is used and
 * the report says `assumed`, so a number nobody measured never reads as one
 * somebody did.
 */
export const halfSpreadBps = (
  rows: ReadonlyArray<{ readonly bidPx: number; readonly askPx: number }>,
): number | null => {
  const samples = rows
    .map((row) => {
      const mid = (row.bidPx + row.askPx) / 2;
      return mid > 0 && row.askPx >= row.bidPx
        ? ((row.askPx - row.bidPx) / 2 / mid) * 10_000
        : null;
    })
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);
  if (samples.length === 0) return null;
  return samples[Math.floor(samples.length / 2)] ?? null;
};

export const makeTradingBacktestService = (
  archive: Context.Service.Shape<typeof TradingMarketArchive>,
  events: TradingEventServiceShape,
): TradingBacktestServiceShape =>
  TradingBacktestService.of({
    run: ({ thesis, lookbackDays, notionalUsd, now, sweep }) =>
      Effect.gen(function* () {
        // The event calendar first, before any archive read: an anchored
        // thesis whose set is unknown or retired would read undefined on
        // every bar, and that refusal costs nothing to make.
        const anchoredSets = thesisEventSets(thesis);
        // A calendar read cannot fail a run halfway: the service's contract
        // is a synchronous answer, so a broken state store is a defect the
        // boundary surfaces, not a typed refusal the tool reads.
        const knownEventSets =
          anchoredSets.length === 0 ? undefined : yield* events.activeSetIds().pipe(Effect.orDie);
        const invalid = validateThesis(
          thesis,
          knownEventSets === undefined ? {} : { knownEventSets },
        );
        if (invalid !== null) {
          return { status: "refused", reason: "thesis_invalid", detail: invalid } as const;
        }
        const eventOccurrences =
          anchoredSets.length === 0
            ? []
            : yield* events.occurrencesFor(anchoredSets).pipe(Effect.orDie);

        const interval = thesis.interval as ArchiveInterval;
        const width = INTERVAL_MS[interval];
        if (width === undefined) {
          return {
            status: "refused",
            reason: "interval_not_archived",
            detail: `${thesis.interval} is not recorded; the archive holds ${ARCHIVE_INTERVALS.join(", ")}`,
          } as const;
        }

        const coverageProbe = yield* archive.coverage({
          coin: thesis.market,
          interval,
          fromT: 0,
          toT: now,
        });
        // No `lookbackDays` means "everything you have", which is the archive's
        // own first bar — not an arbitrary default that quietly clips history
        // somebody spent weeks recording.
        const requestedFromT =
          lookbackDays === undefined
            ? (coverageProbe.recordingSince ?? now - 30 * DAY_MS)
            : now - lookbackDays * DAY_MS;
        const requestedToT = now;

        const requestedBars = Math.ceil(Math.max(0, requestedToT - requestedFromT) / width);
        const tooLarge = checkBacktestBarBudget({
          interval,
          bars: requestedBars,
          coarser: coarserIntervals(interval),
        });
        if (tooLarge !== null) {
          return { status: "refused", reason: "window_too_large", detail: tooLarge } as const;
        }

        // Before the archive read, not after: a sweep refused for its path or
        // its value count should cost nothing, and the bar budget is a
        // statement about work not yet done.
        if (sweep !== undefined) {
          const badSweep = checkBacktestSweep({
            sweep,
            thesis,
            bars: Math.min(requestedBars, BACKTEST_MAX_BARS),
          });
          if (badSweep !== null) {
            return { status: "refused", reason: "sweep_invalid", detail: badSweep } as const;
          }
        }

        const startedAt = yield* Clock.currentTimeMillis;
        const rows = yield* archive.candlesInWindow({
          coin: thesis.market,
          interval,
          fromT: requestedFromT,
          toT: requestedToT,
          maxBars: BACKTEST_MAX_BARS,
        });
        if (rows.length === 0) {
          return {
            status: "refused",
            reason: "no_archived_bars",
            detail:
              `the archive holds no ${interval} bars for ${thesis.market} in that window` +
              (coverageProbe.recordingSince === null
                ? " (nothing is recorded for this market at all)"
                : ` (recording reaches back ${Math.round((now - coverageProbe.recordingSince) / DAY_MS)} days)`),
          } as const;
        }

        const candles = rows.map(toCandle);
        const servedFromT = candles[0]?.openTime ?? null;
        const servedToT = candles[candles.length - 1]?.openTime ?? null;

        const coverageDetail = yield* archive.coverage({
          coin: thesis.market,
          interval,
          fromT: servedFromT ?? requestedFromT,
          toT: servedToT ?? requestedToT,
        });
        const funding = yield* archive.fundingInWindow({
          coin: thesis.market,
          fromT: servedFromT ?? requestedFromT,
          toT: servedToT ?? requestedToT,
        });

        // The grammar passed above; this is the same check re-asked now that
        // the archive has answered whether it funds this market at all. A
        // funding rule with no funding history would read nothing on every bar
        // and report zero trades, which the user would read as "the idea does
        // not work" rather than "the data was never there".
        const unfunded = validateThesis(thesis, { fundingArchived: funding.length > 0 });
        if (unfunded !== null) {
          return { status: "refused", reason: "thesis_invalid", detail: unfunded } as const;
        }

        const book = yield* archive.bookHistory({
          coin: thesis.market,
          n: SLIPPAGE_SAMPLE_ROWS,
        });
        const measured = book.status === "ok" ? halfSpreadBps(book.rows) : null;
        const costs: BacktestCosts = {
          takerFeeBpsPerSide: BACKTEST_TAKER_FEE_BPS_PER_SIDE,
          slippageBpsPerSide: measured ?? BACKTEST_FALLBACK_SLIPPAGE_BPS_PER_SIDE,
          slippageSource: measured === null ? "assumed" : "archived_book",
        };

        const coverage = {
          requestedFromT,
          requestedToT,
          servedFromT,
          servedToT,
          barsServed: candles.length,
          gaps: coverageDetail.gaps,
          recordingSince: coverageDetail.recordingSince,
          fundingServed: funding.length > 0,
        };
        const runInput = {
          candles,
          funding,
          eventOccurrences,
          costs,
          coverage,
          ...(notionalUsd === undefined ? {} : { notionalUsd }),
        };

        const { report } = runBacktest({ thesis, ...runInput });

        // One archive read above, every variation below. The candles and the
        // funding rows are handed to the sweep whole rather than re-fetched
        // per value, which is the entire reason a sweep is one call.
        const swept = sweep === undefined ? null : runBacktestSweep({ thesis, sweep, ...runInput });

        return {
          status: "ok",
          report,
          ...(swept === null
            ? {}
            : {
                sweep: swept.report,
                sweepRuns: swept.runs.map(({ value, run }) => ({ value, report: run.report })),
                sweepRefusals: swept.refusals,
              }),
          elapsedMillis: (yield* Clock.currentTimeMillis) - startedAt,
        } as const;
      }),
  });

export const TradingBacktestServiceLive: Layer.Layer<
  TradingBacktestService,
  never,
  TradingMarketArchive | TradingEventService
> = Layer.effect(
  TradingBacktestService,
  Effect.gen(function* () {
    const archive = yield* TradingMarketArchive;
    const events = yield* TradingEventService;
    return makeTradingBacktestService(archive, events);
  }),
);
