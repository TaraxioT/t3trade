import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import {
  readTakeProfitOrders,
  recordTakeProfitOutcome,
  type ProtectionOrderRow,
} from "./TradingProtectionLedger.ts";

const layer = it.layer(NodeSqliteClient.layerMemory());

const MISSION = "mission_ledger";
const CLOID = "c105e".padEnd(32, "0");

/** Migrate the shared in-memory database and start each test from empty. */
const migrated = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({});
  yield* sql`DELETE FROM trading_protection_orders`;
});

/**
 * Plan 36 item 6 retired the placement lane, so the ledger only ever retires
 * rows now. The rows themselves come from older builds; the tests seed them
 * directly.
 */
layer("TradingProtectionLedger", (it) => {
  const seedRow = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO trading_protection_orders (
        cloid, mission_id, market, kind, size, limit_price, placed_at
      ) VALUES (${CLOID}, ${MISSION}, 'ETH', 'take_profit', 0.01, 1896.75, 1000)
    `;
  });

  it.effect("writes nothing of its own — a pass over a live position leaves the ledger alone", () =>
    Effect.gen(function* () {
      yield* migrated;
      yield* recordTakeProfitOutcome({
        missionId: MISSION,
        market: "ETH",
        positionSize: -0.01,
        cancelledCloids: [],
      });

      assert.deepStrictEqual(
        [...(yield* readTakeProfitOrders(MISSION))],
        [] as ProtectionOrderRow[],
      );
    }),
  );

  it.effect("retires the rows a pass cancelled", () =>
    Effect.gen(function* () {
      yield* migrated;
      yield* seedRow;
      yield* recordTakeProfitOutcome({
        missionId: MISSION,
        market: "ETH",
        positionSize: -0.01,
        cancelledCloids: [CLOID],
      });

      const rows = yield* readTakeProfitOrders(MISSION);
      assert.equal(rows.length, 1);
      assert.isNotNull(rows[0]?.retired_at);
    }),
  );

  it.effect("retires an order still standing when the position is observed flat", () =>
    Effect.gen(function* () {
      yield* migrated;
      yield* seedRow;

      // A pass finds the mission flat. It cancelled nothing — the exchange
      // retires reduce-only orders with the position — but the row must not
      // go on claiming the order is resting.
      yield* recordTakeProfitOutcome({
        missionId: MISSION,
        market: "ETH",
        positionSize: 0,
        cancelledCloids: [],
      });

      const rows = yield* readTakeProfitOrders(MISSION);
      assert.equal(rows.length, 1);
      assert.isNotNull(rows[0]?.retired_at);
    }),
  );
});
