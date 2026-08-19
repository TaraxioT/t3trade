/**
 * The thirteen derived metrics of plan 38 §3.3 — pure functions over an open
 * archive handle, in the same style as `read.ts`: no clock of their own, no
 * side effects, testable against a temp file with synthetic rows.
 *
 * The contract this module enforces: absence is an answer, never a number. A
 * window the archive does not cover, a series with zero variance, a missing
 * position entry time — each returns `{ status: "unavailable", kind, detail }`
 * where `kind` is what later maps onto a watch refusal code:
 * `archive` → derived_needs_archive, `window` → derived_window_unavailable,
 * `context` → an evaluation-time skip (no position, reference watch not fired,
 * zero variance).
 *
 * Math conventions shared by every formula here: population stdev is
 * sqrt(mean((x − x̄)²)); an EMA of `period` is seeded with the first close in
 * the window and iterated with α = 2/(period+1) over the window's closes; a
 * return is r = (c − c_prev)/c_prev. Candle metrics use stored bars — archive
 * rows are closed bars by construction — and check `known_gaps` over the
 * lookback they need, since only the candle backfill records gaps.
 *
 * @module trading/archive/derived
 */
import { INTERVAL_MS } from "./config.ts";
import type { CandleRow } from "./candles.ts";
import type { ArchiveDatabase } from "./db.ts";
import { candlesInRange, fundingInRange, knownGaps } from "./read.ts";

import type { BarInterval, DerivedMetricParams } from "@t3tools/trading-contracts/watch";

export type DerivedMetricUnavailabilityKind = "archive" | "window" | "context";

export type DerivedMetricOutcome =
  | {
      readonly status: "ok";
      readonly value: number;
      /**
       * The figure a metric that serves a second unit carries alongside its
       * value. Only `vwap_distance` sets it: the signed distance of the last
       * close from the session VWAP in bps, rounded to 2dp like the scan
       * digest's percent figures. Thresholds stay in the metric's own units.
       */
      readonly bps?: number;
    }
  | {
      readonly status: "unavailable";
      readonly kind: DerivedMetricUnavailabilityKind;
      readonly detail: string;
    };

/**
 * What the caller resolves at evaluation time: the clock, and the two
 * position/watch anchors the archive cannot know — `positionEntryAt` for the
 * metrics accumulated since entry, `sinceMs` for bars-since-a-reference-watch.
 */
export interface DerivedMetricContext {
  readonly now: number;
  readonly positionEntryAt?: number;
  readonly sinceMs?: number;
}

const DAY_MS = 24 * 60 * 60 * 1_000;
const MINUTE_MS = 60_000;
/** The archiver samples asset_ctx/book ~1/min; coverage older than this is slack. */
const COVERAGE_SLACK_MS = 2 * MINUTE_MS;

// ---------------------------------------------------------------------------
// Local prepared-statement helpers, in the read.ts style
// ---------------------------------------------------------------------------

const CANDLE_COLUMNS = "coin, interval, t, t_close, o, h, l, c, v, n";

/** The last `limit` stored bars for a series, oldest first (may be fewer). */
function lastCandles(
  db: ArchiveDatabase,
  coin: string,
  interval: string,
  limit: number,
): ReadonlyArray<CandleRow> {
  return db
    .all<{
      coin: string;
      interval: string;
      t: number;
      t_close: number;
      o: number;
      h: number;
      l: number;
      c: number;
      v: number;
      n: number;
    }>(
      `SELECT ${CANDLE_COLUMNS} FROM candles ` +
        "WHERE coin = ? AND interval = ? ORDER BY t DESC LIMIT ?",
      coin,
      interval,
      limit,
    )
    .map((row) => ({
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
    }))
    .toReversed();
}

/** Total bars stored for a series — the "does the archive hold it at all" check. */
function candleCount(db: ArchiveDatabase, coin: string, interval: string): number {
  const rows = db.all<{ total: number }>(
    "SELECT COUNT(*) AS total FROM candles WHERE coin = ? AND interval = ?",
    coin,
    interval,
  );
  return rows[0]?.total ?? 0;
}

/** Bars of the series whose close time is strictly after `afterT`. */
function candlesClosedAfter(
  db: ArchiveDatabase,
  coin: string,
  interval: string,
  afterT: number,
): ReadonlyArray<CandleRow> {
  return candlesInRange(db, coin, interval, afterT + 1, Number.MAX_SAFE_INTEGER).filter(
    (row) => row.tClose > afterT,
  );
}

/** The earliest funding timestamp recorded for a coin, or `null` when none. */
function earliestFundingTime(db: ArchiveDatabase, coin: string): number | null {
  const rows = db.all<{ earliest: number | null }>(
    "SELECT MIN(time) AS earliest FROM funding WHERE coin = ?",
    coin,
  );
  return rows[0]?.earliest ?? null;
}

interface CtxSampleColumns {
  readonly ts: number;
  readonly open_interest: number;
  readonly premium: number;
}

/** asset_ctx samples with timestamp in `[fromT, toT]`, oldest first. */
function assetCtxInRange(
  db: ArchiveDatabase,
  coin: string,
  fromT: number,
  toT: number,
): ReadonlyArray<{ readonly ts: number; readonly openInterest: number; readonly premium: number }> {
  return db
    .all<CtxSampleColumns>(
      "SELECT ts, open_interest, premium FROM asset_ctx " +
        "WHERE coin = ? AND ts >= ? AND ts <= ? ORDER BY ts ASC",
      coin,
      fromT,
      toT,
    )
    .map((row) => ({ ts: row.ts, openInterest: row.open_interest, premium: row.premium }));
}

interface BookSampleColumns {
  readonly ts: number;
  readonly bid_depth5: number;
  readonly ask_depth5: number;
}

/** book_summary samples with timestamp in `[fromT, toT]`, oldest first. */
function bookSamplesInRange(
  db: ArchiveDatabase,
  coin: string,
  fromT: number,
  toT: number,
): ReadonlyArray<{ readonly ts: number; readonly bidDepth5: number; readonly askDepth5: number }> {
  return db
    .all<BookSampleColumns>(
      "SELECT ts, bid_depth5, ask_depth5 FROM book_summary " +
        "WHERE coin = ? AND ts >= ? AND ts <= ? ORDER BY ts ASC",
      coin,
      fromT,
      toT,
    )
    .map((row) => ({ ts: row.ts, bidDepth5: row.bid_depth5, askDepth5: row.ask_depth5 }));
}

// ---------------------------------------------------------------------------
// Math helpers — the shared definitions, so each formula stays one line of intent
// ---------------------------------------------------------------------------

/** Population stdev: sqrt(mean((x − x̄)²)). */
function populationStdev(values: ReadonlyArray<number>): number {
  const mean = values.reduce((total, value) => total + value, 0) / values.length;
  let squared = 0;
  for (const value of values) {
    squared += (value - mean) * (value - mean);
  }
  return Math.sqrt(squared / values.length);
}

/** EMA over the window's closes, seeded with the first close, α = 2/(period+1). */
function seededEma(closes: ReadonlyArray<number>, period: number): number {
  const alpha = 2 / (period + 1);
  let ema = closes[0] as number;
  for (let index = 1; index < closes.length; index += 1) {
    ema = ema + alpha * ((closes[index] as number) - ema);
  }
  return ema;
}

/** r_i = (c_i − c_{i−1})/c_{i−1} for i = 1..n−1 over the closes, oldest first. */
function returnsOf(closes: ReadonlyArray<number>): ReadonlyArray<number> {
  const returns: number[] = [];
  for (let index = 1; index < closes.length; index += 1) {
    const previous = closes[index - 1] as number;
    const current = closes[index] as number;
    returns.push((current - previous) / previous);
  }
  return returns;
}

/**
 * A candle lookback `fromT..now` is refused as `archive` when a recorded gap
 * overlaps it — the backfill already told us those bars never existed.
 */
function refuseOnGap(
  db: ArchiveDatabase,
  coin: string,
  interval: string,
  fromT: number,
  toT: number,
): DerivedMetricOutcome | null {
  for (const gap of knownGaps(db, coin, interval)) {
    if (gap.fromT <= toT && gap.toT >= fromT) {
      return {
        status: "unavailable",
        kind: "archive",
        detail:
          `known gap [${gap.fromT}, ${gap.toT}] overlaps the ${interval} lookback ` +
          `[${fromT}, ${toT}] for ${coin}`,
      };
    }
  }
  return null;
}

/**
 * The last `barsNeeded` bars, refused as `window` when the archive holds
 * fewer. Callers that also need gap protection pass a non-null `gapFromT`.
 */
function requireBars(
  db: ArchiveDatabase,
  coin: string,
  interval: BarInterval,
  barsNeeded: number,
  gapFromT: number | null,
  now: number,
): { readonly bars: ReadonlyArray<CandleRow> } | DerivedMetricOutcome {
  const intervalMs = INTERVAL_MS[interval];
  const fromT = gapFromT ?? now - barsNeeded * intervalMs;
  const gapRefusal = refuseOnGap(db, coin, interval, fromT, now);
  if (gapRefusal !== null) {
    return gapRefusal;
  }
  const bars = lastCandles(db, coin, interval, barsNeeded);
  if (bars.length < barsNeeded) {
    return {
      status: "unavailable",
      kind: "window",
      detail:
        `${coin} ${interval} archive holds ${bars.length} of ${barsNeeded} bars ` +
        "needed for the lookback",
    };
  }
  return { bars };
}

/**
 * The ~1/min samples inside a minute-window, refused as `window` when fewer
 * than two or when the oldest sample is fresher than the 2-minute coverage
 * slack — a fresher-only series means holdings do not cover the window.
 */
function coveredMinuteSamples<T extends { readonly ts: number }>(
  samples: ReadonlyArray<T>,
  windowStart: number,
  windowMinutes: number,
  coin: string,
): { readonly samples: ReadonlyArray<T> } | DerivedMetricOutcome {
  const oldest = samples[0];
  if (oldest === undefined || samples.length < 2 || oldest.ts > windowStart + COVERAGE_SLACK_MS) {
    return {
      status: "unavailable",
      kind: "window",
      detail:
        `${coin} samples cover only ${samples.length} of the ${windowMinutes}m window ` +
        `(oldest sample at ${oldest?.ts ?? "none"})`,
    };
  }
  return { samples };
}

// ---------------------------------------------------------------------------
// The metric dispatch
// ---------------------------------------------------------------------------

/**
 * Compute one derived metric for `coin` from the archive. Pure: the same
 * handle, params, and context always produce the same outcome.
 */
export function derivedMetricValue(
  db: ArchiveDatabase,
  coin: string,
  params: DerivedMetricParams,
  ctx: DerivedMetricContext,
): DerivedMetricOutcome {
  switch (params.metric) {
    case "funding_mean":
    case "funding_sign_flip": {
      // Unweighted mean of the hourly funding rates inside the trailing
      // window; the flip/fire-on-change logic is the evaluator's, not ours.
      const from = ctx.now - params.windowDays * DAY_MS;
      const rows = fundingInRange(db, coin, from, ctx.now);
      const earliest = earliestFundingTime(db, coin);
      if (rows.length === 0 || earliest === null) {
        return {
          status: "unavailable",
          kind: "window",
          detail: `0 funding rows in the ${params.windowDays}d window for ${coin}`,
        };
      }
      if (earliest > from) {
        return {
          status: "unavailable",
          kind: "window",
          detail:
            `funding holdings for ${coin} start at ${earliest}, after the ` +
            `${params.windowDays}d window start ${from}`,
        };
      }
      const total = rows.reduce((sum, row) => sum + row.fundingRate, 0);
      return { status: "ok", value: total / rows.length };
    }

    case "funding_cumulative": {
      // Sum of the funding rates paid since the position was opened.
      const entryAt = ctx.positionEntryAt;
      if (entryAt === undefined) {
        return {
          status: "unavailable",
          kind: "context",
          detail: "no open position to accumulate since",
        };
      }
      const rows = fundingInRange(db, coin, entryAt, ctx.now);
      const earliest = earliestFundingTime(db, coin);
      if (rows.length === 0 || earliest === null || earliest > entryAt) {
        return {
          status: "unavailable",
          kind: "window",
          detail:
            `funding holdings for ${coin} do not cover [${entryAt}, ${ctx.now}] ` +
            `(earliest at ${earliest ?? "none"})`,
        };
      }
      return { status: "ok", value: rows.reduce((sum, row) => sum + row.fundingRate, 0) };
    }

    case "sigma_return": {
      // The last bar's return in population-σ units of the trailing period returns.
      const needed = requireBars(db, coin, params.interval, params.period + 1, null, ctx.now);
      if (!("bars" in needed)) return needed;
      const returns = returnsOf(needed.bars.map((bar) => bar.c));
      const sigma = populationStdev(returns);
      if (sigma <= 0) {
        return { status: "unavailable", kind: "context", detail: "zero variance in returns" };
      }
      return { status: "ok", value: (returns[returns.length - 1] as number) / sigma };
    }

    case "sigma_distance": {
      // The last close's distance from the window mean (or seeded EMA) in
      // population-σ units of the closes.
      const needed = requireBars(db, coin, params.interval, params.period, null, ctx.now);
      if (!("bars" in needed)) return needed;
      const closes = needed.bars.map((bar) => bar.c);
      const mu =
        params.basis === "ema"
          ? seededEma(closes, params.period)
          : closes.reduce((total, close) => total + close, 0) / closes.length;
      const sigma = populationStdev(closes);
      if (sigma <= 0) {
        return { status: "unavailable", kind: "context", detail: "zero variance in closes" };
      }
      return { status: "ok", value: ((closes[closes.length - 1] as number) - mu) / sigma };
    }

    case "sigma_ratio": {
      // Fast-window return σ over slow-window return σ — vol regime shift.
      const needed = requireBars(db, coin, params.interval, params.slow + 1, null, ctx.now);
      if (!("bars" in needed)) return needed;
      const returns = returnsOf(needed.bars.map((bar) => bar.c));
      const sigmaFast = populationStdev(returns.slice(returns.length - params.fast));
      const sigmaSlow = populationStdev(returns);
      if (sigmaFast <= 0 || sigmaSlow <= 0) {
        return { status: "unavailable", kind: "context", detail: "zero variance in returns" };
      }
      return { status: "ok", value: sigmaFast / sigmaSlow };
    }

    case "ema_distance": {
      // The last close's relative distance from the seeded EMA of its window.
      const needed = requireBars(db, coin, params.interval, params.period, null, ctx.now);
      if (!("bars" in needed)) return needed;
      const closes = needed.bars.map((bar) => bar.c);
      const ema = seededEma(closes, params.period);
      if (ema === 0) {
        return { status: "unavailable", kind: "context", detail: "ema of closes is zero" };
      }
      return { status: "ok", value: ((closes[closes.length - 1] as number) - ema) / ema };
    }

    case "oi_change_rate": {
      // Open-interest change across the covered window: (last − first)/first.
      const from = ctx.now - params.windowMinutes * MINUTE_MS;
      const covered = coveredMinuteSamples(
        assetCtxInRange(db, coin, from, ctx.now),
        from,
        params.windowMinutes,
        coin,
      );
      if (!("samples" in covered)) return covered;
      const first = covered.samples[0] as { openInterest: number };
      const last = covered.samples[covered.samples.length - 1] as { openInterest: number };
      if (first.openInterest <= 0) {
        return {
          status: "unavailable",
          kind: "context",
          detail: "oldest open-interest sample is not positive",
        };
      }
      return {
        status: "ok",
        value: (last.openInterest - first.openInterest) / first.openInterest,
      };
    }

    case "premium_mean": {
      // Mean of the premium samples inside the covered window.
      const from = ctx.now - params.windowMinutes * MINUTE_MS;
      const covered = coveredMinuteSamples(
        assetCtxInRange(db, coin, from, ctx.now),
        from,
        params.windowMinutes,
        coin,
      );
      if (!("samples" in covered)) return covered;
      const total = covered.samples.reduce((sum, sample) => sum + sample.premium, 0);
      return { status: "ok", value: total / covered.samples.length };
    }

    case "depth_ratio": {
      // Mean of bid_depth5/ask_depth5 over the covered window, skipping
      // samples with no ask-side depth (a one-sided book is not a ratio).
      const from = ctx.now - params.windowMinutes * MINUTE_MS;
      const covered = coveredMinuteSamples(
        bookSamplesInRange(db, coin, from, ctx.now),
        from,
        params.windowMinutes,
        coin,
      );
      if (!("samples" in covered)) return covered;
      const ratios: number[] = [];
      for (const sample of covered.samples) {
        if (sample.askDepth5 > 0) {
          ratios.push(sample.bidDepth5 / sample.askDepth5);
        }
      }
      if (ratios.length === 0) {
        return {
          status: "unavailable",
          kind: "context",
          detail: "no book sample in the window has ask-side depth",
        };
      }
      return {
        status: "ok",
        value: ratios.reduce((total, ratio) => total + ratio, 0) / ratios.length,
      };
    }

    case "bars_since": {
      // Count of closed bars since the reference watch fired (sinceMs).
      const sinceMs = ctx.sinceMs;
      if (sinceMs === undefined) {
        return {
          status: "unavailable",
          kind: "context",
          detail: "reference watch has not fired",
        };
      }
      const gapRefusal = refuseOnGap(db, coin, params.interval, sinceMs, ctx.now);
      if (gapRefusal !== null) return gapRefusal;
      if (candleCount(db, coin, params.interval) === 0) {
        return {
          status: "unavailable",
          kind: "window",
          detail: `no ${params.interval} bars recorded for ${coin}`,
        };
      }
      return { status: "ok", value: candlesClosedAfter(db, coin, params.interval, sinceMs).length };
    }

    case "hold_bars": {
      // Count of closed bars since the position was opened.
      const entryAt = ctx.positionEntryAt;
      if (entryAt === undefined) {
        return {
          status: "unavailable",
          kind: "context",
          detail: "no open position to count bars since",
        };
      }
      const gapRefusal = refuseOnGap(db, coin, params.interval, entryAt, ctx.now);
      if (gapRefusal !== null) return gapRefusal;
      if (candleCount(db, coin, params.interval) === 0) {
        return {
          status: "unavailable",
          kind: "window",
          detail: `no ${params.interval} bars recorded for ${coin}`,
        };
      }
      return { status: "ok", value: candlesClosedAfter(db, coin, params.interval, entryAt).length };
    }

    case "vwap_distance": {
      // Signed distance of the last close from the UTC-day session VWAP
      // (Σ typical·v / Σ v over the bars that opened inside the current UTC
      // day), in population-σ units of the session's closes.
      const dayStart = Math.floor(ctx.now / DAY_MS) * DAY_MS;
      const gapRefusal = refuseOnGap(db, coin, params.interval, dayStart, ctx.now);
      if (gapRefusal !== null) return gapRefusal;
      const bars = candlesInRange(db, coin, params.interval, dayStart, ctx.now);
      if (bars.length === 0) {
        return {
          status: "unavailable",
          kind: "window",
          detail: `no ${params.interval} bars in the current UTC day for ${coin}`,
        };
      }
      let volume = 0;
      let weighted = 0;
      for (const bar of bars) {
        const typical = (bar.h + bar.l + bar.c) / 3;
        volume += bar.v;
        weighted += typical * bar.v;
      }
      if (volume <= 0) {
        return {
          status: "unavailable",
          kind: "context",
          detail: "zero volume across the session's bars",
        };
      }
      const sigma = populationStdev(bars.map((bar) => bar.c));
      if (sigma <= 0) {
        return {
          status: "unavailable",
          kind: "context",
          detail: "zero variance in session closes",
        };
      }
      const last = bars[bars.length - 1] as CandleRow;
      const vwap = weighted / volume;
      return {
        status: "ok",
        value: (last.c - vwap) / sigma,
        // The same distance in bps, sign preserved, at the digest's 2dp —
        // served alongside the sigma figure, never instead of it.
        bps: Math.round(((last.c - vwap) / vwap) * 10_000 * 100) / 100,
      };
    }
  }
}
