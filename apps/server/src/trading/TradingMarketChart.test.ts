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

import * as NodeServices from "@effect/platform-node/NodeServices";

import type { TradingChartRange } from "@t3tools/contracts";
import { HyperliquidGateway } from "@t3tools/hyperliquid/Gateway";
import type {
  AgentMarketSnapshot,
  MarketCandle,
  MarketHistory,
} from "@t3tools/trading-contracts/market";

import { runMigrations } from "../persistence/Migrations.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { TradingEventService, TradingEventServiceLive } from "./TradingEventService.ts";
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
        Layer.provide(
          Layer.mergeAll(stubGateway, emptyArchive, noValidations, TradingEventServiceLive),
        ),
        Layer.provideMerge(NodeSqliteClient.layerMemory()),
        Layer.provideMerge(NodeServices.layer),
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
          Layer.provideMerge(TradingEventServiceLive),
          Layer.provideMerge(NodeSqliteClient.layerMemory()),
          Layer.provideMerge(NodeServices.layer),
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
          Layer.provideMerge(TradingEventServiceLive),
          Layer.provideMerge(NodeSqliteClient.layerMemory()),
          Layer.provideMerge(NodeServices.layer),
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
const validationOn = (interval: string, options: { readonly open?: boolean } = {}) =>
  Layer.succeed(TradingThesisValidationService, {
    forChart: () =>
      Effect.succeed({
        validation: {
          id: "validation-1",
          interval,
          status: "armed",
          expiresAt: 9_000,
          label: "The 5m fade",
          armedAt: 0,
          endedAt: null,
          endReason: null,
          notionalUsd: 1_000,
          // Whole enough for `composeReport`, which the badge's running
          // verdict now goes through: a stub missing `entry` or `barsWatched`
          // fails the composition, and the read's own catch turns any failure
          // into no thesis at all - so an incomplete fixture here looks
          // exactly like a market with no validation on it.
          barsWatched: 500,
          baseline: null,
          thesis: {
            market: "ETH",
            interval,
            side: "long",
            entry: {
              predicates: [
                {
                  left: { source: "price", field: "close" },
                  comparator: "above",
                  right: { source: "constant", value: 3_900 },
                },
              ],
            },
            exits: { stop: { basis: "percent", value: 1 } },
          },
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
            signalTime: 1_000,
            stopPrice: 2_970,
            targetPrice: 3_030,
            barsHeld: 2,
            grossUsd: 10,
            feesUsd: 0.6,
            fundingUsd: 0,
            adverseExcursionUsd: 0,
          },
          ...(options.open === true
            ? [
                {
                  id: "paper-open",
                  entryTime: 3_000,
                  entryPrice: 3_020,
                  signalTime: 3_000,
                  exitTime: null,
                  exitPrice: null,
                  netUsd: null,
                  exitReason: null,
                  stopPrice: 2_990,
                  targetPrice: 3_060,
                  barsHeld: 1,
                  grossUsd: null,
                  feesUsd: null,
                  fundingUsd: null,
                  adverseExcursionUsd: null,
                },
              ]
            : []),
        ],
      }),
  } as unknown as (typeof TradingThesisValidationService)["Service"]);

/** The same validation, with its newest paper trade still running. */
const withOpenPaperTrade = (interval: string) =>
  Effect.provide(
    Layer.merge(
      TradingMarketChartLive.pipe(
        Layer.provide(
          Layer.mergeAll(stubGateway, emptyArchive, validationOn(interval, { open: true })),
        ),
        Layer.provideMerge(TradingEventServiceLive),
        Layer.provideMerge(NodeSqliteClient.layerMemory()),
        Layer.provideMerge(NodeServices.layer),
      ),
      TestClock.layer(),
    ),
  );

const withValidation = (interval: string) =>
  Effect.provide(
    Layer.merge(
      TradingMarketChartLive.pipe(
        Layer.provide(Layer.mergeAll(stubGateway, emptyArchive, validationOn(interval))),
        Layer.provideMerge(TradingEventServiceLive),
        Layer.provideMerge(NodeSqliteClient.layerMemory()),
        Layer.provideMerge(NodeServices.layer),
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
    // A settled trade sends no bracket: only the open trade is banded, and
    // this array is uncapped.
    assert.equal(view?.thesis?.trades[0]?.stopPrice, null);
    assert.equal(view?.thesis?.trades[0]?.targetPrice, null);
    // The running verdict, composed off the same ledger the report card reads.
    assert.equal(view?.thesis?.comparison, "too_few_trades");
    assert.equal(view?.thesis?.side, "long");
    // A price is a price on any bars: the entry constant travels whatever the
    // chart's interval is, unlike the trade markers.
    assert.deepEqual(view?.thesis?.entryLevels, [{ price: 3_900, direction: "above" }]);
  }).pipe(withValidation("1m")),
);

it.effect("bands the open paper trade, and only that one", () =>
  Effect.gen(function* () {
    snapshotRead = Effect.succeed(snapshot);
    historyRead = Effect.succeed(history);

    const chart = yield* TradingMarketChart;
    const view = yield* chart.read({ market: "ETH", interval: "1m", maxBars: 60 });

    const open = view?.thesis?.trades.find((trade) => trade.exitTime === null);
    assert.isDefined(open);
    assert.equal(open?.stopPrice, 2_990);
    assert.equal(open?.targetPrice, 3_060);
  }).pipe(withOpenPaperTrade("1m")),
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
    // The levels are not withheld with them - see the assertion above.
    assert.deepEqual(view?.thesis?.entryLevels, [{ price: 3_900, direction: "above" }]);
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
          Layer.provideMerge(TradingEventServiceLive),
          Layer.provideMerge(NodeSqliteClient.layerMemory()),
          Layer.provideMerge(NodeServices.layer),
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

// -- the event bands of the thesis in view ------------------------------------
//
// Bands are decoration beside the thesis read: served only on a live window,
// from the calendar the thesis anchors on, at every interval. What is pinned
// here is the selection (window overlap plus the single next upcoming date)
// and the newest-first ordering the cap keeps.

/** An archive that actually serves bars, so a live read stays off the gateway. */
const servingArchive = Layer.succeed(TradingMarketArchive, {
  candlesInWindow: (input: { readonly fromT: number; readonly toT: number }) =>
    Effect.succeed(
      Array.from({ length: 200 }, (_, i) => {
        const t = input.toT - (200 - i) * 60_000;
        return { t, tClose: t + 59_999, o: 100, h: 101, l: 99, c: 100, v: 10, n: 5 };
      }),
    ),
  coverage: () => Effect.succeed({ recordingSince: null, gaps: [] }),
  sessionLevels: () => Effect.succeed({ status: "unavailable", reason: "no rows" }),
} as unknown as (typeof TradingMarketArchive)["Service"]);

it.effect("derives the thesis's event bands: window overlap, the next date, newest first", () => {
  // The stub names the set the (mutable) id below resolves to, so the thesis
  // can anchor on a calendar recorded inside the same effect.
  let anchoredSetId = "unset";
  const validations = Layer.succeed(TradingThesisValidationService, {
    forChart: () =>
      Effect.succeed({
        validation: {
          id: "validation-chart",
          interval: "1m",
          status: "armed",
          label: null,
          notionalUsd: 1_000,
          barsWatched: 0,
          baseline: null,
          thesis: {
            market: "ETH",
            interval: "1m",
            side: "long",
            entry: {
              predicates: [
                {
                  left: { source: "event", eventSetId: anchoredSetId, label: "Devcon" },
                  comparator: "below",
                  right: { source: "constant", value: 30 },
                },
              ],
            },
            exits: { maxHoldBars: 10 },
          },
        },
        trades: [],
      } as never),
  } as unknown as (typeof TradingThesisValidationService)["Service"]);

  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({});
    yield* sql`DELETE FROM trading_event_sets`;
    yield* sql`DELETE FROM trading_event_occurrences`;

    const eventService = yield* TradingEventService;
    const recorded = yield* eventService.record({
      name: "Devcon",
      occurrences: [
        // Inside the window, already ended.
        { startAt: 30_000, endAt: 90_000, label: "Devcon SEA", source: "url" },
        // Straddles now: overlapping and upcoming both at once.
        { startAt: 950_000, endAt: 1_050_000, source: "url" },
        // Wholly in the future, and NOT the next date: dropped.
        { startAt: 2_000_000, endAt: 2_060_000, source: "url" },
        // Wholly in the past, before the window: dropped.
        { startAt: -9_000_000, endAt: -8_900_000, source: "url" },
      ],
      threadId: "thread-chart",
      author: "agent",
      now: 1_000_000,
    });
    assert.equal(recorded.outcome, "ok");
    if (recorded.outcome !== "ok") return;
    anchoredSetId = recorded.set.eventSetId;

    // The live clock both the cache window and the band selection read.
    yield* TestClock.adjust(Duration.millis(1_000_000));

    const chart = yield* TradingMarketChart;
    const view = yield* chart.read({ market: "ETH", interval: "1m", maxBars: 100 });
    assert.notEqual(view, null);
    // Newest first: the straddling date, then the past one. The occurrence
    // with no label of its own falls back to the set's name.
    assert.deepEqual(view?.eventBands, [
      {
        key: `${anchoredSetId}:950000`,
        label: "Devcon",
        startAt: 950_000,
        endAt: 1_050_000,
        upcoming: true,
      },
      {
        key: `${anchoredSetId}:30000`,
        label: "Devcon SEA",
        startAt: 30_000,
        endAt: 90_000,
        upcoming: false,
      },
    ]);
  }).pipe(
    Effect.provide(
      Layer.merge(
        TradingMarketChartLive.pipe(
          Layer.provide(Layer.mergeAll(stubGateway, servingArchive, validations)),
          Layer.provideMerge(TradingEventServiceLive),
          Layer.provideMerge(NodeSqliteClient.layerMemory()),
          Layer.provideMerge(NodeServices.layer),
        ),
        TestClock.layer(),
      ),
    ),
  );
});

// -- ranges and the chart-only weekly/monthly intervals ------------------------
//
// A range names a HISTORY span the server resolves (the client cannot know
// `ytd`'s clock or `all`'s archive depth), and `1w`/`1mo` are served by folding
// the archive's daily record — never by asking the exchange. The doubles below
// mirror the real archive's contract: `candlesInWindow` keeps the NEWEST bars
// when it must cut, and `coverage` never refuses.

const DAY_MS = 24 * 60 * 60 * 1_000;

/** One recorded daily bar at a UTC calendar day, priced by `price`. */
interface DailyBarRow {
  readonly coin: string;
  readonly interval: string;
  readonly t: number;
  readonly tClose: number;
  readonly o: number;
  readonly h: number;
  readonly l: number;
  readonly c: number;
  readonly v: number;
  readonly n: number;
}

/** Daily bars for every UTC day from `start` (a UTC midnight), one per day. */
const dailyRun = (start: number, count: number): ReadonlyArray<DailyBarRow> =>
  Array.from({ length: count }, (_, i) => {
    const t = start + i * DAY_MS;
    const price = 100 + i;
    return {
      coin: "ETH",
      interval: "1d",
      t,
      tClose: t + DAY_MS - 1,
      o: price,
      h: price + 2,
      l: price - 3,
      c: price + 1,
      v: 10,
      n: 1,
    };
  });

interface ChartWindowCall {
  readonly coin: string;
  readonly interval: string;
  readonly fromT: number;
  readonly toT: number;
  readonly maxBars: number;
}

interface ChartCoverageCall {
  readonly coin: string;
  readonly interval: string;
  readonly fromT: number;
  readonly toT: number;
}

/**
 * An archive double that records every call and serves the configured daily
 * bars with the real service's own semantics: filtered to the asked window,
 * then cut to the NEWEST `maxBars` when the window holds more.
 */
const recordingArchive = (options: {
  readonly bars: ReadonlyArray<DailyBarRow>;
  readonly coverage: {
    recordingSince: number | null;
    gaps: ReadonlyArray<{ fromT: number; toT: number }>;
  };
  /**
   * Die on session-level reads instead of answering — for the cases that must
   * not ask (a live 1d read legitimately does; weekly/monthly ones must not).
   */
  readonly forbidSessionLevels?: boolean;
}) => {
  const windowCalls: Array<ChartWindowCall> = [];
  const coverageCalls: Array<ChartCoverageCall> = [];
  const layer = Layer.succeed(TradingMarketArchive, {
    candlesInWindow: (input: ChartWindowCall) => {
      windowCalls.push(input);
      const inWindow = options.bars.filter((bar) => bar.t >= input.fromT && bar.t <= input.toT);
      return Effect.succeed(
        inWindow.length <= input.maxBars
          ? inWindow
          : inWindow.slice(inWindow.length - input.maxBars),
      );
    },
    coverage: (input: ChartCoverageCall) => {
      coverageCalls.push(input);
      return Effect.succeed(options.coverage);
    },
    sessionLevels:
      options.forbidSessionLevels === true
        ? () => Effect.die("these reads must not ask for session levels")
        : () => Effect.succeed({ status: "unavailable" as const, reason: "no rows" }),
  } as unknown as (typeof TradingMarketArchive)["Service"]);
  return { layer, windowCalls, coverageCalls };
};

/** The chart layer on the stub gateway plus a case-specific archive double. */
const withArchive = (archiveLayer: Layer.Layer<TradingMarketArchive>) =>
  Effect.provide(
    Layer.merge(
      TradingMarketChartLive.pipe(
        Layer.provide(Layer.mergeAll(stubGateway, archiveLayer, noValidations)),
        Layer.provideMerge(TradingEventServiceLive),
        Layer.provideMerge(NodeSqliteClient.layerMemory()),
        Layer.provideMerge(NodeServices.layer),
      ),
      TestClock.layer(),
    ),
  );

it.effect(
  "a 1w read folds the daily record into Monday buckets without touching the exchange",
  () => {
    // Wednesday, 10 March 2027, 12:00 UTC. Range 1m reaches back to Monday 8
    // February (30 days), and the running week holds Mon-Wed of 8-10 March.
    const now = Date.UTC(2027, 2, 10, 12);
    const feb8 = Date.UTC(2027, 1, 8);
    const knownGap = { fromT: Date.UTC(2027, 1, 16), toT: Date.UTC(2027, 1, 17) };
    const archive = recordingArchive({
      bars: dailyRun(feb8, 31),
      coverage: { recordingSince: feb8, gaps: [knownGap] },
      forbidSessionLevels: true,
    });

    return Effect.gen(function* () {
      snapshotRead = Effect.succeed(snapshot);
      historyRead = Effect.succeed(history);
      historyCalls = 0;
      yield* TestClock.adjust(Duration.millis(now));

      const chart = yield* TradingMarketChart;
      const view = yield* chart.read({ market: "ETH", interval: "1w", maxBars: 8, range: "1m" });

      assert.isNotNull(view);
      assert.equal(historyCalls, 0, "a weekly chart never reaches the exchange");
      // The source read is the DAILY record: window start aligned down to its
      // Monday, bounded by the derived ceiling — never the output cap.
      assert.deepEqual(archive.windowCalls, [
        {
          coin: "ETH",
          interval: "1d",
          fromT: feb8,
          toT: now,
          maxBars: (8 + 1) * 7 + 1,
        },
      ]);
      assert.equal(view?.interval, "1w");
      // Five buckets: Feb 8, Feb 15, Feb 22, Mar 1, and the running week Mar 8.
      assert.deepEqual(
        view?.candles.map((candle) => candle.openTime),
        [
          feb8,
          Date.UTC(2027, 1, 15),
          Date.UTC(2027, 1, 22),
          Date.UTC(2027, 2, 1),
          Date.UTC(2027, 2, 8),
        ],
      );
      // First bucket folds its seven days: first open, max high, min low, last
      // close, summed volume (daily prices are 100, 101, … 106).
      assert.deepEqual(view?.candles[0], {
        openTime: feb8,
        open: 100,
        high: 108,
        low: 97,
        close: 107,
        volume: 70,
      });
      // The running week holds only its three closed days so far.
      assert.deepEqual(view?.candles[4], {
        openTime: Date.UTC(2027, 2, 8),
        open: 128,
        high: 132,
        low: 125,
        close: 131,
        volume: 30,
      });
      // The daily record's coverage decorates the view unchanged: the gap keeps
      // its daily bounds, and recordingSince says when the daily record began.
      assert.equal(view?.recordingSince, feb8);
      assert.deepEqual(view?.gaps, [knownGap]);
      assert.equal(
        archive.coverageCalls.every((call) => call.interval === "1d"),
        true,
      );
      assert.equal(view?.sessionLevels, undefined);
    }).pipe(withArchive(archive.layer));
  },
);

it.effect("a 1mo read buckets on calendar months and caps output after aggregation", () => {
  // Same Wednesday. Range 6m reaches back to Tue 8 Sep 2026 12:00, which the
  // monthly alignment takes down to 1 September — an honest partial bucket.
  const now = Date.UTC(2027, 2, 10, 12);
  const archive = recordingArchive({
    bars: dailyRun(Date.UTC(2026, 8, 7), 185),
    coverage: { recordingSince: Date.UTC(2026, 8, 7), gaps: [] },
    forbidSessionLevels: true,
  });

  return Effect.gen(function* () {
    snapshotRead = Effect.succeed(snapshot);
    historyRead = Effect.succeed(history);
    historyCalls = 0;
    yield* TestClock.adjust(Duration.millis(now));

    const chart = yield* TradingMarketChart;
    const view = yield* chart.read({ market: "ETH", interval: "1mo", maxBars: 12, range: "6m" });

    assert.isNotNull(view);
    assert.equal(historyCalls, 0, "a monthly chart never reaches the exchange");
    assert.deepEqual(
      archive.windowCalls.map((call) => ({ interval: call.interval, maxBars: call.maxBars })),
      [{ interval: "1d", maxBars: (12 + 1) * 31 + 1 }],
    );
    // Sep (partial, from the aligned Monday the 7th) through the running March.
    assert.deepEqual(
      view?.candles.map((candle) => candle.openTime),
      [
        Date.UTC(2026, 8, 1),
        Date.UTC(2026, 9, 1),
        Date.UTC(2026, 10, 1),
        Date.UTC(2026, 11, 1),
        Date.UTC(2027, 0, 1),
        Date.UTC(2027, 1, 1),
        Date.UTC(2027, 2, 1),
      ],
    );
    // February folds exactly its 28 days (Feb 1 is the run's 147th bar).
    assert.deepEqual(view?.candles[5], {
      openTime: Date.UTC(2027, 1, 1),
      open: 247,
      high: 276,
      low: 244,
      close: 275,
      volume: 280,
    });

    // maxBars 3: the source ceiling shrinks, and the OUTPUT cap then keeps the
    // newest three months — the oldest are dropped after aggregation.
    const capped = yield* chart.read({ market: "ETH", interval: "1mo", maxBars: 3, range: "6m" });
    assert.deepEqual(
      capped?.candles.map((candle) => candle.openTime),
      [Date.UTC(2027, 0, 1), Date.UTC(2027, 1, 1), Date.UTC(2027, 2, 1)],
    );
  }).pipe(withArchive(archive.layer));
});

it.effect("resolves each range to its server-side window start", () => {
  const now = Date.UTC(2027, 2, 10, 12);
  const coverage = {
    recordingSince: null as number | null,
    gaps: [] as ReadonlyArray<{ fromT: number; toT: number }>,
  };
  const archive = recordingArchive({ bars: dailyRun(Date.UTC(2026, 8, 7), 185), coverage });

  return Effect.gen(function* () {
    snapshotRead = Effect.succeed(snapshot);
    historyRead = Effect.succeed(history);
    historyCalls = 0;
    yield* TestClock.adjust(Duration.millis(now));

    const chart = yield* TradingMarketChart;
    const fromTOf = (range?: TradingChartRange) =>
      chart
        .read({
          market: "ETH",
          interval: "1d",
          maxBars: 30,
          ...(range !== undefined ? { range } : {}),
        })
        .pipe(
          Effect.tap((view) => Effect.sync(() => assert.isNotNull(view))),
          Effect.map(() => archive.windowCalls[archive.windowCalls.length - 1]?.fromT),
        );

    assert.equal(yield* fromTOf("1w"), now - 7 * DAY_MS);
    assert.equal(yield* fromTOf("1m"), now - 30 * DAY_MS);
    assert.equal(yield* fromTOf("6m"), now - 183 * DAY_MS);
    assert.equal(yield* fromTOf("1y"), now - 365 * DAY_MS);
    // ytd is 00:00:00 UTC of the current year, not a rolling 12 months.
    assert.equal(yield* fromTOf("ytd"), Date.UTC(2027, 0, 1));
    // No range: the latest-bars default, as before.
    assert.equal(yield* fromTOf(), now - 30 * DAY_MS);

    // `all` is the archive's oldest bar for the market, asked of coverage.
    coverage.recordingSince = Date.UTC(2026, 8, 7);
    assert.equal(yield* fromTOf("all"), Date.UTC(2026, 8, 7));
    assert.equal(
      archive.coverageCalls.some((call) => call.fromT === 0 && call.interval === "1d"),
      true,
      "`all` resolves from a whole-history coverage read",
    );
    // Nothing recorded yet: `all` falls back to the default window. The cache
    // window must close first — the previous `all` answer is still being
    // served, which is the service's contract, not a bug.
    coverage.recordingSince = null;
    yield* TestClock.adjust(Duration.seconds(6));
    assert.equal(yield* fromTOf("all"), now + 6_000 - 30 * DAY_MS);
  }).pipe(withArchive(archive.layer));
});

it.effect("a windowed read ignores range entirely", () => {
  const now = Date.UTC(2027, 2, 10, 12);
  const archive = recordingArchive({
    bars: dailyRun(Date.UTC(2026, 8, 7), 185),
    coverage: { recordingSince: Date.UTC(2026, 8, 7), gaps: [] },
  });

  return Effect.gen(function* () {
    snapshotRead = Effect.succeed(snapshot);
    historyRead = Effect.succeed(history);
    historyCalls = 0;
    yield* TestClock.adjust(Duration.millis(now));

    const chart = yield* TradingMarketChart;
    const view = yield* chart.read({
      market: "ETH",
      interval: "1d",
      maxBars: 30,
      range: "all",
      startTime: Date.UTC(2027, 1, 1),
      endTime: Date.UTC(2027, 1, 28, 23, 59),
    });

    assert.isNotNull(view);
    assert.deepEqual(
      archive.windowCalls.map((call) => [call.fromT, call.toT]),
      [[Date.UTC(2027, 1, 1), Date.UTC(2027, 1, 28, 23, 59)]],
    );
    // No whole-history coverage resolution happened: the only coverage call is
    // the decoration, clipped to the caller's own window.
    assert.deepEqual(
      archive.coverageCalls.map((call) => call.fromT),
      [Date.UTC(2027, 1, 1)],
    );
  }).pipe(withArchive(archive.layer));
});

it.effect("a weekly read with no usable daily record fails without reaching the exchange", () => {
  const now = Date.UTC(2027, 2, 10, 12);
  // No bars at all, and bars ending in early January: 1w freshness allows
  // three weekly intervals of trail (21 days), so a two-month-old tail must
  // not serve. Neither case has an exchange path to fall back to.
  const archives = [
    recordingArchive({ bars: [], coverage: { recordingSince: null, gaps: [] } }),
    recordingArchive({
      bars: dailyRun(Date.UTC(2027, 0, 1), 5),
      coverage: { recordingSince: Date.UTC(2027, 0, 1), gaps: [] },
    }),
  ];
  const exercise = (archiveLayer: Layer.Layer<TradingMarketArchive>) =>
    Effect.gen(function* () {
      snapshotRead = Effect.succeed(snapshot);
      historyRead = Effect.succeed(history);
      historyCalls = 0;
      yield* TestClock.adjust(Duration.millis(now));
      const chart = yield* TradingMarketChart;
      const view = yield* chart.read({ market: "ETH", interval: "1w", maxBars: 120, range: "1y" });
      assert.equal(view, null);
      assert.equal(historyCalls, 0, "1w has no exchange path to fall back to");
    }).pipe(withArchive(archiveLayer));

  // Each case carries its own layer (and its own cache), so run them one
  // after the other inside one self-provided effect per case.
  return Effect.gen(function* () {
    for (const archive of archives) {
      yield* exercise(archive.layer);
    }
  });
});

it.effect("the cache key separates ranges", () => {
  const now = Date.UTC(2027, 2, 10, 12);
  const archive = recordingArchive({
    bars: dailyRun(Date.UTC(2026, 8, 7), 185),
    coverage: { recordingSince: Date.UTC(2026, 8, 7), gaps: [] },
  });

  return Effect.gen(function* () {
    snapshotRead = Effect.succeed(snapshot);
    historyRead = Effect.succeed(history);
    yield* TestClock.adjust(Duration.millis(now));

    const chart = yield* TradingMarketChart;
    const read = (range: "1d" | "1w") =>
      chart.read({ market: "ETH", interval: "1d", maxBars: 30, range });

    assert.isNotNull(yield* read("1d"));
    assert.isNotNull(yield* read("1w"));
    // Same range again, same tick: served from its own cache entry, not the
    // other range's, and without a fresh archive read.
    assert.isNotNull(yield* read("1w"));

    assert.equal(archive.windowCalls.length, 2);
    assert.deepEqual(
      archive.windowCalls.map((call) => call.fromT),
      [now - DAY_MS, now - 7 * DAY_MS],
    );
  }).pipe(withArchive(archive.layer));
});

// -- a dead snapshot API must not take the archive's candles down with it ------
//
// The series is the read; the live quote decorates the header. When the quote
// read fails, the candles still render — beside the last quote the exchange
// actually confirmed, marked `stale` with that quote's own `observedAt`. What
// is never allowed is the other direction: a mark invented from a candle
// close, which arm-at-price would read as live and point the wrong way.

/** An archive serving a mutable set of 1m bars; reads of it are windowed. */
interface MutableMinuteBar {
  readonly t: number;
  readonly tClose: number;
  readonly o: number;
  readonly h: number;
  readonly l: number;
  readonly c: number;
  readonly v: number;
  readonly n: number;
}
const mutableArchive = (bars: Array<MutableMinuteBar>) => {
  const layer = Layer.succeed(TradingMarketArchive, {
    candlesInWindow: () => Effect.succeed(bars),
    coverage: () => Effect.succeed({ recordingSince: bars[0]?.t ?? null, gaps: [] }),
    sessionLevels: () => Effect.die("windowed reads must not ask for session levels"),
  } as unknown as (typeof TradingMarketArchive)["Service"]);
  return layer;
};

const minuteBar = (t: number, close: number): MutableMinuteBar => ({
  t,
  tClose: t + 60_000 - 1,
  o: close - 1,
  h: close + 1,
  l: close - 2,
  c: close,
  v: 10,
  n: 5,
});

it.effect(
  "serves fresh archived candles with the last confirmed quote when the snapshot is down",
  () => {
    const bars: Array<MutableMinuteBar> = [minuteBar(1_000, 10), minuteBar(61_000, 11)];
    return Effect.gen(function* () {
      snapshotRead = Effect.succeed(snapshot);
      historyRead = Effect.succeed(history);
      snapshotCalls = 0;

      const chart = yield* TradingMarketChart;
      const window = {
        market: "ETH",
        interval: "1m" as const,
        maxBars: 10,
        startTime: 1_000,
        endTime: 200_000,
      };
      const good = yield* chart.read(window);
      assert.isNotNull(good);
      assert.isUndefined(good?.stale, "a fresh quote is not marked stale");
      assert.equal(good?.candles.length, 2);

      // Past the TTL, the snapshot API now down, and the archive holding one
      // more closed bar than it did on the first read.
      yield* TestClock.adjust(Duration.seconds(6));
      snapshotRead = Effect.fail("snapshot unreachable");
      snapshotCalls = 0;
      bars.push(minuteBar(121_000, 12));

      const served = yield* chart.read(window);
      assert.isNotNull(served, "a held archive window renders without a live snapshot");
      // The candles are the FRESH archive read, not the cached two.
      assert.deepEqual(
        served?.candles.map((bar) => bar.close),
        [10, 11, 12],
      );
      // The quote is the last one the exchange confirmed — never a close.
      assert.equal(served?.markPrice, snapshot.markPrice);
      assert.equal(served?.change24hPercent, snapshot.change24hPercent);
      assert.equal(served?.fundingRate8h, snapshot.fundingRate8h);
      assert.equal(served?.observedAt, good?.observedAt);
      assert.equal(served?.stale, true);

      // The degraded view was not cached: an immediate re-read retries the
      // snapshot rather than serving the hybrid as if it were confirmed.
      const again = yield* chart.read(window);
      assert.isNotNull(again);
      assert.equal(again?.stale, true);
      assert.isAtLeast(snapshotCalls, 2, "a degraded read is never written to cache");
    }).pipe(withArchive(mutableArchive(bars)));
  },
);

it.effect(
  "refuses rather than inventing a quote when the snapshot is down and nothing was confirmed",
  () => {
    const bars: Array<MutableMinuteBar> = [minuteBar(1_000, 10), minuteBar(61_000, 11)];
    return Effect.gen(function* () {
      snapshotRead = Effect.fail("snapshot unreachable");
      historyRead = Effect.succeed(history);
      snapshotCalls = 0;

      const chart = yield* TradingMarketChart;
      const window = {
        market: "ETH",
        interval: "1m" as const,
        maxBars: 10,
        startTime: 1_000,
        endTime: 200_000,
      };
      // The archive holds the whole window, but the wire's quote fields are
      // required numbers and no exchange ever confirmed one, so the read is
      // an explicit failure instead of a made-up mark.
      assert.equal(yield* chart.read(window), null);
      assert.equal(yield* chart.read(window), null);
      assert.isAtLeast(snapshotCalls, 2, "nothing was cached to serve instead");
    }).pipe(withArchive(mutableArchive(bars)));
  },
);

it.effect("yields null when the snapshot, the archive and the exchange are all down", () =>
  Effect.gen(function* () {
    snapshotRead = Effect.fail("snapshot unreachable");
    historyRead = Effect.fail("history unreachable");
    const chart = yield* TradingMarketChart;

    assert.equal(yield* chart.read({ market: "ETH", interval: "1m", maxBars: 100 }), null);
    // The windowed shape fails the same way: no series anywhere, no quote.
    assert.equal(
      yield* chart.read({
        market: "ETH",
        interval: "1m",
        maxBars: 100,
        startTime: 1_000,
        endTime: 2_000,
      }),
      null,
    );
  }).pipe(testLayer()),
);
