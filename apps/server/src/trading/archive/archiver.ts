/**
 * The archiver loop.
 *
 * One sequential tick, forever. Every minute it refreshes the tail of each
 * candle series the WS feed cannot vouch for, samples the derivatives context
 * and the top of book, and prints a heartbeat; every half hour it also pulls
 * funding forward from its high-water mark. Candles arrive primarily over the
 * WebSocket feed (`ws.ts`) between ticks; the poll is boot backfill and gap
 * repair. Sequential rather than three timers, so the single-flight Info
 * client is never contended and the log reads in the order things happened.
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
  reconcileKnownGaps,
  recordKnownGap,
  upsertCandles,
} from "./candles.ts";
import type { CandleRow } from "./candles.ts";
import { candleOpensInRange, knownGaps } from "./read.ts";
import type { CandleFeed } from "./ws.ts";
import {
  readArchiveCoinsFromDisk,
  ARCHIVE_DATA_PROVIDER_ID,
  ARCHIVE_INTERVALS,
  ARCHIVE_VENUE,
  CANDLE_WINDOW_BARS,
  FUNDING_INTERVAL_MS,
  FUNDING_ORIGIN_MS,
  FUNDING_PAGE_ROWS,
  HYDRATION_WRITER_SLICE_MS,
  hydrationRequestsPath,
  INTERVAL_MS,
  POLL_INTERVAL_MS,
  POLL_TAIL_BARS,
  type ArchiveInterval,
} from "./config.ts";
import {
  assessWindowCoverage,
  claimHydrationBatch,
  classifyHydrationOutcome,
  hydrationQueueHasLiveRequests,
  HYDRATION_VENUES,
  loadHydrationQueue,
  makeHydrationFileWatcher,
  planHydrationFetches,
  providerReachFloor,
  recordHydrationResult,
  storeHydrationQueue,
  withHydrationQueueLock,
  type HydrationQueue,
  type HydrationRequest,
  type HydrationResult,
} from "./hydration.ts";
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
 *
 * `betweenUnits`, when given, runs after each coin+interval series — one
 * bounded provider call — with the database free. The archiver passes the
 * hydration drain there during cold start, so a live request is serviced
 * between backfill units rather than after a startup that can outlast the
 * request's deadline. The hook is awaited and sequential: no second writer,
 * no concurrent archive access, and `shouldContinue` stays the only stop
 * signal.
 */
export async function backfillCandles(
  db: ArchiveDatabase,
  info: InfoClient,
  counters: ArchiveCounters,
  now: number,
  shouldContinue: () => boolean,
  coins: ReadonlyArray<string>,
  venue: string = ARCHIVE_VENUE,
  betweenUnits?: () => Promise<void>,
): Promise<void> {
  for (const coin of coins) {
    for (const interval of ARCHIVE_INTERVALS) {
      if (!shouldContinue()) {
        return;
      }
      const intervalMs = INTERVAL_MS[interval];
      const plan = planCandleRepair({
        latestStoredOpen: latestStoredOpen(db, coin, interval, venue),
        now,
        intervalMs,
        windowBars: CANDLE_WINDOW_BARS,
      });

      if (plan.unrecoverable !== null) {
        recordKnownGap(
          db,
          {
            coin,
            interval,
            fromT: plan.unrecoverable.fromT,
            toT: plan.unrecoverable.toT,
            recordedAt: now,
          },
          venue,
        );
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
      counters.candles += upsertCandles(db, rows, venue);
      logInfo(`backfill: ${coin} ${interval} ${rows.length} bars`);
      if (betweenUnits !== undefined) {
        await betweenUnits();
      }
    }
  }
}

/**
 * Refresh the trailing bars of every series the WS feed cannot vouch for,
 * including the bar in progress. With no feed, every series is polled — the
 * pre-WS behavior, and the fallback whenever the socket is down.
 */
export async function pollCandles(
  db: ArchiveDatabase,
  info: InfoClient,
  counters: ArchiveCounters,
  now: number,
  coins: ReadonlyArray<string>,
  feed: CandleFeed | null = null,
  venue: string = ARCHIVE_VENUE,
): Promise<void> {
  for (const coin of coins) {
    for (const interval of ARCHIVE_INTERVALS) {
      if (feed !== null && !feed.shouldPoll(coin, interval, now)) {
        continue;
      }
      const intervalMs = INTERVAL_MS[interval];
      const currentOpen = Math.floor(now / intervalMs) * intervalMs;
      const startTime = currentOpen - (POLL_TAIL_BARS[interval] - 1) * intervalMs;
      const raw = await info.post("candleSnapshot", candleSnapshotBody(coin, interval, startTime));
      counters.candles += upsertCandles(db, parseCandles(raw, coin, interval), venue);
      feed?.markPolled(coin, interval);
    }
  }
}

/**
 * Page funding forward from each coin's stored high-water mark. A cold start
 * can walk years of pages, so `betweenUnits` — the hydration drain during
 * startup — runs after each page for the same deadline reason as the candle
 * backfill's hook.
 */
export async function pullFunding(
  db: ArchiveDatabase,
  info: InfoClient,
  counters: ArchiveCounters,
  shouldContinue: () => boolean,
  coins: ReadonlyArray<string>,
  venue: string = ARCHIVE_VENUE,
  betweenUnits?: () => Promise<void>,
): Promise<void> {
  for (const coin of coins) {
    const stored = latestFundingTime(db, coin, venue);
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
      counters.funding += upsertFunding(db, rows, venue);

      const newest = rows.reduce((max, row) => Math.max(max, row.time), cursor);
      if (newest < cursor || rows.length < FUNDING_PAGE_ROWS) {
        break;
      }
      cursor = newest + 1;
      if (betweenUnits !== undefined) {
        await betweenUnits();
      }
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
  venue: string = ARCHIVE_VENUE,
): Promise<void> {
  const raw = await info.post("metaAndAssetCtxs", { type: "metaAndAssetCtxs" });
  // The whole universe, not just the followed coins: the call already carries
  // every listed asset, so an asset nobody follows still accumulates the OI and
  // funding history that makes it worth looking at later.
  counters.assetCtx += upsertAssetContexts(db, parseAssetContexts(raw, null, ts), venue);
}

/** Sample the top of book and the depth behind it, one call per coin. */
export async function pollBookSummaries(
  db: ArchiveDatabase,
  info: InfoClient,
  counters: ArchiveCounters,
  ts: number,
  coins: ReadonlyArray<string>,
  venue: string = ARCHIVE_VENUE,
): Promise<void> {
  for (const coin of coins) {
    const raw = await info.post("l2Book", { type: "l2Book", coin });
    const row = summariseBook(raw, coin, ts);
    if (row !== null) {
      counters.bookSummary += upsertBookSummaries(db, [row], venue);
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
function candleLag(db: ArchiveDatabase, now: number, venue: string): ReadonlyArray<string> {
  const rows = db.all<{ interval: string; latest: number }>(
    "SELECT interval, MAX(t) AS latest FROM candles WHERE venue = ? GROUP BY interval",
    venue,
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
  venue: string = ARCHIVE_VENUE,
): string {
  const uptimeMinutes = Math.round((now - startedAt) / 60_000);
  return (
    `heartbeat: up ${uptimeMinutes}m | ` +
    `candles=${counters.candles} funding=${counters.funding} ` +
    `asset_ctx=${counters.assetCtx} book=${counters.bookSummary} gaps=${counters.gaps} | ` +
    `lag ${candleLag(db, now, venue).join(" ")} | ` +
    `req=${info.stats.requests} retry=${info.stats.retries} fail=${info.stats.failures} ` +
    `pace=${Math.round(info.stats.paceMs)}ms`
  );
}

/**
 * Fetch exactly one requested window from the one provider's candle endpoint,
 * through the same validated parser and archive upsert the recorder uses, and
 * nothing else: one series, one bounded call, rows clipped to the window so
 * the evidence they feed is truthful. The caller has already validated the
 * window against the request caps; the fetch itself stays bounded by the
 * provider's own page and never reaches for another interval or endpoint.
 *
 * `failure` is set only when the endpoint did not answer at all; an empty
 * successful response is an answer — it means the market's own history does
 * not reach the window.
 */
export async function fetchExactCandleWindow(
  db: ArchiveDatabase,
  info: InfoClient,
  request: {
    readonly coin: string;
    readonly interval: string;
    readonly fromT: number;
    readonly toT: number;
  },
  now: number,
  venue: string,
): Promise<{ readonly rows: ReadonlyArray<CandleRow>; readonly failure: string | null }> {
  const floor = providerReachFloor(request.interval, now);
  const fetchFrom = floor === null ? request.fromT : Math.max(request.fromT, floor);
  if (fetchFrom > request.toT) {
    // Nothing inside the provider's reach: no call at all, and the caller's
    // assessment names the exhaustion.
    return { rows: [], failure: null };
  }
  // The fetch's endTime is the wanted last bar's CLOSE (open + width - 1):
  // under either reading of the endpoint's bounds — bars by open time or by
  // close time — that returns exactly the bars whose opens fall in the
  // requested window, and the clip below drops anything else it may add.
  const intervalMs = INTERVAL_MS[request.interval as keyof typeof INTERVAL_MS];
  const raw = await info.post(
    "candleSnapshot",
    candleSnapshotBody(request.coin, request.interval, fetchFrom, request.toT + intervalMs - 1),
  );
  if (raw === null) {
    return { rows: [], failure: "the candle endpoint did not answer" };
  }
  const rows = parseCandles(raw, request.coin, request.interval).filter(
    (row) => row.t >= fetchFrom && row.t <= request.toT,
  );
  upsertCandles(db, rows, venue);
  return { rows, failure: null };
}

/** One request's coverage assessment inputs, read off the writer's own database. */
const assessRequestCoverage = (
  db: ArchiveDatabase,
  request: HydrationRequest,
  venue: string,
  now: number,
) =>
  assessWindowCoverage({
    intervalMs: INTERVAL_MS[request.interval as keyof typeof INTERVAL_MS],
    fromT: request.fromT,
    toT: request.toT,
    now,
    archivedOpens: candleOpensInRange(
      db,
      request.coin,
      request.interval,
      request.fromT,
      request.toT,
      venue,
    ),
    providerFloor: providerReachFloor(request.interval, now),
    gaps: knownGaps(db, request.coin, request.interval, venue),
  });

/**
 * Drain on-demand hydration requests: the sole archive writer fetching the
 * exact windows readers named, once each, and answering every request id.
 *
 * Two locked phases with the fetches in between (the network may not hold the
 * lock): phase one claims its batch and answers what needs no fetch; phase
 * two fetches each coalesced group once, reconciles gap records against what
 * landed, and merges per-request results into whatever the queue holds by
 * then — a producer that enqueued mid-fetch loses nothing.
 */
async function drainHydrationRequests(
  db: ArchiveDatabase,
  info: InfoClient,
  counters: ArchiveCounters,
  shouldContinue: () => boolean,
  venue: string,
  path: string,
): Promise<void> {
  const claimed = withHydrationQueueLock(path, () => {
    const loaded = loadHydrationQueue(path);
    if (loaded.status === "unusable") {
      logWarn(`archiver: hydration queue unreadable (${loaded.reason}); leaving it untouched`);
      return null;
    }
    const queue = loaded.queue;
    const { batch, rest, expired } = claimHydrationBatch(queue, Date.now());
    if (batch.length === 0 && expired.length === 0 && queue.results.length === 0) return [];
    let next: HydrationQueue = { requests: rest, results: queue.results };
    for (const request of expired) {
      next = recordHydrationResult(next, {
        id: request.id,
        outcome: "timed_out",
        finishedAt: Date.now(),
        reason: "the deadline passed before the writer reached this request",
      });
    }
    // Requests this writer cannot serve honestly are answered here, without a
    // fetch: venue isolation is absolute, and a window older than the one
    // provider's reach can never be recovered.
    const fetchable: HydrationRequest[] = [];
    for (const request of batch) {
      if (
        (HYDRATION_VENUES as readonly string[]).includes(request.venue) !== true ||
        request.venue !== venue
      ) {
        next = recordHydrationResult(next, {
          id: request.id,
          outcome: "unsupported",
          finishedAt: Date.now(),
          reason: `this writer records ${venue}; it will not write ${request.venue} rows`,
        });
        continue;
      }
      const floor = providerReachFloor(request.interval, Date.now());
      if (floor !== null && request.toT < floor) {
        next = recordHydrationResult(next, {
          id: request.id,
          outcome: "source_window_exhausted",
          finishedAt: Date.now(),
          reason:
            `older than ${ARCHIVE_DATA_PROVIDER_ID} still serves; a second price source is a decision ` +
            "recorded in docs/internals, not a fetch away",
        });
        continue;
      }
      fetchable.push(request);
    }
    try {
      storeHydrationQueue(path, next);
    } catch (error) {
      logWarn(`archiver: could not rewrite the hydration queue: ${describeError(error)}`);
      return null;
    }
    return fetchable;
  });
  if (!claimed.ok || claimed.value === null) return;
  const batch = claimed.value;
  if (batch.length === 0) return;

  const results: HydrationResult[] = [];
  for (const group of planHydrationFetches(batch)) {
    if (!shouldContinue()) break;
    const intervalMs = INTERVAL_MS[group.interval as keyof typeof INTERVAL_MS];
    // The before-assessment is what makes `already_covered` legal only for a
    // window that pre-existed this attempt, and `hydrated` only for one this
    // attempt finished — re-served rows can never masquerade as a recovery.
    const before = new Map(
      group.requests.map((request) => [
        request.id,
        assessRequestCoverage(db, request, venue, Date.now()),
      ]),
    );
    const fetch = await fetchExactCandleWindow(db, info, group, Date.now(), venue);
    counters.candles += fetch.rows.length;
    if (fetch.failure === null) {
      reconcileKnownGaps(
        db,
        {
          coin: group.coin,
          interval: group.interval,
          intervalMs,
          fromT: group.fromT,
          toT: group.toT,
        },
        venue,
      );
    }
    const firstServedT = fetch.rows[0]?.t ?? null;
    const afterNow = Date.now();
    for (const request of group.requests) {
      const after = assessRequestCoverage(db, request, venue, afterNow);
      const barsFetched = fetch.rows.filter(
        (row) => row.t >= request.fromT && row.t <= request.toT,
      ).length;
      const { outcome, reason } = classifyHydrationOutcome({
        after,
        completeBefore: before.get(request.id)?.complete ?? false,
        barsFetched,
        effectiveFloorT:
          firstServedT === null
            ? providerReachFloor(request.interval, afterNow)
            : Math.max(providerReachFloor(request.interval, afterNow) ?? -Infinity, firstServedT),
        emptySuccessfulResponse: fetch.failure === null && fetch.rows.length === 0,
        ...(fetch.failure === null
          ? {}
          : { error: fetch.failure, rateLimited: info.lastFailureWasRateLimit() }),
      });
      results.push({
        id: request.id,
        outcome,
        finishedAt: Date.now(),
        barsFetched,
        ...(reason === null ? {} : { reason }),
      });
      logInfo(
        `archiver: hydration ${outcome} for ${request.coin} ${request.interval} ` +
          `[${request.fromT}-${request.toT}] (${barsFetched} bars)`,
      );
    }
  }

  const merged = withHydrationQueueLock(path, () => {
    const loaded = loadHydrationQueue(path);
    if (loaded.status === "unusable") {
      logWarn(
        `archiver: hydration queue unreadable after fetching (${loaded.reason}); results not recorded`,
      );
      return null;
    }
    let queue = loaded.queue;
    for (const result of results) {
      queue = recordHydrationResult(queue, result);
    }
    try {
      storeHydrationQueue(path, queue);
    } catch (error) {
      logWarn(`archiver: could not rewrite the hydration queue: ${describeError(error)}`);
      return null;
    }
    return queue;
  });
  if (merged.ok && merged.value === null) {
    logWarn(
      "archiver: hydration results from this drain could not be recorded; waiters will time out honestly",
    );
  }
}

export async function runArchiver(input: {
  readonly db: ArchiveDatabase;
  readonly info: InfoClient;
  readonly shouldContinue: () => boolean;
  readonly sleep: (ms: number) => Promise<void>;
  /** The coins to record, re-read each tick. Defaults to the control file. */
  readonly readCoins?: () => ReadonlyArray<string>;
  /**
   * Builds the WS candle feed, handed the upsert it should drive. Optional so
   * tests (and a build that wants polling only) can run without a socket;
   * with no feed, every series is polled every tick as before.
   */
  readonly makeFeed?: (onCandle: (row: CandleRow) => void) => CandleFeed;
  /** The venue stamped on every row this run writes. Defaults to mainnet. */
  readonly venue?: string;
  /** The hydration queue path to watch and drain. Defaults to the real one. */
  readonly hydrationPath?: string;
  /** The poll cadence, overridable so tests can exercise the wake path fast. */
  readonly tickIntervalMs?: number;
}): Promise<void> {
  const { db, info, shouldContinue, sleep } = input;
  const readCoins = input.readCoins ?? readArchiveCoinsFromDisk;
  const venue = input.venue ?? ARCHIVE_VENUE;
  const hydrationPath = input.hydrationPath ?? hydrationRequestsPath();
  const tickIntervalMs = input.tickIntervalMs ?? POLL_INTERVAL_MS;
  const counters = emptyCounters();
  const startedAt = Date.now();
  const feed =
    input.makeFeed?.((row) => {
      counters.candles += upsertCandles(db, [row], venue);
    }) ?? null;

  // The queue file's own writes are this writer's alarm clock: a producer's
  // atomic rename wakes the watcher at once, so a live request is drained in
  // milliseconds rather than at the next 60-second poll. When no watcher can
  // be installed the wait degrades to bounded slices, each at most
  // HYDRATION_WRITER_SLICE_MS — half a request's maximum wait — with a queue
  // peek between slices, so a live request is still observed comfortably
  // before its deadline. Either way the 60-second poll cadence is untouched.
  const watcher = makeHydrationFileWatcher(hydrationPath);
  const waitUntil = async (tickEndAt: number): Promise<void> => {
    for (;;) {
      if (!shouldContinue()) return;
      const remaining = tickEndAt - Date.now();
      if (remaining <= 0) return;
      const slice = Math.min(remaining, HYDRATION_WRITER_SLICE_MS);
      // Raced against the injected sleep so tests with instant sleeps stay
      // instant; in production the sleep is the same wall-clock bound the
      // watcher would have enforced anyway.
      const woken =
        watcher === null
          ? (await sleep(slice), false)
          : await Promise.race([
              sleep(slice).then(() => false as const),
              watcher.waitOrTimeout(slice),
            ]);
      if (woken) return;
      // The peek runs even with a healthy watcher: a reader waiting on its
      // own answer also watches this directory, and FSEvents can starve one
      // of two watchers of an event. The peek bounds that hole to one slice
      // — the same bound the watcher-less fallback already promised.
      if (hydrationQueueHasLiveRequests(hydrationPath, Date.now())) return;
    }
  };

  try {
    // The backfill can take minutes on a cold start — longer than a
    // hydration request may wait — so the drain also runs between every
    // bounded startup unit (one candle series, one funding page), and once
    // before the backfill begins. A request that arrives during cold start is
    // serviced within a unit or two, well inside its deadline, and the
    // backfill simply resumes: sequential awaits, one writer, and the stop
    // signal stays the only stop signal.
    const drainNow = (): Promise<void> =>
      drainHydrationRequests(db, info, counters, shouldContinue, venue, hydrationPath);
    let coins = readCoins();
    feed?.setCoins(coins);
    logInfo(`archiver: starting backfill for ${coins.join(" ")}`);
    await drainNow();
    await backfillCandles(db, info, counters, Date.now(), shouldContinue, coins, venue, drainNow);
    await pullFunding(db, info, counters, shouldContinue, coins, venue, drainNow);
    logInfo("archiver: backfill complete");

    let lastFundingAt = Date.now();
    const hydrated = new Set(coins);

    while (shouldContinue()) {
      const tickStartedAt = Date.now();
      const ts = alignToMinute(tickStartedAt);
      try {
        // Re-read attention every tick. Following an asset has to start
        // recording it now — a user who adds it to their watchlist and opens
        // its chart is asking a question about the next few minutes.
        coins = readCoins();
        feed?.setCoins(coins);
        const fresh = coins.filter((coin) => !hydrated.has(coin));
        if (fresh.length > 0) {
          logInfo(`archiver: hydrating ${fresh.join(" ")}`);
          await backfillCandles(
            db,
            info,
            counters,
            tickStartedAt,
            shouldContinue,
            fresh,
            venue,
            drainNow,
          );
          await pullFunding(db, info, counters, shouldContinue, fresh, venue, drainNow);
          for (const coin of fresh) hydrated.add(coin);
        }
        // On-demand hydration: a reader queued a window the archive has not
        // covered but the one provider can still serve (a study over dates
        // from before recording began, a backtest on a newly followed coin).
        // Only this process writes the archive, so only this process may act;
        // the batch is bounded per tick, every request keeps its stable id
        // until a terminal result answers it, and a request older than the
        // provider's reach is answered with the decision named, because a
        // second data provider is a choice this product has not made.
        await drainHydrationRequests(db, info, counters, shouldContinue, venue, hydrationPath);
        await pollCandles(db, info, counters, tickStartedAt, coins, feed, venue);
        await pollAssetContexts(db, info, counters, ts, venue);
        await pollBookSummaries(db, info, counters, ts, coins, venue);
        if (tickStartedAt - lastFundingAt >= FUNDING_INTERVAL_MS) {
          await pullFunding(db, info, counters, shouldContinue, coins, venue);
          lastFundingAt = tickStartedAt;
        }
      } catch (error) {
        // The Info client swallows request failures, so reaching here means a
        // write or a decode misbehaved. Log it and keep the loop alive: a
        // stopped archiver loses history that cannot be re-fetched.
        logWarn(`tick failed: ${describeError(error)}`);
      }

      logInfo(formatHeartbeat(db, counters, info, Date.now(), startedAt, venue));

      await waitUntil(tickStartedAt + tickIntervalMs);
    }
  } finally {
    watcher?.close();
    feed?.close();
  }
}
