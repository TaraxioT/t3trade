import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";

import { DERIVED_METRIC_CATALOG } from "./watch.ts";
import {
  nearestTradingLookKey,
  parseTradingLookFetchKey,
  renderTradingLookMenu,
  TRADING_LOOK_CATALOG,
  TRADING_LOOK_INTERVALS,
  TRADING_LOOK_MAX_ARCHIVE_ROWS,
  TRADING_LOOK_MAX_BARS,
  TRADING_LOOK_MAX_EVENTS,
  TRADING_LOOK_MAX_FUNDING_WINDOW_DAYS,
  TradingLookInput,
} from "./observation.ts";

/**
 * Plan 38 §2 — the data menu. The published size is the contract: the model
 * budgets its own context off the catalog, so the catalog must be complete
 * and the menu must stay a small blob.
 */
describe("the fetch catalog", () => {
  it("holds the 28 published keys, in order, at their published sizes", () => {
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
        ["scan", 550],
        ["levels", 1136],
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

  it("marks exactly the five archive-backed keys", () => {
    assert.deepStrictEqual(
      TRADING_LOOK_CATALOG.filter((entry) => entry.archive === true).map((entry) => entry.key),
      ["funding_stats", "funding_series", "oi_premium", "book_history", "scan"],
    );
  });
});

describe("renderTradingLookMenu", () => {
  const menu = renderTradingLookMenu();

  // Plan 38 phase 3: the menu grew the derived-metric catalog (§3.3), one
  // line per metric rendered from `DERIVED_METRIC_CATALOG`. Measured 1,252
  // chars then; R3's scan key, its legend clause, and the thirteenth metric
  // (`vwap_distance`) measure 1,368; the grammar-and-caps suffixes on the
  // parameterized entries (the discoverability repair: one catalog call must
  // suffice to compose a legal key) measure 1,429. The band keeps a
  // deliberate ceiling — the handler test pins the same 1,500 — so another
  // key's worth of prose has to say so here.
  it("stays in the 1,250–1,500 band, targeted at ~1,430", () => {
    assert.isTrue(menu.length >= 1_250 && menu.length <= 1_500, `menu is ${menu.length} chars`);
  });

  // Grammar and caps ride the parameterized entries, composed from the same
  // constants `parseTradingLookFetchKey` refuses by. This is the "one catalog
  // call suffices" property: a model holding the menu can compose a legal key
  // without a refused call teaching it the shape first.
  it("states each parameterized key's grammar and cap from the parser's constants", () => {
    assert.include(
      menu,
      `candles:tf:n[${TRADING_LOOK_INTERVALS.join("|")};n≤${TRADING_LOOK_MAX_BARS}]`,
    );
    assert.include(menu, `funding_stats:W[days 1-${TRADING_LOOK_MAX_FUNDING_WINDOW_DAYS}]`);
    for (const key of ["funding_series", "oi_premium", "book_history"]) {
      assert.include(menu, `${key}:n[1-${TRADING_LOOK_MAX_ARCHIVE_ROWS}]`);
    }
    assert.include(menu, `events:n[1-${TRADING_LOOK_MAX_EVENTS}]`);
  });

  // The interval list the menu prints is exactly the set the parser accepts:
  // every advertised interval parses, a non-member (`4h`, the invalid call
  // this repair targets) refuses with the same list, and both surfaces quote
  // one constant so they cannot drift.
  it("advertises exactly the candle intervals the parser accepts", () => {
    for (const tf of TRADING_LOOK_INTERVALS) {
      assert.equal(parseTradingLookFetchKey(`candles:${tf}:10`).base, "candles");
    }
    const refused = parseTradingLookFetchKey("candles:4h:10");
    assert.equal(refused.base, "invalid_params");
    if (refused.base === "invalid_params") {
      assert.include(refused.bound, TRADING_LOOK_INTERVALS.join(","));
    }
  });

  it("presents scan as cross-market context, never market selection", () => {
    assert.include(menu, "scan: cross-market context, never market selection");
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

  it("lists every derived metric the watch kind can arm (plan 38 §3.3)", () => {
    for (const metric of DERIVED_METRIC_CATALOG) {
      assert.include(menu, `derived:${metric.metric} `);
    }
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
