/**
 * TradingMissionService - durable mission lifecycle.
 *
 * Owns mission creation, the §11.1 status transitions, and the
 * one-active-mission invariant. A harness turn is temporary; the records this
 * service writes are what outlive it.
 *
 * @module TradingMissionService
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PENDING_EXECUTION_STATUSES } from "@t3tools/trading-contracts/execution";
import { DEFAULT_TRADING_MARKET } from "@t3tools/trading-contracts/primitives";

import { toPersistenceSqlError, type PersistenceSqlError } from "../persistence/Errors.ts";
import {
  TradingHarnessBindingImmutableError,
  TradingMarketManualExposureError,
  TradingMissionAlreadyActiveError,
  TradingMissionNotFoundError,
  TradingMissionTransitionError,
  TradingMissionVersionConflictError,
} from "./Errors.ts";
import { isActiveMissionStatus, validateTransition } from "./MissionTransitions.ts";
import { resolveTestnetAuthority } from "./TestnetAuthority.ts";
import {
  EvmAddress,
  TradingAuthority,
  TradingCapitalSource,
  TradingHarnessBinding,
  TradingMarket,
  TradingMasterWallet,
  TradingMission,
  TradingMissionBlockedReason,
  TradingMissionControl,
  TradingMissionPurpose,
  TradingMissionStatus,
  TradingPendingExecution,
} from "./Schemas.ts";

export const CreateTradingMissionInput = Schema.Struct({
  missionId: Schema.String,
  userId: Schema.String,
  tradingAccountId: Schema.String,
  instruction: Schema.String,
  allocatedCapitalUsd: Schema.Number,
  /**
   * Which precedence rule produced `allocatedCapitalUsd`, see `MissionCapital`.
   * Frozen onto the authority envelope so a surface can tell a granted or
   * measured mandate from the stand-in an unreadable account falls back to.
   */
  capitalSource: Schema.optional(TradingCapitalSource),
  /** The market the mission is mandated to trade. Absent means the default (ETH). */
  market: Schema.optional(TradingMarket),
  /** The wake budget the mandate names (Phase 8). Absent means unlimited. */
  maxWakes: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  /**
   * What the mission is for. Absent means `trade`, which is what every caller
   * that predates observe missions means and what the column defaults to.
   */
  purpose: Schema.optional(TradingMissionPurpose),
  harness: TradingHarnessBinding,
});
export type CreateTradingMissionInput = typeof CreateTradingMissionInput.Type;

export const TransitionTradingMissionInput = Schema.Struct({
  missionId: Schema.String,
  to: TradingMissionStatus,
  expectedVersion: Schema.Number,
  blockedReason: Schema.optional(TradingMissionBlockedReason),
});
export type TransitionTradingMissionInput = typeof TransitionTradingMissionInput.Type;

export const UpdateHarnessBindingInput = Schema.Struct({
  missionId: Schema.String,
  expectedVersion: Schema.Number,
  harness: TradingHarnessBinding,
});
export type UpdateHarnessBindingInput = typeof UpdateHarnessBindingInput.Type;

/**
 * The binding fields frozen for the life of an active mission (§10.2). Recovery
 * §18.3 depends on this: "no restart ever performs automatic provider
 * substitution."
 */
export const HARNESS_BINDING_IDENTITY_FIELDS = [
  "provider",
  "providerInstanceId",
  "threadId",
] as const;

const changedIdentityFields = (
  current: TradingHarnessBinding,
  next: TradingHarnessBinding,
): ReadonlyArray<string> =>
  HARNESS_BINDING_IDENTITY_FIELDS.filter((field) => current[field] !== next[field]);

/**
 * What a release did, in the three words the caller has to relay.
 *
 * `last_market` is a refusal that changed nothing: it is the one case where the
 * honest answer is "end the mission instead".
 */
export type MarketReleaseOutcome = "released" | "not_held" | "last_market";

export type TradingMissionServiceError =
  | PersistenceSqlError
  | TradingMissionAlreadyActiveError
  | TradingMissionNotFoundError
  | TradingMissionTransitionError
  | TradingMissionVersionConflictError;

export interface TradingMissionServiceShape {
  /**
   * Create a mission with the testnet authority defaults applied to the mandate
   * (`TestnetAuthority`, env-overridable).
   *
   * Fails with `TradingMissionAlreadyActiveError` when the user already holds a
   * mission that is not in a permanent terminal state.
   */
  readonly createMission: (
    input: CreateTradingMissionInput,
  ) => Effect.Effect<
    TradingMission,
    | PersistenceSqlError
    | TradingMissionAlreadyActiveError
    | TradingMarketManualExposureError
    | TradingMissionNotFoundError
  >;

  /** Move a mission to a new status, enforcing §11.1 and the row version. */
  readonly transition: (
    input: TransitionTradingMissionInput,
  ) => Effect.Effect<TradingMission, TradingMissionServiceError>;

  /**
   * Re-issue the mission's current authority envelope as a fresh version —
   * same JSON, version + 1, a new `created_at`.
   *
   * The wake budget's reset (Phase 8): the coordinator counts runs from the
   * active authority version's `created_at`, so resuming a
   * `wake_budget_exhausted` mission re-issues the envelope and the same
   * `maxWakes` starts counting from zero.
   */
  readonly refreshAuthorityVersion: (
    missionId: string,
  ) => Effect.Effect<TradingMission, PersistenceSqlError | TradingMissionNotFoundError>;

  /**
   * Update the binding's runtime bookkeeping — session id, resume cursor,
   * model, availability — which ProviderService owns and which changes as a
   * session starts, resumes, and drops.
   *
   * Fails with `TradingHarnessBindingImmutableError` if the caller tries to
   * change the binding's identity (provider, providerInstanceId, threadId)
   * while the mission is active.
   */
  readonly updateHarnessBinding: (
    input: UpdateHarnessBindingInput,
  ) => Effect.Effect<
    TradingMission,
    | PersistenceSqlError
    | TradingHarnessBindingImmutableError
    | TradingMissionNotFoundError
    | TradingMissionVersionConflictError
  >;

  readonly getMission: (
    missionId: string,
  ) => Effect.Effect<TradingMission, PersistenceSqlError | TradingMissionNotFoundError>;

  /**
   * The user's NEWEST mission that still holds authority, if any.
   *
   * Since D4 made authority per-market, several missions can be active at
   * once; callers that mean "is anything running?" (auto-mission's gate, the
   * harness fallback) keep this read, and callers that act per mission use
   * `findActiveMissions`.
   */
  readonly findActiveMission: (
    userId: string,
  ) => Effect.Effect<Option.Option<TradingMission>, PersistenceSqlError>;

  /** Every mission of the user's that still holds authority, newest first. */
  readonly findActiveMissions: (
    userId: string,
  ) => Effect.Effect<ReadonlyArray<TradingMission>, PersistenceSqlError>;

  /** The active mission holding `{venue, market}`, if any — D4's per-market read. */
  readonly findActiveMissionOnMarket: (input: {
    readonly userId: string;
    readonly venue: string;
    readonly market: string;
  }) => Effect.Effect<Option.Option<TradingMission>, PersistenceSqlError>;

  /**
   * Extend an active mission onto one more market, or say who holds it.
   *
   * The bind-on-first-use path for a thread that already holds a mission. Every
   * gate `createMission` applies to the market half applies here unchanged —
   * the D4 mission-vs-mission check, the manual-exposure check — because taking
   * a second market is the same act as taking the first, and the only thing
   * that differs is whether a mission has to be created to hold it.
   *
   * A market the mission already holds is a no-op, not a refusal: a turn that
   * enters twice on one market must not be told the market is taken by itself.
   */
  readonly bindMarket: (input: {
    readonly missionId: string;
    readonly market: string;
  }) => Effect.Effect<
    TradingMission,
    | PersistenceSqlError
    | TradingMissionAlreadyActiveError
    | TradingMarketManualExposureError
    | TradingMissionNotFoundError
  >;

  /**
   * Which of the mission's markets still carry exposure: an open position, a
   * resting order, or an execution the exchange has not settled.
   *
   * Read before a release, because giving up authority over a market something
   * is still open on would leave that exposure with nobody managing it.
   */
  readonly listOpenMarkets: (
    missionId: string,
  ) => Effect.Effect<ReadonlyArray<string>, PersistenceSqlError>;

  /**
   * Let one market go without ending the mission - the reverse of the bind.
   *
   * The market becomes free for another chat immediately. Releasing a market
   * the mission does not hold is a no-op. Releasing the LAST one is refused
   * here: a mission holding nothing is a mission that should have ended, and
   * ending it is the caller's decision to make out loud rather than a side
   * effect of a release.
   */
  readonly releaseMarket: (input: {
    readonly missionId: string;
    readonly market: string;
  }) => Effect.Effect<
    { readonly mission: TradingMission; readonly outcome: MarketReleaseOutcome },
    PersistenceSqlError | TradingMissionNotFoundError
  >;

  /**
   * The mission row's optimistic-locking version.
   *
   * `TradingMission` is a published contract (§10.3) and does not carry the row
   * version, so a caller that needs to transition a mission it did not just
   * write reads the version through here.
   */
  readonly getMissionVersion: (
    missionId: string,
  ) => Effect.Effect<number, PersistenceSqlError | TradingMissionNotFoundError>;

  /**
   * The still-authoritative mission whose harness binding names `threadId`, if
   * any.
   *
   * This is how a harness-facing tool call resolves which mission it is allowed
   * to act on: the credential carries a thread, §10.2 freezes that thread onto
   * one active mission, so the thread is the authorization.
   */
  readonly findMissionByThreadId: (
    threadId: string,
  ) => Effect.Effect<Option.Option<TradingMission>, PersistenceSqlError>;

  /**
   * The newest mission ever bound to `threadId`, terminal ones included.
   *
   * `findMissionByThreadId` is the authorization query and deliberately stops
   * seeing a mission the moment it is revoked or completed. That leaves a thread
   * whose mission has ended unable to learn anything at all about it, which is
   * the one moment it most wants to. This is the read that answers "what
   * happened to mine" — it grants nothing.
   */
  readonly findLastMissionByThreadId: (
    threadId: string,
  ) => Effect.Effect<Option.Option<TradingMission>, PersistenceSqlError>;

  /**
   * The mission's mid-submission executions, oldest first.
   *
   * This is the set preview item 16 refuses a new intent against. Published so
   * a harness told `no_conflicting_execution_pending` can read what is holding
   * the lock and how stale it is, instead of only that something is.
   */
  readonly listPendingExecutions: (
    missionId: string,
  ) => Effect.Effect<ReadonlyArray<TradingPendingExecution>, PersistenceSqlError>;

  /**
   * The master-wallet address for the account a mission trades against.
   *
   * Account reads (§14.2 `trading_look`, `trading_look`,
   * `trading_look`) use the user-owned master-wallet address as
   * identity — never the execution-wallet address (§10.6). This resolves the
   * address from the mission's trading account so the gateway receives it
   * server-side; the harness never supplies an address.
   */
  readonly getMasterWalletAddress: (
    tradingAccountId: string,
  ) => Effect.Effect<EvmAddress, PersistenceSqlError | TradingMissionNotFoundError>;

  /**
   * The highest unrealised PnL this position has reached, from the reconciler's
   * durable high-water mark.
   *
   * `null` when the mission is flat, when the position has never been in
   * profit, or when it was opened before the mark was being recorded. The
   * exchange reports what a position is worth now and never what it was worth
   * at its best, so this is the only place a woken run can learn how much of a
   * winner it has already given back.
   */
  readonly readPeakUnrealisedPnl: (input: {
    readonly missionId: string;
    readonly market: string;
  }) => Effect.Effect<number | null, PersistenceSqlError>;

  /**
   * How far the held position has already come off that high-water mark — plan
   * 34 step 6.
   *
   * The same subtraction the wakeup composer publishes as
   * `position.drawdownFromPeakUsd`, read from the reconciler's snapshot rather
   * than from the exchange, so arming a watch does not cost a market read.
   * `null` when the mission is flat or has no peak to have come off.
   */
  readonly readDrawdownFromPeak: (input: {
    readonly missionId: string;
    readonly market: string;
  }) => Effect.Effect<number | null, PersistenceSqlError>;

  /**
   * Erase a mission and everything keyed to it, in one transaction.
   *
   * Deliberately not called by the boot sweep: an orphan is revoked, not
   * erased, because a mission row is the permanent record of what was traded
   * and the sweep cannot tell a deleted thread from a rebuilt projection with
   * certainty enough to destroy one. This is the implementation an explicit
   * "delete this mission" surface will use, and it must be complete when that
   * arrives — every table keyed to `mission_id` is listed below.
   *
   * This deletes the mission's realised history too: its `trading_closed_trades`
   * rows go with it, so the calibration a later mission could have read off them
   * is gone. That is the accepted trade of an explicit delete.
   *
   * Idempotent (deleting absent rows is a no-op) and NOT guarded: the caller is
   * responsible for checking the mission is flat first. Deleting a mission that
   * still holds a position would strand real exposure with no record of who
   * opened it.
   */
  readonly deleteMission: (missionId: string) => Effect.Effect<void, PersistenceSqlError>;

  /**
   * Every still-authoritative mission whose thread was deleted out from under
   * it. The startup sweep's input.
   *
   * Orphanhood is read off the event log, never off a projection: a
   * `thread.deleted` event is a fact that stays true, while an empty
   * `projection_threads` is what a projection rebuild looks like from the
   * outside. Reading the projection is what once made every live mission look
   * orphaned the moment the projections were reset.
   */
  readonly listOrphanedMissions: () => Effect.Effect<
    ReadonlyArray<{ readonly missionId: string; readonly status: string }>,
    PersistenceSqlError
  >;
}

export class TradingMissionService extends Context.Service<
  TradingMissionService,
  TradingMissionServiceShape
>()("t3/trading/TradingMissionService") {}

interface MissionRow {
  readonly mission_id: string;
  readonly user_id: string;
  readonly trading_account_id: string;
  readonly instruction: string;
  readonly market: string;
  readonly harness_json: string;
  readonly status: string;
  readonly blocked_reason: string | null;
  readonly control_json: string;
  readonly purpose: string;
  readonly authority_version: number;
  readonly version: number;
  readonly last_harness_run_id: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

// JSON text columns are decoded and encoded through the contract schemas, so a
// malformed row fails loudly instead of flowing into the domain as `any`.
const HarnessJson = Schema.fromJsonString(TradingHarnessBinding);
const ControlJson = Schema.fromJsonString(TradingMissionControl);
const AuthorityJson = Schema.fromJsonString(TradingAuthority);

const decodeHarnessJson = Schema.decodeUnknownSync(HarnessJson);
const decodeControlJson = Schema.decodeUnknownSync(ControlJson);
const decodeAuthorityJson = Schema.decodeUnknownSync(AuthorityJson);
const encodeHarnessJson = Schema.encodeUnknownSync(HarnessJson);
const encodeControlJson = Schema.encodeUnknownSync(ControlJson);
const encodeAuthorityJson = Schema.encodeUnknownSync(AuthorityJson);
const decodeStatus = Schema.decodeUnknownSync(TradingMissionStatus);
const decodePurpose = Schema.decodeUnknownSync(TradingMissionPurpose);
const decodeBlockedReason = Schema.decodeUnknownSync(TradingMissionBlockedReason);

/**
 * The mission row plus its current authority version. Strategy is intentionally
 * left off: it is published separately and joined by the read tools.
 */
const toMission = (
  row: MissionRow,
  authorityJson: string,
  heldMarkets: ReadonlyArray<string>,
): TradingMission => ({
  id: row.mission_id,
  userId: row.user_id,
  tradingAccountId: row.trading_account_id,
  instruction: row.instruction,
  // The column is the venue-native asset id since Phase 1 made `TradingMarket`
  // opaque. The old two-literal clamp here would have made the D4 per-market
  // machinery guard the wrong market for anything that was not BTC or ETH.
  market: row.market,
  // Primary first, then the rest in the order they were taken. A mission whose
  // set has not been written yet (only possible between migration 079 and the
  // next bind) still holds its primary, which is what it held before.
  markets: heldMarkets.length === 0 ? [row.market] : heldMarkets,
  harness: decodeHarnessJson(row.harness_json),
  authority: decodeAuthorityJson(authorityJson),
  status: decodeStatus(row.status),
  ...(row.blocked_reason === null
    ? {}
    : { blockedReason: decodeBlockedReason(row.blocked_reason) }),
  control: decodeControlJson(row.control_json),
  purpose: decodePurpose(row.purpose),
  authorityVersion: row.authority_version,
  ...(row.last_harness_run_id === null ? {} : { lastHarnessRunId: row.last_harness_run_id }),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const makeTradingMissionService = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const sqlFail = (operation: string) =>
    toPersistenceSqlError(`TradingMissionService.${operation}`);

  const readMissionRow = (missionId: string) =>
    sql<MissionRow>`
      SELECT * FROM trading_missions WHERE mission_id = ${missionId}
    `.pipe(Effect.mapError(sqlFail("readMissionRow")));

  const readAuthorityJson = (missionId: string, version: number) =>
    sql<{ readonly authority_json: string }>`
      SELECT authority_json FROM trading_authority_versions
      WHERE mission_id = ${missionId} AND version = ${version}
    `.pipe(Effect.mapError(sqlFail("readAuthorityJson")));

  /** Hydrate a mission row together with the authority version it points at. */
  /**
   * The markets a mission still holds, primary first.
   *
   * Ordered by `bound_at` with the primary lifted to the front, so the panel's
   * first tab and the mandate's own market are the same thing.
   */
  const readHeldMarkets = (missionId: string, primary: string) =>
    sql<{ readonly market: string }>`
      SELECT market FROM trading_mission_markets
      WHERE mission_id = ${missionId} AND released_at IS NULL
      ORDER BY bound_at ASC, market ASC
    `.pipe(
      Effect.map((rows) => {
        const markets = rows.map((row) => row.market);
        if (!markets.includes(primary)) return markets;
        return [primary, ...markets.filter((market) => market !== primary)];
      }),
      Effect.mapError(sqlFail("readHeldMarkets")),
    );

  const hydrate = (row: MissionRow) =>
    Effect.gen(function* () {
      const authority = yield* readAuthorityJson(row.mission_id, row.authority_version);
      const authorityJson = authority[0]?.authority_json;
      if (authorityJson === undefined) {
        return yield* new TradingMissionNotFoundError({ missionId: row.mission_id });
      }
      const heldMarkets = yield* readHeldMarkets(row.mission_id, row.market);
      return toMission(row, authorityJson, heldMarkets);
    });

  const getMission: TradingMissionServiceShape["getMission"] = (missionId) =>
    Effect.gen(function* () {
      const rows = yield* readMissionRow(missionId);
      const row = rows[0];
      if (row === undefined) {
        return yield* new TradingMissionNotFoundError({ missionId });
      }
      return yield* hydrate(row);
    });

  const findActiveMission: TradingMissionServiceShape["findActiveMission"] = (userId) =>
    Effect.gen(function* () {
      // Since 075 replaced the one-active-per-user index with the per-market
      // exclusivity index, several rows can match; newest-first is the
      // documented tie-break for callers that only ask "is anything running?".
      const rows = yield* sql<MissionRow>`
        SELECT * FROM trading_missions
        WHERE user_id = ${userId} AND status NOT IN ('revoked', 'completed')
        ORDER BY created_at DESC
        LIMIT 1
      `.pipe(Effect.mapError(sqlFail("findActiveMission")));

      const row = rows[0];
      if (row === undefined) return Option.none();
      return Option.some(yield* hydrate(row).pipe(Effect.orDie));
    });

  const findActiveMissions: TradingMissionServiceShape["findActiveMissions"] = (userId) =>
    Effect.gen(function* () {
      const rows = yield* sql<MissionRow>`
        SELECT * FROM trading_missions
        WHERE user_id = ${userId} AND status NOT IN ('revoked', 'completed')
        ORDER BY created_at DESC
      `.pipe(Effect.mapError(sqlFail("findActiveMissions")));
      return yield* Effect.forEach(rows, (row) => hydrate(row).pipe(Effect.orDie));
    });

  const findActiveMissionOnMarket: TradingMissionServiceShape["findActiveMissionOnMarket"] = (
    input,
  ) =>
    Effect.gen(function* () {
      // The held-set table is the authority record since migration 079: a
      // mission holds a SET, so the mission row's own `market` column only ever
      // knew about the first one. Its `released_at IS NULL` index guarantees at
      // most one row matches.
      const rows = yield* sql<MissionRow>`
        SELECT m.* FROM trading_missions m
        JOIN trading_mission_markets h ON h.mission_id = m.mission_id
        WHERE h.user_id = ${input.userId} AND h.venue = ${input.venue}
          AND h.market = ${input.market} AND h.released_at IS NULL
          AND m.status NOT IN ('revoked', 'completed')
        LIMIT 1
      `.pipe(Effect.mapError(sqlFail("findActiveMissionOnMarket")));
      const row = rows[0];
      if (row === undefined) return Option.none();
      return Option.some(yield* hydrate(row).pipe(Effect.orDie));
    });

  const getMissionVersion: TradingMissionServiceShape["getMissionVersion"] = (missionId) =>
    Effect.gen(function* () {
      const rows = yield* sql<{ readonly version: number }>`
        SELECT version FROM trading_missions WHERE mission_id = ${missionId}
      `.pipe(Effect.mapError(sqlFail("getMissionVersion")));

      const row = rows[0];
      if (row === undefined) {
        return yield* new TradingMissionNotFoundError({ missionId });
      }
      return row.version;
    });

  const listPendingExecutions: TradingMissionServiceShape["listPendingExecutions"] = (missionId) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const rows = yield* sql<{
        readonly cloid: string;
        readonly action_type: string;
        readonly status: string;
        readonly updated_at: number;
      }>`
        SELECT cloid, action_type, status, updated_at FROM trading_execution_records
        WHERE mission_id = ${missionId}
          AND ${sql.in("status", PENDING_EXECUTION_STATUSES)}
        ORDER BY updated_at ASC
      `.pipe(Effect.mapError(sqlFail("listPendingExecutions")));

      return rows.map((row) => ({
        cloid: row.cloid,
        actionType: row.action_type,
        status: row.status,
        ageMillis: Math.max(0, now - row.updated_at),
      }));
    });

  const readPeakUnrealisedPnl: TradingMissionServiceShape["readPeakUnrealisedPnl"] = (input) =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        readonly size: number;
        readonly peak_unrealised_pnl: number | null;
      }>`
        SELECT size, peak_unrealised_pnl FROM trading_position_snapshots
        WHERE mission_id = ${input.missionId} AND market = ${input.market}
      `.pipe(Effect.mapError(sqlFail("readPeakUnrealisedPnl")));

      const row = rows[0];
      // A flat row keeps its columns around; a peak from the position before
      // this one is not this position's high-water mark.
      if (row === undefined || row.size === 0) return null;
      const peak = row.peak_unrealised_pnl;
      return peak === null || peak <= 0 ? null : peak;
    });

  const readDrawdownFromPeak: TradingMissionServiceShape["readDrawdownFromPeak"] = (input) =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        readonly size: number;
        readonly unrealised_pnl: number;
        readonly peak_unrealised_pnl: number | null;
      }>`
        SELECT size, unrealised_pnl, peak_unrealised_pnl FROM trading_position_snapshots
        WHERE mission_id = ${input.missionId} AND market = ${input.market}
      `.pipe(Effect.mapError(sqlFail("readDrawdownFromPeak")));

      const row = rows[0];
      if (row === undefined || row.size === 0) return null;
      const peak = row.peak_unrealised_pnl;
      if (peak === null || peak <= 0) return null;
      return Math.max(0, peak - row.unrealised_pnl);
    });

  const findMissionByThreadId: TradingMissionServiceShape["findMissionByThreadId"] = (threadId) =>
    Effect.gen(function* () {
      const rows = yield* sql<MissionRow>`
        SELECT * FROM trading_missions
        WHERE json_extract(harness_json, '$.threadId') = ${threadId}
          AND status NOT IN ('revoked', 'completed')
      `.pipe(Effect.mapError(sqlFail("findMissionByThreadId")));

      const row = rows[0];
      if (row === undefined) return Option.none();
      return Option.some(yield* hydrate(row).pipe(Effect.orDie));
    });

  const findLastMissionByThreadId: TradingMissionServiceShape["findLastMissionByThreadId"] = (
    threadId,
  ) =>
    Effect.gen(function* () {
      const rows = yield* sql<MissionRow>`
        SELECT * FROM trading_missions
        WHERE json_extract(harness_json, '$.threadId') = ${threadId}
        ORDER BY created_at DESC
        LIMIT 1
      `.pipe(Effect.mapError(sqlFail("findLastMissionByThreadId")));

      const row = rows[0];
      if (row === undefined) return Option.none();
      return Option.some(yield* hydrate(row).pipe(Effect.orDie));
    });

  // Decode the master-wallet JSON column. The address is the identity for
  // account reads (§10.6); the wallet's privy id is never sent to the exchange.
  const decodeMasterWalletJson = Schema.decodeUnknownEffect(
    Schema.fromJsonString(TradingMasterWallet),
  );

  const getMasterWalletAddress: TradingMissionServiceShape["getMasterWalletAddress"] = (
    tradingAccountId,
  ) =>
    Effect.gen(function* () {
      const rows = yield* sql<{ master_wallet_json: string }>`
        SELECT master_wallet_json FROM trading_accounts WHERE account_id = ${tradingAccountId}
      `.pipe(Effect.mapError(sqlFail("getMasterWalletAddress")));
      const row = rows[0];
      if (row === undefined) {
        return yield* new TradingMissionNotFoundError({ missionId: tradingAccountId });
      }
      const wallet = yield* decodeMasterWalletJson(row.master_wallet_json).pipe(Effect.orDie);
      return wallet.address;
    });

  /**
   * D4's manual half: whether the market carries exposure the USER owns —
   * an open manual position, a resting manual order, or a manual submission
   * still in flight. A mission may not take authority over a market the user
   * is in by hand; the index cannot see this, so the service enforces it.
   */
  const readManualExposure = (market: string) =>
    Effect.gen(function* () {
      const positions = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM trading_position_snapshots
        WHERE mission_id IS NULL AND market = ${market} AND size != 0
      `.pipe(Effect.mapError(sqlFail("readManualExposure:positions")));
      if ((positions[0]?.n ?? 0) > 0) return "open_position" as const;

      const orders = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM trading_orders
        WHERE mission_id IS NULL AND market = ${market}
      `.pipe(Effect.mapError(sqlFail("readManualExposure:orders")));
      if ((orders[0]?.n ?? 0) > 0) return "resting_order" as const;

      const pending = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM trading_execution_records
        WHERE mission_id IS NULL AND market = ${market}
          AND ${sql.in("status", PENDING_EXECUTION_STATUSES)}
      `.pipe(Effect.mapError(sqlFail("readManualExposure:pending")));
      if ((pending[0]?.n ?? 0) > 0) return "pending_execution" as const;

      return null;
    });

  const createMission: TradingMissionServiceShape["createMission"] = (input) =>
    Effect.gen(function* () {
      const market = input.market ?? DEFAULT_TRADING_MARKET;
      // An observe mission takes no market. Exclusivity exists because the
      // venue nets positions per asset, so two authorities on one asset would
      // be two agents on one position - and a mission that cannot place an
      // order is not a second agent on anything. Taking the market anyway
      // would mean watching an idea on ETH locked ETH out of being traded,
      // which is the opposite of what watching an idea is for. It keeps
      // `market` as the market it is ABOUT, which is what every surface shows.
      const holdsMarket = (input.purpose ?? "trade") !== "observe";
      if (holdsMarket) {
        // D4: at most one authority per {venue, market}. Mission-vs-mission is
        // also enforced by the 075 partial unique index; checking here first is
        // what turns a constraint violation into a named refusal.
        const existing = yield* findActiveMissionOnMarket({
          userId: input.userId,
          venue: "hyperliquid",
          market,
        });
        if (Option.isSome(existing)) {
          return yield* new TradingMissionAlreadyActiveError({
            userId: input.userId,
            activeMissionId: existing.value.id,
            activeStatus: existing.value.status,
            market,
            activeThreadId: existing.value.harness.threadId,
          });
        }
        const manualExposure = yield* readManualExposure(market);
        if (manualExposure !== null) {
          return yield* new TradingMarketManualExposureError({
            market,
            exposure: manualExposure,
          });
        }
      }

      // The testnet lab preset, not the spec's $1,000 worked example — see
      // `TestnetAuthority` for the sizing and the env knobs that adjust it.
      // The wake budget rides the envelope (Phase 8): the counter's epoch is
      // the authority version's own `created_at`.
      const authority = {
        ...resolveTestnetAuthority(process.env, input.allocatedCapitalUsd),
        ...(input.capitalSource === undefined ? {} : { capitalSource: input.capitalSource }),
        ...(input.maxWakes === undefined ? {} : { maxWakes: input.maxWakes }),
      };
      const control: TradingMissionControl = {
        entriesAllowed: true,
        reentryAllowed: authority.allowReentry,
        pauseAfterPositionClose: false,
      };
      const now = yield* Clock.currentTimeMillis;

      yield* sql`
        INSERT INTO trading_authority_versions (mission_id, version, authority_json, created_at)
        VALUES (${input.missionId}, 1, ${encodeAuthorityJson(authority)}, ${now})
      `.pipe(Effect.mapError(sqlFail("createMission:authority")));

      yield* sql`
        INSERT INTO trading_missions (
          mission_id, user_id, trading_account_id, instruction, market,
          harness_json, status, blocked_reason, control_json, purpose,
          authority_version, version, last_harness_run_id,
          created_at, updated_at
        ) VALUES (
          ${input.missionId}, ${input.userId}, ${input.tradingAccountId},
          ${input.instruction}, ${market},
          ${encodeHarnessJson(input.harness)}, 'initializing', NULL,
          ${encodeControlJson(control)}, ${input.purpose ?? "trade"},
          1, 1, NULL, ${now}, ${now}
        )
      `.pipe(Effect.mapError(sqlFail("createMission:mission")));

      // The first element of the held set. The unique index on this table is
      // the D4 invariant now, so this insert is what actually reserves the
      // market against a concurrent creator - and is exactly why an observe
      // mission skips it. See `holdsMarket` above.
      if (holdsMarket) {
        yield* sql`
          INSERT INTO trading_mission_markets
            (mission_id, user_id, venue, market, bound_at, released_at)
          VALUES (${input.missionId}, ${input.userId}, 'hyperliquid', ${market}, ${now}, NULL)
        `.pipe(Effect.mapError(sqlFail("createMission:market")));
      }

      return yield* getMission(input.missionId);
    });

  const bindMarket: TradingMissionServiceShape["bindMarket"] = (input) =>
    Effect.gen(function* () {
      const mission = yield* getMission(input.missionId);
      if (mission.markets.includes(input.market)) return mission;

      // The same two D4 gates `createMission` runs, in the same order, so a
      // market taken by extension is taken under exactly the rules a market
      // taken by creation is.
      const existing = yield* findActiveMissionOnMarket({
        userId: mission.userId,
        venue: "hyperliquid",
        market: input.market,
      });
      if (Option.isSome(existing)) {
        return yield* new TradingMissionAlreadyActiveError({
          userId: mission.userId,
          activeMissionId: existing.value.id,
          activeStatus: existing.value.status,
          market: input.market,
          activeThreadId: existing.value.harness.threadId,
        });
      }
      const manualExposure = yield* readManualExposure(input.market);
      if (manualExposure !== null) {
        return yield* new TradingMarketManualExposureError({
          market: input.market,
          exposure: manualExposure,
        });
      }

      const now = yield* Clock.currentTimeMillis;
      // A market this mission held before and released comes back through the
      // same row: the primary key is (mission, venue, market), so re-taking it
      // clears the release rather than colliding with its own history.
      yield* sql`
        INSERT INTO trading_mission_markets
          (mission_id, user_id, venue, market, bound_at, released_at)
        VALUES (${input.missionId}, ${mission.userId}, 'hyperliquid', ${input.market}, ${now}, NULL)
        ON CONFLICT (mission_id, venue, market)
        DO UPDATE SET released_at = NULL, bound_at = ${now}
      `.pipe(Effect.mapError(sqlFail("bindMarket")));
      // The mission row moves so every optimistic-lock holder learns the set
      // changed underneath it.
      yield* sql`
        UPDATE trading_missions SET version = version + 1, updated_at = ${now}
        WHERE mission_id = ${input.missionId}
      `.pipe(Effect.mapError(sqlFail("bindMarket:version")));

      return yield* getMission(input.missionId);
    });

  const listOpenMarkets: TradingMissionServiceShape["listOpenMarkets"] = (missionId) =>
    Effect.gen(function* () {
      const rows = yield* sql<{ readonly market: string }>`
        SELECT market FROM trading_position_snapshots
        WHERE mission_id = ${missionId} AND size != 0
        UNION
        SELECT market FROM trading_orders WHERE mission_id = ${missionId}
        UNION
        SELECT market FROM trading_execution_records
        WHERE mission_id = ${missionId} AND ${sql.in("status", PENDING_EXECUTION_STATUSES)}
      `.pipe(Effect.mapError(sqlFail("listOpenMarkets")));
      return rows.map((row) => row.market);
    });

  const releaseMarket: TradingMissionServiceShape["releaseMarket"] = (input) =>
    Effect.gen(function* () {
      const mission = yield* getMission(input.missionId);
      if (!mission.markets.includes(input.market)) {
        return { mission, outcome: "not_held" as const };
      }
      if (mission.markets.length === 1) {
        return { mission, outcome: "last_market" as const };
      }

      const now = yield* Clock.currentTimeMillis;
      yield* sql`
        UPDATE trading_mission_markets SET released_at = ${now}
        WHERE mission_id = ${input.missionId} AND market = ${input.market}
          AND released_at IS NULL
      `.pipe(Effect.mapError(sqlFail("releaseMarket")));
      yield* sql`
        UPDATE trading_missions SET version = version + 1, updated_at = ${now}
        WHERE mission_id = ${input.missionId}
      `.pipe(Effect.mapError(sqlFail("releaseMarket:version")));

      return { mission: yield* getMission(input.missionId), outcome: "released" as const };
    });

  const transition: TradingMissionServiceShape["transition"] = (input) =>
    Effect.gen(function* () {
      const rows = yield* readMissionRow(input.missionId);
      const row = rows[0];
      if (row === undefined) {
        return yield* new TradingMissionNotFoundError({ missionId: input.missionId });
      }
      if (row.version !== input.expectedVersion) {
        return yield* new TradingMissionVersionConflictError({
          missionId: input.missionId,
          expectedVersion: input.expectedVersion,
          currentVersion: row.version,
        });
      }

      const current = yield* hydrate(row);

      const rejection = validateTransition({
        from: current.status,
        to: input.to,
        blockedReason: input.blockedReason,
      });
      if (rejection !== undefined) {
        return yield* new TradingMissionTransitionError({
          missionId: input.missionId,
          from: current.status,
          to: input.to,
          reason: rejection.reason,
          ...(input.blockedReason === undefined ? {} : { blockedReason: input.blockedReason }),
        });
      }

      const now = yield* Clock.currentTimeMillis;
      yield* sql`
        UPDATE trading_missions
        SET status = ${input.to},
            blocked_reason = ${input.blockedReason ?? null},
            version = version + 1,
            updated_at = ${now}
        WHERE mission_id = ${input.missionId} AND version = ${input.expectedVersion}
      `.pipe(Effect.mapError(sqlFail("transition")));

      // Ending the mission releases every market it held. Exclusivity lives in
      // the held-set table now, so a terminal status that left rows behind
      // would hold markets hostage to a mission nobody can reach.
      if (input.to === "revoked" || input.to === "completed") {
        yield* sql`
          UPDATE trading_mission_markets
          SET released_at = ${now}
          WHERE mission_id = ${input.missionId} AND released_at IS NULL
        `.pipe(Effect.mapError(sqlFail("transition:release")));
      }

      return yield* getMission(input.missionId);
    });

  const refreshAuthorityVersion: TradingMissionServiceShape["refreshAuthorityVersion"] = (
    missionId,
  ) =>
    Effect.gen(function* () {
      const rows = yield* readMissionRow(missionId);
      const row = rows[0];
      if (row === undefined) {
        return yield* new TradingMissionNotFoundError({ missionId });
      }
      const authority = yield* readAuthorityJson(missionId, row.authority_version);
      const authorityJson = authority[0]?.authority_json;
      if (authorityJson === undefined) {
        return yield* new TradingMissionNotFoundError({ missionId });
      }

      const now = yield* Clock.currentTimeMillis;
      const nextVersion = row.authority_version + 1;
      yield* sql`
        INSERT INTO trading_authority_versions (mission_id, version, authority_json, created_at)
        VALUES (${missionId}, ${nextVersion}, ${authorityJson}, ${now})
      `.pipe(Effect.mapError(sqlFail("refreshAuthorityVersion:insert")));
      yield* sql`
        UPDATE trading_missions
        SET authority_version = ${nextVersion}, version = version + 1, updated_at = ${now}
        WHERE mission_id = ${missionId}
      `.pipe(Effect.mapError(sqlFail("refreshAuthorityVersion:update")));

      return yield* getMission(missionId);
    });

  const updateHarnessBinding: TradingMissionServiceShape["updateHarnessBinding"] = (input) =>
    Effect.gen(function* () {
      const rows = yield* readMissionRow(input.missionId);
      const row = rows[0];
      if (row === undefined) {
        return yield* new TradingMissionNotFoundError({ missionId: input.missionId });
      }
      if (row.version !== input.expectedVersion) {
        return yield* new TradingMissionVersionConflictError({
          missionId: input.missionId,
          expectedVersion: input.expectedVersion,
          currentVersion: row.version,
        });
      }

      const current = yield* hydrate(row);
      const changed = changedIdentityFields(current.harness, input.harness);
      if (changed.length > 0 && isActiveMissionStatus(current.status)) {
        return yield* new TradingHarnessBindingImmutableError({
          missionId: input.missionId,
          status: current.status,
          changedFields: changed,
        });
      }

      const now = yield* Clock.currentTimeMillis;
      yield* sql`
        UPDATE trading_missions
        SET harness_json = ${encodeHarnessJson(input.harness)},
            version = version + 1,
            updated_at = ${now}
        WHERE mission_id = ${input.missionId} AND version = ${input.expectedVersion}
      `.pipe(Effect.mapError(sqlFail("updateHarnessBinding")));

      return yield* getMission(input.missionId);
    });

  const deleteMission: TradingMissionServiceShape["deleteMission"] = (missionId) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          // Children first, then the projection, then the mission row. Order
          // does not matter to SQLite here (no foreign keys are declared), but
          // it keeps the intent readable: nothing is left pointing at a row
          // that is gone.
          yield* sql`DELETE FROM trading_watches WHERE mission_id = ${missionId}`;
          yield* sql`DELETE FROM trading_harness_runs WHERE mission_id = ${missionId}`;
          yield* sql`DELETE FROM trading_event_inbox WHERE mission_id = ${missionId}`;
          yield* sql`DELETE FROM trading_execution_records WHERE mission_id = ${missionId}`;
          yield* sql`DELETE FROM trading_orders WHERE mission_id = ${missionId}`;
          yield* sql`DELETE FROM trading_fills WHERE mission_id = ${missionId}`;
          yield* sql`DELETE FROM trading_position_snapshots WHERE mission_id = ${missionId}`;
          yield* sql`DELETE FROM trading_risk_reservations WHERE mission_id = ${missionId}`;
          yield* sql`DELETE FROM trading_closed_trades WHERE mission_id = ${missionId}`;
          yield* sql`DELETE FROM trading_account_snapshots WHERE mission_id = ${missionId}`;
          yield* sql`DELETE FROM trading_account_observations WHERE mission_id = ${missionId}`;
          yield* sql`DELETE FROM trading_authority_versions WHERE mission_id = ${missionId}`;
          yield* sql`DELETE FROM trading_plan_history WHERE mission_id = ${missionId}`;
          // The eight tables that arrived after this list was written and were
          // never added to it. Each one kept a mission's rows alive after the
          // mission itself was gone, keyed to an id nothing resolves.
          yield* sql`DELETE FROM trading_entry_context WHERE mission_id = ${missionId}`;
          yield* sql`DELETE FROM trading_execution_sequences WHERE mission_id = ${missionId}`;
          yield* sql`DELETE FROM trading_journal WHERE mission_id = ${missionId}`;
          yield* sql`DELETE FROM trading_level_events WHERE mission_id = ${missionId}`;
          yield* sql`DELETE FROM trading_market_samples WHERE mission_id = ${missionId}`;
          yield* sql`DELETE FROM trading_protection_orders WHERE mission_id = ${missionId}`;
          yield* sql`DELETE FROM trading_stop_adjustments WHERE mission_id = ${missionId}`;
          yield* sql`DELETE FROM trading_structure_reads WHERE mission_id = ${missionId}`;
          yield* sql`DELETE FROM trading_mission_markets WHERE mission_id = ${missionId}`;
          yield* sql`DELETE FROM projection_trading_missions WHERE mission_id = ${missionId}`;
          yield* sql`DELETE FROM trading_missions WHERE mission_id = ${missionId}`;
        }),
      )
      .pipe(Effect.mapError(sqlFail("deleteMission")), Effect.asVoid);

  const listOrphanedMissions: TradingMissionServiceShape["listOrphanedMissions"] = () =>
    // A mission whose thread carries a `thread.deleted` event has no surface
    // left to show it on and nothing that can ever wake it. Terminal missions
    // are left alone either way — a revoked or completed row is the permanent
    // record of what was traded (plan 27 H1), and the sweep's job is to free
    // the authority an orphan is still holding, not to erase history.
    sql<{ readonly mission_id: string; readonly status: string }>`
      SELECT m.mission_id, m.status
      FROM trading_missions m
      WHERE m.status NOT IN ('revoked', 'completed')
        AND EXISTS (
              SELECT 1 FROM orchestration_events e
              WHERE e.aggregate_kind = 'thread'
                AND e.stream_id = json_extract(m.harness_json, '$.threadId')
                AND e.event_type = 'thread.deleted'
            )
    `.pipe(
      Effect.mapError(sqlFail("listOrphanedMissions")),
      Effect.map((rows) => rows.map((row) => ({ missionId: row.mission_id, status: row.status }))),
    );

  return {
    createMission,
    bindMarket,
    releaseMarket,
    listOpenMarkets,
    transition,
    refreshAuthorityVersion,
    updateHarnessBinding,
    getMission,
    getMissionVersion,
    findActiveMission,
    findActiveMissions,
    findActiveMissionOnMarket,
    findMissionByThreadId,
    findLastMissionByThreadId,
    listPendingExecutions,
    getMasterWalletAddress,
    readPeakUnrealisedPnl,
    readDrawdownFromPeak,
    deleteMission,
    listOrphanedMissions,
  } satisfies TradingMissionServiceShape;
});

export const TradingMissionServiceLive = Layer.effect(
  TradingMissionService,
  makeTradingMissionService,
);

export { isActiveMissionStatus };
