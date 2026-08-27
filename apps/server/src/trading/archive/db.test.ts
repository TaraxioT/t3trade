/**
 * The archive's own version chain: a fresh file is built whole at the current
 * version, and a v1 file — coin-keyed, no venue column — is migrated in place
 * the first time it is opened, with every row preserved and backfilled to the
 * only venue v1 ever recorded.
 */
// @effect-diagnostics nodeBuiltinImport:off - temp files and a hand-built v1 fixture.
import { assert, describe, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { upsertCandles } from "./candles.ts";
import { ARCHIVE_VENUE } from "./config.ts";
import { ARCHIVE_SCHEMA_VERSION, openArchiveDatabase } from "./db.ts";

const withArchivePath = <A>(use: (path: string) => A): A => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "market-archive-db-"));
  try {
    return use(NodePath.join(dir, "archive.sqlite"));
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
};

/** Build a v1 archive by hand: the schema as it shipped, plus one row each. */
function writeV1Fixture(path: string): void {
  const db = new NodeSqlite.DatabaseSync(path);
  const statements = [
    `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID`,
    `CREATE TABLE candles (
       coin TEXT NOT NULL, interval TEXT NOT NULL, t INTEGER NOT NULL,
       t_close INTEGER NOT NULL, o REAL NOT NULL, h REAL NOT NULL,
       l REAL NOT NULL, c REAL NOT NULL, v REAL NOT NULL, n INTEGER NOT NULL,
       PRIMARY KEY (coin, interval, t)
     ) WITHOUT ROWID`,
    `CREATE TABLE funding (
       coin TEXT NOT NULL, time INTEGER NOT NULL,
       funding_rate REAL NOT NULL, premium REAL NOT NULL,
       PRIMARY KEY (coin, time)
     ) WITHOUT ROWID`,
    `CREATE TABLE asset_ctx (
       coin TEXT NOT NULL, ts INTEGER NOT NULL, open_interest REAL NOT NULL,
       premium REAL NOT NULL, oracle_px REAL NOT NULL, mark_px REAL NOT NULL,
       day_ntl_volume REAL NOT NULL, funding REAL NOT NULL,
       PRIMARY KEY (coin, ts)
     ) WITHOUT ROWID`,
    `CREATE TABLE book_summary (
       coin TEXT NOT NULL, ts INTEGER NOT NULL, bid_px REAL NOT NULL,
       bid_sz REAL NOT NULL, ask_px REAL NOT NULL, ask_sz REAL NOT NULL,
       bid_depth5 REAL NOT NULL, ask_depth5 REAL NOT NULL,
       PRIMARY KEY (coin, ts)
     ) WITHOUT ROWID`,
    `CREATE TABLE known_gaps (
       coin TEXT NOT NULL, interval TEXT NOT NULL, from_t INTEGER NOT NULL,
       to_t INTEGER NOT NULL, recorded_at INTEGER NOT NULL,
       PRIMARY KEY (coin, interval, from_t, to_t)
     ) WITHOUT ROWID`,
    `INSERT INTO meta (key, value) VALUES ('schema_version', '1')`,
    `INSERT INTO candles VALUES ('BTC', '1m', 60000, 119999, 1, 2, 0.5, 1.5, 10, 3)`,
    `INSERT INTO funding VALUES ('BTC', 3600000, 0.0001, 0.0002)`,
    `INSERT INTO asset_ctx VALUES ('ETH', 60000, 1000, 0.1, 100, 101, 5000, 0.00001)`,
    `INSERT INTO book_summary VALUES ('BTC', 60000, 99, 1, 101, 2, 5, 6)`,
    `INSERT INTO known_gaps VALUES ('BTC', '1m', 0, 59999, 60000)`,
  ];
  for (const statement of statements) {
    db.prepare(statement).run();
  }
  db.close();
}

describe("applySchema", () => {
  it("stamps a fresh file at the current version with venue-keyed tables", () => {
    withArchivePath((path) => {
      const db = openArchiveDatabase(path);
      const version = db.all<{ value: string }>(
        "SELECT value FROM meta WHERE key = 'schema_version'",
      );
      assert.strictEqual(version[0]?.value, String(ARCHIVE_SCHEMA_VERSION));

      upsertCandles(db, [
        { coin: "BTC", interval: "1m", t: 0, tClose: 1, o: 1, h: 1, l: 1, c: 1, v: 1, n: 1 },
      ]);
      const rows = db.all<{ venue: string }>("SELECT venue FROM candles");
      assert.strictEqual(rows[0]?.venue, ARCHIVE_VENUE);
      db.close();
    });
  });

  it("migrates a v1 file in place, preserving every row with venue backfilled", () => {
    withArchivePath((path) => {
      writeV1Fixture(path);
      const db = openArchiveDatabase(path);

      const version = db.all<{ value: string }>(
        "SELECT value FROM meta WHERE key = 'schema_version'",
      );
      assert.strictEqual(version[0]?.value, "2");

      const candle = db.all<{ venue: string; coin: string; t: number; c: number }>(
        "SELECT venue, coin, t, c FROM candles",
      );
      assert.deepStrictEqual(candle, [{ venue: "hyperliquid", coin: "BTC", t: 60000, c: 1.5 }]);

      for (const table of ["funding", "asset_ctx", "book_summary", "known_gaps"]) {
        const rows = db.all<{ venue: string }>(`SELECT venue FROM ${table}`);
        assert.strictEqual(rows.length, 1, table);
        assert.strictEqual(rows[0]?.venue, "hyperliquid", table);
      }

      // The migrated file accepts the current writers: same bar upserted twice
      // stays one row, keyed by (venue, coin, interval, t).
      const bar = {
        coin: "BTC",
        interval: "1m" as const,
        t: 60000,
        tClose: 119999,
        o: 1,
        h: 2,
        l: 0.5,
        c: 1.7,
        v: 11,
        n: 4,
      };
      upsertCandles(db, [bar]);
      upsertCandles(db, [bar]);
      const after = db.all<{ total: number; c: number }>(
        "SELECT COUNT(*) AS total, MAX(c) AS c FROM candles",
      );
      assert.strictEqual(after[0]?.total, 1);
      assert.strictEqual(after[0]?.c, 1.7);
      db.close();
    });
  });

  it("reopening a migrated file is a no-op", () => {
    withArchivePath((path) => {
      writeV1Fixture(path);
      openArchiveDatabase(path).close();
      const db = openArchiveDatabase(path);
      const rows = db.all<{ total: number }>("SELECT COUNT(*) AS total FROM candles");
      assert.strictEqual(rows[0]?.total, 1);
      db.close();
    });
  });

  it("refuses a file stamped by a newer build", () => {
    withArchivePath((path) => {
      const db = openArchiveDatabase(path);
      db.run("UPDATE meta SET value = '99' WHERE key = 'schema_version'");
      db.close();
      assert.throws(() => openArchiveDatabase(path), /newer than this build/);
    });
  });
});
