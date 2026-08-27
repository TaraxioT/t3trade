/**
 * TradingThreadMarketService — which market a chat thread is about.
 *
 * One row per thread. Three things write it: the trade home seeding a fresh
 * thread from "Trade in chat", the agent's own `trading_look` resolving a
 * market, and a thread taking trading authority on one. The client reads it to
 * decide which market's chart, position and alerts sit beside the conversation.
 *
 * It records attention, never authority. Nothing downstream reads this table to
 * decide what an agent may trade — that is `trading_missions` and its per-market
 * exclusivity check — so a wrong row here costs a wrong panel and nothing else.
 *
 * `record` is a no-op when the market has not changed, and that is load-bearing:
 * it is called on every look, and the doorbell it rings would otherwise make
 * every mounted client refetch its whole trade home once per agent read.
 *
 * SQL-only, like `TradingAnalystService`: asset validation lives with the
 * callers that already hold the gateway.
 *
 * @module TradingThreadMarketService
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError, type PersistenceSqlError } from "../persistence/Errors.ts";
import { TradingAccountProjection } from "./TradingAccountProjection.ts";
import { DEFAULT_TRADING_VENUE } from "./Schemas.ts";

/** Why a market landed on a thread. Mirrors `TradingThreadMarketSource`. */
export type ThreadMarketSource = "seeded" | "look" | "bound";

export interface ThreadMarketFocus {
  readonly threadId: string;
  readonly venue: string;
  readonly asset: string;
  readonly source: ThreadMarketSource;
  readonly updatedAt: number;
}

export interface TradingThreadMarketServiceShape {
  /**
   * Put `asset` on `threadId`, unless it is already there.
   *
   * Returns the row as it now stands. An unchanged market writes nothing and
   * rings nothing, so the hot path (one call per `trading_look`) is one read.
   */
  readonly record: (input: {
    readonly threadId: string;
    readonly asset: string;
    readonly source: ThreadMarketSource;
  }) => Effect.Effect<ThreadMarketFocus, PersistenceSqlError>;

  /** The thread's market, or null for every thread that never had one. */
  readonly read: (threadId: string) => Effect.Effect<ThreadMarketFocus | null, PersistenceSqlError>;
}

export class TradingThreadMarketService extends Context.Service<
  TradingThreadMarketService,
  TradingThreadMarketServiceShape
>()("t3/trading/TradingThreadMarketService") {}

const sqlFail = (operation: string) =>
  toPersistenceSqlError(`TradingThreadMarketService.${operation}`);

interface FocusRow {
  readonly thread_id: string;
  readonly venue: string;
  readonly asset: string;
  readonly source: string;
  readonly updated_at: number;
}

const toFocus = (row: FocusRow): ThreadMarketFocus => ({
  threadId: row.thread_id,
  venue: row.venue,
  asset: row.asset,
  source: (row.source === "seeded" || row.source === "bound"
    ? row.source
    : "look") as ThreadMarketSource,
  updatedAt: row.updated_at,
});

const makeTradingThreadMarketService = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projection = yield* TradingAccountProjection;

  const read: TradingThreadMarketServiceShape["read"] = (threadId) =>
    sql<FocusRow>`
      SELECT thread_id, venue, asset, source, updated_at
      FROM trading_thread_market_focus
      WHERE thread_id = ${threadId}
    `.pipe(
      Effect.mapError(sqlFail("read")),
      Effect.map((rows) => {
        const row = rows[0];
        return row === undefined ? null : toFocus(row);
      }),
    );

  const record: TradingThreadMarketServiceShape["record"] = (input) =>
    Effect.gen(function* () {
      const existing = yield* read(input.threadId);
      if (existing !== null && existing.asset === input.asset) return existing;

      const now = yield* Clock.currentTimeMillis;
      yield* sql`
        INSERT INTO trading_thread_market_focus (thread_id, venue, asset, source, updated_at)
        VALUES (${input.threadId}, ${DEFAULT_TRADING_VENUE}, ${input.asset}, ${input.source}, ${now})
        ON CONFLICT (thread_id) DO UPDATE SET
          venue = excluded.venue,
          asset = excluded.asset,
          source = excluded.source,
          updated_at = excluded.updated_at
      `.pipe(Effect.mapError(sqlFail("record")));

      // The doorbell is how the companion panel appears without a poll. Rung
      // only on a real change, so an agent looking at the same market on every
      // wake costs no client refetches at all.
      yield* projection.invalidate({ reason: "thread-market-focus" });

      return {
        threadId: input.threadId,
        venue: DEFAULT_TRADING_VENUE,
        asset: input.asset,
        source: input.source,
        updatedAt: now,
      };
    });

  return { record, read } satisfies TradingThreadMarketServiceShape;
});

export const TradingThreadMarketServiceLive = Layer.effect(
  TradingThreadMarketService,
  makeTradingThreadMarketService,
);
