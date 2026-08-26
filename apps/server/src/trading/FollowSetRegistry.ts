/**
 * FollowSetRegistry — which markets this install is paying attention to.
 *
 * Recording every asset a venue lists is not affordable and recording two
 * hardcoded ones is not useful. The set that matters is the one attention is
 * already on: what is held, what is armed, what is on the watchlist, what was
 * charted a moment ago. That is what gets deep recording — WS candles, book
 * samples, a first-follow backfill — and everything else gets the cheap
 * universe-wide sampling the archiver does in one call anyway.
 *
 * Derived on read, from tables that already exist, so there is no follow state
 * to keep in sync with the thing it follows. The one exception is chart opens:
 * nothing durable records that somebody looked at a chart, so those are held in
 * memory with a decay window and lost on restart — which is the right lifetime
 * for "I glanced at this".
 *
 * The archiver is a separate process, so the set reaches it through a small
 * JSON file beside the archive that the child re-reads each tick. A file rather
 * than a table because the archive database has exactly one writer and this
 * would have made it two.
 *
 * @module FollowSetRegistry
 */
// @effect-diagnostics nodeBuiltinImport:off - writes the archiver's control file.
import { Context, Effect, Schema } from "effect";
import * as Clock from "effect/Clock";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  DEFAULT_TRADING_VENUE,
  type MarketRef,
  type TradingVenue,
} from "@t3tools/trading-contracts/primitives";

import { archiveDatabasePath } from "./archive/config.ts";

/** Why a market is followed. Ordered: the first reason wins when several apply. */
export type FollowReason = "position" | "watch" | "watchlist" | "chart";

/** One followed market and what put it there. */
export interface FollowedMarket {
  readonly venue: TradingVenue;
  readonly asset: string;
  readonly reason: FollowReason;
}

export interface FollowSetRegistryShape {
  /** The current follow set, newest evidence first, capped. */
  readonly list: Effect.Effect<ReadonlyArray<FollowedMarket>>;
  /** Note that somebody opened a chart on this market. */
  readonly noteChartOpened: (ref: MarketRef) => Effect.Effect<void>;
  /** Start publishing the set to the archiver. */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class FollowSetRegistry extends Context.Service<FollowSetRegistry, FollowSetRegistryShape>()(
  "t3/trading/FollowSetRegistry",
) {}

/**
 * How many markets are followed at once.
 *
 * Every followed market costs a book sample per minute and a WS candle
 * subscription per interval, so the cap is what keeps attention-driven
 * recording from becoming universe-wide recording by accident. Twenty is far
 * more than anyone watches at once and still a bounded number of requests.
 */
export const FOLLOW_CAP = 20;

/**
 * How long a chart open keeps a market followed.
 *
 * Long enough that closing a chart and reopening it does not re-trigger a
 * backfill, short enough that a day of browsing does not pin twenty markets.
 */
export const CHART_DECAY_MS = 24 * 60 * 60 * 1_000;

/** How often the set is recomputed and republished to the archiver. */
const PUBLISH_INTERVAL_MS = 30_000;

/** Where the archiver reads the follow set from. */
export const followSetControlPath = (): string => `${archiveDatabasePath()}.follow.json`;

/**
 * The control file's shape. Venue and asset only: the reason a market is
 * followed is the server's business, and the archiver only needs the list.
 */
export const FollowSetControlFile = Schema.Struct({
  followed: Schema.Array(Schema.Struct({ venue: Schema.String, asset: Schema.String })),
});
const encodeControlFile = Schema.encodeSync(Schema.fromJsonString(FollowSetControlFile));

/** Reasons in priority order — a market held is followed for being held. */
const REASON_ORDER: ReadonlyArray<FollowReason> = ["position", "watch", "watchlist", "chart"];

/**
 * Fold the four sources into one capped, de-duplicated list.
 *
 * Pure so the precedence and the cap can be tested without a database: an
 * asset held and charted is followed once, as a position, and the cap drops
 * chart opens before it drops anything anyone has money in.
 */
export function foldFollowSet(
  candidates: ReadonlyArray<FollowedMarket>,
  cap: number = FOLLOW_CAP,
): ReadonlyArray<FollowedMarket> {
  const best = new Map<string, FollowedMarket>();
  for (const candidate of candidates) {
    const key = `${candidate.venue}:${candidate.asset}`;
    const existing = best.get(key);
    if (
      existing === undefined ||
      REASON_ORDER.indexOf(candidate.reason) < REASON_ORDER.indexOf(existing.reason)
    ) {
      best.set(key, candidate);
    }
  }
  return [...best.values()]
    .sort((left, right) => REASON_ORDER.indexOf(left.reason) - REASON_ORDER.indexOf(right.reason))
    .slice(0, cap);
}

/** The market a persisted watch is about, or null when its JSON does not say. */
export function watchMarket(watchJson: string): string | null {
  try {
    const parsed: unknown = JSON.parse(watchJson);
    if (parsed === null || typeof parsed !== "object") return null;
    const market = (parsed as Record<string, unknown>)["market"];
    return typeof market === "string" && market.length > 0 ? market : null;
  } catch {
    return null;
  }
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  /** Chart opens: market key → when it was last opened. */
  const charted = yield* Ref.make(new Map<string, number>());

  const fromPositions = Effect.gen(function* () {
    const rows = yield* sql<{ readonly market: string }>`
      SELECT DISTINCT market FROM trading_position_snapshots WHERE size != 0
    `;
    return rows.map(
      (row): FollowedMarket => ({
        venue: DEFAULT_TRADING_VENUE,
        asset: row.market,
        reason: "position",
      }),
    );
  }).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<FollowedMarket>));

  const fromWatches = Effect.gen(function* () {
    const rows = yield* sql<{ readonly watch_json: string }>`
      SELECT watch_json FROM trading_watches WHERE status = 'active'
    `;
    const markets: Array<FollowedMarket> = [];
    for (const row of rows) {
      const asset = watchMarket(row.watch_json);
      if (asset !== null) markets.push({ venue: DEFAULT_TRADING_VENUE, asset, reason: "watch" });
    }
    return markets;
  }).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<FollowedMarket>));

  /**
   * Watchlist rows, once the watchlist exists.
   *
   * Reading a table that may not be there is deliberate rather than sloppy: the
   * registry lands before the watchlist migration, and a registry that refuses
   * to answer until then would hold up the archiver work that needs it.
   */
  const fromWatchlist = Effect.gen(function* () {
    const rows = yield* sql<{ readonly venue: string; readonly asset: string }>`
      SELECT venue, asset FROM trading_watchlist ORDER BY position ASC
    `;
    return rows.map(
      (row): FollowedMarket => ({
        venue: row.venue as TradingVenue,
        asset: row.asset,
        reason: "watchlist",
      }),
    );
  }).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<FollowedMarket>));

  const fromCharts = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const opens = yield* Ref.get(charted);
    const fresh: Array<FollowedMarket> = [];
    for (const [key, openedAt] of opens) {
      if (now - openedAt > CHART_DECAY_MS) continue;
      const separator = key.indexOf(":");
      fresh.push({
        venue: key.slice(0, separator) as TradingVenue,
        asset: key.slice(separator + 1),
        reason: "chart",
      });
    }
    return fresh;
  });

  const list: FollowSetRegistryShape["list"] = Effect.gen(function* () {
    const [positions, watches, watchlist, charts] = yield* Effect.all(
      [fromPositions, fromWatches, fromWatchlist, fromCharts],
      { concurrency: "unbounded" },
    );
    return foldFollowSet([...positions, ...watches, ...watchlist, ...charts]);
  });

  const noteChartOpened: FollowSetRegistryShape["noteChartOpened"] = (ref) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      yield* Ref.update(charted, (opens) => {
        const next = new Map(opens);
        next.set(`${ref.venue}:${ref.asset}`, now);
        return next;
      });
    });

  /**
   * Write the set where the archiver will find it.
   *
   * Written to a sibling and renamed, so a child reading mid-write gets the
   * old file rather than half of the new one.
   */
  const publish = Effect.gen(function* () {
    const followed = yield* list;
    const path = followSetControlPath();
    const payload = encodeControlFile({
      followed: followed.map(({ venue, asset }) => ({ venue, asset })),
    });
    yield* Effect.sync(() => {
      NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
      const staging = `${path}.tmp`;
      NodeFS.writeFileSync(staging, payload);
      NodeFS.renameSync(staging, path);
    });
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("FollowSetRegistry: could not publish the follow set", {
        cause: String(cause),
      }),
    ),
  );

  const start: FollowSetRegistryShape["start"] = () =>
    Effect.forkScoped(
      Effect.gen(function* () {
        while (true) {
          yield* publish;
          yield* Effect.sleep(PUBLISH_INTERVAL_MS);
        }
      }),
    ).pipe(Effect.asVoid);

  return { list, noteChartOpened, start } satisfies FollowSetRegistryShape;
});

export const FollowSetRegistryLive: Layer.Layer<FollowSetRegistry, never, SqlClient.SqlClient> =
  Layer.effect(FollowSetRegistry, make);
