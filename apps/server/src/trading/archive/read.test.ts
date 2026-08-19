/**
 * The read side, and the three writers the read side reads back.
 *
 * What is worth pinning: funding, asset contexts, and book summaries decode
 * out of the exact JSON the Info API returns and survive a round trip; the
 * trailing funding mean respects its window rather than averaging everything
 * stored; and every "latest" read returns the newest row, not the last one
 * written.
 *
 * Synthetic rows only — nothing here touches the network.
 */
// @effect-diagnostics nodeBuiltinImport:off - temp files for a temp database.
import { assert, describe, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { parseAssetContexts, upsertAssetContexts } from "./assetCtx.ts";
import { summariseBook, upsertBookSummaries } from "./bookSummary.ts";
import { recordKnownGap, upsertCandles, type CandleRow } from "./candles.ts";
import { openArchiveDatabase, type ArchiveDatabase } from "./db.ts";
import { parseFunding, upsertFunding } from "./funding.ts";
import {
  candlesInRange,
  knownGaps,
  latestAssetContext,
  latestBookSummary,
  latestCandle,
  trailingMeanFunding,
} from "./read.ts";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const NOW = 1_700_000_000_000;

const withArchive = <A>(use: (db: ArchiveDatabase) => A): A => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "market-archive-read-"));
  const db = openArchiveDatabase(NodePath.join(dir, "archive.sqlite"));
  try {
    return use(db);
  } finally {
    db.close();
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
};

const candle = (t: number, close: number): CandleRow => ({
  coin: "BTC",
  interval: "1m",
  t,
  tClose: t + MINUTE - 1,
  o: 100,
  h: 101,
  l: 99,
  c: close,
  v: 1.5,
  n: 7,
});

describe("latestCandle", () => {
  it("returns the newest bar, whatever order rows were written in", () => {
    withArchive((db) => {
      upsertCandles(db, [candle(3 * MINUTE, 103), candle(MINUTE, 101), candle(2 * MINUTE, 102)]);
      const latest = latestCandle(db, "BTC", "1m");
      assert.strictEqual(latest?.t, 3 * MINUTE);
      assert.strictEqual(latest?.c, 103);
      // The wire's `T` survives the column rename to `t_close`.
      assert.strictEqual(latest?.tClose, 3 * MINUTE + MINUTE - 1);
    });
  });

  it("returns null for a series with nothing recorded", () => {
    withArchive((db) => {
      assert.strictEqual(latestCandle(db, "SOL", "4h"), null);
    });
  });
});

describe("candlesInRange", () => {
  it("returns the inclusive range, oldest first", () => {
    withArchive((db) => {
      upsertCandles(
        db,
        [1, 2, 3, 4, 5].map((step) => candle(step * MINUTE, 100 + step)),
      );
      const rows = candlesInRange(db, "BTC", "1m", 2 * MINUTE, 4 * MINUTE);
      assert.deepStrictEqual(
        rows.map((row) => row.t),
        [2 * MINUTE, 3 * MINUTE, 4 * MINUTE],
      );
    });
  });

  it("does not bleed across coins", () => {
    withArchive((db) => {
      upsertCandles(db, [candle(MINUTE, 101), { ...candle(MINUTE, 999), coin: "ETH" }]);
      const rows = candlesInRange(db, "BTC", "1m", 0, 10 * MINUTE);
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0]?.c, 101);
    });
  });
});

describe("funding", () => {
  const wireFunding = (time: number, rate: string) => ({
    coin: "BTC",
    fundingRate: rate,
    premium: "0.0001",
    time,
  });

  it("decodes the wire shape and drops rows for other coins", () => {
    const rows = parseFunding(
      [wireFunding(1, "0.01"), { ...wireFunding(2, "0.02"), coin: "ETH" }, { time: 3 }],
      "BTC",
    );
    assert.deepStrictEqual(
      rows.map((row) => row.time),
      [1],
    );
    assert.strictEqual(rows[0]?.fundingRate, 0.01);
  });

  it("averages only the rows inside the trailing window", () => {
    withArchive((db) => {
      upsertFunding(db, [
        { coin: "BTC", time: NOW - 10 * DAY, fundingRate: 1, premium: 0 },
        { coin: "BTC", time: NOW - 2 * DAY, fundingRate: 0.2, premium: 0 },
        { coin: "BTC", time: NOW - 1 * DAY, fundingRate: 0.4, premium: 0 },
      ]);
      assert.closeTo(trailingMeanFunding(db, "BTC", 7, NOW) ?? Number.NaN, 0.3, 1e-12);
      // Widen the window and the row from ten days ago is included.
      assert.closeTo(trailingMeanFunding(db, "BTC", 30, NOW) ?? Number.NaN, 1.6 / 3, 1e-12);
    });
  });

  it("returns null when the window holds no rows", () => {
    withArchive((db) => {
      assert.strictEqual(trailingMeanFunding(db, "BTC", 7, NOW), null);
    });
  });

  it("re-pulling an already-stored hour rewrites it in place", () => {
    withArchive((db) => {
      upsertFunding(db, parseFunding([wireFunding(NOW, "0.01")], "BTC"));
      upsertFunding(db, parseFunding([wireFunding(NOW, "0.02")], "BTC"));
      const rows = db.all<{ funding_rate: number }>("SELECT funding_rate FROM funding");
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0]?.funding_rate, 0.02);
    });
  });
});

describe("asset contexts", () => {
  const response = [
    { universe: [{ name: "BTC" }, { name: "ETH" }, { name: "SOL" }] },
    [
      {
        funding: "0.0000125",
        openInterest: "40618.99",
        premium: "-0.00045",
        oraclePx: "64328.2",
        markPx: "64299.0",
        dayNtlVlm: "1436314655.92",
        prevDayPx: "64055.0",
      },
      { funding: "0.00001", openInterest: "888722.15", premium: "-0.0004" },
      {
        funding: "0.0000123",
        openInterest: "5220328.96",
        premium: "-0.00036",
        oraclePx: "76.805",
        markPx: "76.775",
        dayNtlVlm: "96662677.62",
        prevDayPx: "75.303",
      },
    ],
  ];

  it("resolves each coin by name and skips a context missing fields", () => {
    // ETH's context has no oraclePx, so it is dropped rather than written
    // with a zero that would read later as a real oracle print.
    const rows = parseAssetContexts(response, ["BTC", "ETH", "SOL", "DOGE"], NOW);
    assert.deepStrictEqual(
      rows.map((row) => row.coin),
      ["BTC", "SOL"],
    );
    assert.strictEqual(rows[0]?.openInterest, 40618.99);
    assert.strictEqual(rows[1]?.markPx, 76.775);
  });

  it("survives a response that is not the expected pair", () => {
    assert.deepStrictEqual(parseAssetContexts({ universe: [] }, ["BTC"], NOW), []);
    assert.deepStrictEqual(parseAssetContexts([{ universe: [{ name: "BTC" }] }], ["BTC"], NOW), []);
  });

  it("round-trips through the archive and reads back the newest sample", () => {
    withArchive((db) => {
      upsertAssetContexts(db, parseAssetContexts(response, ["BTC"], NOW - MINUTE));
      upsertAssetContexts(db, parseAssetContexts(response, ["BTC"], NOW));
      const latest = latestAssetContext(db, "BTC");
      assert.strictEqual(latest?.ts, NOW);
      assert.strictEqual(latest?.openInterest, 40618.99);
      assert.strictEqual(latest?.premium, -0.00045);
      assert.strictEqual(
        db.all<{ total: number }>("SELECT COUNT(*) AS total FROM asset_ctx")[0]?.total,
        2,
      );
    });
  });
});

describe("book summaries", () => {
  const bids = [
    { px: "100.0", sz: "1.0", n: 2 },
    { px: "99.0", sz: "2.0", n: 1 },
    { px: "98.0", sz: "3.0", n: 1 },
    { px: "97.0", sz: "4.0", n: 1 },
    { px: "96.0", sz: "5.0", n: 1 },
    { px: "95.0", sz: "100.0", n: 1 },
  ];
  const asks = [
    { px: "101.0", sz: "0.5", n: 1 },
    { px: "102.0", sz: "0.5", n: 1 },
  ];
  const book = { coin: "BTC", time: NOW, levels: [bids, asks] };

  it("summarises the top of book and sums only the top five levels", () => {
    const row = summariseBook(book, "BTC", NOW);
    assert.strictEqual(row?.bidPx, 100);
    assert.strictEqual(row?.bidSz, 1);
    assert.strictEqual(row?.askPx, 101);
    assert.strictEqual(row?.bidDepth5, 1 + 2 + 3 + 4 + 5);
    // A side thinner than five levels sums what it has.
    assert.strictEqual(row?.askDepth5, 1);
  });

  it("refuses to summarise a one-sided or malformed book", () => {
    assert.strictEqual(summariseBook({ ...book, levels: [[], asks] }, "BTC", NOW), null);
    assert.strictEqual(summariseBook({ coin: "BTC" }, "BTC", NOW), null);
    assert.strictEqual(summariseBook(null, "BTC", NOW), null);
  });

  it("round-trips through the archive", () => {
    withArchive((db) => {
      const row = summariseBook(book, "BTC", NOW);
      upsertBookSummaries(db, row === null ? [] : [row]);
      const latest = latestBookSummary(db, "BTC");
      assert.strictEqual(latest?.askPx, 101);
      assert.strictEqual(latest?.bidDepth5, 15);
    });
  });
});

describe("knownGaps", () => {
  it("reads back the recorded stretches oldest first, per series", () => {
    withArchive((db) => {
      const at = { recordedAt: NOW };
      recordKnownGap(db, { coin: "BTC", interval: "1m", fromT: 5_000, toT: 6_000, ...at });
      recordKnownGap(db, { coin: "BTC", interval: "1m", fromT: 1_000, toT: 2_000, ...at });
      recordKnownGap(db, { coin: "ETH", interval: "1m", fromT: 1_000, toT: 2_000, ...at });

      assert.deepStrictEqual(
        knownGaps(db, "BTC", "1m").map((gap) => gap.fromT),
        [1_000, 5_000],
      );
      assert.deepStrictEqual(knownGaps(db, "SOL", "1m"), []);
    });
  });
});
