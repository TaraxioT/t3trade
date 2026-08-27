/**
 * TradingAlertService — account-scoped watches and the alert feed
 * (final-form Phase 5).
 *
 * Watches stop being mission property here: a user with no mission arms a
 * `deliver: 'notify'` watch on any listed asset, the evaluator fires it into
 * `trading_alert_events`, and the account doorbell tells clients to refetch.
 * No inbox, no reactor, no harness — the wake path is untouched and belongs to
 * `TradingWatchService`.
 *
 * The arm path validates the asset through the gateway's market resolver (D1:
 * validation lives where the live universe lives) and restricts the condition
 * to the market-scoped kinds — a PnL line or a fill watch is a question about
 * a mission's position, and there is no mission here to ask it of.
 *
 * @module TradingAlertService
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { HyperliquidGateway } from "@t3tools/hyperliquid/Gateway";
import { DEFAULT_TRADING_VENUE, type MarketRef, type TradingVenue } from "./Schemas.ts";
import { toPersistenceSqlError, type PersistenceSqlError } from "../persistence/Errors.ts";
import {
  isWatchRefusal,
  MarketWatch,
  toMarketWatch,
  toWatchCondition,
  TradingWatchDeliver,
  TradingWatchRearm,
  type PersistedWatchStatus,
  type WatchCondition,
} from "./Schemas.ts";
import { TradingAccountProjection } from "./TradingAccountProjection.ts";

const decodeWatchJson = Schema.decodeUnknownSync(Schema.fromJsonString(MarketWatch));
const encodeWatchJson = Schema.encodeUnknownSync(Schema.fromJsonString(MarketWatch));
const decodeRearmJson = Schema.decodeUnknownSync(Schema.fromJsonString(TradingWatchRearm));
const encodeRearmJson = Schema.encodeUnknownSync(Schema.fromJsonString(TradingWatchRearm));
/** Encode the opaque alert payload (`unknown`) to a JSON string for storage. */
const encodePayloadJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

/** The condition kinds an account-scoped watch may carry: market questions,
 * not position questions. */
const ACCOUNT_WATCH_KINDS: ReadonlySet<WatchCondition["kind"]> = new Set([
  "price",
  "metric",
  "derived",
  "time",
]);

export interface ArmAccountWatchInput {
  readonly condition: WatchCondition;
  /** Defaults to `'notify'`; `'wake'`/`'both'` need a mission and are refused. */
  readonly deliver?: TradingWatchDeliver | undefined;
  readonly rearm?: TradingWatchRearm | undefined;
  readonly accountId?: string | undefined;
}

/** One account-scoped watch as the RPCs serve it. */
export interface AccountWatch {
  readonly id: string;
  readonly market: MarketRef;
  readonly condition: WatchCondition;
  readonly deliver: TradingWatchDeliver;
  readonly rearm?: TradingWatchRearm;
  readonly status: PersistedWatchStatus;
  readonly accountId: string | null;
  readonly lastObservedValue?: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type ArmAccountWatchResult =
  | { readonly outcome: "armed"; readonly watch: AccountWatch }
  | { readonly outcome: "rejected"; readonly reason: string };

/** One appended alert, as the evaluator hands it over. */
export interface AlertAppendInput {
  readonly venue: TradingVenue;
  readonly asset: string;
  readonly accountId: string | null;
  readonly watchId: string;
  readonly firedAt: number;
  readonly summary: string;
  readonly payload: unknown;
}

export interface AlertEvent {
  readonly id: string;
  readonly market: MarketRef;
  readonly accountId: string | null;
  readonly watchId: string;
  readonly firedAt: number;
  readonly summary: string;
}

export interface TradingAlertServiceShape {
  /** Arm an account-scoped watch — no mission anywhere near it. */
  readonly armWatch: (
    input: ArmAccountWatchInput,
  ) => Effect.Effect<ArmAccountWatchResult, PersistenceSqlError>;

  /**
   * Cancel an active account-scoped watch. Mission watches are not reachable
   * from here — their lifecycle belongs to `TradingWatchService`. Returns
   * false when nothing active matched.
   */
  readonly cancelWatch: (watchId: string) => Effect.Effect<boolean, PersistenceSqlError>;

  /** Every account-scoped watch, newest first. */
  readonly listWatches: Effect.Effect<ReadonlyArray<AccountWatch>, PersistenceSqlError>;

  /**
   * Append one fired alert and ring the account doorbell. Append-only: the
   * feed is history, and a repeat watch appends one row per firing.
   */
  readonly append: (input: AlertAppendInput) => Effect.Effect<void, PersistenceSqlError>;

  /** Recent alerts, newest first. `limit` is clamped to [1, 200]. */
  readonly listAlerts: (input: {
    readonly limit?: number;
  }) => Effect.Effect<ReadonlyArray<AlertEvent>, PersistenceSqlError>;
}

export class TradingAlertService extends Context.Service<
  TradingAlertService,
  TradingAlertServiceShape
>()("t3/trading/TradingAlertService") {}

const DEFAULT_ALERT_LIMIT = 50;
const MAX_ALERT_LIMIT = 200;

const sqlFail = (operation: string) => toPersistenceSqlError(`TradingAlertService.${operation}`);

interface AccountWatchRow {
  readonly watch_id: string;
  readonly watch_json: string;
  readonly status: string;
  readonly venue: string;
  readonly asset: string | null;
  readonly account_id: string | null;
  readonly deliver: string;
  readonly rearm_json: string | null;
  readonly last_observed_value: number | null;
  readonly created_at: number;
  readonly updated_at: number;
}

const toAccountWatch = (row: AccountWatchRow): AccountWatch => {
  const watch = decodeWatchJson(row.watch_json);
  const condition = toWatchCondition(watch);
  const rearm = row.rearm_json === null ? undefined : decodeRearmJson(row.rearm_json);
  return {
    id: row.watch_id,
    market: {
      venue: row.venue as TradingVenue,
      asset: row.asset ?? ("market" in watch ? watch.market : ""),
    },
    condition,
    deliver: row.deliver as TradingWatchDeliver,
    ...(rearm === undefined ? {} : { rearm }),
    status: row.status as PersistedWatchStatus,
    accountId: row.account_id,
    ...(row.last_observed_value === null ? {} : { lastObservedValue: row.last_observed_value }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

const makeTradingAlertService = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const gateway = yield* HyperliquidGateway;
  const projection = yield* TradingAccountProjection;

  const armWatch: TradingAlertServiceShape["armWatch"] = (input) =>
    Effect.gen(function* () {
      const rejected = (reason: string): ArmAccountWatchResult => ({
        outcome: "rejected",
        reason,
      });

      const deliver = input.deliver ?? "notify";
      if (deliver !== "notify") {
        // A wake is a turn of harness attention on a mission thread; with no
        // mission there is nothing to wake.
        return rejected("an account-scoped watch delivers 'notify'; a wake needs a mission");
      }
      if (!ACCOUNT_WATCH_KINDS.has(input.condition.kind)) {
        return rejected(
          `a '${input.condition.kind}' condition needs a mission position; ` +
            "account alerts take price, metric, derived, or time",
        );
      }

      const encoded = toMarketWatch(input.condition);
      if (isWatchRefusal(encoded)) {
        return rejected(`${encoded.code}: ${encoded.detail}`);
      }

      // A time watch has no market to validate; everything else is checked
      // against the live universe, where D1 says validation lives.
      const asset = "market" in encoded ? encoded.market : null;
      if (asset !== null) {
        const resolved = yield* gateway.resolveMarket(asset).pipe(
          Effect.map((market) => (market.available ? "ok" : "unavailable")),
          Effect.catchCause(() => Effect.succeed("unknown" as const)),
        );
        if (resolved !== "ok") {
          return rejected(
            resolved === "unavailable"
              ? `${asset} is not accepting new positions`
              : `${asset} is not a market the venue lists`,
          );
        }
      }

      const now = yield* Clock.currentTimeMillis;
      const watchId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      const rearmJson =
        input.rearm === undefined || input.rearm.mode === "once"
          ? null
          : encodeRearmJson(input.rearm);

      yield* sql`
        INSERT INTO trading_watches (
          watch_id, mission_id, watch_json, status, version, created_at,
          updated_at, venue, asset, account_id, deliver, rearm_json
        ) VALUES (
          ${watchId}, NULL, ${encodeWatchJson(encoded)}, 'active', 1, ${now},
          ${now}, ${DEFAULT_TRADING_VENUE}, ${asset}, ${input.accountId ?? null},
          ${deliver}, ${rearmJson}
        )
      `.pipe(Effect.mapError(sqlFail("armWatch")));

      yield* projection.invalidate({ reason: "watch_armed" });

      return {
        outcome: "armed",
        watch: {
          id: watchId,
          market: { venue: DEFAULT_TRADING_VENUE, asset: asset ?? "" },
          condition: input.condition,
          deliver,
          ...(input.rearm === undefined ? {} : { rearm: input.rearm }),
          status: "active",
          accountId: input.accountId ?? null,
          createdAt: now,
          updatedAt: now,
        },
      } satisfies ArmAccountWatchResult;
    });

  const cancelWatch: TradingAlertServiceShape["cancelWatch"] = (watchId) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const rows = yield* sql<{ readonly watch_id: string }>`
        UPDATE trading_watches
        SET status = 'cancelled', version = version + 1, updated_at = ${now}
        WHERE watch_id = ${watchId} AND mission_id IS NULL AND status = 'active'
        RETURNING watch_id
      `.pipe(Effect.mapError(sqlFail("cancelWatch")));
      const cancelled = rows.length > 0;
      if (cancelled) yield* projection.invalidate({ reason: "watch_cancelled" });
      return cancelled;
    });

  const listWatches: TradingAlertServiceShape["listWatches"] = Effect.gen(function* () {
    const rows = yield* sql<AccountWatchRow>`
      SELECT watch_id, watch_json, status, venue, asset, account_id, deliver,
             rearm_json, last_observed_value, created_at, updated_at
      FROM trading_watches
      WHERE mission_id IS NULL
      ORDER BY created_at DESC
      LIMIT 200
    `.pipe(Effect.mapError(sqlFail("listWatches")));
    return rows.map(toAccountWatch);
  });

  const append: TradingAlertServiceShape["append"] = (input) =>
    Effect.gen(function* () {
      const eventId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      yield* sql`
        INSERT INTO trading_alert_events (
          event_id, venue, asset, account_id, watch_id, fired_at, summary,
          payload_json
        ) VALUES (
          ${eventId}, ${input.venue}, ${input.asset}, ${input.accountId},
          ${input.watchId}, ${input.firedAt}, ${input.summary},
          ${encodePayloadJson(input.payload ?? null)}
        )
      `.pipe(Effect.mapError(sqlFail("append")));
      // The same doorbell the fills ring: the event carries no data, the
      // refetch is the truth.
      yield* projection.invalidate({ reason: "alert_fired" });
    });

  const listAlerts: TradingAlertServiceShape["listAlerts"] = (input) =>
    Effect.gen(function* () {
      const limit = Math.min(Math.max(input.limit ?? DEFAULT_ALERT_LIMIT, 1), MAX_ALERT_LIMIT);
      const rows = yield* sql<{
        readonly event_id: string;
        readonly venue: string;
        readonly asset: string;
        readonly account_id: string | null;
        readonly watch_id: string;
        readonly fired_at: number;
        readonly summary: string;
      }>`
        SELECT event_id, venue, asset, account_id, watch_id, fired_at, summary
        FROM trading_alert_events
        ORDER BY fired_at DESC, event_id DESC
        LIMIT ${limit}
      `.pipe(Effect.mapError(sqlFail("listAlerts")));
      return rows.map(
        (row): AlertEvent => ({
          id: row.event_id,
          market: { venue: row.venue as TradingVenue, asset: row.asset },
          accountId: row.account_id,
          watchId: row.watch_id,
          firedAt: row.fired_at,
          summary: row.summary,
        }),
      );
    });

  return {
    armWatch,
    cancelWatch,
    listWatches,
    append,
    listAlerts,
  } satisfies TradingAlertServiceShape;
});

export const TradingAlertServiceLive = Layer.effect(TradingAlertService, makeTradingAlertService);
