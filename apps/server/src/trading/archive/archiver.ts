/**
 * The archiver loop.
 *
 * One sequential tick, forever. Every minute it refreshes the tail of each
 * candle series, samples the derivatives context and the top of book, and
 * prints a heartbeat; every half hour it also pulls funding forward from its
 * high-water mark. Sequential rather than three timers, so the single-flight
 * Info client is never contended and the log reads in the order things
 * happened.
 *
 * Nothing here throws. A failed request returns `null` from the client and
 * the tick moves on — the next one re-asks for an overlapping window, so a
 * minute lost to a 429 is repaired a minute later without a retry queue.
 * Startup always begins with a full-window backfill, which makes killing the
 * process a supported way to operate it rather than an incident.
 *
 * @module trading/archive/archiver
 */

// @effect-diagnostics globalDate:off globalTimers:off - a standalone always-on process.
import { parseAssetContexts, upsertAssetContexts } from "./assetCtx.ts";
import { summariseBook, upsertBookSummaries } from "./bookSummary.ts";
import {
  latestStoredOpen,
  parseCandles,
  planCandleRepair,
  recordKnownGap,
  upsertCandles,
} from "./candles.ts";
import {
  ARCHIVE_COINS,
  ARCHIVE_INTERVALS,
  CANDLE_WINDOW_BARS,
  FUNDING_INTERVAL_MS,
  FUNDING_ORIGIN_MS,
  FUNDING_PAGE_ROWS,
  INTERVAL_MS,
  POLL_INTERVAL_MS,
  POLL_TAIL_BARS,
  type ArchiveInterval,
} from "./config.ts";
import type { ArchiveDatabase } from "./db.ts";
import { latestFundingTime, parseFunding, upsertFunding } from "./funding.ts";
import type { InfoClient } from "./info.ts";
import { describeError, logInfo, logWarn } from "./log.ts";

/** Rows upserted per table since the process started. */
export interface ArchiveCounters {
  candles: number;
  funding: number;
  assetCtx: number;
  bookSummary: number;
  gaps: number;
}

export const emptyCounters = (): ArchiveCounters => ({
  candles: 0,
  funding: 0,
  assetCtx: 0,
  bookSummary: 0,
  gaps: 0,
});

/**
 * Snapshot timestamps land on the minute so a restart mid-tick overwrites the
 * sample it was taking rather than adding a second one a few seconds apart.
 */
export const alignToMinute = (now: number): number => Math.floor(now / 60_000) * 60_000;

/** Guard against a paging loop that never advances. */
const MAX_FUNDING_PAGES = 1_000;

const candleSnapshotBody = (
  coin: string,
  interval: string,
  startTime: number,
  endTime?: number,
) => ({
  type: "candleSnapshot",
  req:
    endTime === undefined ? { coin, interval, startTime } : { coin, interval, startTime, endTime },
});

/**
 * Fetch the whole servable window for every series and note what fell out of
 * it while nothing was recording. Runs once, before the first tick.
 */
export async function backfillCandles(
  db: ArchiveDatabase,
  info: InfoClient,
  counters: ArchiveCounters,
  now: number,
  shouldContinue: () => boolean = () => true,
): Promise<void> {
  for (const coin of ARCHIVE_COINS) {
    for (const interval of ARCHIVE_INTERVALS) {
      if (!shouldContinue()) {
        return;
      }
      const intervalMs = INTERVAL_MS[interval];
      const plan = planCandleRepair({
        latestStoredOpen: latestStoredOpen(db, coin, interval),
        now,
        intervalMs,
        windowBars: CANDLE_WINDOW_BARS,
      });

      if (plan.unrecoverable !== null) {
        recordKnownGap(db, {
          coin,
          interval,
          fromT: plan.unrecoverable.fromT,
          toT: plan.unrecoverable.toT,
          recordedAt: now,
        });
        counters.gaps += 1;
        logWarn(
          `gap: ${coin} ${interval} ${new Date(plan.unrecoverable.fromT).toISOString()} — ` +
            `${new Date(plan.unrecoverable.toT).toISOString()} is older than the API window`,
        );
      }

      const raw = await info.post(
        "candleSnapshot",
        candleSnapshotBody(coin, interval, plan.fetchFrom, plan.fetchTo),
      );
      const rows = parseCandles(raw, coin, interval);
      counters.candles += upsertCandles(db, rows);
      logInfo(`backfill: ${coin} ${interval} ${rows.length} bars`);
    }
  }
}

/** Refresh the trailing bars of every series, including the one in progress. */
export async function pollCandles(
  db: ArchiveDatabase,
  info: InfoClient,
  counters: ArchiveCounters,
  now: number,
): Promise<void> {
  for (const coin of ARCHIVE_COINS) {
    for (const interval of ARCHIVE_INTERVALS) {
      const intervalMs = INTERVAL_MS[interval];
      const currentOpen = Math.floor(now / intervalMs) * intervalMs;
      const startTime = currentOpen - (POLL_TAIL_BARS[interval] - 1) * intervalMs;
      const raw = await info.post("candleSnapshot", candleSnapshotBody(coin, interval, startTime));
      counters.candles += upsertCandles(db, parseCandles(raw, coin, interval));
    }
  }
}

/** Page funding forward from each coin's stored high-water mark. */
export async function pullFunding(
  db: ArchiveDatabase,
  info: InfoClient,
  counters: ArchiveCounters,
  shouldContinue: () => boolean = () => true,
): Promise<void> {
  for (const coin of ARCHIVE_COINS) {
    const stored = latestFundingTime(db, coin);
    let cursor = stored === null ? FUNDING_ORIGIN_MS : stored + 1;
    let pages = 0;

    while (pages < MAX_FUNDING_PAGES && shouldContinue()) {
      pages += 1;
      const raw = await info.post("fundingHistory", {
        type: "fundingHistory",
        coin,
        startTime: cursor,
      });
      const rows = parseFunding(raw, coin);
      if (rows.length === 0) {
        break;
      }
      counters.funding += upsertFunding(db, rows);

      const newest = rows.reduce((max, row) => Math.max(max, row.time), cursor);
      if (newest < cursor || rows.length < FUNDING_PAGE_ROWS) {
        break;
      }
      cursor = newest + 1;
    }

    if (pages > 1) {
      logInfo(`funding: ${coin} pulled ${pages} pages`);
    }
  }
}

/** Sample open interest, premium, and the rest of the derivatives context. */
export async function pollAssetContexts(
  db: ArchiveDatabase,
  info: InfoClient,
  counters: ArchiveCounters,
  ts: number,
): Promise<void> {
  const raw = await info.post("metaAndAssetCtxs", { type: "metaAndAssetCtxs" });
  counters.assetCtx += upsertAssetContexts(db, parseAssetContexts(raw, ARCHIVE_COINS, ts));
}

/** Sample the top of book and the depth behind it, one call per coin. */
export async function pollBookSummaries(
  db: ArchiveDatabase,
  info: InfoClient,
  counters: ArchiveCounters,
  ts: number,
): Promise<void> {
  for (const coin of ARCHIVE_COINS) {
    const raw = await info.post("l2Book", { type: "l2Book", coin });
    const row = summariseBook(raw, coin, ts);
    if (row !== null) {
      counters.bookSummary += upsertBookSummaries(db, [row]);
    }
  }
}

/**
 * How far behind the newest stored bar of each interval is.
 *
 * Reported in seconds, and marked `!` when a bar has actually been missed.
 * Seconds alone do not show health on the slow intervals — the newest 4h bar
 * is up to four hours old the moment it opens, so a healthy 4h series always
 * reads in the thousands. The marker is what makes the line glanceable: any
 * `!` means that interval actually missed a bar.
 */
function candleLag(db: ArchiveDatabase, now: number): ReadonlyArray<string> {
  const rows = db.all<{ interval: string; latest: number }>(
    "SELECT interval, MAX(t) AS latest FROM candles GROUP BY interval",
  );
  const latestByInterval = new Map(rows.map((row) => [row.interval, row.latest]));
  return ARCHIVE_INTERVALS.map((interval: ArchiveInterval) => {
    const latest = latestByInterval.get(interval);
    if (latest === undefined) {
      return `${interval}=none!`;
    }
    const behind = now - latest;
    // Two bars of slack: the newest bar is the one in progress, so its open
    // time is already up to one bar old the instant it is written.
    const marker = behind >= 3 * INTERVAL_MS[interval] ? "!" : "";
    return `${interval}=${Math.round(behind / 1_000)}s${marker}`;
  });
}

/**
 * One line a minute: what has been written since start, how far behind the
 * newest bar of each interval is, and what the wire has been doing. Enough to
 * tell at a glance whether the archive is healthy.
 */
export function formatHeartbeat(
  db: ArchiveDatabase,
  counters: ArchiveCounters,
  info: InfoClient,
  now: number,
  startedAt: number,
): string {
  const uptimeMinutes = Math.round((now - startedAt) / 60_000);
  return (
    `heartbeat: up ${uptimeMinutes}m | ` +
    `candles=${counters.candles} funding=${counters.funding} ` +
    `asset_ctx=${counters.assetCtx} book=${counters.bookSummary} gaps=${counters.gaps} | ` +
    `lag ${candleLag(db, now).join(" ")} | ` +
    `req=${info.stats.requests} retry=${info.stats.retries} fail=${info.stats.failures} ` +
    `pace=${Math.round(info.stats.paceMs)}ms`
  );
}

/**
 * Run until the process is stopped.
 *
 * `shouldContinue` is a stop flag, not a counter: it is consulted between
 * backfill steps and funding pages as well as between ticks, so a kill during
 * a cold start ends the process promptly rather than after every page of
 * three years of funding history.
 */
export async function runArchiver(input: {
  readonly db: ArchiveDatabase;
  readonly info: InfoClient;
  readonly shouldContinue: () => boolean;
  readonly sleep: (ms: number) => Promise<void>;
}): Promise<void> {
  const { db, info, shouldContinue, sleep } = input;
  const counters = emptyCounters();
  const startedAt = Date.now();

  // The backfill can take minutes on a cold start, so it checks the stop
  // signal between series and between funding pages: a kill during startup
  // should end the process promptly, not after three years of funding.
  logInfo("archiver: starting backfill");
  await backfillCandles(db, info, counters, Date.now(), shouldContinue);
  await pullFunding(db, info, counters, shouldContinue);
  logInfo("archiver: backfill complete");

  let lastFundingAt = Date.now();

  while (shouldContinue()) {
    const tickStartedAt = Date.now();
    const ts = alignToMinute(tickStartedAt);
    try {
      await pollCandles(db, info, counters, tickStartedAt);
      await pollAssetContexts(db, info, counters, ts);
      await pollBookSummaries(db, info, counters, ts);
      if (tickStartedAt - lastFundingAt >= FUNDING_INTERVAL_MS) {
        await pullFunding(db, info, counters, shouldContinue);
        lastFundingAt = tickStartedAt;
      }
    } catch (error) {
      // The Info client swallows request failures, so reaching here means a
      // write or a decode misbehaved. Log it and keep the loop alive: a
      // stopped archiver loses history that cannot be re-fetched.
      logWarn(`tick failed: ${describeError(error)}`);
    }

    logInfo(formatHeartbeat(db, counters, info, Date.now(), startedAt));

    const elapsed = Date.now() - tickStartedAt;
    await sleep(Math.max(0, POLL_INTERVAL_MS - elapsed));
  }
}
