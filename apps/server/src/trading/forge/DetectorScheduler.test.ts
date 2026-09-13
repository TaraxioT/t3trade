/**
 * DetectorScheduler — the provider-free sweep that keeps armed detectors
 * evaluating on a schedule.
 *
 * What is pinned here:
 * - The gate matrix: only an ARMED, INSTALLED, UNPAUSED capability whose
 *   ACTIVE version's manifest discriminates as v2 is ever enqueued, and
 *   always with `programKind: 2`. v1, un-armed, paused, and uninstalled are
 *   skipped silently.
 * - No pile-up: a capability with a queued or running job is skipped until
 *   that job is terminal.
 * - Lease discipline: `held === false` means a sweep enqueues nothing.
 * - Unwired store/reactor is a named no-op tick, never a crash.
 * - Failure isolation: one capability's failure never stops the others, and
 *   the periodic loop itself survives and repeats (driven by the TestClock —
 *   no sleeps).
 * - The store seam: against the REAL store, a staged+installed+armed v2
 *   bundle is enqueued and a v1 bundle is not — the catalog → activeState →
 *   hash-verified manifest path is exercised for real.
 */
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - real files under temp roots are the fixture.
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Duration from "effect/Duration";
import * as TestClock from "effect/testing/TestClock";
import { createHash } from "node:crypto";
import * as NodeFs from "node:fs/promises";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import {
  FORGE_SDK_SCHEMA_VERSION,
  type ForgeCapabilityCatalogEntry,
} from "@t3tools/trading-contracts";

import {
  ForgeCapabilityStore,
  ForgeCapabilityStoreConfig,
  ForgeCapabilityStoreLive,
  type ForgeCapabilityStoreShape,
} from "./CapabilityStore.ts";
import {
  ForgeReactor,
  type ForgeReactorJobRecord,
  type ForgeReactorShape,
} from "./ForgeReactor.ts";
import { TradingRuntimeLease } from "../TradingRuntimeLease.ts";
import {
  DETECTOR_SWEEP_DEFAULT_INTERVAL_MS,
  DETECTOR_SWEEP_MIN_INTERVAL_MS,
  DetectorScheduler,
  makeDetectorScheduler,
  manifestSubstreamsSourceIds,
  resolveDetectorSweepIntervalMs,
  SubstreamsOutbox,
  type DetectorSchedulerShape,
  type SubstreamsOutboxEntry,
  type SubstreamsOutboxShape,
} from "./DetectorScheduler.ts";

const ENV = "env_sched";
const SWEEP_MS = 60_000;

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

const tempRoot = (): Promise<string> =>
  NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "detector-sched-"));

/** The environment directory must exist for the state-root scan to see it. */
const seedEnvironmentDir = (stateRoot: string): Promise<void> =>
  NodeFs.mkdir(NodePath.join(stateRoot, ENV), { recursive: true }).then(() => undefined);

// ---------------------------------------------------------------------------
// Scripted services
// ---------------------------------------------------------------------------

/** One capability as the stub store answers it. */
interface StubCapability {
  readonly capabilityId: string;
  readonly active: {
    readonly version: number;
    readonly bundleSha256: string;
    readonly status: "installed" | "paused";
    readonly armed: boolean;
  } | null;
  /** `manifest.json` bytes the artifact read returns; defaults to v2. */
  readonly manifestJson?: string;
  /** When true, `activeState` dies for this capability (failure isolation). */
  readonly dieOnActiveState?: boolean;
}

const v2Manifest = (capabilityId: string): string =>
  JSON.stringify({
    manifestVersion: 2,
    capabilityId,
    version: 1,
    semantics: "fixture detector",
    requiredSourceIds: ["github-releases:o/r"],
    outputFactKeys: ["flag"],
    artifacts: [
      { role: "sdk", path: "sdk.ts", sha256: sha256("sdk") },
      { role: "detector", path: "detector.ts", sha256: sha256("detector") },
      { role: "acceptance", path: "detector.test.ts", sha256: sha256("tests") },
    ],
    createdAtMs: 1_700_000_000_000,
  });

const v1Manifest = (capabilityId: string): string =>
  JSON.stringify({
    capabilityId,
    version: 1,
    schemaVersion: FORGE_SDK_SCHEMA_VERSION,
    description: "v1 fixture",
  });

const stubStore = (capabilities: ReadonlyArray<StubCapability>) =>
  Layer.succeed(ForgeCapabilityStore, {
    listCatalog: () =>
      Effect.succeed(
        capabilities
          .filter((capability) => capability.active !== null)
          .map((capability): ForgeCapabilityCatalogEntry => ({
            capabilityId: capability.capabilityId,
            version: capability.active!.version,
            bundleSha256: capability.active!.bundleSha256,
            description: "fixture",
            status: capability.active!.status,
            installedAtMs: 1_000,
          })),
      ),
    activeState: ({ capabilityId }: { readonly capabilityId: string }) => {
      const found = capabilities.find((capability) => capability.capabilityId === capabilityId);
      if (found === undefined) return Effect.succeed(null);
      if (found.dieOnActiveState === true) return Effect.die(new Error("scripted store failure"));
      return Effect.succeed(found.active);
    },
    readArtifact: ({
      path,
      capabilityId,
    }: {
      readonly path: string;
      readonly capabilityId: string;
    }) =>
      Effect.succeed(
        path === "manifest.json"
          ? (capabilities.find((capability) => capability.capabilityId === capabilityId)
              ?.manifestJson ?? v2Manifest(capabilityId))
          : null,
      ),
  } as unknown as ForgeCapabilityStoreShape);

/** The job record with readonly fields relaxed, so a test can complete a job. */
type StubJob = { -readonly [K in keyof ForgeReactorJobRecord]: ForgeReactorJobRecord[K] };

/**
 * The scripted reactor: `enqueues` records every enqueue; `jobs` mirrors each
 * enqueued job as `queued` (mutable, so a test completes it to unblock the
 * next sweep).
 */
const stubReactor = () => {
  const enqueues: Array<{
    readonly environmentId: string;
    readonly capabilityId: string;
    readonly programKind?: 2 | undefined;
  }> = [];
  const jobs: Array<StubJob> = [];
  /** Counted per `listJobs` call — each sweep makes exactly one. */
  let listCalls = 0;
  const layer = Layer.succeed(ForgeReactor, {
    enqueueEvaluation: (input: {
      readonly environmentId: string;
      readonly threadId?: string | undefined;
      readonly capabilityId: string;
      readonly programKind?: 2 | undefined;
    }) =>
      Effect.sync(() => {
        enqueues.push({
          environmentId: input.environmentId,
          capabilityId: input.capabilityId,
          ...(input.programKind === undefined ? {} : { programKind: input.programKind }),
        });
        const job: StubJob = {
          jobId: `fjob_sched_${enqueues.length}`,
          kind: "evaluation",
          status: "queued",
          environmentId: input.environmentId,
          ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
          createdAtMs: 1_000,
          capabilityId: input.capabilityId,
          ...(input.programKind === undefined ? {} : { programKind: input.programKind }),
        };
        jobs.push(job);
        return job;
      }),
    drain: () => Effect.void,
    cancel: () => Effect.succeed(false),
    listJobs: ({ environmentId }: { readonly environmentId: string }) =>
      Effect.sync(() => {
        listCalls += 1;
        return jobs
          .filter((job) => job.environmentId === environmentId)
          .slice(-50)
          .reverse();
      }),
    observedStatus: () => Effect.succeed(null),
  } as unknown as ForgeReactorShape);
  return { enqueues, jobs, listCalls: () => listCalls, layer };
};

/** The lease as a mutable ref, so a test can flip `held` mid-flight. */
const fakeLease = () => {
  const lease = { held: true, lockPath: null };
  return { lease, layer: Layer.succeed(TradingRuntimeLease, lease) };
};

/**
 * Compose the scheduler layer over the scripted services and a state root.
 * The optional store/reactor are PROVIDED into the scheduler's build context
 * (that is what `serviceOption` reads), so an absent member is the unwired
 * case, not a build failure. Explicit branches, not an array spread: the
 * layer combinators type-check a written-out composition, not a folded one.
 */
const schedulerOver = (input: {
  readonly stateRoot: string;
  readonly lease: Layer.Layer<TradingRuntimeLease>;
  readonly store?: Layer.Layer<ForgeCapabilityStore> | undefined;
  readonly reactor?: Layer.Layer<ForgeReactor> | undefined;
  readonly outbox?: Layer.Layer<SubstreamsOutbox> | undefined;
  readonly sweepIntervalMs?: number | undefined;
}): Layer.Layer<DetectorScheduler> => {
  const core = Layer.effect(
    DetectorScheduler,
    makeDetectorScheduler(input.sweepIntervalMs ?? SWEEP_MS),
  ).pipe(
    Layer.provide(input.lease),
    Layer.provide(Layer.succeed(ForgeCapabilityStoreConfig, { stateRoot: input.stateRoot })),
  );
  // Explicit branches, not a folded array: the layer combinators type-check
  // a written-out composition, not a spread one.
  if (input.store !== undefined && input.reactor !== undefined && input.outbox !== undefined) {
    return core.pipe(Layer.provideMerge(Layer.mergeAll(input.store, input.reactor, input.outbox)));
  }
  if (input.store !== undefined && input.reactor !== undefined) {
    return core.pipe(Layer.provideMerge(Layer.mergeAll(input.store, input.reactor)));
  }
  if (input.store !== undefined && input.outbox !== undefined) {
    return core.pipe(Layer.provideMerge(Layer.mergeAll(input.store, input.outbox)));
  }
  if (input.reactor !== undefined && input.outbox !== undefined) {
    return core.pipe(Layer.provideMerge(Layer.mergeAll(input.reactor, input.outbox)));
  }
  if (input.store !== undefined) return core.pipe(Layer.provideMerge(input.store));
  if (input.reactor !== undefined) return core.pipe(Layer.provideMerge(input.reactor));
  if (input.outbox !== undefined) return core.pipe(Layer.provideMerge(input.outbox));
  return core;
};

/** Run one sweep (or a body holding the scheduler) over a temp state root. */
const withScheduler = async (
  stateRoot: string,
  layer: Layer.Layer<DetectorScheduler>,
  body?: (scheduler: DetectorSchedulerShape) => Promise<void>,
): Promise<void> => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const scheduler = yield* DetectorScheduler;
      if (body === undefined) {
        yield* scheduler.sweep;
        return;
      }
      yield* Effect.promise(() => body(scheduler));
    }).pipe(Effect.provide(layer)),
  );
};

/**
 * Cooperatively drain pending resumptions (each yield gives completed IO
 * callbacks a turn to resume their fibers) until `done` holds, bounded so a
 * stuck fiber fails the assertion instead of hanging the suite. No clock, no
 * sleeps — the loop-under-test advances via TestClock in the caller.
 */
const settleUntil = (done: () => boolean): Effect.Effect<void> => {
  const step = (attempts: number): Effect.Effect<void> =>
    attempts === 0 || done()
      ? Effect.void
      : Effect.flatMap(Effect.yieldNow, () => step(attempts - 1));
  return step(500);
};

// ---------------------------------------------------------------------------
// The interval knob
// ---------------------------------------------------------------------------

describe("resolveDetectorSweepIntervalMs", () => {
  it("defaults to 60s, accepts positive integers, and floors at 5s", () => {
    assert.equal(resolveDetectorSweepIntervalMs({}), DETECTOR_SWEEP_DEFAULT_INTERVAL_MS);
    assert.equal(resolveDetectorSweepIntervalMs({ T3_DETECTOR_SWEEP_INTERVAL_MS: "" }), 60_000);
    assert.equal(
      resolveDetectorSweepIntervalMs({ T3_DETECTOR_SWEEP_INTERVAL_MS: "garbage" }),
      60_000,
    );
    assert.equal(
      resolveDetectorSweepIntervalMs({ T3_DETECTOR_SWEEP_INTERVAL_MS: "120000" }),
      120_000,
    );
    // Below the floor: clamped, never a hot loop.
    assert.equal(
      resolveDetectorSweepIntervalMs({ T3_DETECTOR_SWEEP_INTERVAL_MS: "1" }),
      DETECTOR_SWEEP_MIN_INTERVAL_MS,
    );
    assert.equal(resolveDetectorSweepIntervalMs({ T3_DETECTOR_SWEEP_INTERVAL_MS: "-5" }), 60_000);
  });
});

// ---------------------------------------------------------------------------
// The gate matrix (scripted services over a temp root)
// ---------------------------------------------------------------------------

describe("DetectorScheduler.sweep", () => {
  it("enqueues exactly one v2 job for the armed+installed capability, skipping unarmed, paused, v1 and uninstalled", async () => {
    const root = await tempRoot();
    try {
      await seedEnvironmentDir(root);
      const reactor = stubReactor();
      const store = stubStore([
        {
          capabilityId: "armed-v2",
          active: { version: 1, bundleSha256: "aa", status: "installed", armed: true },
        },
        {
          capabilityId: "unarmed-v2",
          active: { version: 1, bundleSha256: "bb", status: "installed", armed: false },
        },
        {
          capabilityId: "paused-v2",
          active: { version: 1, bundleSha256: "cc", status: "paused", armed: true },
        },
        {
          capabilityId: "armed-v1",
          active: { version: 1, bundleSha256: "dd", status: "installed", armed: true },
          manifestJson: v1Manifest("armed-v1"),
        },
        { capabilityId: "uninstalled-v2", active: null },
      ]);
      await withScheduler(
        root,
        schedulerOver({ stateRoot: root, lease: fakeLease().layer, store, reactor: reactor.layer }),
      );
      assert.deepEqual(reactor.enqueues, [
        { environmentId: ENV, capabilityId: "armed-v2", programKind: 2 },
      ]);
    } finally {
      await NodeFs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not enqueue a second job while one is non-terminal, then resumes when it is terminal", async () => {
    const root = await tempRoot();
    try {
      await seedEnvironmentDir(root);
      const reactor = stubReactor();
      const store = stubStore([
        {
          capabilityId: "armed-v2",
          active: { version: 1, bundleSha256: "aa", status: "installed", armed: true },
        },
      ]);
      const layer = schedulerOver({
        stateRoot: root,
        lease: fakeLease().layer,
        store,
        reactor: reactor.layer,
      });
      await withScheduler(root, layer);
      assert.equal(reactor.enqueues.length, 1);

      // The stub reactor mirrored the first enqueue as a `queued` job, so
      // the pending filter must hold the second sweep's enqueue back.
      await withScheduler(root, layer);
      assert.equal(reactor.enqueues.length, 1);

      // The job completes: the next sweep may enqueue again.
      reactor.jobs[0]!.status = "complete";
      await withScheduler(root, layer);
      assert.equal(reactor.enqueues.length, 2);
    } finally {
      await NodeFs.rm(root, { recursive: true, force: true });
    }
  });

  it("enqueues nothing when the lease is not held", async () => {
    const root = await tempRoot();
    try {
      await seedEnvironmentDir(root);
      const reactor = stubReactor();
      const store = stubStore([
        {
          capabilityId: "armed-v2",
          active: { version: 1, bundleSha256: "aa", status: "installed", armed: true },
        },
      ]);
      const lease = fakeLease();
      lease.lease.held = false;
      await withScheduler(
        root,
        schedulerOver({ stateRoot: root, lease: lease.layer, store, reactor: reactor.layer }),
      );
      assert.deepEqual(reactor.enqueues, []);
    } finally {
      await NodeFs.rm(root, { recursive: true, force: true });
    }
  });

  it("an unwired reactor is a no-op tick, never a crash", async () => {
    const root = await tempRoot();
    try {
      await seedEnvironmentDir(root);
      // No reactor layer at all: the sweep completes without throwing (and
      // trivially enqueues nothing — there is nothing to enqueue through).
      await withScheduler(
        root,
        schedulerOver({
          stateRoot: root,
          lease: fakeLease().layer,
          store: stubStore([
            {
              capabilityId: "armed-v2",
              active: { version: 1, bundleSha256: "aa", status: "installed", armed: true },
            },
          ]),
        }),
      );
    } finally {
      await NodeFs.rm(root, { recursive: true, force: true });
    }
  });

  it("one capability's failure never stops the others in the same sweep", async () => {
    const root = await tempRoot();
    try {
      await seedEnvironmentDir(root);
      const reactor = stubReactor();
      const store = stubStore([
        {
          capabilityId: "dying-v2",
          active: { version: 1, bundleSha256: "aa", status: "installed", armed: true },
          dieOnActiveState: true,
        },
        {
          capabilityId: "healthy-v2",
          active: { version: 1, bundleSha256: "bb", status: "installed", armed: true },
        },
      ]);
      await withScheduler(
        root,
        schedulerOver({ stateRoot: root, lease: fakeLease().layer, store, reactor: reactor.layer }),
      );
      assert.deepEqual(reactor.enqueues, [
        { environmentId: ENV, capabilityId: "healthy-v2", programKind: 2 },
      ]);
    } finally {
      await NodeFs.rm(root, { recursive: true, force: true });
    }
  });
});

// The loop itself: started under a TestClock, the sweep repeats on the
// interval, and the fork dies with the test scope — no sleeps anywhere.
it.effect("the periodic loop sweeps immediately and repeats on the interval", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = yield* Effect.promise(tempRoot);
      yield* Effect.promise(() => seedEnvironmentDir(root));
      const reactor = stubReactor();
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => NodeFs.rm(root, { recursive: true, force: true })),
      );
      yield* Effect.gen(function* () {
        const scheduler = yield* DetectorScheduler;
        yield* scheduler.start();
        // The first sweep fires immediately at start (before any interval).
        yield* settleUntil(() => reactor.listCalls() === 1);
        assert.equal(reactor.enqueues.length, 1);

        // Complete the queued job so the next sweep may enqueue again, then
        // advance the clock by one interval: exactly one more sweep.
        for (const job of reactor.jobs) job.status = "complete";
        yield* TestClock.adjust(Duration.millis(SWEEP_MS));
        yield* settleUntil(() => reactor.listCalls() === 2);
        assert.equal(reactor.enqueues.length, 2);

        // Ten more intervals, one at a time: a `spaced` schedule re-anchors
        // after each firing, so each single-interval advance fires exactly
        // one more sweep — ten alive ticks, ten fresh enqueues (the prior
        // job is completed before each advance), and the loop never died.
        for (let tick = 0; tick < 10; tick += 1) {
          for (const job of reactor.jobs) job.status = "complete";
          yield* TestClock.adjust(Duration.millis(SWEEP_MS));
          yield* settleUntil(() => reactor.listCalls() === 3 + tick);
        }
        assert.equal(reactor.listCalls(), 12);
        assert.equal(reactor.enqueues.length, 12);
      }).pipe(
        Effect.provide(
          schedulerOver({
            stateRoot: root,
            lease: fakeLease().layer,
            store: stubStore([
              {
                capabilityId: "armed-v2",
                active: { version: 1, bundleSha256: "aa", status: "installed", armed: true },
              },
            ]),
            reactor: reactor.layer,
          }),
        ),
      );
    }),
  ),
);

// ---------------------------------------------------------------------------
// The real store seam: catalog → activeState → hash-verified manifest
// ---------------------------------------------------------------------------

describe("DetectorScheduler against the real capability store", () => {
  /** Stage + install a bundle whose manifest bytes decide its program kind. */
  const installFixture = async (
    store: ForgeCapabilityStoreShape,
    capabilityId: string,
    manifestJson: string,
  ): Promise<void> => {
    const contents: Record<string, string> = {
      "detector.ts": "export const detect = 1;",
      "detector.test.ts": 'test("x", () => {});',
      "sdk.ts": "export const sdkFixture = 1;",
      "manifest.json": manifestJson,
    };
    const paths = Object.keys(contents).sort();
    const bundleSha256 = sha256(paths.map((path) => contents[path] ?? "").join("\n"));
    const staged = await Effect.runPromise(
      store.stageVersion(
        ENV,
        {
          capabilityId,
          version: 1,
          bundleSha256,
          artifacts: paths.map((path) => ({
            path,
            sha256: sha256(contents[path] ?? ""),
            bytes: Buffer.byteLength(contents[path] ?? "", "utf8"),
          })),
          manifest: {
            capabilityId,
            version: 1,
            schemaVersion: FORGE_SDK_SCHEMA_VERSION,
            description: "fixture",
          },
          createdAtMs: 1_000,
        },
        contents,
      ),
    );
    assert.equal(staged.status, "staged");
    const installed = await Effect.runPromise(
      store.install({
        environmentId: ENV,
        capabilityId,
        version: 1,
        bundleSha256,
        expectedActiveVersion: null,
      }),
    );
    assert.equal(installed.status, "installed");
  };

  it("enqueues an armed v2 capability and never a v1 one, through the real store reads", async () => {
    const root = await tempRoot();
    try {
      const storeLayer = ForgeCapabilityStoreLive.pipe(
        Layer.provide(Layer.succeed(ForgeCapabilityStoreConfig, { stateRoot: root })),
      );
      const store = await Effect.runPromise(Effect.provide(storeLayer)(ForgeCapabilityStore));
      await installFixture(store, "flag-detector", v2Manifest("flag-detector"));
      await installFixture(store, "wash-detector", v1Manifest("wash-detector"));
      // Arm BOTH: arming gates standing, the manifest gates the scheduler's
      // vocabulary — an armed v1 capability must still never be scheduled.
      await Effect.runPromise(store.arm({ environmentId: ENV, capabilityId: "flag-detector" }));
      await Effect.runPromise(store.arm({ environmentId: ENV, capabilityId: "wash-detector" }));

      const reactor = stubReactor();
      // The scheduler gets its own store instance over the same root: the
      // seed writes completed before the sweep reads, so there is never a
      // concurrent writer (the file store's own discipline).
      await withScheduler(
        root,
        schedulerOver({
          stateRoot: root,
          lease: fakeLease().layer,
          store: storeLayer,
          reactor: reactor.layer,
        }),
      );
      assert.deepEqual(reactor.enqueues, [
        { environmentId: ENV, capabilityId: "flag-detector", programKind: 2 },
      ]);
    } finally {
      await NodeFs.rm(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// The outbox drain — stream-committed evidence triggers evaluation
// ---------------------------------------------------------------------------

/** A v2 manifest binding arbitrary required source ids. */
const v2ManifestBinding = (
  capabilityId: string,
  requiredSourceIds: ReadonlyArray<string>,
): string =>
  JSON.stringify({
    manifestVersion: 2,
    capabilityId,
    version: 1,
    semantics: "fixture stream detector",
    requiredSourceIds,
    outputFactKeys: ["flag"],
    artifacts: [
      { role: "sdk", path: "sdk.ts", sha256: sha256("sdk") },
      { role: "detector", path: "detector.ts", sha256: sha256("detector") },
      { role: "acceptance", path: "detector.test.ts", sha256: sha256("tests") },
    ],
    createdAtMs: 1_700_000_000_000,
  });

/**
 * DEVELOPMENT FAKE — Worker A's durable outbox stand-in, implementing exactly
 * the consumer port (`SubstreamsOutboxShape`). Replaced by A's store at
 * integration; never shipped.
 */
const fakeOutbox = (entries: ReadonlyArray<SubstreamsOutboxEntry>) => {
  const pending: Array<SubstreamsOutboxEntry> = [...entries];
  const acked: Array<string> = [];
  const layer = Layer.succeed(SubstreamsOutbox, {
    readPending: ({
      environmentId,
      limit,
    }: {
      readonly environmentId: string;
      readonly limit: number;
    }) =>
      Effect.sync(() =>
        pending.filter((entry) => entry.environmentId === environmentId).slice(0, limit),
      ),
    ack: ({ outboxIds }: { readonly outboxIds: ReadonlyArray<string> }) =>
      Effect.sync(() => {
        for (const id of outboxIds) {
          const index = pending.findIndex((entry) => entry.outboxId === id);
          if (index >= 0) pending.splice(index, 1);
          if (!acked.includes(id)) acked.push(id);
        }
      }),
  } satisfies SubstreamsOutboxShape);
  return { pending, acked, layer };
};

const entry = (outboxId: string, sourceId: string): SubstreamsOutboxEntry => ({
  outboxId,
  environmentId: ENV,
  sourceId,
  committedAtMs: 2_000,
});

describe("manifestSubstreamsSourceIds", () => {
  it("extracts bare source ids from substreams bindings and rejects non-v2 shapes", () => {
    const manifest = v2ManifestBinding("cap", [
      "substreams:pool-obs-main:3600000",
      "graph-dataset:ds_1",
      "external:devcon:doc-1",
      "substreams:other.stream:60000",
    ]);
    assert.deepEqual(manifestSubstreamsSourceIds(manifest), ["pool-obs-main", "other.stream"]);
    assert.isNull(manifestSubstreamsSourceIds(v1Manifest("cap")));
    assert.isNull(manifestSubstreamsSourceIds("not json"));
    // A selector-less binding stays the bare id (it is malformed as a window
    // reference, but the drain must still see the source binding attempt).
    assert.deepEqual(manifestSubstreamsSourceIds(v2ManifestBinding("cap", ["substreams:pool"])), [
      "pool",
    ]);
  });
});

describe("DetectorScheduler.drainOutbox", () => {
  it("enqueues only armed v2 capabilities bound to the entry's source, then acks", async () => {
    const root = await tempRoot();
    try {
      await seedEnvironmentDir(root);
      const reactor = stubReactor();
      const outbox = fakeOutbox([entry("ob-1", "pool-obs-main")]);
      const store = stubStore([
        {
          capabilityId: "bound-armed",
          active: { version: 1, bundleSha256: "aa", status: "installed", armed: true },
          manifestJson: v2ManifestBinding("bound-armed", [
            "substreams:pool-obs-main:3600000",
            "external:devcon:doc-1",
          ]),
        },
        {
          // Bound to a DIFFERENT stream source: not this entry's consumer.
          capabilityId: "bound-other-stream",
          active: { version: 1, bundleSha256: "ee", status: "installed", armed: true },
          manifestJson: v2ManifestBinding("bound-other-stream", ["substreams:unrelated:60000"]),
        },
        {
          // Substreams-bound but unarmed: never evaluated.
          capabilityId: "bound-unarmed",
          active: { version: 1, bundleSha256: "bb", status: "installed", armed: false },
          manifestJson: v2ManifestBinding("bound-unarmed", ["substreams:pool-obs-main:3600000"]),
        },
        {
          // Armed v2 with no stream binding: the periodic sweep's business.
          capabilityId: "plain-v2",
          active: { version: 1, bundleSha256: "cc", status: "installed", armed: true },
        },
      ]);
      await Effect.runPromise(
        Effect.gen(function* () {
          const scheduler = yield* DetectorScheduler;
          yield* scheduler.drainOutbox;
        }).pipe(
          Effect.provide(
            schedulerOver({
              stateRoot: root,
              lease: fakeLease().layer,
              store,
              reactor: reactor.layer,
              outbox: outbox.layer,
            }),
          ),
        ),
      );
      assert.deepEqual(reactor.enqueues, [
        { environmentId: ENV, capabilityId: "bound-armed", programKind: 2 },
      ]);
      assert.deepEqual(outbox.acked, ["ob-1"]);
      assert.isEmpty(outbox.pending);
    } finally {
      await NodeFs.rm(root, { recursive: true, force: true });
    }
  });

  it("acks without a second enqueue when a non-terminal job already covers the capability", async () => {
    const root = await tempRoot();
    try {
      await seedEnvironmentDir(root);
      const reactor = stubReactor();
      // The stub mirrors each enqueue as a queued job; complete it so the
      // FIRST drain's job is terminal, then leave the second drain's new job
      // queued while a third entry arrives.
      const outbox = fakeOutbox([entry("ob-1", "pool-obs-main")]);
      const store = stubStore([
        {
          capabilityId: "bound-armed",
          active: { version: 1, bundleSha256: "aa", status: "installed", armed: true },
          manifestJson: v2ManifestBinding("bound-armed", ["substreams:pool-obs-main:3600000"]),
        },
      ]);
      const layer = schedulerOver({
        stateRoot: root,
        lease: fakeLease().layer,
        store,
        reactor: reactor.layer,
        outbox: outbox.layer,
      });
      await Effect.runPromise(
        Effect.gen(function* () {
          const scheduler = yield* DetectorScheduler;
          yield* scheduler.drainOutbox;
        }).pipe(Effect.provide(layer)),
      );
      assert.equal(reactor.enqueues.length, 1);
      assert.deepEqual(outbox.acked, ["ob-1"]);
      // New evidence while the first job is STILL queued: the entry is
      // honored (acked) without piling a second job on the capability.
      reactor.jobs[0]!.status = "running";
      outbox.pending.push(entry("ob-2", "pool-obs-main"));
      await Effect.runPromise(
        Effect.gen(function* () {
          const scheduler = yield* DetectorScheduler;
          yield* scheduler.drainOutbox;
        }).pipe(Effect.provide(layer)),
      );
      assert.equal(reactor.enqueues.length, 1);
      assert.deepEqual(outbox.acked, ["ob-1", "ob-2"]);
      assert.isEmpty(outbox.pending);
    } finally {
      await NodeFs.rm(root, { recursive: true, force: true });
    }
  });

  it("acks an entry with no bound capabilities instead of replaying it forever", async () => {
    const root = await tempRoot();
    try {
      await seedEnvironmentDir(root);
      const reactor = stubReactor();
      const outbox = fakeOutbox([entry("ob-lonely", "nobody-listens")]);
      const store = stubStore([
        {
          capabilityId: "plain-v2",
          active: { version: 1, bundleSha256: "aa", status: "installed", armed: true },
        },
      ]);
      await Effect.runPromise(
        Effect.gen(function* () {
          const scheduler = yield* DetectorScheduler;
          yield* scheduler.drainOutbox;
        }).pipe(
          Effect.provide(
            schedulerOver({
              stateRoot: root,
              lease: fakeLease().layer,
              store,
              reactor: reactor.layer,
              outbox: outbox.layer,
            }),
          ),
        ),
      );
      assert.isEmpty(reactor.enqueues);
      assert.deepEqual(outbox.acked, ["ob-lonely"]);
    } finally {
      await NodeFs.rm(root, { recursive: true, force: true });
    }
  });

  it("drains nothing when the lease is not held, and an unwired outbox is a no-op", async () => {
    const root = await tempRoot();
    try {
      await seedEnvironmentDir(root);
      const reactor = stubReactor();
      const outbox = fakeOutbox([entry("ob-1", "pool-obs-main")]);
      const store = stubStore([
        {
          capabilityId: "bound-armed",
          active: { version: 1, bundleSha256: "aa", status: "installed", armed: true },
          manifestJson: v2ManifestBinding("bound-armed", ["substreams:pool-obs-main:3600000"]),
        },
      ]);
      const lease = fakeLease();
      lease.lease.held = false;
      await Effect.runPromise(
        Effect.gen(function* () {
          const scheduler = yield* DetectorScheduler;
          yield* scheduler.drainOutbox;
        }).pipe(
          Effect.provide(
            schedulerOver({
              stateRoot: root,
              lease: lease.layer,
              store,
              reactor: reactor.layer,
              outbox: outbox.layer,
            }),
          ),
        ),
      );
      assert.isEmpty(reactor.enqueues);
      assert.isEmpty(outbox.acked);

      // Lease held but no outbox wired: a silent no-op, never a crash.
      await Effect.runPromise(
        Effect.gen(function* () {
          const scheduler = yield* DetectorScheduler;
          yield* scheduler.drainOutbox;
        }).pipe(
          Effect.provide(
            schedulerOver({
              stateRoot: root,
              lease: fakeLease().layer,
              store,
              reactor: reactor.layer,
            }),
          ),
        ),
      );
      assert.isEmpty(reactor.enqueues);
    } finally {
      await NodeFs.rm(root, { recursive: true, force: true });
    }
  });

  it("one entry's store failure leaves it pending while the next entry still drains and acks", async () => {
    const root = await tempRoot();
    try {
      await seedEnvironmentDir(root);
      const reactor = stubReactor();
      const outbox = fakeOutbox([
        entry("ob-dying", "pool-obs-main"),
        entry("ob-healthy", "other-source"),
      ]);
      const store = stubStore([
        {
          // Dies for this capability only; the dying entry drains it first
          // (both entries name ENV, catalog order is fixture order).
          capabilityId: "dying-v2",
          active: { version: 1, bundleSha256: "aa", status: "installed", armed: true },
          manifestJson: v2ManifestBinding("dying-v2", ["substreams:pool-obs-main:3600000"]),
          dieOnActiveState: true,
        },
        {
          capabilityId: "healthy-v2",
          active: { version: 1, bundleSha256: "bb", status: "installed", armed: true },
          manifestJson: v2ManifestBinding("healthy-v2", ["substreams:other-source:60000"]),
        },
      ]);
      await Effect.runPromise(
        Effect.gen(function* () {
          const scheduler = yield* DetectorScheduler;
          yield* scheduler.drainOutbox;
        }).pipe(
          Effect.provide(
            schedulerOver({
              stateRoot: root,
              lease: fakeLease().layer,
              store,
              reactor: reactor.layer,
              outbox: outbox.layer,
            }),
          ),
        ),
      );
      assert.deepEqual(reactor.enqueues, [
        { environmentId: ENV, capabilityId: "healthy-v2", programKind: 2 },
      ]);
      // The dying entry stays pending for the next drain; the healthy one acked.
      assert.deepEqual(outbox.acked, ["ob-healthy"]);
      assert.deepEqual(
        outbox.pending.map((pending) => pending.outboxId),
        ["ob-dying"],
      );
    } finally {
      await NodeFs.rm(root, { recursive: true, force: true });
    }
  });

  it("a full sweep drains the outbox before the periodic pass", async () => {
    const root = await tempRoot();
    try {
      await seedEnvironmentDir(root);
      const reactor = stubReactor();
      const outbox = fakeOutbox([entry("ob-1", "pool-obs-main")]);
      const store = stubStore([
        {
          capabilityId: "stream-bound",
          active: { version: 1, bundleSha256: "aa", status: "installed", armed: true },
          manifestJson: v2ManifestBinding("stream-bound", ["substreams:pool-obs-main:3600000"]),
        },
        {
          capabilityId: "plain-v2",
          active: { version: 1, bundleSha256: "bb", status: "installed", armed: true },
        },
      ]);
      await withScheduler(
        root,
        schedulerOver({
          stateRoot: root,
          lease: fakeLease().layer,
          store,
          reactor: reactor.layer,
          outbox: outbox.layer,
        }),
      );
      // The stream-bound capability got its evidence-triggered job from the
      // drain and then also appears in the periodic pass (it has no
      // non-terminal job only if the stub mirrored it — it did, as queued,
      // so the periodic pass skips it); plain-v2 is periodic-only.
      assert.includeDeepMembers(reactor.enqueues, [
        { environmentId: ENV, capabilityId: "stream-bound", programKind: 2 },
        { environmentId: ENV, capabilityId: "plain-v2", programKind: 2 },
      ]);
      assert.isEmpty(outbox.pending);
    } finally {
      await NodeFs.rm(root, { recursive: true, force: true });
    }
  });
});
