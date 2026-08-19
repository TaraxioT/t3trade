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
 * Takeover race: two processes judging the same already-stale lock cannot be
 * allowed to both end up holding it. A plain read-judge-unlink-retry leaves a
 * window where process B unlinks the fresh lock process A just created, and
 * both hold. Instead, a takeover never unlinks the lock path directly: it
 * `rename`s the lock to a private temp path (atomic — whatever the file held
 * at rename time is captured), then compares the captured contents against
 * the stale record it judged. Only an exact match is deleted; a mismatch
 * means the file changed hands between the read and the rename, so the
 * capturer restores it with `link` (which refuses to clobber a lock since
 * (re)created at the original path) and retries acquisition against the new
 * contents. So a takeover can never delete a lock it did not judge stale,
 * and after acquiring (`wx` + read-back verifying the file names this
 * pid/host) the heartbeat re-verifies ownership on every tick: the moment
 * the file stops naming this process, the holder logs the thief, stops
 * refreshing, and stands down — `held` flips to false and the periodic
 * writers (the 2s watch sweep, the mission follow loop) skip their next
 * tick. One extreme corner still escapes this: the heartbeat refresh is a
 * truncate-write, so a holder suspended ≥ STALE_AFTER_MS (judged stale,
 * lease broken and retaken) that resumes in the microseconds between its
 * own ownership re-read and its truncate-write can clobber the new holder's
 * fresh lock. For at most one heartbeat interval (~10s) both processes then
 * believe they hold, resolved when the dispossessed holder's next tick
 * detects the loss and stands down — so exclusivity is eventually
 * preserved, with at most that one bounded transient dual-belief in this
 * corner, and a stood-down process never becomes a writer again without a
 * full re-acquire. Dually, a late racer renaming a fresh holder's lock away
 * can make the holder's next tick briefly see the file missing and stand
 * down — a liveness cost only, never a second writer.
 *
 * Clock sensitivity: heartbeat ages come from the wall clock
 * (`Clock.currentTimeMillis`), because the heartbeat must survive across
 * processes — a monotonic in-process clock cannot judge another process's
 * timestamp. A backwards clock step makes leases look fresher than they are
 * (takeover is delayed); a forward step of ≥ STALE_AFTER_MS can get a live
 * holder's lease judged stale and taken over. In that case the old holder's
 * next heartbeat tick detects that the file no longer names it and stands
 * down, so a clock step can cost liveness, not exclusivity.
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
import * as NodeCrypto from "node:crypto";
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

/** Whether two records are the same lock, byte for byte in every field. */
const sameRecord = (a: LeaseRecord, b: LeaseRecord): boolean =>
  a.pid === b.pid && a.host === b.host && a.heartbeat === b.heartbeat;

/**
 * Atomically capture the lock before deleting it, so a takeover can never
 * remove a lock whose contents it did not judge stale. `rename` is atomic:
 * the captured file holds exactly what the lock path held at rename time.
 * When the captured contents match the record this caller judged stale (or
 * both are unreadable), the captured file is deleted and the lock path is
 * free. When they differ, another process replaced the lock between the
 * caller's read and the rename — the captured file is put back with `link`
 * (which fails rather than clobber a lock since re-created at the original
 * path) and the caller must re-judge. Exported for the takeover-race test.
 */
export const breakStaleLock = (
  lockPath: string,
  judgedStale: LeaseRecord | null,
): "broken" | "replaced" | "gone" => {
  const capturedPath = `${lockPath}.takeover-${NodeProcess.pid}-${NodeCrypto.randomUUID()}`;
  try {
    NodeFS.renameSync(lockPath, capturedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "gone";
    throw error;
  }
  const captured = readRecord(capturedPath);
  const isWhatWeJudged =
    judgedStale === null
      ? captured === null
      : captured !== null && sameRecord(captured, judgedStale);
  if (isWhatWeJudged) {
    NodeFS.rmSync(capturedPath, { force: true });
    return "broken";
  }
  try {
    NodeFS.linkSync(capturedPath, lockPath);
  } catch {
    // EEXIST: a fresh lock already sits at the original path; ours was the
    // stale copy. Drop it.
  }
  NodeFS.rmSync(capturedPath, { force: true });
  return "replaced";
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

/** Exported for the takeover-race test. */
export const acquire = (
  lockPath: string,
  /**
   * Test seam for the takeover race: invoked after a record has been judged
   * stale but before the lock is broken, letting the test swap the file under
   * the acquirer exactly as a racing process would.
   */
  afterJudge?: (judged: LeaseRecord | null) => void,
): Effect.Effect<Acquisition> =>
  Effect.gen(function* () {
    const self: LeaseRecord = {
      pid: NodeProcess.pid,
      host: HOST,
      heartbeat: yield* Clock.currentTimeMillis,
    };
    let tookOver: LeaseRecord | null = null;
    for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt += 1) {
      if (yield* Effect.sync(() => writeRecord(lockPath, self, true))) {
        // Post-acquisition verification: refuse to act as holder unless the
        // file we just created still names this process. The rename-based
        // takeover makes this near-impossible to hit, but the cost of being
        // wrong is two writers, so it is checked anyway.
        const verified = yield* Effect.sync(() => {
          const current = readRecord(lockPath);
          return current !== null && current.pid === self.pid && current.host === self.host;
        });
        if (verified) return { acquired: true as const, record: self, tookOver };
        continue;
      }
      const holder = yield* Effect.sync(() => readRecord(lockPath));
      // An unreadable file is stale (a half-written crash, wrong shape) —
      // break it via the atomic rename capture and retry the exclusive
      // create. The capture never deletes a file whose contents changed
      // since this read, so a racing acquirer's fresh lock survives.
      if (holder === null) {
        yield* Effect.sync(() => afterJudge?.(null));
        yield* Effect.sync(() => breakStaleLock(lockPath, null));
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
      yield* Effect.sync(() => afterJudge?.(holder));
      yield* Effect.sync(() => breakStaleLock(lockPath, holder));
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

/**
 * Rewrite the heartbeat, but only while the file still names this process.
 * Every tick re-verifies ownership: a file that is gone or names another
 * holder means the lease was taken over (or clobbered), so the loop logs
 * the new holder, stands down via `onLoss`, and stops refreshing.
 */
const heartbeatLoop = (lockPath: string, record: LeaseRecord, onLoss: () => void) =>
  Effect.gen(function* () {
    while (true) {
      yield* Effect.sleep(HEARTBEAT_INTERVAL_MS);
      const now = yield* Clock.currentTimeMillis;
      // Undefined = still ours and refreshed; a LeaseRecord = the thief;
      // null = the file is gone. Either non-undefined value is a loss.
      const outcome = yield* Effect.sync((): LeaseRecord | null | undefined => {
        const current = readRecord(lockPath);
        if (current === null) return null;
        if (current.pid !== record.pid || current.host !== record.host) return current;
        writeRecord(lockPath, { ...current, heartbeat: now }, false);
        return undefined;
      });
      if (outcome === undefined) continue;
      const thief = outcome ?? { pid: -1, host: "(missing)", heartbeat: now };
      yield* Effect.logError(
        `TradingRuntimeLease: lost the lease on ${lockPath} - the lock file now names pid ${thief.pid} on ${thief.host}; standing down the trading runtime`,
      );
      onLoss();
      return;
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
  // stops the heartbeat and removes the file we own. The heartbeat flips
  // `leaseLost` the moment the file stops naming this process; `held` reads
  // it, so the periodic writers stand down on their next tick.
  let leaseLost = false;
  const scope = yield* Effect.scope;
  yield* heartbeatLoop(lockPath, result.record, () => {
    leaseLost = true;
  }).pipe(Effect.forkScoped, Effect.provideService(Scope.Scope, scope));
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

  return {
    get held() {
      return !leaseLost;
    },
    lockPath,
  } satisfies TradingRuntimeLeaseShape;
});

export const TradingRuntimeLeaseLive = Layer.effect(TradingRuntimeLease, make);
