// @effect-diagnostics nodeBuiltinImport:off - drives the real lock files on disk.
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { assert, describe, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

import { TradingMissionService } from "./TradingMissionService.ts";
import { purgeFinishedMissions } from "./TradingMissionSweep.ts";
import {
  TradingLeaseTarget,
  TradingRuntimeLease,
  TradingRuntimeLeaseLive,
} from "./TradingRuntimeLease.ts";

const tempDbPath = () =>
  NodePath.join(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-trading-lease-")),
    "state.sqlite",
  );

const leaseLayer = (dbPath: string) =>
  TradingRuntimeLeaseLive.pipe(Layer.provide(Layer.succeed(TradingLeaseTarget, { dbPath })));

const writeLock = (dbPath: string, record: { pid: number; host: string; heartbeat: number }) =>
  Effect.sync(() =>
    NodeFS.writeFileSync(
      dbPath + ".trading.lock",
      `{"pid":${record.pid},"host":"${record.host}","heartbeat":${record.heartbeat}}`,
    ),
  );

/** A pid the kernel provably does not know, so a "fresh" record naming it is stale. */
const deadPid = (): number => {
  for (let pid = 90_000; pid < 90_100; pid += 1) {
    try {
      NodeProcess.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return pid;
    }
  }
  throw new Error("could not find a dead pid for the lease tests");
};

describe("TradingRuntimeLease", () => {
  it.effect("a fresh boot acquires the lease and releases it on close", () =>
    Effect.gen(function* () {
      const dbPath = tempDbPath();
      const lockPath = dbPath + ".trading.lock";

      const lease = yield* Effect.scoped(
        Effect.gen(function* () {
          const built = yield* Layer.build(leaseLayer(dbPath));
          const acquired = Context.get(built, TradingRuntimeLease);
          // While the scope is open the lock file names this process.
          assert.isTrue(NodeFS.existsSync(lockPath));
          return acquired;
        }),
      );

      assert.isTrue(lease.held);
      assert.equal(lease.lockPath, lockPath);
      // Scope closed: the lock file this process owned is removed.
      assert.isFalse(NodeFS.existsSync(lockPath));
    }),
  );

  it.effect("a memory database needs no lease and never touches the filesystem", () =>
    Effect.gen(function* () {
      const built = yield* Effect.scoped(Layer.build(leaseLayer(":memory:")));
      const lease = Context.get(built, TradingRuntimeLease);
      assert.isTrue(lease.held);
      assert.isNull(lease.lockPath);
    }),
  );

  it.effect("a second boot against a live lease refuses and leaves the holder untouched", () =>
    Effect.gen(function* () {
      const dbPath = tempDbPath();
      const lockPath = dbPath + ".trading.lock";
      // A live foreign holder: this process's parent is guaranteed alive right
      // now, on this host, with a fresh heartbeat.
      const now = yield* Clock.currentTimeMillis;
      yield* writeLock(dbPath, { pid: NodeProcess.ppid, host: NodeOS.hostname(), heartbeat: now });

      const built = yield* Effect.scoped(Layer.build(leaseLayer(dbPath)));
      const lease = Context.get(built, TradingRuntimeLease);

      assert.isFalse(lease.held);
      assert.equal(lease.lockPath, lockPath);
      // The holder's record is untouched — the refused boot stole nothing.
      assert.isTrue(NodeFS.existsSync(lockPath));
      // The holder's record still names the foreign pid.
      assert.include(NodeFS.readFileSync(lockPath, "utf8"), `"pid":${NodeProcess.ppid}`);
    }),
  );

  it.effect("a stale heartbeat is broken and taken over", () =>
    Effect.gen(function* () {
      const dbPath = tempDbPath();
      const now = yield* Clock.currentTimeMillis;
      yield* writeLock(dbPath, {
        pid: NodeProcess.ppid,
        host: NodeOS.hostname(),
        heartbeat: now - 120_000,
      });

      const built = yield* Effect.scoped(Layer.build(leaseLayer(dbPath)));
      assert.isTrue(Context.get(built, TradingRuntimeLease).held);
    }),
  );

  it.effect("a fresh heartbeat naming a dead pid is stale and taken over", () =>
    Effect.gen(function* () {
      const dbPath = tempDbPath();
      const now = yield* Clock.currentTimeMillis;
      yield* writeLock(dbPath, { pid: deadPid(), host: NodeOS.hostname(), heartbeat: now });

      const built = yield* Effect.scoped(Layer.build(leaseLayer(dbPath)));
      assert.isTrue(Context.get(built, TradingRuntimeLease).held);
    }),
  );

  it.effect("an unreadable lock file is treated as stale", () =>
    Effect.gen(function* () {
      const dbPath = tempDbPath();
      yield* Effect.sync(() => NodeFS.writeFileSync(dbPath + ".trading.lock", "not json"));

      const built = yield* Effect.scoped(Layer.build(leaseLayer(dbPath)));
      assert.isTrue(Context.get(built, TradingRuntimeLease).held);
    }),
  );
});

describe("TradingMissionSweep lease gate", () => {
  const missionsFake = (calls: string[]) =>
    Layer.succeed(TradingMissionService, {
      listDeletableMissions: () =>
        Effect.sync(() => {
          calls.push("list");
          return [];
        }),
      deleteMission: (id: string) =>
        Effect.sync(() => {
          calls.push("delete:" + id);
        }),
    } as unknown as TradingMissionService["Service"]);

  const runPurge = (held: boolean) => {
    const calls: string[] = [];
    return purgeFinishedMissions.pipe(
      Effect.map(() => calls),
      Effect.provide(
        Layer.mergeAll(
          missionsFake(calls),
          Layer.succeed(TradingRuntimeLease, { held, lockPath: "/tmp/ignored" }),
          Layer.succeed(SqlClient.SqlClient, undefined as unknown as SqlClient.SqlClient),
        ),
      ),
    );
  };

  it.effect("lists deletable missions while holding the lease", () =>
    Effect.gen(function* () {
      const calls = yield* runPurge(true);
      assert.deepEqual(calls, ["list"]);
    }),
  );

  it.effect("does not run the purge when the lease was refused", () =>
    Effect.gen(function* () {
      const calls = yield* runPurge(false);
      assert.deepEqual(calls, []);
    }),
  );
});
