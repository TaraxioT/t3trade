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
// @effect-diagnostics nodeBuiltinImport:off - temp files for a temp database.
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { upsertAssetContexts } from "./archive/assetCtx.ts";
import { upsertBookSummaries } from "./archive/bookSummary.ts";
import { openArchiveDatabase } from "./archive/db.ts";
import { upsertFunding } from "./archive/funding.ts";
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
    assert.closeTo(stats.mean, (0.1 + 0.2 - 0.12 + 0.04) / 4, 1e-12);
    assert.strictEqual(stats.latestRate, 0.04);
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
