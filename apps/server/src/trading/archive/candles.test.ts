/**
 * The archive's write path, against a real temp SQLite file.
 *
 * What is worth pinning: a bar re-fetched while still in progress overwrites
 * itself rather than duplicating; a malformed or foreign row never reaches
 * the file; the repair planner asks for the whole servable window and names
 * exactly the stretch that fell out of it; and a gap re-recorded on a second
 * restart stays one row.
 *
 * No network here — every response is synthetic JSON in the exact shape the
 * Info API returns.
 */
// @effect-diagnostics nodeBuiltinImport:off - temp files for a temp database.
import { assert, describe, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  latestStoredOpen,
  oldestServableOpen,
  parseCandles,
  planCandleRepair,
  recordKnownGap,
  upsertCandles,
} from "./candles.ts";
import { ARCHIVE_SCHEMA_VERSION, openArchiveDatabase, type ArchiveDatabase } from "./db.ts";

const MINUTE = 60_000;

/** A fresh archive in a temp directory, removed when the test ends. */
const withArchive = <A>(use: (db: ArchiveDatabase) => A): A => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "market-archive-"));
  const db = openArchiveDatabase(NodePath.join(dir, "archive.sqlite"));
  try {
    return use(db);
  } finally {
    db.close();
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
};

/** One wire candle, in the exchange's string-encoded shape. */
const wireCandle = (t: number, close: number, volume: number) => ({
  t,
  T: t + MINUTE - 1,
  s: "BTC",
  i: "1m",
  o: "100.0",
  h: "101.0",
  l: "99.0",
  c: String(close),
  v: String(volume),
  n: 42,
});

describe("archive schema", () => {
  it("stamps its own version and does not touch an app migration chain", () => {
    withArchive((db) => {
      const rows = db.all<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'");
      assert.strictEqual(rows[0]?.value, String(ARCHIVE_SCHEMA_VERSION));

      const tables = db
        .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .map((row) => row.name);
      assert.deepStrictEqual(tables, [
        "asset_ctx",
        "book_summary",
        "candles",
        "funding",
        "known_gaps",
        "meta",
      ]);
    });
  });

  it("is safe to open twice", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "market-archive-"));
    const path = NodePath.join(dir, "archive.sqlite");
    try {
      const first = openArchiveDatabase(path);
      upsertCandles(first, parseCandles([wireCandle(0, 100, 1)], "BTC", "1m"));
      first.close();

      const second = openArchiveDatabase(path);
      assert.strictEqual(latestStoredOpen(second, "BTC", "1m"), 0);
      second.close();
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("parseCandles", () => {
  it("keeps only well-formed bars for the coin and interval asked for", () => {
    const raw = [
      wireCandle(MINUTE, 100, 1),
      { ...wireCandle(2 * MINUTE, 100, 1), s: "ETH" },
      { ...wireCandle(3 * MINUTE, 100, 1), i: "5m" },
      { ...wireCandle(4 * MINUTE, 100, 1), c: "not-a-price" },
      { ...wireCandle(5 * MINUTE, 100, 1), t: undefined },
      "nonsense",
    ];
    const rows = parseCandles(raw, "BTC", "1m");
    assert.deepStrictEqual(
      rows.map((row) => row.t),
      [MINUTE],
    );
  });

  it("returns nothing for a response that is not an array", () => {
    assert.deepStrictEqual(parseCandles({ error: "nope" }, "BTC", "1m"), []);
    assert.deepStrictEqual(parseCandles(null, "BTC", "1m"), []);
  });
});

describe("upsertCandles", () => {
  it("overwrites an in-progress bar instead of duplicating it", () => {
    withArchive((db) => {
      upsertCandles(db, parseCandles([wireCandle(MINUTE, 100, 0.5)], "BTC", "1m"));
      upsertCandles(db, parseCandles([wireCandle(MINUTE, 107, 3.25)], "BTC", "1m"));

      const rows = db.all<{ c: number; v: number }>("SELECT c, v FROM candles WHERE t = ?", MINUTE);
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0]?.c, 107);
      assert.strictEqual(rows[0]?.v, 3.25);
    });
  });

  it("keeps series apart by coin and interval", () => {
    withArchive((db) => {
      upsertCandles(db, [
        { coin: "BTC", interval: "1m", t: 0, tClose: 1, o: 1, h: 1, l: 1, c: 1, v: 1, n: 1 },
        { coin: "ETH", interval: "1m", t: 0, tClose: 1, o: 2, h: 2, l: 2, c: 2, v: 2, n: 2 },
        { coin: "BTC", interval: "5m", t: 0, tClose: 1, o: 3, h: 3, l: 3, c: 3, v: 3, n: 3 },
      ]);
      const rows = db.all<{ total: number }>("SELECT COUNT(*) AS total FROM candles");
      assert.strictEqual(rows[0]?.total, 3);
    });
  });

  it("reports an empty batch as no work", () => {
    withArchive((db) => {
      assert.strictEqual(upsertCandles(db, []), 0);
      assert.strictEqual(latestStoredOpen(db, "BTC", "1m"), null);
    });
  });
});

describe("planCandleRepair", () => {
  const now = 10_000 * MINUTE;
  const windowBars = 5_000;

  it("asks for the whole servable window on a cold start and names no gap", () => {
    const plan = planCandleRepair({
      latestStoredOpen: null,
      now,
      intervalMs: MINUTE,
      windowBars,
    });
    assert.strictEqual(plan.fetchFrom, oldestServableOpen(now, MINUTE, windowBars));
    assert.strictEqual(plan.fetchTo, now);
    assert.strictEqual(plan.unrecoverable, null);
  });

  it("names no gap when the stored history reaches into the window", () => {
    const oldest = oldestServableOpen(now, MINUTE, windowBars);
    const plan = planCandleRepair({
      latestStoredOpen: oldest - MINUTE,
      now,
      intervalMs: MINUTE,
      windowBars,
    });
    assert.strictEqual(plan.unrecoverable, null);
  });

  it("names exactly the bars that fell out of the window during downtime", () => {
    const oldest = oldestServableOpen(now, MINUTE, windowBars);
    const latest = oldest - 4 * MINUTE;
    const plan = planCandleRepair({
      latestStoredOpen: latest,
      now,
      intervalMs: MINUTE,
      windowBars,
    });
    assert.deepStrictEqual(plan.unrecoverable, {
      fromT: latest + MINUTE,
      toT: oldest - MINUTE,
    });
    // Even with a gap it can never fill, it still asks for everything it can.
    assert.strictEqual(plan.fetchFrom, oldest);
  });

  it("still asks for the window when the stored bar is somehow in the future", () => {
    const plan = planCandleRepair({
      latestStoredOpen: now + 10 * MINUTE,
      now,
      intervalMs: MINUTE,
      windowBars,
    });
    assert.strictEqual(plan.fetchFrom, oldestServableOpen(now, MINUTE, windowBars));
    assert.strictEqual(plan.unrecoverable, null);
  });

  it("scales the window with the interval", () => {
    const hour = 60 * MINUTE;
    const plan = planCandleRepair({
      latestStoredOpen: null,
      now,
      intervalMs: hour,
      windowBars,
    });
    assert.strictEqual(now - plan.fetchFrom > 4_990 * hour, true);
  });
});

describe("recordKnownGap", () => {
  it("records the same gap once however many restarts see it", () => {
    withArchive((db) => {
      const gap = { coin: "BTC", interval: "1m", fromT: 1_000, toT: 2_000 };
      recordKnownGap(db, { ...gap, recordedAt: 5_000 });
      recordKnownGap(db, { ...gap, recordedAt: 9_000 });

      const rows = db.all<{ recorded_at: number }>("SELECT recorded_at FROM known_gaps");
      assert.strictEqual(rows.length, 1);
      // The first sighting is what stands; a restart does not restamp it.
      assert.strictEqual(rows[0]?.recorded_at, 5_000);
    });
  });
});
