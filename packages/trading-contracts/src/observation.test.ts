import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";

import {
  echoedBarsForLook,
  nearestTradingLookKey,
  parseTradingLookFetchKey,
  renderTradingLookMenu,
  TRADING_LOOK_CATALOG,
  TRADING_LOOK_DEFAULT_BARS,
  TRADING_LOOK_FLAT_BAR_CAP,
  TRADING_LOOK_MAX_ARCHIVE_ROWS,
  TRADING_LOOK_MAX_BARS,
  TRADING_LOOK_MAX_FUNDING_WINDOW_DAYS,
  TradingLookInput,
} from "./observation.ts";

/**
 * Plan 36 item 8. 17 `trading_look` calls came to 293,500 characters — 82% of
 * one mission's entire context, against 35,589 for all 21 of its wake payloads
 * combined. The model asked for 120 bars on essentially every turn and used
 * them to recompute ema(20) and ema(50), which the server had already computed
 * and sent beside them. Thirteen of those turns concluded "no setup".
 *
 * The cap is flat-only on purpose: the shape of the chart is what a trade is
 * contemplated and managed against, and a held position is not the place to
 * economise.
 */
describe("echoedBarsForLook", () => {
  it("caps a flat call at the flat cap", () => {
    assert.equal(echoedBarsForLook({ bars: 120 }), TRADING_LOOK_FLAT_BAR_CAP);
  });

  it("gives a held position the whole window it asked for", () => {
    assert.equal(echoedBarsForLook({ bars: 120, holdingPosition: true }), 120);
  });

  it("leaves a flat call under the cap alone", () => {
    assert.equal(echoedBarsForLook({ bars: 5 }), 5);
  });

  it("still answers indicators-without-bars with no chart at all", () => {
    // The reading is 140 characters where the window it came from is 18,000.
    assert.equal(echoedBarsForLook({ indicators: [{ kind: "ema" }] }), 0);
    assert.equal(echoedBarsForLook({ indicators: [{ kind: "ema" }], holdingPosition: true }), 0);
  });

  it("falls back to the short tail when neither was named", () => {
    assert.equal(echoedBarsForLook({}), TRADING_LOOK_DEFAULT_BARS);
    assert.equal(echoedBarsForLook({ holdingPosition: true }), TRADING_LOOK_DEFAULT_BARS);
  });

  it("takes an explicit zero as the answer, not as absent", () => {
    assert.equal(echoedBarsForLook({ bars: 0 }), 0);
  });
});

/**
 * Plan 38 §2 — the data menu. The published size is the contract: the model
 * budgets its own context off the catalog, so the catalog must be complete
 * and the menu must stay a small blob.
 */
describe("the fetch catalog", () => {
  it("holds the 27 published keys, in order, at their published sizes", () => {
    assert.deepStrictEqual(
      TRADING_LOOK_CATALOG.map((entry) => [entry.key, entry.chars]),
      [
        ["snapshot", 454],
        ["book", 130],
        ["book_full", 898],
        ["microstructure", 599],
        ["candles", 38],
        ["indicators", 63],
        ["volatility", 677],
        ["volatility_htf", 680],
        ["structure", 4375],
        ["structure_brief", 640],
        ["funding_stats", 140],
        ["funding_series", 52],
        ["oi_premium", 100],
        ["book_history", 89],
        ["levels", 886],
        ["position", 180],
        ["position_costs", 900],
        ["orders", 46],
        ["account", 248],
        ["plan", 1258],
        ["watches", 2860],
        ["events", 90],
        ["journal", 1219],
        ["trades", 1173],
        ["calibration", 1047],
        ["plan_history", 3342],
        // Not in the plan's §2.2 table; §4.2's nothing-deleted invariant keeps
        // the market scope's cost line reachable.
        ["cost", 101],
      ],
    );
  });

  it("marks exactly the four archive-backed keys", () => {
    assert.deepStrictEqual(
      TRADING_LOOK_CATALOG.filter((entry) => entry.archive === true).map((entry) => entry.key),
      ["funding_stats", "funding_series", "oi_premium", "book_history"],
    );
  });
});

describe("renderTradingLookMenu", () => {
  const menu = renderTradingLookMenu();

  it("stays in the 360–540 band, targeted at ~450", () => {
    assert.isTrue(menu.length >= 360 && menu.length <= 540, `menu is ${menu.length} chars`);
  });

  it("prices every key and stars the archive keys", () => {
    for (const entry of TRADING_LOOK_CATALOG) {
      assert.include(menu, `${entry.key}`);
    }
    assert.include(menu, "*");
    // The legend must tell the model an archive miss is not data.
    assert.include(menu, "unavailable");
  });

  it("names indicators as the cheaper alternative to candles", () => {
    assert.include(menu, "indicators");
    assert.include(menu, "cheaper");
  });
});

describe("parseTradingLookFetchKey", () => {
  it("parses every valid shape", () => {
    assert.deepStrictEqual(parseTradingLookFetchKey("snapshot"), { base: "snapshot" });
    assert.deepStrictEqual(parseTradingLookFetchKey("cost"), { base: "cost" });
    assert.deepStrictEqual(parseTradingLookFetchKey("candles:5m:20"), {
      base: "candles",
      interval: "5m",
      n: 20,
    });
    assert.deepStrictEqual(parseTradingLookFetchKey("candles:1h:0"), {
      base: "candles",
      interval: "1h",
      n: 0,
    });
    assert.deepStrictEqual(parseTradingLookFetchKey("indicators:ema20"), {
      base: "indicators",
      spec: "ema20",
    });
    assert.deepStrictEqual(parseTradingLookFetchKey("funding_stats:7"), {
      base: "funding_stats",
      windowDays: 7,
    });
    assert.deepStrictEqual(parseTradingLookFetchKey("funding_series:24"), {
      base: "funding_series",
      n: 24,
    });
    assert.deepStrictEqual(parseTradingLookFetchKey("oi_premium:50"), {
      base: "oi_premium",
      n: 50,
    });
    assert.deepStrictEqual(parseTradingLookFetchKey("book_history:10"), {
      base: "book_history",
      n: 10,
    });
  });

  it("refuses out-of-bound parameters with the cap named", () => {
    const bound = (parsed: ReturnType<typeof parseTradingLookFetchKey>) =>
      parsed.base === "invalid_params" ? parsed.bound : "";

    const candles = parseTradingLookFetchKey(`candles:5m:${TRADING_LOOK_MAX_BARS + 1}`);
    assert.equal(candles.base, "invalid_params");
    assert.include(bound(candles), String(TRADING_LOOK_MAX_BARS));

    const interval = parseTradingLookFetchKey("candles:2h:20");
    assert.equal(interval.base, "invalid_params");
    assert.include(bound(interval), "1m");

    const window = parseTradingLookFetchKey(
      `funding_stats:${TRADING_LOOK_MAX_FUNDING_WINDOW_DAYS + 1}`,
    );
    assert.equal(window.base, "invalid_params");
    assert.include(bound(window), String(TRADING_LOOK_MAX_FUNDING_WINDOW_DAYS));

    for (const key of [
      `funding_series:${TRADING_LOOK_MAX_ARCHIVE_ROWS + 1}`,
      `oi_premium:${TRADING_LOOK_MAX_ARCHIVE_ROWS + 1}`,
      `book_history:${TRADING_LOOK_MAX_ARCHIVE_ROWS + 1}`,
    ]) {
      const parsed = parseTradingLookFetchKey(key);
      assert.equal(parsed.base, "invalid_params");
      assert.include(bound(parsed), String(TRADING_LOOK_MAX_ARCHIVE_ROWS));
    }
  });

  it("reports unknown keys as unknown, never silently", () => {
    assert.deepStrictEqual(parseTradingLookFetchKey("nonexistent"), {
      base: "unknown",
      key: "nonexistent",
    });
  });
});

describe("nearestTradingLookKey", () => {
  it("maps a typo to the catalog base it normalizes to", () => {
    assert.equal(nearestTradingLookKey("candle"), "candles");
    assert.equal(nearestTradingLookKey("book_ful"), "book_full");
    assert.equal(nearestTradingLookKey("fundingstat"), "funding_stats");
  });

  it("maps exact keys to themselves", () => {
    for (const entry of TRADING_LOOK_CATALOG) {
      assert.equal(nearestTradingLookKey(entry.key), entry.key);
    }
  });
});

describe("the fetch parameter", () => {
  const decodeLook = Schema.decodeUnknownSync(TradingLookInput);

  it("accepts arbitrary strings — unknown keys are the handler's to refuse by name", () => {
    // Not an enum on purpose (plan 38 §2.3 rule 4): a schema rejection cannot
    // name the nearest valid key, and reads to the model as "nothing here".
    const decoded = decodeLook({ fetch: ["candles:5m:20", "not_a_key"] });
    assert.deepStrictEqual(decoded.fetch, ["candles:5m:20", "not_a_key"]);
  });
});
