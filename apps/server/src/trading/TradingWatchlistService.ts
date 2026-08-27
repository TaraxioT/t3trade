/**
 * TradingWatchlistService — the user-ordered list of markets on the trade home
 * (final-form Phase 4).
 *
 * A row is a `{venue, asset}` pair and a position; nothing else. The follow-set
 * registry reads the table directly on every recompute (no cache to
 * invalidate), so adding a market here starts recording it within one publish
 * tick. Adds are validated through the gateway's market resolver — D1 says the
 * live universe is the validator, not a schema.
 *
 * @module TradingWatchlistService
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { HyperliquidGateway } from "@t3tools/hyperliquid/Gateway";

import { toPersistenceSqlError, type PersistenceSqlError } from "../persistence/Errors.ts";
import type { MarketRef, TradingVenue } from "./Schemas.ts";
import { TradingAccountProjection } from "./TradingAccountProjection.ts";

export interface WatchlistEntry {
  readonly market: MarketRef;
  readonly addedAt: number;
  readonly position: number;
}

export type WatchlistMutationResult =
  | { readonly outcome: "ok"; readonly entries: ReadonlyArray<WatchlistEntry> }
  | { readonly outcome: "rejected"; readonly reason: string };

export interface TradingWatchlistServiceShape {
  /** Append a market to the end of the list. Adding a present one is a no-op. */
  readonly add: (market: MarketRef) => Effect.Effect<WatchlistMutationResult, PersistenceSqlError>;

  /** Remove a market. Removing an absent one is a no-op, not an error. */
  readonly remove: (
    market: MarketRef,
  ) => Effect.Effect<WatchlistMutationResult, PersistenceSqlError>;

  /** The list, in the user's order. */
  readonly list: Effect.Effect<ReadonlyArray<WatchlistEntry>, PersistenceSqlError>;
}

export class TradingWatchlistService extends Context.Service<
  TradingWatchlistService,
  TradingWatchlistServiceShape
>()("t3/trading/TradingWatchlistService") {}

const sqlFail = (operation: string) =>
  toPersistenceSqlError(`TradingWatchlistService.${operation}`);

const makeTradingWatchlistService = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const gateway = yield* HyperliquidGateway;
  const projection = yield* TradingAccountProjection;

  const list: TradingWatchlistServiceShape["list"] = Effect.gen(function* () {
    const rows = yield* sql<{
      readonly venue: string;
      readonly asset: string;
      readonly added_at: number;
      readonly position: number;
    }>`
      SELECT venue, asset, added_at, position FROM trading_watchlist
      ORDER BY position ASC, asset ASC
    `.pipe(Effect.mapError(sqlFail("list")));
    return rows.map(
      (row): WatchlistEntry => ({
        market: { venue: row.venue as TradingVenue, asset: row.asset },
        addedAt: row.added_at,
        position: row.position,
      }),
    );
  });

  const add: TradingWatchlistServiceShape["add"] = (market) =>
    Effect.gen(function* () {
      const resolved = yield* gateway.resolveMarket(market.asset).pipe(
        Effect.map((entry) => (entry.available ? "ok" : "unavailable")),
        Effect.catchCause(() => Effect.succeed("unknown" as const)),
      );
      if (resolved !== "ok") {
        return {
          outcome: "rejected",
          reason:
            resolved === "unavailable"
              ? `${market.asset} is not accepting new positions`
              : `${market.asset} is not a market the venue lists`,
        } satisfies WatchlistMutationResult;
      }

      const now = yield* Clock.currentTimeMillis;
      yield* sql`
        INSERT INTO trading_watchlist (venue, asset, added_at, position)
        VALUES (
          ${market.venue}, ${market.asset}, ${now},
          (SELECT COALESCE(MAX(position), 0) + 1 FROM trading_watchlist)
        )
        ON CONFLICT (venue, asset) DO NOTHING
      `.pipe(Effect.mapError(sqlFail("add")));

      yield* projection.invalidate({ reason: "watchlist_changed" });
      return { outcome: "ok", entries: yield* list } satisfies WatchlistMutationResult;
    });

  const remove: TradingWatchlistServiceShape["remove"] = (market) =>
    Effect.gen(function* () {
      yield* sql`
        DELETE FROM trading_watchlist
        WHERE venue = ${market.venue} AND asset = ${market.asset}
      `.pipe(Effect.mapError(sqlFail("remove")));
      yield* projection.invalidate({ reason: "watchlist_changed" });
      return { outcome: "ok", entries: yield* list } satisfies WatchlistMutationResult;
    });

  return { add, remove, list } satisfies TradingWatchlistServiceShape;
});

export const TradingWatchlistServiceLive = Layer.effect(
  TradingWatchlistService,
  makeTradingWatchlistService,
);
