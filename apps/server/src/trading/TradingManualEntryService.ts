/**
 * TradingManualEntryService — one manual entry, priced, sized and pre-checked
 * (final-form Phase 7).
 *
 * The mirror of `TradingEntryService.prepare` with the mission machinery
 * removed: no mandate, no decision lease, no plan target, no setup snapshot —
 * the user at the ticket is the strategy. What stays is everything about the
 * ORDER: the account envelope (`AccountTradingPolicy`), the margin-capacity
 * bound, the feasible-size derivation, the manual §16.3 subset
 * (`previewManualOrder`), and the rule with no exceptions — **every manual
 * entry carries a stop**, refused at preview without one.
 *
 * D4 exclusivity, manual side: a market with an active mission refuses the
 * ticket with `market_owned_by_mission`, named so the refusal reads as the
 * rule it is. (The mission side of the same rule lives in
 * `TradingMissionService.createMission`.)
 *
 * @module TradingManualEntryService
 */
import {
  deriveFeasibleSize,
  deriveEntryLimitPrice,
  type EntrySizeConstraint,
} from "@t3tools/trading-contracts/entry";
import type { TradingOrderIntent, TradingOrderSide } from "@t3tools/trading-contracts/execution";
import { PENDING_EXECUTION_STATUSES } from "@t3tools/trading-contracts/execution";
import { urgencyToOrderPreference, type TradingUrgency } from "@t3tools/trading-contracts/strategy";
import {
  resolveAccountPolicy,
  type AccountTradingPolicy,
} from "@t3tools/trading-contracts/accountPolicy";
import { MIN_NOTIONAL_USD } from "@t3tools/hyperliquid/Precision";
import { HyperliquidGateway } from "@t3tools/hyperliquid/Gateway";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { estimateIsolatedLiquidationPrice } from "./AccountMarginCapacity.ts";
import { retryTransientRead } from "./RetryTransient.ts";
import { IocSlippageConfig } from "./IocSlippageConfig.ts";
import { TradingCostEstimator } from "./TradingCostEstimator.ts";
import { TradingMissionService } from "./TradingMissionService.ts";
import { previewManualOrder } from "./TradingPreviewService.ts";
import { allocateManualExecutionSequence } from "./TradingExecutionSequence.ts";

/**
 * The in-memory owner token a manual intent carries in its `missionId` field.
 *
 * `TradingOrderIntent.missionId` is a required contract field and the manual
 * path has no mission — this token fills it for in-memory identity and logs
 * only. It is NEVER persisted: the execution service writes `mission_id NULL`
 * for a manual owner, and the cloid comes from `deriveManualCloid`, not from
 * this string.
 */
export const manualOwnerMissionToken = (accountId: string): string => `manual:${accountId}`;

/** What the ticket asked for. */
export interface ManualEntryRequest {
  readonly accountId: string;
  readonly market: string;
  readonly side: TradingOrderSide;
  /** Mandatory. A ticket without a stop is refused, never defaulted. */
  readonly stopPrice: number;
  readonly sizeEth?: number | undefined;
  readonly notionalUsd?: number | undefined;
  /** Same vocabulary the agent's entry offers: `now` crosses, `patient` rests. */
  readonly urgency?: TradingUrgency | undefined;
}

/** A prepared manual entry, ready for `submitManualOrder`. */
export interface PreparedManualEntry {
  readonly outcome: "prepared";
  readonly accountId: string;
  readonly intent: TradingOrderIntent;
  readonly size: number;
  readonly constrainedBy: EntrySizeConstraint;
  /** The largest size every account ceiling allows — the ticket's live readout. */
  readonly feasibleSize: number;
  readonly notionalUsd: number;
  readonly plannedLossAtStopUsd: number;
  readonly reservedRiskUsd: number;
  readonly estimatedRoundTripCostUsd: number;
  readonly notes: ReadonlyArray<string>;
}

/** Why no manual entry could be built. `reason` is the server's own rule name. */
export interface RefusedManualEntry {
  readonly outcome: "refused";
  readonly reason: string;
  readonly detail: string;
  /** The largest size that would have cleared, when a smaller one would. */
  readonly feasibleSize?: number | undefined;
}

export type ManualEntryPreparation = PreparedManualEntry | RefusedManualEntry;

export class TradingManualEntryService extends Context.Service<
  TradingManualEntryService,
  {
    /**
     * Price, size and pre-check one manual entry. `allocateSequence: false`
     * (the ticket's live preview) leaves the durable sequence counter alone
     * and stamps sequence 0 on the returned intent; the place path passes
     * `true` and gets a real, never-reused sequence.
     */
    readonly prepare: (
      request: ManualEntryRequest,
      options?: { readonly allocateSequence?: boolean },
    ) => Effect.Effect<ManualEntryPreparation>;
  }
>()("t3/trading/TradingManualEntryService") {}

const refused = (reason: string, detail: string, feasibleSize?: number): RefusedManualEntry => ({
  outcome: "refused",
  reason,
  detail,
  ...(feasibleSize === undefined ? {} : { feasibleSize }),
});

export const makeTradingManualEntryService = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const missions = yield* TradingMissionService;
  const gateway = yield* HyperliquidGateway;
  const iocSlippage = yield* IocSlippageConfig;
  const estimator = yield* TradingCostEstimator;

  /**
   * The active mission holding this market, if any — the D4 refusal's input.
   *
   * The held-set table is the authority record since migration 079: a mission
   * holds a SET of markets, so the mission row's own `market` column only
   * ever knew the first one. Both held primary and held secondary markets
   * refuse. A failed read is a failed read — it propagates rather than
   * reading as "nobody holds it" (06B).
   */
  const findActiveMissionOnMarket = (market: string) =>
    sql<{ readonly mission_id: string; readonly status: string }>`
      SELECT m.mission_id, m.status
      FROM trading_mission_markets h
      JOIN trading_missions m ON m.mission_id = h.mission_id
      WHERE h.venue = 'hyperliquid' AND h.market = ${market}
        AND h.released_at IS NULL
        AND m.status NOT IN ('revoked', 'completed')
      LIMIT 1
    `.pipe(Effect.map((rows) => rows[0] ?? null));

  /**
   * The leverage the exchange has this market configured at for this account,
   * when nothing is currently open in it. The reconciler persists `leverage`
   * on every position snapshot and deliberately leaves it standing after the
   * position closes, so the last row is the account's per-asset setting as
   * last observed — the isolated 10x a mission era left behind is exactly
   * what a fresh manual entry inherits (R6-2).
   */
  const readLastKnownMarketLeverage = (accountId: string, market: string) =>
    sql<{ readonly leverage: number | null }>`
      SELECT leverage FROM trading_position_snapshots
      WHERE venue = 'hyperliquid' AND account_id = ${accountId}
        AND market = ${market} AND leverage IS NOT NULL
      ORDER BY observed_at DESC
      LIMIT 1
    `.pipe(
      Effect.map((rows) => rows[0]?.leverage ?? null),
      Effect.orElseSucceed(() => null),
    );

  /** The oldest mid-submission manual record for this account, if any. */
  const readPendingManualExecution = (accountId: string) =>
    Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      const rows = yield* sql<{
        readonly cloid: string;
        readonly action_type: string;
        readonly status: string;
        readonly updated_at: number;
      }>`
        SELECT cloid, action_type, status, updated_at FROM trading_execution_records
        WHERE mission_id IS NULL AND account_id = ${accountId}
          AND ${sql.in("status", PENDING_EXECUTION_STATUSES)}
        ORDER BY updated_at ASC
        LIMIT 1
      `;
      const row = rows[0];
      if (row === undefined) return null;
      return {
        cloid: row.cloid,
        actionType: row.action_type,
        status: row.status,
        ageMillis: Math.max(0, nowMs - row.updated_at),
      };
    }).pipe(Effect.orElseSucceed(() => null));

  /**
   * The keyless preview's one line: the honest refusal, carrying whatever the
   * public book can still say about the ticket.
   *
   * The quote is best-effort by construction, an unreadable book costs the
   * numbers, never the sentence. The sentence is the part the user needs.
   */
  const describeKeylessQuote = (request: ManualEntryRequest): Effect.Effect<string> =>
    Effect.gen(function* () {
      const refusal =
        "no trading signer is configured on this environment, so this order would be refused; " +
        "charts, watchlists, alerts, backtests and validations all work without one";
      const book = yield* Effect.suspend(() => gateway.getOrderBook(request.market)).pipe(
        Effect.catchCause(() => Effect.succeed(null)),
      );
      const bestBid = book?.bestBidOffer.bidPrice;
      const bestAsk = book?.bestBidOffer.askPrice;
      if (bestBid === undefined || bestAsk === undefined) return refusal;
      const fillNear = request.side === "buy" ? bestAsk : bestBid;
      return (
        `${refusal}. The book quotes ${request.market} bid ${bestBid} ask ${bestAsk}, so a ` +
        `${request.side} now would fill near ${fillNear}`
      );
    });

  const prepare: TradingManualEntryService["Service"]["prepare"] = (request, options) =>
    Effect.gen(function* () {
      // The stop is the contract. Checked first, before any network read.
      if (!(request.stopPrice > 0)) {
        return refused(
          "valid_stop_defined",
          "a manual entry requires a stop price; every position this ticket opens is protected or not placed",
        );
      }

      // --- D4, manual side: a mission holds this market -------------------
      // The ownership read is the gate: a failed read refuses before any
      // network or exchange call, because "could not read who holds it" must
      // never be answered as "nobody holds it" (06B).
      const ownershipRead = yield* findActiveMissionOnMarket(request.market).pipe(
        Effect.map(
          (
            row,
          ): {
            readonly owner: { readonly mission_id: string; readonly status: string } | null;
          } => ({ owner: row }),
        ),
        Effect.orElseSucceed(() => ({ owner: null, readFailed: true as const })),
      );
      if ("readFailed" in ownershipRead) {
        return refused(
          "market_data_unavailable",
          "held-market ownership could not be read; retry once — nothing was prepared or submitted",
        );
      }
      const owningMission = ownershipRead.owner;
      if (owningMission !== null) {
        return refused(
          "market_owned_by_mission",
          `mission ${owningMission.mission_id} (${owningMission.status}) holds the ` +
            `${request.market} authority; pause or revoke it before trading this market by hand`,
        );
      }

      // No `trading_accounts` row means no signer is armed on this
      // environment. Preview is a pure read and used to die here on a generic
      // RPC error, which told the user nothing; it degrades instead. What it
      // can still say comes from the public book, the side of the market this
      // ticket would take and where it would fill, and what it cannot is that
      // the order itself would be refused. Placement's own refusal is unchanged.
      const resolvedAddress = yield* missions
        .getMasterWalletAddress(request.accountId)
        .pipe(Effect.catchTag("TradingMissionNotFoundError", () => Effect.succeed(null)));
      if (resolvedAddress === null) {
        return refused("no_trading_signer", yield* describeKeylessQuote(request));
      }
      const masterAddress = resolvedAddress;

      // Canonical account state, read fresh: the policy scales off the live
      // account value, and the margin bound and gross-notional aggregate both
      // come from the same snapshot.
      const snapshot = yield* retryTransientRead(
        gateway.getAccountSnapshot(masterAddress),
        "manualEntry.getAccountSnapshot",
      );
      const policy: AccountTradingPolicy = resolveAccountPolicy(process.env, snapshot.accountValue);
      const existingNotionalUsd = snapshot.positions.reduce(
        (sum, position) => sum + Math.abs(position.size) * position.entryPrice,
        0,
      );
      // What the exchange account can fund: account value at the leverage this
      // market is configured at (1x when it has never held the market — the
      // floor no account is below, same reasoning as `AccountMarginCapacity`).
      const openPositionLeverage =
        snapshot.positions.find((position) => position.market === request.market)?.leverage ?? null;
      const marketLeverage = openPositionLeverage ?? 1;
      const accountMarginCapacityUsd =
        snapshot.accountValue > 0 ? snapshot.accountValue * marketLeverage : null;

      const fallbackFeeBps = policy.riskPolicy.fallbackTakerFeeBpsPerSide;
      const feeRate = yield* gateway.getUserFeeRatesBps(masterAddress).pipe(
        Effect.orElseSucceed(() => ({
          takerFeeBps: fallbackFeeBps,
          makerFeeBps: fallbackFeeBps,
        })),
      );

      const orderBook = yield* retryTransientRead(
        gateway.getOrderBook(request.market),
        "manualEntry.getOrderBook",
      );
      const resolved = yield* retryTransientRead(
        gateway.resolveMarket(request.market),
        "manualEntry.resolveMarket",
      );

      const urgency = request.urgency ?? "now";
      const orderPreference = urgencyToOrderPreference(urgency);
      const bbo = orderBook.bestBidOffer;
      const bestBid = bbo.bidPrice;
      const bestAsk = bbo.askPrice;
      if (bestBid === undefined || bestAsk === undefined) {
        return refused(
          "market_data_unavailable",
          `${request.market} has no two-sided book right now; retry once`,
        );
      }
      const limitPrice = deriveEntryLimitPrice({
        side: request.side,
        orderPreference,
        bestBid,
        bestAsk,
        slippageBps: (yield* iocSlippage.resolve).entryBps,
      });
      const entryPrice = request.side === "buy" ? bestAsk : bestBid;

      // R6-2/R2-5: the entry inherits the account's per-asset margin mode and
      // leverage — this service never sets either on the exchange — so the
      // mandatory stop must sit on the survivable side of the liquidation
      // that inheritance implies. A stop at or beyond the estimate protects
      // nothing: the exchange liquidates before the stop can fire. The
      // estimate is deliberately conservative (isolated at full utilisation),
      // so the ambiguous band refuses.
      const configuredLeverage =
        openPositionLeverage ??
        (yield* readLastKnownMarketLeverage(request.accountId, request.market)) ??
        1;
      const estimatedLiquidationPrice = estimateIsolatedLiquidationPrice({
        side: request.side,
        entryPrice,
        leverage: configuredLeverage,
        maxLeverage: resolved.maxLeverage,
      });
      const stopBeyondLiquidation =
        estimatedLiquidationPrice !== null &&
        (request.side === "buy"
          ? request.stopPrice <= estimatedLiquidationPrice
          : request.stopPrice >= estimatedLiquidationPrice);
      if (stopBeyondLiquidation) {
        const liquidationText = Number(estimatedLiquidationPrice.toPrecision(6));
        return refused(
          "stop_beyond_liquidation",
          `the stop at ${request.stopPrice} cannot protect this entry: at the account's ` +
            `inherited ${configuredLeverage}x ${request.market} leverage the liquidation is ` +
            `estimated near ${liquidationText}, ${request.side === "buy" ? "above" : "below"} the stop — ` +
            `the exchange would liquidate before the stop fires. Reduce this market's leverage ` +
            `on the exchange or move the stop ${request.side === "buy" ? "above" : "below"} ${liquidationText}`,
        );
      }

      const requestedSize =
        request.sizeEth ??
        (request.notionalUsd === undefined ? undefined : request.notionalUsd / entryPrice);

      const sizing = deriveFeasibleSize({
        side: request.side,
        entryPrice,
        stopPrice: request.stopPrice,
        requestedSize,
        szDecimals: resolved.szDecimals,
        existingNotionalUsd,
        allocatedCapitalUsd: policy.accountValueUsd,
        maximumLeverage: policy.maximumLeverage,
        maximumGrossNotionalUsd: policy.maximumPositionNotionalUsd,
        ...(accountMarginCapacityUsd === null ? {} : { accountMarginCapacityUsd }),
        maximumPlannedRiskPerPositionUsd: policy.perTradeLossBudgetUsd,
        // Manual trading carries no cumulative budget; the per-trade budget
        // bounds the all-in reservation of THIS ticket instead.
        remainingCumulativeLossUsd: policy.perTradeLossBudgetUsd,
        takerFeeBpsPerSide: feeRate.takerFeeBps,
        stopSlippageReserveBps: policy.riskPolicy.stopSlippageReserveBps,
        minimumNotionalUsd: MIN_NOTIONAL_USD,
      });

      if (!sizing.feasible) {
        return refused(sizing.constrainedBy, sizing.detail, sizing.size);
      }

      const executionSequence =
        options?.allocateSequence === true
          ? yield* allocateManualExecutionSequence(sql, request.accountId)
          : 0;

      const intent: TradingOrderIntent = {
        missionId: manualOwnerMissionToken(request.accountId),
        executionSequence,
        actionType: "open",
        market: request.market,
        side: request.side,
        size: sizing.size,
        orderPreference,
        limitPrice,
        stop: {
          stopPrice: request.stopPrice,
          plannedLossAtStopUsd: sizing.plannedLossAtStopUsd,
        },
        reduceOnly: false,
      };

      // The manual checklist, against the same state the submit will read.
      const nowMs = yield* Clock.currentTimeMillis;
      const verdict = yield* previewManualOrder(intent, {
        policy,
        // Same interim-signer stand-in the mission preview uses at prepare
        // time; the real armed-signer gate runs again inside the submit.
        approvedExecutionWalletAddress: "prepare",
        bbo,
        accountObservedAt: snapshot.freshness.observedAt,
        pendingExecution: yield* readPendingManualExecution(request.accountId),
        existingNotionalUsd,
        takerFeeRateBps: feeRate.takerFeeBps,
        stopSlippageReserveBps: policy.riskPolicy.stopSlippageReserveBps,
        nowMs,
      }).pipe(
        Effect.map(() => null),
        Effect.catch((rejection) => Effect.succeed(rejection)),
      );
      if (verdict !== null) {
        return refused(verdict.item, verdict.detail, sizing.size);
      }

      const costs = yield* estimator
        .estimate({
          market: request.market,
          masterAddress,
          sizeEth: sizing.size,
          fallbackTakerFeeBpsPerSide: fallbackFeeBps,
        })
        .pipe(
          Effect.provideService(HyperliquidGateway, gateway),
          Effect.orElseSucceed(() => null),
        );

      const notes: Array<string> = [];
      if (sizing.constrainedBy !== "requested") {
        notes.push(sizing.detail);
      }
      if (costs === null) {
        notes.push("the round-trip cost could not be read; estimatedRoundTripCostUsd is 0");
      }

      const reservedRiskUsd =
        sizing.plannedLossAtStopUsd +
        sizing.notionalUsd * ((feeRate.takerFeeBps / 10_000) * 2) +
        sizing.notionalUsd * (policy.riskPolicy.stopSlippageReserveBps / 10_000);

      return {
        outcome: "prepared" as const,
        accountId: request.accountId,
        intent,
        size: sizing.size,
        constrainedBy: sizing.constrainedBy,
        feasibleSize: sizing.ceilingSize,
        notionalUsd: sizing.notionalUsd,
        plannedLossAtStopUsd: sizing.plannedLossAtStopUsd,
        reservedRiskUsd,
        estimatedRoundTripCostUsd: costs?.roundTripUsd ?? 0,
        notes,
      } satisfies PreparedManualEntry;
    }).pipe(
      // A dropped read refuses with a retry hint rather than killing the RPC:
      // same convention as the mission entry path.
      Effect.catchCause((cause) =>
        Effect.logWarning("trading manual entry could not be prepared", {
          cause: String(cause),
        }).pipe(
          Effect.as(
            refused(
              "market_data_unavailable",
              "the account, book, or market state a manual entry is made of could not be read; retry once",
            ),
          ),
        ),
      ),
    );

  return TradingManualEntryService.of({ prepare });
});

export const TradingManualEntryServiceLive = Layer.effect(
  TradingManualEntryService,
  makeTradingManualEntryService,
);
