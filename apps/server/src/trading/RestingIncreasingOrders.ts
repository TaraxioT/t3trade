/**
 * A mission's resting position-increasing orders: one read and one
 * best-effort cancel, shared by the three paths that must take entries off
 * the book — §16.4 exhaustion (`TradingExecutionGuard`), §17.5 emergency
 * close (`TradingEmergencyCloseService`), and the cancel-entries control
 * (`TradingControlService`). They were three near-identical copies of the
 * same SQL and the same cancel loop, each free to drift from the others.
 *
 * "Increasing" is decided by the execution record's action type through
 * `isPositionIncreasing` — the same fail-closed rule the stop gate applies —
 * with `trading_orders.reduce_only = 0` as the belt. Server-rested protection
 * never writes an execution record, so the JOIN keeps it invisible here.
 *
 * @module RestingIncreasingOrders
 */
import * as Effect from "effect/Effect";
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
 * Every mission-owned resting order whose fill would increase the position.
 * The SQL failure is surfaced — each caller decides whether a failed read
 * fails its flow (exhaustion does) or degrades to "nothing to cancel"
 * (the emergency close does).
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
 * Cancel each order by cloid, best-effort. A failed cancel never aborts the
 * pass — the caller's flow (a block, a close) matters more than one cancel,
 * and the reconciler catches a still-resting order on its next convergence —
 * but it is logged at warn with the cloid, never swallowed silently.
 */
export const cancelOrdersBestEffort = (input: {
  readonly orders: ReadonlyArray<{ readonly cloid: string; readonly market: string }>;
  /** Who is cancelling, for the warn line — e.g. "emergency close". */
  readonly logContext: string;
}) =>
  Effect.gen(function* () {
    const execution = yield* HyperliquidExecutionService;
    for (const order of input.orders) {
      yield* execution
        .submitCancel({ market: order.market, cloid: order.cloid })
        .pipe(
          Effect.catchTag("TradingExecutionError", (cause) =>
            Effect.logWarning(
              `${input.logContext}: could not cancel increasing order ` +
                `${order.cloid} (${order.market}): ${cause.message}`,
            ),
          ),
        );
    }
  });
