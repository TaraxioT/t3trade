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
 * A failed read never invents a chart. The price series and the live quote are
 * resolved independently: the series is the read, the quote decorates its
 * header, so a window the archive holds never fails to render merely because
 * the snapshot API is down. When the quote read fails, the last confirmed
 * quote is served for a few minutes beside FRESH candles, marked `stale` (its
 * `observedAt` says when the exchange last confirmed those figures); past that
 * window, or with no confirmed quote at all, the read yields `null` and the RPC
 * fails rather than inventing a mark. The same stale-then-null rule covers a
 * failed history read, and nothing new is written to cache on a degraded read.
 * Blanking the whole surface for one transient exchange hiccup is worse for an
 * operator making an exit decision than a chart a few seconds behind that says
 * so — but a mark synthesized from a historic close would arm watches on a
 * price the exchange never quoted, so absence stays absence.
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
  TradingChartEventBand,
  TradingChartInterval,
  TradingChartRange,
  TradingChartSessionLevels,
  TradingChartThesis,
  TradingMarketChartView,
} from "@t3tools/contracts";
import type { TradingMarket } from "@t3tools/trading-contracts/primitives";
import {
  describeThesis,
  thesisEntryPriceLevels,
  thesisEventSets,
} from "@t3tools/trading-contracts/thesis";
import { TradingEventService } from "./TradingEventService.ts";
import { TradingMarketArchive } from "./TradingMarketArchive.ts";
import {
  aggregateDailyBars,
  aggregationBucketStart,
  aggregationSourceCeiling,
} from "./chartAggregation.ts";
import { archiveDatabasePath } from "./archive/config.ts";
import { archiveOwnershipRefusal } from "./TradingRuntimeLease.ts";
import { composeReport, TradingThesisValidationService } from "./TradingThesisValidationService.ts";

/**
 * How many event bands one chart read carries. Twelve is more occurrences
 * than a thesis anchored on one set can show inside a window (the set caps at
 * 200, but a window overlaps a handful), and the number exists so a densely
 * recorded calendar can never fence the price line in behind verticals.
 */
const MAX_EVENT_BANDS = 12;

export interface TradingMarketChartReadInput {
  readonly market: string;
  readonly interval: TradingChartInterval;
  readonly maxBars: number;
  /**
   * How much history to serve, resolved to a window here because `all` is
   * defined by what the archive recorded, which only the server knows.
   * Ignored on a windowed read (`startTime`/`endTime` name their own span).
   */
  readonly range?: TradingChartRange;
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
  // Chart-only intervals, derived from archived 1d bars — see the aggregation
  // module. Durations here are bucket widths for window arithmetic only.
  "1w": 7 * 24 * 60 * 60_000,
  "1mo": 30 * 24 * 60 * 60_000,
};

/** The intervals the exchange gateway can serve; `4h`/`1d` are archive-only. */
const GATEWAY_INTERVALS = new Set<TradingChartInterval>(["1m", "3m", "5m", "15m", "1h"]);

const isGatewayInterval = (
  interval: TradingChartInterval,
): interval is "1m" | "3m" | "5m" | "15m" | "1h" => GATEWAY_INTERVALS.has(interval);

/**
 * The chart-only intervals served by folding archived daily bars. Never
 * requested from the exchange and never stored: the gateway stops at `1h`
 * (see `GATEWAY_INTERVALS`), so the aggregation path below is their only
 * source, and an archive that cannot serve them fails the read like every
 * other archive-only interval.
 */
const AGGREGATED_INTERVALS = new Set<TradingChartInterval>(["1w", "1mo"]);

const isAggregatedInterval = (interval: TradingChartInterval): interval is "1w" | "1mo" =>
  AGGREGATED_INTERVALS.has(interval);

const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * Fixed range windows: the chart's HISTORY span, resolved from the server's
 * clock. These names collide with interval names but are not interval widths —
 * range `1w` is a week of history whatever interval draws it, and range `1m`
 * is a calendar month of it (not one 1m bar's width). `ytd` and `all` resolve
 * per read: `ytd` from the current UTC year, `all` from what the archive
 * actually holds.
 */
const RANGE_WINDOW_FROM: Readonly<
  Record<Exclude<TradingChartRange, "all">, (now: number) => number>
> = {
  "1d": (now) => now - DAY_MS,
  "1w": (now) => now - 7 * DAY_MS,
  "1m": (now) => now - 30 * DAY_MS,
  "6m": (now) => now - 183 * DAY_MS,
  ytd: (now) =>
    DateTime.makeUnsafe({
      year: DateTime.toPartsUtc(DateTime.makeUnsafe(now)).year,
      month: 1,
      day: 1,
    }).epochMilliseconds,
  "1y": (now) => now - 365 * DAY_MS,
};

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
  const events = yield* TradingEventService;
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
    windowFrom: number,
    windowTo: number,
    now: number,
  ): Effect.Effect<{
    readonly wire: TradingChartThesis;
    readonly bands: ReadonlyArray<TradingChartEventBand>;
  } | null> =>
    Effect.gen(function* () {
      const found = yield* validations.forChart({ asset: market });
      if (found === null) return null;
      const { validation } = found;
      if (validation.status === "ended") return null;
      const intervalMatches = validation.interval === interval;
      // The running verdict, off the same pure composition the report card and
      // the expiry alert use. Composed rather than re-derived so the badge on
      // the chart and the card in the thread cannot disagree about whether a
      // run is tracking; the whole read is behind this module's own cache, so
      // it costs one composition per cache window, not one per poll.
      const comparison = composeReport(validation, found.trades).comparison;

      // The event bands of the thesis in view: occurrences overlapping the
      // served window, plus the single next upcoming occurrence per set so
      // the gutter shows the date being waited on. Newest first, capped at
      // MAX_EVENT_BANDS so a densely recorded calendar cannot fence the price
      // line in behind verticals. Served at EVERY interval: trades are claims
      // produced at one interval, but an event is a claim about a wall-clock
      // time, like a price level is a claim about a price, so its band is
      // true wherever the chart is drawn.
      const bands: Array<TradingChartEventBand> = [];
      for (const setId of thesisEventSets(validation.thesis)) {
        const set = yield* events.show(setId);
        if (set === null) continue;
        const nextUpcoming =
          set.occurrences.filter((row) => row.endAt > now).sort((a, b) => a.endAt - b.endAt)[0] ??
          null;
        for (const row of set.occurrences) {
          const overlapsWindow = row.startAt <= windowTo && row.endAt >= windowFrom;
          const isTheNextUpcoming = nextUpcoming !== null && row.startAt === nextUpcoming.startAt;
          if (!overlapsWindow && !isTheNextUpcoming) continue;
          bands.push({
            key: `${set.eventSetId}:${row.startAt}`,
            label: row.label ?? set.name,
            startAt: row.startAt,
            endAt: row.endAt,
            upcoming: row.endAt > now,
          });
        }
      }
      // Newest first, so the cap keeps the bands the window actually shows.
      bands.sort((a, b) => b.startAt - a.startAt);

      return {
        wire: {
          validationId: validation.id,
          headline: validation.label ?? describeThesis(validation.thesis),
          interval: validation.interval as TradingChartInterval,
          status: validation.status,
          expiresAt: validation.expiresAt,
          intervalMatches,
          side: validation.thesis.side,
          comparison,
          // Levels, not markers: they are true on every timeframe, because the
          // rule's number does not change with the bars it is read on. The
          // interval gate above is about WHEN the rule fired, which is a claim
          // about times, and this is a claim about a price.
          entryLevels: thesisEntryPriceLevels(validation.thesis),
          trades: intervalMatches
            ? found.trades.map((trade) => ({
                id: trade.id,
                entryTime: trade.entryTime,
                entryPrice: trade.entryPrice,
                exitTime: trade.exitTime,
                exitPrice: trade.exitPrice,
                netUsd: trade.netUsd,
                exitReason: trade.exitReason,
                // Only the OPEN trade carries its bracket. The chart bands the
                // trade that is still running and nothing else - a settled
                // trade's stop is a fact about a moment that has passed - and
                // this array is uncapped, so sending two numbers per settled
                // trade cost 5.2 KB on a 134-trade validation, on a 15s poll,
                // for a pair of levels nothing reads.
                ...(trade.exitTime === null
                  ? { stopPrice: trade.stopPrice, targetPrice: trade.targetPrice }
                  : { stopPrice: null, targetPrice: null }),
              }))
            : [],
        },
        bands: bands.slice(0, MAX_EVENT_BANDS),
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
      const { market, interval, maxBars, range, startTime, endTime } = input;
      // The read gate: a writer lock nobody can parse is the one archive
      // state where serving data would be serving a guess about who owns the
      // file, so the chart refuses rather than renders. Every other state
      // (owned, external, stopped, stale) stays readable with its own label.
      const ownership = archiveOwnershipRefusal(`${archiveDatabasePath()}.writer.lock`);
      if (ownership !== null) {
        yield* Effect.logWarning("TradingMarketChart: refusing read", {
          market,
          reason: ownership,
        });
        return null;
      }
      // The window is part of the identity of the read: a post-mortem chart of
      // a closed trade and the live chart of the same market/interval are
      // different series, and sharing a cache entry would serve one as the
      // other. `maxBars` is part of it too — a 360-bar read and a 120-bar
      // read of the same series are different answers — and so is `range`,
      // which resolves to a different window on the server.
      const key = `${market}:${interval}:${maxBars}:${startTime ?? ""}:${endTime ?? ""}:${range ?? ""}`;
      const now = yield* Clock.currentTimeMillis;
      const cached = (yield* Ref.get(cache)).get(key);
      if (cached !== undefined && now - cached.readAt < CACHE_WINDOW_MS) return cached.view;

      // The archive is asked first for BOTH shapes of read. A windowed read is
      // the post-mortem chart of a finished trade, and the exchange serves
      // roughly the most recent 5,000 bars and nothing older — the archive is
      // the only thing that still holds a week-old window. A latest-bars read
      // trusts the archive only while its newest bar is fresh: the WS
      // collector writes followed markets continuously, so a stale tail means
      // it is not recording and the exchange answers instead. `4h`/`1d` have
      // no exchange path here (the gateway stops at `1h`), so for those the
      // archive is the only source and an empty answer fails the read — and
      // `1w`/`1mo` are the same, one step removed: they fold the daily record.
      const intervalMillis = INTERVAL_MILLIS[interval];
      const windowed = startTime !== undefined && endTime !== undefined;
      const aggregated = isAggregatedInterval(interval);

      // A live read's window start: the default latest-bars span, narrowed by
      // a range when one is named. Ranges resolve HERE because two of them are
      // unknowable on the client — `ytd` needs the server's clock, and `all`
      // is defined by what the archive recorded for this market. A windowed
      // read names its own span and ignores `range` entirely.
      const defaultFrom = now - maxBars * intervalMillis;
      const rangeStart =
        range === undefined || windowed
          ? null
          : range === "all"
            ? (yield* archive.coverage({
                coin: market,
                // `all` at 1w/1mo spans what the DAILY record holds — the
                // aggregation source — not an interval nothing records.
                interval: aggregated ? "1d" : interval,
                fromT: 0,
                toT: now,
              })).recordingSince
            : RANGE_WINDOW_FROM[range](now);
      const windowFrom = windowed ? startTime : (rangeStart ?? defaultFrom);
      const windowTo = windowed ? endTime : now;

      // The source read for a weekly/monthly chart is the DAILY record, from
      // the window start aligned DOWN to its bucket boundary (so the first
      // partial bucket is honest), bounded by a ceiling derived from the
      // output cap. The RPC's bar cap limits OUTPUT buckets and must not clip
      // the source read: the archive keeps the NEWEST bars when it cuts, so a
      // prematurely capped read would silently drop the oldest buckets.
      const archived = yield* archive.candlesInWindow({
        coin: market,
        interval: aggregated ? "1d" : interval,
        fromT: aggregated ? aggregationBucketStart(interval, windowFrom) : windowFrom,
        toT: windowTo,
        maxBars: aggregated ? aggregationSourceCeiling(interval, maxBars) : maxBars,
      });
      const newestClose = archived.length > 0 ? archived[archived.length - 1]!.tClose : null;
      const archiveServes =
        archived.length > 0 &&
        (windowed ||
          (newestClose !== null && now - newestClose <= ARCHIVE_FRESH_BARS * intervalMillis));

      const history: { candles: ReadonlyArray<TradingChartCandle> } | null = archiveServes
        ? aggregated
          ? {
              // The output cap applies to the aggregated buckets, after the
              // fold — newest buckets win, exactly as the archive's own cap
              // behaves for stored bars.
              candles: aggregateDailyBars({
                bars: archived.map((bar) => ({
                  t: bar.t,
                  o: bar.o,
                  h: bar.h,
                  l: bar.l,
                  c: bar.c,
                  v: bar.v,
                })),
                kind: interval,
                maxBars,
              }),
            }
          : {
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
      if (history === null) {
        // No series anywhere: serve the last good view rather than blanking
        // the surface. Only the freshness claim changes — everything drawn is
        // what the exchange last actually confirmed.
        if (cached === undefined || now - cached.readAt > STALE_WINDOW_MS) return null;
        yield* Effect.logDebug("trading chart served stale", {
          market,
          interval,
          ageMillis: now - cached.readAt,
        });
        return { ...cached.view, stale: true };
      }

      // Coverage and session levels are decoration, never a reason to fail:
      // both come from the archive alone and degrade to absence. A weekly or
      // monthly chart decorates from the DAILY record's coverage — gaps stay
      // at daily resolution so a bucket that bridges a known daily gap is
      // shaded honestly, and nothing here re-times or merges them.
      const coverage = yield* archive.coverage({
        coin: market,
        interval: aggregated ? "1d" : interval,
        fromT: windowFrom,
        toT: windowTo,
      });
      // "Prior day" and "today" are anchored at now, so a post-mortem window
      // from last week must not carry them — they would be the wrong day's —
      // and a multi-week chart has no single "today" for its context either.
      const sessionLevels =
        windowed || aggregated
          ? null
          : toWireSessionLevels(yield* archive.sessionLevels({ coin: market, now }));

      // The thesis being validated on this market, when there is one. Read
      // last and never allowed to fail the chart: a validation is decoration
      // on a price series, and a chart that would not draw because a paper
      // ledger read failed is the wrong trade.
      //
      // Only on a live window. A post-mortem chart of last week is not where
      // a running validation belongs, and its markers would be outside it.
      const thesis = windowed
        ? null
        : yield* readThesis(market, interval, windowFrom, windowTo, now);

      // Everything the series and its decorations say, before any quote is
      // attached. This is the part an unavailable snapshot must never take
      // down: the candles, coverage and bands are facts about history.
      const body = {
        market,
        interval,
        candles: history.candles,
        ...(thesis === null ? {} : { thesis: thesis.wire }),
        ...(thesis === null || thesis.bands.length === 0 ? {} : { eventBands: thesis.bands }),
        ...(sessionLevels === null ? {} : { sessionLevels }),
        ...(coverage.recordingSince === null ? {} : { recordingSince: coverage.recordingSince }),
        ...(coverage.gaps.length === 0 ? {} : { gaps: coverage.gaps }),
      };

      // The live quote, fetched only once a series exists to decorate. It
      // degrades to null on failure, and null is an answer: nothing below
      // invents a mark from a candle close, because the header figures arm
      // watches (arm-at-price reads `markPrice` to pick a direction) and a
      // synthesized mark would point them the wrong way.
      const snapshot = yield* gateway.getMarketSnapshot(market).pipe(
        Effect.tapError((cause) =>
          Effect.logDebug("trading chart snapshot read failed", { market, cause }),
        ),
        Effect.orElseSucceed(() => null),
      );

      if (snapshot === null) {
        // The snapshot is down but the series served. The header carries the
        // LAST quote the exchange actually confirmed, marked `stale` with its
        // own `observedAt`, next to candles that are fresh; nothing is cached,
        // so the degraded quote can never outlive its label.
        if (cached === undefined || now - cached.readAt > STALE_WINDOW_MS) {
          yield* Effect.logDebug("trading chart refused: no live quote and no confirmed quote", {
            market,
            interval,
          });
          return null;
        }
        yield* Effect.logDebug("trading chart served fresh history with last confirmed quote", {
          market,
          interval,
          quoteAgeMillis: now - cached.readAt,
        });
        return {
          ...body,
          markPrice: cached.view.markPrice,
          change24hPercent: cached.view.change24hPercent,
          fundingRate8h: cached.view.fundingRate8h,
          openInterest: cached.view.openInterest,
          dayVolumeUsd: cached.view.dayVolumeUsd,
          observedAt: cached.view.observedAt,
          stale: true,
        };
      }

      const view: TradingMarketChartView = {
        ...body,
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
