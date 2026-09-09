/**
 * Migration 079 — the held-set table — and its chain context (11A).
 *
 * Two scopes, both against the real migration bodies over a fresh in-memory
 * database: the whole chain from empty (head assertions, including that the
 * old one-column exclusivity index is gone), and a representative legacy
 * upgrade that stops at 078 with live mission rows, then runs to head and
 * proves the backfill: active missions hold their market, terminals release
 * theirs, a re-run duplicates nothing, and the UNIQUE held index is the
 * exclusivity constraint that answers inserts.
 */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const HELD_INDEX = "idx_trading_mission_markets_held";
const LOOKUP_INDEX = "idx_trading_mission_markets_mission";
const OLD_INDEX = "idx_trading_missions_one_active_per_market";

const seedLegacyMission = (
  missionId: string,
  market: string,
  status: string,
  createdAt: number,
  updatedAt: number,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO trading_missions (
        mission_id, user_id, trading_account_id, instruction, market,
        harness_json, status, control_json, authority_version, version,
        created_at, updated_at, venue
      ) VALUES (
        ${missionId}, 'local', 'acct_1', 'trade', ${market}, '{}', ${status},
        '{}', 1, 1, ${createdAt}, ${updatedAt}, 'hyperliquid'
      )
    `;
  }).pipe(Effect.orDie);

it.effect("the whole chain from empty reaches head with the held-set indexes", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const executed = yield* runMigrations({});
    assert.isTrue(executed.length > 0);

    const indexes = yield* sql<{ readonly name: string; readonly sql: string | null }>`
      SELECT name, sql FROM sqlite_master WHERE type = 'index'
    `;
    const held = indexes.find((row) => row.name === HELD_INDEX);
    assert.isDefined(held, "the UNIQUE held-set index exists at head");
    assert.include(held?.sql ?? "", "UNIQUE");
    assert.include(held?.sql ?? "", "released_at IS NULL");
    assert.isTrue(indexes.some((row) => row.name === LOOKUP_INDEX));
    assert.isFalse(
      indexes.some((row) => row.name === OLD_INDEX),
      "the pre-079 exclusivity index is dropped at head",
    );

    // A re-run of the whole chain is a no-op.
    const again = yield* runMigrations({});
    assert.equal(again.length, 0);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect(
  "a v078 database upgrades to head: active missions hold, terminals release, nothing duplicates",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // Stop before 079 with live rows in the one-column world.
      yield* runMigrations({ toMigrationInclusive: 78 });
      yield* seedLegacyMission("m_active", "ETH", "position_open", 1, 1);
      yield* seedLegacyMission("m_done", "ETH", "completed", 2, 5);
      yield* seedLegacyMission("m_other_market", "BTC", "analysing", 3, 3);

      // Run to head: the backfill writes the held set from those rows.
      yield* runMigrations({});

      const rows = yield* sql<{
        readonly mission_id: string;
        readonly market: string;
        readonly released_at: number | null;
      }>`
        SELECT mission_id, market, released_at FROM trading_mission_markets
        ORDER BY mission_id
      `;
      const active = rows.find((row) => row.mission_id === "m_active");
      assert.isDefined(active, "the active mission was backfilled");
      assert.equal(active?.market, "ETH");
      assert.isNull(active?.released_at, "an active mission holds its market");
      const done = rows.find((row) => row.mission_id === "m_done");
      assert.isNotNull(done?.released_at, "a terminal mission's row is released history");
      assert.equal(rows.filter((row) => row.mission_id === "m_other_market").length, 1);

      // Re-running the chain duplicates nothing.
      yield* runMigrations({});
      const recount = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM trading_mission_markets
      `;
      assert.equal(recount[0]?.n, rows.length);

      // The UNIQUE held index is the live exclusivity constraint.
      const heldRows = yield* sql<{ readonly market: string }>`
        SELECT market FROM trading_mission_markets
        WHERE user_id = 'local' AND venue = 'hyperliquid' AND released_at IS NULL
      `;
      assert.deepEqual(heldRows.map((row) => row.market).sort(), ["BTC", "ETH"]);
      const clash = yield* sql`
        INSERT INTO trading_mission_markets (
          mission_id, user_id, venue, market, bound_at, released_at
        ) VALUES ('m_clash', 'local', 'hyperliquid', 'ETH', 9, NULL)
      `.pipe(
        Effect.as("inserted"),
        Effect.orElseSucceed(() => "refused"),
      );
      assert.equal(clash, "refused", "a second live holder of ETH is rejected");

      // A released row permits the market to be retaken; different markets coexist.
      yield* sql`
        UPDATE trading_mission_markets SET released_at = 10
        WHERE mission_id = 'm_active' AND released_at IS NULL
      `;
      yield* sql`
        INSERT INTO trading_mission_markets (
          mission_id, user_id, venue, market, bound_at, released_at
        ) VALUES ('m_retake', 'local', 'hyperliquid', 'ETH', 11, NULL)
      `;
      const retake = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM trading_mission_markets
        WHERE user_id = 'local' AND market = 'ETH' AND released_at IS NULL
      `;
      assert.equal(retake[0]?.n, 1, "a released market can be held again");
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
