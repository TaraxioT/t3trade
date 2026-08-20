/**
 * TradingMarketArchive — the toolkit's read-only seam over the market archive.
 *
 * Plan 38 §2.4: the archive is a separate SQLite file owned by the archiver,
 * and everything the trading toolkit wants from it — funding history,
 * derivatives contexts, book summaries — crosses here. The archiver is the
 * only writer; this service opens the file read-only, so a reader can never
 * block or corrupt it, and the handle is re-derived per call so an archive
 * that appears after the server booted is picked up without a restart.
 *
 * The one rule this module exists to enforce (§5.3): absence is an answer,
 * never a number. A missing file, an archiver that has not been running, a
 * window with no rows — each returns `{ status: "unavailable", reason }`.
 * Nothing here throws for those states and nothing returns a zero that could
 * be read as a real funding mean of 0.
 *
 * `known_gaps` is recorded only by the candle backfill (archiver.ts,
 * `backfillCandles` writes one row per stretch older than the exchange's
 * servable window, keyed by `(coin, interval)` where interval is a candle
 * interval). Funding, asset contexts, and book summaries have no gap records,
 * so coverage for those series is decided by row counts, not by `known_gaps`.
 *
 * @module TradingMarketArchive
 */
import { Context, Effect } from "effect";
import * as Layer from "effect/Layer";

import { archiveDatabasePath, ARCHIVE_COINS } from "./archive/config.ts";
import type { AssetCtxRow } from "./archive/assetCtx.ts";
import type { BookSummaryRow } from "./archive/bookSummary.ts";
import { openArchiveDatabaseReadOnly, type ArchiveDatabase } from "./archive/db.ts";
import { derivedMetricValue, type DerivedMetricUnavailabilityKind } from "./archive/derived.ts";
import type { FundingRow } from "./archive/funding.ts";

import type { DerivedMetricParams } from "@t3tools/trading-contracts/watch";
import {
  assetCtxAtOrBefore,
  candlesInRange,
  fundingInRange,
  latestAssetContext,
  minFundingTime,
  recentAssetContext,
  recentBookSummary,
  recentFunding,
} from "./archive/read.ts";

/** The answer when the archive cannot serve the question. Never a number. */
export interface ArchiveUnavailable {
  readonly status: "unavailable";
  readonly reason: string;
}

export interface FundingStatsOk {
  readonly status: "ok";
  /** Unweighted mean of the hourly rates inside the window (per-hour rate). */
  readonly mean: number;
  readonly latestRate: number;
  readonly latestTime: number;
  /** Adjacent samples in the window whose signs differ, `sign(0)` its own class. */
  readonly signFlips: number;
  readonly sampleCount: number;
}

export type FundingStatsResult = FundingStatsOk | ArchiveUnavailable;

export interface FundingSeriesOk {
  readonly status: "ok";
  /** Oldest first, matching `candlesInRange`. May be fewer than `n`. */
  readonly rows: ReadonlyArray<FundingRow>;
  readonly count: number;
}

export type FundingSeriesResult = FundingSeriesOk | ArchiveUnavailable;

export interface OiPremiumOk {
  readonly status: "ok";
  /** Oldest first. May be fewer than `n`. */
  readonly rows: ReadonlyArray<AssetCtxRow>;
  readonly count: number;
}

export type OiPremiumResult = OiPremiumOk | ArchiveUnavailable;

export interface BookHistoryOk {
  readonly status: "ok";
  /** Oldest first. May be fewer than `n`. */
  readonly rows: ReadonlyArray<BookSummaryRow>;
  readonly count: number;
}

export type BookHistoryResult = BookHistoryOk | ArchiveUnavailable;

export interface DerivedMetricOk {
  readonly status: "ok";
  readonly value: number;
  /**
   * The second-unit figure `vwap_distance` serves alongside its sigma value:
   * the signed mark-to-VWAP distance in bps. Absent for every other metric.
   */
  readonly bps?: number;
}

/**
 * A derived metric the archive could not serve. `kind` is the refusal the
 * evaluator maps onto: `archive` → derived_needs_archive, `window` →
 * derived_window_unavailable, `context` → an evaluation-time skip.
 */
export interface DerivedMetricUnavailable {
  readonly status: "unavailable";
  readonly kind: DerivedMetricUnavailabilityKind;
  readonly reason: string;
}

export type DerivedMetricResult = DerivedMetricOk | DerivedMetricUnavailable;

/** One coin's half of the `scan` digest. Absent figures are absent, never zero. */
export interface ScanCoinDigest {
  readonly coin: string;
  readonly mark?: number;
  readonly change24hPct?: number;
  readonly realizedVol24hPct?: number;
  readonly fundingNow?: number;
  readonly funding7dMean?: number;
  readonly oiChange24hPct?: number;
  /** What could not be answered and why — present exactly when a figure is absent. */
  readonly unavailable?: string;
}

export type ScanResult =
  | { readonly status: "ok"; readonly coins: ReadonlyArray<ScanCoinDigest> }
  | ArchiveUnavailable;

/** The UTC-day anchored session levels, from archived 5m candles with volume. */
export interface SessionLevelsOk {
  readonly status: "ok";
  readonly priorUtcDay?: { readonly high: number; readonly low: number; readonly close: number };
  readonly currentUtcDay?: { readonly open: number; readonly high: number; readonly low: number };
  readonly vwap?: number;
  /** Which halves are missing and why — absent when all three served. */
  readonly unavailable?: string;
}

export type SessionLevelsResult = SessionLevelsOk | ArchiveUnavailable;

export interface TradingMarketArchiveShape {
  readonly fundingStats: (input: {
    readonly coin: string;
    readonly windowDays: number;
    readonly now: number;
  }) => Effect.Effect<FundingStatsResult>;
  readonly fundingSeries: (input: {
    readonly coin: string;
    readonly n: number;
  }) => Effect.Effect<FundingSeriesResult>;
  readonly oiPremium: (input: {
    readonly coin: string;
    readonly n: number;
  }) => Effect.Effect<OiPremiumResult>;
  readonly bookHistory: (input: {
    readonly coin: string;
    readonly n: number;
  }) => Effect.Effect<BookHistoryResult>;
  readonly derivedMetric: (input: {
    readonly market: string;
    readonly params: DerivedMetricParams;
    readonly now: number;
    readonly positionEntryAt?: number;
    readonly sinceMs?: number;
  }) => Effect.Effect<DerivedMetricResult>;
  readonly scan: (input: { readonly now: number }) => Effect.Effect<ScanResult>;
  readonly sessionLevels: (input: {
    readonly coin: string;
    readonly now: number;
  }) => Effect.Effect<SessionLevelsResult>;
}

export class TradingMarketArchive extends Context.Service<
  TradingMarketArchive,
  TradingMarketArchiveShape
>()("t3/trading/TradingMarketArchive") {}

const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * Build the service against an explicit archive path. Tests pass a temp
 * fixture; the live layer passes `archiveDatabasePath()`.
 *
 * The handle is opened lazily and never cached as "missing": every call
 * re-checks the file, so an archive created after boot — the archiver being
 * started later, or a cold machine — is served on the next call without a
 * restart. Once open, the handle is kept; WAL means the writer never blocks
 * on it. A `n` of less than 1 is a caller bug, refused as `unavailable`
 * rather than silently returning everything (`LIMIT -1` in SQLite).
 */
export const makeTradingMarketArchive = (filePath: string): TradingMarketArchiveShape => {
  let handle: ArchiveDatabase | null = null;

  // Opens the handle when possible and runs `read` against it. A missing or
  // unopenable file, or a query that fails (an empty file has no tables),
  // yields `unavailable` with the reason — never a throw, never a number.
  const withHandle = <Ok>(
    read: (db: ArchiveDatabase) => Ok,
    onMissing: string,
  ): Effect.Effect<Ok | ArchiveUnavailable> =>
    Effect.sync(() => {
      if (handle === null) {
        handle = openArchiveDatabaseReadOnly(filePath);
      }
      if (handle === null) {
        return { status: "unavailable", reason: onMissing };
      }
      try {
        return read(handle);
      } catch (error) {
        return {
          status: "unavailable",
          reason: `archive read failed at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    });

  const checkN = (n: number): string | null => (n < 1 ? "n must be at least 1" : null);

  return TradingMarketArchive.of({
    fundingStats: ({ coin, windowDays, now }) =>
      withHandle((db) => {
        const since = now - windowDays * DAY_MS;
        const rows = fundingInRange(db, coin, since, now);
        if (rows.length === 0) {
          return {
            status: "unavailable",
            reason:
              `funding window ${windowDays}d not covered for ${coin} ` +
              "(0 rows in window; archiver not running?)",
          };
        }
        const mean = rows.reduce((total, row) => total + row.fundingRate, 0) / rows.length;
        const latest = rows[rows.length - 1] as FundingRow;
        let signFlips = 0;
        for (let index = 1; index < rows.length; index += 1) {
          const previous = Math.sign((rows[index - 1] as FundingRow).fundingRate);
          const current = Math.sign((rows[index] as FundingRow).fundingRate);
          if (previous !== current) {
            signFlips += 1;
          }
        }
        return {
          status: "ok",
          mean,
          latestRate: latest.fundingRate,
          latestTime: latest.time,
          signFlips,
          sampleCount: rows.length,
        };
      }, `archive file not found at ${filePath}`),

    fundingSeries: ({ coin, n }) => {
      const invalid = checkN(n);
      if (invalid !== null) {
        return Effect.succeed({ status: "unavailable", reason: invalid });
      }
      return withHandle((db) => {
        const rows = recentFunding(db, coin, n);
        if (rows.length === 0) {
          return {
            status: "unavailable",
            reason: `no funding rows recorded for ${coin} (archiver not running?)`,
          };
        }
        return { status: "ok", rows, count: rows.length };
      }, `archive file not found at ${filePath}`);
    },

    oiPremium: ({ coin, n }) => {
      const invalid = checkN(n);
      if (invalid !== null) {
        return Effect.succeed({ status: "unavailable", reason: invalid });
      }
      return withHandle((db) => {
        const rows = recentAssetContext(db, coin, n);
        if (rows.length === 0) {
          return {
            status: "unavailable",
            reason: `no asset_ctx rows recorded for ${coin} (archiver not running?)`,
          };
        }
        return { status: "ok", rows, count: rows.length };
      }, `archive file not found at ${filePath}`);
    },

    bookHistory: ({ coin, n }) => {
      const invalid = checkN(n);
      if (invalid !== null) {
        return Effect.succeed({ status: "unavailable", reason: invalid });
      }
      return withHandle((db) => {
        const rows = recentBookSummary(db, coin, n);
        if (rows.length === 0) {
          return {
            status: "unavailable",
            reason: `no book_summary rows recorded for ${coin} (archiver not running?)`,
          };
        }
        return { status: "ok", rows, count: rows.length };
      }, `archive file not found at ${filePath}`);
    },

    derivedMetric: ({ market, params, now, positionEntryAt, sinceMs }) =>
      Effect.map(
        withHandle((db): DerivedMetricResult => {
          const outcome = derivedMetricValue(db, market, params, {
            now,
            ...(positionEntryAt === undefined ? {} : { positionEntryAt }),
            ...(sinceMs === undefined ? {} : { sinceMs }),
          });
          return outcome.status === "ok"
            ? {
                status: "ok",
                value: outcome.value,
                ...(outcome.bps === undefined ? {} : { bps: outcome.bps }),
              }
            : { status: "unavailable", kind: outcome.kind, reason: outcome.detail };
        }, `archive file not found at ${filePath}`),
        // A missing file or failed read falls out of `withHandle` as the plain
        // unavailable shape; a metric-level refusal already carries its kind.
        (result): DerivedMetricResult =>
          "kind" in result || result.status === "ok"
            ? result
            : { status: "unavailable", kind: "archive", reason: result.reason },
      ),

    scan: ({ now }) =>
      withHandle((db) => {
        // One compact digest per archived coin, from the coin list the archive
        // config owns. Each half is best-effort: a coin the archive cannot
        // answer is marked on the coin, never by failing the whole key.
        // There is deliberately no regime field: it is not derivable from the
        // existing structure code at acceptable cost, and the plan says omit
        // rather than invent.
        const coins = ARCHIVE_COINS.map((coin): ScanCoinDigest => {
          const entry: { coin: string } & Record<string, number | string> = { coin };
          const missing: Array<string> = [];

          const bars = candlesInRange(db, coin, "5m", now - DAY_MS, now);
          if (bars.length === 0) {
            missing.push("no 5m candles in the trailing 24h");
          } else {
            const last = bars[bars.length - 1] as (typeof bars)[number];
            const first = bars[0] as (typeof bars)[number];
            // Rounded to the precision the digest publishes: the scan is a
            // context read, and full float precision is chars nothing acts on.
            const round2 = (value: number): number => Math.round(value * 100) / 100;
            // Mark is the last archived 5m close — the scan is an archive-only
            // key and makes no live exchange call, so it can trail the tape by
            // up to one bar.
            entry["mark"] = round2(last.c);
            if (first.o > 0) {
              entry["change24hPct"] = round2(((last.c - first.o) / first.o) * 100);
            } else {
              // No positive base to measure the change against. Named like
              // every other absence here rather than dropped in silence.
              missing.push("oldest 24h bar has no positive open");
            }
            const returns: Array<number> = [];
            for (let index = 1; index < bars.length; index += 1) {
              const previous = (bars[index - 1] as (typeof bars)[number]).c;
              returns.push(((bars[index] as (typeof bars)[number]).c - previous) / previous);
            }
            if (returns.length > 1) {
              const mean = returns.reduce((total, value) => total + value, 0) / returns.length;
              let squared = 0;
              for (const value of returns) squared += (value - mean) * (value - mean);
              // Daily-scaled percent: 288 five-minute bars a day.
              entry["realizedVol24hPct"] =
                Math.round(Math.sqrt(squared / returns.length) * Math.sqrt(288) * 100 * 10) / 10;
            } else {
              // Two bars give at most one return — no variance to scale. The
              // absence is named per coin, never silenced (plan 38 §2).
              missing.push(
                `only ${bars.length} 5m bar${bars.length === 1 ? "" : "s"} in the trailing 24h — realized volatility not computable`,
              );
            }
          }

          const week = fundingInRange(db, coin, now - 7 * DAY_MS, now);
          if (week.length === 0) {
            missing.push("no funding rows in the trailing 7d");
          } else {
            const latest = week[week.length - 1] as FundingRow;
            entry["fundingNow"] = latest.fundingRate;
            const earliest = minFundingTime(db, coin);
            if (earliest !== null && earliest <= now - 7 * DAY_MS) {
              const total = week.reduce((sum, row) => sum + row.fundingRate, 0);
              entry["funding7dMean"] = total / week.length;
            } else {
              missing.push("funding holdings start inside the 7d window");
            }
          }

          const latestCtx = latestAssetContext(db, coin);
          const dayAgoCtx = assetCtxAtOrBefore(db, coin, now - DAY_MS);
          if (latestCtx === null || dayAgoCtx === null || dayAgoCtx.ts < now - 2 * DAY_MS) {
            missing.push("no asset_ctx coverage across the trailing 24h");
          } else if (dayAgoCtx.openInterest > 0) {
            entry["oiChange24hPct"] =
              Math.round(
                ((latestCtx.openInterest - dayAgoCtx.openInterest) / dayAgoCtx.openInterest) *
                  100 *
                  100,
              ) / 100;
          } else {
            missing.push("oldest open-interest sample is not positive");
          }

          if (missing.length > 0) entry["unavailable"] = missing.join("; ");
          return entry as ScanCoinDigest;
        });
        return { status: "ok", coins };
      }, `archive file not found at ${filePath}`),

    sessionLevels: ({ coin, now }) =>
      withHandle((db) => {
        const dayStart = Math.floor(now / DAY_MS) * DAY_MS;
        const prior = candlesInRange(db, coin, "5m", dayStart - DAY_MS, dayStart - 1);
        const current = candlesInRange(db, coin, "5m", dayStart, now);
        const missing: Array<string> = [];
        if (prior.length === 0) {
          missing.push("no 5m candles in the prior UTC day");
        }
        if (current.length === 0) {
          missing.push("no 5m candles in the current UTC day");
        }
        if (prior.length === 0 && current.length === 0) {
          return {
            status: "unavailable",
            reason: `no 5m candles recorded for ${coin} over the last two UTC days`,
          } as const;
        }
        const priorLevels =
          prior.length > 0
            ? {
                high: Math.max(...prior.map((bar) => bar.h)),
                low: Math.min(...prior.map((bar) => bar.l)),
                close: (prior[prior.length - 1] as (typeof prior)[number]).c,
              }
            : undefined;
        let currentLevels: SessionLevelsOk["currentUtcDay"] = undefined;
        let vwap: number | undefined;
        if (current.length > 0) {
          currentLevels = {
            open: (current[0] as (typeof current)[number]).o,
            high: Math.max(...current.map((bar) => bar.h)),
            low: Math.min(...current.map((bar) => bar.l)),
          };
          let volume = 0;
          let weighted = 0;
          for (const bar of current) {
            const typical = (bar.h + bar.l + bar.c) / 3;
            volume += bar.v;
            weighted += typical * bar.v;
          }
          if (volume > 0) {
            vwap = Math.round((weighted / volume) * 100) / 100;
          } else {
            missing.push("zero volume in the current UTC day");
          }
        }
        return {
          status: "ok",
          ...(priorLevels === undefined ? {} : { priorUtcDay: priorLevels }),
          ...(currentLevels === undefined ? {} : { currentUtcDay: currentLevels }),
          ...(vwap === undefined ? {} : { vwap }),
          ...(missing.length > 0 ? { unavailable: missing.join("; ") } : {}),
        };
      }, `archive file not found at ${filePath}`),
  });
};

export const TradingMarketArchiveLive = Layer.succeed(
  TradingMarketArchive,
  makeTradingMarketArchive(archiveDatabasePath()),
);
