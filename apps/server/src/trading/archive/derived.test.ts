/**
 * The thirteen derived metrics of plan 38 §3.3, each pinned by one hand-checked
 * fixture: the expected value is written as a literal with the arithmetic that
 * produced it, so a regression is a readable diff rather than a floating-point
 * mystery. The refusal paths (window not covered, context missing, known gap)
 * get the same treatment — the kind and a fragment of the detail.
 *
 * Synthetic rows only, in the read.test.ts convention: a temp file seeded
 * through the archive's own upserters. Nothing touches the network or the
 * live `~/.t3/userdata`.
 */
// @effect-diagnostics nodeBuiltinImport:off - temp files for a temp database.
import { assert, describe, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { upsertAssetContexts } from "./assetCtx.ts";
import { upsertBookSummaries } from "./bookSummary.ts";
import { recordKnownGap, upsertCandles, type CandleRow } from "./candles.ts";
import { openArchiveDatabase, type ArchiveDatabase } from "./db.ts";
import { derivedMetricValue, type DerivedMetricOutcome } from "./derived.ts";
import { upsertFunding } from "./funding.ts";

import type { DerivedMetricParams } from "@t3tools/trading-contracts/watch";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = 1_700_000_000_000;

const withArchive = <A>(use: (db: ArchiveDatabase) => A): A => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "market-archive-derived-"));
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
  o: close,
  h: close + 1,
  l: close - 1,
  c: close,
  v: 1,
  n: 3,
});

const ctxSample = (ts: number, oi: number, premium: number) => ({
  coin: "BTC",
  ts,
  openInterest: oi,
  premium,
  oraclePx: 100,
  markPx: 100,
  dayNtlVolume: 1_000,
  funding: 0,
});

const bookSample = (ts: number, bidDepth5: number, askDepth5: number) => ({
  coin: "BTC",
  ts,
  bidPx: 100,
  bidSz: 1,
  askPx: 101,
  askSz: 1,
  bidDepth5,
  askDepth5,
});

const ok = (outcome: DerivedMetricOutcome): number => {
  assert.strictEqual(outcome.status, "ok");
  if (outcome.status !== "ok") throw new Error("unreachable");
  return outcome.value;
};

const unavailable = (
  outcome: DerivedMetricOutcome,
  kind: "archive" | "window" | "context",
  detailFragment: string,
): void => {
  assert.strictEqual(outcome.status, "unavailable");
  if (outcome.status !== "unavailable") return;
  assert.strictEqual(outcome.kind, kind);
  assert.include(outcome.detail, detailFragment);
};

describe("funding_mean", () => {
  const params: DerivedMetricParams = { metric: "funding_mean", windowDays: 1 };

  it("averages only the in-window rows when holdings cover the start", () => {
    withArchive((db) => {
      upsertFunding(db, [
        // Pre-window: proves holdings reach back past the window start.
        { coin: "BTC", time: NOW - 2 * DAY, fundingRate: 9e-4, premium: 0 },
        { coin: "BTC", time: NOW - 12 * HOUR, fundingRate: 1e-4, premium: 0 },
        { coin: "BTC", time: NOW - 6 * HOUR, fundingRate: 2e-4, premium: 0 },
        { coin: "BTC", time: NOW - 1 * HOUR, fundingRate: 3e-4, premium: 0 },
      ]);
      // (1e-4 + 2e-4 + 3e-4) / 3 = 2.0e-4; the 9e-4 row is outside the window.
      assert.strictEqual(ok(derivedMetricValue(db, "BTC", params, { now: NOW })), 2.0e-4);
    });
  });

  it("is window-unavailable when the archive starts mid-window", () => {
    withArchive((db) => {
      upsertFunding(db, [{ coin: "BTC", time: NOW - 12 * HOUR, fundingRate: 1e-4, premium: 0 }]);
      unavailable(derivedMetricValue(db, "BTC", params, { now: NOW }), "window", "after the");
    });
  });
});

describe("funding_sign_flip", () => {
  it("uses the identical mean computation; flip logic is the evaluator's", () => {
    withArchive((db) => {
      upsertFunding(db, [
        { coin: "BTC", time: NOW - 2 * DAY, fundingRate: 9e-4, premium: 0 },
        { coin: "BTC", time: NOW - 12 * HOUR, fundingRate: 1e-4, premium: 0 },
        { coin: "BTC", time: NOW - 1 * HOUR, fundingRate: 2e-4, premium: 0 },
      ]);
      // (1e-4 + 2e-4) / 2 = 1.5e-4.
      assert.closeTo(
        ok(
          derivedMetricValue(
            db,
            "BTC",
            { metric: "funding_sign_flip", windowDays: 1 },
            { now: NOW },
          ),
        ),
        1.5e-4,
        1e-15,
      );
    });
  });
});

describe("funding_cumulative", () => {
  it("sums the rates since position entry", () => {
    withArchive((db) => {
      upsertFunding(db, [
        // Pre-entry: proves holdings cover the entry time.
        { coin: "BTC", time: NOW - 4 * HOUR, fundingRate: 5e-4, premium: 0 },
        { coin: "BTC", time: NOW - 2 * HOUR, fundingRate: 1e-4, premium: 0 },
        { coin: "BTC", time: NOW - 1 * HOUR, fundingRate: 2.5e-4, premium: 0 },
      ]);
      // 1e-4 + 2.5e-4 = 3.5e-4; the pre-entry 5e-4 row is excluded.
      assert.strictEqual(
        ok(
          derivedMetricValue(
            db,
            "BTC",
            { metric: "funding_cumulative", sinceEntry: true },
            { now: NOW, positionEntryAt: NOW - 3 * HOUR },
          ),
        ),
        3.5e-4,
      );
      // No open position → a context skip, not a number.
      unavailable(
        derivedMetricValue(
          db,
          "BTC",
          { metric: "funding_cumulative", sinceEntry: true },
          { now: NOW },
        ),
        "context",
        "no open position",
      );
    });
  });
});

describe("sigma_return", () => {
  it("is the last return in population-σ units of the trailing returns", () => {
    withArchive((db) => {
      upsertCandles(
        db,
        [100, 101, 102, 103].map((c, i) => candle(NOW - (4 - i) * MINUTE, c)),
      );
      // returns r = 1/100, 1/101, 1/102; r̄ = 0.009901635, σ_pop = 0.00008004999225081;
      // value = r_3/σ = 0.00980392156862745 / 0.00008004999225081 = 122.47248616726559.
      assert.closeTo(
        ok(
          derivedMetricValue(
            db,
            "BTC",
            { metric: "sigma_return", interval: "1m", period: 3 },
            { now: NOW },
          ),
        ),
        122.47248616726559,
        1e-9,
      );
    });
  });

  it("is archive-unavailable when a known gap overlaps the lookback", () => {
    withArchive((db) => {
      upsertCandles(
        db,
        [100, 101, 102, 103].map((c, i) => candle(NOW - (4 - i) * MINUTE, c)),
      );
      // The lookback is the last 4 bar-widths from now: [NOW − 4m, NOW].
      recordKnownGap(db, {
        coin: "BTC",
        interval: "1m",
        fromT: NOW - 3 * MINUTE,
        toT: NOW - 2 * MINUTE,
        recordedAt: NOW,
      });
      unavailable(
        derivedMetricValue(
          db,
          "BTC",
          { metric: "sigma_return", interval: "1m", period: 3 },
          { now: NOW },
        ),
        "archive",
        "known gap",
      );
    });
  });
});

describe("sigma_distance", () => {
  const bars = (): ReadonlyArray<CandleRow> =>
    [100, 102, 104].map((c, i) => candle(NOW - (3 - i) * MINUTE, c));

  it("basis mean: (last − mean)/σ of the closes", () => {
    withArchive((db) => {
      upsertCandles(db, bars());
      // mean = 102, σ_pop{100,102,104} = sqrt(8/3) = 1.632993161855452;
      // value = (104 − 102)/1.632993161855452 = 1.224744871391589.
      assert.closeTo(
        ok(
          derivedMetricValue(
            db,
            "BTC",
            { metric: "sigma_distance", interval: "1m", period: 3, basis: "mean" },
            { now: NOW },
          ),
        ),
        1.224744871391589,
        1e-12,
      );
    });
  });

  it("basis ema: distance from the seeded EMA instead of the mean", () => {
    withArchive((db) => {
      upsertCandles(db, bars());
      // EMA(3), α = 0.5, seeded at 100: 100 → 101 → 102.5;
      // value = (104 − 102.5)/1.632993161855452 = 0.9185586535436918.
      assert.closeTo(
        ok(
          derivedMetricValue(
            db,
            "BTC",
            { metric: "sigma_distance", interval: "1m", period: 3, basis: "ema" },
            { now: NOW },
          ),
        ),
        0.9185586535436918,
        1e-12,
      );
    });
  });
});

describe("sigma_ratio", () => {
  it("is fast return-σ over slow return-σ", () => {
    withArchive((db) => {
      upsertCandles(
        db,
        [100, 101, 102, 103].map((c, i) => candle(NOW - (4 - i) * MINUTE, c)),
      );
      // returns r1..r3 = 1/100, 1/101, 1/102;
      // σ_slow = σ_pop{r1,r2,r3} = 0.00008004999225081, σ_fast = σ_pop{r2,r3} =
      // 0.00004853426519122513; value = σ_fast/σ_slow = 0.6062994364716134.
      assert.closeTo(
        ok(
          derivedMetricValue(
            db,
            "BTC",
            { metric: "sigma_ratio", interval: "1m", fast: 2, slow: 3 },
            { now: NOW },
          ),
        ),
        0.6062994364716134,
        1e-12,
      );
    });
  });
});

describe("ema_distance", () => {
  it("is the last close's relative distance from the seeded EMA", () => {
    withArchive((db) => {
      upsertCandles(
        db,
        [100, 102, 104].map((c, i) => candle(NOW - (3 - i) * MINUTE, c)),
      );
      // EMA(3), α = 0.5, seeded at 100: 100 → 101 → 102.5;
      // value = (104 − 102.5)/102.5 = 0.014634146341463415.
      assert.closeTo(
        ok(
          derivedMetricValue(
            db,
            "BTC",
            { metric: "ema_distance", interval: "1m", period: 3 },
            { now: NOW },
          ),
        ),
        0.014634146341463415,
        1e-15,
      );
    });
  });
});

describe("oi_change_rate", () => {
  const params: DerivedMetricParams = { metric: "oi_change_rate", windowMinutes: 10 };

  it("is (last − first)/first over the covered window", () => {
    withArchive((db) => {
      upsertAssetContexts(db, [
        // Oldest at NOW−9m ≤ window start + 2m slack: coverage holds.
        ctxSample(NOW - 9 * MINUTE, 100, 0),
        ctxSample(NOW - 5 * MINUTE, 102, 0),
        ctxSample(NOW, 105, 0),
      ]);
      // (105 − 100)/100 = 0.05.
      assert.strictEqual(ok(derivedMetricValue(db, "BTC", params, { now: NOW })), 0.05);
    });
  });

  it("is window-unavailable when the samples only cover the recent tail", () => {
    withArchive((db) => {
      upsertAssetContexts(db, [ctxSample(NOW - 1 * MINUTE, 100, 0), ctxSample(NOW, 105, 0)]);
      unavailable(derivedMetricValue(db, "BTC", params, { now: NOW }), "window", "cover only");
    });
  });
});

describe("premium_mean", () => {
  it("averages the premium samples over the covered window", () => {
    withArchive((db) => {
      upsertAssetContexts(db, [
        ctxSample(NOW - 9 * MINUTE, 100, -0.0001),
        ctxSample(NOW - 5 * MINUTE, 101, 0.0001),
        ctxSample(NOW, 102, 0.0003),
      ]);
      // (−0.0001 + 0.0001 + 0.0003)/3 = 0.0001.
      assert.closeTo(
        ok(
          derivedMetricValue(
            db,
            "BTC",
            { metric: "premium_mean", windowMinutes: 10 },
            { now: NOW },
          ),
        ),
        0.0001,
        1e-15,
      );
    });
  });
});

describe("depth_ratio", () => {
  it("means bid/ask depth over the window, skipping one-sided books", () => {
    withArchive((db) => {
      upsertBookSummaries(db, [
        bookSample(NOW - 9 * MINUTE, 10, 10),
        bookSample(NOW - 5 * MINUTE, 12, 8),
        // ask_depth5 = 0: a one-sided book, not a ratio — skipped.
        bookSample(NOW - 3 * MINUTE, 9, 0),
        bookSample(NOW, 10, 5),
      ]);
      // (10/10 + 12/8 + 10/5)/3 = (1 + 1.5 + 2)/3 = 1.5.
      assert.strictEqual(
        ok(
          derivedMetricValue(db, "BTC", { metric: "depth_ratio", windowMinutes: 10 }, { now: NOW }),
        ),
        1.5,
      );
    });
  });
});

describe("bars_since", () => {
  it("counts closed bars strictly after the reference watch fired", () => {
    withArchive((db) => {
      // Three 1m bars: t = NOW−2m, NOW−1m, NOW; t_close = t + 59_999.
      upsertCandles(
        db,
        [100, 101, 102].map((c, i) => candle(NOW - (2 - i) * MINUTE, c)),
      );
      const sinceMs = NOW - 2 * MINUTE + 59_999;
      // t_close > sinceMs holds for the second and third bar → 2.
      assert.strictEqual(
        ok(
          derivedMetricValue(
            db,
            "BTC",
            { metric: "bars_since", interval: "1m", sinceWatchId: "watch-1" },
            { now: NOW, sinceMs },
          ),
        ),
        2,
      );
      // No fired reference → a context skip.
      unavailable(
        derivedMetricValue(
          db,
          "BTC",
          { metric: "bars_since", interval: "1m", sinceWatchId: "watch-1" },
          { now: NOW },
        ),
        "context",
        "reference watch",
      );
    });
  });
});

describe("hold_bars", () => {
  it("counts closed bars strictly after the position was opened", () => {
    withArchive((db) => {
      upsertCandles(
        db,
        [100, 101, 102].map((c, i) => candle(NOW - (2 - i) * MINUTE, c)),
      );
      const entryAt = NOW - 2 * MINUTE + 59_999;
      // Same count as bars_since over the same anchor: 2.
      assert.strictEqual(
        ok(
          derivedMetricValue(
            db,
            "BTC",
            { metric: "hold_bars", interval: "1m" },
            {
              now: NOW,
              positionEntryAt: entryAt,
            },
          ),
        ),
        2,
      );
      // No open position → a context skip.
      unavailable(
        derivedMetricValue(db, "BTC", { metric: "hold_bars", interval: "1m" }, { now: NOW }),
        "context",
        "no open position",
      );
    });
  });
});

describe("vwap_distance", () => {
  // Hand-checked fixture. NOW sits 80,000,000 ms (~22.2h) inside its UTC day,
  // so the session holds the four bars below and anything earlier is prior
  // day. Typical prices are integers so the VWAP arithmetic is exact:
  // Σ tp·v = 101·10 + 104·30 + 99·20 + 103·40 = 10,230 over Σv = 100 →
  // VWAP 102.3. Session closes [101, 104, 99, 103]: mean 101.75, population
  // variance 14.75/4 = 3.6875, σ = √3.6875 ≈ 1.920286. Last close 103:
  // (103 − 102.3)/σ ≈ 0.364527.
  const DAY_START = Math.floor(NOW / DAY) * DAY;
  const FIVE = 5 * MINUTE;
  const vwapBar = (t: number, h: number, l: number, c: number, v: number): CandleRow => ({
    coin: "BTC",
    interval: "5m",
    t,
    tClose: t + FIVE - 1,
    o: c,
    h,
    l,
    c,
    v,
    n: 3,
  });
  const session = [
    vwapBar(DAY_START, 102, 100, 101, 10),
    vwapBar(DAY_START + FIVE, 106, 102, 104, 30),
    vwapBar(DAY_START + 2 * FIVE, 101, 97, 99, 20),
    vwapBar(DAY_START + 3 * FIVE, 105, 101, 103, 40),
  ];

  it("is the last close's signed distance from the session VWAP, in session sigmas", () => {
    withArchive((db) => {
      upsertCandles(db, session);
      assert.closeTo(
        ok(
          derivedMetricValue(db, "BTC", { metric: "vwap_distance", interval: "5m" }, { now: NOW }),
        ),
        0.364527,
        1e-5,
      );
    });
  });

  it("serves the same signed distance in bps alongside the sigma value", () => {
    withArchive((db) => {
      upsertCandles(db, session);
      const outcome = derivedMetricValue(
        db,
        "BTC",
        { metric: "vwap_distance", interval: "5m" },
        { now: NOW },
      );
      assert.strictEqual(outcome.status, "ok");
      if (outcome.status !== "ok") return;
      // Hand-checked off the same fixture: (103 − 102.3)/102.3 × 10,000 =
      // 7,000/102.3 ≈ 68.4262, which the family's 2dp convention rounds to
      // 68.43. Sign preserved: a close below VWAP would serve negative bps.
      assert.strictEqual(outcome.bps, 68.43);
    });
  });

  it("keeps the sign when the last close sits below the session VWAP", () => {
    withArchive((db) => {
      // Hand-checked negative-side fixture: the first three bars are the same
      // session's; the fourth keeps typical price 99 ((104+94+99)/3) but with
      // close 99, dropping the last close below the VWAP its own volume helps
      // set. Σ tp·v = 101·10 + 104·30 + 99·20 + 99·40 = 10,070 over
      // Σv = 100 → VWAP 100.7. Session closes [101, 104, 99, 99]: mean 100.75,
      // population variance 16.75/4 = 4.1875, σ = √4.1875 ≈ 2.046338.
      // Sigma: (99 − 100.7)/σ ≈ −0.830752 (negative).
      // Bps: (99 − 100.7)/100.7 × 10,000 = −1,700/100.7 ≈ −168.8183,
      // which the 2dp convention (Math.round(x·100)/100) rounds to −168.82.
      const belowSession = [...session.slice(0, 3), vwapBar(DAY_START + 3 * FIVE, 104, 94, 99, 40)];
      upsertCandles(db, belowSession);
      const outcome = derivedMetricValue(
        db,
        "BTC",
        { metric: "vwap_distance", interval: "5m" },
        { now: NOW },
      );
      assert.strictEqual(outcome.status, "ok");
      if (outcome.status !== "ok") return;
      assert.ok(outcome.value < 0);
      assert.closeTo(outcome.value, -0.830752, 1e-5);
      assert.strictEqual(outcome.bps, -168.82);
    });
  });

  it("anchors to the UTC day: a prior-day bar never enters the VWAP", () => {
    withArchive((db) => {
      // An extreme prior-day bar that would drag the VWAP to ~196 if the
      // anchor were wrong. The value must not move.
      upsertCandles(db, [vwapBar(DAY_START - FIVE, 299, 100, 200, 1_000), ...session]);
      assert.closeTo(
        ok(
          derivedMetricValue(db, "BTC", { metric: "vwap_distance", interval: "5m" }, { now: NOW }),
        ),
        0.364527,
        1e-5,
      );
    });
  });

  it("refuses a session the archive holds no bars for", () => {
    withArchive((db) => {
      // Bars exist, but only before today's UTC boundary.
      upsertCandles(db, [vwapBar(DAY_START - FIVE, 102, 100, 101, 10)]);
      unavailable(
        derivedMetricValue(db, "BTC", { metric: "vwap_distance", interval: "5m" }, { now: NOW }),
        "window",
        "no 5m bars in the current UTC day",
      );
    });
  });

  it("refuses a zero-volume session rather than dividing by zero", () => {
    withArchive((db) => {
      upsertCandles(
        db,
        session.map((bar) => ({ ...bar, v: 0 })),
      );
      unavailable(
        derivedMetricValue(db, "BTC", { metric: "vwap_distance", interval: "5m" }, { now: NOW }),
        "context",
        "zero volume",
      );
    });
  });
});
