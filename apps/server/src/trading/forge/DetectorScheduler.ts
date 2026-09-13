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
 * STREAM-TRIGGERED EVALUATION (the durable outbox drain): Worker A's
 * ingestion commits facts, cursor, and OUTBOX entries atomically; each sweep
 * first drains that outbox — for every committed-evidence entry, every armed
 * v2 capability bound to that stream source gets a `ForgeReactor.
 * enqueueEvaluation` job, with no provider turn — and only then runs the
 * periodic fallback below. The drain is IDEMPOTENT by construction: an entry
 * is durably acked only AFTER its evaluation job exists (or a non-terminal
 * job already covers the capability, which will read the newest committed
 * evidence when it runs). A crash between enqueue and ack replays the entry;
 * the replay's extra job is a duplicate evaluation, never a duplicate
 * occurrence (occurrences are keyed and committed through DetectorRunStore).
 * The scheduler stays a lease-gated recovery sweep over A's committed
 * evidence — never a second, independent source of occurrences.
 *
 * Invariants this module owns:
 *
 * - Lease-gated: a sweep (and the drain inside it) runs only while this
 *   process holds the trading lease (`held` is read per tick, so a lost
 *   lease stands the loop down without a restart). Single writer, the
 *   WatchEvaluator discipline.
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

/** The most outbox entries one drain processes (a burst bound, not a cap on
 * total delivery: anything left stays pending for the next drain). */
export const DETECTOR_DRAIN_MAX_ENTRIES = 128;

// ---------------------------------------------------------------------------
// The A→B outbox port. Worker A's SubstreamsIngestion commits facts + cursor
// + outbox entries in ONE transaction; this port is the consumer side of that
// outbox. The shapes bind (names on A's side may differ); until A's store
// lands, tests bind a local fake implementing exactly this shape — replaced
// at integration, never shipped.
// ---------------------------------------------------------------------------

/** One durable evidence-committed entry: A committed stream facts for `sourceId`. */
export interface SubstreamsOutboxEntry {
  /** Durable identity; acking it makes delivery permanently done. */
  readonly outboxId: string;
  readonly environmentId: string;
  readonly sourceId: string;
  readonly committedAtMs: number;
}

export interface SubstreamsOutboxShape {
  /**
   * Pending (unacked) entries for one environment, oldest first, at most
   * `limit`. The claim is per environment because the committing store keys
   * its outbox that way and the sweep is already per environment.
   */
  readonly readPending: (input: {
    readonly environmentId: string;
    readonly limit: number;
  }) => Effect.Effect<ReadonlyArray<SubstreamsOutboxEntry>, never>;
  /**
   * Durably ack entries. The scheduler calls this ONLY after the evaluation
   * job creation each entry honors has happened, so a crash before the ack
   * replays the entry instead of losing it.
   */
  readonly ack: (input: {
    readonly outboxIds: ReadonlyArray<string>;
  }) => Effect.Effect<void, never>;
}

export class SubstreamsOutbox extends Context.Service<SubstreamsOutbox, SubstreamsOutboxShape>()(
  "t3/trading/forge/DetectorScheduler/SubstreamsOutbox",
) {}

/**
 * The bare stream source ids a v2 manifest binds through `substreams:`
 * source references (`substreams:<sourceId>:<windowMs>`; the last colon
 * splits the window selector, so prefix matching is exact at the source-id
 * boundary). Null when the manifest bytes are not v2-shaped JSON.
 */
export const manifestSubstreamsSourceIds = (manifestJson: string): ReadonlyArray<string> | null => {
  try {
    const parsed = JSON.parse(manifestJson) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as { manifestVersion?: unknown; requiredSourceIds?: unknown };
    if (record.manifestVersion !== 2 || !Array.isArray(record.requiredSourceIds)) return null;
    const ids: Array<string> = [];
    for (const id of record.requiredSourceIds) {
      if (typeof id !== "string" || !id.startsWith("substreams:")) continue;
      const rest = id.slice("substreams:".length);
      // Strip the trailing window selector when a well-formed one exists.
      const split = rest.lastIndexOf(":");
      ids.push(split > 0 ? rest.slice(0, split) : rest);
    }
    return ids;
  } catch {
    return null;
  }
};

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
   * Drain Worker A's durable evidence outbox: for every pending entry,
   * enqueue one v2 evaluation per armed, installed, unpaused v2 capability
   * whose manifest binds the entry's stream source, then durably ack the
   * entry — the ack happens ONLY after the job creation (or an existing
   * non-terminal job that will read the newest committed evidence). Lease-
   * gated like the sweep; never fails (per-entry failures skip that entry
   * without acking it). Exposed so tests and the ingestion wiring drive a
   * drain without waiting for a sweep tick.
   */
  readonly drainOutbox: Effect.Effect<void>;
  /**
   * One sweep pass: drain the stream evidence outbox, then enqueue one v2
   * evaluation per armed, installed, unpaused v2 capability that has no
   * non-terminal job. Never fails — every failure is caught, logged, and
   * the pass continues; exposed so tests drive sweeps synchronously without
   * a clock.
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
    const outboxOption = yield* Effect.serviceOption(SubstreamsOutbox);
    // Resolved once at build; `null` is the unwired case every sweep names.
    const store = Option.isSome(storeOption) ? storeOption.value : null;
    const reactor = Option.isSome(reactorOption) ? reactorOption.value : null;
    const outbox = Option.isSome(outboxOption) ? outboxOption.value : null;
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

    /**
     * One outbox entry's drain: every armed, installed, unpaused v2
     * capability whose manifest binds the entry's stream source gets an
     * evaluation job (unless a non-terminal job already covers it — that job
     * reads the newest committed evidence when it runs). Returns true when
     * the entry is fully honored and may be acked; a capability BOUND to the
     * entry's source whose step failed keeps the entry pending.
     *
     * Binding is read from the catalog version's manifest BEFORE the standing
     * gates, so a capability that cannot even be considered never blocks an
     * entry it is not bound to. A catalog/manifest race against an upgrade
     * costs at most one extra reactor job (the reactor re-reads the ACTIVE
     * version's manifest and rebuilds its window at run time) or one sweep of
     * delay for a brand-new binding — never a missed or forged evaluation.
     */
    const drainEntry = (entry: SubstreamsOutboxEntry): Effect.Effect<boolean, ForgeStoreError> =>
      Effect.gen(function* () {
        if (store === null || reactor === null) return false;
        const catalog = yield* store.listCatalog(entry.environmentId);
        if (catalog.length === 0) return true;
        const jobs = yield* reactor.listJobs({ environmentId: entry.environmentId });
        const pendingCapabilities = new Set(
          jobs
            .filter((job) => job.status === "queued" || job.status === "running")
            .map((job) => job.capabilityId),
        );
        let anyFailure = false;
        for (const capability of catalog) {
          const step: Effect.Effect<void, ForgeStoreError> = Effect.gen(function* () {
            const manifestJson = yield* store.readArtifact({
              environmentId: entry.environmentId,
              capabilityId: capability.capabilityId,
              version: capability.version,
              path: "manifest.json",
            });
            if (manifestJson === null || versionProgramKind(manifestJson) !== "v2") return;
            const boundSources = manifestSubstreamsSourceIds(manifestJson);
            if (boundSources === null || !boundSources.includes(entry.sourceId)) return;
            // Bound: from here a failure blocks the entry's ack — acking
            // without the job creation this capability is owed would lose
            // the evidence delivery on a crash.
            const active = yield* store.activeState({
              environmentId: entry.environmentId,
              capabilityId: capability.capabilityId,
            });
            if (active === null || active.status !== "installed" || !active.armed) return;
            // A non-terminal job covers the capability: it will evaluate
            // over the newest committed evidence, so the entry is honored.
            if (pendingCapabilities.has(capability.capabilityId)) return;
            yield* reactor.enqueueEvaluation({
              environmentId: entry.environmentId,
              capabilityId: capability.capabilityId,
              programKind: 2,
            });
          });
          yield* step.pipe(
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                anyFailure = true;
                yield* Effect.logWarning(
                  `DetectorScheduler: draining outbox entry ${entry.outboxId} for ${capability.capabilityId} failed; the entry stays pending`,
                  { cause: Cause.pretty(cause) },
                );
              }),
            ),
          );
        }
        // Even zero bound capabilities honors the entry: the evidence is
        // committed and nothing will ever consume it — acking keeps the
        // outbox from replaying it forever. But a FAILED bound step does not.
        return !anyFailure;
      });

    const drainOutbox: DetectorSchedulerShape["drainOutbox"] = Effect.gen(function* () {
      // The drain is as lease-gated as the sweep: one writer per state root.
      if (!lease.held) return;
      // Unwired outbox (Worker A's store not integrated yet) or unwired
      // store/reactor: a silent no-op, the same ambiently-optional rule the
      // reactor follows — the periodic sweep's own unwired log names the rest.
      if (outbox === null || store === null || reactor === null) return;
      const environments = yield* listEnvironments;
      for (const environmentId of environments) {
        const entries = yield* outbox.readPending({
          environmentId,
          limit: DETECTOR_DRAIN_MAX_ENTRIES,
        });
        if (entries.length === 0) continue;
        const ackIds: Array<string> = [];
        for (const entry of entries) {
          if (entry.environmentId !== environmentId) continue;
          const honored = yield* drainEntry(entry).pipe(
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                yield* Effect.logWarning(
                  `DetectorScheduler: draining outbox entry ${entry.outboxId} failed; leaving it pending`,
                  { cause: Cause.pretty(cause) },
                );
                return false;
              }),
            ),
          );
          // Durable ack ONLY after the job creation the entry honors happened
          // (or was already covered): a crash before this point replays.
          if (honored) ackIds.push(entry.outboxId);
        }
        if (ackIds.length > 0) yield* outbox.ack({ outboxIds: ackIds });
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("DetectorScheduler: outbox drain failed; retrying next sweep", {
          cause: Cause.pretty(cause),
        }),
      ),
    );

    const sweep: DetectorSchedulerShape["sweep"] = Effect.gen(function* () {
      // Only the lease owner sweeps: a second runtime against the same state
      // must not enqueue alongside the live holder. Read per tick — the
      // getter flips the moment the lock file stops naming this process.
      if (!lease.held) return;
      if (unwiredReason !== null) {
        yield* logSkip(unwiredReason);
        return;
      }
      // Stream-triggered evaluation first: fresh committed evidence reaches
      // bound detectors on this sweep, not the next one.
      yield* drainOutbox;
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

    return { drainOutbox, sweep, start } satisfies DetectorSchedulerShape;
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
