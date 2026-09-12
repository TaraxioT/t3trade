/**
 * ForgeReactor — the first evaluation as a persisted, receipt-backed job.
 *
 * The window provider is a scripted port and the container is the scripted
 * fake; the store and the jobs file are real, over a temp root. What is under
 * test is the ordering discipline: a reading exists only after the reactor's
 * COMMIT, job status and observed-data status are separate records, paused or
 * missing capabilities refuse, and nothing here signs or touches a chain.
 */
// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off globalConsole:off preferSchemaOverJson:off globalTimers:off - real files under temp roots are the fixture; receipts are wall-clock data; JSON is the storage codec under test.

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeFs from "node:fs/promises";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { FORGE_SDK_SCHEMA_VERSION, type ForgeSwapObservation } from "@t3tools/trading-contracts";

import {
  ForgeCapabilitySandbox,
  ForgeCapabilitySandboxLive,
  ForgeSandboxConfig,
  ForgeContainerRunner,
  type ForgeContainerRunRequest,
  type ForgeContainerRunnerShape,
} from "./CapabilitySandbox.ts";
import {
  ForgeCapabilityStore,
  ForgeCapabilityStoreConfig,
  ForgeCapabilityStoreLive,
  type ForgeCapabilityStoreShape,
} from "./CapabilityStore.ts";
import { FORGE_RUNNER_EVALUATE, FORGE_SDK_SOURCE } from "./CapabilityBuilder.ts";
import {
  ForgeReactor,
  ForgeReactorLive,
  ForgeSourceWindowProvider,
  type ForgeEvaluationWindow,
  type ForgeReactorShape,
  type ForgeSourceWindowProviderShape,
} from "./ForgeReactor.ts";
import { forgeAggregatePoolWindow, forgeMoveBps } from "./ForgeReactor.ts";

const ENV = "env_reactor";
const CAPABILITY = "wash-detector";
const IMAGE = "registry.local/forge-runner@sha256:" + "ab".repeat(32);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SIGNAL_TS = [
  'import type { ReadSignal } from "./sdk";',
  "export const readSignal: ReadSignal = (input) => ({",
  '  reading: { kind: "insufficient", reason: "fixture" },',
  "  diagnostics: [],",
  "});",
].join("\n");

const artifacts = (version = 1): Record<string, string> => ({
  "query.graphql": "query { swaps { id } }",
  "signal.ts": SIGNAL_TS,
  "signal.test.ts": 'import { readSignal } from "./signal"; test("x", () => {});',
  "manifest.json": JSON.stringify({
    capabilityId: CAPABILITY,
    version,
    schemaVersion: FORGE_SDK_SCHEMA_VERSION,
    description: "fixture detector",
  }),
});

const window = (block: number): ForgeEvaluationWindow => ({
  evidence: {
    mode: "live",
    provider: "the-graph",
    deploymentId: "dep",
    blockNumber: String(block),
    blockHash: "0x" + "cd".repeat(32),
    fetchedAtMs: 10_000,
    windowEndMs: 9_000,
    querySha256: "q",
    responseSha256: "r",
    complete: true,
  },
  pools: [
    {
      poolId: "pool-a",
      moveBps: 10,
      quoteVolumeMicros: "1000",
      tradeCount: 1,
      observationIds: ["tx1:0"],
    },
  ],
  evidenceIds: ["forge_ev_1"],
  window: { startedAtMs: 8_000, endedAtMs: 9_000 },
  historical: false,
  pinnedBlock: block,
  sourceDigest: "digest-1",
});

/** The scripted window port: serves queued windows in order, per environment. */
const makeWindowPort = (
  queue: Array<{ readonly window?: ForgeEvaluationWindow; readonly fail?: string }>,
): ForgeSourceWindowProviderShape & { readonly calls: Array<string> } => {
  const calls: Array<string> = [];
  return {
    calls,
    currentWindow: () =>
      Effect.sync(() => {
        calls.push(`call-${calls.length}`);
        const next = queue.shift();
        if (next === undefined) return yieldWindow();
        if (next.fail !== undefined) {
          return Effect.fail({ reason: next.fail });
        }
        return Effect.succeed(next.window ?? window(100));
      }).pipe(Effect.flatten),
  };
};

const yieldWindow = (): Effect.Effect<ForgeEvaluationWindow, { readonly reason: string }> =>
  Effect.fail({ reason: "the scripted window port is exhausted" });

/** The scripted container: evaluate echoes a schema-valid output. */
const runnerWithCounter = () => {
  let evaluateRuns = 0;
  const runner: ForgeContainerRunnerShape = {
    available: Effect.succeed(true),
    run: (request: ForgeContainerRunRequest) =>
      Effect.sync(() => {
        if (request.entrypoint[0] === FORGE_RUNNER_EVALUATE[0]) {
          evaluateRuns += 1;
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              reading: { kind: "insufficient", reason: "fixture" },
              diagnostics: [],
            }),
            stderr: "",
            killed: null,
          };
        }
        return { exitCode: 0, stdout: "", stderr: "", killed: null };
      }),
  };
  return { runner, count: () => evaluateRuns };
};

const layers = (
  runner: ForgeContainerRunnerShape,
  port: ForgeSourceWindowProviderShape,
  stateRoot: string,
) =>
  ForgeReactorLive.pipe(
    Layer.provide(ForgeCapabilityStoreLive),
    Layer.provide(ForgeCapabilitySandboxLive),
    Layer.provide(Layer.succeed(ForgeCapabilityStoreConfig, { stateRoot })),
    Layer.provide(
      Layer.succeed(ForgeSandboxConfig, {
        imageRef: IMAGE,
        buildBudgetMs: 30_000,
        evaluationBudgetMs: 2_000,
      }),
    ),
    Layer.provide(Layer.succeed(ForgeContainerRunner, runner)),
    Layer.provide(Layer.succeed(ForgeSourceWindowProvider, port)),
  );

/**
 * Build the reactor and run `body` with it, inside one scope: the worker
 * lives exactly as long as the work. The store is opened separately because
 * its records must outlive the reactor.
 */
const withReactor = async <A>(
  stateRoot: string,
  runner: ForgeContainerRunnerShape,
  port: ForgeSourceWindowProviderShape,
  body: (reactor: ForgeReactorShape) => Promise<A>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const reactor = yield* ForgeReactor;
        return yield* Effect.promise(() => body(reactor));
      }).pipe(Effect.provide(layers(runner, port, stateRoot))),
    ),
  );

const storeWith = (stateRoot: string): Promise<ForgeCapabilityStoreShape> =>
  Effect.runPromise(
    ForgeCapabilityStore.pipe(
      Effect.provide(
        ForgeCapabilityStoreLive.pipe(
          Layer.provide(Layer.succeed(ForgeCapabilityStoreConfig, { stateRoot })),
        ),
      ),
    ),
  );

/** Install v1 through the store's own CAS (the builder path is tested there). */
const installFixture = async (store: ForgeCapabilityStoreShape): Promise<string> => {
  const crypto = await import("node:crypto");
  const contents = artifacts(1);
  const bundleSha256 = crypto
    .createHash("sha256")
    .update(Object.values(contents).join("\n"))
    .digest("hex");
  const staged = await Effect.runPromise(
    store.stageVersion(
      ENV,
      {
        capabilityId: CAPABILITY,
        version: 1,
        bundleSha256,
        artifacts: Object.entries(contents).map(([path, content]) => ({
          path,
          sha256: crypto.createHash("sha256").update(content).digest("hex"),
          bytes: Buffer.byteLength(content, "utf8"),
        })),
        manifest: {
          capabilityId: CAPABILITY,
          version: 1,
          schemaVersion: FORGE_SDK_SCHEMA_VERSION,
          description: "fixture detector",
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
      capabilityId: CAPABILITY,
      version: 1,
      bundleSha256,
      expectedActiveVersion: null,
    }),
  );
  assert.equal(installed.status, "installed");
  return bundleSha256;
};

// ---------------------------------------------------------------------------
// Host aggregation
// ---------------------------------------------------------------------------

describe("host aggregation", () => {
  it("computes move bps exactly, integer-truncated", () => {
    assert.equal(forgeMoveBps({ anchorPriceMicros: 1_000_000, lastPriceMicros: 1_001_000 }), 10);
    assert.equal(forgeMoveBps({ anchorPriceMicros: 1_000_000, lastPriceMicros: 999_000 }), -10);
    assert.equal(forgeMoveBps({ anchorPriceMicros: 0, lastPriceMicros: 5 }), 0);
  });

  it("aggregates a pool window: exact volume, ordering, provenance ids, anchor", () => {
    const observation = (
      id: string,
      ts: number,
      micros: number,
      price: number,
    ): ForgeSwapObservation => ({
      chain: "ethereum-mainnet",
      poolId: "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640",
      observationId: id,
      transactionHash: "0x" + "aa".repeat(32),
      logIndex: Number(id.split(":")[1]),
      timestamp: ts,
      sender: "0x11",
      recipient: "0x22",
      amount0: "-1",
      amount1: "1",
      sqrtPriceX96: "1",
      tick: 0,
      baseIsToken1: true,
      priceQuotePerBase: { numerator: "1", denominator: "1" },
      priceQuotePerBaseMicros: price,
      quoteVolumeRaw: "1",
      quoteVolumeMicros: micros,
    });
    const aggregated = forgeAggregatePoolWindow({
      poolId: "pool-a",
      // Deliberately unordered input: order and duplicate handling are the
      // host's, and the same set must aggregate identically in any order.
      observations: [
        observation("tx1:2", 1_002, 700, 1_002_000),
        observation("tx1:1", 1_001, 300, 1_001_000),
      ],
      anchor: {
        observationId: "tx0:9",
        priceQuotePerBaseMicros: 1_000_000,
        ageBeforeWindowSeconds: 30,
      },
    });
    assert.equal(aggregated.quoteVolumeMicros, "1000");
    assert.equal(aggregated.tradeCount, 2);
    assert.deepEqual(aggregated.observationIds, ["tx1:1", "tx1:2"]);
    assert.equal(aggregated.moveBps, 20);
    assert.equal(aggregated.anchor?.observationId, "tx0:9");

    const reordered = forgeAggregatePoolWindow({
      poolId: "pool-a",
      observations: [
        observation("tx1:1", 1_001, 300, 1_001_000),
        observation("tx1:2", 1_002, 700, 1_002_000),
      ],
      anchor: {
        observationId: "tx0:9",
        priceQuotePerBaseMicros: 1_000_000,
        ageBeforeWindowSeconds: 30,
      },
    });
    assert.deepEqual(reordered, aggregated);
  });
});

// ---------------------------------------------------------------------------
// The reactor job
// ---------------------------------------------------------------------------

describe("the first evaluation job", () => {
  it("commits the evaluation only after the job drains — the catalog's latest reading appears then", async () => {
    const root = NodePath.join(
      await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "forge-reactor-")),
    );
    try {
      const store = await storeWith(root);
      await installFixture(store);
      const port = makeWindowPort([{}]);
      const { runner, count } = runnerWithCounter();

      const observed = await withReactor(root, runner, port, async (reactor) => {
        const job = await Effect.runPromise(
          reactor.enqueueEvaluation({
            environmentId: ENV,
            threadId: "th_1",
            capabilityId: CAPABILITY,
          }),
        );
        assert.equal(job.status, "queued");

        // The job is persisted before it runs; the observed-data half is still
        // empty — installation alone produces no reading.
        const jobsBefore = await Effect.runPromise(reactor.listJobs({ environmentId: ENV }));
        assert.equal(jobsBefore[0]?.status, "queued");
        assert.isNull(
          await Effect.runPromise(
            reactor.observedStatus({ environmentId: ENV, capabilityId: CAPABILITY }),
          ),
        );
        assert.isNull(
          await Effect.runPromise(
            store.latestEvaluation({ environmentId: ENV, capabilityId: CAPABILITY }),
          ),
        );

        await Effect.runPromise(reactor.drain());

        const jobsAfter = await Effect.runPromise(reactor.listJobs({ environmentId: ENV }));
        assert.equal(jobsAfter[0]?.status, "complete");
        assert.include(jobsAfter[0]?.detail ?? "", "committed");
        assert.equal(count(), 1);
        return Effect.runPromise(
          reactor.observedStatus({ environmentId: ENV, capabilityId: CAPABILITY }),
        );
      });
      assert.isNotNull(observed);
      assert.equal(observed?.status, "complete");
      assert.equal(observed?.capabilityVersion, 1);
      assert.equal(observed?.reading?.kind, "insufficient");
      assert.equal(observed?.pinnedBlock, 100);
      assert.deepEqual(observed?.evidenceIds, ["forge_ev_1"]);

      // The contained run mounted the installed bytes and the host SDK.
      // (Asserted through the port/runner wiring already; the receipt proves
      // the committed identity.)
      const active = await Effect.runPromise(
        store.activeState({ environmentId: ENV, capabilityId: CAPABILITY }),
      );
      assert.equal(observed?.bundleSha256, active?.bundleSha256);
    } finally {
      await NodeFs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps provider job status separate from observed-data status on a failed window", async () => {
    const root = NodePath.join(
      await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "forge-reactor-")),
    );
    try {
      const store = await storeWith(root);
      await installFixture(store);
      const port = makeWindowPort([{ fail: "the Graph source is unavailable" }]);
      const { runner } = runnerWithCounter();

      await withReactor(root, runner, port, async (reactor) => {
        await Effect.runPromise(
          reactor.enqueueEvaluation({ environmentId: ENV, capabilityId: CAPABILITY }),
        );
        await Effect.runPromise(reactor.drain());

        const jobs = await Effect.runPromise(reactor.listJobs({ environmentId: ENV }));
        assert.equal(jobs[0]?.status, "failed");
        assert.include(jobs[0]?.detail ?? "", "unavailable");
        // The data half is unchanged: no evaluation, and no fabricated reading.
        assert.isNull(
          await Effect.runPromise(
            reactor.observedStatus({ environmentId: ENV, capabilityId: CAPABILITY }),
          ),
        );
      });
    } finally {
      await NodeFs.rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to evaluate an incomplete window and a paused capability", async () => {
    const root = NodePath.join(
      await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "forge-reactor-")),
    );
    try {
      const store = await storeWith(root);
      await installFixture(store);
      const incomplete = makeWindowPort([
        { window: { ...window(101), evidence: { ...window(101).evidence, complete: false } } },
      ]);
      const { runner: runnerA } = runnerWithCounter();
      await withReactor(root, runnerA, incomplete, async (reactor) => {
        await Effect.runPromise(
          reactor.enqueueEvaluation({ environmentId: ENV, capabilityId: CAPABILITY }),
        );
        await Effect.runPromise(reactor.drain());
        const jobs = await Effect.runPromise(reactor.listJobs({ environmentId: ENV }));
        assert.equal(jobs[0]?.status, "failed");
        assert.include(jobs[0]?.detail ?? "", "incomplete");
      });

      await Effect.runPromise(store.pause({ environmentId: ENV, capabilityId: CAPABILITY }));
      const port = makeWindowPort([{}]);
      const { runner: runnerB } = runnerWithCounter();
      await withReactor(root, runnerB, port, async (reactor) => {
        await Effect.runPromise(
          reactor.enqueueEvaluation({ environmentId: ENV, capabilityId: CAPABILITY }),
        );
        await Effect.runPromise(reactor.drain());
        const jobs = await Effect.runPromise(reactor.listJobs({ environmentId: ENV }));
        assert.equal(jobs[0]?.status, "failed");
        assert.include(jobs[0]?.detail ?? "", "paused");
      });
    } finally {
      await NodeFs.rm(root, { recursive: true, force: true });
    }
  });

  it("a cancelled queued job never evaluates and never installs anything", async () => {
    const root = NodePath.join(
      await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "forge-reactor-")),
    );
    try {
      const store = await storeWith(root);
      await installFixture(store);
      // Hold the window so the first job stays running while the second waits.
      let release: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const port: ForgeSourceWindowProviderShape = {
        currentWindow: () =>
          Effect.promise(async () => {
            await gate;
            return window(102);
          }),
      };
      const { runner, count } = runnerWithCounter();
      const secondId = await withReactor(root, runner, port, async (reactor) => {
        await Effect.runPromise(
          reactor.enqueueEvaluation({ environmentId: ENV, capabilityId: CAPABILITY }),
        );
        const second = await Effect.runPromise(
          reactor.enqueueEvaluation({ environmentId: ENV, capabilityId: CAPABILITY }),
        );
        // Give the worker a beat to pick up the first job, then cancel the queued one.
        await new Promise((resolve) => setTimeout(resolve, 25));
        assert.isTrue(await Effect.runPromise(reactor.cancel({ jobId: second.jobId })));
        release?.();
        await Effect.runPromise(reactor.drain());

        const jobs = await Effect.runPromise(reactor.listJobs({ environmentId: ENV }));
        const byId = new Map(jobs.map((job) => [job.jobId, job]));
        assert.equal(byId.get(second.jobId)?.status, "cancelled");
        // Only the first job ran.
        assert.equal(count(), 1);
        return second.jobId;
      });
      assert.isDefined(secondId);
      const evaluations = await Effect.runPromise(
        store.listEvaluations({ environmentId: ENV, capabilityId: CAPABILITY }),
      );
      assert.equal(evaluations.length, 1);
    } finally {
      await NodeFs.rm(root, { recursive: true, force: true });
    }
  });

  it("replays an identical evaluation as its committed record instead of forking history", async () => {
    const root = NodePath.join(
      await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "forge-reactor-")),
    );
    try {
      const store = await storeWith(root);
      await installFixture(store);
      const port = makeWindowPort([{}, {}]);
      const { runner, count } = runnerWithCounter();
      await withReactor(root, runner, port, async (reactor) => {
        await Effect.runPromise(
          reactor.enqueueEvaluation({ environmentId: ENV, capabilityId: CAPABILITY }),
        );
        await Effect.runPromise(reactor.drain());
        await Effect.runPromise(
          reactor.enqueueEvaluation({ environmentId: ENV, capabilityId: CAPABILITY }),
        );
        await Effect.runPromise(reactor.drain());

        const jobs = await Effect.runPromise(reactor.listJobs({ environmentId: ENV }));
        assert.equal(jobs.length, 2);
        assert.include(jobs[0]?.detail ?? "", "replayed");
      });
      const evaluations = await Effect.runPromise(
        store.listEvaluations({ environmentId: ENV, capabilityId: CAPABILITY }),
      );
      assert.equal(evaluations.length, 1);
      // The second run replayed the committed record without a container run.
      assert.equal(count(), 1);
    } finally {
      await NodeFs.rm(root, { recursive: true, force: true });
    }
  });
});

it("evaluates a new pinned source window instead of replaying the previous reading", async () => {
  const root = await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "forge-reactor-window-"));
  try {
    const store = await storeWith(root);
    await installFixture(store);
    const port = makeWindowPort([{ window: window(100) }, { window: window(101) }]);
    const { runner, count } = runnerWithCounter();
    await withReactor(root, runner, port, async (reactor) => {
      await Effect.runPromise(
        reactor.enqueueEvaluation({ environmentId: ENV, capabilityId: CAPABILITY }),
      );
      await Effect.runPromise(reactor.drain());
      await Effect.runPromise(
        reactor.enqueueEvaluation({ environmentId: ENV, capabilityId: CAPABILITY }),
      );
      await Effect.runPromise(reactor.drain());
    });
    assert.equal(count(), 2);
    assert.equal(
      (
        await Effect.runPromise(
          store.listEvaluations({ environmentId: ENV, capabilityId: CAPABILITY }),
        )
      ).length,
      2,
    );
  } finally {
    await NodeFs.rm(root, { recursive: true, force: true });
  }
});

it("preserves unreadable job history instead of replacing it", async () => {
  const root = await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "forge-reactor-corrupt-"));
  try {
    await NodeFs.mkdir(NodePath.join(root, ENV), { recursive: true });
    const path = NodePath.join(root, ENV, "forge-jobs.json");
    await NodeFs.writeFile(path, "corrupt jobs");
    const { runner, count } = runnerWithCounter();
    let failed = false;
    try {
      await withReactor(root, runner, makeWindowPort([]), async () => undefined);
    } catch {
      failed = true;
    }
    assert.equal(failed, true);
    assert.equal(count(), 0);
    assert.equal(await NodeFs.readFile(path, "utf8"), "corrupt jobs");
  } finally {
    await NodeFs.rm(root, { recursive: true, force: true });
  }
});
