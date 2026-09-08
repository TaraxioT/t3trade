/**
 * TradingMarketArchive — the read-only seam over the market archive.
 *
 * The property this file exists to pin (plan 38 §5.3): absence is an answer,
 * never a number. With the archive file absent, with its tables empty, or
 * with the asked-for funding window uncovered, every method returns
 * `status: "unavailable"` with a reason — a zero mean presented as `ok` is
 * the single most dangerous failure this service can produce.
 *
 * Fixtures are temp directories seeded through the archive's own upserters,
 * the same convention as `archive/read.test.ts`. Nothing touches the network
 * or the live `~/.t3/userdata`.
 */
// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off - temp files for a temp database; the hydration waits are wall-clock by design.
import { assert, it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { upsertAssetContexts } from "./archive/assetCtx.ts";
import { upsertBookSummaries } from "./archive/bookSummary.ts";
import { recordKnownGap, upsertCandles, type CandleRow } from "./archive/candles.ts";
import { INTERVAL_MS, TESTNET_ARCHIVE_VENUE } from "./archive/config.ts";
import { openArchiveDatabase } from "./archive/db.ts";
import { upsertFunding } from "./archive/funding.ts";
import {
  gridOpens,
  loadHydrationQueue,
  makeHydrationFileWatcher,
  providerReachFloor,
  recordHydrationResult,
  storeHydrationQueue,
  withHydrationQueueLock,
  type HydrationRequest,
} from "./archive/hydration.ts";
import {
  makeTradingMarketArchive,
  type TradingMarketArchiveShape,
} from "./TradingMarketArchive.ts";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const NOW = 1_700_000_000_000;

/** A temp dir; the archive file inside it is created only by the test. */
const tempDir = (name: string): string => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), name));

it.effect("serves seeded series and hand-checked funding statistics", () =>
  Effect.gen(function* () {
    const dir = tempDir("market-archive-seam-");
    const writer = openArchiveDatabase(NodePath.join(dir, "archive.sqlite"));
    upsertFunding(writer, [
      // Outside the 7d window: a rate of 1 that must not move the mean.
      { coin: "BTC", time: NOW - 10 * DAY, fundingRate: 1, premium: 0 },
      // Inside: +, +, -, + → mean (0.1+0.2-0.12+0.04)/4, latest 0.04, 2 flips.
      { coin: "BTC", time: NOW - 6 * DAY, fundingRate: 0.1, premium: 0.001 },
      { coin: "BTC", time: NOW - 4 * DAY, fundingRate: 0.2, premium: 0.002 },
      { coin: "BTC", time: NOW - 2 * DAY, fundingRate: -0.12, premium: -0.001 },
      { coin: "BTC", time: NOW - 1 * DAY, fundingRate: 0.04, premium: 0 },
    ]);
    upsertAssetContexts(writer, [
      {
        coin: "BTC",
        ts: NOW - MINUTE,
        openInterest: 10,
        premium: -0.0004,
        oraclePx: 100.5,
        markPx: 100.4,
        dayNtlVolume: 1_000,
        funding: 0.0000125,
      },
      {
        coin: "BTC",
        ts: NOW,
        openInterest: 12,
        premium: -0.0002,
        oraclePx: 101.5,
        markPx: 101.4,
        dayNtlVolume: 1_100,
        funding: 0.0000125,
      },
    ]);
    upsertBookSummaries(writer, [
      {
        coin: "BTC",
        ts: NOW - MINUTE,
        bidPx: 100,
        bidSz: 1,
        askPx: 101,
        askSz: 0.5,
        bidDepth5: 15,
        askDepth5: 2,
      },
    ]);
    writer.close();

    const archive: TradingMarketArchiveShape = makeTradingMarketArchive(
      NodePath.join(dir, "archive.sqlite"),
    );

    const stats = yield* archive.fundingStats({ coin: "BTC", windowDays: 7, now: NOW });
    assert.strictEqual(stats.status, "ok");
    if (stats.status !== "ok") return;
    assert.strictEqual(stats.sampleCount, 4);
    // Served as 8h-equivalent rates: the archive stores per-hour rows, the
    // boundary multiplies by 8 (seeded hourly mean 0.055 -> 0.44, latest
    // hourly 0.04 -> 0.32).
    assert.closeTo(stats.meanPer8h, ((0.1 + 0.2 - 0.12 + 0.04) / 4) * 8, 1e-12);
    assert.strictEqual(stats.latestRatePer8h, 0.04 * 8);
    assert.strictEqual(stats.latestTime, NOW - 1 * DAY);
    assert.strictEqual(stats.signFlips, 2);

    const series = yield* archive.fundingSeries({ coin: "BTC", n: 3 });
    assert.strictEqual(series.status, "ok");
    if (series.status !== "ok") return;
    assert.strictEqual(series.count, 3);
    // Oldest first: the newest three in-window rows, ascending.
    assert.deepStrictEqual(
      series.rows.map((row) => row.fundingRate),
      [0.2, -0.12, 0.04],
    );

    const oi = yield* archive.oiPremium({ coin: "BTC", n: 5 });
    assert.strictEqual(oi.status, "ok");
    if (oi.status !== "ok") return;
    assert.strictEqual(oi.count, 2);
    assert.strictEqual(oi.rows[1]?.openInterest, 12);
    assert.strictEqual(oi.rows[0]?.markPx, 100.4);

    const book = yield* archive.bookHistory({ coin: "BTC", n: 2 });
    assert.strictEqual(book.status, "ok");
    if (book.status !== "ok") return;
    assert.strictEqual(book.count, 1);
    assert.strictEqual(book.rows[0]?.bidDepth5, 15);

    // The derived seam sees the same rows: the 7d funding mean over the four
    // in-window rates (holdings reach back to the 10d row) = 0.055.
    const derived = yield* archive.derivedMetric({
      market: "BTC",
      params: { metric: "funding_mean", windowDays: 7 },
      now: NOW,
    });
    assert.strictEqual(derived.status, "ok");
    if (derived.status !== "ok") return;
    assert.closeTo(derived.value, (0.1 + 0.2 - 0.12 + 0.04) / 4, 1e-12);
  }),
);

it.effect("an archive that appears after boot is served without a restart", () =>
  Effect.gen(function* () {
    const dir = tempDir("market-archive-late-");
    const path = NodePath.join(dir, "archive.sqlite");
    const archive = makeTradingMarketArchive(path);

    const before = yield* archive.fundingSeries({ coin: "BTC", n: 5 });
    assert.strictEqual(before.status, "unavailable");

    const writer = openArchiveDatabase(path);
    upsertFunding(writer, [{ coin: "BTC", time: NOW, fundingRate: 0.01, premium: 0 }]);
    writer.close();

    const after = yield* archive.fundingSeries({ coin: "BTC", n: 5 });
    assert.strictEqual(after.status, "ok");
    if (after.status !== "ok") return;
    assert.strictEqual(after.count, 1);
  }),
);

it.effect("a missing file makes every method unavailable, never a zero", () =>
  Effect.gen(function* () {
    const dir = tempDir("market-archive-absent-");
    const missing = NodePath.join(dir, "not-there.sqlite");
    const archive = makeTradingMarketArchive(missing);

    const results = [
      yield* archive.fundingStats({ coin: "ETH", windowDays: 7, now: NOW }),
      yield* archive.fundingSeries({ coin: "ETH", n: 10 }),
      yield* archive.oiPremium({ coin: "ETH", n: 10 }),
      yield* archive.bookHistory({ coin: "ETH", n: 10 }),
    ];
    for (const result of results) {
      // The discriminant itself is the assertion: no "ok" carrying zeros.
      assert.strictEqual(result.status, "unavailable");
      if (result.status !== "unavailable") return;
      assert.include(result.reason, "archive file not found");
    }

    // A derived metric over a missing archive refuses with the archive kind,
    // which the evaluator maps onto `derived_needs_archive`.
    const derived = yield* archive.derivedMetric({
      market: "ETH",
      params: { metric: "funding_mean", windowDays: 7 },
      now: NOW,
    });
    assert.strictEqual(derived.status, "unavailable");
    if (derived.status !== "unavailable") return;
    assert.strictEqual(derived.kind, "archive");
    assert.include(derived.reason, "archive file not found");
    // And the failed lookups created nothing.
    assert.strictEqual(NodeFS.existsSync(missing), false);
  }),
);

it.effect("empty tables are unavailable with the not-running reason", () =>
  Effect.gen(function* () {
    const dir = tempDir("market-archive-empty-");
    const path = NodePath.join(dir, "archive.sqlite");
    const writer = openArchiveDatabase(path);
    writer.close();

    const archive = makeTradingMarketArchive(path);

    const stats = yield* archive.fundingStats({ coin: "ETH", windowDays: 7, now: NOW });
    assert.strictEqual(stats.status, "unavailable");
    if (stats.status !== "unavailable") return;
    assert.include(stats.reason, "0 rows in window");

    const series = yield* archive.fundingSeries({ coin: "ETH", n: 10 });
    assert.strictEqual(series.status, "unavailable");
    if (series.status !== "unavailable") return;
    assert.include(series.reason, "no funding rows recorded for ETH");

    const oi = yield* archive.oiPremium({ coin: "ETH", n: 10 });
    assert.strictEqual(oi.status, "unavailable");
    if (oi.status !== "unavailable") return;
    assert.include(oi.reason, "no asset_ctx rows recorded for ETH");

    const book = yield* archive.bookHistory({ coin: "ETH", n: 10 });
    assert.strictEqual(book.status, "unavailable");
    if (book.status !== "unavailable") return;
    assert.include(book.reason, "no book_summary rows recorded for ETH");
  }),
);

it.effect("a thin 24h candle window names its reason per coin, and the key still serves", () =>
  Effect.gen(function* () {
    const dir = tempDir("market-archive-thin-");
    const path = NodePath.join(dir, "archive.sqlite");
    const writer = openArchiveDatabase(path);
    // Two 5m bars inside the trailing 24h: at most one return, so realized
    // volatility has no variance to scale — the absence must be named on the
    // coin, never by zeroing the figure or failing the whole scan.
    const FIVE = 5 * MINUTE;
    const bar = (t: number): CandleRow => ({
      coin: "SOL",
      interval: "5m",
      t,
      tClose: t + FIVE - 1,
      o: 141,
      h: 142,
      l: 140,
      c: 141,
      v: 12.5,
      n: 30,
    });
    upsertCandles(writer, [bar(NOW - 2 * FIVE), bar(NOW - FIVE)]);
    writer.close();

    const archive = makeTradingMarketArchive(path);
    const scan = yield* archive.scan({ now: NOW });
    assert.strictEqual(scan.status, "ok");
    if (scan.status !== "ok") return;
    const sol = scan.coins.find((coin) => coin.coin === "SOL");
    assert.ok(sol !== undefined);
    // The exact production reason (TradingMarketArchive.ts thin-window
    // branch), joined with the coin's other absences by "; ".
    assert.include(
      sol.unavailable,
      "only 2 5m bars in the trailing 24h — realized volatility not computable",
    );
    assert.equal(sol.realizedVol24hPct, undefined);
  }),
);

it.effect("a mark more than two bars behind is withheld, not published", () =>
  Effect.gen(function* () {
    const dir = tempDir("market-archive-stale-mark-");
    const path = NodePath.join(dir, "archive.sqlite");
    const writer = openArchiveDatabase(path);
    // A complete, gap-free run of 5m bars that simply stopped an hour ago —
    // the shape a dead archiver leaves behind. The last close is a real price
    // from a market that has since moved, so the scan must not serve it.
    const FIVE = 5 * MINUTE;
    const bar = (t: number): CandleRow => ({
      coin: "SOL",
      interval: "5m",
      t,
      tClose: t + FIVE - 1,
      o: 141,
      h: 142,
      l: 140,
      c: 141,
      v: 12.5,
      n: 30,
    });
    upsertCandles(
      writer,
      [12, 11, 10].map((back) => bar(NOW - back * FIVE)),
    );
    writer.close();

    const archive = makeTradingMarketArchive(path);
    const scan = yield* archive.scan({ now: NOW });
    assert.strictEqual(scan.status, "ok");
    if (scan.status !== "ok") return;
    const sol = scan.coins.find((coin) => coin.coin === "SOL");
    assert.ok(sol !== undefined);
    assert.equal(sol.mark, undefined);
    assert.include(sol.unavailable, "mark withheld, the archiver is not writing");
  }),
);

it.effect("asking for more rows than exist returns what exists", () =>
  Effect.gen(function* () {
    const dir = tempDir("market-archive-short-");
    const path = NodePath.join(dir, "archive.sqlite");
    const writer = openArchiveDatabase(path);
    upsertFunding(
      writer,
      [1, 2].map((hour) => ({
        coin: "BTC",
        time: NOW - hour * DAY,
        fundingRate: 0.01,
        premium: 0,
      })),
    );
    writer.close();

    const archive = makeTradingMarketArchive(path);
    const series = yield* archive.fundingSeries({ coin: "BTC", n: 500 });
    // Pinned choice: fewer rows than asked for is "ok" with the rows that
    // exist — the count field carries the shortfall, so the caller can tell.
    assert.strictEqual(series.status, "ok");
    if (series.status !== "ok") return;
    assert.strictEqual(series.count, 2);
  }),
);

it.effect("coverage reports the recording start and clips known gaps to the window", () =>
  Effect.gen(function* () {
    const dir = tempDir("market-archive-coverage-");
    const path = NodePath.join(dir, "archive.sqlite");
    const writer = openArchiveDatabase(path);
    const bar = (t: number): CandleRow => ({
      coin: "BTC",
      interval: "5m",
      t,
      tClose: t + 5 * MINUTE,
      o: 100,
      h: 101,
      l: 99,
      c: 100.5,
      v: 2,
      n: 3,
    });
    upsertCandles(writer, [bar(NOW - 2 * DAY), bar(NOW - MINUTE)]);
    // One gap inside the asked window (must be clipped to it), one entirely
    // before it (must not appear), and one straddling the window start.
    recordKnownGap(writer, {
      coin: "BTC",
      interval: "5m",
      fromT: NOW - 10 * DAY,
      toT: NOW - 9 * DAY,
      recordedAt: NOW,
    });
    recordKnownGap(writer, {
      coin: "BTC",
      interval: "5m",
      fromT: NOW - 2 * DAY,
      toT: NOW - DAY + MINUTE,
      recordedAt: NOW,
    });
    writer.close();

    const archive = makeTradingMarketArchive(path);
    const coverage = yield* archive.coverage({
      coin: "BTC",
      interval: "5m",
      fromT: NOW - DAY,
      toT: NOW,
    });
    assert.strictEqual(coverage.recordingSince, NOW - 2 * DAY);
    assert.deepStrictEqual(coverage.gaps, [{ fromT: NOW - DAY, toT: NOW - DAY + MINUTE }]);

    // A different interval has its own recording start and no gap records.
    const other = yield* archive.coverage({
      coin: "BTC",
      interval: "1m",
      fromT: NOW - DAY,
      toT: NOW,
    });
    assert.strictEqual(other.recordingSince, null);
    assert.deepStrictEqual(other.gaps, []);
  }),
);

it.effect("coverage over a missing archive is empty, never a failure", () =>
  Effect.gen(function* () {
    const dir = tempDir("market-archive-coverage-missing-");
    const archive = makeTradingMarketArchive(NodePath.join(dir, "absent.sqlite"));
    const coverage = yield* archive.coverage({
      coin: "BTC",
      interval: "5m",
      fromT: NOW - DAY,
      toT: NOW,
    });
    assert.deepStrictEqual(coverage, { recordingSince: null, gaps: [] });
  }),
);

it.effect("a testnet reader never serves mainnet rows as its own history", () =>
  Effect.gen(function* () {
    // R5-1: the live layer reads with the venue of the network being traded.
    // Mainnet rows recorded before the switch simply stop matching — a
    // testnet session sees "recording since now", never the other exchange's
    // prices.
    const dir = tempDir("market-archive-venue-");
    const path = NodePath.join(dir, "archive.sqlite");
    const writer = openArchiveDatabase(path);
    const bar = (t: number, close: number): CandleRow => ({
      coin: "HYPE",
      interval: "5m",
      t,
      tClose: t + 5 * MINUTE - 1,
      o: close,
      h: close + 1,
      l: close - 1,
      c: close,
      v: 3,
      n: 2,
    });
    // Mainnet history at ~82, testnet at ~41 — the R5-1 live divergence.
    upsertCandles(writer, [bar(NOW - 10 * MINUTE, 82), bar(NOW - 5 * MINUTE, 82.5)]);
    upsertFunding(writer, [{ coin: "HYPE", time: NOW - MINUTE, fundingRate: 0.01, premium: 0 }]);
    upsertCandles(writer, [bar(NOW - 5 * MINUTE, 41)], TESTNET_ARCHIVE_VENUE);
    recordKnownGap(writer, {
      coin: "HYPE",
      interval: "5m",
      fromT: NOW - DAY,
      toT: NOW - DAY + MINUTE,
      recordedAt: NOW,
    });
    writer.close();

    const testnet = makeTradingMarketArchive(path, TESTNET_ARCHIVE_VENUE);

    // Candles: only the testnet bar, never the mainnet 82s.
    const bars = yield* testnet.candlesInWindow({
      coin: "HYPE",
      interval: "5m",
      fromT: NOW - DAY,
      toT: NOW,
      maxBars: 100,
    });
    assert.deepStrictEqual(
      bars.map((row) => row.c),
      [41],
    );

    // Funding recorded only on mainnet is unavailable, not served.
    const stats = yield* testnet.fundingStats({ coin: "HYPE", windowDays: 7, now: NOW });
    assert.strictEqual(stats.status, "unavailable");

    // Session levels come from the testnet bar alone.
    const levels = yield* testnet.sessionLevels({ coin: "HYPE", now: NOW });
    assert.strictEqual(levels.status, "ok");
    if (levels.status !== "ok") return;
    assert.strictEqual(levels.currentUtcDay?.high, 42);

    // Coverage: recording started at the testnet bar, and the mainnet-only
    // gap record does not bleed across.
    const coverage = yield* testnet.coverage({
      coin: "HYPE",
      interval: "5m",
      fromT: NOW - DAY,
      toT: NOW,
    });
    assert.strictEqual(coverage.recordingSince, NOW - 5 * MINUTE);
    assert.deepStrictEqual(coverage.gaps, []);

    // The mainnet reader still sees its own history untouched.
    const mainnet = makeTradingMarketArchive(path);
    const mainnetBars = yield* mainnet.candlesInWindow({
      coin: "HYPE",
      interval: "5m",
      fromT: NOW - DAY,
      toT: NOW,
      maxBars: 100,
    });
    assert.deepStrictEqual(
      mainnetBars.map((row) => row.c),
      [82, 82.5],
    );
  }),
);

// ---------------------------------------------------------------------------
// on-demand hydration: the reader asks the sole writer through the queue
// ---------------------------------------------------------------------------

/** A grid-aligned 1m window 60–30 minutes old: closed bars, inside reach. */
const hydrationWindow = () => {
  const minuteNow = Math.floor(Date.now() / MINUTE) * MINUTE;
  return { fromT: minuteNow - 60 * MINUTE, toT: minuteNow - 30 * MINUTE };
};

const hydrationBar = (open: number): CandleRow => ({
  coin: "ETH",
  interval: "1m",
  t: open,
  tClose: open + MINUTE - 1,
  o: 100,
  h: 101,
  l: 99,
  c: 100.5,
  v: 1,
  n: 3,
});

/**
 * Resolve the first queued request by watching the queue file itself, the
 * same event the archiver's watcher wakes on. The event is the fast path;
 * the 200ms slice re-read bounds a lost FIRST event — `fs.watch`'s
 * subscription arms asynchronously, so a queue write in the first
 * milliseconds after the fork can go unseen — the same slice discipline the
 * archiver's own writer uses. 5 seconds without the request is the failure.
 */
const awaitQueuedRequest = (hydrationPath: string): Promise<HydrationRequest> =>
  (async () => {
    const watcher = makeHydrationFileWatcher(hydrationPath);
    if (watcher === null) throw new Error("no watcher on the temp queue");
    try {
      const deadline = Date.now() + 5_000;
      for (;;) {
        const loaded = loadHydrationQueue(hydrationPath);
        if (loaded.status === "ok" && loaded.queue.requests.length > 0) {
          return loaded.queue.requests[0] as HydrationRequest;
        }
        await watcher.waitOrTimeout(200);
        if (Date.now() >= deadline) throw new Error("the request never reached the queue");
      }
    } finally {
      watcher.close();
    }
  })();

/**
 * Fork an ensureCoverage call and resolve the request it queues — the proof
 * that the window was NOT answered `already_covered`. The fiber is returned
 * for the caller to interrupt: these tests assert the ask, not the writer's
 * answer, and never wait out a 30-second deadline.
 */
const forkedEnsure = (
  archive: TradingMarketArchiveShape,
  input: Parameters<TradingMarketArchiveShape["ensureCoverage"]>[0],
  hydrationPath: string,
) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkScoped(archive.ensureCoverage(input));
    const appeared = yield* Effect.promise(() => awaitQueuedRequest(hydrationPath));
    return { fiber, appeared };
  });

it.effect("ensureCoverage answers already_covered from stored bars alone, queueing nothing", () =>
  Effect.gen(function* () {
    const dir = tempDir("market-archive-ensure-covered-");
    const archivePath = NodePath.join(dir, "archive.sqlite");
    const hydrationPath = NodePath.join(dir, "queue.json");
    const writer = openArchiveDatabase(archivePath);
    const { fromT, toT } = hydrationWindow();
    upsertCandles(writer, gridOpens(fromT, toT, MINUTE).map(hydrationBar));
    writer.close();

    const archive = makeTradingMarketArchive(archivePath, "hyperliquid", hydrationPath);
    const answer = yield* archive.ensureCoverage({
      coin: "ETH",
      interval: "1m",
      fromT,
      toT,
      purpose: "study",
      now: Date.now(),
    });
    assert.strictEqual(answer.outcome, "already_covered");
    assert.strictEqual(answer.reason, null);
    assert.strictEqual(answer.coverage.recordingSince, fromT);
    // The ordinary case costs no queue work at all.
    assert.strictEqual(NodeFS.existsSync(hydrationPath), false);
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }),
);

// The gap-overlap proof: the ask itself. A window whose bars all exist but
// which a gap record still overlaps must NOT answer `already_covered` — and
// the direct evidence is that a request was queued for the writer at all.
// it.live: the queue-file watcher waits on real fs timing by design (see the
// header); it.effect's frozen clock would turn a missed wake into a hang.
it.live("ensureCoverage never claims coverage while a known gap overlaps the window", () => {
  const dir = tempDir("market-archive-ensure-gap-");
  return Effect.gen(function* () {
    const archivePath = NodePath.join(dir, "archive.sqlite");
    const hydrationPath = NodePath.join(dir, "queue.json");
    const writer = openArchiveDatabase(archivePath);
    const { fromT, toT } = hydrationWindow();
    upsertCandles(writer, gridOpens(fromT, toT, MINUTE).map(hydrationBar));
    recordKnownGap(writer, {
      coin: "ETH",
      interval: "1m",
      fromT: fromT + 2 * MINUTE,
      toT: fromT + 4 * MINUTE,
      recordedAt: Date.now(),
    });
    writer.close();

    const archive = makeTradingMarketArchive(archivePath, "hyperliquid", hydrationPath);
    const { fiber, appeared } = yield* forkedEnsure(
      archive,
      { coin: "ETH", interval: "1m", fromT, toT, purpose: "study", now: Date.now() },
      hydrationPath,
    );
    expect(appeared.fromT).toBe(fromT);
    expect(appeared.toT).toBe(toT);
    yield* Fiber.interrupt(fiber);
  }).pipe(Effect.ensuring(Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true }))));
});

// The Devcon shape at the service seam: an early occurrence older than the
// source's own history, later occurrences fully archived. The recoverable
// part is whole, but the window is not complete — so the request goes to the
// writer instead of answering `already_covered` over history that can never
// exist. Same it.live rationale as the gap-overlap proof above.
it.live(
  "ensureCoverage does not answer already_covered when the window predates the source",
  () => {
    const dir = tempDir("market-archive-ensure-devcon-");
    return Effect.gen(function* () {
      const archivePath = NodePath.join(dir, "archive.sqlite");
      const hydrationPath = NodePath.join(dir, "queue.json");
      const now = Date.now();
      const DAY = INTERVAL_MS["1d"];
      const floor = providerReachFloor("1d", now) as number;
      const floorOpen = Math.ceil(floor / DAY) * DAY;
      const fromT = floor - 3 * DAY;
      const toT = floor + 20 * DAY;
      const writer = openArchiveDatabase(archivePath);
      const dayBar = (open: number): CandleRow => ({
        coin: "ETH",
        interval: "1d",
        t: open,
        tClose: open + DAY - 1,
        o: 100,
        h: 101,
        l: 99,
        c: 100.5,
        v: 1,
        n: 3,
      });
      // Every recoverable bar already stored; the pre-floor days are absent
      // because the source can never serve them.
      upsertCandles(writer, gridOpens(floorOpen, toT, DAY).map(dayBar));
      writer.close();

      const archive = makeTradingMarketArchive(archivePath, "hyperliquid", hydrationPath);
      const { fiber, appeared } = yield* forkedEnsure(
        archive,
        { coin: "ETH", interval: "1d", fromT, toT, purpose: "study", now },
        hydrationPath,
      );
      expect(appeared.fromT).toBe(fromT);
      expect(appeared.toT).toBe(toT);
      yield* Fiber.interrupt(fiber);
    }).pipe(
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true }))),
    );
  },
);

// Same it.live rationale as the two proofs above: the watcher and the
// fiber's 30-second deadline race both run on real time by design.
it.live(
  "ensureCoverage queues the exact window and relays the writer's answer by stable id",
  () => {
    const dir = tempDir("market-archive-ensure-queue-");
    return Effect.gen(function* () {
      const archivePath = NodePath.join(dir, "archive.sqlite");
      const hydrationPath = NodePath.join(dir, "queue.json");
      const { fromT, toT } = hydrationWindow();
      const archive = makeTradingMarketArchive(archivePath, "hyperliquid", hydrationPath);

      const fiber = yield* Effect.forkScoped(
        archive.ensureCoverage({
          coin: "ETH",
          interval: "1m",
          fromT,
          toT,
          purpose: "study",
          now: Date.now(),
        }),
      );

      // The writer's eye: watch the queue file itself for the request, the same
      // event the archiver's watcher wakes on (slice-bounded, see the helper).
      const appeared = yield* Effect.promise(() => awaitQueuedRequest(hydrationPath));
      assert.strictEqual(appeared.venue, "hyperliquid");
      assert.strictEqual(appeared.coin, "ETH");
      assert.strictEqual(appeared.interval, "1m");
      assert.strictEqual(appeared.fromT, fromT);
      assert.strictEqual(appeared.toT, toT);

      // The archiver's answer, written the way the archiver writes it.
      yield* Effect.sync(() => {
        const locked = withHydrationQueueLock(hydrationPath, () => {
          const loaded = loadHydrationQueue(hydrationPath);
          if (loaded.status !== "ok") return null;
          storeHydrationQueue(
            hydrationPath,
            recordHydrationResult(loaded.queue, {
              id: appeared.id,
              outcome: "partial",
              finishedAt: Date.now(),
              barsFetched: 12,
            }),
          );
          return true;
        });
        if (!locked.ok || locked.value !== true) throw new Error("the writer could not answer");
      });

      const answer = yield* Fiber.join(fiber);
      assert.strictEqual(answer.outcome, "partial");
      assert.strictEqual(answer.coverage.recordingSince, null);
    }).pipe(
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true }))),
    );
  },
);

it.effect("ensureCoverage refuses a malformed queue without erasing pending work", () =>
  Effect.gen(function* () {
    const dir = tempDir("market-archive-ensure-malformed-");
    const archivePath = NodePath.join(dir, "archive.sqlite");
    const hydrationPath = NodePath.join(dir, "queue.json");
    const garbage = "{ this is not the queue";
    NodeFS.writeFileSync(hydrationPath, garbage);
    const { fromT, toT } = hydrationWindow();

    const archive = makeTradingMarketArchive(archivePath, "hyperliquid", hydrationPath);
    const answer = yield* archive.ensureCoverage({
      coin: "ETH",
      interval: "1m",
      fromT,
      toT,
      purpose: "study",
      now: Date.now(),
    });
    assert.strictEqual(answer.outcome, "unsupported");
    assert.include(answer.reason, "unreadable");
    // Unusable state was left exactly as it was found.
    assert.strictEqual(NodeFS.readFileSync(hydrationPath, "utf8"), garbage);
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }),
);

it.effect(
  "ensureCoverage answers source_window_exhausted for a window older than the source's history",
  () =>
    Effect.gen(function* () {
      const dir = tempDir("market-archive-ensure-exhausted-");
      const archivePath = NodePath.join(dir, "archive.sqlite");
      const hydrationPath = NodePath.join(dir, "queue.json");
      const now = Date.now();
      const floor = providerReachFloor("1d", now) as number;
      const DAY = INTERVAL_MS["1d"];

      const archive = makeTradingMarketArchive(archivePath, "hyperliquid", hydrationPath);
      const answer = yield* archive.ensureCoverage({
        coin: "ETH",
        interval: "1d",
        fromT: floor - 10 * DAY,
        toT: floor - 1,
        purpose: "study",
        now,
      });
      // The window's interval and venue are supported; the history is not —
      // `source_window_exhausted`, distinguishable at the tool surface from
      // `unsupported` input, and nothing is queued for a fetch that cannot run.
      assert.strictEqual(answer.outcome, "source_window_exhausted");
      assert.include(answer.reason, "has not made");
      assert.strictEqual(NodeFS.existsSync(hydrationPath), false);
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }),
);

it.effect("ensureCoverage refuses an interval the archive does not record", () =>
  Effect.gen(function* () {
    const dir = tempDir("market-archive-ensure-interval-");
    const archivePath = NodePath.join(dir, "archive.sqlite");
    const hydrationPath = NodePath.join(dir, "queue.json");
    const { fromT, toT } = hydrationWindow();

    const archive = makeTradingMarketArchive(archivePath, "hyperliquid", hydrationPath);
    const answer = yield* archive.ensureCoverage({
      coin: "ETH",
      interval: "2h",
      fromT,
      toT,
      purpose: "chart",
      now: Date.now(),
    });
    assert.strictEqual(answer.outcome, "unsupported");
    assert.include(answer.reason, "2h");
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }),
);
