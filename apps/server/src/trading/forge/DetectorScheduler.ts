/**
 * DetectorScheduler — the provider-free heartbeat for armed detectors.
 *
 * An armed, installed detector-program (v2) capability evaluates on a
 * schedule WITHOUT any provider turn: this periodic sweep enqueues a v2
 * reactor job per qualifying capability, and the reactor's own gates (armed,
 * installed, unpaused) re-verify everything at run time. The scheduler never
 * evaluates anything itself and never writes a result — the reactor's
 * DetectorRunStore commit is the only result surface.
 *
 * Invariants this module owns:
 *
 * - Lease-gated: a sweep runs only while this process holds the trading
 *   lease (`held` is read per tick, so a lost lease stands the loop down
 *   without a restart). Single writer, the WatchEvaluator discipline.
 * - v2-only: a capability participates ONLY when its ACTIVE version's
 *   manifest discriminates as `manifestVersion === 2` (via
 *   `versionProgramKind` over the hash-verified stored bytes). v1
 *   capabilities are install-driven and are never scheduled here.
 * - Standing gates: armed AND installed AND not paused, re-read from the
 *   store every sweep — never cached, so arm/disarm/pause/uninstall take
 *   effect on the very next tick.
 * - No pile-up: a capability with a non-terminal job (queued or running,
 *   from `listJobs`) is skipped. That listing serves the newest 50 jobs per
 *   environment; the reactor's queue is sequential and continuously
 *   draining, and a duplicate v2 enqueue that ever escaped the window would
 *   collapse into the same content-derived evaluation id anyway (replayed),
 *   so the bounded window is a staleness bound, not a correctness boundary.
 * - The loop cannot die: every capability's step catches its own failures
 *   (one bad capability never stops the others), each sweep catches its own
 *   (the next tick always comes), and unwired store/reactor is a named
 *   no-op — never a crash.
 *
 * Wake delivery is deliberately NOT here: no subscriber exists yet
 * (execution policies and the task UI are later phases), so a detector wake
 * would write rows nobody consumes. Committed DetectorRunStore records are
 * the durable result surface.
 *
 * @module DetectorScheduler
 */
// @effect-diagnostics nodeBuiltinImport:off - the environment listing scans the store's state root directory, exactly like the reactor's restart recovery.
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";

import {
  ForgeCapabilityStore,
  ForgeCapabilityStoreConfig,
  versionProgramKind,
  type ForgeStoreError,
} from "./CapabilityStore.ts";
import { ForgeReactor } from "./ForgeReactor.ts";
import { TradingRuntimeLease } from "../TradingRuntimeLease.ts";

/** The default sweep cadence: one sweep per minute. */
export const DETECTOR_SWEEP_DEFAULT_INTERVAL_MS = 60_000;

/** The floor on the sweep cadence: nothing may poll the store faster. */
export const DETECTOR_SWEEP_MIN_INTERVAL_MS = 5_000;

/**
 * The `toIntOr` idiom (GraphSource): a positive integer or the fallback,
 * then clamped to the minimum so no environment value can hot-loop the
 * store. Exposed for tests.
 */
export function resolveDetectorSweepIntervalMs(env: Record<string, string | undefined>): number {
  const parsed = Number(env.T3_DETECTOR_SWEEP_INTERVAL_MS);
  const value =
    Number.isInteger(parsed) && parsed > 0 ? parsed : DETECTOR_SWEEP_DEFAULT_INTERVAL_MS;
  return Math.max(value, DETECTOR_SWEEP_MIN_INTERVAL_MS);
}

export interface DetectorSchedulerShape {
  /**
   * One sweep pass: enqueue one v2 evaluation per armed, installed,
   * unpaused v2 capability that has no non-terminal job. Never fails —
   * every failure is caught, logged, and the pass continues; exposed so
   * tests drive sweeps synchronously without a clock.
   */
  readonly sweep: Effect.Effect<void>;
  /**
   * Fork the periodic loop into the ambient scope. The first sweep runs
   * immediately, then one per interval. Each tick re-checks the lease, so
   * the loop stands itself down the moment the lease is lost.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class DetectorScheduler extends Context.Service<DetectorScheduler, DetectorSchedulerShape>()(
  "t3/trading/forge/DetectorScheduler",
) {}

/** A store state-root segment naming one environment directory. */
const isEnvironmentSegment = (segment: string): boolean =>
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(segment);

export const makeDetectorScheduler = (
  sweepIntervalMs: number,
): Effect.Effect<DetectorSchedulerShape, never, TradingRuntimeLease | ForgeCapabilityStoreConfig> =>
  Effect.gen(function* () {
    const lease = yield* TradingRuntimeLease;
    const { stateRoot } = yield* ForgeCapabilityStoreConfig;
    const fs = yield* Effect.promise(() => import("node:fs/promises"));
    // Ambiently optional (the ForgeAcceptance pattern): a wiring without the
    // reactor or the store keeps the loop alive as a named no-op instead of
    // crashing at build. One runtime provides the real instances.
    const storeOption = yield* Effect.serviceOption(ForgeCapabilityStore);
    const reactorOption = yield* Effect.serviceOption(ForgeReactor);
    // Resolved once at build; `null` is the unwired case every sweep names.
    const store = Option.isSome(storeOption) ? storeOption.value : null;
    const reactor = Option.isSome(reactorOption) ? reactorOption.value : null;
    const unwiredReason =
      store === null && reactor === null
        ? "the Forge capability store and reactor are not wired"
        : store === null
          ? "the Forge capability store is not wired"
          : reactor === null
            ? "the Forge reactor is not wired"
            : null;

    const logSkip = (reason: string) =>
      Effect.logWarning(`DetectorScheduler: sweep skipped — ${reason}`);

    /** The environment directories under the shared state root (the same
     * scan the reactor's restart recovery performs). */
    const listEnvironments: Effect.Effect<ReadonlyArray<string>> = Effect.promise(() =>
      fs
        .readdir(stateRoot)
        .then((entries) => entries.filter(isEnvironmentSegment))
        .catch(() => [] as string[]),
    );

    /**
     * One capability's consideration. Every gate re-reads the store, so the
     * sweep's decision is never stale cache: the catalog says something is
     * installed, `activeState` says the standing (armed + not paused), and
     * the ACTIVE version's own manifest bytes say v2. A refusal at any gate
     * is a skip, never an error.
     */
    const considerCapability = (input: {
      readonly environmentId: string;
      readonly capabilityId: string;
      readonly pending: ReadonlySet<string>;
    }): Effect.Effect<void, ForgeStoreError> =>
      Effect.gen(function* () {
        if (store === null || reactor === null) return;
        const active = yield* store.activeState({
          environmentId: input.environmentId,
          capabilityId: input.capabilityId,
        });
        // null = uninstalled (catalog races an uninstall); paused capabilities
        // do not evaluate while paused. Both are skips.
        if (active === null || active.status !== "installed" || !active.armed) return;
        const manifestJson = yield* store.readArtifact({
          environmentId: input.environmentId,
          capabilityId: input.capabilityId,
          version: active.version,
          path: "manifest.json",
        });
        if (versionProgramKind(manifestJson) !== "v2") return;
        if (input.pending.has(input.capabilityId)) return;
        yield* reactor.enqueueEvaluation({
          environmentId: input.environmentId,
          capabilityId: input.capabilityId,
          programKind: 2,
        });
      });

    /** One environment's pass: catalog → non-terminal jobs → per-capability
     * decisions, with per-capability failure isolation. */
    const sweepEnvironment = (environmentId: string): Effect.Effect<void, ForgeStoreError> =>
      Effect.gen(function* () {
        if (store === null || reactor === null) return;
        const catalog = yield* store.listCatalog(environmentId);
        if (catalog.length === 0) return;
        const jobs = yield* reactor.listJobs({ environmentId });
        const pending = new Set(
          jobs
            .filter((job) => job.status === "queued" || job.status === "running")
            .map((job) => job.capabilityId),
        );
        for (const entry of catalog) {
          yield* considerCapability({
            environmentId,
            capabilityId: entry.capabilityId,
            pending,
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning(
                `DetectorScheduler: considering ${entry.capabilityId} in ${environmentId} failed; continuing`,
                { cause: Cause.pretty(cause) },
              ),
            ),
          );
        }
      });

    const sweep: DetectorSchedulerShape["sweep"] = Effect.gen(function* () {
      // Only the lease owner sweeps: a second runtime against the same state
      // must not enqueue alongside the live holder. Read per tick — the
      // getter flips the moment the lock file stops naming this process.
      if (!lease.held) return;
      if (unwiredReason !== null) {
        yield* logSkip(unwiredReason);
        return;
      }
      const environments = yield* listEnvironments;
      for (const environmentId of environments) {
        yield* sweepEnvironment(environmentId).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning(
              `DetectorScheduler: sweeping ${environmentId} failed; continuing to the next environment`,
              { cause: Cause.pretty(cause) },
            ),
          ),
        );
      }
    });

    const start: DetectorSchedulerShape["start"] = () =>
      Effect.gen(function* () {
        yield* Effect.forkScoped(
          sweep.pipe(
            // The loop cannot die: any residual failure or defect in a sweep
            // is caught here so the schedule always fires the next tick.
            Effect.catchCause((cause) =>
              Effect.logWarning("DetectorScheduler: sweep failed; retrying next interval", {
                cause: Cause.pretty(cause),
              }),
            ),
            Effect.repeat(Schedule.spaced(Duration.millis(sweepIntervalMs))),
          ),
        );
        yield* Effect.logInfo("DetectorScheduler: periodic detector sweep started", {
          sweepIntervalMs,
        });
      });

    return { sweep, start } satisfies DetectorSchedulerShape;
  });

/**
 * The scheduler, reading its cadence from `T3_DETECTOR_SWEEP_INTERVAL_MS`
 * (default 60 s, floor 5 s). Pair with {@link DetectorSchedulerStartLive} to
 * actually run the loop.
 */
export const DetectorSchedulerLive = Layer.effect(
  DetectorScheduler,
  Effect.sync(() => resolveDetectorSweepIntervalMs(process.env)).pipe(
    Effect.flatMap(makeDetectorScheduler),
  ),
);

/**
 * Starts the periodic sweep, scoped to the layer's lifetime: the loop is
 * forked into the layer's scope and interrupted with it. Merged into the
 * trading layer (see runtimeLayer) so the scheduler runs wherever the
 * trading runtime does, and stops with it.
 */
export const DetectorSchedulerStartLive: Layer.Layer<never, never, DetectorScheduler> =
  Layer.effectDiscard(
    Effect.gen(function* () {
      const scheduler = yield* DetectorScheduler;
      yield* scheduler.start();
    }),
  );
