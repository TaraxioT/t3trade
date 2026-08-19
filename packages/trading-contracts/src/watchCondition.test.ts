/**
 * The one condition union (plan 29 step 6.3).
 *
 * The property that matters is not that each branch maps somewhere — it is
 * that the mapping covers every persisted predicate and loses nothing on the
 * way back, because `MarketWatch` is still what the evaluator reads and what
 * every row in `trading_watches` already holds.
 */
import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";

import {
  DERIVED_METRIC_CATALOG,
  DerivedMetricName,
  isWatchRefusal,
  MarketWatch,
  toMarketWatch,
  toWatchCondition,
  WatchCondition,
} from "./watch.ts";

const decode = Schema.decodeUnknownSync(WatchCondition);
const decodeWatch = Schema.decodeUnknownSync(MarketWatch);

/** One of every persisted predicate, so the inverse is exercised exhaustively. */
const EVERY_WATCH: ReadonlyArray<MarketWatch> = [
  { type: "price_cross", market: "ETH", priceSource: "mark", direction: "above", price: 1899 },
  { type: "price_cross", market: "BTC", priceSource: "mid", direction: "below", price: 61_000 },
  { type: "candle_close", market: "ETH", interval: "15m", direction: "above", price: 1899 },
  { type: "order_update", cloid: "0xabc" },
  { type: "position_update", market: "ETH" },
  { type: "scheduled_reassessment", runAt: 1_700_000_000_000 },
  { type: "pnl_above", market: "ETH", valueUsd: 12 },
  { type: "pnl_below", market: "ETH", valueUsd: -6 },
  { type: "pnl_below", market: "ETH", valueUsd: 3 },
  { type: "pnl_giveback", market: "ETH", drawdownUsd: 4 },
  {
    type: "metric_threshold",
    market: "ETH",
    metric: "funding_rate_8h",
    direction: "below",
    value: -0.0001,
  },
  {
    type: "metric_threshold",
    market: "ETH",
    metric: "day_volume_usd",
    direction: "above",
    value: 900_000_000,
  },
  {
    type: "metric_threshold",
    market: "ETH",
    metric: "volume_ratio",
    direction: "above",
    value: 2,
    interval: "1m",
  },
];

describe("the condition the model writes", () => {
  it("round-trips every persisted predicate through the union unchanged", () => {
    for (const watch of EVERY_WATCH) {
      const back = toMarketWatch(toWatchCondition(watch));
      assert.isFalse(isWatchRefusal(back), `${watch.type} refused its own condition`);
      assert.deepEqual(back, watch, `${watch.type} did not survive the round trip`);
    }
  });

  it("accepts what it reads back as a valid condition", () => {
    for (const watch of EVERY_WATCH) {
      assert.doesNotThrow(() => decode(toWatchCondition(watch)));
    }
  });

  // The two defaults, and the reason they are safe: neither can be the wrong
  // answer to a question the model did not ask.
  it("reads a bare level as a touch on the mark", () => {
    const armed = toMarketWatch(
      decode({ kind: "price", market: "ETH", direction: "above", price: 1899 }),
    );
    assert.deepEqual(armed, {
      type: "price_cross",
      market: "ETH",
      priceSource: "mark",
      direction: "above",
      price: 1899,
    });
  });

  // The default it deliberately does not apply. A guessed timeframe here is a
  // 1h breakout armed on a 1m wick.
  it("refuses a close-confirmed level with no interval rather than guessing one", () => {
    const refused = toMarketWatch(
      decode({ kind: "price", market: "ETH", direction: "above", price: 1899, confirm: "close" }),
    );
    assert.isTrue(isWatchRefusal(refused));
    assert.equal(isWatchRefusal(refused) ? refused.code : "", "close_needs_interval");
  });

  // A volume ratio is measured on a bar series; a metric condition that names
  // none is measured on the frame the MISSION works. It used to be a flat 1m,
  // which on a 5m mission is a frame nothing else it reads is measured on and
  // five times as many chances to fire.
  it("measures an unnamed volume ratio on the mission's own frame", () => {
    const condition = decode({
      kind: "metric",
      market: "ETH",
      metric: "volume_ratio",
      direction: "above",
      value: 2,
    });
    assert.deepEqual(toMarketWatch(condition, "5m"), {
      type: "metric_threshold",
      market: "ETH",
      metric: "volume_ratio",
      direction: "above",
      value: 2,
      interval: "5m",
    });
    // A mandate naming no interval still gets the documented default (5m).
    assert.deepEqual(toMarketWatch(condition), {
      type: "metric_threshold",
      market: "ETH",
      metric: "volume_ratio",
      direction: "above",
      value: 2,
      interval: "5m",
    });
    // And a condition that names its own interval keeps it.
    const named = decode({
      kind: "metric",
      market: "ETH",
      metric: "volume_ratio",
      direction: "above",
      value: 2,
      interval: "15m",
    });
    assert.deepEqual(toMarketWatch(named, "5m"), {
      type: "metric_threshold",
      market: "ETH",
      metric: "volume_ratio",
      direction: "above",
      value: 2,
      interval: "15m",
    });
  });

  // The snapshot metrics carry no bar series, and none is invented for them.
  it("arms a snapshot metric without inventing an interval", () => {
    const armed = toMarketWatch(
      decode({
        kind: "metric",
        market: "ETH",
        metric: "spread_bps",
        direction: "above",
        value: 5,
      }),
    );
    assert.deepEqual(armed, {
      type: "metric_threshold",
      market: "ETH",
      metric: "spread_bps",
      direction: "above",
      value: 5,
    });
  });

  it("refuses a profit line that is not a profit", () => {
    for (const valueUsd of [0, -3]) {
      const refused = toMarketWatch(
        decode({ kind: "pnl", market: "ETH", direction: "above", valueUsd }),
      );
      assert.isTrue(isWatchRefusal(refused), `${valueUsd} should not arm as a target`);
    }
    // The same number below the line is a give-back floor, and legal.
    const giveback = decode({ kind: "pnl", market: "ETH", direction: "below", valueUsd: 3 });
    assert.isFalse(isWatchRefusal(toMarketWatch(giveback)));
  });

  it("keys a fill off the order when given one, and the position otherwise", () => {
    assert.deepEqual(toMarketWatch(decode({ kind: "fill", cloid: "0xabc" })), {
      type: "order_update",
      cloid: "0xabc",
    });
    assert.deepEqual(toMarketWatch(decode({ kind: "fill", market: "ETH" })), {
      type: "position_update",
      market: "ETH",
    });
    const refused = toMarketWatch(decode({ kind: "fill" }));
    assert.isTrue(isWatchRefusal(refused));
    assert.equal(isWatchRefusal(refused) ? refused.code : "", "fill_needs_order_or_market");
  });

  it("carries a cloid and a market together as the order watch", () => {
    // Naming both is not ambiguous: the order is the more specific of the two.
    assert.deepEqual(toMarketWatch(decode({ kind: "fill", cloid: "0xabc", market: "ETH" })), {
      type: "order_update",
      cloid: "0xabc",
    });
  });
});

describe("the derived condition kind (plan 38 §3)", () => {
  /** `assert.equal` on a refusal's code, in the shape the other tests use. */
  const refusalCode = (result: ReturnType<typeof toMarketWatch>): string | undefined =>
    isWatchRefusal(result) ? result.code : undefined;

  it("round-trips a candle metric with confirm through the persisted encoding", () => {
    const condition = decode({
      kind: "derived",
      market: "ETH",
      metric: "sigma_distance",
      params: { metric: "sigma_distance", interval: "5m", period: 20, basis: "mean" },
      direction: "below",
      value: -2.5,
      mode: "cross",
      confirm: "bar_close",
    });
    const armed = toMarketWatch(condition);
    assert.isFalse(isWatchRefusal(armed));
    assert.deepEqual(armed, {
      type: "metric_derived",
      market: "ETH",
      metric: "sigma_distance",
      params: { metric: "sigma_distance", interval: "5m", period: 20, basis: "mean" },
      direction: "below",
      value: -2.5,
      mode: "cross",
      confirm: "bar_close",
    });
    assert.doesNotThrow(() => decodeWatch(armed));
    assert.deepEqual(toWatchCondition(armed as MarketWatch), condition);
  });

  it("round-trips a funding metric and fills the mode default as cross", () => {
    const condition = decode({
      kind: "derived",
      market: "ETH",
      metric: "funding_mean",
      params: { metric: "funding_mean", windowDays: 7 },
      direction: "below",
      value: 0,
    });
    const armed = toMarketWatch(condition);
    assert.isFalse(isWatchRefusal(armed));
    assert.deepEqual(armed, {
      type: "metric_derived",
      market: "ETH",
      metric: "funding_mean",
      params: { metric: "funding_mean", windowDays: 7 },
      direction: "below",
      value: 0,
      mode: "cross",
    });
    // Reading it back spells the default out, which is the same condition.
    assert.deepEqual(toWatchCondition(armed as MarketWatch), {
      kind: "derived",
      market: "ETH",
      metric: "funding_mean",
      params: { metric: "funding_mean", windowDays: 7 },
      direction: "below",
      value: 0,
      mode: "cross",
    });
  });

  it("arms a flip metric with no direction or value", () => {
    const armed = toMarketWatch(
      decode({
        kind: "derived",
        market: "BTC",
        metric: "funding_sign_flip",
        params: { metric: "funding_sign_flip", windowDays: 1 },
      }),
    );
    assert.isFalse(isWatchRefusal(armed));
    assert.deepEqual(armed, {
      type: "metric_derived",
      market: "BTC",
      metric: "funding_sign_flip",
      params: { metric: "funding_sign_flip", windowDays: 1 },
      mode: "cross",
    });
  });

  // Each way `toMarketWatch` can refuse a derived condition without touching
  // the archive — plan 38 §3.2's `derived_params_invalid`, one per rule.
  it("refuses params that do not match the named metric", () => {
    const refused = toMarketWatch(
      decode({
        kind: "derived",
        market: "ETH",
        metric: "funding_mean",
        params: { metric: "sigma_return", interval: "1h", period: 72 },
        direction: "below",
        value: 0,
      }),
    );
    assert.equal(refusalCode(refused), "derived_params_invalid");
  });

  it("refuses a funding_mean with no direction", () => {
    const refused = toMarketWatch(
      decode({
        kind: "derived",
        market: "ETH",
        metric: "funding_mean",
        params: { metric: "funding_mean", windowDays: 7 },
        value: 0,
      }),
    );
    assert.equal(refusalCode(refused), "derived_params_invalid");
  });

  it("refuses a direction or value on a flip metric", () => {
    const refused = toMarketWatch(
      decode({
        kind: "derived",
        market: "BTC",
        metric: "funding_sign_flip",
        params: { metric: "funding_sign_flip", windowDays: 1 },
        direction: "below",
        value: 0,
      }),
    );
    assert.equal(refusalCode(refused), "derived_params_invalid");
  });

  it("refuses bar_close confirmation on a non-candle metric", () => {
    const refused = toMarketWatch(
      decode({
        kind: "derived",
        market: "ETH",
        metric: "oi_change_rate",
        params: { metric: "oi_change_rate", windowMinutes: 60 },
        direction: "above",
        value: 0.05,
        confirm: "bar_close",
      }),
    );
    assert.equal(refusalCode(refused), "derived_params_invalid");
  });

  it("refuses an out-of-range window", () => {
    const refused = toMarketWatch(
      decode({
        kind: "derived",
        market: "ETH",
        metric: "funding_mean",
        params: { metric: "funding_mean", windowDays: 31 },
        direction: "below",
        value: 0,
      }),
    );
    assert.equal(refusalCode(refused), "derived_params_invalid");
  });

  it("refuses a sigma_ratio whose fast window is not the shorter one", () => {
    const refused = toMarketWatch(
      decode({
        kind: "derived",
        market: "ETH",
        metric: "sigma_ratio",
        params: { metric: "sigma_ratio", interval: "15m", fast: 20, slow: 20 },
        direction: "above",
        value: 1.5,
      }),
    );
    assert.equal(refusalCode(refused), "derived_params_invalid");
  });

  it("refuses an evaluateEveryMs outside the clamp", () => {
    for (const evaluateEveryMs of [59_999, 86_400_001]) {
      const refused = toMarketWatch(
        decode({
          kind: "derived",
          market: "ETH",
          metric: "funding_mean",
          params: { metric: "funding_mean", windowDays: 7 },
          direction: "below",
          value: 0,
          evaluateEveryMs,
        }),
      );
      assert.equal(refusalCode(refused), "derived_params_invalid", `${evaluateEveryMs}`);
    }
  });

  // The additive guarantee: every row written before the ninth union member
  // exists still decodes as-is.
  it("still decodes a watch_json of every earlier kind unchanged", () => {
    for (const watch of EVERY_WATCH) {
      assert.doesNotThrow(() => decodeWatch(watch), `${watch.type} no longer decodes`);
      assert.deepEqual(decodeWatch(watch), watch);
    }
  });

  it("carries one catalog entry per metric, fireOnChange only on the flip", () => {
    const names = Schema.decodeUnknownSync(DerivedMetricName);
    const catalogued = DERIVED_METRIC_CATALOG.map((entry) => entry.metric);
    assert.deepEqual(
      catalogued.slice().sort(),
      [
        "funding_mean",
        "funding_sign_flip",
        "funding_cumulative",
        "sigma_return",
        "sigma_distance",
        "sigma_ratio",
        "ema_distance",
        "oi_change_rate",
        "premium_mean",
        "depth_ratio",
        "bars_since",
        "hold_bars",
        "vwap_distance",
      ].sort(),
    );
    for (const entry of DERIVED_METRIC_CATALOG) {
      assert.doesNotThrow(() => names(entry.metric));
      assert.equal(entry.fireOnChange, entry.metric === "funding_sign_flip");
    }
  });
});
