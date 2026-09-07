/**
 * A mission's resting position-increasing orders: one read and one
 * best-effort cancel, shared by the three paths that must take entries off
 * the book — §16.4 exhaustion (`TradingExecutionGuard`), §17.5 emergency
 * close (`TradingEmergencyCloseService`), the cancel-entries control
 * (`TradingControlService`), and RC01's mission finalization. They were three
 * near-identical copies of the same SQL and the same cancel loop, each free
 * to drift from the others.
 *
 * "Increasing" is decided by the execution record's action type through
 * `isPositionIncreasing` — the same fail-closed rule the stop gate applies —
 * with `trading_orders.reduce_only = 0` as the belt. Server-rested protection
 * never writes an execution record, so the JOIN keeps it invisible here; a
 * protective stop is never submitted for cancellation by this module.
 *
 * @module RestingIncreasingOrders
 */
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { isPositionIncreasing } from "@t3tools/trading-contracts/protection";

import { HyperliquidExecutionService } from "./HyperliquidExecutionService.ts";

/** One resting order that could grow the position. */
export interface RestingIncreasingOrder {
  readonly cloid: string;
  readonly market: string;
  readonly action_type: string;
  /** The stop the record was authorised with, when it carries one. */
  readonly stop_price: number | null;
}

/**
 * What one best-effort cancellation pass actually achieved (RC03).
 *
 * `acknowledged` holds only cloids the exchange explicitly confirmed as
 * cancelled; `unconfirmed` holds everything else with the reason. A failed or
 * unconfirmable cancel never aborts the pass — the caller's flow (a block, a
 * close, a finalization) matters more than one cancel — but it is also never
 * rounded up into the acknowledged list.
 */
export interface CancellationReport {
  readonly acknowledged: ReadonlyArray<string>;
  readonly unconfirmed: ReadonlyArray<{
    readonly cloid: string;
    readonly reason: string;
  }>;
}

/**
 * Every mission-owned resting order whose fill would increase the position.
 * The SQL failure is surfaced for each caller to answer in its own channel —
 * the exhaustion block fails typed, the emergency close and the finalization
 * carry an explicit discovery-failed warning, and none of them may answer a
 * failed read as "nothing to cancel".
 */
export const readRestingIncreasingOrders = (missionId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<RestingIncreasingOrder>`
      SELECT DISTINCT o.cloid, o.market, e.action_type, e.stop_price
      FROM trading_orders o
      JOIN trading_execution_records e ON e.cloid = o.cloid
      WHERE o.mission_id = ${missionId}
        AND o.reduce_only = 0
    `;
    return rows.filter((row) => isPositionIncreasing(row.action_type));
  });

/**
 * Cancel each order by cloid, best-effort, and report what was actually
 * acknowledged. Every remaining entry is attempted even when one fails, each
 * failure is logged at warn with the cloid and the exchange's reason, and no
 * failed or unconfirmed cloid ever appears in the acknowledged list (RC03).
 */
export const cancelOrdersBestEffort = (input: {
  readonly orders: ReadonlyArray<{ readonly cloid: string; readonly market: string }>;
  /** Who is cancelling, for the warn line — e.g. "emergency close". */
  readonly logContext: string;
}): Effect.Effect<CancellationReport, never, HyperliquidExecutionService> =>
  Effect.gen(function* () {
    const execution = yield* HyperliquidExecutionService;
    const acknowledged: Array<string> = [];
    const unconfirmed: Array<{ readonly cloid: string; readonly reason: string }> = [];
    for (const order of input.orders) {
      const outcome = yield* execution
        .submitCancel({ market: order.market, cloid: order.cloid })
        .pipe(Effect.result);
      if (Result.isSuccess(outcome)) {
        acknowledged.push(order.cloid);
        continue;
      }
      const failure = outcome.failure;
      const reason =
        failure._tag === "TradingExecutionError"
          ? (failure.detail ?? failure.message)
          : String(failure);
      unconfirmed.push({ cloid: order.cloid, reason });
      yield* Effect.logWarning(
        `${input.logContext}: could not confirm the cancellation of increasing order ` +
          `${order.cloid} (${order.market}): ${reason}`,
      );
    }
    return { acknowledged, unconfirmed };
  });
