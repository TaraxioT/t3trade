/**
 * The mission read model the workspace UI renders.
 *
 * A trading event says only "mission X changed". This service then re-reads
 * mission X from the authoritative migration-035 tables and writes one flat row
 * to `projection_trading_missions`. Doing it that way rather than carrying the
 * mandate, strategy, and watches through event payloads keeps the domain tables
 * the single source of truth: the projection can always be dropped and rebuilt.
 *
 * This is also the one place epoch millis become ISO strings. The row's own
 * `created_at`/`updated_at` are ISO, matching every other `projection_*` table;
 * the JSON payload columns keep the published spec contracts verbatim.
 *
 * @module TradingMissionProjection
 */
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ThreadId, TradingMissionId } from "@t3tools/contracts";
import type {
  OrchestrationTradingMission,
  TradingMissionTimelineEntry,
  TradingRiskControl,
} from "@t3tools/contracts";
import type { TradingOrderTimeInForce } from "@t3tools/trading-contracts/execution";

import { toPersistenceSqlError, type PersistenceSqlError } from "../persistence/Errors.ts";
import { DIRECT_ORDER_MANDATE_MARKER } from "./TradingAuthorityBinding.ts";
import {
  TradingPlanState,
  PersistedWatch,
  TradingAuthority,
  TradingHarnessBinding,
  TradingMissionBlockedReason,
  TradingMissionControl,
  TradingMissionStatus,
  WatchArmedReason,
} from "./Schemas.ts";

export interface TradingMissionProjectionShape {
  /**
   * Rebuild one mission's projection row from the domain tables. A mission that
   * no longer exists is removed rather than left stale.
   */
  readonly refresh: (input: {
    readonly missionId: string;
    readonly occurredAt: string;
  }) => Effect.Effect<void, PersistenceSqlError>;

  readonly getByThreadId: (
    threadId: string,
  ) => Effect.Effect<Option.Option<OrchestrationTradingMission>, PersistenceSqlError>;

  readonly list: () => Effect.Effect<
    ReadonlyArray<OrchestrationTradingMission>,
    PersistenceSqlError
  >;
}

export class TradingMissionProjection extends Context.Service<
  TradingMissionProjection,
  TradingMissionProjectionShape
>()("t3/trading/TradingMissionProjection") {}

/** The one place migration 035's epoch millis become read-model ISO strings. */
const toIso = (epochMillis: number): string => DateTime.formatIso(DateTime.makeUnsafe(epochMillis));

const MarketsJson = Schema.fromJsonString(Schema.Array(Schema.String));
/** The per-market facts of a control result row (RC06). Unreadable reads as absent. */
const ControlMarketsRowJson = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      market: Schema.String,
      outcome: Schema.String,
      positionSize: Schema.NullOr(Schema.Number),
    }),
  ),
);
const parseControlMarketsJson = (
  json: string,
): ReadonlyArray<{
  readonly market: string;
  readonly outcome: string;
  readonly positionSize: number | null;
}> => {
  try {
    return Schema.decodeUnknownSync(ControlMarketsRowJson)(json);
  } catch {
    return [];
  }
};
const encodeMarketsJson = Schema.encodeUnknownSync(MarketsJson);
const decodeMarketsJson = Schema.decodeUnknownSync(MarketsJson);
const WatchesJson = Schema.fromJsonString(Schema.Array(PersistedWatch));
const encodeWatchesJson = Schema.encodeUnknownSync(WatchesJson);
const decodeWatchesJson = Schema.decodeUnknownSync(WatchesJson);
const decodeAuthorityJson = Schema.decodeUnknownSync(Schema.fromJsonString(TradingAuthority));
const decodeControlJson = Schema.decodeUnknownSync(Schema.fromJsonString(TradingMissionControl));
const decodeHarnessJson = Schema.decodeUnknownSync(Schema.fromJsonString(TradingHarnessBinding));
const decodeStrategyJson = Schema.decodeUnknownSync(Schema.fromJsonString(TradingPlanState));
const decodeMarketWatchJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(PersistedWatch.fields.watch),
);
const decodeStatus = Schema.decodeUnknownSync(TradingMissionStatus);
const decodeBlockedReason = Schema.decodeUnknownSync(TradingMissionBlockedReason);
const decodeWatchStatus = Schema.decodeUnknownSync(PersistedWatch.fields.status);
const decodeArmedReason = Schema.decodeUnknownSync(WatchArmedReason);

/**
 * Decode one mission's persisted strategy, degrading to "no strategy" when the
 * stored JSON no longer satisfies `TradingPlanState`.
 *
 * A strategy published before a field became required (`protection.targetProfitUsd`
 * is the first such field) used to throw a defect straight out of `list()`, which
 * took the whole trading mission snapshot down for every mission and left the
 * workspace polling a permanently failing RPC. One unreadable historical row
 * should cost that one mission's strategy card, nothing more.
 *
 * The warning is logged once per row rather than once per read: the workspace
 * polls this projection, so a handful of legacy missions otherwise reprint the
 * same schema error every few seconds for as long as the server is up.
 */
const loggedUndecodableStrategies = new Set<string>();

/** A persisted strategy row that no longer decodes against the current schema. */
class UndecodableStrategyError extends Data.TaggedError("UndecodableStrategyError")<{
  readonly cause: unknown;
}> {}

const readStrategy = (row: {
  readonly mission_id: string;
  readonly strategy_json: string | null;
}): Effect.Effect<TradingPlanState | null> => {
  const strategyJson = row.strategy_json;
  if (strategyJson === null) {
    return Effect.succeed(null);
  }
  return Effect.try({
    try: () => decodeStrategyJson(strategyJson),
    catch: (cause) => new UndecodableStrategyError({ cause }),
  }).pipe(
    Effect.catch(({ cause }) => {
      if (loggedUndecodableStrategies.has(row.mission_id)) {
        return Effect.succeed(null);
      }
      loggedUndecodableStrategies.add(row.mission_id);
      return Effect.logWarning("trading mission projection could not decode a persisted strategy", {
        missionId: row.mission_id,
        cause,
      }).pipe(Effect.as(null));
    }),
  );
};

interface ProjectionRow {
  readonly mission_id: string;
  readonly thread_id: string;
  readonly user_id: string;
  readonly trading_account_id: string;
  readonly instruction: string;
  readonly market: string;
  readonly status: string;
  readonly blocked_reason: string | null;
  readonly authority_json: string;
  readonly authority_version: number;
  readonly strategy_json: string | null;
  /** JSON array of the held markets, primary first. Null only until the next refresh. */
  readonly markets_json: string | null;
  readonly watches_json: string;
  readonly control_json: string;
  readonly harness_json: string;
  readonly created_at: string;
  readonly updated_at: string;
}

/** Row shape for the most recent non-terminal execution record. */
interface ExecutionRecordRow {
  readonly execution_id: string;
  readonly cloid: string;
  readonly action_type: string;
  readonly side: string;
  readonly market: string;
  readonly size: number;
  readonly limit_price: number;
  readonly time_in_force: string;
  readonly reduce_only: number;
  readonly status: string;
  readonly updated_at: number;
}

/**
 * Row shape for a receipt in the fill list — one order, not one fill event.
 *
 * Hyperliquid reports a market order as however many partial fills it took to
 * cross the book: a 3 ETH entry comes back as a dozen slices of a few hundredths
 * each. Rendering those raw put "Sell 0.044 ETH" on the receipt for an order
 * that sold three, with a fee and a realised PnL to match — every figure on the
 * card a fraction of what the trade actually did, and a cap of three receipts
 * hiding the rest. The aggregate below is the order the operator placed, which
 * is also the row the exchange's own trade history shows.
 */
interface FillRow {
  readonly cloid: string | null;
  readonly order_id: number;
  readonly market: string;
  readonly side: string;
  readonly filled_size: number;
  readonly avg_fill_price: number;
  readonly fee_usd: number;
  readonly closed_pnl: number;
  readonly direction: string | null;
  readonly traded_at: number;
}

/**
 * Row shape for one order in the ledger — every execution record that placed
 * an order, joined to its fill aggregate (plan 39 phase 0). `modify_stop` and
 * `cancel` records are filtered out in SQL: a stop move is an agent-log row
 * and a cancel surfaces as its target order's `cancelled` status.
 */
interface OrderRow {
  readonly execution_id: string;
  readonly cloid: string;
  readonly action_type: string;
  readonly side: string;
  readonly market: string;
  readonly size: number;
  readonly limit_price: number;
  readonly time_in_force: string;
  readonly reduce_only: number;
  readonly status: string;
  readonly created_at: number;
  readonly updated_at: number;
  readonly fill_size: number | null;
  readonly avg_fill_price: number | null;
  readonly fee_usd: number | null;
  readonly closed_pnl: number | null;
  readonly fill_order_id: number | null;
  /** From the reconciled open-order table; null when no row exists. */
  readonly open_order_id: number | null;
  readonly remaining_size: number | null;
}

/**
 * The mission's realised result, aggregated across every fill.
 *
 * Separate from `recentFills` because that list is capped at all: a completion
 * summary built from a capped list would understate any mission that traded
 * more times than the cap. It is also grouped by order there, so its row count
 * is orders, not fills.
 */
interface MissionResultRow {
  readonly realized_pnl: number | null;
  readonly fees_paid: number | null;
  readonly fill_count: number;
  readonly first_fill_at: number | null;
  readonly last_fill_at: number | null;
  /** Planned loss at the approved stop, scaled to what actually filled. */
  readonly planned_loss_at_stop: number | null;
}

/** Row shape for the latest position snapshot. */
interface PositionSnapshotRow {
  readonly market: string;
  readonly size: number;
  readonly entry_price: number | null;
  readonly unrealised_pnl: number;
  readonly margin_used: number;
  readonly protected_size: number;
  readonly liquidation_price: number | null;
  readonly mark_px: number | null;
  readonly leverage: number | null;
  readonly observed_at: number;
}

/** The PROMPT-04 execution surfaces for one mission, read from the 037 tables. */
interface ExecutionSurfaces {
  /** The most recent non-terminal execution record, or null. */
  readonly inFlightExecution: ExecutionRecordRow | null;
  /** Recent fills, newest first (caller limits the count). */
  readonly recentFills: ReadonlyArray<FillRow>;
  /** Every order the mission placed, newest first (plan 39 phase 0). */
  readonly orders: ReadonlyArray<OrderRow>;
  /** The latest position snapshot, or null when flat/absent. */
  readonly position: PositionSnapshotRow | null;
  /** One snapshot per market the mission has a live position on, newest first. */
  readonly positions: ReadonlyArray<PositionSnapshotRow>;
  /** Realised result across every fill. */
  readonly result: MissionResultRow;
}

/**
 * How many history entries the mission view carries — plan 24 §4.2.
 *
 * The three sources grow for as long as the mission lives and this rides a 3s
 * poll, so the cap is the payload guard. Fifty is a few hours of a busy 1m
 * mission: enough that the chart's past axis and the thread's wake rows are
 * never short, far below anything that would matter on the wire.
 */
export const MISSION_TIMELINE_LIMIT = 50;

/** A harness run, as the timeline reads it. */
interface HarnessRunRow {
  readonly run_id: string;
  readonly cause: string;
  readonly status: string;
  readonly started_at: number | null;
  readonly created_at: number;
  /** The run's funnel list of tool names (migration 051); null before it. */
  readonly tools_called_json: string | null;
}

/**
 * Decode a run's recorded tool list, degrading to none when unparseable.
 *
 * Names are trimmed and blanks dropped: the contract types `toolsCalled` as
 * `TrimmedNonEmptyString`, so one empty string in the recorded JSON would
 * fail the whole timeline's encode and freeze the panel over a datum that is
 * decoration.
 */
const parseToolsCalled = (json: string | null): ReadonlyArray<string> => {
  if (json === null) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed)
      ? parsed
          .filter((name): name is string => typeof name === "string")
          .map((name) => name.trim())
          .filter((name) => name !== "")
      : [];
  } catch {
    return [];
  }
};

/** A confirmed stop move (migration 050). */
interface StopAdjustmentRow {
  readonly new_stop_price: number;
  readonly justification: string;
  readonly adjusted_at: number;
}

/** One journal note (migration 066; `author` since 067). */
interface JournalNoteRow {
  readonly note: string;
  readonly created_at: number;
  readonly author?: string;
}

/**
 * One delivered validation wake (prompt W).
 *
 * Read off the mission's own inbox rather than a table of its own: the
 * evaluator already writes exactly one durable row per wake, carrying the
 * composed lines as its summary, and a second table would be a second copy of
 * a fact that is already recorded and already bounded.
 */
interface ValidationEventRow {
  readonly summary: string;
  readonly occurred_at: number;
}

/** A §14.7 control outcome row, or an §17.5 emergency notice, as the timeline reads it (RC06). */
export interface ControlResultTimelineRow {
  readonly control: string;
  readonly status: string;
  readonly summary: string;
  readonly occurred_at: number;
}

/** A strategy publish. */
interface StrategyVersionRow {
  readonly version: number;
  readonly created_at: number;
}

/**
 * Merge the history sources into one bounded, newest-first list.
 *
 * Pure, and separate from the queries, because the merge is where the rules
 * actually live: which moment each row is filed under, what it reads as, and
 * which entries survive the cap. Each source is queried with its own limit, so
 * a mission that woke two hundred times cannot crowd its four stop steps out of
 * the array before the sort has run.
 */
export function buildMissionTimeline(input: {
  readonly wakes: ReadonlyArray<HarnessRunRow>;
  readonly stopAdjustments: ReadonlyArray<StopAdjustmentRow>;
  readonly publishes: ReadonlyArray<StrategyVersionRow>;
  readonly journal?: ReadonlyArray<JournalNoteRow>;
  readonly validationEvents?: ReadonlyArray<ValidationEventRow>;
  /** A §14.7 control's durable outcome, and an §17.5 emergency notice (RC06). */
  readonly controlResults?: ReadonlyArray<ControlResultTimelineRow>;
}): ReadonlyArray<TradingMissionTimelineEntry> {
  const entries: Array<TradingMissionTimelineEntry & { readonly atMillis: number }> = [];

  for (const wake of input.wakes) {
    // A queued run that never started is filed under when it was created: the
    // question the axis answers is when the mission was woken, not when a
    // provider got round to it.
    const atMillis = wake.started_at ?? wake.created_at;
    const toolsCalled = parseToolsCalled(wake.tools_called_json);
    entries.push({
      atMillis,
      at: toIso(atMillis),
      kind: "wake",
      // A failed run is the one wake worth reading twice — it is a turn the
      // mission was owed and did not get.
      label: wake.status === "failed" ? `${wake.cause} (failed)` : wake.cause,
      cause: wake.cause,
      // What the run called, verbatim — the one recorded account of what the
      // agent read during the wake. Absent rather than empty when the run
      // called nothing, matching every other optional field here.
      ...(toolsCalled.length === 0 ? {} : { toolsCalled }),
    });
  }

  for (const adjustment of input.stopAdjustments) {
    entries.push({
      atMillis: adjustment.adjusted_at,
      at: toIso(adjustment.adjusted_at),
      kind: "stop_adjusted",
      label: adjustment.justification,
      priceLevel: adjustment.new_stop_price,
    });
  }

  // The model's own words, on the same axis as what it did with them — the
  // note is already prose, so it is the label verbatim (plan 29 step 6.4).
  for (const note of input.journal ?? []) {
    entries.push({
      atMillis: note.created_at,
      at: toIso(note.created_at),
      kind: "journal",
      label: note.note,
      // Narrowed rather than passed through: the column is NOT NULL DEFAULT
      // 'model', so anything else is a row nothing in this codebase wrote.
      author: note.author === "user" ? "user" : "model",
    });
  }

  // The summary IS the composed sentence, the same one the wake carried, so
  // the log row and the wake text cannot describe the same paper fill two
  // different ways. A blank one is dropped: `label` is a non-empty string on
  // the wire and one empty summary would fail the whole timeline's encode.
  for (const event of input.validationEvents ?? []) {
    const label = event.summary.trim();
    if (label === "") continue;
    entries.push({
      atMillis: event.occurred_at,
      at: toIso(event.occurred_at),
      kind: "validation_event",
      label,
    });
  }

  for (const publish of input.publishes) {
    entries.push({
      atMillis: publish.created_at,
      at: toIso(publish.created_at),
      kind: "strategy_published",
      label: `v${publish.version}`,
    });
  }

  // The already-composed outcome sentence, prefixed with the control's own
  // status word — "failed" and "unknown" are the two an operator must never
  // have to infer from prose (RC06).
  for (const result of input.controlResults ?? []) {
    const label = result.summary.trim();
    if (label === "") continue;
    entries.push({
      atMillis: result.occurred_at,
      at: toIso(result.occurred_at),
      kind: "control_result",
      label: `${result.control} ${result.status}: ${label}`,
    });
  }

  return entries
    .sort((a, b) => b.atMillis - a.atMillis)
    .slice(0, MISSION_TIMELINE_LIMIT)
    .map(({ atMillis: _atMillis, ...entry }) => entry);
}

const EMPTY_RESULT: MissionResultRow = {
  realized_pnl: 0,
  fees_paid: 0,
  fill_count: 0,
  first_fill_at: null,
  last_fill_at: null,
  planned_loss_at_stop: null,
};

const EMPTY_SURFACES: ExecutionSurfaces = {
  inFlightExecution: null,
  recentFills: [],
  orders: [],
  position: null,
  positions: [],
  result: EMPTY_RESULT,
};

/**
 * The held set as the row records it, primary first.
 *
 * Falls back to `[market]` for a row written before migration 079 backfilled
 * the column, which is exactly what such a mission held.
 */
const readHeldMarkets = (row: ProjectionRow): ReadonlyArray<string> => {
  if (row.markets_json === null) return [row.market];
  try {
    const markets = decodeMarketsJson(row.markets_json);
    return markets.length === 0 ? [row.market] : markets;
  } catch {
    return [row.market];
  }
};

const toPositionView = (position: PositionSnapshotRow) => ({
  market: position.market,
  size: position.size,
  entryPrice: position.entry_price ?? undefined,
  unrealisedPnl: position.unrealised_pnl,
  marginUsed: position.margin_used,
  protectedSize: position.protected_size,
  liquidationPrice: position.liquidation_price ?? undefined,
  markPrice: position.mark_px ?? undefined,
  observedAt: toIso(position.observed_at),
});

const toMission = (
  row: ProjectionRow,
  missionVersion: number,
  exec: ExecutionSurfaces,
  strategy: TradingPlanState | null,
  strategies: ReadonlyArray<TradingPlanState>,
  missionTimeline: ReadonlyArray<TradingMissionTimelineEntry>,
  lastControlResult: OrchestrationTradingMission["lastControlResult"] = null,
): OrchestrationTradingMission =>
  ({
    id: TradingMissionId.make(row.mission_id),
    threadId: ThreadId.make(row.thread_id),
    userId: row.user_id,
    tradingAccountId: row.trading_account_id,
    instruction: row.instruction,
    market: row.market,
    markets: readHeldMarkets(row),
    status: decodeStatus(row.status),
    blockedReason: row.blocked_reason === null ? null : decodeBlockedReason(row.blocked_reason),
    authority: decodeAuthorityJson(row.authority_json),
    authorityVersion: row.authority_version,
    // Read live from `trading_missions` rather than projected, because it is an
    // optimistic lock: plan 29 step 8.4's drag sends it back as
    // `expectedMissionVersion`, and a projected copy that lagged one publish
    // would refuse every drag with "the model republished underneath you" when
    // nothing had.
    missionVersion,
    strategy,
    strategies,
    watches: decodeWatchesJson(row.watches_json),
    control: decodeControlJson(row.control_json),
    harness: decodeHarnessJson(row.harness_json),
    // The mandate's durable marker decides the label: a direct order's
    // mandate is generated prose (see TradingAuthorityBinding), not a
    // user-authored TRADE.md strategy.
    mandateOrigin: row.instruction.startsWith(DIRECT_ORDER_MANDATE_MARKER)
      ? ("direct_order" as const)
      : ("strategy" as const),
    // Filled by the ws layer, which resolves the thread's workspace root and
    // reads the document there (the projection is SQL-only by design).
    planDocument: null,
    // PROMPT-04 execution surfaces, joined from the migration-037 tables. The
    // cards render only when these are non-null/non-empty.
    inFlightExecution:
      exec.inFlightExecution === null
        ? null
        : {
            executionId: exec.inFlightExecution.execution_id,
            cloid: exec.inFlightExecution.cloid,
            actionType: exec.inFlightExecution.action_type,
            side: exec.inFlightExecution.side as "buy" | "sell",
            market: exec.inFlightExecution.market,
            size: exec.inFlightExecution.size,
            limitPrice: exec.inFlightExecution.limit_price,
            timeInForce: exec.inFlightExecution.time_in_force as TradingOrderTimeInForce,
            reduceOnly: exec.inFlightExecution.reduce_only !== 0,
            status: exec.inFlightExecution.status,
            updatedAt: toIso(exec.inFlightExecution.updated_at),
          },
    recentFills: exec.recentFills.map((f) => ({
      cloid: f.cloid ?? undefined,
      orderId: f.order_id,
      market: f.market,
      side: f.side as "buy" | "sell",
      filledSize: f.filled_size,
      avgFillPrice: f.avg_fill_price,
      feeUsd: f.fee_usd,
      closedPnl: f.closed_pnl,
      direction: f.direction ?? undefined,
      tradedAt: toIso(f.traded_at),
    })),
    orders: exec.orders.map((o) => {
      // Partial progress: the reconciled open-order row is authoritative when
      // it exists (the reconciler holds it current even when fill rows lag);
      // the fill sum is the fallback.
      const filledSize =
        o.remaining_size === null ? (o.fill_size ?? 0) : Math.max(0, o.size - o.remaining_size);
      const orderId = o.open_order_id ?? o.fill_order_id;
      return {
        executionId: o.execution_id,
        cloid: o.cloid,
        actionType: o.action_type,
        side: o.side as "buy" | "sell",
        market: o.market,
        size: o.size,
        limitPrice: o.limit_price,
        timeInForce: o.time_in_force as TradingOrderTimeInForce,
        reduceOnly: o.reduce_only !== 0,
        status: o.status,
        filledSize,
        avgFillPrice: o.avg_fill_price,
        feeUsd: o.fee_usd ?? 0,
        closedPnl: o.closed_pnl ?? 0,
        ...(orderId === null ? {} : { orderId }),
        createdAt: toIso(o.created_at),
        updatedAt: toIso(o.updated_at),
      };
    }),
    result: {
      realizedPnlUsd: exec.result.realized_pnl ?? 0,
      feesPaidUsd: exec.result.fees_paid ?? 0,
      fillCount: exec.result.fill_count,
      firstFillAt: exec.result.first_fill_at === null ? null : toIso(exec.result.first_fill_at),
      lastFillAt: exec.result.last_fill_at === null ? null : toIso(exec.result.last_fill_at),
      plannedLossAtStopUsd: exec.result.planned_loss_at_stop,
    },
    position: exec.position === null ? null : toPositionView(exec.position),
    // Drawn in held order rather than snapshot order, so the switcher's tabs
    // and the cards under them agree.
    positions: readHeldMarkets(row).flatMap((market) => {
      const snapshot = exec.positions.find((position) => position.market === market);
      return snapshot === undefined ? [] : [toPositionView(snapshot)];
    }),
    // The market's configured leverage, read off the position snapshot because
    // that is where the exchange reports it. Mission-level rather than
    // position-level: it outlives the position, and the mission's receipts are
    // read after it has closed.
    leverage: exec.position?.leverage ?? undefined,
    // Filled by the ws layer, which owns the live mark read.
    marketPrices: [],
    missionTimeline,
    lastControlResult,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }) satisfies OrchestrationTradingMission;

const makeTradingMissionProjection = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const sqlFail = (operation: string) =>
    toPersistenceSqlError(`TradingMissionProjection.${operation}`);

  const refresh: TradingMissionProjectionShape["refresh"] = (input) =>
    Effect.gen(function* () {
      const missions = yield* sql<{
        readonly mission_id: string;
        readonly user_id: string;
        readonly trading_account_id: string;
        readonly instruction: string;
        readonly market: string;
        readonly harness_json: string;
        readonly status: string;
        readonly blocked_reason: string | null;
        readonly control_json: string;
        readonly authority_version: number;
        readonly created_at: number;
        readonly updated_at: number;
      }>`
        SELECT * FROM trading_missions WHERE mission_id = ${input.missionId}
      `.pipe(Effect.mapError(sqlFail("refresh:mission")));

      const mission = missions[0];
      if (mission === undefined) {
        yield* sql`
          DELETE FROM projection_trading_missions WHERE mission_id = ${input.missionId}
        `.pipe(Effect.mapError(sqlFail("refresh:delete")));
        return;
      }

      const authorities = yield* sql<{ readonly authority_json: string }>`
        SELECT authority_json FROM trading_authority_versions
        WHERE mission_id = ${input.missionId} AND version = ${mission.authority_version}
      `.pipe(Effect.mapError(sqlFail("refresh:authority")));

      const heldRows = yield* sql<{ readonly market: string }>`
        SELECT market FROM trading_mission_markets
        WHERE mission_id = ${input.missionId} AND released_at IS NULL
        ORDER BY bound_at ASC, market ASC
      `.pipe(Effect.mapError(sqlFail("refresh:markets")));
      const held = heldRows.map((row) => row.market);
      const heldMarkets =
        held.length === 0
          ? [mission.market]
          : held.includes(mission.market)
            ? [mission.market, ...held.filter((market) => market !== mission.market)]
            : held;

      // The primary market's current plan. Plans are keyed by market since
      // migration 079, so "the mission's latest plan" would otherwise be
      // whichever market was published to last.
      const strategies = yield* sql<{ readonly strategy_json: string }>`
        SELECT strategy_json FROM trading_plan_history
        WHERE mission_id = ${input.missionId} AND market = ${mission.market}
        ORDER BY version DESC
        LIMIT 1
      `.pipe(Effect.mapError(sqlFail("refresh:strategy")));

      const watchRows = yield* sql<{
        readonly watch_id: string;
        readonly mission_id: string;
        readonly watch_json: string;
        readonly status: string;
        readonly armed_reason: string | null;
        readonly created_at: number;
        readonly updated_at: number;
        readonly last_observed_value: number | null;
        readonly last_evaluated_at: number | null;
        readonly prediction_version: number | null;
      }>`
        SELECT watch_id, mission_id, watch_json, status, armed_reason,
               created_at, updated_at, last_observed_value, last_evaluated_at,
               prediction_version
        FROM trading_watches
        WHERE mission_id = ${input.missionId}
        ORDER BY created_at DESC, watch_id DESC
      `.pipe(Effect.mapError(sqlFail("refresh:watches")));

      const authorityJson = authorities[0]?.authority_json;
      if (authorityJson === undefined) {
        // A mission always points at a published authority version; if it does
        // not, the projection is better empty than wrong.
        yield* Effect.logWarning("trading mission has no authority version to project", {
          missionId: input.missionId,
          authorityVersion: mission.authority_version,
        });
        return;
      }

      const watches = watchRows.map((row) => ({
        id: row.watch_id,
        missionId: row.mission_id,
        watch: decodeMarketWatchJson(row.watch_json),
        status: decodeWatchStatus(row.status),
        // The web's provenance chips ("auto", "target", "stop") read this; a
        // mapping that drops it renders every watch as harness-armed.
        ...(row.armed_reason === null ? {} : { armedReason: decodeArmedReason(row.armed_reason) }),
        // Which prediction armed this. The unified watch stream labels every
        // row `v{n}` from it, so a dropped mapping here would leave the panel
        // unable to say which read a level belongs to.
        ...(row.prediction_version === null ? {} : { predictionVersion: row.prediction_version }),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        // Guarded on BOTH columns: `lastEvaluatedAt` is typed non-null when
        // present, so a half-written pair must encode as absent, not as null.
        ...(row.last_observed_value === null || row.last_evaluated_at === null
          ? {}
          : {
              lastObservedValue: row.last_observed_value,
              lastEvaluatedAt: row.last_evaluated_at,
            }),
      }));

      yield* sql`
        INSERT INTO projection_trading_missions (
          mission_id, thread_id, user_id, trading_account_id, instruction, market,
          markets_json, status, blocked_reason, authority_json, authority_version,
          strategy_json, watches_json, control_json, harness_json,
          created_at, updated_at
        ) VALUES (
          ${mission.mission_id},
          ${decodeHarnessJson(mission.harness_json).threadId},
          ${mission.user_id},
          ${mission.trading_account_id},
          ${mission.instruction},
          ${mission.market},
          ${encodeMarketsJson(heldMarkets)},
          ${mission.status},
          ${mission.blocked_reason},
          ${authorityJson},
          ${mission.authority_version},
          ${strategies[0]?.strategy_json ?? null},
          ${encodeWatchesJson(watches)},
          ${mission.control_json},
          ${mission.harness_json},
          ${toIso(mission.created_at)},
          ${toIso(mission.updated_at)}
        )
        ON CONFLICT (mission_id) DO UPDATE SET
          thread_id = excluded.thread_id,
          markets_json = excluded.markets_json,
          status = excluded.status,
          blocked_reason = excluded.blocked_reason,
          authority_json = excluded.authority_json,
          authority_version = excluded.authority_version,
          strategy_json = excluded.strategy_json,
          watches_json = excluded.watches_json,
          control_json = excluded.control_json,
          harness_json = excluded.harness_json,
          updated_at = excluded.updated_at
      `.pipe(Effect.mapError(sqlFail("refresh:upsert")));
    });

  /**
   * Read the three PROMPT-04 execution surfaces for one mission from the
   * migration-037 tables. The 036 projection row carries mission state only;
   * these joins populate the order-intent / fill / position cards. A mission
   * with no execution history decodes to empty surfaces.
   */
  const readExecutionSurfaces = (
    missionId: string,
  ): Effect.Effect<ExecutionSurfaces, PersistenceSqlError> =>
    Effect.gen(function* () {
      // The most recent non-terminal execution record (reserved/submitted/accepted).
      // Rejected records are terminal and not shown as in-flight.
      const execRows = yield* sql<ExecutionRecordRow>`
        SELECT execution_id, cloid, action_type, side, market, size, limit_price,
               time_in_force, reduce_only, status, updated_at
        FROM trading_execution_records
        WHERE mission_id = ${missionId} AND status IN ('reserved', 'submitted', 'accepted')
        ORDER BY updated_at DESC LIMIT 1
      `.pipe(Effect.mapError(sqlFail("execution")));
      const inFlightExecution = execRows[0] ?? null;

      // The mission's orders, newest first — each one the sum of its own partial
      // fills. The average price is size-weighted, because the plain mean of a
      // dozen slices is not the price the order got.
      //
      // The cap was 3, to match a receipt list the thread rendered as three
      // cards. The receipts are single rows now and the thread shows all of
      // them, because a session that opened and closed twice before the trade
      // on screen has to be readable — and the chart plots the same fills as
      // markers, so a truncated list would silently truncate the chart too. The
      // limit that remains is a payload guard on a 3s poll, not a display
      // choice: it is far above any real mission's order count.
      const recentFills = yield* sql<FillRow>`
        SELECT
          MIN(cloid) AS cloid,
          order_id,
          market,
          side,
          SUM(filled_size) AS filled_size,
          SUM(filled_size * avg_fill_price) / SUM(filled_size) AS avg_fill_price,
          SUM(fee_usd) AS fee_usd,
          SUM(closed_pnl) AS closed_pnl,
          MIN(direction) AS direction,
          MAX(traded_at) AS traded_at
        FROM trading_fills WHERE mission_id = ${missionId}
        GROUP BY order_id, market, side
        ORDER BY MAX(traded_at) DESC LIMIT 50
      `.pipe(Effect.mapError(sqlFail("fills")));

      // Every order the mission placed, newest first — plan 39 phase 0. The
      // limit mirrors the fill list's: a payload guard on a 3s poll, not a
      // display choice, far above any real mission's order count.
      //
      // Fills are aggregated by COALESCE(cloid, execution_id) and joined on
      // both keys: `trading_fills.cloid` is nullable (an exchange-reconciled
      // fill can arrive without one), so keying on cloid alone would silently
      // drop such fills off their order. The reconciled open-order table
      // supplies `order_id` and `remaining_size` where its row exists — the
      // reconciler holds it current even when fill rows lag.
      const orders = yield* sql<OrderRow>`
        SELECT
          e.execution_id, e.cloid, e.action_type, e.side, e.market, e.size,
          e.limit_price, e.time_in_force, e.reduce_only, e.status,
          e.created_at, e.updated_at,
          f.fill_size, f.avg_fill_price, f.fee_usd, f.closed_pnl, f.fill_order_id,
          o.order_id AS open_order_id, o.remaining_size
        FROM trading_execution_records e
        LEFT JOIN (
          SELECT
            COALESCE(cloid, execution_id) AS fill_key,
            SUM(filled_size) AS fill_size,
            SUM(filled_size * avg_fill_price) / SUM(filled_size) AS avg_fill_price,
            SUM(fee_usd) AS fee_usd,
            SUM(closed_pnl) AS closed_pnl,
            MAX(order_id) AS fill_order_id
          FROM trading_fills WHERE mission_id = ${missionId}
          GROUP BY COALESCE(cloid, execution_id)
        ) f ON f.fill_key = e.cloid OR f.fill_key = e.execution_id
        LEFT JOIN trading_orders o
          ON o.mission_id = e.mission_id AND o.cloid = e.cloid
        WHERE e.mission_id = ${missionId}
          AND e.action_type IN ('open', 'scale_in', 'close', 'reduce', 'reduce_only_exit')
        ORDER BY e.updated_at DESC LIMIT 50
      `.pipe(Effect.mapError(sqlFail("orders")));

      // The realised result across EVERY fill, for the completion summary.
      const resultRows = yield* sql<Omit<MissionResultRow, "planned_loss_at_stop">>`
        SELECT
          SUM(closed_pnl) AS realized_pnl,
          SUM(fee_usd) AS fees_paid,
          COUNT(*) AS fill_count,
          MIN(traded_at) AS first_fill_at,
          MAX(traded_at) AS last_fill_at
        FROM trading_fills WHERE mission_id = ${missionId}
      `.pipe(Effect.mapError(sqlFail("fills")));

      // What the mission really had at stake — plan 34 step 7.3. Each entry's
      // planned loss at its approved stop, scaled by the fraction of that
      // entry which actually filled. An IOC the account could not fund fills
      // part of its request and still reports `filled`, so the approved number
      // alone describes a position the mission never held.
      const plannedRiskRows = yield* sql<{ readonly planned_loss_at_stop: number | null }>`
        SELECT SUM(
          e.planned_loss_at_stop_usd * MIN(1.0, COALESCE(f.filled_size, 0) / e.size)
        ) AS planned_loss_at_stop
        FROM trading_execution_records e
        LEFT JOIN (
          SELECT cloid, SUM(filled_size) AS filled_size
          FROM trading_fills WHERE mission_id = ${missionId} AND cloid IS NOT NULL
          GROUP BY cloid
        ) f ON f.cloid = e.cloid
        WHERE e.mission_id = ${missionId}
          AND e.action_type IN ('open', 'scale_in')
          AND e.planned_loss_at_stop_usd IS NOT NULL
          AND e.size > 0
      `.pipe(Effect.mapError(sqlFail("plannedRisk")));

      const result: MissionResultRow = {
        ...(resultRows[0] ?? EMPTY_RESULT),
        planned_loss_at_stop: plannedRiskRows[0]?.planned_loss_at_stop ?? null,
      };

      // One snapshot per market the mission holds a position on — the table is
      // unique on (mission, market), so this is the whole set and no longer
      // whichever one was reconciled last.
      const positionRows = yield* sql<PositionSnapshotRow>`
        SELECT market, size, entry_price, unrealised_pnl, margin_used, protected_size,
               liquidation_price, mark_px, leverage, observed_at
        FROM trading_position_snapshots WHERE mission_id = ${missionId}
        ORDER BY observed_at DESC
      `.pipe(Effect.mapError(sqlFail("position")));
      const position = positionRows[0] ?? null;

      return {
        inFlightExecution,
        recentFills,
        orders,
        position,
        positions: positionRows,
        result,
      } satisfies ExecutionSurfaces;
    });

  /**
   * The mission's history, joined at read time from the three tables that keep
   * it — the same shape as `readExecutionSurfaces`, and for the same reason:
   * the projection row is current state, and rebuilding it must never depend on
   * history having been copied into it.
   */
  const readMissionTimeline = (
    missionId: string,
  ): Effect.Effect<ReadonlyArray<TradingMissionTimelineEntry>, PersistenceSqlError> =>
    Effect.gen(function* () {
      const wakes = yield* sql<HarnessRunRow>`
        SELECT run_id, cause, status, started_at, created_at, tools_called_json
        FROM trading_harness_runs WHERE mission_id = ${missionId}
        ORDER BY created_at DESC LIMIT ${MISSION_TIMELINE_LIMIT}
      `.pipe(Effect.mapError(sqlFail("timeline:wakes")));

      const stopAdjustments = yield* sql<StopAdjustmentRow>`
        SELECT new_stop_price, justification, adjusted_at
        FROM trading_stop_adjustments WHERE mission_id = ${missionId}
        ORDER BY adjusted_at DESC LIMIT ${MISSION_TIMELINE_LIMIT}
      `.pipe(Effect.mapError(sqlFail("timeline:stops")));

      const publishes = yield* sql<StrategyVersionRow>`
        SELECT version, created_at
        FROM trading_plan_history WHERE mission_id = ${missionId}
        ORDER BY created_at DESC LIMIT ${MISSION_TIMELINE_LIMIT}
      `.pipe(Effect.mapError(sqlFail("timeline:publishes")));

      const journal = yield* sql<JournalNoteRow>`
        SELECT note, created_at, author
        FROM trading_journal WHERE mission_id = ${missionId}
        -- rowid, because two notes in one turn share a millisecond and the
        -- timeline has to draw them in the order they were written.
        ORDER BY created_at DESC, rowid DESC LIMIT ${MISSION_TIMELINE_LIMIT}
      `.pipe(Effect.mapError(sqlFail("timeline:journal")));

      const validationEvents = yield* sql<ValidationEventRow>`
        SELECT summary, occurred_at
        FROM trading_event_inbox
        WHERE mission_id = ${missionId} AND deduplication_key LIKE 'validation:%'
        ORDER BY occurred_at DESC LIMIT ${MISSION_TIMELINE_LIMIT}
      `.pipe(Effect.mapError(sqlFail("timeline:validationEvents")));

      // RC06: the control's own durable outcomes, plus the §17.5 emergency
      // notices RC04 persists — the mission's history is where an operator
      // reads them without a provider.
      const controlResults = yield* sql<ControlResultTimelineRow>`
        SELECT control, status, summary, occurred_at FROM trading_control_results
        WHERE mission_id = ${missionId}
        ORDER BY occurred_at DESC LIMIT ${MISSION_TIMELINE_LIMIT}
      `.pipe(Effect.mapError(sqlFail("timeline:controlResults")));
      const emergencyNotices = yield* sql<ControlResultTimelineRow>`
        SELECT 'emergency_close' AS control, 'unknown' AS status, summary, occurred_at
        FROM trading_event_inbox
        WHERE mission_id = ${missionId} AND deduplication_key LIKE 'emergency_%'
        ORDER BY occurred_at DESC LIMIT ${MISSION_TIMELINE_LIMIT}
      `.pipe(Effect.mapError(sqlFail("timeline:emergencyNotices")));

      return buildMissionTimeline({
        wakes,
        stopAdjustments,
        publishes,
        journal,
        validationEvents,
        controlResults: [...controlResults, ...emergencyNotices],
      });
    });

  /**
   * The mission's most recent §14.7 control outcome (RC06): the correlated
   * completion a dispatched command never proved. Read at read time like the
   * timeline, for the same reason — the row is history, not current state.
   */
  const readLastControlResult = (missionId: string) =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        readonly control: string;
        readonly status: string;
        readonly summary: string;
        readonly markets_json: string;
        readonly request_event_sequence: number | null;
        readonly occurred_at: number;
      }>`
        SELECT control, status, summary, markets_json, request_event_sequence, occurred_at
        FROM trading_control_results WHERE mission_id = ${missionId}
        ORDER BY occurred_at DESC LIMIT 1
      `.pipe(Effect.mapError(sqlFail("lastControlResult")));
      const row = rows[0];
      if (row === undefined) return null;
      const markets: ReadonlyArray<{
        readonly market: string;
        readonly outcome: string;
        readonly positionSize: number | null;
      }> = parseControlMarketsJson(row.markets_json);
      return {
        control: row.control as TradingRiskControl,
        status: row.status as "completed" | "failed" | "unknown",
        summary: row.summary,
        markets,
        ...(row.request_event_sequence === null
          ? {}
          : { requestEventSequence: row.request_event_sequence }),
        occurredAt: toIso(row.occurred_at),
      };
    });

  /** The mission row's own optimistic-lock version, live. */
  const readMissionVersion = (missionId: string) =>
    sql<{ readonly version: number }>`
      SELECT version FROM trading_missions WHERE mission_id = ${missionId}
    `.pipe(
      Effect.map((rows) => rows[0]?.version ?? 0),
      Effect.mapError(sqlFail("readMissionVersion")),
    );

  /**
   * The current plan for every held market, in held order.
   *
   * The projection row carries only the primary market's plan; the rest come
   * from the history table, which has been keyed by market since migration 079.
   * A row that no longer decodes is skipped, same as the primary's.
   */
  const readStrategies = (row: ProjectionRow) =>
    Effect.gen(function* () {
      const markets = readHeldMarkets(row);
      const rows = yield* sql<{ readonly market: string; readonly strategy_json: string }>`
        SELECT market, strategy_json FROM trading_plan_history p
        WHERE p.mission_id = ${row.mission_id} AND p.market IS NOT NULL
          AND p.version = (
            SELECT MAX(version) FROM trading_plan_history q
            WHERE q.mission_id = p.mission_id AND q.market = p.market
          )
      `.pipe(Effect.mapError(sqlFail("readStrategies")));
      const byMarket = new Map(rows.map((entry) => [entry.market, entry.strategy_json]));
      const plans: Array<TradingPlanState> = [];
      for (const market of markets) {
        const json = byMarket.get(market);
        if (json === undefined) continue;
        const plan = yield* readStrategy({ mission_id: row.mission_id, strategy_json: json });
        if (plan !== null) plans.push(plan);
      }
      return plans as ReadonlyArray<TradingPlanState>;
    });

  const getByThreadId: TradingMissionProjectionShape["getByThreadId"] = (threadId) =>
    Effect.gen(function* () {
      const rows = yield* sql<ProjectionRow>`
        SELECT * FROM projection_trading_missions WHERE thread_id = ${threadId}
      `.pipe(Effect.mapError(sqlFail("getByThreadId")));
      const row = rows[0];
      if (row === undefined) return Option.none();
      const exec = yield* readExecutionSurfaces(row.mission_id);
      const strategy = yield* readStrategy(row);
      const strategies = yield* readStrategies(row);
      const timeline = yield* readMissionTimeline(row.mission_id);
      const missionVersion = yield* readMissionVersion(row.mission_id);
      const lastControlResult = yield* readLastControlResult(row.mission_id);
      return Option.some(
        toMission(row, missionVersion, exec, strategy, strategies, timeline, lastControlResult),
      );
    });

  const list: TradingMissionProjectionShape["list"] = () =>
    Effect.gen(function* () {
      const rows = yield* sql<ProjectionRow>`
        SELECT * FROM projection_trading_missions ORDER BY created_at DESC, mission_id DESC
      `.pipe(Effect.mapError(sqlFail("list")));
      const missions = yield* Effect.all(
        rows.map((row) =>
          Effect.map(
            Effect.all([
              readExecutionSurfaces(row.mission_id),
              readStrategy(row),
              readStrategies(row),
              readMissionTimeline(row.mission_id),
              readMissionVersion(row.mission_id),
              readLastControlResult(row.mission_id),
            ]),
            ([exec, strategy, strategies, timeline, missionVersion, lastControlResult]) =>
              toMission(
                row,
                missionVersion,
                exec,
                strategy,
                strategies,
                timeline,
                lastControlResult,
              ),
          ),
        ),
        { concurrency: "unbounded" },
      );
      return missions;
    });

  return { refresh, getByThreadId, list } satisfies TradingMissionProjectionShape;
});

export const TradingMissionProjectionLive = Layer.effect(
  TradingMissionProjection,
  makeTradingMissionProjection,
);
