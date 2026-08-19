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
// @effect-diagnostics nodeBuiltinImport:off globalDate:off - temp files, real clock.
import { assert, describe, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { alignToMinute, emptyCounters, formatHeartbeat, runArchiver } from "./archiver.ts";
import { ARCHIVE_COINS, ARCHIVE_INTERVALS, CANDLE_WINDOW_BARS, INTERVAL_MS } from "./config.ts";
import { openArchiveDatabase, type ArchiveDatabase } from "./db.ts";
import type { InfoClient } from "./info.ts";
import { upsertCandles } from "./candles.ts";

const MINUTE = 60_000;

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

const withArchivePath = <A>(use: (path: string) => A): A => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "market-archive-loop-"));
  try {
    return use(NodePath.join(dir, "archive.sqlite"));
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
          { universe: ARCHIVE_COINS.map((name) => ({ name })) },
          ARCHIVE_COINS.map(() => ({
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
 * The countdown hangs off `sleep`, which the loop calls once at the end of
 * each tick, because `shouldContinue` is a flag the archiver also consults
 * during the backfill — counting its calls would end the run mid-startup.
 */
async function runTicks(db: ArchiveDatabase, info: InfoClient, ticks: number): Promise<void> {
  let remaining = ticks;
  await runArchiver({
    db,
    info,
    shouldContinue: () => remaining > 0,
    sleep: () => {
      remaining -= 1;
      return Promise.resolve();
    },
  });
}

describe("formatHeartbeat", () => {
  it("marks only the intervals that have actually missed a bar", () => {
    withArchivePath((path) => {
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
      assert.strictEqual(series[0]?.total, ARCHIVE_COINS.length * ARCHIVE_INTERVALS.length);

      const funding = db.all<{ total: number }>("SELECT COUNT(*) AS total FROM funding");
      assert.strictEqual(funding[0]?.total, ARCHIVE_COINS.length);
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
      assert.strictEqual(contexts[0]?.total, ARCHIVE_COINS.length);
      const books = db.all<{ total: number }>("SELECT COUNT(*) AS total FROM book_summary");
      assert.strictEqual(books[0]?.total, ARCHIVE_COINS.length);

      const sampled = db.all<{ ts: number }>("SELECT DISTINCT ts FROM asset_ctx");
      assert.strictEqual(sampled[0]?.ts, alignToMinute(sampled[0]?.ts ?? 0));
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
});
