import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import {
  ACCOUNT_MARGIN_HEADROOM_BPS,
  readAccountMarginCapacityUsd,
} from "./AccountMarginCapacity.ts";

const layer = NodeSqliteClient.layer({ filename: ":memory:" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

/** The account value from the live rejection: $857.2857 at 1x. */
const ACCOUNT_VALUE = 857.2857;

const seed = (input: { readonly accountValue: number; readonly leverage?: number | undefined }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({});
    yield* sql`
      INSERT INTO trading_account_observations (mission_id, account_value, observed_at)
      VALUES ('m1', ${input.accountValue}, 1)
    `;
    if (input.leverage !== undefined) {
      yield* sql`
        INSERT INTO trading_position_snapshots (
          mission_id, market, size, entry_price, unrealised_pnl, margin_used,
          protected_size, observed_at, leverage
        ) VALUES ('m1', 'ETH', 0, NULL, 0, 0, 0, 1, ${input.leverage})
      `;
    }
    return sql;
  });

it.effect("leaves headroom under the venue's rejection line", () =>
  Effect.gen(function* () {
    const sql = yield* seed({ accountValue: ACCOUNT_VALUE });
    const capacity = yield* readAccountMarginCapacityUsd(sql, {
      missionId: "m1",
      market: "ETH",
    });

    // The order that was rejected. Sizing to `account_value * leverage` put
    // it four cents under the account value and the venue still refused it.
    assert.isNotNull(capacity);
    assert.isBelow(capacity!, 857.246);
    assert.strictEqual(capacity, ACCOUNT_VALUE * (1 - ACCOUNT_MARGIN_HEADROOM_BPS / 10_000));
  }).pipe(Effect.provide(layer)),
);

it.effect("reserves the headroom out of the levered capacity too", () =>
  Effect.gen(function* () {
    const sql = yield* seed({ accountValue: 1_000, leverage: 5 });
    const capacity = yield* readAccountMarginCapacityUsd(sql, {
      missionId: "m1",
      market: "ETH",
    });

    assert.strictEqual(capacity, 5_000 * (1 - ACCOUNT_MARGIN_HEADROOM_BPS / 10_000));
  }).pipe(Effect.provide(layer)),
);

it.effect("reads null when there is no account value, rather than a headroom of nothing", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({});
    const capacity = yield* readAccountMarginCapacityUsd(sql, {
      missionId: "m1",
      market: "ETH",
    });

    assert.strictEqual(capacity, null);
  }).pipe(Effect.provide(layer)),
);
