/**
 * The ledger of orders the SERVER rests on a position — plan 34 step 5.
 *
 * The take-profit reconcile used to place a reduce-only ALO at the plan's
 * target and replace it whenever the target moved. Those orders existed only
 * on the exchange: no execution record, no event, no row. So when one filled,
 * the position simply shrank between two wakes with nothing anywhere to say
 * why — and on the mission this was found on, the model attributed the
 * server's own profit-taking to the give-back watch it had armed itself.
 *
 * Plan 36 item 6 stopped resting them: a target is a wake now, not an order,
 * so nothing new is placed and the ledger no longer inserts. What remains is
 * the retirement half — a pass that cancels a
 * leftover, or observes the position flat, writes that down — and
 * {@link readTakeProfitOrders}, which tells the fill reconciler which cloids
 * were the server's, so a fill against one an older build rested still becomes
 * an event the next wake carries.
 *
 * Bookkeeping, never protection. Nothing here gates anything, and a write that
 * fails costs the attribution and nothing else.
 *
 * @module TradingProtectionLedger
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PROTECTION_SIZE_EPSILON } from "@t3tools/trading-contracts/protection";

/** One order the server rested, as the ledger holds it. */
export interface ProtectionOrderRow {
  readonly cloid: string;
  readonly kind: string;
  readonly size: number;
  readonly limit_price: number;
  readonly placed_at: number;
  readonly retired_at: number | null;
}

/** What one take-profit reconcile pass did to the resting orders. */
export interface TakeProfitLedgerInput {
  readonly missionId: string;
  readonly market: string;
  /** Signed canonical position size at the start of the pass. */
  readonly positionSize: number;
  /** Orders this pass withdrew or superseded. */
  readonly cancelledCloids: ReadonlyArray<string>;
}

/**
 * Record a reconcile pass: the rows it retired.
 *
 * Only retirement — the pass places nothing, so the ledger writes nothing
 * new. A pass that observed the position flat retires every live row; one
 * that cancelled leftovers retires exactly those cloids.
 */
export const recordTakeProfitOutcome = (
  input: TakeProfitLedgerInput,
): Effect.Effect<void, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const at = yield* Effect.clockWith((clock) => clock.currentTimeMillis);

    const flat = Math.abs(input.positionSize) <= PROTECTION_SIZE_EPSILON;

    // The position is gone, so every order the server was resting on it is
    // gone with it — whether this pass managed to cancel it or the exchange
    // retired it alongside the position.
    if (flat) {
      yield* sql`
        UPDATE trading_protection_orders SET retired_at = ${at}
        WHERE mission_id = ${input.missionId} AND kind = 'take_profit'
          AND retired_at IS NULL
      `;
    }

    if (input.cancelledCloids.length > 0) {
      yield* sql`
        UPDATE trading_protection_orders SET retired_at = ${at}
        WHERE mission_id = ${input.missionId}
          AND ${sql.in("cloid", input.cancelledCloids)}
      `;
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("could not record a take-profit in the protection ledger", {
        missionId: input.missionId,
        cause,
      }),
    ),
  );

/**
 * Every take-profit this mission's server side has rested, retired ones
 * included.
 *
 * Retired rows stay in the answer on purpose: a fill arrives on the pass AFTER
 * the order it filled against was replaced, and an order that is gone is
 * exactly the one whose fill needs explaining.
 */
export const readTakeProfitOrders = (
  missionId: string,
): Effect.Effect<ReadonlyArray<ProtectionOrderRow>, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<ProtectionOrderRow>`
      SELECT cloid, kind, size, limit_price, placed_at, retired_at
      FROM trading_protection_orders
      WHERE mission_id = ${missionId} AND kind = 'take_profit'
    `;
  }).pipe(Effect.orElseSucceed(() => []));
