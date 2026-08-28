/**
 * ArchiveSupervisor — the market archiver runs because the server runs.
 *
 * The archive is the only history T3 Trade will ever have: Hyperliquid serves a
 * window of about 5,000 bars per interval and nothing older, so a minute not
 * recorded is a minute gone. Until now recording depended on somebody
 * remembering to run `node src/trading/archive/main.ts` in a spare terminal,
 * which meant most installs had no history at all and the ones that did lost it
 * whenever the terminal closed.
 *
 * So the server owns the process. It spawns the archiver as a Node child,
 * restarts it with backoff when it dies, reads its heartbeat off stdout, and
 * publishes what it knows so a surface can say "recording since…" honestly.
 *
 * Single writer, on its own lock. The trading runtime lease will not do here:
 * it is scoped to a state directory, and the archive deliberately is not — it
 * is machine-wide market data that a dev server and the installed app read from
 * the same file. So the supervisor takes a lease on the archive path itself,
 * and a second server on the same machine supervises nothing.
 *
 * @module ArchiveSupervisor
 */
// @effect-diagnostics nodeBuiltinImport:off - resolving the child's own entry file.
import { Context, Effect } from "effect";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";

import { HyperliquidEndpoints, isTestnetEndpoints } from "@t3tools/hyperliquid/config";
import { ARCHIVE_NETWORK_ENV, archiveDatabasePath, type ArchiveNetwork } from "./archive/config.ts";
import {
  TradingAccountProjection,
  TradingAccountProjectionLive,
} from "./TradingAccountProjection.ts";
import { acquire, heartbeatLoop } from "./TradingRuntimeLease.ts";

/** What the supervisor knows about the archiver right now. */
export interface ArchiveHealth {
  /** Whether a child is running at this moment. */
  readonly running: boolean;
  /** The running child's pid, or null when nothing is running. */
  readonly pid: number | null;
  /** When the child last printed a heartbeat, or null if it never has. */
  readonly lastHeartbeatAt: number | null;
  /** The heartbeat line itself — counters, per-interval lag, request pace. */
  readonly lastHeartbeat: string | null;
  /** How many times the child has been restarted since the server booted. */
  readonly restarts: number;
  /** Why the archiver is not running, when it is not. */
  readonly stoppedReason: string | null;
}

export interface ArchiveSupervisorShape {
  readonly health: Effect.Effect<ArchiveHealth>;
  /** Start supervising. Returns once the first spawn attempt has been made. */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class ArchiveSupervisor extends Context.Service<ArchiveSupervisor, ArchiveSupervisorShape>()(
  "t3/trading/ArchiveSupervisor",
) {}

/** First wait after the child dies. Doubles per consecutive failure. */
const BACKOFF_BASE = Duration.seconds(2);
/** Ceiling on the wait. A minute is short enough that a fixed outage recovers. */
const BACKOFF_MAX = Duration.minutes(1);
/**
 * How long a child must survive before its restart is treated as recovery
 * rather than a crash loop. The archiver's first tick is within a minute of
 * boot, so anything past this actually ran.
 */
const HEALTHY_AFTER = Duration.minutes(2);

/**
 * Where the archiver's entry file is, from wherever this module ended up.
 *
 * Two shapes. In the source tree this file sits beside `archive/main.ts`. In
 * the packed CLI this module is inlined into `bin.mjs`, so `here` is the
 * bundle root, and the archiver — packed as its own entry — keeps its path
 * below it as `trading/archive/main.mjs`. Both entries land in one `vp pack`
 * run; see `pack.entry` in `apps/server/vite.config.ts`.
 *
 * Returns null when neither is found, which leaves the archiver off with a
 * reason rather than spawning something that does not exist.
 */
export const resolveArchiverEntry = (moduleUrl: string): string | null => {
  const here = NodePath.dirname(NodeURL.fileURLToPath(moduleUrl));
  const candidates = [
    NodePath.join(here, "archive", "main.ts"),
    NodePath.join(here, "trading", "archive", "main.mjs"),
  ];
  return candidates.find((candidate) => NodeFS.existsSync(candidate)) ?? null;
};

/**
 * The signal a child died from, pulled out of the failed `exitCode` read, or
 * `null` when the failure is not a signal death. The Node spawner reports a
 * signal-terminated child as a failure whose message names the signal
 * ("Process interrupted due to receipt of signal: 'SIGKILL'"); the message may
 * sit on the error itself or on a nested cause, so both are walked.
 */
export const exitSignal = (error: unknown): string | null => {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth += 1) {
    const record = current as { readonly message?: unknown; readonly cause?: unknown };
    const message = typeof current === "string" ? current : record.message;
    if (typeof message === "string") {
      const match = /signal:\s*'?(SIG[A-Z0-9]+)'?/.exec(message);
      if (match?.[1] !== undefined) return match[1];
    }
    current = typeof current === "string" ? undefined : record.cause;
  }
  return null;
};

/** Exported for tests: the supervisor's construction with its dependencies visible. */
export const makeArchiveSupervisor = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  // The account view carries the archiver-health rider, and the account view
  // refreshes only when this doorbell rings — so every supervisor transition
  // rings it, exactly as the reconciler does after a pass (R1-1).
  const projection = yield* TradingAccountProjection;
  // The archiver records the venue the app trades. The network is derived
  // from the trading gateway's own endpoint configuration — the same single
  // decision the execution service makes — and passed to the child by env.
  const endpoints = yield* HyperliquidEndpoints;
  const network: ArchiveNetwork = isTestnetEndpoints(endpoints) ? "testnet" : "mainnet";
  /** Flipped by the heartbeat if another process takes the archive lock. */
  let ownsArchive = false;

  const state = yield* Ref.make<ArchiveHealth>({
    running: false,
    pid: null,
    lastHeartbeatAt: null,
    lastHeartbeat: null,
    restarts: 0,
    stoppedReason: "not started",
  });

  const stopped = (reason: string) =>
    Ref.update(state, (current) => ({
      ...current,
      running: false,
      pid: null,
      stoppedReason: reason,
    })).pipe(Effect.andThen(projection.invalidate({ reason: "archiver_stopped" })));

  /**
   * Run one child to completion, folding its stdout into the health state.
   *
   * The archiver prints one heartbeat line per tick — counters, per-interval
   * lag, request pace — which is exactly the health report a supervisor would
   * otherwise have to invent, so it is read rather than duplicated. Every other
   * line is forwarded at debug: an archiver that is failing says so in prose,
   * and losing that to a swallowed stream would make this the hardest process
   * in the app to diagnose.
   */
  const runOnce = (entry: string) =>
    Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make(NodeProcess.execPath, [entry], {
          extendEnv: true,
          env: { [ARCHIVE_NETWORK_ENV]: network },
        }),
      );
      yield* Ref.update(state, (current) => ({
        ...current,
        running: true,
        pid: child.pid ?? null,
        stoppedReason: null,
      }));
      yield* projection.invalidate({ reason: "archiver_started" });
      yield* Effect.logInfo("ArchiveSupervisor: archiver started", {
        pid: child.pid,
        entry,
        network,
      });

      yield* Stream.runForEach(
        Stream.splitLines(Stream.decodeText(child.stdout)),
        (line: string): Effect.Effect<void> =>
          line.includes("heartbeat:")
            ? Clock.currentTimeMillis.pipe(
                Effect.flatMap((now) =>
                  Ref.update(state, (current) => ({
                    ...current,
                    lastHeartbeatAt: now,
                    lastHeartbeat: line.trim(),
                  })),
                ),
              )
            : Effect.logDebug("archiver", { line: line.trim() }),
      );

      // A signal death (SIGKILL, a kill during shutdown) surfaces as a failed
      // exit-code read; it is an ordinary way to operate the process, logged
      // as information. Everything else stays a warning (R1-2).
      yield* child.exitCode.pipe(
        Effect.flatMap((code) => Effect.logWarning("ArchiveSupervisor: archiver exited", { code })),
        Effect.catch((error) => {
          const signal = exitSignal(error);
          return signal === null
            ? Effect.fail(error)
            : Effect.logInfo(`ArchiveSupervisor: archiver exited (signal ${signal})`);
        }),
      );
    }).pipe(Effect.scoped);

  /**
   * Spawn, watch, wait, spawn again — for as long as this process holds the
   * trading lease.
   *
   * The backoff resets once a child has survived `HEALTHY_AFTER`, so a
   * long-running archiver that finally dies restarts immediately while one
   * that cannot start at all backs off to a minute instead of hammering the
   * exchange with cold-start backfills.
   */
  const supervise = (entry: string) =>
    Effect.gen(function* () {
      let backoff = BACKOFF_BASE;
      while (true) {
        if (!ownsArchive) {
          yield* stopped("another process is writing the archive");
          return;
        }
        const startedAt = yield* Clock.currentTimeMillis;
        yield* runOnce(entry).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("ArchiveSupervisor: archiver failed", { cause: String(cause) }),
          ),
        );
        const ranFor = (yield* Clock.currentTimeMillis) - startedAt;
        yield* Ref.update(state, (current) => ({
          ...current,
          running: false,
          pid: null,
          restarts: current.restarts + 1,
          stoppedReason: "restarting",
        }));
        yield* projection.invalidate({ reason: "archiver_restarting" });

        backoff =
          ranFor >= Duration.toMillis(HEALTHY_AFTER)
            ? BACKOFF_BASE
            : Duration.min(Duration.times(backoff, 2), BACKOFF_MAX);
        yield* Effect.sleep(backoff);
      }
    });

  const start: ArchiveSupervisorShape["start"] = () =>
    Effect.gen(function* () {
      const archivePath = archiveDatabasePath();
      const lockPath = `${archivePath}.writer.lock`;
      yield* Effect.sync(() => NodeFS.mkdirSync(NodePath.dirname(lockPath), { recursive: true }));
      const lock = yield* acquire(lockPath);
      if (!lock.acquired) {
        yield* stopped(`pid ${lock.holder.pid} on ${lock.holder.host} is writing the archive`);
        yield* Effect.logInfo("ArchiveSupervisor: another process is archiving", {
          holder: lock.holder.pid,
          host: lock.holder.host,
        });
        return;
      }
      ownsArchive = true;
      const scope = yield* Effect.scope;
      yield* heartbeatLoop(lockPath, lock.record, () => {
        ownsArchive = false;
      }).pipe(Effect.forkScoped, Effect.provideService(Scope.Scope, scope));
      // Only remove a lock this process still owns: the heartbeat clears
      // `ownsArchive` the moment the file names somebody else, and deleting a
      // live holder's lock would let a third process in behind them.
      yield* Scope.addFinalizer(
        scope,
        Effect.sync(() => {
          if (ownsArchive) NodeFS.rmSync(lockPath, { force: true });
        }),
      );

      const entry = resolveArchiverEntry(import.meta.url);
      if (entry === null) {
        yield* stopped("the archiver entry file was not found");
        yield* Effect.logWarning("ArchiveSupervisor: could not find the archiver entry file");
        return;
      }
      yield* Effect.forkScoped(supervise(entry));
    });

  return { health: Ref.get(state), start } satisfies ArchiveSupervisorShape;
});

/**
 * The projection is provided here (not by the runtime layer) so the
 * supervisor's dependency stays local; Effect memoizes the layer by
 * reference, so this is the same doorbell instance the reconciler, the alert
 * services and the WS read path share.
 */
export const ArchiveSupervisorLive: Layer.Layer<
  ArchiveSupervisor,
  never,
  ChildProcessSpawner.ChildProcessSpawner | SqlClient.SqlClient
> = Layer.effect(ArchiveSupervisor, makeArchiveSupervisor).pipe(
  Layer.provide(TradingAccountProjectionLive),
);
