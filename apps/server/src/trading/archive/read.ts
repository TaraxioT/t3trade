/**
 * The read side of the archive — pure functions over an open handle.
 *
 * Nothing in the application imports this yet. It exists so that when the
 * trading toolkit does want the history, the question it asks is
 * `trailingMeanFunding(db, "ETH", 30, now)` and not a hand-written join. Every
 * function here is a query and a shape: no caching, no clock of its own, no
 * side effects, so a caller can test against a temp file with synthetic rows.
 *
 * Open the handle with `openArchiveDatabase(archiveDatabasePath())`. Reads are
 * safe while the archiver is writing — the file is in WAL mode.
 *
 * @module trading/archive/read
 */
import type { AssetCtxRow } from "./assetCtx.ts";
import type { BookSummaryRow } from "./bookSummary.ts";
import type { CandleRow } from "./candles.ts";
import type { ArchiveDatabase } from "./db.ts";
import type { FundingRow } from "./funding.ts";

interface CandleColumns {
  readonly coin: string;
  readonly interval: string;
  readonly t: number;
  readonly t_close: number;
  readonly o: number;
  readonly h: number;
  readonly l: number;
  readonly c: number;
  readonly v: number;
  readonly n: number;
}

const toCandle = (row: CandleColumns): CandleRow => ({
  coin: row.coin,
  interval: row.interval,
  t: row.t,
  tClose: row.t_close,
  o: row.o,
  h: row.h,
  l: row.l,
  c: row.c,
  v: row.v,
  n: row.n,
});

const CANDLE_COLUMNS = "coin, interval, t, t_close, o, h, l, c, v, n";

/** The newest stored bar for a series, or `null` when nothing is recorded. */
export function latestCandle(
  db: ArchiveDatabase,
  coin: string,
  interval: string,
): CandleRow | null {
  const rows = db.all<CandleColumns>(
    `SELECT ${CANDLE_COLUMNS} FROM candles WHERE coin = ? AND interval = ? ORDER BY t DESC LIMIT 1`,
    coin,
    interval,
  );
  const row = rows[0];
  return row === undefined ? null : toCandle(row);
}

/** Bars whose open time falls in `[fromT, toT]`, oldest first. */
export function candlesInRange(
  db: ArchiveDatabase,
  coin: string,
  interval: string,
  fromT: number,
  toT: number,
): ReadonlyArray<CandleRow> {
  return db
    .all<CandleColumns>(
      `SELECT ${CANDLE_COLUMNS} FROM candles ` +
        "WHERE coin = ? AND interval = ? AND t >= ? AND t <= ? ORDER BY t ASC",
      coin,
      interval,
      fromT,
      toT,
    )
    .map(toCandle);
}

/**
 * Mean funding rate over the last `days`, or `null` when the window holds no
 * rows. The rate is per 8-hour period as the exchange publishes it; the mean
 * is unweighted because Hyperliquid pays hourly on a fixed schedule, so every
 * row in the window covers the same span.
 */
export function trailingMeanFunding(
  db: ArchiveDatabase,
  coin: string,
  days: number,
  now: number,
): number | null {
  const since = now - days * 24 * 60 * 60 * 1_000;
  const rows = db.all<{ mean: number | null }>(
    "SELECT AVG(funding_rate) AS mean FROM funding WHERE coin = ? AND time >= ? AND time <= ?",
    coin,
    since,
    now,
  );
  return rows[0]?.mean ?? null;
}

interface AssetCtxColumns {
  readonly coin: string;
  readonly ts: number;
  readonly open_interest: number;
  readonly premium: number;
  readonly oracle_px: number;
  readonly mark_px: number;
  readonly day_ntl_volume: number;
  readonly funding: number;
}

const toAssetCtx = (row: AssetCtxColumns): AssetCtxRow => ({
  coin: row.coin,
  ts: row.ts,
  openInterest: row.open_interest,
  premium: row.premium,
  oraclePx: row.oracle_px,
  markPx: row.mark_px,
  dayNtlVolume: row.day_ntl_volume,
  funding: row.funding,
});

const ASSET_CTX_COLUMNS =
  "coin, ts, open_interest, premium, oracle_px, mark_px, day_ntl_volume, funding";

/** The most recent open-interest/premium sample for a coin. */
export function latestAssetContext(db: ArchiveDatabase, coin: string): AssetCtxRow | null {
  const rows = db.all<AssetCtxColumns>(
    `SELECT ${ASSET_CTX_COLUMNS} FROM asset_ctx WHERE coin = ? ORDER BY ts DESC LIMIT 1`,
    coin,
  );
  const row = rows[0];
  return row === undefined ? null : toAssetCtx(row);
}

interface BookSummaryColumns {
  readonly coin: string;
  readonly ts: number;
  readonly bid_px: number;
  readonly bid_sz: number;
  readonly ask_px: number;
  readonly ask_sz: number;
  readonly bid_depth5: number;
  readonly ask_depth5: number;
}

const toBookSummary = (row: BookSummaryColumns): BookSummaryRow => ({
  coin: row.coin,
  ts: row.ts,
  bidPx: row.bid_px,
  bidSz: row.bid_sz,
  askPx: row.ask_px,
  askSz: row.ask_sz,
  bidDepth5: row.bid_depth5,
  askDepth5: row.ask_depth5,
});

const BOOK_SUMMARY_COLUMNS = "coin, ts, bid_px, bid_sz, ask_px, ask_sz, bid_depth5, ask_depth5";

/** The most recent book summary for a coin. */
export function latestBookSummary(db: ArchiveDatabase, coin: string): BookSummaryRow | null {
  const rows = db.all<BookSummaryColumns>(
    `SELECT ${BOOK_SUMMARY_COLUMNS} FROM book_summary WHERE coin = ? ORDER BY ts DESC LIMIT 1`,
    coin,
  );
  const row = rows[0];
  return row === undefined ? null : toBookSummary(row);
}

/**
 * Funding rows whose timestamp falls in `[fromT, toT]`, oldest first — the
 * funding counterpart of `candlesInRange`, so a windowed statistic never has
 * to load the coin's whole history.
 */
export function fundingInRange(
  db: ArchiveDatabase,
  coin: string,
  fromT: number,
  toT: number,
): ReadonlyArray<FundingRow> {
  return db
    .all<{ coin: string; time: number; funding_rate: number; premium: number }>(
      "SELECT coin, time, funding_rate, premium FROM funding " +
        "WHERE coin = ? AND time >= ? AND time <= ? ORDER BY time ASC",
      coin,
      fromT,
      toT,
    )
    .map((row) => ({
      coin: row.coin,
      time: row.time,
      fundingRate: row.funding_rate,
      premium: row.premium,
    }));
}

/**
 * The last `limit` funding rows for a coin, oldest first — the same
 * chronological order as `candlesInRange`, so a caller can walk any series in
 * one direction. Asking for more rows than exist returns what there is; the
 * empty array means the coin has nothing recorded.
 */
export function recentFunding(
  db: ArchiveDatabase,
  coin: string,
  limit: number,
): ReadonlyArray<FundingRow> {
  return db
    .all<{ coin: string; time: number; funding_rate: number; premium: number }>(
      "SELECT coin, time, funding_rate, premium FROM funding " +
        "WHERE coin = ? ORDER BY time DESC LIMIT ?",
      coin,
      limit,
    )
    .map((row) => ({
      coin: row.coin,
      time: row.time,
      fundingRate: row.funding_rate,
      premium: row.premium,
    }))
    .toReversed();
}

/** The last `limit` derivatives-context samples for a coin, oldest first. */
export function recentAssetContext(
  db: ArchiveDatabase,
  coin: string,
  limit: number,
): ReadonlyArray<AssetCtxRow> {
  return db
    .all<AssetCtxColumns>(
      `SELECT ${ASSET_CTX_COLUMNS} FROM asset_ctx WHERE coin = ? ORDER BY ts DESC LIMIT ?`,
      coin,
      limit,
    )
    .map(toAssetCtx)
    .toReversed();
}

/** The last `limit` book summaries for a coin, oldest first. */
export function recentBookSummary(
  db: ArchiveDatabase,
  coin: string,
  limit: number,
): ReadonlyArray<BookSummaryRow> {
  return db
    .all<BookSummaryColumns>(
      `SELECT ${BOOK_SUMMARY_COLUMNS} FROM book_summary WHERE coin = ? ORDER BY ts DESC LIMIT ?`,
      coin,
      limit,
    )
    .map(toBookSummary)
    .toReversed();
}

export interface KnownGap {
  readonly coin: string;
  readonly interval: string;
  readonly fromT: number;
  readonly toT: number;
  readonly recordedAt: number;
}

/**
 * Stretches the archive is known to be missing, oldest first. A caller that
 * backtests over a window should check this before trusting a continuous
 * series.
 */
export function knownGaps(
  db: ArchiveDatabase,
  coin: string,
  interval: string,
): ReadonlyArray<KnownGap> {
  return db
    .all<{
      coin: string;
      interval: string;
      from_t: number;
      to_t: number;
      recorded_at: number;
    }>(
      "SELECT coin, interval, from_t, to_t, recorded_at FROM known_gaps " +
        "WHERE coin = ? AND interval = ? ORDER BY from_t ASC",
      coin,
      interval,
    )
    .map((row) => ({
      coin: row.coin,
      interval: row.interval,
      fromT: row.from_t,
      toT: row.to_t,
      recordedAt: row.recorded_at,
    }));
}
