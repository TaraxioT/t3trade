/**
 * TradingMarketChart unit tests.
 *
 * The contract this service owns is the cache window and the "either read fails
 * yields null, nothing cached" rule — both rest on the gateway read pair and the
 * `Clock.currentTimeMillis` TTL, so the tests drive a stub gateway and a
 * `TestClock`. The view-mapping case also pins the candle/field projection.
 *
 * Each case provides its own `TradingMarketChartLive` so the in-memory `Ref`
 * cache starts empty per test (a shared layer would leak cache state across
 * cases, defeating the cache-window assertions).
 */
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { HyperliquidGateway } from "@t3tools/hyperliquid/Gateway";
import type {
  AgentMarketSnapshot,
  MarketCandle,
  MarketHistory,
} from "@t3tools/trading-contracts/market";

import { TradingMarketArchive } from "./TradingMarketArchive.ts";
import { TradingThesisValidationService } from "./TradingThesisValidationService.ts";
import { TradingMarketChart, TradingMarketChartLive } from "./TradingMarketChart.ts";

const freshness = {
  observedAt: 1_700_000_000_000,
  source: "info_api",
  staleAfterMillis: 2_000,
} as const;

const snapshot: AgentMarketSnapshot = {
  market: "ETH",
  markPrice: 2_000,
  midPrice: 2_000,
  oraclePrice: 2_000,
  fundingRate8h: 0.0001,
  openInterest: 1_000,
  dayVolumeUsd: 1_000_000,
  bestBidOffer: { bidPrice: 1_999.5, bidSize: 10, askPrice: 2_000.5, askSize: 10, freshness },
  freshness,
  change24hPercent: 0.5,
};

const candle = (openTime: number, close: number): MarketCandle => ({
  openTime,
  closeTime: openTime + 60_000,
  open: close - 1,
  close,
  high: close + 1,
  low: close - 2,
  volume: 100,
  trades: 50,
});

const history: MarketHistory = {
  market: "ETH",
  interval: "1m",
  candles: [candle(1_000, 2_000), candle(61_000, 2_010)],
  freshness,
};

const unusedRead = () => Effect.die("not used by TradingMarketChart tests");

/**
 * Mutable stubs so a case can flip either read to a failure, and counters so a
 * case can assert how many gateway reads actually happened. Reset at the top of
 * each case before the service is built.
 */
let snapshotRead: Effect.Effect<AgentMarketSnapshot, string> = Effect.succeed(snapshot);
let historyRead: Effect.Effect<MarketHistory, string> = Effect.succeed(history);
let snapshotCalls = 0;
let historyCalls = 0;

const stubGateway = Layer.succeed(HyperliquidGateway, {
  resolveMarket: unusedRead,
  getMarketSnapshot: () => {
    snapshotCalls += 1;
    return snapshotRead;
  },
  getMarketHistory: () => {
    historyCalls += 1;
    return historyRead;
  },
  getOrderBook: unusedRead,
  getAccountSnapshot: unusedRead,
  getPosition: unusedRead,
  getOpenOrders: unusedRead,
  getTakerFeeRateBps: unusedRead,
} as unknown as (typeof HyperliquidGateway)["Service"]);

/**
 * An archive holding nothing: latest-bars reads fall through to the gateway,
 * and the coverage/session decorations degrade to absence. These cases are
 * about the gateway pair and the cache window.
 */
const emptyArchive = Layer.succeed(TradingMarketArchive, {
  candlesInWindow: () => Effect.succeed([]),
  coverage: () => Effect.succeed({ recordingSince: null, gaps: [] }),
  sessionLevels: () => Effect.succeed({ status: "unavailable", reason: "no rows" }),
} as unknown as (typeof TradingMarketArchive)["Service"]);

/**
 * Nothing being validated. These cases are about the gateway pair and the
 * cache window; the thesis overlay has its own case below.
 */
const noValidations = Layer.succeed(TradingThesisValidationService, {
  forChart: () => Effect.succeed(null),
} as unknown as (typeof TradingThesisValidationService)["Service"]);

/** The real chart layer on the stub gateway, plus the TestClock the TTL reads. */
const testLayer = () =>
  Effect.provide(
    Layer.merge(
      TradingMarketChartLive.pipe(
        Layer.provide(Layer.mergeAll(stubGateway, emptyArchive, noValidations)),
      ),
      TestClock.layer(),
    ),
  );

it.effect("serves a cached view to concurrent reads without re-reading the gateway", () =>
  Effect.gen(function* () {
    snapshotRead = Effect.succeed(snapshot);
    historyRead = Effect.succeed(history);
    snapshotCalls = 0;
    historyCalls = 0;
    const chart = yield* TradingMarketChart;

    const first = yield* chart.read({ market: "ETH", interval: "1m", maxBars: 100 });
    const second = yield* chart.read({ market: "ETH", interval: "1m", maxBars: 100 });

    assert.notEqual(first, null);
    assert.equal(second, first);
    assert.equal(snapshotCalls, 1);
    assert.equal(historyCalls, 1);
  }).pipe(testLayer()),
);

// The post-mortem chart of a closed trade and the live chart of the same
// market/interval are different series. Sharing one cache entry would serve
// whichever landed first as the other.
it.effect("does not serve a windowed read from the live read's cache entry", () =>
  Effect.gen(function* () {
    snapshotRead = Effect.succeed(snapshot);
    historyRead = Effect.succeed(history);
    snapshotCalls = 0;
    historyCalls = 0;
    const chart = yield* TradingMarketChart;

    yield* chart.read({ market: "ETH", interval: "1m", maxBars: 100 });
    yield* chart.read({
      market: "ETH",
      interval: "1m",
      maxBars: 100,
      startTime: 1_000,
      endTime: 2_000,
    });

    assert.equal(historyCalls, 2, "the windowed read must reach the gateway on its own");
  }).pipe(testLayer()),
);

it.effect("re-reads after the cache window elapses", () =>
  Effect.gen(function* () {
    snapshotRead = Effect.succeed(snapshot);
    historyRead = Effect.succeed(history);
    snapshotCalls = 0;
    historyCalls = 0;
    const chart = yield* TradingMarketChart;

    yield* chart.read({ market: "ETH", interval: "1m", maxBars: 100 });
    // 6s > 5s TTL: the cache window has closed, so the next read hits the gateway.
    yield* TestClock.adjust(Duration.seconds(6));
    yield* chart.read({ market: "ETH", interval: "1m", maxBars: 100 });

    assert.equal(snapshotCalls, 2);
    assert.equal(historyCalls, 2);
  }).pipe(testLayer()),
);

it.effect("yields null and leaves the cache empty when the snapshot read fails", () =>
  Effect.gen(function* () {
    snapshotRead = Effect.fail("snapshot unreachable");
    historyRead = Effect.succeed(history);
    snapshotCalls = 0;
    historyCalls = 0;
    const chart = yield* TradingMarketChart;

    const first = yield* chart.read({ market: "ETH", interval: "1m", maxBars: 100 });
    assert.equal(first, null);

    // Nothing was cached: a second call (same tick) hits the gateway again.
    const second = yield* chart.read({ market: "ETH", interval: "1m", maxBars: 100 });
    assert.equal(second, null);
    assert.isAtLeast(snapshotCalls, 2);
  }).pipe(testLayer()),
);

it.effect("yields null and leaves the cache empty when the history read fails", () =>
  Effect.gen(function* () {
    snapshotRead = Effect.succeed(snapshot);
    historyRead = Effect.fail("history unreachable");
    snapshotCalls = 0;
    historyCalls = 0;
    const chart = yield* TradingMarketChart;

    const first = yield* chart.read({ market: "ETH", interval: "1m", maxBars: 100 });
    assert.equal(first, null);

    const second = yield* chart.read({ market: "ETH", interval: "1m", maxBars: 100 });
    assert.equal(second, null);
    assert.isAtLeast(historyCalls, 2);
  }).pipe(testLayer()),
);

// Blanking the whole surface for one transient exchange hiccup is worse for an
// operator reading an exit off the series than a chart a few seconds behind
// that says it is behind.
it.effect("serves the last good view, marked stale, through a failed refresh", () =>
  Effect.gen(function* () {
    snapshotRead = Effect.succeed(snapshot);
    historyRead = Effect.succeed(history);
    const chart = yield* TradingMarketChart;

    const good = yield* chart.read({ market: "ETH", interval: "1m", maxBars: 100 });
    assert.notEqual(good, null);

    // Past the TTL, with the exchange now unreachable.
    yield* TestClock.adjust(Duration.seconds(6));
    historyRead = Effect.fail("history unreachable");
    const served = yield* chart.read({ market: "ETH", interval: "1m", maxBars: 100 });

    assert.equal(served?.stale, true);
    assert.deepEqual(served?.candles, good?.candles);
    assert.equal(served?.markPrice, good?.markPrice);
  }).pipe(testLayer()),
);

it.effect("stops serving a stale view once it is minutes old", () =>
  Effect.gen(function* () {
    snapshotRead = Effect.succeed(snapshot);
    historyRead = Effect.succeed(history);
    const chart = yield* TradingMarketChart;

    yield* chart.read({ market: "ETH", interval: "1m", maxBars: 100 });

    yield* TestClock.adjust(Duration.minutes(6));
    historyRead = Effect.fail("history unreachable");
    const served = yield* chart.read({ market: "ETH", interval: "1m", maxBars: 100 });

    assert.equal(served, null);
  }).pipe(testLayer()),
);

it.effect("maps the gateway pair into the view, dropping closeTime/trades, keeping volume", () =>
  Effect.gen(function* () {
    snapshotRead = Effect.succeed(snapshot);
    historyRead = Effect.succeed(history);
    const chart = yield* TradingMarketChart;

    const view = yield* chart.read({ market: "ETH", interval: "1m", maxBars: 100 });
    assert.notEqual(view, null);
    if (view === null) return;

    assert.equal(view.market, "ETH");
    assert.equal(view.interval, "1m");
    assert.equal(view.candles.length, 2);
    // closeTime/trades are dropped by the projection; volume is kept for the
    // chart's volume underlay (final-form phase 6).
    assert.deepEqual(view.candles[0], {
      openTime: 1_000,
      open: 1_999,
      high: 2_001,
      low: 1_998,
      close: 2_000,
      volume: 100,
    });
    assert.deepEqual(view.candles[1], {
      openTime: 61_000,
      open: 2_009,
      high: 2_011,
      low: 2_008,
      close: 2_010,
      volume: 100,
    });

    // Header figures lifted straight off the snapshot.
    assert.equal(view.markPrice, 2_000);
    assert.equal(view.change24hPercent, 0.5);
    assert.equal(view.fundingRate8h, 0.0001);
    assert.equal(view.openInterest, 1_000);
    assert.equal(view.dayVolumeUsd, 1_000_000);

    // observedAt is the gateway's UnixMillis freshness stamp, rendered as ISO-8601.
    assert.equal(view.observedAt, DateTime.formatIso(DateTime.makeUnsafe(freshness.observedAt)));
  }).pipe(testLayer()),
);

it.effect("draws a closed window from the archive instead of asking the exchange", () =>
  Effect.gen(function* () {
    // The exchange serves roughly the last 5,000 bars. A trade closed a week
    // ago is outside that window entirely, so a post-mortem chart that asked
    // the exchange got nothing — the archive is the only thing that has it.
    snapshotRead = Effect.succeed(snapshot);
    historyRead = Effect.succeed(history);
    historyCalls = 0;

    const chart = yield* TradingMarketChart;
    const view = yield* chart.read({
      market: "ETH",
      interval: "1m",
      maxBars: 10,
      startTime: 1_600_000_000_000,
      endTime: 1_600_000_600_000,
    });

    assert.isNotNull(view);
    assert.deepEqual(
      view?.candles.map((bar) => bar.close),
      [10, 11],
    );
    assert.equal(historyCalls, 0);
    // The archive's volume rides through, coverage decorates the view, and a
    // windowed read carries no session levels ("today" would be the wrong day).
    assert.deepEqual(
      view?.candles.map((bar) => bar.volume),
      [1, 1],
    );
    assert.equal(view?.recordingSince, 1);
    assert.deepEqual(view?.gaps, [{ fromT: 1_600_000_100_000, toT: 1_600_000_200_000 }]);
    assert.equal(view?.sessionLevels, undefined);
  }).pipe(
    Effect.provide(
      Layer.merge(
        TradingMarketChartLive.pipe(
          Layer.provide(noValidations),
          Layer.provide(
            Layer.merge(
              stubGateway,
              Layer.succeed(TradingMarketArchive, {
                candlesInWindow: () =>
                  Effect.succeed([
                    {
                      coin: "ETH",
                      interval: "1m",
                      t: 1,
                      tClose: 2,
                      o: 9,
                      h: 11,
                      l: 8,
                      c: 10,
                      v: 1,
                      n: 1,
                    },
                    {
                      coin: "ETH",
                      interval: "1m",
                      t: 3,
                      tClose: 4,
                      o: 10,
                      h: 12,
                      l: 9,
                      c: 11,
                      v: 1,
                      n: 1,
                    },
                  ]),
                coverage: () =>
                  Effect.succeed({
                    recordingSince: 1,
                    gaps: [{ fromT: 1_600_000_100_000, toT: 1_600_000_200_000 }],
                  }),
                sessionLevels: () => Effect.die("windowed reads must not ask for session levels"),
              } as unknown as (typeof TradingMarketArchive)["Service"]),
            ),
          ),
        ),
        TestClock.layer(),
      ),
    ),
  ),
);

it.effect("serves latest bars from the archive while its tail is fresh", () =>
  Effect.gen(function* () {
    snapshotRead = Effect.succeed(snapshot);
    historyRead = Effect.succeed(history);
    historyCalls = 0;

    // now = 1_000_000 on the TestClock; a bar closing at 990_000 is well
    // inside the three-bar freshness bound for 1m.
    yield* TestClock.adjust(Duration.millis(1_000_000));
    const chart = yield* TradingMarketChart;
    const view = yield* chart.read({ market: "ETH", interval: "1m", maxBars: 120 });

    assert.isNotNull(view);
    assert.equal(historyCalls, 0, "a fresh archive tail must not reach the exchange");
    assert.deepEqual(
      view?.candles.map((bar) => bar.close),
      [50],
    );
    // A live read carries the session levels the archive computed.
    assert.deepEqual(view?.sessionLevels, { priorDayHigh: 60, priorDayLow: 40, priorDayClose: 55 });
  }).pipe(
    Effect.provide(
      Layer.merge(
        TradingMarketChartLive.pipe(
          Layer.provide(noValidations),
          Layer.provide(
            Layer.merge(
              stubGateway,
              Layer.succeed(TradingMarketArchive, {
                candlesInWindow: () =>
                  Effect.succeed([
                    {
                      coin: "ETH",
                      interval: "1m",
                      t: 930_000,
                      tClose: 990_000,
                      o: 49,
                      h: 51,
                      l: 48,
                      c: 50,
                      v: 3,
                      n: 5,
                    },
                  ]),
                coverage: () => Effect.succeed({ recordingSince: 930_000, gaps: [] }),
                sessionLevels: () =>
                  Effect.succeed({
                    status: "ok",
                    priorUtcDay: { high: 60, low: 40, close: 55 },
                  }),
              } as unknown as (typeof TradingMarketArchive)["Service"]),
            ),
          ),
        ),
        TestClock.layer(),
      ),
    ),
  ),
);

// The gateway stops at 1h; the wider intervals exist only in the archive, so
// an empty archive must fail the read instead of asking the exchange for a
// series it cannot serve.
it.effect("a 4h read with no archive yields null without reaching the exchange", () =>
  Effect.gen(function* () {
    snapshotRead = Effect.succeed(snapshot);
    historyRead = Effect.succeed(history);
    historyCalls = 0;

    const chart = yield* TradingMarketChart;
    const view = yield* chart.read({ market: "ETH", interval: "4h", maxBars: 120 });

    assert.equal(view, null);
    assert.equal(historyCalls, 0);
  }).pipe(testLayer()),
);

it.effect("falls back to the exchange when the archive was not recording then", () =>
  Effect.gen(function* () {
    snapshotRead = Effect.succeed(snapshot);
    historyRead = Effect.succeed(history);
    historyCalls = 0;

    const chart = yield* TradingMarketChart;
    yield* chart.read({
      market: "ETH",
      interval: "1m",
      maxBars: 10,
      startTime: 1_600_000_000_000,
      endTime: 1_600_000_600_000,
    });

    assert.equal(historyCalls, 1);
  }).pipe(testLayer()),
);

/**
 * The thesis overlay, and the one rule that keeps it honest.
 *
 * A 5m thesis has paper entries at 5m bar opens. Drawing those on a 1m chart
 * would put markers at times the rule never fired — a picture of trades that
 * did not happen where it says they did. So the trades are served only on the
 * thesis's own interval, and the badge goes out either way.
 */
const validationOn = (interval: string) =>
  Layer.succeed(TradingThesisValidationService, {
    forChart: () =>
      Effect.succeed({
        validation: {
          id: "validation-1",
          interval,
          status: "armed",
          expiresAt: 9_000,
          label: "The 5m fade",
          thesis: { market: "ETH", interval, side: "long" },
        },
        trades: [
          {
            id: "paper-1",
            entryTime: 1_000,
            entryPrice: 3_000,
            exitTime: 2_000,
            exitPrice: 3_030,
            netUsd: 9.4,
            exitReason: "target",
          },
        ],
      }),
  } as unknown as (typeof TradingThesisValidationService)["Service"]);

const withValidation = (interval: string) =>
  Effect.provide(
    Layer.merge(
      TradingMarketChartLive.pipe(
        Layer.provide(Layer.mergeAll(stubGateway, emptyArchive, validationOn(interval))),
      ),
      TestClock.layer(),
    ),
  );

it.effect("draws the thesis's paper trades when the chart is on its own interval", () =>
  Effect.gen(function* () {
    snapshotRead = Effect.succeed(snapshot);
    historyRead = Effect.succeed(history);

    const chart = yield* TradingMarketChart;
    const view = yield* chart.read({ market: "ETH", interval: "1m", maxBars: 60 });

    assert.isNotNull(view);
    assert.equal(view?.thesis?.validationId, "validation-1");
    assert.equal(view?.thesis?.intervalMatches, true);
    assert.equal(view?.thesis?.trades.length, 1);
    assert.equal(view?.thesis?.trades[0]?.exitReason, "target");
    // The label the user gave it, not a re-derived sentence.
    assert.equal(view?.thesis?.headline, "The 5m fade");
  }).pipe(withValidation("1m")),
);

it.effect("sends the badge without markers when the chart is on another interval", () =>
  Effect.gen(function* () {
    snapshotRead = Effect.succeed(snapshot);
    historyRead = Effect.succeed(history);

    const chart = yield* TradingMarketChart;
    const view = yield* chart.read({ market: "ETH", interval: "1m", maxBars: 60 });

    assert.equal(view?.thesis?.intervalMatches, false);
    // The badge still says what is running; the markers do not lie about where.
    assert.equal(view?.thesis?.interval, "5m");
    assert.deepEqual(view?.thesis?.trades, []);
  }).pipe(withValidation("5m")),
);

it.effect("still draws the chart when the paper ledger cannot be read", () =>
  Effect.gen(function* () {
    snapshotRead = Effect.succeed(snapshot);
    historyRead = Effect.succeed(history);

    const chart = yield* TradingMarketChart;
    const view = yield* chart.read({ market: "ETH", interval: "1m", maxBars: 60 });

    // A price series must render when a decoration fails. The alternative is a
    // blank chart because a paper trade could not be counted.
    assert.isNotNull(view);
    assert.isAbove(view?.candles.length ?? 0, 0);
    assert.isUndefined(view?.thesis);
  }).pipe(
    Effect.provide(
      Layer.merge(
        TradingMarketChartLive.pipe(
          Layer.provide(
            Layer.mergeAll(
              stubGateway,
              emptyArchive,
              Layer.succeed(TradingThesisValidationService, {
                forChart: () => Effect.die("the paper ledger is unavailable"),
              } as unknown as (typeof TradingThesisValidationService)["Service"]),
            ),
          ),
        ),
        TestClock.layer(),
      ),
    ),
  ),
);
