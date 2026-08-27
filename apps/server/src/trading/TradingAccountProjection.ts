/**
 * The account read model — trading state addressed by account and market
 * (final-form Phase 3), and the invalidation bus that tells clients to
 * refetch it.
 *
 * Derived on read, deliberately: there is no `projection_trading_account`
 * table. The reconciled migration-038 tables are already the truth the
 * mission projection reads, so this service only re-addresses them — one
 * account row per `trading_account_id`, positions and open orders joined to
 * the mission that owns them, provenance and authority labeled per D4/D5.
 *
 * The push half is in-process only: `invalidate` publishes a doorbell event,
 * `changes` is the stream a WS subscription serves. The event carries no
 * data — the view is derived on read, so the refetch is the truth and the
 * event only says "now is a good time".
 *
 * @module TradingAccountProjection
 */
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { TradingMissionId } from "@t3tools/contracts";
import type {
  TradingAccountOpenOrder,
  TradingAccountPosition,
  TradingAccountState,
  TradingAccountStreamEvent,
} from "@t3tools/contracts";
import { DEFAULT_TRADING_VENUE, marketRef } from "@t3tools/trading-contracts";

import { toPersistenceSqlError, type PersistenceSqlError } from "../persistence/Errors.ts";

/**
 * The accounts half of `TradingAccountView`. The WS handler adds the
 * `snapshotSequence` and archiver health riders, exactly as the mission
 * snapshot handler does — they are engine/supervisor facts, not table facts.
 */
export interface TradingAccountAssembly {
  readonly accounts: ReadonlyArray<TradingAccountState>;
  readonly updatedAt: string;
}

export interface TradingAccountProjectionShape {
  /** Assemble the account view from the reconciled tables, fresh per read. */
  readonly view: () => Effect.Effect<TradingAccountAssembly, PersistenceSqlError>;

  /**
   * Announce that something the view derives from changed. Callers are the
   * trading projector (orchestration events) and the reconciler (fills,
   * position and order convergence).
   */
  readonly invalidate: (input: { readonly reason: string }) => Effect.Effect<void>;

  /** Every invalidation published after subscription. One doorbell per change. */
  readonly changes: Stream.Stream<TradingAccountStreamEvent>;
}

export class TradingAccountProjection extends Context.Service<
  TradingAccountProjection,
  TradingAccountProjectionShape
>()("t3/trading/TradingAccountProjection") {}

const toIso = (epochMillis: number): string => DateTime.formatIso(DateTime.makeUnsafe(epochMillis));

const EPOCH_ISO = "1970-01-01T00:00:00.000Z";

interface PositionRow {
  readonly mission_id: string | null;
  readonly trading_account_id: string;
  readonly market: string;
  readonly size: number;
  readonly entry_price: number | null;
  readonly unrealised_pnl: number;
  readonly margin_used: number;
  readonly protected_size: number;
  readonly liquidation_price: number | null;
  readonly mark_px: number | null;
  readonly observed_at: number;
}

interface OpenOrderRow {
  readonly mission_id: string | null;
  readonly trading_account_id: string;
  readonly cloid: string;
  readonly order_id: number;
  readonly market: string;
  readonly side: string;
  readonly limit_price: number;
  readonly remaining_size: number;
  readonly reduce_only: number;
  readonly observed_at: number;
}

interface BalanceRow {
  readonly trading_account_id: string;
  readonly account_value: number;
  readonly observed_at: number;
}

interface AccountIdRow {
  readonly trading_account_id: string;
}

const toPosition = (row: PositionRow): TradingAccountPosition => ({
  market: marketRef(row.market),
  size: row.size,
  entryPrice: row.entry_price ?? undefined,
  markPrice: row.mark_px ?? undefined,
  unrealisedPnl: row.unrealised_pnl,
  marginUsed: row.margin_used,
  protectedSize: row.protected_size,
  // D5: everything that protects today is a trigger order resting on the
  // exchange; the server-executed arm exists in the schema for the day a
  // watcher-enforced stop ships. Null when nothing protects.
  protection: row.protected_size > 0 ? "resting_on_exchange" : null,
  // D4: a NULL mission is the user's own hand (Phase 7's manual authority).
  authority:
    row.mission_id === null
      ? { kind: "manual" }
      : { kind: "mission", missionId: TradingMissionId.make(row.mission_id) },
  liquidationPrice: row.liquidation_price ?? undefined,
  observedAt: toIso(row.observed_at),
});

const toOpenOrder = (row: OpenOrderRow): TradingAccountOpenOrder => ({
  market: marketRef(row.market),
  cloid: row.cloid,
  orderId: row.order_id,
  side: row.side === "buy" ? "buy" : "sell",
  limitPrice: row.limit_price,
  remainingSize: row.remaining_size,
  reduceOnly: row.reduce_only !== 0,
  authority:
    row.mission_id === null
      ? { kind: "manual" }
      : { kind: "mission", missionId: TradingMissionId.make(row.mission_id) },
  observedAt: toIso(row.observed_at),
});

const makeTradingAccountProjection = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const pubsub = yield* PubSub.unbounded<TradingAccountStreamEvent>();
  const revision = yield* Ref.make(0);

  const sqlFail = (operation: string) =>
    toPersistenceSqlError(`TradingAccountProjection.${operation}`);

  const view: TradingAccountProjectionShape["view"] = () =>
    Effect.gen(function* () {
      // Every account row that exists, plus any account a mission ever named:
      // a manual-only account must not vanish from its own home screen, and a
      // pre-bootstrap database still surfaces its historic mission accounts.
      const accountIds = yield* sql<AccountIdRow>`
        SELECT account_id AS trading_account_id FROM trading_accounts
        UNION
        SELECT DISTINCT trading_account_id FROM trading_missions
        ORDER BY trading_account_id
      `.pipe(Effect.mapError(sqlFail("accounts")));

      // Since 075 the rows carry their own account_id, so a manual row
      // (mission_id NULL) is read exactly like a mission's — the old JOIN to
      // trading_missions silently dropped it.
      const positions = yield* sql<PositionRow>`
        SELECT p.mission_id, p.account_id AS trading_account_id, p.market, p.size,
               p.entry_price, p.unrealised_pnl, p.margin_used, p.protected_size,
               p.liquidation_price, p.mark_px, p.observed_at
        FROM trading_position_snapshots p
        WHERE p.size != 0
        ORDER BY p.observed_at DESC
      `.pipe(Effect.mapError(sqlFail("positions")));

      const openOrders = yield* sql<OpenOrderRow>`
        SELECT o.mission_id, o.account_id AS trading_account_id, o.cloid, o.order_id,
               o.market, o.side, o.limit_price, o.remaining_size, o.reduce_only,
               o.observed_at
        FROM trading_orders o
        ORDER BY o.observed_at DESC
      `.pipe(Effect.mapError(sqlFail("orders")));

      // Latest reconciled account value per account. The observations table is
      // mission-keyed (one row per mission, overwritten per pass), so the
      // account's balance is its most recently observed mission's row.
      const balances = yield* sql<BalanceRow>`
        SELECT m.trading_account_id, a.account_value, a.observed_at
        FROM trading_account_observations a
        JOIN trading_missions m ON m.mission_id = a.mission_id
        ORDER BY a.observed_at DESC
      `.pipe(Effect.mapError(sqlFail("balances")));

      const latestBalance = new Map<string, BalanceRow>();
      for (const row of balances) {
        if (!latestBalance.has(row.trading_account_id)) {
          latestBalance.set(row.trading_account_id, row);
        }
      }

      let latestObservedAt = 0;
      for (const row of [...positions, ...openOrders, ...balances]) {
        if (row.observed_at > latestObservedAt) latestObservedAt = row.observed_at;
      }

      const accounts = accountIds.map(({ trading_account_id }): TradingAccountState => {
        const balance = latestBalance.get(trading_account_id);
        return {
          accountId: trading_account_id,
          venue: DEFAULT_TRADING_VENUE,
          balanceUsd: balance?.account_value ?? null,
          // Not persisted by any reconciled table today; null is the honest
          // answer until a reconcile pass starts writing it.
          withdrawableUsd: null,
          balanceObservedAt: balance === undefined ? null : toIso(balance.observed_at),
          positions: positions
            .filter((p) => p.trading_account_id === trading_account_id)
            .map(toPosition),
          openOrders: openOrders
            .filter((o) => o.trading_account_id === trading_account_id)
            .map(toOpenOrder),
        };
      });

      return {
        accounts,
        updatedAt: latestObservedAt === 0 ? EPOCH_ISO : toIso(latestObservedAt),
      } satisfies TradingAccountAssembly;
    });

  const invalidate: TradingAccountProjectionShape["invalidate"] = (_input) =>
    Effect.gen(function* () {
      const next = yield* Ref.updateAndGet(revision, (value) => value + 1);
      const occurredAt = DateTime.formatIso(yield* DateTime.now);
      const event: TradingAccountStreamEvent = {
        kind: "invalidated",
        revision: next,
        occurredAt,
      };
      yield* PubSub.publish(pubsub, event);
    });

  return {
    view,
    invalidate,
    get changes() {
      return Stream.fromPubSub(pubsub);
    },
  } satisfies TradingAccountProjectionShape;
});

export const TradingAccountProjectionLive = Layer.effect(
  TradingAccountProjection,
  makeTradingAccountProjection,
);
