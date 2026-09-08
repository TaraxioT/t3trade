/**
 * WatchEvaluator - evaluates persisted watches against live market data, spec §12.1.
 *
 * Two entry points feed it:
 *  - WS candle deliveries (one subscription per direct interval, §13) drive the
 *    `candle_close` watches.
 *  - A slow periodic sweep drives the `price_cross` watches (fresh BBO/mark via
 *    the gateway, whose §13 freshness windows apply) and fires
 *    `scheduled_reassessment` watches whose `runAt` has passed.
 *
 * On a match it flips the watch `active → triggered`, persists an inbox event
 * keyed for deduplication, and announces the firing on the orchestration stream
 * — the `TradingMissionReactor` turns that announcement into a
 * `TradingTurnCoordinator.requestRun`.
 *
 * "Fires exactly once" rests on two guards, both durable:
 *  - `markTriggered` only flips an `active` watch (atomic UPDATE), so a
 *    concurrent replay, supersede, or cancel drops the firing.
 *  - The inbox deduplication key is scoped per watch (`type:watchId:...`), so a
 *    replay after a restart cannot generate a second wake-up.
 *
 * The evaluator never starts a run itself; the turn coordinator owns the lease
 * and the wake path. A watch firing does not authorize a position (§12.4).
 *
 * @module WatchEvaluator
 */
import type { ThreadId } from "@t3tools/contracts";
import { CommandId, TradingMissionId } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { HyperliquidGateway } from "@t3tools/hyperliquid/Gateway";
import type {
  AgentAccountSnapshot,
  AgentNetPosition,
} from "@t3tools/trading-contracts/account-snapshot";
import type { AgentMarketSnapshot } from "@t3tools/trading-contracts/market";
import { unpaidExitFeeUsd } from "@t3tools/trading-contracts/costs";
import {
  describeValidationEvents,
  forwardEndSummary,
  type ValidationEventBatch,
} from "@t3tools/trading-contracts/forward";
import type { BarInterval, DerivedMetricParams } from "@t3tools/trading-contracts/watch";
import { HyperliquidWebSocketClient, type WsDelivery } from "@t3tools/hyperliquid/WebSocketClient";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { toPersistenceSqlError, type PersistenceSqlError } from "../persistence/Errors.ts";
import { INTERVAL_MS } from "./archive/config.ts";
import { FollowSetRegistry } from "./FollowSetRegistry.ts";
import { isActiveMissionStatus } from "./MissionTransitions.ts";
import { DEFAULT_TRADING_VENUE } from "./Schemas.ts";
import type {
  MarketWatch,
  PersistedWatch,
  TradingMissionStatus,
  TradingVenue,
  TradingWatchDeliver,
  TradingWatchRearm,
} from "./Schemas.ts";
import { TradingTimeframe } from "./Schemas.ts";
import { TradingAlertService } from "./TradingAlertService.ts";
import { TradingMarketArchive } from "./TradingMarketArchive.ts";
import { TradingThesisValidationService } from "./TradingThesisValidationService.ts";
import { TradingEventInbox } from "./TradingEventInbox.ts";
import { recordLevelEvent } from "./TradingLevelHistory.ts";
import { TradingMissionService } from "./TradingMissionService.ts";
import { TradingRuntimeLease } from "./TradingRuntimeLease.ts";
import { VALIDATION_EVENT_KEY_PREFIX } from "./TradingWakeupComposer.ts";
import { TradingTurnCoordinator } from "./TradingTurnCoordinator.ts";
import { toPersistedWatch, TradingWatchService } from "./TradingWatchService.ts";

/**
 * How often the candle subscriptions are reconciled against the follow set.
 *
 * Matches the registry's own publish cadence: the archiver and the evaluator
 * learn about a newly followed market in the same beat. Arming a watch on a
 * new asset therefore starts delivery-driven evaluation within half a minute;
 * until then the slow sweep already covers everything price-shaped.
 */
const FOLLOW_SYNC_INTERVAL_MS = 30_000;

/**
 * The five §13 direct candle intervals. Subscribing to all of them keeps the
 * evaluator free of per-watch subscription management: a candle-close watch on
 * any direct interval is evaluated the moment its candle arrives.
 */
const DIRECT_INTERVALS = TradingTimeframe.literals;

/**
 * How often the sweep re-reads price-cross and scheduled watches. Matches the
 * §13 BBO freshness window so a price-cross is evaluated against data no older
 * than the gateway would serve anyway.
 */
const SWEEP_INTERVAL = "2 seconds";

export interface WatchEvaluatorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  /** Resolves when all in-flight evaluations have settled. For tests. */
  readonly drain: Effect.Effect<void>;
  /**
   * Evaluate a single WS delivery against the candle-close watches it could
   * match. This is what the forked stream consumers call per delivery;
   * exposing it lets tests drive evaluation synchronously (the
   * fires-exactly-once invariant) without racing a forked fiber.
   */
  readonly evaluateDelivery: (delivery: WsDelivery) => Effect.Effect<void, PersistenceSqlError>;
  /**
   * One pass of the periodic sweep: evaluate active price-cross watches against
   * a fresh gateway snapshot and fire due scheduled reassessments. The forked
   * sweep loop calls this on `SWEEP_INTERVAL`; exposed for tests.
   */
  readonly sweep: Effect.Effect<void, PersistenceSqlError>;
  /**
   * Forget the last candle seen per subscription, so the next delivery starts a
   * fresh rollover comparison. For tests, which share one long-lived evaluator
   * across cases and would otherwise see one case's candle finalised by the
   * next case's first delivery.
   */
  readonly forgetDeliveredCandles: Effect.Effect<void>;
}

export class WatchEvaluator extends Context.Service<WatchEvaluator, WatchEvaluatorShape>()(
  "t3/trading/WatchEvaluator",
) {}

/**
 * A watch the evaluator is tracking, with its delivery route and — when a
 * mission armed it — the mission and thread a wake announces on.
 *
 * `missionId`/`threadId` are null for an account-scoped alert (final-form
 * Phase 5): those deliver into the alert feed and never touch the inbox, the
 * orchestration stream, or a harness.
 */
export interface TrackedWatch {
  readonly watch: PersistedWatch;
  readonly deliver: TradingWatchDeliver;
  readonly rearm: TradingWatchRearm | null;
  readonly venue: TradingVenue;
  readonly asset: string | null;
  readonly accountId: string | null;
  readonly missionId: TradingMissionId | null;
  readonly threadId: ThreadId | null;
}

/** A firing the evaluator queued for processing. */
interface PendingFire {
  readonly tracked: TrackedWatch;
  readonly deduplicationKey: string;
  readonly summary: string;
  readonly payload: unknown;
}

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const nowMs = Clock.currentTimeMillis;

/** Read a numeric field off an unknown payload, tolerating string-encoded numbers. */
const num = (value: unknown): number | undefined => {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
};

/** Read a field off an unknown object payload. */
const field = (data: unknown, key: string): unknown => {
  if (typeof data !== "object" || data === null) return undefined;
  return (data as Record<string, unknown>)[key];
};

/** The thread a mission's harness binding names, or null on a malformed row. */
const harnessThreadId = (harnessJson: string | null): ThreadId | null => {
  if (harnessJson === null) return null;
  try {
    const threadId = field(JSON.parse(harnessJson), "threadId");
    return typeof threadId === "string" && threadId.length > 0 ? (threadId as ThreadId) : null;
  } catch {
    return null;
  }
};

/** The delivery route off the row; anything unrecognized reads as `wake`. */
const decodeDeliver = (value: string): TradingWatchDeliver =>
  value === "notify" || value === "both" ? value : "wake";

/** The re-arm rule off the row; null and anything malformed read as once. */
const decodeRearm = (rearmJson: string | null): TradingWatchRearm | null => {
  if (rearmJson === null) return null;
  try {
    const parsed: unknown = JSON.parse(rearmJson);
    const mode = field(parsed, "mode");
    if (mode === "once") return { mode: "once" };
    const cooldownMs = num(field(parsed, "cooldownMs"));
    if (mode === "repeat" && cooldownMs !== undefined && cooldownMs > 0) {
      return { mode: "repeat", cooldownMs };
    }
    return null;
  } catch {
    return null;
  }
};

/** One delivered candle, reduced to the fields finality, matching, and the
 * level ledger's wick test need. `high`/`low` may be absent on a malformed
 * frame; the wick test simply stays silent then. */
interface DeliveredCandle {
  readonly openTime: number;
  readonly closeTime: number;
  readonly close: number;
  readonly high?: number | undefined;
  readonly low?: number | undefined;
  /** Bar volume, when the frame carries it — the volume-ratio watches read it. */
  readonly volume?: number | undefined;
}

/**
 * The candle payload delivered over the WS `candle` channel is an array whose
 * first element carries `{t, T, s, i, o, c, h, l, v, n}` (per the wire schema).
 */
const candleFromDelivery = (delivery: WsDelivery): DeliveredCandle | undefined => {
  const data = delivery.data;
  const candle = Array.isArray(data) ? data[0] : data;
  const openTime = num(field(candle, "t"));
  const closeTime = num(field(candle, "T"));
  const close = num(field(candle, "c"));
  if (openTime === undefined || closeTime === undefined || close === undefined) return undefined;
  return {
    openTime,
    closeTime,
    close,
    high: num(field(candle, "h")),
    low: num(field(candle, "l")),
    volume: num(field(candle, "v")),
  };
};

/**
 * How long a validation wake waits behind an active run, and for how many
 * tries. Matched to the mission reactor's own queue retry: the constraint is
 * the same one - a single decision lease per mission - so the patience should
 * be too.
 */
const VALIDATION_QUEUE_RETRY_DELAY = "5 seconds";
const VALIDATION_QUEUE_RETRY_LIMIT = 60;

const make = Effect.gen(function* () {
  const ws = yield* HyperliquidWebSocketClient;
  const gateway = yield* HyperliquidGateway;
  const watches = yield* TradingWatchService;
  const missions = yield* TradingMissionService;
  const alerts = yield* TradingAlertService;
  const followSet = yield* FollowSetRegistry;
  const archive = yield* TradingMarketArchive;
  const validations = yield* TradingThesisValidationService;
  const inbox = yield* TradingEventInbox;
  // A validation event wakes its mission directly rather than through the
  // orchestration stream. The watch-fired route exists because a fired watch is
  // a domain event the projection draws; a paper fill on an idea nobody has
  // money on is not, and adding a second command type to five layers of wiring
  // to reach the same `requestRun` would be machinery for its own sake.
  const coordinator = yield* TradingTurnCoordinator;
  const engine = yield* OrchestrationEngineService;
  const crypto = yield* Crypto.Crypto;
  const sql = yield* SqlClient.SqlClient;
  // Stand-down: the lease flips `held` to false the moment its lock file stops
  // naming this process; the writers below check it before acting.
  const lease = yield* TradingRuntimeLease;

  const announceFired = Effect.fn("WatchEvaluator.announceFired")(function* (input: {
    readonly missionId: TradingMissionId;
    readonly threadId: ThreadId;
    readonly watchId: string;
    readonly deduplicationKey: string;
  }) {
    const commandId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    yield* engine.dispatch({
      type: "trading.mission.watch-fired",
      commandId: CommandId.make(commandId),
      threadId: input.threadId,
      missionId: input.missionId,
      watchId: input.watchId,
      deduplicationKey: input.deduplicationKey,
      createdAt: yield* nowIso,
    });
  });

  /**
   * Process a queued firing: flip the watch to `triggered`, then deliver.
   *
   * `markTriggered` is the authoritative single-fire guard — if a concurrent
   * supersede or cancel already moved the watch off `active`, this returns
   * `null` and the firing is dropped (nothing is persisted anywhere).
   *
   * Delivery branches on the watch's `deliver` route:
   * - `wake` (and the wake half of `both`): the original path, untouched —
   *   inbox event, orchestration announcement, harness wake. Single-fire.
   * - `notify` (and the notify half of `both`): one `trading_alert_events`
   *   row plus the account doorbell. No inbox, no reactor.
   *
   * Re-arm: a pure-notify watch with `rearm: repeat` flips back to `active`
   * with `next_evaluate_at` set `cooldownMs` ahead — the same due-time column
   * the derived cadence uses, so both sweep and delivery paths already know
   * to leave it alone until the cooldown passes. Anything with a wake half
   * stays single-fire.
   */
  const processFire = (fire: PendingFire) =>
    Effect.gen(function* () {
      const triggered = yield* watches.markTriggered(fire.tracked.watch.id);
      if (triggered === null) return;

      const tracked = fire.tracked;
      const occurredAt = yield* nowMs;

      const wake = tracked.deliver === "wake" || tracked.deliver === "both";
      if (wake && tracked.missionId !== null && tracked.threadId !== null) {
        yield* inbox.persist({
          missionId: tracked.missionId,
          category: tracked.watch.watch.type === "scheduled_reassessment" ? "timer" : "market",
          deduplicationKey: fire.deduplicationKey,
          payload: fire.payload,
          occurredAt,
          summary: fire.summary,
        });

        yield* announceFired({
          missionId: tracked.missionId,
          threadId: tracked.threadId,
          watchId: tracked.watch.id,
          deduplicationKey: fire.deduplicationKey,
        });
      }

      if (tracked.deliver === "notify" || tracked.deliver === "both") {
        const watch = tracked.watch.watch;
        yield* alerts.append({
          venue: tracked.venue,
          asset: tracked.asset ?? ("market" in watch ? watch.market : ""),
          accountId: tracked.accountId,
          watchId: tracked.watch.id,
          firedAt: occurredAt,
          summary: fire.summary,
          payload: fire.payload,
        });

        if (tracked.deliver === "notify" && tracked.rearm?.mode === "repeat") {
          // Durable re-arm: the row goes back to active with its cooldown
          // written as the due time, so a restart mid-cooldown still honours
          // it. Guarded on 'triggered' so a concurrent cancel wins.
          yield* sql`
            UPDATE trading_watches
            SET status = 'active', version = version + 1,
                next_evaluate_at = ${occurredAt + tracked.rearm.cooldownMs}
            WHERE watch_id = ${tracked.watch.id} AND status = 'triggered'
          `.pipe(Effect.orDie);
        }
      }
    });

  const worker = yield* makeDrainableWorker((fire: PendingFire) =>
    processFire(fire).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
        return Effect.logWarning("WatchEvaluator could not process a firing", {
          watchId: fire.tracked.watch.id,
          cause: Cause.pretty(cause),
        });
      }),
    ),
  );

  const enqueueFire = (
    tracked: TrackedWatch,
    dedupeKey: string,
    summary: string,
    payload: unknown,
  ) => worker.enqueue({ tracked, deduplicationKey: dedupeKey, summary, payload });

  /**
   * Every active watch, with its delivery route and — where a mission armed
   * it — that mission's thread binding, read in one join.
   *
   * This replaces the `findActiveMission("local")` read: watches are no
   * longer reached through THE active mission (there may be one per market
   * under D4, or none at all for an account alert). A mission-bound watch is
   * only tracked while its mission still holds an active status — the same
   * gate the old read applied — and a mission-less watch is always tracked.
   */
  const activeTrackedWatches = Effect.fn("WatchEvaluator.activeTrackedWatches")(function* () {
    const rows = yield* sql<{
      readonly watch_id: string;
      readonly mission_id: string | null;
      readonly watch_json: string;
      readonly status: string;
      readonly armed_reason: string | null;
      readonly created_at: number;
      readonly updated_at: number;
      readonly last_observed_value: number | null;
      readonly last_evaluated_at: number | null;
      readonly prediction_version: number | null;
      readonly next_evaluate_at: number | null;
      readonly venue: string;
      readonly asset: string | null;
      readonly account_id: string | null;
      readonly deliver: string;
      readonly rearm_json: string | null;
      readonly mission_status: string | null;
      readonly harness_json: string | null;
    }>`
      SELECT w.watch_id, w.mission_id, w.watch_json, w.status, w.armed_reason,
             w.created_at, w.updated_at, w.last_observed_value,
             w.last_evaluated_at, w.prediction_version, w.next_evaluate_at,
             w.venue, w.asset, w.account_id, w.deliver, w.rearm_json,
             m.status AS mission_status, m.harness_json
      FROM trading_watches w
      LEFT JOIN trading_missions m ON m.mission_id = w.mission_id
      WHERE w.status = 'active'
    `.pipe(Effect.mapError(toPersistenceSqlError("WatchEvaluator.activeTrackedWatches")));

    const tracked: Array<TrackedWatch> = [];
    for (const row of rows) {
      let threadId: ThreadId | null = null;
      if (row.mission_id !== null) {
        // A mission-bound watch on a mission that is gone or terminal is not
        // evaluated — the behaviour the active-mission read always had.
        if (
          row.mission_status === null ||
          !isActiveMissionStatus(row.mission_status as TradingMissionStatus)
        ) {
          continue;
        }
        threadId = harnessThreadId(row.harness_json);
      }
      tracked.push({
        watch: toPersistedWatch({
          watch_id: row.watch_id,
          mission_id: row.mission_id ?? "",
          watch_json: row.watch_json,
          status: row.status,
          armed_reason: row.armed_reason,
          created_at: row.created_at,
          updated_at: row.updated_at,
          last_observed_value: row.last_observed_value,
          last_evaluated_at: row.last_evaluated_at,
          prediction_version: row.prediction_version,
          next_evaluate_at: row.next_evaluate_at,
        }),
        deliver: decodeDeliver(row.deliver),
        rearm: decodeRearm(row.rearm_json),
        venue: row.venue as TradingVenue,
        asset: row.asset,
        accountId: row.account_id,
        missionId: row.mission_id === null ? null : (row.mission_id as TradingMissionId),
        threadId,
      });
    }
    return tracked as ReadonlyArray<TrackedWatch>;
  });

  /**
   * The last candle delivered per `coin:interval`, so a rollover is visible.
   *
   * In-memory and per-process on purpose: it holds one small record per
   * subscription and its only job is to compare consecutive deliveries. A
   * restart loses at most the candle in flight, and the next rollover restores
   * it.
   */
  const lastDelivered = new Map<string, DeliveredCandle>();

  /**
   * Finalized bar volumes per `coin:interval`, newest last, for the
   * `volume_ratio` metric watches.
   *
   * In-memory on the same terms as `lastDelivered`: it compares a bar against
   * the bars just before it, and a restart costs only the warm-up — the window
   * refills at one bar per interval, and a ratio is not computed until the
   * window holds `VOLUME_RATIO_MIN_PRIOR_BARS` priors again. Nothing durable
   * depends on it.
   */
  const recentVolumes = new Map<string, number[]>();
  const VOLUME_RATIO_WINDOW_BARS = 20;
  const VOLUME_RATIO_MIN_PRIOR_BARS = 5;

  /**
   * Which candle, if any, this delivery proves is final.
   *
   * The wall-clock test alone is not enough, and that is what stalled the wake
   * loop. Hyperliquid pushes a candle only when a trade updates it, so the last
   * delivery a candle ever receives lands *before* its close time — measured on
   * testnet ETH 1m, not one candle in a three-minute capture was ever delivered
   * again after its `T`. A watch armed on `1m` therefore waited for a message
   * that only arrives when a trade happens to land in the final milliseconds,
   * which is why runs woke every three to five minutes instead of every minute.
   *
   * A rollover is the proof that was missing: the exchange starting candle N+1
   * means it has stopped updating candle N, whatever the clock says. The
   * wall-clock test is kept as the second path, for a delivery that does land
   * after its own close.
   */
  const finalizedCandle = (
    previous: DeliveredCandle | undefined,
    current: DeliveredCandle,
  ): Effect.Effect<DeliveredCandle | undefined> =>
    Effect.gen(function* () {
      if (previous !== undefined && previous.openTime < current.openTime) return previous;
      const observedAt = yield* nowMs;
      return current.closeTime <= observedAt ? current : undefined;
    });

  /**
   * Evaluate a `candle_close` watch against a candle already known to be final.
   *
   * The predicate is a directional price comparison against the candle's close;
   * the dedupe key is scoped per watch and close so a replay cannot wake the
   * harness twice.
   */
  const evaluateCandleClose = (
    tracked: TrackedWatch,
    market: string,
    interval: string,
    candle: DeliveredCandle,
  ) =>
    Effect.gen(function* () {
      const watch = tracked.watch.watch;
      if (watch.type !== "candle_close") return;
      if (market !== watch.market) return;
      if (interval !== watch.interval) return;

      const matched =
        watch.direction === "above" ? candle.close >= watch.price : candle.close <= watch.price;

      // Level memory (plan 27 B1): a final candle either closed through the
      // armed level, wicked through it and closed back inside (the failed
      // break both playbooks turn on), or never reached it. The first two are
      // facts worth remembering at this level; recording them here is what
      // lets a later turn see "this boundary already broke twice".
      const wicked =
        watch.direction === "above"
          ? candle.high !== undefined && candle.high > watch.price
          : candle.low !== undefined && candle.low < watch.price;
      // Level memory is mission memory: an account alert has no mission whose
      // later turns would read it, so nothing is recorded for one.
      if ((matched || wicked) && tracked.missionId !== null) {
        yield* recordLevelEvent({
          missionId: tracked.missionId,
          market: watch.market,
          level: watch.price,
          kind: matched ? "closed_through" : "wick_rejected",
          price: candle.close,
          occurredAt: candle.closeTime,
        }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
      }
      if (!matched) return;

      yield* enqueueFire(
        tracked,
        `candle_close:${tracked.watch.id}:${candle.closeTime}`,
        `${watch.interval} candle closed ${candle.close} (${watch.direction} ${watch.price})`,
        { closeTime: candle.closeTime, close: candle.close, watchId: tracked.watch.id },
      );
    });

  /**
   * The venue reads one sweep pass is allowed to make, shared by every watch
   * in it.
   *
   * The sweep runs every two seconds over every armed watch, and each watch
   * used to do its own reads: a `metaAndAssetCtxs` plus an `l2Book` per
   * price-cross or metric watch, a `clearinghouseState` per PnL watch. Twenty
   * armed watches was sixty info calls every two seconds, which is what put
   * this server into the venue's rate limiter — and a 429 on the exit path is
   * what aborted a live close.
   *
   * One `metaAndAssetCtxs` and one `clearinghouseState` per sweep now serve
   * all of them, plus one book per distinct market. Null between sweeps, and
   * the delivery-driven path never has one: a WS delivery is not a sweep and
   * still reads live.
   */
  let sweepReads: {
    readonly snapshots: ReadonlyMap<string, AgentMarketSnapshot>;
    readonly accounts: ReadonlyMap<string, AgentAccountSnapshot>;
  } | null = null;

  /** The sweep's snapshot for `market`, or a live read outside a sweep. */
  const readMarketSnapshot = (market: string) => {
    const cached = sweepReads?.snapshots.get(market);
    return cached === undefined
      ? gateway.getMarketSnapshot(market).pipe(Effect.orDie)
      : Effect.succeed(cached);
  };

  /** The sweep's account read for `address`, or a live read outside a sweep. */
  const readAccountSnapshot = (address: `0x${string}`) => {
    const cached = sweepReads?.accounts.get(address);
    return cached === undefined
      ? gateway.getAccountSnapshot(address).pipe(Effect.orDie)
      : Effect.succeed(cached);
  };

  /**
   * Evaluate a `price_cross` watch against a fresh BBO/mark snapshot.
   *
   * Freshness is enforced by reading through the gateway (§13: BBO stale after
   * 2s, asset context 5s) rather than trusting a single WS tick.
   */
  const evaluatePriceCross = Effect.fn("WatchEvaluator.evaluatePriceCross")(function* (
    tracked: TrackedWatch,
  ) {
    const watch = tracked.watch.watch;
    if (watch.type !== "price_cross") return;

    const snapshot = yield* readMarketSnapshot(watch.market);
    const reference = watch.priceSource === "mark" ? snapshot.markPrice : snapshot.midPrice;

    const observedAt = yield* nowMs;
    yield* recordObservation(tracked.watch.id, reference, observedAt);

    const matched =
      watch.direction === "above" ? reference >= watch.price : reference <= watch.price;
    if (!matched) return;

    // Level memory (plan 27 B1): a price-cross firing is the market touching
    // the armed level. Recorded once — the fire consumes the watch — and only
    // for a mission, whose later turns are what read it.
    if (tracked.missionId !== null) {
      yield* recordLevelEvent({
        missionId: tracked.missionId,
        market: watch.market,
        level: watch.price,
        kind: "touched",
        price: reference,
        occurredAt: observedAt,
      }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
    }

    yield* enqueueFire(
      tracked,
      `price_cross:${tracked.watch.id}`,
      `${watch.priceSource} ${watch.market} crossed ${watch.direction} ${watch.price} (at ${reference})`,
      { reference, observedAt, watchId: tracked.watch.id },
    );
  });

  /**
   * Fire when the reconciled state a watch names has changed since the last
   * sweep. `signature` is the value being watched, reduced to a string: the
   * position's size and entry for `position_update`, the order's remaining size
   * for `order_update`, and `"gone"` when the row no longer exists.
   *
   * `position_update` and `order_update` are differential — they fire on a
   * *change*, so each needs a baseline. The first sweep that sees a watch
   * records the current value and fires nothing; a later sweep that reads
   * something different fires.
   *
   * The baseline lives on the watch row rather than in a process-local Map,
   * because a restart with a Map baseline swallows exactly the change the
   * harness most needs to hear about: the position that moved, or the order
   * that filled, while the server was down. The row is durable, so the first
   * real change after a restart still fires.
   */
  const fireOnChange = (tracked: TrackedWatch, signature: string, describe: () => string) =>
    Effect.gen(function* () {
      const key = tracked.watch.id;
      const rows = yield* sql<{ readonly baseline_signature: string | null }>`
        SELECT baseline_signature FROM trading_watches WHERE watch_id = ${key}
      `.pipe(Effect.orDie);
      const previous = rows[0]?.baseline_signature ?? null;
      if (previous === signature) return;

      yield* sql`
        UPDATE trading_watches SET baseline_signature = ${signature} WHERE watch_id = ${key}
      `.pipe(Effect.orDie);
      // The first observation is the baseline, not a change.
      if (previous === null) return;

      yield* enqueueFire(tracked, `${tracked.watch.watch.type}:${key}:${signature}`, describe(), {
        watchId: key,
        previous,
        current: signature,
      });
    });

  /**
   * How stale a stored `last_evaluated_at` may be before this sweep refreshes
   * it even when the value is unchanged. The sweep cadence is 2s; 5s keeps a
   * write from landing on every single tick when the number is static, while
   * still telling the checklist the watch is live.
   */
  const OBSERVATION_REFRESH_MILLIS = 5_000;

  /**
   * Carry the value a watch predicate is reading onto the watch row so the
   * workspace's conditions checklist can render the live number next to its
   * threshold, not just a ticked/empty checkbox.
   *
   * Called by the four numeric evaluators (`price_cross`, `pnl_above`,
   * `pnl_below`, `pnl_giveback`) on every sweep that computed a real observed
   * value, BEFORE the match-check / early-return — so a watch that has not
   * crossed still surfaces how close it is.
   *
   * Write-guarded: a write only lands when the value moved beyond an epsilon or
   * the stored timestamp is stale, so a static number does not hit SQLite on
   * every 2s tick. A sweep that could not read a real value (flat position,
   * gateway failure) must NOT call this — there is nothing true to record.
   */
  const recordObservation = (watchId: string, observedValue: number, observedAt: number) =>
    sql`
      UPDATE trading_watches
      SET last_observed_value = ${observedValue}, last_evaluated_at = ${observedAt}
      WHERE watch_id = ${watchId}
        AND (
          last_observed_value IS NULL
          OR ABS(last_observed_value - ${observedValue}) > 1e-9
          OR last_evaluated_at < ${observedAt - OBSERVATION_REFRESH_MILLIS}
        )
    `.pipe(Effect.orDie);

  /**
   * Evaluate a `position_update` watch against the reconciled position snapshot.
   *
   * Reads the reconciler's table rather than the exchange: the reconciler is
   * already converging it on fills, reconnects, and the periodic backstop, and
   * a watch that re-read the exchange every two seconds would multiply that
   * traffic by the number of armed watches.
   */
  const evaluatePositionUpdate = Effect.fn("WatchEvaluator.evaluatePositionUpdate")(function* (
    tracked: TrackedWatch,
  ) {
    const watch = tracked.watch.watch;
    if (watch.type !== "position_update") return;
    // A fill watch is a question about a mission's position; there is no
    // account-scoped one (the arm path refuses it), so this is only a guard.
    if (tracked.missionId === null) return;

    const rows = yield* sql<{
      readonly size: number;
      readonly entry_price: number | null;
    }>`
      SELECT size, entry_price FROM trading_position_snapshots
      WHERE mission_id = ${tracked.missionId} AND market = ${watch.market}
    `.pipe(Effect.orDie);

    const row = rows[0];
    const signature = row === undefined ? "flat" : `${row.size}@${row.entry_price ?? ""}`;
    yield* fireOnChange(
      tracked,
      signature,
      () => `${watch.market} position changed to ${signature}`,
    );
  });

  /**
   * Evaluate an `order_update` watch against the reconciled order table.
   *
   * A cloid that has left the table has been filled or cancelled, which is the
   * update the harness most needs to hear about — so a missing row is a change,
   * not a reason to stay silent.
   */
  const evaluateOrderUpdate = Effect.fn("WatchEvaluator.evaluateOrderUpdate")(function* (
    tracked: TrackedWatch,
  ) {
    const watch = tracked.watch.watch;
    if (watch.type !== "order_update") return;
    if (tracked.missionId === null) return;

    const rows = yield* sql<{ readonly remaining_size: number }>`
      SELECT remaining_size FROM trading_orders
      WHERE mission_id = ${tracked.missionId} AND cloid = ${watch.cloid}
    `.pipe(Effect.orDie);

    const row = rows[0];
    const signature = row === undefined ? "gone" : `resting:${row.remaining_size}`;
    yield* fireOnChange(tracked, signature, () => `order ${watch.cloid} is now ${signature}`);
  });

  /**
   * The live position a PnL watch is measured against, or `null` when the
   * mission is flat.
   *
   * The PnL comes from the gateway position read, resolved via the
   * master-wallet address — the same identity the composer and §10.6 use. A
   * flat position fires nothing and leaves the watch active, so a strategy
   * publish or a later re-entry still supersedes it like any other watch.
   */
  const readLivePosition = (missionId: TradingMissionId, market: string) =>
    Effect.gen(function* () {
      const mission = yield* missions.getMission(missionId);
      const address = yield* missions.getMasterWalletAddress(mission.tradingAccountId);
      // One account read serves every PnL watch in the sweep; `getPosition`
      // would have made one per watch, because it reads the whole account and
      // then picks a market out of it.
      const snapshot = yield* readAccountSnapshot(address);
      const held = snapshot.positions.find((entry) => entry.market === market);
      if (held === undefined || held.size === 0) return null;
      return {
        market: held.market,
        size: held.size,
        entryPrice: held.entryPrice,
        unrealisedPnl: held.unrealisedPnl,
        cumulativeFunding: held.cumulativeFunding,
        marginUsed: held.marginUsed,
        freshness: snapshot.freshness,
      } satisfies AgentNetPosition;
    }).pipe(Effect.orDie);

  /**
   * The taker fee rate for one wallet, read from the exchange at most this
   * often.
   *
   * The sweep runs every two seconds against every armed watch, and `userFees`
   * is one of the exchange's heavy info calls — read on every pass it would
   * spend more of the rate limit than the rest of the server put together, on
   * a number that moves with a fourteen-day volume tier. Rate limiting is not
   * an abstract risk here: an unretried rate limit on the exit path is exactly
   * what aborted a live close.
   */
  const FEE_RATE_TTL_MILLIS = 10 * 60_000;

  const feeRateCache = new Map<string, { readonly feeBps: number; readonly readAt: number }>();

  /**
   * The wallet's taker fee in bps, cached, falling back to the mission's own
   * policy figure when the exchange has never answered.
   */
  const takerFeeBps = (address: `0x${string}`, fallbackBps: number) =>
    Effect.gen(function* () {
      const now = yield* nowMs;
      const cached = feeRateCache.get(address);
      if (cached !== undefined && now - cached.readAt < FEE_RATE_TTL_MILLIS) return cached.feeBps;

      const read = yield* gateway
        .getTakerFeeRateBps(address)
        .pipe(Effect.catchCause(() => Effect.succeed(null)));
      // A failed read keeps whatever was last known rather than snapping the
      // target's threshold to a different number for one sweep.
      if (read === null) return cached?.feeBps ?? fallbackBps;

      feeRateCache.set(address, { feeBps: read.feeBps, readAt: now });
      return read.feeBps;
    });

  /**
   * What the position would still owe to realise its profit, in USD.
   *
   * Zero when the fee rate cannot be read at all — a target that fires a little
   * early is a decision point arriving early, which is recoverable; one that
   * cannot fire because a fee read failed is a wake the mission never gets.
   */
  const unpaidExitCost = (missionId: TradingMissionId, position: AgentNetPosition) =>
    Effect.gen(function* () {
      const mission = yield* missions.getMission(missionId);
      const address = yield* missions.getMasterWalletAddress(mission.tradingAccountId);
      const fallback = mission.authority.riskPolicy.fallbackTakerFeeBpsPerSide;
      const feeBps = yield* takerFeeBps(address, fallback);
      // The clearinghouse payload carries no mark, but upnl = (mark − entry) ×
      // size, so mark = entry + upnl/size — the reconciler's own derivation.
      const entryPrice = position.entryPrice;
      if (entryPrice === undefined || position.size === 0) return 0;
      const markPrice = entryPrice + position.unrealisedPnl / position.size;
      return unpaidExitFeeUsd({
        positionSize: position.size,
        markPrice,
        takerFeeBpsPerSide: feeBps,
      });
    }).pipe(Effect.orElseSucceed(() => 0));

  /**
   * Evaluate a `pnl_above` watch against unrealised PnL NET of the exit.
   *
   * The target lives in the strategy the watch was armed against.
   *
   * Net, because `unrealisedPnl` is gross and the exit that realises it has not
   * been paid. Compared against the gross number the target fires at a profit
   * the mission cannot actually bank: one live plan published a $0.34 target
   * against $0.45 of round-trip fees, so reaching it exactly was worth minus
   * eleven cents. A target that fires is now always genuinely bankable.
   *
   * `pnl_above` is not differential: it fires once when the threshold is first
   * reached, then `markTriggered` flips it terminal so a subsequent sweep
   * cannot re-fire.
   */
  const evaluatePnlAbove = Effect.fn("WatchEvaluator.evaluatePnlAbove")(function* (
    tracked: TrackedWatch,
  ) {
    const watch = tracked.watch.watch;
    if (watch.type !== "pnl_above") return;
    if (tracked.missionId === null) return;

    const position = yield* readLivePosition(tracked.missionId, watch.market);
    if (position === null) return;

    const exitCostUsd = yield* unpaidExitCost(tracked.missionId, position);
    const netPnl = position.unrealisedPnl - exitCostUsd;

    const observedAt = yield* nowMs;
    yield* recordObservation(tracked.watch.id, netPnl, observedAt);
    if (netPnl < watch.valueUsd) return;

    yield* enqueueFire(
      tracked,
      `pnl_above:${tracked.watch.id}`,
      `unrealised PnL $${position.unrealisedPnl.toFixed(2)} less $${exitCostUsd.toFixed(2)} ` +
        `still to pay on the exit reached target $${watch.valueUsd}`,
      {
        unrealisedPnl: position.unrealisedPnl,
        netPnlUsd: netPnl,
        exitCostUsd,
        valueUsd: watch.valueUsd,
        observedAt,
        watchId: tracked.watch.id,
      },
    );
  });

  /**
   * Evaluate a `pnl_below` watch against the reconciled unrealised PnL.
   *
   * The mirror of `pnl_above`, and signed: the level worth watching on the way
   * down is usually a loss. A flat position never fires it, for the same reason
   * — a mission with no position has no PnL to have fallen.
   */
  const evaluatePnlBelow = Effect.fn("WatchEvaluator.evaluatePnlBelow")(function* (
    tracked: TrackedWatch,
  ) {
    const watch = tracked.watch.watch;
    if (watch.type !== "pnl_below") return;
    if (tracked.missionId === null) return;

    const position = yield* readLivePosition(tracked.missionId, watch.market);
    if (position === null) return;

    const observedAt = yield* nowMs;
    yield* recordObservation(tracked.watch.id, position.unrealisedPnl, observedAt);
    if (position.unrealisedPnl > watch.valueUsd) return;

    yield* enqueueFire(
      tracked,
      `pnl_below:${tracked.watch.id}`,
      `unrealised PnL $${position.unrealisedPnl.toFixed(2)} fell to the $${watch.valueUsd} level`,
      {
        unrealisedPnl: position.unrealisedPnl,
        valueUsd: watch.valueUsd,
        observedAt,
        watchId: tracked.watch.id,
      },
    );
  });

  /**
   * Evaluate a `pnl_giveback` watch: how far this position has come off its own
   * best.
   *
   * The high-water mark is the reconciler's durable `peak_unrealised_pnl`, not
   * anything the exchange reports and not a process-local maximum — a restart
   * loses neither the peak nor the give-back that happened while it was down.
   * A position that has never been in profit has no peak, so nothing fires:
   * a losing trade is the stop's problem, not this watch's.
   */
  const evaluatePnlGiveback = Effect.fn("WatchEvaluator.evaluatePnlGiveback")(function* (
    tracked: TrackedWatch,
  ) {
    const watch = tracked.watch.watch;
    if (watch.type !== "pnl_giveback") return;
    if (tracked.missionId === null) return;

    const position = yield* readLivePosition(tracked.missionId, watch.market);
    if (position === null) return;

    const rows = yield* sql<{ readonly peak_unrealised_pnl: number | null }>`
      SELECT peak_unrealised_pnl FROM trading_position_snapshots
      WHERE mission_id = ${tracked.missionId} AND market = ${watch.market}
    `.pipe(Effect.orDie);
    const peak = rows[0]?.peak_unrealised_pnl ?? 0;
    if (peak <= 0) return;

    const drawdown = peak - position.unrealisedPnl;

    const observedAt = yield* nowMs;
    yield* recordObservation(tracked.watch.id, drawdown, observedAt);
    if (drawdown < watch.drawdownUsd) return;

    yield* enqueueFire(
      tracked,
      `pnl_giveback:${tracked.watch.id}`,
      `unrealised PnL gave back $${drawdown.toFixed(2)} from its peak of $${peak.toFixed(2)} (now $${position.unrealisedPnl.toFixed(2)})`,
      {
        unrealisedPnl: position.unrealisedPnl,
        peakUnrealisedPnl: peak,
        drawdownUsd: drawdown,
        thresholdUsd: watch.drawdownUsd,
        observedAt,
        watchId: tracked.watch.id,
      },
    );
  });

  /**
   * Evaluate a snapshot-metric `metric_threshold` watch against the fresh
   * gateway snapshot: funding, open interest, day volume, or the spread.
   *
   * `volume_ratio` is deliberately NOT evaluated here — it is a property of a
   * finished bar, so it fires on the candle-finalisation path below, where the
   * bar it measures actually exists.
   */
  const evaluateMetricThreshold = Effect.fn("WatchEvaluator.evaluateMetricThreshold")(function* (
    tracked: TrackedWatch,
  ) {
    const watch = tracked.watch.watch;
    if (watch.type !== "metric_threshold") return;
    if (watch.metric === "volume_ratio") return;

    const snapshot = yield* readMarketSnapshot(watch.market);
    const bbo = snapshot.bestBidOffer;
    const reading =
      watch.metric === "funding_rate_8h"
        ? snapshot.fundingRate8h
        : watch.metric === "open_interest"
          ? snapshot.openInterest
          : watch.metric === "day_volume_usd"
            ? snapshot.dayVolumeUsd
            : // spread_bps needs both sides of the book; a one-sided book has
              // no spread to measure, and the watch simply waits.
              bbo.bidPrice !== undefined && bbo.askPrice !== undefined && bbo.askPrice > 0
              ? ((bbo.askPrice - bbo.bidPrice) / ((bbo.askPrice + bbo.bidPrice) / 2)) * 10_000
              : null;
    if (reading === null) return;

    const observedAt = yield* nowMs;
    yield* recordObservation(tracked.watch.id, reading, observedAt);

    const matched = watch.direction === "above" ? reading >= watch.value : reading <= watch.value;
    if (!matched) return;

    yield* enqueueFire(
      tracked,
      `metric_threshold:${tracked.watch.id}`,
      `${watch.market} ${watch.metric} at ${reading.toPrecision(6)} crossed ${watch.direction} ${watch.value}`,
      { metric: watch.metric, reading, value: watch.value, observedAt, watchId: tracked.watch.id },
    );
  });

  /**
   * Evaluate the `volume_ratio` metric watches against a bar that just
   * finalised: the bar's volume over the average of the prior bars in the
   * rolling window. Called from the delivery path AFTER the bar is known
   * final, so a ratio can never be read off a bar still forming.
   */
  const evaluateVolumeRatio = (
    tracked: TrackedWatch,
    market: string,
    interval: string,
    barVolume: number,
    priorVolumes: ReadonlyArray<number>,
  ) =>
    Effect.gen(function* () {
      const watch = tracked.watch.watch;
      if (watch.type !== "metric_threshold" || watch.metric !== "volume_ratio") return;
      if (market !== watch.market) return;
      // 1m only matches watches persisted before the 5m default landed; those
      // rows keep evaluating on the frame they were armed under. New watches
      // always carry an interval, so this fallback never fires for them.
      if ((watch.interval ?? "1m") !== interval) return;
      if (priorVolumes.length < VOLUME_RATIO_MIN_PRIOR_BARS) return;

      const average = priorVolumes.reduce((sum, v) => sum + v, 0) / priorVolumes.length;
      if (!(average > 0)) return;
      const ratio = barVolume / average;

      const observedAt = yield* nowMs;
      yield* recordObservation(tracked.watch.id, ratio, observedAt);

      const matched = watch.direction === "above" ? ratio >= watch.value : ratio <= watch.value;
      if (!matched) return;

      yield* enqueueFire(
        tracked,
        `metric_threshold:${tracked.watch.id}`,
        `${watch.market} ${interval} bar volume ran at ${ratio.toFixed(2)}× its recent average (${watch.direction} ${watch.value})`,
        {
          metric: "volume_ratio",
          ratio,
          value: watch.value,
          observedAt,
          watchId: tracked.watch.id,
        },
      );
    });

  // -------------------------------------------------------------------------
  // `metric_derived` — plan 38 §3.5. The metric is computed by the market
  // archive (never here); the evaluator only owns the clock, the write-backs,
  // and the firing decision.
  // -------------------------------------------------------------------------

  /** 30 minutes: funding accrues hourly, so a 30m cadence never misses a rate. */
  const DERIVED_FUNDING_CADENCE_MS = 30 * 60_000;
  /** 1 minute: the archiver samples asset_ctx / book_summary ~1/min. */
  const DERIVED_SAMPLE_CADENCE_MS = 60_000;

  /** The interval a candle-sourced derived metric is measured on, if any. */
  const derivedInterval = (params: DerivedMetricParams): BarInterval | undefined =>
    "interval" in params ? params.interval : undefined;

  /**
   * The metric's natural evaluation cadence (plan 38 §3.3): 30m for funding,
   * 1m for the sampled series, one bar for everything candle-sourced.
   * `evaluateEveryMs` on the condition overrides the default.
   */
  const derivedCadenceMs = (watch: Extract<MarketWatch, { type: "metric_derived" }>): number => {
    if (watch.evaluateEveryMs !== undefined) return watch.evaluateEveryMs;
    switch (watch.metric) {
      case "funding_mean":
      case "funding_sign_flip":
      case "funding_cumulative":
        return DERIVED_FUNDING_CADENCE_MS;
      case "oi_change_rate":
      case "premium_mean":
      case "depth_ratio":
        return DERIVED_SAMPLE_CADENCE_MS;
      default:
        // Deliberately 1m: only pre-5m rows lack a derived interval, and they
        // must keep evaluating on the frame they were armed under.
        return INTERVAL_MS[derivedInterval(watch.params) ?? "1m"];
    }
  };

  /** The metric as a fire summary names it, with its key params. */
  const derivedMetricLabel = (watch: Extract<MarketWatch, { type: "metric_derived" }>): string => {
    const params = watch.params;
    switch (params.metric) {
      case "funding_mean":
      case "funding_sign_flip":
        return `${params.windowDays}d mean funding`;
      case "funding_cumulative":
        return "cumulative funding since entry";
      case "sigma_return":
        return `sigma_return ${params.interval}`;
      case "sigma_distance":
        return `sigma_distance ${params.interval}`;
      case "sigma_ratio":
        return `sigma_ratio ${params.interval}`;
      case "ema_distance":
        return `ema_distance ${params.interval}`;
      case "oi_change_rate":
        return `oi change rate ${params.windowMinutes}m`;
      case "premium_mean":
        return `premium mean ${params.windowMinutes}m`;
      case "depth_ratio":
        return `depth ratio ${params.windowMinutes}m`;
      case "bars_since":
        return `bars_since ${params.interval}`;
      case "hold_bars":
        return `hold_bars ${params.interval}`;
      case "vwap_distance":
        return `vwap_distance ${params.interval}`;
    }
  };

  /** A metric value for a fire summary: exponent form for the tiny ones. */
  const formatMetricValue = (value: number): string => {
    if (value === 0) return "0";
    if (Math.abs(value) < 1e-4 || Math.abs(value) >= 1e7) return value.toExponential(2);
    return `${Number(value.toPrecision(3))}`;
  };

  /**
   * The start of the mission's current nonzero holding episode for `market`.
   *
   * Source: the reconciler's `trading_position_snapshots.opened_at` (migration
   * 046) — stamped when the position is first observed non-flat, held while it
   * stays non-flat, cleared on the flat transition. That is the honest live
   * answer to "the position's first fill of the current episode": history.ts
   * derives the same anchor (`first.firstFillAt`) for CLOSED trips by walking
   * `trading_fills` and netting sizes to zero, but that walk can only group a
   * trailing episode after it closes; `opened_at` is the same fact maintained
   * incrementally by the component that owns position truth. Null (or no row,
   * or a flat row) means there is no episode and the caller leaves
   * `positionEntryAt` unset.
   */
  const readPositionEntryAt = (missionId: string, market: string) =>
    sql<{ readonly opened_at: number | null }>`
      SELECT opened_at FROM trading_position_snapshots
      WHERE mission_id = ${missionId} AND market = ${market} AND size != 0
    `.pipe(
      Effect.orDie,
      Effect.map((rows) => rows[0]?.opened_at ?? undefined),
    );

  /**
   * When the `bars_since` reference watch fired, or undefined when it has not
   * fired yet — `markTriggered` stamps `updated_at` with the trigger time, so
   * a triggered row's `updated_at` IS the moment the counted window opens.
   */
  const readSinceTrigger = (sinceWatchId: string) =>
    sql<{ readonly status: string; readonly updated_at: number }>`
      SELECT status, updated_at FROM trading_watches WHERE watch_id = ${sinceWatchId}
    `.pipe(
      Effect.orDie,
      Effect.map((rows) =>
        rows[0]?.status === "triggered" ? (rows[0]?.updated_at as number) : undefined,
      ),
    );

  /**
   * The derived variant of `recordObservation`: the observed value lands under
   * the same epsilon/refresh write-guard, and `next_evaluate_at` — the cadence
   * that keeps a 72-bar sigma off the 2s sweep — is written in the same single
   * UPDATE. The cadence must advance on EVERY real evaluation (guard or no
   * guard), or a static value would pin the watch to per-sweep recomputation;
   * the guard therefore governs only the observation columns.
   */
  const recordDerivedObservation = (
    watchId: string,
    observedValue: number,
    observedAt: number,
    nextEvaluateAt: number,
  ) =>
    sql`
      UPDATE trading_watches
      SET last_observed_value = CASE WHEN (
        last_observed_value IS NULL
        OR ABS(last_observed_value - ${observedValue}) > 1e-9
        OR last_evaluated_at < ${observedAt - OBSERVATION_REFRESH_MILLIS}
      ) THEN ${observedValue} ELSE last_observed_value END,
      last_evaluated_at = CASE WHEN (
        last_observed_value IS NULL
        OR ABS(last_observed_value - ${observedValue}) > 1e-9
        OR last_evaluated_at < ${observedAt - OBSERVATION_REFRESH_MILLIS}
      ) THEN ${observedAt} ELSE last_evaluated_at END,
      next_evaluate_at = ${nextEvaluateAt}
      WHERE watch_id = ${watchId}
    `.pipe(Effect.orDie);

  /** Advance the retry clock without recording anything true. */
  const advanceNextEvaluateAt = (watchId: string, nextEvaluateAt: number) =>
    sql`
      UPDATE trading_watches SET next_evaluate_at = ${nextEvaluateAt}
      WHERE watch_id = ${watchId}
    `.pipe(Effect.orDie);

  /**
   * The `cross` region signature, persisted in the same `baseline_signature`
   * column `fireOnChange` uses. A watch has exactly one firing discipline, so
   * a region signature ("in"/"out") and a change signature ("pos"/"neg") can
   * never collide on the same row.
   */
  const fireOnRegionEntry = (tracked: TrackedWatch, region: "in" | "out", summary: string) =>
    Effect.gen(function* () {
      const key = tracked.watch.id;
      const rows = yield* sql<{ readonly baseline_signature: string | null }>`
        SELECT baseline_signature FROM trading_watches WHERE watch_id = ${key}
      `.pipe(Effect.orDie);
      const previous = rows[0]?.baseline_signature ?? null;
      if (previous !== region) {
        yield* sql`
          UPDATE trading_watches SET baseline_signature = ${region} WHERE watch_id = ${key}
        `.pipe(Effect.orDie);
      }
      // ENTRY-ONLY. The first evaluation arms (a watch armed while already
      // inside its region must not fire — the giveback instant-refire guard
      // of plan 34 step 6, generalised), and leaving the region never fires.
      if (previous !== "out" || region !== "in") return;

      yield* enqueueFire(tracked, `metric_derived:${key}:${region}`, summary, {
        watchId: key,
        region,
        previous,
      });
    });

  /**
   * Evaluate a `metric_derived` watch. `onDelivery` is true on the
   * candle-delivery path, where the delivery is the clock: no cadence is read
   * or written there (the sweep never evaluates a delivered-interval bar_close
   * watch), while the sweep path both gates on and advances
   * `next_evaluate_at`.
   */
  const evaluateDerived = Effect.fn("WatchEvaluator.evaluateDerived")(function* (
    tracked: TrackedWatch,
    now: number,
    onDelivery: boolean,
  ) {
    const watch = tracked.watch.watch;
    if (watch.type !== "metric_derived") return;
    const cadenceMs = derivedCadenceMs(watch);

    // The two anchors the archive cannot resolve itself.
    let positionEntryAt: number | undefined;
    let sinceMs: number | undefined;
    if (
      (watch.metric === "funding_cumulative" || watch.metric === "hold_bars") &&
      tracked.missionId !== null
    ) {
      positionEntryAt = yield* readPositionEntryAt(tracked.missionId, watch.market);
    }
    if (watch.params.metric === "bars_since") {
      sinceMs = yield* readSinceTrigger(watch.params.sinceWatchId);
      if (sinceMs === undefined) {
        // The reference watch has not fired: unavailable-kind "context" this
        // cycle. Retry later, fire nothing, write nothing true.
        if (!onDelivery) yield* advanceNextEvaluateAt(tracked.watch.id, now + cadenceMs);
        return;
      }
    }

    const result = yield* archive.derivedMetric({
      market: watch.market,
      params: watch.params,
      now,
      ...(positionEntryAt === undefined ? {} : { positionEntryAt }),
      ...(sinceMs === undefined ? {} : { sinceMs }),
    });

    if (result.status === "unavailable") {
      // Absence is an answer, never a number: no fire, no observation write,
      // but the retry clock advances. A missing archive must never read as 0.
      if (!onDelivery) yield* advanceNextEvaluateAt(tracked.watch.id, now + cadenceMs);
      return;
    }
    const value = result.value;

    if (onDelivery) {
      yield* recordObservation(tracked.watch.id, value, now);
    } else {
      yield* recordDerivedObservation(tracked.watch.id, value, now, now + cadenceMs);
    }

    const label = derivedMetricLabel(watch);
    if (watch.metric === "funding_sign_flip") {
      // The existing durable-baseline machinery, verbatim: the first
      // evaluation records the sign and fires nothing; any later difference
      // fires once. Durable, so a flip during downtime fires on the first
      // sweep after restart.
      const signature = value < 0 ? "neg" : "pos";
      yield* fireOnChange(
        tracked,
        signature,
        () =>
          `${label} ${formatMetricValue(value)} (sign flip, was ` +
          `${signature === "neg" ? "positive" : "negative"})`,
      );
      return;
    }

    const direction = watch.direction ?? "above";
    const threshold = watch.value ?? 0;
    const inRegion = direction === "above" ? value >= threshold : value <= threshold;
    // `vwap_distance` serves its distance twice: in sigma units (the value,
    // and the threshold's frame) and in bps from the session VWAP.
    const bpsSuffix = result.bps === undefined ? "" : ` (${result.bps} bps from vwap)`;
    const summary = `${label} ${formatMetricValue(value)}${bpsSuffix} (${direction} ${threshold})`;

    if (watch.mode === "level") {
      if (!inRegion) return;
      yield* enqueueFire(tracked, `metric_derived:${tracked.watch.id}`, summary, {
        metric: watch.metric,
        value,
        ...(result.bps === undefined ? {} : { bps: result.bps }),
        threshold,
        observedAt: now,
        watchId: tracked.watch.id,
      });
      return;
    }
    yield* fireOnRegionEntry(tracked, inRegion ? "in" : "out", summary);
  });

  /** The delivery-path filter: a bar of `interval` finalised for `market`. */
  const evaluateDerivedDelivery = (tracked: TrackedWatch, market: string, interval: string) =>
    Effect.gen(function* () {
      const watch = tracked.watch.watch;
      if (watch.type !== "metric_derived") return;
      if (watch.confirm !== "bar_close") return;
      if (market !== watch.market) return;
      if (derivedInterval(watch.params) !== interval) return;
      // The delivery event is the clock; the archive is the data. The
      // archiver lags the WS by up to ~60s, so the metric may exclude the
      // just-closed bar — acceptable and documented (plan 38 §3.5): the next
      // bar's delivery re-evaluates against a complete archive.
      yield* evaluateDerived(tracked, yield* nowMs, true);
    });

  /** Fire a `scheduled_reassessment` watch whose `runAt` has passed. */
  const evaluateScheduled = (tracked: TrackedWatch, observedAt: number) =>
    Effect.gen(function* () {
      const watch = tracked.watch.watch;
      if (watch.type !== "scheduled_reassessment") return;
      if (watch.runAt > observedAt) return;

      yield* enqueueFire(
        tracked,
        `scheduled_reassessment:${tracked.watch.id}`,
        `scheduled reassessment due at ${DateTime.formatIso(DateTime.makeUnsafe(watch.runAt))}`,
        { runAt: watch.runAt, observedAt, watchId: tracked.watch.id },
      );
    });

  const evaluateDelivery: WatchEvaluatorShape["evaluateDelivery"] = (delivery) =>
    Effect.gen(function* () {
      // A candle delivery is a writer too; once the lease is lost this
      // process must stop firing watches in parallel with the new holder.
      if (!lease.held) return;
      const interval = delivery.subscription.interval;
      if (interval === undefined) return;
      const candle = candleFromDelivery(delivery);
      if (candle === undefined) return;

      // Every subscription names its coin (the follow-set sync opens them),
      // so a delivery without one has nothing to be matched against.
      const market = delivery.subscription.coin;
      if (market === undefined) return;
      const key = `${market}:${interval}`;
      const previous = lastDelivered.get(key);
      lastDelivered.set(key, candle);

      const finalized = yield* finalizedCandle(previous, candle);
      if (finalized === undefined) return;

      // The prior window is read BEFORE this bar joins it: the ratio compares
      // the finished bar against the bars before it, not against itself.
      const priorVolumes = recentVolumes.get(key) ?? [];
      const finalVolume = finalized.volume;

      // A re-armed repeat alert parks its cooldown in `next_evaluate_at`; a
      // candle-driven one sits out deliveries until the cooldown passes. The
      // derived watches keep their own rule — delivery is their clock, and
      // their cadence column means something else on the delivery path.
      const now = yield* nowMs;
      const tracked = (yield* activeTrackedWatches()).filter((t) => {
        if (t.watch.watch.type === "metric_derived") return true;
        const due = t.watch.nextEvaluateAt;
        return due === undefined || due <= now;
      });
      // An armed thesis evaluates on the same closed bar the watches do, and
      // costs no venue read: the delivery is only the clock, and the bars come
      // from the archive. Contained, because a validation is research and must
      // never be able to starve the watches that guard a real position.
      yield* validations.onClosedBar({ asset: market, interval, now }).pipe(
        Effect.flatMap((events) => deliverValidationEvents(events, now)),
        Effect.catchCause((cause) =>
          Effect.logWarning("WatchEvaluator: a thesis validation pass failed; watches continue", {
            market,
            interval,
            cause: String(cause),
          }),
        ),
      );

      yield* Effect.forEach(tracked, (t) => evaluateCandleClose(t, market, interval, finalized));
      yield* Effect.forEach(tracked, (t) => evaluateDerivedDelivery(t, market, interval));
      if (finalVolume !== undefined) {
        yield* Effect.forEach(tracked, (t) =>
          evaluateVolumeRatio(t, market, interval, finalVolume, priorVolumes),
        );
        recentVolumes.set(key, [...priorVolumes, finalVolume].slice(-VOLUME_RATIO_WINDOW_BARS));
      }
    });

  const evaluateOne = (t: TrackedWatch, observedAt: number) => {
    switch (t.watch.watch.type) {
      case "price_cross":
        return evaluatePriceCross(t);
      case "scheduled_reassessment":
        return evaluateScheduled(t, observedAt);
      case "position_update":
        return evaluatePositionUpdate(t);
      case "order_update":
        return evaluateOrderUpdate(t);
      case "pnl_above":
        return evaluatePnlAbove(t);
      case "pnl_below":
        return evaluatePnlBelow(t);
      case "pnl_giveback":
        return evaluatePnlGiveback(t);
      case "metric_threshold":
        return evaluateMetricThreshold(t);
      case "metric_derived":
        return evaluateDerived(t, observedAt, false);
      default:
        return Effect.void;
    }
  };

  /**
   * O(1) sweep skip before any archive or exchange call.
   *
   * For a derived watch (plan 38 §3.5): a `confirm: "bar_close"` watch on an
   * interval the delivery path carries is never sweep-evaluated, and any
   * derived watch whose cadence has not come due is skipped until it has.
   *
   * The due-time check now applies to EVERY watch type, because a re-armed
   * repeat alert parks its cooldown in the same `next_evaluate_at` column.
   * Wake watches never carry a due time (only the derived cadence and the
   * notify re-arm write it), so their sweep behaviour is unchanged.
   */
  const sweepSkips = (t: TrackedWatch, now: number): boolean => {
    const watch = t.watch.watch;
    if (watch.type === "metric_derived" && watch.confirm === "bar_close") {
      const interval = derivedInterval(watch.params);
      // DIRECT_INTERVALS (1m/3m/5m/15m/1h) are the delivered intervals. A
      // bar_close watch on 4h/1d has no delivery to ride, so it falls back to
      // the sweep at its interval's cadence below.
      if (interval !== undefined && (DIRECT_INTERVALS as readonly string[]).includes(interval)) {
        return true;
      }
    }
    const due = t.watch.nextEvaluateAt;
    return due !== undefined && due > now;
  };

  const sweep: WatchEvaluatorShape["sweep"] = Effect.gen(function* () {
    // The sweep is a periodic writer; it only acts while this process still
    // holds the trading lease (the lease stands `held` down on takeover).
    if (!lease.held) return;
    const tracked = yield* activeTrackedWatches();
    const observedAt = yield* nowMs;

    // Everything the pass will read, read once. Anything that fails is simply
    // absent from the maps, and the watch that wanted it falls through to a
    // live read of its own — the sweep degrades to what it did before rather
    // than going deaf.
    const due = tracked.filter((t) => !sweepSkips(t, observedAt));
    sweepReads = yield* collectSweepReads(due);

    for (const t of due) {
      // Contained per watch: the evaluators read the exchange and the DB
      // through `orDie`, and one watch's transient failure must not starve the
      // rest of this sweep — a silent evaluator is a deaf mission wearing a
      // healthy status.
      yield* evaluateOne(t, observedAt).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("WatchEvaluator: one evaluation failed; the sweep continues", {
            watchId: t.watch.id,
            watchType: t.watch.watch.type,
            cause: String(cause),
          }),
        ),
      );
    }

    // A validation whose clock has run out ends here rather than on a candle,
    // because a quiet market delivers no candle and an expiry that waits for
    // one would never arrive. Pure database and clock: it adds nothing to the
    // batch of exchange reads collected above.
    yield* expireValidations(observedAt).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("WatchEvaluator: the thesis expiry pass failed; the sweep continues", {
          cause: String(cause),
        }),
      ),
    );

    // The batch is only good for the pass it was read in.
    sweepReads = null;
  });

  /**
   * How many `validation_event` wakes one mission may take in an hour before
   * they are compressed into one.
   *
   * A validation on a 1m interval that is entering and exiting every few bars
   * can produce an event every minute, and six turns an hour on paper trades
   * nobody has money on is a mission spending its whole life narrating. Past
   * this the wake still arrives - going deaf would be worse - but it says so,
   * and the model is told to summarise rather than to react bar by bar.
   */
  const VALIDATION_WAKE_HOURLY_CAP = 6;
  const VALIDATION_WAKE_WINDOW_MS = 60 * 60 * 1_000;
  /** Every validation wake's dedupe key starts with this, so the cap can count them. */
  const VALIDATION_DEDUPE_PREFIX = VALIDATION_EVENT_KEY_PREFIX;

  /**
   * Which mission, if any, is narrating this validation.
   *
   * The validation's own thread first, then the thread its hypothesis was
   * filed in: an idea saved in one chat and validated from the same chat has
   * both, and an idea validated from a mission thread that was never filed has
   * only the first. A thread with no LIVE mission resolves to nothing and the
   * batch falls back to the alert feed, which is where a validation armed from
   * the trade home has always been reported.
   */
  const missionForValidation = (batch: ValidationEventBatch) =>
    Effect.gen(function* () {
      const threads: Array<string> = [];
      if (batch.threadId !== null) threads.push(batch.threadId);
      if (batch.hypothesisId !== null) {
        const rows = yield* sql<{ readonly thread_id: string }>`
          SELECT thread_id FROM trading_hypotheses WHERE hypothesis_id = ${batch.hypothesisId}
        `;
        const filed = rows[0]?.thread_id;
        if (filed !== undefined && !threads.includes(filed)) threads.push(filed);
      }
      for (const threadId of threads) {
        const found = yield* missions.findMissionByThreadId(threadId);
        if (found._tag === "Some" && isActiveMissionStatus(found.value.status)) {
          return { missionId: found.value.id, threadId };
        }
      }
      return null;
    }).pipe(Effect.orDie);

  /** How many validation wakes this mission has been sent in the last hour. */
  const validationWakesInWindow = (missionId: string, observedAt: number) =>
    sql<{ readonly recent: number }>`
      SELECT COUNT(*) AS recent FROM trading_event_inbox
      WHERE mission_id = ${missionId}
        AND deduplication_key LIKE ${`${VALIDATION_DEDUPE_PREFIX}%`}
        AND occurred_at > ${observedAt - VALIDATION_WAKE_WINDOW_MS}
    `.pipe(
      Effect.orDie,
      Effect.map((rows) => rows[0]?.recent ?? 0),
    );

  /**
   * Turn a pass's validation events into at most one wake per mission.
   *
   * Two coalescing rules, both hard. Every batch a mission owns in this pass
   * becomes ONE inbox event and ONE run request, whatever it covers - three
   * validations on three markets are three lines in one wake, not three wakes.
   * And past {@link VALIDATION_WAKE_HOURLY_CAP} in an hour the lines are folded
   * into a count and the compression is stated in the wake itself, because a
   * summary that does not say it is a summary is a lie about how much happened.
   *
   * A batch that resolves to no live mission is left to the alert feed. That is
   * not a fallback so much as the original delivery: a validation armed from
   * the trade home has no agent to narrate it and never did.
   */
  const deliverValidationEvents = (
    batches: ReadonlyArray<ValidationEventBatch>,
    observedAt: number,
  ) =>
    Effect.gen(function* () {
      if (batches.length === 0) return;
      const byMission = new Map<
        string,
        { readonly threadId: string; readonly batches: Array<ValidationEventBatch> }
      >();
      for (const batch of batches) {
        const owner = yield* missionForValidation(batch);
        if (owner === null) continue;
        const existing = byMission.get(owner.missionId);
        if (existing === undefined) {
          byMission.set(owner.missionId, { threadId: owner.threadId, batches: [batch] });
        } else {
          existing.batches.push(batch);
        }
      }

      for (const [missionId, group] of byMission) {
        const recent = yield* validationWakesInWindow(missionId, observedAt);
        const compressed = recent >= VALIDATION_WAKE_HOURLY_CAP;
        const lines = group.batches.map(describeValidationEvents);
        const summary = compressed
          ? `${lines.length} validation event(s) on ${group.batches
              .map((batch) => batch.market)
              .join(", ")}; compressed after ${recent} wakes in the last hour. ` +
            `Newest: ${lines[lines.length - 1] ?? ""}`
          : lines.join(" | ");

        const key = `${VALIDATION_DEDUPE_PREFIX}${missionId}:${observedAt}`;
        yield* inbox.persist({
          missionId: TradingMissionId.make(missionId),
          // A paper fill is news from the market's own bars, arriving on the
          // same clock a candle watch does.
          category: "market",
          deduplicationKey: key,
          payload: { validationEvents: group.batches, compressed },
          occurredAt: observedAt,
          summary,
        });

        yield* requestValidationRun({ missionId, deduplicationKey: key });
      }
    });

  /**
   * Ask the coordinator for a run, retrying while another run holds the lease.
   *
   * The same shape the mission reactor uses for a fired watch, and forked for
   * the same reason: a mission mid-turn must not stall the sweep behind it. It
   * stops as soon as the inbox event stops being pending, which means a run has
   * claimed it and the narration has been delivered.
   */
  const requestValidationRun = (input: {
    readonly missionId: string;
    readonly deduplicationKey: string;
  }) =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < VALIDATION_QUEUE_RETRY_LIMIT; attempt++) {
        const outcome = yield* coordinator.requestRun({
          missionId: input.missionId,
          cause: "validation_event",
        });
        if (outcome.status === "started") return;
        if (outcome.status === "blocked") {
          yield* Effect.logInfo("WatchEvaluator: a validation wake could not start a run", {
            missionId: input.missionId,
            reason: outcome.reason,
          });
          return;
        }
        yield* Effect.sleep(VALIDATION_QUEUE_RETRY_DELAY);
        const stillPending = yield* inbox.isPending(
          TradingMissionId.make(input.missionId),
          input.deduplicationKey,
        );
        if (!stillPending) return;
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("WatchEvaluator: the validation wake request failed", {
          missionId: input.missionId,
          cause: String(cause),
        }),
      ),
      Effect.forkDetach,
    );

  /**
   * End every validation whose window has closed, and deliver its final report
   * as an alert.
   *
   * The alert is the delivery the user actually gets: a validation runs for
   * weeks, and nobody is watching the chat when it finishes. The summary is one
   * line because it lands in a feed beside price alerts; the report card
   * carries the rest, and the payload carries the report itself so a client can
   * render it without asking again.
   */
  const expireValidations = (observedAt: number) =>
    Effect.gen(function* () {
      const finished = yield* validations.expireDue({ now: observedAt });
      for (const report of finished.reports) {
        yield* alerts.append({
          venue: DEFAULT_TRADING_VENUE,
          asset: report.thesis.market,
          accountId: null,
          // The validation is the thing that fired. Alerts are keyed by what
          // armed them, and a validation is not a watch row.
          watchId: report.validationId,
          firedAt: observedAt,
          summary: forwardEndSummary(report),
          payload: report,
        });
      }
      yield* deliverValidationEvents(finished.events, observedAt);
    });

  /**
   * The markets and wallets one sweep needs, read once each.
   *
   * `getMarketSnapshots` pays one `metaAndAssetCtxs` for the whole list, and
   * the account read is one `clearinghouseState` per distinct master wallet —
   * which in this fork is one. A failed read leaves its entry out, and the
   * watch that wanted it reads live: this is a rate-limit optimisation, never
   * a correctness gate.
   */
  const collectSweepReads = Effect.fn("WatchEvaluator.collectSweepReads")(function* (
    due: ReadonlyArray<TrackedWatch>,
  ) {
    const markets = new Set<string>();
    const missionIds = new Set<TradingMissionId>();
    for (const t of due) {
      const watch = t.watch.watch;
      if (watch.type === "price_cross" || watch.type === "metric_threshold") {
        markets.add(watch.market);
      }
      if (
        t.missionId !== null &&
        (watch.type === "pnl_above" || watch.type === "pnl_below" || watch.type === "pnl_giveback")
      ) {
        missionIds.add(t.missionId);
      }
    }

    const snapshots = new Map<string, AgentMarketSnapshot>();
    if (markets.size > 0) {
      const read = yield* gateway
        .getMarketSnapshots([...markets])
        .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<AgentMarketSnapshot>));
      for (const snapshot of read) snapshots.set(snapshot.market, snapshot);
    }

    const addresses = new Set<`0x${string}`>();
    for (const missionId of missionIds) {
      const address = yield* missions.getMission(missionId).pipe(
        Effect.flatMap((mission) => missions.getMasterWalletAddress(mission.tradingAccountId)),
        Effect.map((address) => address as `0x${string}` | null),
        Effect.orElseSucceed(() => null),
      );
      if (address !== null) addresses.add(address);
    }

    const accounts = new Map<string, AgentAccountSnapshot>();
    for (const address of addresses) {
      const snapshot = yield* gateway.getAccountSnapshot(address).pipe(
        Effect.map((value) => value as AgentAccountSnapshot | null),
        Effect.orElseSucceed(() => null),
      );
      if (snapshot !== null) accounts.set(address, snapshot);
    }

    return { snapshots, accounts };
  });

  /**
   * The candle consumers per followed asset, so a market that falls out of
   * the follow set can have its subscriptions interrupted.
   */
  const consumers = new Map<string, Array<Fiber.Fiber<unknown, unknown>>>();

  /**
   * One candle subscription per §13 direct interval for one asset.
   * Deliveries route to the candle-close watches bound to that interval.
   *
   * The forked consumers read the services the evaluator captured at build,
   * so nothing extra is required in the forked fibers' context.
   * `catchCause`, not `ignore`: `ignore` swallows typed failures only, and
   * the evaluators die (`orDie`) on gateway/DB errors — a defect escaping
   * here would kill the consumer fiber and silence every watch it drives,
   * with nothing on the mission to say it happened.
   */
  const subscribeAsset = (asset: string) =>
    Effect.gen(function* () {
      const fibers: Array<Fiber.Fiber<unknown, unknown>> = [];
      for (const interval of DIRECT_INTERVALS) {
        const subscription = ws.subscribe({ type: "candle", coin: asset, interval });
        const fiber = yield* Effect.forkScoped(
          Stream.runForEach(subscription, (delivery) =>
            evaluateDelivery(delivery).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("WatchEvaluator: candle evaluation failed", {
                  cause: String(cause),
                }),
              ),
            ),
          ),
        );
        fibers.push(fiber);
      }
      consumers.set(asset, fibers);
    });

  /**
   * Reconcile the candle subscriptions against the follow set — the registry
   * replaces the hardcoded market list this evaluator used to carry. The set
   * already includes every armed watch's market (the registry reads
   * `trading_watches` itself), so an armed watch on any asset gets
   * delivery-driven evaluation, and a market nobody is paying attention to
   * stops costing five subscriptions.
   */
  const syncSubscriptions = Effect.gen(function* () {
    const followed = yield* followSet.list;
    const wanted = new Set(followed.map((entry) => entry.asset));
    for (const asset of wanted) {
      if (!consumers.has(asset)) yield* subscribeAsset(asset);
    }
    for (const [asset, fibers] of consumers) {
      if (wanted.has(asset)) continue;
      consumers.delete(asset);
      yield* Effect.forEach(fibers, (fiber) => Fiber.interrupt(fiber));
    }
  });

  const start: WatchEvaluatorShape["start"] = () =>
    Effect.gen(function* () {
      // Candle subscriptions follow attention: reconciled now and then on the
      // registry's own cadence.
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          while (true) {
            yield* syncSubscriptions.pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("WatchEvaluator: follow-set sync failed; retrying", {
                  cause: String(cause),
                }),
              ),
            );
            yield* Effect.sleep(FOLLOW_SYNC_INTERVAL_MS);
          }
        }),
      );

      // The slow sweep for price-cross and scheduled watches.
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          while (true) {
            yield* sweep.pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("WatchEvaluator: sweep failed; retrying next interval", {
                  cause: String(cause),
                }),
              ),
            );
            yield* Effect.sleep(SWEEP_INTERVAL);
          }
        }),
      );
    });

  return {
    start,
    drain: worker.drain,
    evaluateDelivery,
    sweep,
    forgetDeliveredCandles: Effect.sync(() => {
      lastDelivered.clear();
      recentVolumes.clear();
    }),
  } satisfies WatchEvaluatorShape;
});

export const WatchEvaluatorLive = Layer.effect(WatchEvaluator, make);
