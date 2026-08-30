/**
 * The loop, against a fake Info client and a real temp database.
 *
 * What is worth pinning is the operational promise: killing the archiver and
 * starting it again is a supported way to run it. So a cold start backfills
 * every series, a restart after a short outage repairs itself silently, a
 * restart after a long one writes down exactly what it can no longer reach,
 * and two ticks inside the same minute leave one sample rather than two.
 *
 * No network — `fakeInfo` answers every request from synthetic JSON.
 */
// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - temp files, real clock, and the fake clock the loop is handed.
import { assert, describe, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { alignToMinute, emptyCounters, formatHeartbeat, runArchiver } from "./archiver.ts";
import {
  ARCHIVE_INTERVALS,
  CANDLE_WINDOW_BARS,
  HYDRATION_MAX_WAIT_MS,
  HYDRATION_WRITER_SLICE_MS,
  INTERVAL_MS,
  TESTNET_ARCHIVE_VENUE,
  type ArchiveInterval,
} from "./config.ts";

/** Fire a gate promise resolver that the test has proven armed. */
const fire = (gate: (() => void) | null): void => {
  if (gate === null) throw new Error("the gate was never armed");
  gate();
};
import { openArchiveDatabase, type ArchiveDatabase } from "./db.ts";
import type { InfoClient } from "./info.ts";
import { recordKnownGap, upsertCandles, type CandleRow } from "./candles.ts";
import type { CandleFeed } from "./ws.ts";
import {
  gridOpens,
  loadHydrationQueue,
  makeHydrationFileWatcher,
  storeHydrationQueue,
  type HydrationRequest,
} from "./hydration.ts";

const MINUTE = 60_000;

/** The coins every loop test records — pinned here so no test reads the real
 * follow file on the machine running it. */
const COINS = ["BTC", "ETH", "SOL"] as const;

/** One stored bar for a given interval; the caller sets `t`. */
const bar = (interval: string) => ({
  coin: "BTC",
  interval,
  t: 0,
  tClose: 1,
  o: 1,
  h: 1,
  l: 1,
  c: 1,
  v: 1,
  n: 1,
});

/**
 * A temp archive directory whose lifetime spans the whole (possibly async)
 * body: the cleanup waits for the body's promise, so a test that writes and
 * reads files mid-flight — the hydration queue especially — still has its
 * directory when it needs it.
 */
const withArchivePath = async <A>(use: (path: string) => A | Promise<A>): Promise<A> => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "market-archive-loop-"));
  try {
    return await use(NodePath.join(dir, "archive.sqlite"));
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
};

/**
 * Answers every Info body the archiver sends. Candles come back as three
 * bars ending at the requested window's close, which is enough to prove the
 * write path without simulating five thousand of them.
 */
function fakeInfo(): InfoClient & { readonly calls: Array<string> } {
  const calls: Array<string> = [];
  return {
    calls,
    stats: { requests: 0, failures: 0, retries: 0, paceMs: 200 },
    lastFailureWasRateLimit: () => false,
    post: (operation, body) => {
      calls.push(operation);
      if (operation === "candleSnapshot") {
        const request = (body as { req: { coin: string; interval: string; startTime: number } })
          .req;
        const step = INTERVAL_MS[request.interval as keyof typeof INTERVAL_MS];
        const first = Math.floor(request.startTime / step) * step;
        return Promise.resolve(
          [0, 1, 2].map((index) => ({
            t: first + index * step,
            T: first + (index + 1) * step - 1,
            s: request.coin,
            i: request.interval,
            o: "100.0",
            h: "101.0",
            l: "99.0",
            c: "100.5",
            v: "1.0",
            n: 3,
          })),
        );
      }
      if (operation === "fundingHistory") {
        const coin = (body as { coin: string }).coin;
        const startTime = (body as { startTime: number }).startTime;
        return Promise.resolve([
          { coin, time: startTime, fundingRate: "0.0001", premium: "0.0002" },
        ]);
      }
      if (operation === "metaAndAssetCtxs") {
        return Promise.resolve([
          { universe: COINS.map((name) => ({ name })) },
          COINS.map(() => ({
            funding: "0.00001",
            openInterest: "1000.0",
            premium: "-0.0001",
            oraclePx: "100.0",
            markPx: "100.1",
            dayNtlVlm: "1000000.0",
          })),
        ]);
      }
      if (operation === "l2Book") {
        return Promise.resolve({
          coin: (body as { coin: string }).coin,
          time: Date.now(),
          levels: [[{ px: "99.9", sz: "1.0", n: 1 }], [{ px: "100.1", sz: "2.0", n: 1 }]],
        });
      }
      return Promise.resolve(null);
    },
  };
}

/**
 * Run the loop for exactly `ticks` iterations, with no real waiting.
 *
 * The countdown hangs off `sleep`, which the loop's between-tick wait races
 * against the hydration watcher, because `shouldContinue` is a flag the
 * archiver also consults during the backfill — counting its calls would end
 * the run mid-startup. The hydration queue is always a temp path so no test
 * watches or writes the machine's real state directory.
 */
async function runTicks(
  db: ArchiveDatabase,
  info: InfoClient,
  ticks: number,
  makeFeed?: (onCandle: (row: CandleRow) => void) => CandleFeed,
  venue?: string,
  hydrationPath?: string,
  readCoins?: () => readonly string[],
): Promise<void> {
  const ownedTemp =
    hydrationPath === undefined
      ? NodePath.join(
          NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-hydration-ticks-")),
          "queue.json",
        )
      : null;
  let remaining = ticks;
  try {
    await runArchiver({
      db,
      info,
      shouldContinue: () => remaining > 0,
      sleep: () => {
        remaining -= 1;
        return Promise.resolve();
      },
      readCoins: readCoins ?? (() => COINS),
      hydrationPath: hydrationPath ?? (ownedTemp as string),
      ...(makeFeed === undefined ? {} : { makeFeed }),
      ...(venue === undefined ? {} : { venue }),
    });
  } finally {
    if (ownedTemp !== null) {
      NodeFS.rmSync(NodePath.dirname(ownedTemp), { recursive: true, force: true });
    }
  }
}

describe("formatHeartbeat", () => {
  it("marks only the intervals that have actually missed a bar", async () => {
    await withArchivePath(async (path) => {
      const db = openArchiveDatabase(path);
      const now = 10_000 * MINUTE;
      // A 1m bar one minute old is healthy; a 4h bar four hours old is too,
      // because the newest 4h bar is the one still in progress. Only the 5m
      // series here has genuinely fallen behind.
      upsertCandles(db, [
        { ...bar("1m"), t: now - MINUTE },
        { ...bar("5m"), t: now - 60 * MINUTE },
        { ...bar("4h"), t: now - 4 * 60 * MINUTE },
      ]);

      const line = formatHeartbeat(db, emptyCounters(), fakeInfo(), now, now - 5 * MINUTE);
      assert.match(line, /1m=60s /);
      assert.match(line, /5m=3600s!/);
      assert.match(line, /4h=14400s /);
      // Intervals with nothing recorded are called out rather than omitted.
      assert.match(line, /1d=none!/);
      db.close();
    });
  });
});

describe("runArchiver", () => {
  it("backfills every tracked series before its first tick", async () => {
    await withArchivePath(async (path) => {
      const db = openArchiveDatabase(path);
      const info = fakeInfo();
      await runTicks(db, info, 1);

      const series = db.all<{ total: number }>(
        "SELECT COUNT(*) AS total FROM (SELECT DISTINCT coin, interval FROM candles)",
      );
      assert.strictEqual(series[0]?.total, COINS.length * ARCHIVE_INTERVALS.length);

      const funding = db.all<{ total: number }>("SELECT COUNT(*) AS total FROM funding");
      assert.strictEqual(funding[0]?.total, COINS.length);
      db.close();
    });
  });

  it("samples context and book once per minute however many ticks run in it", async () => {
    await withArchivePath(async (path) => {
      const db = openArchiveDatabase(path);
      await runTicks(db, fakeInfo(), 3);

      // Three ticks with no waiting all land in the same wall-clock minute, so
      // the minute-aligned key collapses them onto one sample per coin.
      const contexts = db.all<{ total: number }>("SELECT COUNT(*) AS total FROM asset_ctx");
      assert.strictEqual(contexts[0]?.total, COINS.length);
      const books = db.all<{ total: number }>("SELECT COUNT(*) AS total FROM book_summary");
      assert.strictEqual(books[0]?.total, COINS.length);

      const sampled = db.all<{ ts: number }>("SELECT DISTINCT ts FROM asset_ctx");
      assert.strictEqual(sampled[0]?.ts, alignToMinute(sampled[0]?.ts ?? 0));
      db.close();
    });
  });

  it("stamps every table with the venue the run was given", async () => {
    // R5-1: the supervised archiver records the venue actually traded. A run
    // handed the testnet venue must write it on every row, everywhere.
    await withArchivePath(async (path) => {
      const db = openArchiveDatabase(path);
      await runTicks(db, fakeInfo(), 1, undefined, TESTNET_ARCHIVE_VENUE);

      for (const table of ["candles", "funding", "asset_ctx", "book_summary"]) {
        const venues = db.all<{ venue: string }>(`SELECT DISTINCT venue FROM ${table}`);
        assert.deepStrictEqual(venues, [{ venue: TESTNET_ARCHIVE_VENUE }], table);
      }
      db.close();
    });
  });

  it("restarting on top of an existing archive adds no duplicates", async () => {
    await withArchivePath(async (path) => {
      const first = openArchiveDatabase(path);
      await runTicks(first, fakeInfo(), 1);
      const after = first.all<{ total: number }>("SELECT COUNT(*) AS total FROM candles")[0]?.total;
      first.close();

      const second = openArchiveDatabase(path);
      await runTicks(second, fakeInfo(), 1);
      const again = second.all<{ total: number }>("SELECT COUNT(*) AS total FROM candles")[0]
        ?.total;
      assert.strictEqual(again, after);
      assert.deepStrictEqual(second.all("SELECT * FROM known_gaps"), []);
      second.close();
    });
  });

  it("records what fell out of the API window during a long outage", async () => {
    await withArchivePath(async (path) => {
      const db = openArchiveDatabase(path);
      // A 1m bar from well before the servable window: the archiver was down
      // for longer than 5000 minutes and those bars are gone for good.
      const strandedOpen =
        Math.floor(Date.now() / MINUTE) * MINUTE - (CANDLE_WINDOW_BARS + 500) * MINUTE;
      upsertCandles(db, [
        {
          coin: "BTC",
          interval: "1m",
          t: strandedOpen,
          tClose: strandedOpen + MINUTE - 1,
          o: 1,
          h: 1,
          l: 1,
          c: 1,
          v: 1,
          n: 1,
        },
      ]);

      await runTicks(db, fakeInfo(), 1);

      const gaps = db.all<{ coin: string; interval: string; from_t: number; to_t: number }>(
        "SELECT coin, interval, from_t, to_t FROM known_gaps",
      );
      assert.strictEqual(gaps.length, 1);
      assert.strictEqual(gaps[0]?.coin, "BTC");
      assert.strictEqual(gaps[0]?.interval, "1m");
      assert.strictEqual(gaps[0]?.from_t, strandedOpen + MINUTE);
      db.close();
    });
  });

  it("keeps recording when the exchange returns nothing at all", async () => {
    await withArchivePath(async (path) => {
      const db = openArchiveDatabase(path);
      const dead: InfoClient = {
        stats: { requests: 0, failures: 0, retries: 0, paceMs: 200 },
        post: () => Promise.resolve(null),
        lastFailureWasRateLimit: () => false,
      };
      await runTicks(db, dead, 2);

      // Nothing written, nothing thrown, and the loop still completed both
      // ticks — a failing endpoint must not end the recording.
      assert.strictEqual(
        db.all<{ total: number }>("SELECT COUNT(*) AS total FROM candles")[0]?.total,
        0,
      );
      db.close();
    });
  });

  it("skips the candle poll for series the feed vouches for", async () => {
    await withArchivePath(async (path) => {
      const db = openArchiveDatabase(path);
      const info = fakeInfo();
      const polled: Array<string> = [];
      const healthy: CandleFeed = {
        setCoins: () => undefined,
        shouldPoll: () => false,
        markPolled: (coin, interval) => polled.push(`${coin} ${interval}`),
        close: () => undefined,
      };
      await runTicks(db, info, 2, () => healthy);

      // The backfill still fetched every series once; the two ticks added no
      // candleSnapshot calls because the feed vouched for every series.
      const snapshots = info.calls.filter((call) => call === "candleSnapshot").length;
      assert.strictEqual(snapshots, COINS.length * ARCHIVE_INTERVALS.length);
      assert.deepStrictEqual(polled, []);
      db.close();
    });
  });

  it("polls exactly the series the feed cannot vouch for, and reports them back", async () => {
    await withArchivePath(async (path) => {
      const db = openArchiveDatabase(path);
      const info = fakeInfo();
      const polled: Array<string> = [];
      const feed: CandleFeed = {
        setCoins: () => undefined,
        // One unhealthy series; everything else rides the socket.
        shouldPoll: (coin, interval) => coin === "ETH" && interval === "5m",
        markPolled: (coin, interval) => polled.push(`${coin} ${interval}`),
        close: () => undefined,
      };
      const backfillCalls = COINS.length * ARCHIVE_INTERVALS.length;
      await runTicks(db, info, 1, () => feed);

      const snapshots = info.calls.filter((call) => call === "candleSnapshot").length;
      assert.strictEqual(snapshots, backfillCalls + 1);
      assert.deepStrictEqual(polled, ["ETH 5m"]);
      db.close();
    });
  });

  it("feeds the WS candles into the same table the poller writes", async () => {
    await withArchivePath(async (path) => {
      const db = openArchiveDatabase(path);
      let deliver: ((row: CandleRow) => void) | null = null;
      const feed: CandleFeed = {
        setCoins: () => undefined,
        shouldPoll: () => false,
        markPolled: () => undefined,
        close: () => undefined,
      };
      const dead: InfoClient = {
        stats: { requests: 0, failures: 0, retries: 0, paceMs: 200 },
        post: () => Promise.resolve(null),
        lastFailureWasRateLimit: () => false,
      };
      await runTicks(db, dead, 1, (onCandle) => {
        deliver = onCandle;
        return feed;
      });
      // The loop has ended, but the wiring is what is under test: a candle
      // handed to the feed's callback lands as an ordinary upsert.
      assert.isNotNull(deliver);
      (deliver as unknown as (row: CandleRow) => void)({ ...bar("1m"), t: 60_000 });
      const rows = db.all<{ total: number }>("SELECT COUNT(*) AS total FROM candles");
      assert.strictEqual(rows[0]?.total, 1);
      db.close();
    });
  });
});

// ---------------------------------------------------------------------------
// on-demand hydration: the sole writer drains the queue
// ---------------------------------------------------------------------------

/** One 1m-window request aligned to the real clock, inside the provider's reach. */
const liveRequest = (overrides?: Partial<HydrationRequest>): HydrationRequest => {
  const minuteNow = Math.floor(Date.now() / MINUTE) * MINUTE;
  return {
    id: "hr-1",
    venue: "hyperliquid",
    coin: "ETH",
    interval: "1m",
    fromT: minuteNow - 60 * MINUTE,
    toT: minuteNow - 30 * MINUTE,
    purpose: "study",
    requestedAt: Date.now(),
    deadlineAt: Date.now() + 25_000,
    ...overrides,
  };
};

/** The wire shape `parseCandles` accepts, for one bar. */
const wireBar = (coin: string, interval: string, open: number, step: number) => ({
  t: open,
  T: open + step - 1,
  s: coin,
  i: interval,
  o: "100.0",
  h: "101.0",
  l: "99.0",
  c: "100.5",
  v: "1.0",
  n: 3,
});

/**
 * An Info client that answers `candleSnapshot` with the grid bars of the
 * requested window the caller chooses, and nothing for any other call — with
 * `readCoins: () => []`, the only candleSnapshot a tick makes is a hydration
 * fetch, so the bodies it records are exactly what the writer asked the
 * provider for.
 */
const hydrationInfo = (
  serve: (req: { coin: string; interval: string; startTime: number; endTime?: number }) => number[],
): InfoClient & { readonly bodies: Array<Record<string, unknown>> } => {
  const bodies: Array<Record<string, unknown>> = [];
  return {
    bodies,
    stats: { requests: 0, failures: 0, retries: 0, paceMs: 200 },
    lastFailureWasRateLimit: () => false,
    post: (operation, body) => {
      if (operation !== "candleSnapshot") return Promise.resolve(null);
      const req = (
        body as { req: { coin: string; interval: string; startTime: number; endTime?: number } }
      ).req;
      bodies.push({ ...req });
      const step = INTERVAL_MS[req.interval as keyof typeof INTERVAL_MS];
      return Promise.resolve(serve(req).map((open) => wireBar(req.coin, req.interval, open, step)));
    },
  };
};

/** Serve every grid bar in the requested window — the healthy provider. */
const serveGrid = (req: { startTime: number; endTime?: number; interval: string }) =>
  gridOpens(
    req.startTime,
    req.endTime ?? req.startTime,
    INTERVAL_MS[req.interval as keyof typeof INTERVAL_MS],
  ).slice();

const queueAfter = (hydrationPath: string) => {
  const loaded = loadHydrationQueue(hydrationPath);
  assert.strictEqual(loaded.status, "ok");
  if (loaded.status !== "ok") throw new Error(loaded.reason);
  return loaded.queue;
};

describe("the sole writer drains hydration requests", () => {
  it("fetches exactly the requested venue, coin, interval, and window — one call", async () => {
    await withArchivePath(async (path) => {
      const db = openArchiveDatabase(path);
      const hydrationPath = `${path}.hydration.json`;
      const info = hydrationInfo(serveGrid);
      const request = liveRequest();
      storeHydrationQueue(hydrationPath, { requests: [request], results: [] });

      await runTicks(db, info, 1, undefined, undefined, hydrationPath, () => []);

      // One candleSnapshot, naming the request's own window and interval —
      // not the recorder's repair window, and no other interval. The end
      // bound is the last wanted bar's close, one width minus one millisecond.
      assert.strictEqual(info.bodies.length, 1);
      assert.deepEqual(info.bodies[0], {
        coin: "ETH",
        interval: "1m",
        startTime: request.fromT,
        endTime: request.toT + MINUTE - 1,
      });
      const stored = db
        .all<{ t: number }>(
          "SELECT t FROM candles WHERE venue = 'hyperliquid' AND coin = 'ETH' AND interval = '1m' ORDER BY t",
        )
        .map((row) => row.t);
      assert.deepEqual(stored, gridOpens(request.fromT, request.toT, MINUTE));
      const queue = queueAfter(hydrationPath);
      assert.strictEqual(queue.requests.length, 0);
      assert.strictEqual(queue.results[0]?.outcome, "hydrated");
      assert.strictEqual(queue.results[0]?.barsFetched, stored.length);
      db.close();
    });
  });

  it("coalesces overlapping requests into one fetch, answering each by its own id", async () => {
    await withArchivePath(async (path) => {
      const db = openArchiveDatabase(path);
      const hydrationPath = `${path}.hydration.json`;
      const info = hydrationInfo(serveGrid);
      const first = liveRequest({ id: "a" });
      const second = liveRequest({
        id: "b",
        fromT: first.fromT + 15 * MINUTE,
        toT: first.toT + 15 * MINUTE,
      });
      storeHydrationQueue(hydrationPath, { requests: [first, second], results: [] });

      await runTicks(db, info, 1, undefined, undefined, hydrationPath, () => []);

      assert.strictEqual(info.bodies.length, 1);
      assert.strictEqual(info.bodies[0]?.["startTime"], first.fromT);
      assert.strictEqual(info.bodies[0]?.["endTime"], second.toT + MINUTE - 1);
      const queue = queueAfter(hydrationPath);
      assert.strictEqual(queue.requests.length, 0);
      const byId = new Map(queue.results.map((result) => [result.id, result]));
      assert.strictEqual(byId.get("a")?.outcome, "hydrated");
      assert.strictEqual(byId.get("b")?.outcome, "hydrated");
      db.close();
    });
  });

  it("answers a request for another venue unsupported, fetching nothing", async () => {
    await withArchivePath(async (path) => {
      const db = openArchiveDatabase(path);
      const hydrationPath = `${path}.hydration.json`;
      const info = hydrationInfo(serveGrid);
      storeHydrationQueue(hydrationPath, {
        requests: [liveRequest({ id: "t1", venue: "hyperliquid-testnet" })],
        results: [],
      });

      await runTicks(db, info, 1, undefined, undefined, hydrationPath, () => []);

      assert.strictEqual(info.bodies.length, 0);
      assert.strictEqual(
        db.all<{ total: number }>("SELECT COUNT(*) AS total FROM candles")[0]?.total,
        0,
      );
      const queue = queueAfter(hydrationPath);
      assert.strictEqual(queue.results[0]?.outcome, "unsupported");
      assert.include(queue.results[0]?.reason ?? "", "hyperliquid-testnet");
      db.close();
    });
  });

  it("answers an expired request timed_out exactly once", async () => {
    await withArchivePath(async (path) => {
      const db = openArchiveDatabase(path);
      const hydrationPath = `${path}.hydration.json`;
      const info = hydrationInfo(serveGrid);
      storeHydrationQueue(hydrationPath, {
        requests: [liveRequest({ id: "late", deadlineAt: Date.now() - 1_000 })],
        results: [],
      });

      await runTicks(db, info, 2, undefined, undefined, hydrationPath);

      const queue = queueAfter(hydrationPath);
      const timedOut = queue.results.filter((result) => result.id === "late");
      assert.strictEqual(timedOut.length, 1);
      assert.strictEqual(timedOut[0]?.outcome, "timed_out");
      assert.strictEqual(queue.requests.length, 0);
      db.close();
    });
  });

  it("names rate limiting honestly when the endpoint refuses to answer", async () => {
    await withArchivePath(async (path) => {
      const db = openArchiveDatabase(path);
      const hydrationPath = `${path}.hydration.json`;
      let rateLimited = false;
      const info: InfoClient & { readonly bodies: unknown[] } = {
        bodies: [],
        stats: { requests: 0, failures: 0, retries: 0, paceMs: 200 },
        lastFailureWasRateLimit: () => rateLimited,
        post: (operation) => {
          if (operation !== "candleSnapshot") return Promise.resolve(null);
          rateLimited = true;
          return Promise.resolve(null);
        },
      };
      storeHydrationQueue(hydrationPath, { requests: [liveRequest()], results: [] });

      await runTicks(db, info, 1, undefined, undefined, hydrationPath, () => []);

      const queue = queueAfter(hydrationPath);
      assert.strictEqual(queue.results[0]?.outcome, "rate_limited");
      db.close();
    });
  });

  it("reconciles a known gap the hydrated bars filled, keeping what is still missing", async () => {
    await withArchivePath(async (path) => {
      const db = openArchiveDatabase(path);
      const hydrationPath = `${path}.hydration.json`;
      const info = hydrationInfo(serveGrid);
      const request = liveRequest();
      // A gap wider than the request: only the intersection can be healed.
      recordKnownGap(
        db,
        {
          coin: "ETH",
          interval: "1m",
          fromT: request.fromT - 5 * MINUTE,
          toT: request.toT + 10 * MINUTE,
          recordedAt: Date.now(),
        },
        "hyperliquid",
      );
      storeHydrationQueue(hydrationPath, { requests: [request], results: [] });

      await runTicks(db, info, 1, undefined, undefined, hydrationPath, () => []);

      const gaps = db.all<{ from_t: number; to_t: number }>(
        "SELECT from_t, to_t FROM known_gaps ORDER BY from_t",
      );
      assert.deepEqual(gaps, [
        { from_t: request.fromT - 5 * MINUTE, to_t: request.fromT - MINUTE },
        { from_t: request.toT + MINUTE, to_t: request.toT + 10 * MINUTE },
      ]);
      db.close();
    });
  });

  it("leaves a gap record alone when the fetch did not fill its intersection", async () => {
    await withArchivePath(async (path) => {
      const db = openArchiveDatabase(path);
      const hydrationPath = `${path}.hydration.json`;
      // Serve only the first bar of the window: the gap's intersection is
      // still mostly missing, so the record must stand.
      const info = hydrationInfo((req) => serveGrid(req).slice(0, 1));
      const request = liveRequest();
      recordKnownGap(
        db,
        {
          coin: "ETH",
          interval: "1m",
          fromT: request.fromT,
          toT: request.toT,
          recordedAt: Date.now(),
        },
        "hyperliquid",
      );
      storeHydrationQueue(hydrationPath, { requests: [request], results: [] });

      await runTicks(db, info, 1, undefined, undefined, hydrationPath, () => []);

      const gaps = db.all<{ from_t: number; to_t: number }>("SELECT from_t, to_t FROM known_gaps");
      assert.strictEqual(gaps.length, 1);
      assert.strictEqual(gaps[0]?.from_t, request.fromT);
      assert.strictEqual(queueAfter(hydrationPath).results[0]?.outcome, "partial");
      db.close();
    });
  });

  it("says partial when bars inside the source's reach were still not served", async () => {
    await withArchivePath(async (path) => {
      const db = openArchiveDatabase(path);
      const hydrationPath = `${path}.hydration.json`;
      // The provider drops one bar in the middle of an otherwise full window.
      const info = hydrationInfo((req) => serveGrid(req).filter((_, index) => index !== 3));
      storeHydrationQueue(hydrationPath, { requests: [liveRequest()], results: [] });

      await runTicks(db, info, 1, undefined, undefined, hydrationPath, () => []);

      const result = queueAfter(hydrationPath).results[0];
      assert.strictEqual(result?.outcome, "partial");
      assert.include(result?.reason ?? "", "1 recoverable bar(s)");
      db.close();
    });
  });

  it("says source_window_exhausted when a healthy endpoint holds nothing for the window", async () => {
    await withArchivePath(async (path) => {
      const db = openArchiveDatabase(path);
      const hydrationPath = `${path}.hydration.json`;
      const info = hydrationInfo(() => []);
      storeHydrationQueue(hydrationPath, { requests: [liveRequest()], results: [] });

      await runTicks(db, info, 1, undefined, undefined, hydrationPath, () => []);

      const result = queueAfter(hydrationPath).results[0];
      assert.strictEqual(result?.outcome, "source_window_exhausted");
      db.close();
    });
  });

  it("says already_covered when the window was whole before the writer fetched", async () => {
    await withArchivePath(async (path) => {
      const db = openArchiveDatabase(path);
      const hydrationPath = `${path}.hydration.json`;
      const info = hydrationInfo(() => []);
      const request = liveRequest();
      const step = MINUTE;
      upsertCandles(
        db,
        gridOpens(request.fromT, request.toT, step).map(
          (open) =>
            ({
              coin: "ETH",
              interval: "1m",
              t: open,
              tClose: open + step - 1,
              o: 100,
              h: 101,
              l: 99,
              c: 100.5,
              v: 1,
              n: 3,
            }) as CandleRow,
        ),
        "hyperliquid",
      );
      storeHydrationQueue(hydrationPath, { requests: [request], results: [] });

      await runTicks(db, info, 1, undefined, undefined, hydrationPath, () => []);

      assert.strictEqual(queueAfter(hydrationPath).results[0]?.outcome, "already_covered");
      db.close();
    });
  });
});

describe("the writer's wake", () => {
  it("a request arriving between ticks wakes the writer long before the poll interval", async () => {
    await withArchivePath(async (path) => {
      const db = openArchiveDatabase(path);
      const hydrationPath = `${path}.hydration.json`;
      const info = hydrationInfo(serveGrid);
      // Gate tick 1 at its context sample: drain(tick 1) has already run and
      // found nothing, so a request written while the gate is held lands
      // strictly between the two drains — only the wake can reach it early.
      let arriveGate: (() => void) | null = null;
      let releaseHold: (() => void) | null = null;
      const gateArrived = new Promise<void>((resolve) => {
        arriveGate = resolve;
      });
      const hold = new Promise<void>((resolve) => {
        releaseHold = resolve;
      });
      const gatedInfo: InfoClient = {
        ...info,
        post: (operation, body) => {
          if (operation === "metaAndAssetCtxs") {
            fire(arriveGate);
            arriveGate = null;
            return hold.then(() => []);
          }
          return info.post(operation, body);
        },
      };
      let stop = false;
      const startedAt = Date.now();
      const runPromise = runArchiver({
        db,
        info: gatedInfo,
        shouldContinue: () => !stop,
        sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
        readCoins: () => [],
        hydrationPath,
        // Ten seconds of poll cadence: without the wake, tick 2 cannot run
        // inside the assertion budget at all.
        tickIntervalMs: 10_000,
      });
      try {
        // Wait for the gate (tick 1 reached its context sample), enqueue the
        // request while the tick still sleeps on the gate, then let tick 1
        // finish into its between-tick wait.
        await gateArrived;
        const request = liveRequest({ id: "wake-1" });
        storeHydrationQueue(hydrationPath, { requests: [request], results: [] });
        assert.isNotNull(releaseHold);
        fire(releaseHold);
        // The writer's own result write is the receipt. The test POLLS the
        // queue rather than watching it: a second FSEvents watcher on the
        // directory can starve the writer's watcher of the wake event, which
        // is the very behavior under test.
        for (;;) {
          const queue = queueAfter(hydrationPath);
          if (queue.results.some((result) => result.id === "wake-1")) break;
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
        }
        stop = true;
        await runPromise;
        const elapsed = Date.now() - startedAt;
        const queue = queueAfter(hydrationPath);
        assert.strictEqual(
          queue.results.find((result) => result.id === "wake-1")?.outcome,
          "hydrated",
        );
        assert.strictEqual(info.bodies.length, 1);
        assert.isTrue(
          elapsed < 8_000,
          `the wake saved the request from waiting the full cadence (${elapsed}ms)`,
        );
      } finally {
        stop = true;
        await runPromise.catch(() => undefined);
      }
      db.close();
    });
  });

  it("pins the guarantee floor: the fallback slice is half the maximum wait", () => {
    assert.isTrue(HYDRATION_WRITER_SLICE_MS <= HYDRATION_MAX_WAIT_MS / 2);
  });
});

describe("cold-start priority: hydration is drained between startup units", () => {
  it("a request arriving during cold-start backfill is answered before startup completes", async () => {
    await withArchivePath(async (path) => {
      const db = openArchiveDatabase(path);
      const hydrationPath = `${path}.hydration.json`;
      const request = liveRequest({ id: "startup-1" });
      // The fake provider serves ONLY the exact window the drain asks for:
      // the backfill units return no bars, so the coverage that answers this
      // request can only come from the between-units hydration fetch.
      const info = hydrationInfo((req) => (req.startTime === request.fromT ? serveGrid(req) : []));
      // Gate the STARTUP units only: a backfill unit is a candleSnapshot
      // that names an endTime (the whole servable window in one call),
      // while the hydration drain's exact-window fetch is the one whose
      // startTime is the request's own fromT. Holding the first two units
      // lets the test enqueue mid-startup and then prove the result landed
      // while the second unit — and five more after it — still hold the
      // backfill open.
      const exactWindow = (req: unknown): boolean =>
        (req as { readonly startTime?: unknown } | undefined | null)?.startTime === request.fromT;
      let backfillCalls = 0;
      let arriveA: (() => void) | null = null;
      let releaseA: (() => void) | null = null;
      let arriveB: (() => void) | null = null;
      let releaseB: (() => void) | null = null;
      const aArrived = new Promise<void>((resolve) => {
        arriveA = resolve;
      });
      const holdA = new Promise<void>((resolve) => {
        releaseA = resolve;
      });
      const bArrived = new Promise<void>((resolve) => {
        arriveB = resolve;
      });
      const holdB = new Promise<void>((resolve) => {
        releaseB = resolve;
      });
      let bReleased = false;
      const gatedInfo: InfoClient = {
        ...info,
        post: (operation, body) => {
          if (
            operation === "candleSnapshot" &&
            !exactWindow((body as { readonly req: unknown }).req) &&
            "endTime" in (body as { req: object }).req
          ) {
            backfillCalls += 1;
            if (backfillCalls === 1) {
              fire(arriveA);
              return holdA.then(() => info.post(operation, body));
            }
            if (backfillCalls === 2) {
              fire(arriveB);
              return holdB.then(() => info.post(operation, body));
            }
          }
          return info.post(operation, body);
        },
      };

      let stop = false;
      const runPromise = runArchiver({
        db,
        info: gatedInfo,
        shouldContinue: () => !stop,
        sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
        readCoins: () => ["ETH"],
        hydrationPath,
        tickIntervalMs: 60_000,
      });
      try {
        // Startup unit 1 (the 1m backfill) is holding: enqueue a request now,
        // mid-cold-start, then let unit 1 finish into its between-unit drain.
        await aArrived;
        storeHydrationQueue(hydrationPath, { requests: [request], results: [] });
        fire(releaseA);

        // The writer's result write is the receipt. Poll, not watch: a
        // second FSEvents watcher on the directory can starve the writer's
        // own wake, which this suite exercises elsewhere.
        for (;;) {
          const queue = queueAfter(hydrationPath);
          if (queue.results.some((result) => result.id === "startup-1")) break;
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
        }
        const queue = queueAfter(hydrationPath);
        assert.strictEqual(
          queue.results.find((result) => result.id === "startup-1")?.outcome,
          "hydrated",
        );
        // The result exists while startup is still incomplete: the second
        // backfill unit has not been released, so the cold start cannot have
        // finished — the drain ran between units, not after the backfill.
        assert.strictEqual(bReleased, false);
        assert.strictEqual(
          backfillCalls >= 2,
          true,
          "the second startup unit was reached and held",
        );

        fire(releaseB);
        bReleased = true;
        stop = true;
        await runPromise;
        // Exactly one exact-window fetch (the hydration call, identified by
        // the request's own fromT), made during startup: every other
        // candleSnapshot was a backfill unit with the servable window's own
        // startTime.
        const exactFetches = info.bodies.filter(exactWindow).length;
        assert.strictEqual(exactFetches, 1);
      } finally {
        stop = true;
        if (!bReleased) {
          fire(releaseB);
        }
        fire(releaseA);
        await runPromise.catch(() => undefined);
        db.close();
      }
    });
  });
});
