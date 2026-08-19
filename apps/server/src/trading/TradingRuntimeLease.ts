/**
 * TradingRuntimeLease - the single-writer guard for the trading runtime.
 *
 * Booting the trading layer runs destructive housekeeping against the state
 * database: `TradingMissionSweep` deletes missions whose thread row is gone,
 * and the watch evaluator sweeps every two seconds. When a second process —
 * another server, or the live-derived harness — boots the same layer against
 * a database someone else is using, that housekeeping runs twice against the
 * same rows and has already killed a live soak. This lease makes the
 * collision loud instead of silent.
 *
 * Mechanism: a lock file next to the sqlite database (`<dbPath>.trading.lock`)
 * holding `{ pid, host, heartbeat }`, created with the exclusive `wx` flag so
 * acquisition is atomic on every platform we ship to. A lock file was chosen
 * over a schema change deliberately: spending migration 074 on a lease table
 * would couple boot-order policy to the migration chain (a refused process
 * still needs to read state, a crashed process leaves the row behind, and
 * tests would need the migration before the lease) while the file gives the
 * same atomicity via the filesystem and self-cleans with the temp dir. The
 * heartbeat is refreshed on an interval; a lease whose heartbeat is older
 * than `STALE_AFTER_MS` — or whose holder pid is provably dead on this host —
 * is stale, broken, and taken over with a log line.
 *
 * An in-memory database (`:memory:`) is private to the process by
 * construction, so it needs no lease: the layer answers `held: true` without
 * touching the filesystem. The same applies to a missing path.
 *
 * While the lease is refused the rest of the server boots normally; only the
 * destructive trading runtime — the orphan purge, the watch sweep, the
 * mission reactor — stays down. A refused process does not retry: bringing
 * the trading runtime up requires a restart once the holder is gone.
 *
 * @module TradingRuntimeLease
 */
// @effect-diagnostics nodeBuiltinImport:off - the lock must be atomic at the
// filesystem level, which the Effect FileSystem service does not expose ("wx").
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

/**
 * How often the holder rewrites its heartbeat. Kept well under the stale
 * threshold so one missed refresh does not get the lease stolen.
 */
const HEARTBEAT_INTERVAL_MS = 10_000;

/**
 * A heartbeat older than this means the holder is gone (crashed, SIGKILLed,
 * or suspended). 45s = several missed heartbeats, short enough that a
 * takeover after a crash is near-immediate.
 */
const STALE_AFTER_MS = 45_000;

/** Attempts before giving up on the create/read/unlink/retry race. */
const ACQUIRE_ATTEMPTS = 5;

/** The state database the lease is scoped to. */
export interface TradingLeaseTargetShape {
  readonly dbPath: string;
}

export class TradingLeaseTarget extends Context.Service<
  TradingLeaseTarget,
  TradingLeaseTargetShape
>()("t3/trading/TradingRuntimeLease/TradingLeaseTarget") {}

export interface TradingRuntimeLeaseShape {
  /** True when this process exclusively owns the trading lease. */
  readonly held: boolean;
  /** The lock file path, or null when no file backs the lease (memory dbs). */
  readonly lockPath: string | null;
}

export class TradingRuntimeLease extends Context.Service<
  TradingRuntimeLease,
  TradingRuntimeLeaseShape
>()("t3/trading/TradingRuntimeLease") {}

interface LeaseRecord {
  readonly pid: number;
  readonly host: string;
  readonly heartbeat: number;
}

const HOST = NodeOS.hostname();

const readRecord = (lockPath: string): LeaseRecord | null => {
  try {
    const parsed = JSON.parse(NodeFS.readFileSync(lockPath, "utf8")) as Partial<LeaseRecord>;
    if (
      typeof parsed.pid !== "number" ||
      typeof parsed.host !== "string" ||
      typeof parsed.heartbeat !== "number"
    ) {
      return null;
    }
    return { pid: parsed.pid, host: parsed.host, heartbeat: parsed.heartbeat };
  } catch {
    return null;
  }
};

const writeRecord = (lockPath: string, record: LeaseRecord, exclusive: boolean): boolean => {
  try {
    const handle = NodeFS.openSync(lockPath, exclusive ? "wx" : "w");
    NodeFS.writeFileSync(handle, JSON.stringify(record));
    NodeFS.closeSync(handle);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
};

/** Signal-0 probe: true when a pid is alive. Only meaningful on our own host. */
const pidIsAlive = (pid: number): boolean => {
  try {
    NodeProcess.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

type Acquisition =
  | {
      readonly acquired: true;
      readonly record: LeaseRecord;
      /** The dead holder whose lease we broke, when the file was not empty. */
      readonly tookOver: LeaseRecord | null;
    }
  | { readonly acquired: false; readonly holder: LeaseRecord; readonly ageMs: number };

const acquire = (lockPath: string): Effect.Effect<Acquisition> =>
  Effect.gen(function* () {
    const self: LeaseRecord = {
      pid: NodeProcess.pid,
      host: HOST,
      heartbeat: yield* Clock.currentTimeMillis,
    };
    let tookOver: LeaseRecord | null = null;
    for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt += 1) {
      if (yield* Effect.sync(() => writeRecord(lockPath, self, true))) {
        return { acquired: true as const, record: self, tookOver };
      }
      const holder = yield* Effect.sync(() => readRecord(lockPath));
      // An unreadable file is stale (a half-written crash, wrong shape) — retry
      // the exclusive create after removing it.
      if (holder === null) {
        yield* Effect.sync(() => NodeFS.rmSync(lockPath, { force: true }));
        continue;
      }
      const ageMs = (yield* Clock.currentTimeMillis) - holder.heartbeat;
      // The holder is live when its heartbeat is fresh — or, on this host, when
      // a fresh-enough record names a pid the kernel still knows. A dead pid is
      // stale no matter how fresh the file looks (SIGKILL between write and
      // crash leaves a lying heartbeat behind).
      const holderIsLive =
        ageMs < STALE_AFTER_MS && (holder.host !== HOST || pidIsAlive(holder.pid));
      if (holderIsLive) return { acquired: false as const, holder, ageMs };
      tookOver = holder;
      yield* Effect.sync(() => NodeFS.rmSync(lockPath, { force: true }));
    }
    // Lost the takeover race repeatedly; report whoever holds the file now.
    const holder: LeaseRecord =
      (yield* Effect.sync(() => readRecord(lockPath))) ??
      ({ pid: -1, host: HOST, heartbeat: yield* Clock.currentTimeMillis } satisfies LeaseRecord);
    return {
      acquired: false as const,
      holder,
      ageMs: (yield* Clock.currentTimeMillis) - holder.heartbeat,
    } satisfies { acquired: false; holder: LeaseRecord; ageMs: number };
  });

/** Rewrite the heartbeat, but only while the file still names this process. */
const heartbeatLoop = (lockPath: string, record: LeaseRecord) =>
  Effect.gen(function* () {
    while (true) {
      yield* Effect.sleep(HEARTBEAT_INTERVAL_MS);
      const now = yield* Clock.currentTimeMillis;
      yield* Effect.sync(() => {
        const current = readRecord(lockPath);
        if (current !== null && current.pid === record.pid && current.host === record.host) {
          writeRecord(lockPath, { ...current, heartbeat: now }, false);
        }
      });
    }
  });

const make = Effect.gen(function* () {
  const { dbPath } = yield* TradingLeaseTarget;

  // An in-memory or unnamed database is private to this process; there is no
  // neighbour a lease could protect against.
  if (dbPath === "" || dbPath.startsWith(":memory:")) {
    return { held: true, lockPath: null } satisfies TradingRuntimeLeaseShape;
  }

  const lockPath = `${dbPath}.trading.lock`;
  yield* Effect.sync(() => NodeFS.mkdirSync(NodePath.dirname(lockPath), { recursive: true }));

  const result = yield* acquire(lockPath);
  if (!result.acquired) {
    yield* Effect.logWarning(
      `TradingRuntimeLease: refusing to start the trading runtime - lease on ${lockPath} is held by pid ${result.holder.pid} on ${result.holder.host} (heartbeat ${Math.round(result.ageMs / 1000)}s old)`,
    );
    return { held: false, lockPath } satisfies TradingRuntimeLeaseShape;
  }

  if (result.tookOver !== null) {
    // A takeover means the previous holder died or stopped refreshing; say
    // so, because it explains why this boot may run housekeeping a process
    // that still believes it owns the database used to own.
    yield* Effect.logInfo(
      `TradingRuntimeLease: took over stale lease on ${lockPath} from pid ${result.tookOver.pid} on ${result.tookOver.host}`,
    );
  }

  // The heartbeat fiber and the release finalizer both live in the layer's
  // build scope, so closing the layer (server shutdown, test scope end)
  // stops the heartbeat and removes the file we own.
  const scope = yield* Effect.scope;
  yield* heartbeatLoop(lockPath, result.record).pipe(
    Effect.forkScoped,
    Effect.provideService(Scope.Scope, scope),
  );
  yield* Scope.addFinalizer(
    scope,
    Effect.sync(() => {
      const current = readRecord(lockPath);
      if (
        current !== null &&
        current.pid === result.record.pid &&
        current.host === result.record.host
      ) {
        NodeFS.rmSync(lockPath, { force: true });
      }
    }),
  );

  return { held: true, lockPath } satisfies TradingRuntimeLeaseShape;
});

export const TradingRuntimeLeaseLive = Layer.effect(TradingRuntimeLease, make);
