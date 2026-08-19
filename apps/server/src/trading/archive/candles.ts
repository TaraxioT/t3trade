/**
 * Candles: the part of the archive the API will stop serving.
 *
 * A `candleSnapshot` answers with at most ~5000 bars ending now, whatever
 * `startTime` asks for; a window entirely older than that comes back empty.
 * So the archive is the only place a 1m bar from last week will ever exist
 * again, and the two jobs here are to write every bar the exchange still has
 * and to be honest about the ones it no longer does.
 *
 * Every write is an upsert keyed on (coin, interval, t). That is what makes
 * the process safe to kill: the bar in progress when it died is re-fetched
 * and overwritten with its final values on the next poll, and a bar fetched
 * twice costs one wasted write rather than a duplicate row.
 *
 * @module trading/archive/candles
 */
import type { ArchiveDatabase } from "./db.ts";
import { asArray, asInteger, asNumber, asRecord, asString } from "./wire.ts";

export interface CandleRow {
  readonly coin: string;
  readonly interval: string;
  /** Bar open time, epoch millis. The bar's identity. */
  readonly t: number;
  /** Bar close time, epoch millis (the wire calls this `T`). */
  readonly tClose: number;
  readonly o: number;
  readonly h: number;
  readonly l: number;
  readonly c: number;
  readonly v: number;
  readonly n: number;
}

/** The oldest bar open time the exchange will still serve, given `now`. */
export function oldestServableOpen(now: number, intervalMs: number, windowBars: number): number {
  const currentOpen = Math.floor(now / intervalMs) * intervalMs;
  return currentOpen - (windowBars - 1) * intervalMs;
}

/**
 * What to ask for on startup, and what can never be asked for again.
 *
 * The fetch window is always the whole servable range, never just the tail
 * past the newest stored bar. One `candleSnapshot` returns up to the API's
 * full cap whatever the range asked for, so asking for everything costs the
 * same single request and heals interior holes — a poll that failed an hour
 * ago — for free.
 *
 * When the stored history stops before the servable window even begins, the
 * process was down for longer than the window is wide and those bars are gone
 * for good. The caller records them in `known_gaps` rather than retrying
 * forever against an endpoint that will never answer.
 */
export interface CandleRepairPlan {
  readonly fetchFrom: number;
  readonly fetchTo: number;
  /** Bars that fell out of the API window while nothing was recording. */
  readonly unrecoverable: { readonly fromT: number; readonly toT: number } | null;
}

export function planCandleRepair(input: {
  readonly latestStoredOpen: number | null;
  readonly now: number;
  readonly intervalMs: number;
  readonly windowBars: number;
}): CandleRepairPlan {
  const { latestStoredOpen, now, intervalMs, windowBars } = input;
  const oldest = oldestServableOpen(now, intervalMs, windowBars);
  const nextExpected = latestStoredOpen === null ? null : latestStoredOpen + intervalMs;
  const unrecoverable =
    nextExpected !== null && nextExpected < oldest
      ? { fromT: nextExpected, toT: oldest - intervalMs }
      : null;

  return { fetchFrom: oldest, fetchTo: now, unrecoverable };
}

/**
 * Decode a `candleSnapshot` response, keeping only well-formed bars for the
 * coin and interval that were asked for. A row missing a field, or carrying
 * a price that is not a number, is dropped rather than written as a hole.
 */
export function parseCandles(
  raw: unknown,
  coin: string,
  interval: string,
): ReadonlyArray<CandleRow> {
  const rows = asArray(raw);
  if (rows === null) {
    return [];
  }

  const parsed: CandleRow[] = [];
  for (const entry of rows) {
    const record = asRecord(entry);
    if (record === null) {
      continue;
    }
    if (asString(record["s"]) !== coin || asString(record["i"]) !== interval) {
      continue;
    }
    const t = asInteger(record["t"]);
    const tClose = asInteger(record["T"]);
    const o = asNumber(record["o"]);
    const h = asNumber(record["h"]);
    const l = asNumber(record["l"]);
    const c = asNumber(record["c"]);
    const v = asNumber(record["v"]);
    const n = asInteger(record["n"]);
    if (
      t === null ||
      tClose === null ||
      o === null ||
      h === null ||
      l === null ||
      c === null ||
      v === null ||
      n === null
    ) {
      continue;
    }
    parsed.push({ coin, interval, t, tClose, o, h, l, c, v, n });
  }
  return parsed;
}

const UPSERT_CANDLE_SQL =
  "INSERT INTO candles (coin, interval, t, t_close, o, h, l, c, v, n) " +
  "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
  "ON CONFLICT(coin, interval, t) DO UPDATE SET " +
  "t_close = excluded.t_close, o = excluded.o, h = excluded.h, l = excluded.l, " +
  "c = excluded.c, v = excluded.v, n = excluded.n";

/** Upsert a batch in one transaction. Returns how many rows were written. */
export function upsertCandles(db: ArchiveDatabase, rows: ReadonlyArray<CandleRow>): number {
  if (rows.length === 0) {
    return 0;
  }
  return db.transaction(() => {
    for (const row of rows) {
      db.run(
        UPSERT_CANDLE_SQL,
        row.coin,
        row.interval,
        row.t,
        row.tClose,
        row.o,
        row.h,
        row.l,
        row.c,
        row.v,
        row.n,
      );
    }
    return rows.length;
  });
}

/** The newest stored bar open time for a series, or `null` when it is empty. */
export function latestStoredOpen(
  db: ArchiveDatabase,
  coin: string,
  interval: string,
): number | null {
  const rows = db.all<{ latest: number | null }>(
    "SELECT MAX(t) AS latest FROM candles WHERE coin = ? AND interval = ?",
    coin,
    interval,
  );
  return rows[0]?.latest ?? null;
}

/**
 * Record a stretch of bars the exchange can no longer serve. Idempotent on
 * (coin, interval, from_t, to_t): restarting inside the same outage re-states
 * the same gap rather than accumulating near-duplicates of it.
 */
export function recordKnownGap(
  db: ArchiveDatabase,
  gap: {
    readonly coin: string;
    readonly interval: string;
    readonly fromT: number;
    readonly toT: number;
    readonly recordedAt: number;
  },
): void {
  db.run(
    "INSERT INTO known_gaps (coin, interval, from_t, to_t, recorded_at) VALUES (?, ?, ?, ?, ?) " +
      "ON CONFLICT(coin, interval, from_t, to_t) DO NOTHING",
    gap.coin,
    gap.interval,
    gap.fromT,
    gap.toT,
    gap.recordedAt,
  );
}
