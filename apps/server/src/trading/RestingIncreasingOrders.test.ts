/**
 * RestingIncreasingOrders — the shared read + best-effort cancel (RC03).
 *
 * Two properties are worth proving in isolation, because every safety path
 * (§16.4 exhaustion, §17.5 emergency close, cancel-entries, RC01 finalization)
 * inherits them:
 *
 *   1. The read returns exactly the mission's resting position-increasing
 *      orders — never a reduce-only order, never a server-rested protective
 *      stop (which has no execution record to join on).
 *
 *   2. The cancel pass reports acknowledged cloids only. A failed or
 *      unconfirmable cancel never inflates the acknowledged list, and it never
 *      stops the remaining entries from being attempted.
 */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import {
  HyperliquidExecutionService,
  TradingExecutionError,
} from "./HyperliquidExecutionService.ts";
import { cancelOrdersBestEffort, readRestingIncreasingOrders } from "./RestingIncreasingOrders.ts";

const MISSION = "mission_resting";

/**
 * An execution service whose cancel answers a fixed rejection list: every cloid
 * on the list fails typed, everything else is acknowledged.
 */
const executionLayer = (rejected: ReadonlyArray<string>) =>
  Layer.succeed(HyperliquidExecutionService, {
    submitCancel: (input: { cloid: string }) =>
      Effect.suspend(() => {
        if (rejected.includes(input.cloid)) {
          return Effect.fail(
            new TradingExecutionError({ stage: "inspect_failed", detail: "rejected by exchange" }),
          );
        }
        return Effect.void;
      }),
    submitOrder: () => Effect.die("not used"),
    submitProtectiveStop: () => Effect.die("not used"),
  } as unknown as HyperliquidExecutionService["Service"]);

/** Seed one resting order plus the execution record that names its action. */
let seededSequence = 0;
const seedOrder = (
  cloid: string,
  actionType: string | null,
  reduceOnly: number,
  market = "ETH",
): Effect.Effect<void, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO trading_orders (
        mission_id, cloid, order_id, market, side, limit_price,
        remaining_size, reduce_only, observed_at
      ) VALUES (${MISSION}, ${cloid}, 1, ${market}, 'buy', 3000, 0.5, ${reduceOnly}, 0)
    `;
    if (actionType === null) return;
    const sequence = seededSequence++;
    yield* sql`
      INSERT INTO trading_execution_records (
        execution_id, mission_id, execution_sequence, action_type,
        cloid, idempotency_key, market, side, size, limit_price, time_in_force,
        reduce_only, signer_address, status, order_results_json, created_at, updated_at
      ) VALUES (
        ${`exec_${cloid}`}, ${MISSION}, ${sequence}, ${actionType}, ${cloid}, ${`idem_${cloid}`},
        ${market}, 'buy', 0.5, 3000, 'gtc', ${reduceOnly}, '0xsigner', 'accepted', '[]', 0, 0
      )
    `;
  }).pipe(Effect.orDie);

const runRead = (seed: Effect.Effect<void, never, SqlClient.SqlClient>) =>
  Effect.gen(function* () {
    yield* runMigrations({});
    yield* seed;
    return yield* readRestingIncreasingOrders(MISSION);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory()));

it.effect("read returns only increasing, non-reduce-only, execution-recorded orders", () =>
  Effect.gen(function* () {
    const rows = yield* runRead(
      Effect.gen(function* () {
        yield* seedOrder("0xentry", "open", 0);
        yield* seedOrder("0xscale", "scale_in", 0);
        // Reduce-only rows are the protection — never a cancellation candidate.
        yield* seedOrder("0xstop", "open", 1);
        // Non-increasing action types cannot grow the position.
        yield* seedOrder("0xclose", "close", 0);
        yield* seedOrder("0xcancel", "cancel", 0);
        // A server-rested protective stop has an order row but no execution
        // record; the JOIN must keep it invisible so no safety path ever
        // submits the stop itself for cancellation.
        yield* seedOrder("0xrested-stop", null, 0);
      }),
    );

    assert.deepEqual(
      rows.map((row) => row.cloid),
      ["0xentry", "0xscale"],
    );
  }),
);

it.effect("a failed read surfaces the failure rather than an empty list", () =>
  Effect.gen(function* () {
    const failure = yield* Effect.flip(
      Effect.gen(function* () {
        yield* runMigrations({});
        // The read's table is gone: the failure must surface typed rather
        // than degrade to "nothing to cancel" — an empty list here would let
        // every caller claim there is nothing that could reopen exposure.
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DROP TABLE trading_orders`;
        return yield* readRestingIncreasingOrders(MISSION);
      }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
    );
    assert.ok(failure !== undefined);
  }),
);

it.effect("cancel pass acknowledges every cloid when the exchange confirms each one", () =>
  Effect.gen(function* () {
    const report = yield* cancelOrdersBestEffort({
      orders: [
        { cloid: "0xa", market: "ETH" },
        { cloid: "0xb", market: "BTC" },
      ],
      logContext: "test",
    }).pipe(Effect.provide(executionLayer([])));

    assert.deepEqual(report.acknowledged, ["0xa", "0xb"]);
    assert.deepEqual(report.unconfirmed, []);
  }),
);

it.effect("a failed cancel never inflates the acknowledged list and never stops the pass", () =>
  Effect.gen(function* () {
    // First fails, second succeeds: both were attempted, and only the second
    // is acknowledged. This is the shape every caller's "N cancelled" claim
    // is built from — an inflated list here becomes a false safety fact there.
    const report = yield* cancelOrdersBestEffort({
      orders: [
        { cloid: "0xa", market: "ETH" },
        { cloid: "0xb", market: "BTC" },
        { cloid: "0xc", market: "SOL" },
      ],
      logContext: "test",
    }).pipe(Effect.provide(executionLayer(["0xa", "0xc"])));

    assert.deepEqual(report.acknowledged, ["0xb"]);
    assert.deepEqual(
      report.unconfirmed.map((entry) => entry.cloid),
      ["0xa", "0xc"],
    );
    assert.ok(report.unconfirmed.every((entry) => entry.reason.length > 0));
  }),
);

it.effect("a fully failed pass reports an empty acknowledged list, not a count", () =>
  Effect.gen(function* () {
    const report = yield* cancelOrdersBestEffort({
      orders: [
        { cloid: "0xa", market: "ETH" },
        { cloid: "0xb", market: "BTC" },
      ],
      logContext: "test",
    }).pipe(Effect.provide(executionLayer(["0xa", "0xb"])));

    assert.deepEqual(report.acknowledged, []);
    assert.equal(report.unconfirmed.length, 2);
  }),
);
