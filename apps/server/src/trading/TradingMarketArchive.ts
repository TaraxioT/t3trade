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

import { archiveDatabasePath } from "./archive/config.ts";
import type { AssetCtxRow } from "./archive/assetCtx.ts";
import type { BookSummaryRow } from "./archive/bookSummary.ts";
import { openArchiveDatabaseReadOnly, type ArchiveDatabase } from "./archive/db.ts";
import type { FundingRow } from "./archive/funding.ts";
import {
  fundingInRange,
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
  });
};

export const TradingMarketArchiveLive = Layer.succeed(
  TradingMarketArchive,
  makeTradingMarketArchive(archiveDatabasePath()),
);
