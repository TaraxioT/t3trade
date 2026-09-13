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
import { createHash } from "node:crypto";
import * as NodeFs from "node:fs/promises";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  FORGE_SDK_SCHEMA_VERSION,
  detectorEvaluationId,
  type ForgeSwapObservation,
} from "@t3tools/trading-contracts";

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
import {
  FORGE_RUNNER_EVALUATE,
  FORGE_RUNNER_EVALUATE_V2,
  FORGE_SDK_SOURCE,
} from "./CapabilityBuilder.ts";
import { FORGE_SWAPS_QUERY } from "./GraphSource.ts";
import {
  ForgeReactor,
  ForgeReactorLive,
  ForgeSourceWindowProvider,
  type ForgeEvaluationWindow,
  type ForgeReactorShape,
  type ForgeSourceWindowProviderShape,
} from "./ForgeReactor.ts";
import { forgeAggregatePoolWindow, forgeMoveBps } from "./ForgeReactor.ts";
import { DetectorFactWindowLive } from "./DetectorFactWindow.ts";
import {
  DetectorRunStore,
  DetectorRunStoreLive,
  type DetectorRunStoreShape,
} from "./DetectorRunStore.ts";
import {
  ForgeSourceStore,
  ForgeSourceStoreLive,
  type ForgeSourceStoreShape,
} from "./ForgeSourceStore.ts";
import {
  ExternalSourceStore,
  ExternalSourceStoreLive,
  type ExternalSourceRevision,
  type ExternalSourceStoreShape,
} from "../research/ExternalSourceStore.ts";
import createEvidenceTable from "../../persistence/Migrations/101_ForgeSourceEvidence.ts";
import createRevisionsTable from "../../persistence/Migrations/103_ExternalSourceRevisions.ts";
import createDetectorTables from "../../persistence/Migrations/105_DetectorRuns.ts";

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

/**
 * A validated bundle query: structurally the pinned reference, byte-different
 * (operation name, spacing), so hash assertions can tell bundle bytes from
 * the host constant.
 */
const BUNDLE_QUERY = `query InstalledSwaps($pool: String!, $first: Int!, $cursor: ID!, $block: Int!, $from: BigInt!, $to: BigInt!) {
  swaps(first: $first, where: { pool: $pool, id_gt: $cursor, timestamp_gte: $from, timestamp_lte: $to }, block: { number: $block }, orderBy: id, orderDirection: asc) {
    id timestamp sender recipient amount0 amount1 sqrtPriceX96 tick logIndex transaction { id }
  }
  _meta(block: { number: $block }) { deployment block { number hash } }
}`;

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

const artifacts = (version = 1): Record<string, string> => ({
  "query.graphql": BUNDLE_QUERY,
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
): ForgeSourceWindowProviderShape & {
  readonly calls: Array<string>;
  readonly queries: Array<string | undefined>;
} => {
  const calls: Array<string> = [];
  const queries: Array<string | undefined> = [];
  return {
    calls,
    queries,
    currentWindow: ({ query }) =>
      Effect.sync(() => {
        calls.push(`call-${calls.length}`);
        queries.push(query);
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
  const evaluateInputs: Array<{ evidence: { readonly querySha256: string } }> = [];
  const runner: ForgeContainerRunnerShape = {
    available: Effect.succeed(true),
    run: (request: ForgeContainerRunRequest) =>
      Effect.sync(() => {
        if (request.entrypoint[0] === FORGE_RUNNER_EVALUATE[0]) {
          evaluateRuns += 1;
          const input = JSON.parse(request.stdin ?? "{}") as {
            evidence: { readonly querySha256: string };
          };
          evaluateInputs.push(input);
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
  return { runner, count: () => evaluateRuns, evaluateInputs };
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
const installFixture = async (
  store: ForgeCapabilityStoreShape,
  contents: Record<string, string> = artifacts(1),
): Promise<string> => {
  const crypto = await import("node:crypto");
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

it("executes the installed bundle's query and stamps its hash into the evidence the capability sees", async () => {
  const root = await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "forge-reactor-query-"));
  try {
    const store = await storeWith(root);
    await installFixture(store);
    const seenQueries: Array<string | undefined> = [];
    // The port stands in for ForgeSourceWindow: it executes whatever query it
    // was handed and hashes THOSE bytes into the window evidence.
    const port: ForgeSourceWindowProviderShape = {
      currentWindow: ({ query }) =>
        Effect.sync(() => {
          seenQueries.push(query);
          return {
            ...window(100),
            evidence: { ...window(100).evidence, querySha256: sha256(query ?? "") },
          };
        }),
    };
    const { runner, count, evaluateInputs } = runnerWithCounter();
    assert.notEqual(sha256(BUNDLE_QUERY), sha256(FORGE_SWAPS_QUERY));
    await withReactor(root, runner, port, async (reactor) => {
      await Effect.runPromise(
        reactor.enqueueEvaluation({ environmentId: ENV, capabilityId: CAPABILITY }),
      );
      await Effect.runPromise(reactor.drain());
    });
    assert.deepEqual(seenQueries, [BUNDLE_QUERY]);
    assert.equal(count(), 1);
    // The capability's input evidence hashed the bundle's exact bytes — not
    // the host constant it replaced.
    assert.equal(evaluateInputs[0]?.evidence.querySha256, sha256(BUNDLE_QUERY));
    const committed = await Effect.runPromise(
      store.listEvaluations({ environmentId: ENV, capabilityId: CAPABILITY }),
    );
    assert.equal(committed.length, 1);
  } finally {
    await NodeFs.rm(root, { recursive: true, force: true });
  }
});

it("refuses to evaluate an installed bundle whose query.graphql fails validation — no window, no run", async () => {
  const root = await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "forge-reactor-badquery-"));
  try {
    const store = await storeWith(root);
    await installFixture(store, {
      ...artifacts(1),
      "query.graphql": "query { swaps { id } }",
    });
    const port = makeWindowPort([]);
    const { runner, count } = runnerWithCounter();
    await withReactor(root, runner, port, async (reactor) => {
      await Effect.runPromise(
        reactor.enqueueEvaluation({ environmentId: ENV, capabilityId: CAPABILITY }),
      );
      await Effect.runPromise(reactor.drain());
      const jobs = await Effect.runPromise(reactor.listJobs({ environmentId: ENV }));
      assert.equal(jobs[0]?.status, "failed");
      assert.include(jobs[0]?.detail ?? "", "installed query.graphql failed validation");
      assert.include(jobs[0]?.detail ?? "", "refusing to fall back to the host query");
    });
    assert.equal(port.calls.length, 0);
    assert.equal(count(), 0);
    assert.isEmpty(
      await Effect.runPromise(
        store.listEvaluations({ environmentId: ENV, capabilityId: CAPABILITY }),
      ),
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

// ---------------------------------------------------------------------------
// The detector-program (v2) job path
// ---------------------------------------------------------------------------
//
// The CONTAINED contract (real runner image, real tsc) is P4.2's coverage;
// here the container is the scripted fake returning a crafted
// DetectorProgramOutputV2, and what is under test is the reactor's ordering
// discipline: armed gate → sealed window from RETAINED evidence → state read
// → contained run → validated output → the one atomic DetectorRunStore
// commit, with the v1 pool-window path byte-identical beside it.

const V2_ENV = "env_reactor_v2";
const V2_CAP = "flag-detector";

/** The scripted detector container: parses stdin, answers from `respond`. */
const makeDetectorRunner = (
  respond: (
    input: unknown,
    run: number,
  ) => { readonly result: unknown; readonly nextState: unknown },
  options?: { readonly beforeRespond?: () => Promise<void> },
) => {
  const stdins: Array<string> = [];
  const filePaths: Array<ReadonlyArray<string>> = [];
  const runner: ForgeContainerRunnerShape = {
    available: Effect.succeed(true),
    run: (request: ForgeContainerRunRequest) =>
      request.entrypoint[0] === FORGE_RUNNER_EVALUATE_V2[0]
        ? Effect.promise(async () => {
            await options?.beforeRespond?.();
            stdins.push(request.stdin ?? "");
            filePaths.push(request.files.map((file) => file.path));
            const output = respond(JSON.parse(request.stdin ?? "{}"), stdins.length);
            return {
              exitCode: 0,
              stdout: JSON.stringify(output),
              stderr: "",
              killed: null,
            };
          })
        : Effect.sync(() => ({ exitCode: 0, stdout: "", stderr: "", killed: null })),
  };
  return { runner, stdins, filePaths };
};

/** A staged v2 bundle in the P4.2 route-around shape (four hashed paths). */
const detectorContents = (requiredSourceIds: ReadonlyArray<string>): Record<string, string> => {
  const contents: Record<string, string> = {
    "detector.ts":
      'import type { Detect } from "./sdk";\nexport const detect: Detect = (input) => ({ result: { status: "not-matched", evidenceIds: [], explanation: "fixture" }, nextState: { stateSchemaVersion: 1, state: { seen: input.asOfMs > 0 } } });',
    "detector.test.ts": 'import { test } from "./sdk";\ntest("fixture", () => {});',
    "sdk.ts": "export const sdkFixture = 1;",
  };
  contents["manifest.json"] = JSON.stringify({
    manifestVersion: 2,
    capabilityId: V2_CAP,
    version: 1,
    semantics: "fixture detector",
    requiredSourceIds,
    outputFactKeys: ["flag"],
    artifacts: [
      { role: "sdk", path: "sdk.ts", sha256: sha256(contents["sdk.ts"] ?? "") },
      { role: "detector", path: "detector.ts", sha256: sha256(contents["detector.ts"] ?? "") },
      {
        role: "acceptance",
        path: "detector.test.ts",
        sha256: sha256(contents["detector.test.ts"] ?? ""),
      },
    ],
    createdAtMs: 1_700_000_000_000,
  });
  return contents;
};

/** Stage + install a v2 bundle; arming stays the caller's separate act. */
const installDetector = async (
  store: ForgeCapabilityStoreShape,
  requiredSourceIds: ReadonlyArray<string>,
): Promise<void> => {
  const contents = detectorContents(requiredSourceIds);
  const hashedPaths = ["detector.test.ts", "detector.ts", "manifest.json", "sdk.ts"];
  const bundleSha256 = sha256(hashedPaths.map((path) => contents[path] ?? "").join("\n"));
  const staged = await Effect.runPromise(
    store.stageVersion(
      V2_ENV,
      {
        capabilityId: V2_CAP,
        version: 1,
        bundleSha256,
        artifacts: hashedPaths.map((path) => ({
          path,
          sha256: sha256(contents[path] ?? ""),
          bytes: Buffer.byteLength(contents[path] ?? "", "utf8"),
        })),
        manifest: {
          capabilityId: V2_CAP,
          version: 1,
          schemaVersion: FORGE_SDK_SCHEMA_VERSION,
          description: "[detector-program v2] fixture detector",
        },
        createdAtMs: 1_000,
      },
      contents,
    ),
  );
  assert.equal(staged.status, "staged");
  const installed = await Effect.runPromise(
    store.install({
      environmentId: V2_ENV,
      capabilityId: V2_CAP,
      version: 1,
      bundleSha256,
      expectedActiveVersion: null,
    }),
  );
  assert.equal(installed.status, "installed");
};

const v2Observation = (suffix: string, timestamp: number): ForgeSwapObservation => ({
  chain: "ethereum-mainnet",
  poolId: ("0x" + "1".repeat(40)) as `0x${string}`,
  observationId: `0x${suffix.repeat(64)}:0`,
  transactionHash: `0x${suffix.repeat(64)}`,
  logIndex: 0,
  timestamp,
  sender: "0xa",
  recipient: "0xb",
  amount0: "1000000",
  amount1: "-500",
  sqrtPriceX96: "1",
  tick: 0,
  baseIsToken1: true,
  priceQuotePerBase: { numerator: "2000", denominator: "1" },
  priceQuotePerBaseMicros: 2_000_000_000,
  quoteVolumeRaw: "1000000",
  quoteVolumeMicros: 1_000_000,
});

const V2_REVISION: ExternalSourceRevision = {
  revisionId: "rev-fixture",
  environmentId: V2_ENV,
  sourceKind: "github-releases",
  documentIdentity: "github-release:o/r:v1.0.0",
  sourceUrl: "https://github.com/o/r/releases/tag/v1.0.0",
  contentSha256: "a".repeat(64),
  publishedAtMs: 1_000,
  timePrecision: "instant",
  firstObservedAtMs: 2_000,
  captureMs: 2_000,
  correctionOf: null,
  retracted: false,
};

interface V2Helpers {
  readonly reactor: ForgeReactorShape;
  readonly store: ForgeCapabilityStoreShape;
  readonly graph: ForgeSourceStoreShape;
  readonly external: ExternalSourceStoreShape;
  readonly runs: DetectorRunStoreShape;
  readonly sql: SqlClient.SqlClient;
}

/**
 * Build the v2 reactor inside one layer graph with the real SQL services
 * (migrations included) and run `body` with every helper over the SAME
 * in-memory client — one writer by construction.
 */
const withDetectorReactor = async <A>(
  stateRoot: string,
  runner: ForgeContainerRunnerShape,
  body: (helpers: V2Helpers) => Promise<A>,
  options?: { readonly detectorRunsLayer?: Layer.Layer<DetectorRunStore> | undefined },
): Promise<A> => {
  const sql = NodeSqliteClient.layerMemory();
  const layers = Layer.mergeAll(
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
      Layer.provide(Layer.succeed(ForgeSourceWindowProvider, makeWindowPort([]))),
      Layer.provide(options?.detectorRunsLayer ?? DetectorRunStoreLive),
      Layer.provide(
        DetectorFactWindowLive.pipe(
          Layer.provide(ForgeSourceStoreLive),
          Layer.provide(ExternalSourceStoreLive),
        ),
      ),
    ),
    ForgeCapabilityStoreLive.pipe(
      Layer.provide(Layer.succeed(ForgeCapabilityStoreConfig, { stateRoot })),
    ),
    DetectorRunStoreLive,
    ForgeSourceStoreLive,
    ExternalSourceStoreLive,
  ).pipe(
    // provideMerge: satisfies every member's SqlClient requirement AND keeps
    // the client in the final context for the direct-SQL race fixtures below.
    Layer.provideMerge(sql),
  );
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* createEvidenceTable;
      yield* createRevisionsTable;
      yield* createDetectorTables;
      const reactor = yield* ForgeReactor;
      const store = yield* ForgeCapabilityStore;
      const graph = yield* ForgeSourceStore;
      const external = yield* ExternalSourceStore;
      const runs = yield* DetectorRunStore;
      const sqlClient = yield* SqlClient.SqlClient;
      return yield* Effect.promise(() =>
        body({ reactor, store, graph, external, runs, sql: sqlClient }),
      );
    }).pipe(Effect.provide(layers)),
  );
};

/** The default fixture evidence: one retained dataset plus one document. */
const seedV2Evidence = async (helpers: V2Helpers, datasetId: string): Promise<void> => {
  const observations = [v2Observation("e", 1_700_000_010)];
  await Effect.runPromise(
    helpers.graph.insert({
      record: {
        evidenceId: datasetId,
        environmentId: V2_ENV,
        poolId: observations[0]!.poolId,
        historical: true,
        endpoint: "https://example.test",
        deployment: "dep-1",
        pinnedBlock: 1_000,
        pinnedBlockHash: "0x" + "cd".repeat(32),
        windowStart: 1_700_000_000,
        windowEnd: 1_700_000_100,
        fetchedAtMs: 1_700_000_200_000,
        digest: createHash("sha256").update(JSON.stringify(observations)).digest("hex"),
        observationCount: observations.length,
      },
      observations,
    }),
  );
  await Effect.runPromise(
    helpers.external.insert({ revision: V2_REVISION, payloadJson: '{"id":1}' }),
  );
};

describe("the detector-program (v2) job", () => {
  it("commits revision 0 from retained evidence with a content-derived id and a stable input digest", async () => {
    const root = await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "forge-reactor-v2-"));
    try {
      const datasetId = `ds_${"e".repeat(21)}`;
      const { runner, stdins, filePaths } = makeDetectorRunner(() => ({
        result: { status: "not-matched", evidenceIds: [], explanation: "flag not set" },
        nextState: { stateSchemaVersion: 1, state: { count: 1 } },
      }));
      const latest = await withDetectorReactor(root, runner, async (helpers) => {
        await seedV2Evidence(helpers, datasetId);
        await installDetector(helpers.store, [
          `graph-dataset:${datasetId}`,
          "external:github-releases:github-release:o/r:v1.0.0",
        ]);
        await Effect.runPromise(helpers.store.arm({ environmentId: V2_ENV, capabilityId: V2_CAP }));

        const job = await Effect.runPromise(
          helpers.reactor.enqueueEvaluation({
            environmentId: V2_ENV,
            threadId: "th_v2",
            capabilityId: V2_CAP,
            programKind: 2,
          }),
        );
        assert.equal(job.programKind, 2);
        await Effect.runPromise(helpers.reactor.drain());

        const jobs = await Effect.runPromise(helpers.reactor.listJobs({ environmentId: V2_ENV }));
        assert.equal(jobs[0]?.status, "complete");
        assert.include(jobs[0]?.detail ?? "", "committed at state revision 0");

        const state = await Effect.runPromise(helpers.runs.readState(V2_ENV, V2_CAP));
        assert.isNotNull(state);
        assert.equal(state?.stateRevision, 0);
        return Effect.runPromise(helpers.runs.latestEvaluation(V2_ENV, V2_CAP));
      });

      // One contained run, mounting the bundle exactly as staged.
      assert.equal(stdins.length, 1);
      assert.deepEqual([...(filePaths[0] ?? [])].sort(), [
        "detector.test.ts",
        "detector.ts",
        "manifest.json",
        "sdk.ts",
      ]);
      const stdin = JSON.parse(stdins[0] ?? "{}") as {
        readonly programSchemaVersion: number;
        readonly asOfMs: number;
        readonly inputDigest: string;
        readonly facts: ReadonlyArray<{ readonly key: string }>;
        readonly sources: ReadonlyArray<{ readonly sourceId: string }>;
        readonly priorState?: unknown;
      };
      assert.equal(stdin.programSchemaVersion, 2);
      assert.isUndefined(stdin.priorState);
      // The sealed window carried both sources and only bounded facts.
      assert.deepEqual(
        stdin.sources.map((source) => source.sourceId),
        [`graph-dataset:${datasetId}`, "external:github-releases:github-release:o/r:v1.0.0"],
      );
      // Six graph summary facts (the two exact flow facts came with the
      // "expose exact flow facts" change) plus the two external document facts.
      assert.equal(stdin.facts.length, 8);

      // The digest is a rebuild from the identical sealed bytes: same
      // {asOfMs, facts, sources, priorState} in, same digest out.
      const rebuilt = createHash("sha256")
        .update(
          JSON.stringify({
            asOfMs: stdin.asOfMs,
            facts: stdin.facts,
            sources: stdin.sources,
            priorState: stdin.priorState,
          }),
        )
        .digest("hex");
      assert.equal(stdin.inputDigest, rebuilt);

      assert.isNotNull(latest);
      assert.equal(
        latest?.evaluationId,
        detectorEvaluationId({
          environmentId: V2_ENV,
          capabilityId: V2_CAP,
          version: 1,
          stateRevision: 0,
          inputDigest: rebuilt,
        }),
      );
      assert.deepEqual(latest?.evidenceIds, [datasetId, "rev-fixture"]);
      assert.equal(latest?.result.status, "not-matched");
    } finally {
      await NodeFs.rm(root, { recursive: true, force: true });
    }
  });

  it("advances the state revision on a second sequential job, feeding the committed state back", async () => {
    const root = await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "forge-reactor-v2-"));
    try {
      const datasetId = `ds_${"f".repeat(21)}`;
      const { runner, stdins } = makeDetectorRunner((_input, run) => ({
        result: { status: "not-matched", evidenceIds: [], explanation: "flag not set" },
        nextState: { stateSchemaVersion: 1, state: { count: run } },
      }));
      await withDetectorReactor(root, runner, async (helpers) => {
        await seedV2Evidence(helpers, datasetId);
        await installDetector(helpers.store, [`graph-dataset:${datasetId}`]);
        await Effect.runPromise(helpers.store.arm({ environmentId: V2_ENV, capabilityId: V2_CAP }));

        for (let index = 0; index < 2; index += 1) {
          await Effect.runPromise(
            helpers.reactor.enqueueEvaluation({
              environmentId: V2_ENV,
              capabilityId: V2_CAP,
              programKind: 2,
            }),
          );
          await Effect.runPromise(helpers.reactor.drain());
        }

        const state = await Effect.runPromise(helpers.runs.readState(V2_ENV, V2_CAP));
        assert.equal(state?.stateRevision, 1);
        const listed = await Effect.runPromise(helpers.runs.listEvaluations(V2_ENV, V2_CAP));
        assert.equal(listed.length, 2);
        assert.deepEqual(
          listed.map((record) => record.stateRevision),
          [1, 0],
        );
      });
      // The second run received the first run's committed envelope.
      const second = JSON.parse(stdins[1] ?? "{}") as { readonly priorState?: unknown };
      assert.deepEqual(second.priorState, { stateSchemaVersion: 1, state: { count: 1 } });
    } finally {
      await NodeFs.rm(root, { recursive: true, force: true });
    }
  });

  it("fails named state-revision-conflict when the state row advances mid-run, corrupting nothing", async () => {
    const root = await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "forge-reactor-v2-"));
    try {
      const datasetId = `ds_${"7".repeat(21)}`;
      let release: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      // The gate parks ONLY the third run; the first two commits proceed so
      // the initial enqueue/drain pairs complete.
      let runnerCalls = 0;
      const gateThirdRunOnly = () => {
        runnerCalls += 1;
        return runnerCalls <= 2 ? Promise.resolve() : gate;
      };
      const { runner } = makeDetectorRunner(
        () => ({
          result: { status: "not-matched", evidenceIds: [], explanation: "flag not set" },
          nextState: { stateSchemaVersion: 1, state: { count: 99 } },
        }),
        { beforeRespond: gateThirdRunOnly },
      );
      await withDetectorReactor(root, runner, async (helpers) => {
        await seedV2Evidence(helpers, datasetId);
        await installDetector(helpers.store, [`graph-dataset:${datasetId}`]);
        await Effect.runPromise(helpers.store.arm({ environmentId: V2_ENV, capabilityId: V2_CAP }));

        // Two committed revisions first.
        for (let index = 0; index < 2; index += 1) {
          await Effect.runPromise(
            helpers.reactor.enqueueEvaluation({
              environmentId: V2_ENV,
              capabilityId: V2_CAP,
              programKind: 2,
            }),
          );
          await Effect.runPromise(helpers.reactor.drain());
        }

        // The third job reads state at revision 1, then parks inside the
        // container while a concurrent writer (here: direct SQL, standing in
        // for any racing committer) advances the row.
        await Effect.runPromise(
          helpers.reactor.enqueueEvaluation({
            environmentId: V2_ENV,
            capabilityId: V2_CAP,
            programKind: 2,
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 50));
        await Effect.runPromise(helpers.sql`
          UPDATE forge_detector_state SET state_revision = 50 WHERE capability_id = ${V2_CAP}
        `);
        release?.();
        await Effect.runPromise(helpers.reactor.drain());

        const jobs = await Effect.runPromise(helpers.reactor.listJobs({ environmentId: V2_ENV }));
        assert.equal(jobs[0]?.status, "failed");
        assert.include(jobs[0]?.detail ?? "", "state-revision-conflict");
        // Nothing corrupted: still two evaluations, and the winner's state row
        // stands untouched at the revision the losing commit refused against.
        const listed = await Effect.runPromise(helpers.runs.listEvaluations(V2_ENV, V2_CAP));
        assert.equal(listed.length, 2);
        const state = await Effect.runPromise(helpers.runs.readState(V2_ENV, V2_CAP));
        assert.equal(state?.stateRevision, 50);
      });
    } finally {
      await NodeFs.rm(root, { recursive: true, force: true });
    }
  });

  it("refuses an un-armed capability by name and a paused one by pause semantics", async () => {
    const root = await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "forge-reactor-v2-"));
    try {
      const datasetId = `ds_${"8".repeat(21)}`;
      const { runner, stdins } = makeDetectorRunner(() => ({
        result: { status: "not-matched", evidenceIds: [], explanation: "flag not set" },
        nextState: { stateSchemaVersion: 1, state: {} },
      }));
      await withDetectorReactor(root, runner, async (helpers) => {
        await seedV2Evidence(helpers, datasetId);
        await installDetector(helpers.store, [`graph-dataset:${datasetId}`]);
        // Installed but NOT armed: installation alone never evaluates.
        await Effect.runPromise(
          helpers.reactor.enqueueEvaluation({
            environmentId: V2_ENV,
            capabilityId: V2_CAP,
            programKind: 2,
          }),
        );
        await Effect.runPromise(helpers.reactor.drain());
        let jobs = await Effect.runPromise(helpers.reactor.listJobs({ environmentId: V2_ENV }));
        assert.equal(jobs[0]?.status, "failed");
        assert.include(jobs[0]?.detail ?? "", "not armed");
        assert.isEmpty(
          (await Effect.runPromise(helpers.runs.listEvaluations(V2_ENV, V2_CAP))).map(
            (record) => record,
          ),
        );
        assert.isNull(await Effect.runPromise(helpers.runs.readState(V2_ENV, V2_CAP)));
        assert.equal(stdins.length, 0);

        // Armed but paused: the pause gate holds before the armed gate matters.
        await Effect.runPromise(helpers.store.arm({ environmentId: V2_ENV, capabilityId: V2_CAP }));
        await Effect.runPromise(
          helpers.store.pause({ environmentId: V2_ENV, capabilityId: V2_CAP }),
        );
        await Effect.runPromise(
          helpers.reactor.enqueueEvaluation({
            environmentId: V2_ENV,
            capabilityId: V2_CAP,
            programKind: 2,
          }),
        );
        await Effect.runPromise(helpers.reactor.drain());
        jobs = await Effect.runPromise(helpers.reactor.listJobs({ environmentId: V2_ENV }));
        assert.equal(jobs[0]?.status, "failed");
        assert.include(jobs[0]?.detail ?? "", "paused");
      });
    } finally {
      await NodeFs.rm(root, { recursive: true, force: true });
    }
  });

  it("commits an unknown result over a partially-missing window — unknown is a result, not a failure", async () => {
    const root = await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "forge-reactor-v2-"));
    try {
      const datasetId = `ds_${"9".repeat(21)}`;
      const { runner, stdins } = makeDetectorRunner(() => ({
        result: {
          status: "unknown",
          missingSourceIds: ["external:github-releases:never-captured"],
          explanation: "a required source is absent",
        },
        nextState: { stateSchemaVersion: 1, state: {} },
      }));
      await withDetectorReactor(root, runner, async (helpers) => {
        await seedV2Evidence(helpers, datasetId);
        await installDetector(helpers.store, [
          `graph-dataset:${datasetId}`,
          "external:github-releases:never-captured",
        ]);
        await Effect.runPromise(helpers.store.arm({ environmentId: V2_ENV, capabilityId: V2_CAP }));

        await Effect.runPromise(
          helpers.reactor.enqueueEvaluation({
            environmentId: V2_ENV,
            capabilityId: V2_CAP,
            programKind: 2,
          }),
        );
        await Effect.runPromise(helpers.reactor.drain());

        const jobs = await Effect.runPromise(helpers.reactor.listJobs({ environmentId: V2_ENV }));
        assert.equal(jobs[0]?.status, "complete");
        const latest = await Effect.runPromise(helpers.runs.latestEvaluation(V2_ENV, V2_CAP));
        assert.equal(latest?.result.status, "unknown");
        // Only the resolved source's evidence is committed.
        assert.deepEqual(latest?.evidenceIds, [datasetId]);
        const state = await Effect.runPromise(helpers.runs.readState(V2_ENV, V2_CAP));
        assert.equal(state?.stateRevision, 0);
      });
      // The program saw one source and no facts from the missing one.
      const stdin = JSON.parse(stdins[0] ?? "{}") as {
        readonly sources: ReadonlyArray<{ readonly sourceId: string }>;
      };
      assert.equal(stdin.sources.length, 1);
    } finally {
      await NodeFs.rm(root, { recursive: true, force: true });
    }
  });

  it("maps a replayed commit outcome to a completed job (dedup), never a second row", async () => {
    const root = await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "forge-reactor-v2-"));
    try {
      const datasetId = `ds_${"a".repeat(21)}`;
      const { runner, stdins } = makeDetectorRunner(() => ({
        result: { status: "not-matched", evidenceIds: [], explanation: "flag not set" },
        nextState: { stateSchemaVersion: 1, state: {} },
      }));
      // The replay CAS semantics live in DetectorRunStore.test.ts; here the
      // seam is synthesized (commitRun always reports a replay) to pin the
      // REACTOR's mapping: replay is a completed job with a replay note.
      const replayingRuns = Layer.succeed(DetectorRunStore, {
        readState: () => Effect.succeed(null),
        commitRun: () => Effect.succeed({ status: "replayed" as const }),
        latestEvaluation: () => Effect.succeed(null),
        listEvaluations: () => Effect.succeed([]),
        // Occurrence stubs (Worker B's occurrence boundary): this fixture's
        // results are never matched, so the recording path is never taken.
        recordOccurrence: () => Effect.succeed({ status: "recorded" as const }),
        readOccurrence: () => Effect.succeed(null),
        consumeOccurrence: () => Effect.succeed({ status: "not-found" as const }),
      } satisfies DetectorRunStoreShape);
      await withDetectorReactor(
        root,
        runner,
        async (helpers) => {
          await seedV2Evidence(helpers, datasetId);
          await installDetector(helpers.store, [`graph-dataset:${datasetId}`]);
          await Effect.runPromise(
            helpers.store.arm({ environmentId: V2_ENV, capabilityId: V2_CAP }),
          );
          await Effect.runPromise(
            helpers.reactor.enqueueEvaluation({
              environmentId: V2_ENV,
              capabilityId: V2_CAP,
              programKind: 2,
            }),
          );
          await Effect.runPromise(helpers.reactor.drain());
          const jobs = await Effect.runPromise(helpers.reactor.listJobs({ environmentId: V2_ENV }));
          assert.equal(jobs[0]?.status, "complete");
          assert.include(jobs[0]?.detail ?? "", "replayed");
        },
        { detectorRunsLayer: replayingRuns },
      );
      assert.equal(stdins.length, 1);
    } finally {
      await NodeFs.rm(root, { recursive: true, force: true });
    }
  });

  it("a cancelled queued v2 job never runs and writes no rows", async () => {
    const root = await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "forge-reactor-v2-"));
    try {
      const datasetId = `ds_${"b".repeat(21)}`;
      let release: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { runner, stdins } = makeDetectorRunner(
        () => ({
          result: { status: "not-matched", evidenceIds: [], explanation: "flag not set" },
          nextState: { stateSchemaVersion: 1, state: {} },
        }),
        { beforeRespond: () => gate },
      );
      await withDetectorReactor(root, runner, async (helpers) => {
        await seedV2Evidence(helpers, datasetId);
        await installDetector(helpers.store, [`graph-dataset:${datasetId}`]);
        await Effect.runPromise(helpers.store.arm({ environmentId: V2_ENV, capabilityId: V2_CAP }));

        // The first job parks inside the container; the second waits queued.
        await Effect.runPromise(
          helpers.reactor.enqueueEvaluation({
            environmentId: V2_ENV,
            capabilityId: V2_CAP,
            programKind: 2,
          }),
        );
        const second = await Effect.runPromise(
          helpers.reactor.enqueueEvaluation({
            environmentId: V2_ENV,
            capabilityId: V2_CAP,
            programKind: 2,
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.isTrue(await Effect.runPromise(helpers.reactor.cancel({ jobId: second.jobId })));
        release?.();
        await Effect.runPromise(helpers.reactor.drain());

        const jobs = await Effect.runPromise(helpers.reactor.listJobs({ environmentId: V2_ENV }));
        const byId = new Map(jobs.map((job) => [job.jobId, job]));
        assert.equal(byId.get(second.jobId)?.status, "cancelled");
        // Only the first job ran and committed.
        assert.equal(stdins.length, 1);
        const listed = await Effect.runPromise(helpers.runs.listEvaluations(V2_ENV, V2_CAP));
        assert.equal(listed.length, 1);
      });
    } finally {
      await NodeFs.rm(root, { recursive: true, force: true });
    }
  });
});
