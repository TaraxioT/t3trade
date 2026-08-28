/**
 * TradingMarketChart — the chart surface's combined snapshot + candle read.
 *
 * The chart needs two things the exchange owns: the OHLC series a candle pane is
 * drawn from, and the mark/funding/OI/volume/change figures its header and
 * footer rows quote. Reading them as two separate RPCs would let the chart
 * render a price series against a stale header any time the two reads raced, so
 * this service fetches both in one effect and returns a single
 * `TradingMarketChartView` the surface can project atomically.
 *
 * The pair is cached for a few seconds because the chart is polled on a fixed
 * cadence: without the window every open workspace would put its own pair of
 * Hyperliquid calls on the wire on every poll, for figures that barely move in
 * that window. The TTL stays well under the candle poll so a polling client
 * still sees a fresh series each time, while concurrent clients share one read.
 *
 * A failed read never invents a chart. If either the snapshot or the history
 * call fails, the last good view is served again for a few minutes, marked
 * `stale`, and nothing new is written to cache; past that window, or with no
 * cache at all, the read yields `null` and the RPC fails. Blanking the whole
 * surface for one transient exchange hiccup is worse for an operator making an
 * exit decision than a chart a few seconds behind that says so.
 *
 * @module TradingMarketChart
 */
import { Context, Effect } from "effect";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { HyperliquidGateway } from "@t3tools/hyperliquid";
import type {
  TradingChartCandle,
  TradingChartInterval,
  TradingChartSessionLevels,
  TradingChartThesis,
  TradingMarketChartView,
} from "@t3tools/contracts";
import type { TradingMarket } from "@t3tools/trading-contracts/primitives";
import { describeThesis } from "@t3tools/trading-contracts/thesis";
import { TradingMarketArchive } from "./TradingMarketArchive.ts";
import { TradingThesisValidationService } from "./TradingThesisValidationService.ts";

export interface TradingMarketChartReadInput {
  readonly market: string;
  readonly interval: TradingChartInterval;
  readonly maxBars: number;
  /** Epoch millis bounding the candle window; omitted means the latest bars. */
  readonly startTime?: number;
  readonly endTime?: number;
}

export interface TradingMarketChartShape {
  /** The market's chart view, or null when either exchange read failed. */
  readonly read: (
    input: TradingMarketChartReadInput,
  ) => Effect.Effect<TradingMarketChartView | null>;
}

export class TradingMarketChart extends Context.Service<
  TradingMarketChart,
  TradingMarketChartShape
>()("t3/trading/TradingMarketChart") {}

/**
 * How long a chart view is served from memory before the exchange is asked
 * again. The candle poll runs every 15s; this 5s window is short enough that a
 * polling client still sees a fresh series each poll, and long enough that
 * several clients polling at once collapse onto a single pair of reads.
 */
const CACHE_WINDOW_MS = 5_000;

/**
 * How far past its TTL a cached view may still be served when the exchange
 * read fails. Beyond this the series is old enough that showing it would
 * mislead more than an explicit failure does.
 */
const STALE_WINDOW_MS = 5 * 60_000;

interface CachedChart {
  readonly view: TradingMarketChartView;
  readonly readAt: number;
}

/** Millis per servable candle interval — the archive's own interval set. */
const INTERVAL_MILLIS: Record<TradingChartInterval, number> = {
  "1m": 60_000,
  "3m": 3 * 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
};

/** The intervals the exchange gateway can serve; `4h`/`1d` are archive-only. */
const GATEWAY_INTERVALS = new Set<TradingChartInterval>(["1m", "3m", "5m", "15m", "1h"]);

const isGatewayInterval = (
  interval: TradingChartInterval,
): interval is "1m" | "3m" | "5m" | "15m" | "1h" => GATEWAY_INTERVALS.has(interval);

/**
 * How far behind "now" the newest archived bar may trail before a latest-bars
 * read stops trusting the archive and falls back live. One bar is the normal
 * trail of an archive read (the forming bar is not stored); three means the
 * WS collector is not writing and the series would render a stopped market.
 */
const ARCHIVE_FRESH_BARS = 3;

/**
 * Map the archive's session-levels answer onto the wire struct, flattened.
 * `null` when the archive refused outright (no file, no rows at all).
 */
export function toWireSessionLevels(
  result:
    | {
        readonly status: "ok";
        readonly priorUtcDay?: {
          readonly high: number;
          readonly low: number;
          readonly close: number;
        };
        readonly currentUtcDay?: {
          readonly open: number;
          readonly high: number;
          readonly low: number;
        };
        readonly vwap?: number;
      }
    | { readonly status: "unavailable"; readonly reason: string },
): TradingChartSessionLevels | null {
  if (result.status !== "ok") return null;
  return {
    ...(result.priorUtcDay === undefined
      ? {}
      : {
          priorDayHigh: result.priorUtcDay.high,
          priorDayLow: result.priorUtcDay.low,
          priorDayClose: result.priorUtcDay.close,
        }),
    ...(result.currentUtcDay === undefined
      ? {}
      : {
          todayOpen: result.currentUtcDay.open,
          todayHigh: result.currentUtcDay.high,
          todayLow: result.currentUtcDay.low,
        }),
    ...(result.vwap === undefined ? {} : { vwap: result.vwap }),
  };
}

export const makeTradingMarketChart = Effect.gen(function* () {
  const gateway = yield* HyperliquidGateway;
  const archive = yield* TradingMarketArchive;
  const validations = yield* TradingThesisValidationService;
  const cache = yield* Ref.make(new Map<string, CachedChart>());

  /**
   * The armed or paused validation on this market, as the chart's badge and
   * markers.
   *
   * Trades are served only when the chart is on the thesis's own interval. A
   * 5m thesis has paper entries at 5m bar opens, and drawing those on a 1m
   * chart would put markers at times the rule never fired — so the badge goes
   * out alone and the client says which interval to switch to.
   */
  const readThesis = (
    market: string,
    interval: TradingChartInterval,
  ): Effect.Effect<TradingChartThesis | null> =>
    Effect.gen(function* () {
      const found = yield* validations.forChart({ asset: market });
      if (found === null) return null;
      const { validation } = found;
      if (validation.status === "ended") return null;
      const intervalMatches = validation.interval === interval;
      return {
        validationId: validation.id,
        headline: validation.label ?? describeThesis(validation.thesis),
        interval: validation.interval as TradingChartInterval,
        status: validation.status,
        expiresAt: validation.expiresAt,
        intervalMatches,
        trades: intervalMatches
          ? found.trades.map((trade) => ({
              id: trade.id,
              entryTime: trade.entryTime,
              entryPrice: trade.entryPrice,
              exitTime: trade.exitTime,
              exitPrice: trade.exitPrice,
              netUsd: trade.netUsd,
              exitReason: trade.exitReason,
            }))
          : [],
      };
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logDebug("trading chart thesis read failed", { market, cause }).pipe(
          Effect.as(null),
        ),
      ),
    );

  const read = (input: TradingMarketChartReadInput): Effect.Effect<TradingMarketChartView | null> =>
    Effect.gen(function* () {
      const { market, interval, maxBars, startTime, endTime } = input;
      // The window is part of the identity of the read: a post-mortem chart of
      // a closed trade and the live chart of the same market/interval are
      // different series, and sharing a cache entry would serve one as the
      // other. `maxBars` is part of it too — a 360-bar read and a 120-bar
      // read of the same series are different answers.
      const key = `${market}:${interval}:${maxBars}:${startTime ?? ""}:${endTime ?? ""}`;
      const now = yield* Clock.currentTimeMillis;
      const cached = (yield* Ref.get(cache)).get(key);
      if (cached !== undefined && now - cached.readAt < CACHE_WINDOW_MS) return cached.view;

      // Both reads degrade to null on failure; if either yields null the whole
      // read yields null and nothing is cached (a half-populated chart lies).
      const snapshot = yield* gateway.getMarketSnapshot(market).pipe(
        Effect.tapError((cause) =>
          Effect.logDebug("trading chart snapshot read failed", { market, cause }),
        ),
        Effect.orElseSucceed(() => null),
      );
      // The archive is asked first for BOTH shapes of read. A windowed read is
      // the post-mortem chart of a finished trade, and the exchange serves
      // roughly the most recent 5,000 bars and nothing older — the archive is
      // the only thing that still holds a week-old window. A latest-bars read
      // trusts the archive only while its newest bar is fresh: the WS
      // collector writes followed markets continuously, so a stale tail means
      // it is not recording and the exchange answers instead. `4h`/`1d` have
      // no exchange path here (the gateway stops at `1h`), so for those the
      // archive is the only source and an empty answer fails the read.
      const intervalMillis = INTERVAL_MILLIS[interval];
      const windowed = startTime !== undefined && endTime !== undefined;
      const windowFrom = windowed ? startTime : now - maxBars * intervalMillis;
      const windowTo = windowed ? endTime : now;
      const archived = yield* archive.candlesInWindow({
        coin: market,
        interval,
        fromT: windowFrom,
        toT: windowTo,
        maxBars,
      });
      const newestClose = archived.length > 0 ? archived[archived.length - 1]!.tClose : null;
      const archiveServes =
        archived.length > 0 &&
        (windowed ||
          (newestClose !== null && now - newestClose <= ARCHIVE_FRESH_BARS * intervalMillis));

      const history: { candles: ReadonlyArray<TradingChartCandle> } | null = archiveServes
        ? {
            candles: archived.map((bar) => ({
              openTime: bar.t,
              open: bar.o,
              high: bar.h,
              low: bar.l,
              close: bar.c,
              volume: bar.v,
            })),
          }
        : isGatewayInterval(interval)
          ? yield* gateway
              .getMarketHistory({
                market: market as TradingMarket,
                interval,
                maxBars,
                ...(startTime !== undefined ? { startTime } : {}),
                ...(endTime !== undefined ? { endTime } : {}),
              })
              .pipe(
                Effect.map((live) => ({
                  candles: live.candles.map(
                    (candle): TradingChartCandle => ({
                      openTime: candle.openTime,
                      open: candle.open,
                      high: candle.high,
                      low: candle.low,
                      close: candle.close,
                      volume: candle.volume,
                    }),
                  ),
                })),
                Effect.tapError((cause) =>
                  Effect.logDebug("trading chart history read failed", { market, interval, cause }),
                ),
                Effect.orElseSucceed(() => null),
              )
          : null;
      if (snapshot === null || history === null) {
        // Serve the last good view rather than blanking the surface. Only the
        // freshness claim changes — everything drawn is what the exchange last
        // actually confirmed.
        if (cached === undefined || now - cached.readAt > STALE_WINDOW_MS) return null;
        yield* Effect.logDebug("trading chart served stale", {
          market,
          interval,
          ageMillis: now - cached.readAt,
        });
        return { ...cached.view, stale: true };
      }

      // Coverage and session levels are decoration, never a reason to fail:
      // both come from the archive alone and degrade to absence.
      const coverage = yield* archive.coverage({
        coin: market,
        interval,
        fromT: windowFrom,
        toT: windowTo,
      });
      // "Prior day" and "today" are anchored at now, so a post-mortem window
      // from last week must not carry them — they would be the wrong day's.
      const sessionLevels = windowed
        ? null
        : toWireSessionLevels(yield* archive.sessionLevels({ coin: market, now }));

      // The thesis being validated on this market, when there is one. Read
      // last and never allowed to fail the chart: a validation is decoration
      // on a price series, and a chart that would not draw because a paper
      // ledger read failed is the wrong trade.
      //
      // Only on a live window. A post-mortem chart of last week is not where
      // a running validation belongs, and its markers would be outside it.
      const thesis = windowed ? null : yield* readThesis(market, interval);

      const view: TradingMarketChartView = {
        market,
        interval,
        candles: history.candles,
        ...(thesis === null ? {} : { thesis }),
        ...(sessionLevels === null ? {} : { sessionLevels }),
        ...(coverage.recordingSince === null ? {} : { recordingSince: coverage.recordingSince }),
        ...(coverage.gaps.length === 0 ? {} : { gaps: coverage.gaps }),
        markPrice: snapshot.markPrice,
        change24hPercent: snapshot.change24hPercent,
        fundingRate8h: snapshot.fundingRate8h,
        openInterest: snapshot.openInterest,
        dayVolumeUsd: snapshot.dayVolumeUsd,
        observedAt: DateTime.formatIso(DateTime.makeUnsafe(snapshot.freshness.observedAt)),
      };
      yield* Ref.update(cache, (entries) => new Map(entries).set(key, { view, readAt: now }));
      return view;
    });

  return TradingMarketChart.of({ read });
});

export const TradingMarketChartLive = Layer.effect(TradingMarketChart, makeTradingMarketChart);
