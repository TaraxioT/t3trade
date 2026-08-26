import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { TradingMissionService, TradingMissionServiceLive } from "./TradingMissionService.ts";
import type { TradingHarnessBinding } from "./Schemas.ts";

const layer = it.layer(
  TradingMissionServiceLive.pipe(Layer.provideMerge(NodeSqliteClient.layerMemory())),
);

const harness: TradingHarnessBinding = {
  provider: "claude",
  providerInstanceId: "instance_1",
  threadId: "thread_1",
  status: "available",
};

const createInput = (overrides?: { readonly missionId?: string; readonly userId?: string }) => ({
  missionId: overrides?.missionId ?? "mission_1",
  userId: overrides?.userId ?? "user_1",
  tradingAccountId: "acct_1",
  instruction: "Trade ETH momentum",
  allocatedCapitalUsd: 1_000,
  harness,
});

/**
 * it.layer shares one in-memory database across the suite, so each test starts
 * by migrating and then truncating the trading tables.
 */
const migrated = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations();
  yield* sql`DELETE FROM trading_missions`;
  yield* sql`DELETE FROM trading_authority_versions`;
});

/**
 * Every table `deleteMission` claims to clear, with one row per mission.
 *
 * Written as data rather than as fifteen inserts so a table added to the
 * delete without being added here fails loudly on the count, and a table added
 * to the schema without being added to the delete fails on the assertion.
 */
interface ColumnInfo {
  readonly name: string;
  readonly type: string;
  readonly notnull: number;
  readonly dflt_value: string | null;
}

/** Every table in the live schema carrying a `mission_id` column. */
const missionScopedTables = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const tables = yield* sql.unsafe<{ readonly name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    );
    const scoped: Array<string> = [];
    for (const { name } of tables) {
      const columns = yield* sql.unsafe<ColumnInfo>(`PRAGMA table_info(${name})`);
      if (columns.some((column) => column.name === "mission_id")) scoped.push(name);
    }
    return scoped;
  });

/**
 * One row keyed to `mission_1`, with a schema-shaped value for every column the
 * table requires. The values are meaningless — the row exists to be deleted.
 */
const insertProbeRow = (sql: SqlClient.SqlClient, table: string) =>
  Effect.gen(function* () {
    const columns = yield* sql.unsafe<ColumnInfo>(`PRAGMA table_info(${table})`);
    const names: Array<string> = [];
    const values: Array<string> = [];
    for (const column of columns) {
      if (column.name === "mission_id") {
        names.push(column.name);
        values.push("'mission_1'");
        continue;
      }
      if (column.notnull === 0 || column.dflt_value !== null) continue;
      names.push(column.name);
      const type = column.type.toUpperCase();
      values.push(type.includes("INT") || type.includes("REAL") ? "0" : "'x'");
    }
    yield* sql.unsafe(`INSERT INTO ${table} (${names.join(", ")}) VALUES (${values.join(", ")})`);
  });

/** A durable `thread.deleted` event — the only evidence of orphanhood. */
const recordThreadDeleted = (sql: SqlClient.SqlClient, threadId: string) =>
  sql.unsafe(
    "INSERT INTO orchestration_events (" +
      "event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, " +
      "actor_kind, payload_json, metadata_json" +
      `) VALUES ('evt_${threadId}', 'thread', '${threadId}', 1, 'thread.deleted', ` +
      "'2026-01-01T00:00:00Z', 'user', '{}', '{}')",
  );

layer("TradingMissionService", (it) => {
  it.effect("creates an ETH momentum mission with the testnet authority defaults", () =>
    Effect.gen(function* () {
      yield* migrated;
      const service = yield* TradingMissionService;

      const mission = yield* service.createMission(createInput());

      assert.equal(mission.id, "mission_1");
      assert.equal(mission.market, "ETH");
      assert.equal(mission.status, "initializing");
      assert.equal(mission.authorityVersion, 1);
      assert.equal(mission.authority.allocatedCapitalUsd, 1_000);
      // The testnet preset, not the spec's $1,000 worked example: 8x capital
      // gross, 20x leverage ceiling. See `testnetAuthorityDefaults`.
      assert.equal(mission.authority.maximumGrossNotionalUsd, 8_000);
      assert.equal(mission.authority.maximumLeverage, 20);
      assert.equal(mission.authority.maximumCumulativeLossUsd, 350);
      assert.equal(mission.authority.maximumPlannedRiskPerPositionUsd, 70);
      assert.deepStrictEqual(mission.authority.marginModes, ["isolated"]);
      assert.equal(mission.harness.provider, "claude");
      assert.equal(mission.control.entriesAllowed, true);
    }),
  );

  it.effect("rejects a second active mission for the same user", () =>
    Effect.gen(function* () {
      yield* migrated;
      const service = yield* TradingMissionService;

      yield* service.createMission(createInput());

      const second = yield* Effect.result(
        service.createMission(createInput({ missionId: "mission_2" })),
      );

      assert.equal(second._tag, "Failure");
      if (second._tag === "Failure") {
        const error = second.failure;
        assert.equal(error._tag, "TradingMissionAlreadyActiveError");
        if (error._tag === "TradingMissionAlreadyActiveError") {
          assert.equal(error.activeMissionId, "mission_1");
          assert.equal(error.activeStatus, "initializing");
        }
      }
    }),
  );

  // The service's pre-insert check is a race away from being wrong: two
  // concurrent creates both read "no active mission" and both insert. The
  // partial unique index from migration 035 is what actually makes the
  // invariant true, so it is asserted against a raw insert that skips the
  // service entirely — the only way to prove the database, not the read, is
  // holding the line.
  it.effect("refuses a second active mission row at the database", () =>
    Effect.gen(function* () {
      yield* migrated;
      const service = yield* TradingMissionService;
      const sql = yield* SqlClient.SqlClient;

      yield* service.createMission(createInput());

      const smuggled = yield* Effect.result(sql`
        INSERT INTO trading_missions (
          mission_id, user_id, trading_account_id, instruction, market,
          harness_json, status, control_json,
          authority_version, version, created_at, updated_at
        ) VALUES (
          'mission_smuggled', 'user_1', 'acct_1', 'Trade ETH momentum', 'ETH',
          '{}', 'waiting', '{}', 1, 1, 0, 0
        )
      `);

      assert.equal(smuggled._tag, "Failure");

      // And the one mission that does hold the slot is still the one the
      // service reports, deterministically.
      const active = yield* service.findActiveMission("user_1");
      assert.ok(Option.isSome(active));
      assert.equal(Option.getOrThrow(active).id, "mission_1");
    }),
  );

  it.effect("allows a different user to hold their own active mission", () =>
    Effect.gen(function* () {
      yield* migrated;
      const service = yield* TradingMissionService;

      yield* service.createMission(createInput());
      const other = yield* service.createMission(
        createInput({ missionId: "mission_2", userId: "user_2" }),
      );

      assert.equal(other.userId, "user_2");
    }),
  );

  it.effect("frees the mission slot once the first mission reaches a terminal", () =>
    Effect.gen(function* () {
      yield* migrated;
      const service = yield* TradingMissionService;

      const first = yield* service.createMission(createInput());
      yield* service.transition({
        missionId: first.id,
        to: "completed",
        expectedVersion: 1,
      });

      const second = yield* service.createMission(createInput({ missionId: "mission_2" }));
      assert.equal(second.id, "mission_2");

      const active = yield* service.findActiveMission("user_1");
      assert.ok(Option.isSome(active));
      assert.equal(Option.getOrThrow(active).id, "mission_2");
    }),
  );

  it.effect("walks the published active loop", () =>
    Effect.gen(function* () {
      yield* migrated;
      const service = yield* TradingMissionService;

      yield* service.createMission(createInput());

      let version = 1;
      for (const to of ["analysing", "waiting", "executing", "position_open", "waiting"] as const) {
        const mission = yield* service.transition({
          missionId: "mission_1",
          to,
          expectedVersion: version,
        });
        assert.equal(mission.status, to);
        version += 1;
      }
    }),
  );

  it.effect("rejects an illegal transition", () =>
    Effect.gen(function* () {
      yield* migrated;
      const service = yield* TradingMissionService;
      yield* service.createMission(createInput());

      const result = yield* Effect.result(
        service.transition({ missionId: "mission_1", to: "position_open", expectedVersion: 1 }),
      );

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure._tag, "TradingMissionTransitionError");
      }
    }),
  );

  it.effect("persists the blocked reason and refuses blocked without one", () =>
    Effect.gen(function* () {
      yield* migrated;
      const service = yield* TradingMissionService;
      yield* service.createMission(createInput());

      const missing = yield* Effect.result(
        service.transition({ missionId: "mission_1", to: "blocked", expectedVersion: 1 }),
      );
      assert.equal(missing._tag, "Failure");

      const blocked = yield* service.transition({
        missionId: "mission_1",
        to: "blocked",
        expectedVersion: 1,
        blockedReason: "cumulative_loss_limit",
      });
      assert.equal(blocked.status, "blocked");
      assert.equal(blocked.blockedReason, "cumulative_loss_limit");
    }),
  );

  it.effect("rejects a stale optimistic version", () =>
    Effect.gen(function* () {
      yield* migrated;
      const service = yield* TradingMissionService;
      yield* service.createMission(createInput());

      yield* service.transition({ missionId: "mission_1", to: "analysing", expectedVersion: 1 });

      const stale = yield* Effect.result(
        service.transition({ missionId: "mission_1", to: "waiting", expectedVersion: 1 }),
      );

      assert.equal(stale._tag, "Failure");
      if (stale._tag === "Failure") {
        const error = stale.failure;
        assert.equal(error._tag, "TradingMissionVersionConflictError");
        if (error._tag === "TradingMissionVersionConflictError") {
          assert.equal(error.currentVersion, 2);
          assert.equal(error.expectedVersion, 1);
        }
      }
    }),
  );

  it.effect("fails when the mission does not exist", () =>
    Effect.gen(function* () {
      yield* migrated;
      const service = yield* TradingMissionService;

      const result = yield* Effect.result(service.getMission("nope"));
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure._tag, "TradingMissionNotFoundError");
      }
    }),
  );

  it.effect("reports no active mission for an unknown user", () =>
    Effect.gen(function* () {
      yield* migrated;
      const service = yield* TradingMissionService;

      const active = yield* service.findActiveMission("user_absent");
      assert.ok(Option.isNone(active));
    }),
  );

  /**
   * The authorization query stops seeing a mission the moment it ends, which
   * left a thread whose mission had finished unable to learn anything about it.
   * This is the read that answers "what happened to mine"; it grants nothing.
   */
  it.effect("finds the last mission a thread held, terminal ones included", () =>
    Effect.gen(function* () {
      yield* migrated;
      const service = yield* TradingMissionService;

      const mission = yield* service.createMission(createInput());
      const version = yield* service.getMissionVersion(mission.id);
      yield* service.transition({ missionId: mission.id, to: "revoked", expectedVersion: version });

      // The binding query no longer sees it...
      assert.isTrue(Option.isNone(yield* service.findMissionByThreadId("thread_1")));

      // ...but the history read does, with the status it ended in.
      const last = yield* service.findLastMissionByThreadId("thread_1");
      assert.isTrue(Option.isSome(last));
      assert.equal(Option.getOrThrow(last).id, "mission_1");
      assert.equal(Option.getOrThrow(last).status, "revoked");
    }),
  );

  it.effect("finds nothing for a thread that never held a mission", () =>
    Effect.gen(function* () {
      yield* migrated;
      const service = yield* TradingMissionService;
      assert.isTrue(Option.isNone(yield* service.findLastMissionByThreadId("thread_unknown")));
    }),
  );

  // Deletion takes every table keyed to the mission with it. The table list is
  // read out of the schema rather than written down here: the hand-kept list
  // fell eight tables behind the migrations before anyone noticed, and a test
  // that repeats the implementation's list can only ever agree with it.
  it.effect("deletes every row in every table keyed to the mission", () =>
    Effect.gen(function* () {
      yield* migrated;
      const sql = yield* SqlClient.SqlClient;
      const service = yield* TradingMissionService;
      yield* service.createMission(createInput());

      const tables = yield* missionScopedTables(sql);
      // The count is not asserted, only that the schema had some — a query
      // that silently matched nothing would otherwise pass this test forever.
      assert.isAbove(tables.length, 15);

      for (const table of tables) {
        if (table === "trading_missions") continue;
        yield* insertProbeRow(sql, table);
      }

      yield* service.deleteMission("mission_1");

      for (const table of tables) {
        const remaining = yield* sql.unsafe<{ readonly c: number }>(
          `SELECT COUNT(*) AS c FROM ${table} WHERE mission_id = 'mission_1'`,
        );
        assert.equal(remaining[0]?.c, 0, `${table} still holds rows for the deleted mission`);
      }
    }),
  );

  it.effect("is a no-op for a mission that is already gone", () =>
    Effect.gen(function* () {
      yield* migrated;
      const service = yield* TradingMissionService;
      yield* service.deleteMission("mission_never_existed");
    }),
  );

  // The startup sweep's input: only missions whose thread was actually
  // deleted, read off the event log. An empty projection is not evidence of
  // anything — reading one is what once made a live soak look orphaned.
  it.effect("lists only missions whose thread carries a deletion event", () =>
    Effect.gen(function* () {
      yield* migrated;
      const sql = yield* SqlClient.SqlClient;
      const service = yield* TradingMissionService;

      yield* service.createMission(createInput({ missionId: "mission_live" }));
      yield* service.createMission(createInput({ missionId: "mission_done", userId: "user_2" }));
      yield* sql`
        UPDATE trading_missions SET status = 'revoked' WHERE mission_id = 'mission_done'
      `;
      // No projection rows for either thread, and no deletion events: nothing
      // is orphaned, whatever the projections happen to hold right now.
      assert.deepEqual(yield* service.listOrphanedMissions(), []);

      // Both missions share thread_1 (createInput's binding), so deleting it
      // orphans both — but the revoked one is already terminal and is left
      // alone: the sweep frees authority, it does not tidy history.
      yield* recordThreadDeleted(sql, "thread_1");
      const orphans = yield* service.listOrphanedMissions();
      assert.deepEqual(
        orphans.map((m) => m.missionId),
        ["mission_live"],
      );
    }),
  );
});
