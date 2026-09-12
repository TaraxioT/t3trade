/**
 * CapabilityBuilder — the host's orchestration, held to its contract.
 *
 * The sandbox is the scripted fake from the sandbox tests; the staging
 * workspace is a real temp directory holding real files (and, for the refusal
 * cases, symlinks, extra files, oversized bundles, and hostile imports). The
 * store is the real file store over a temp root. No Docker, no provider, no
 * network.
 *
 * The core property under test: a bundle reaches `ready` only through the
 * host's own checks and hashes, and nothing here installs anything.
 */
// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off globalConsole:off preferSchemaOverJson:off - real files under temp roots are the fixture; receipts are wall-clock data; JSON is the storage codec under test.

import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as NodeFsSync from "node:fs";
import * as NodeFs from "node:fs/promises";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
  FORGE_MAX_BUNDLE_BYTES,
  FORGE_SDK_SCHEMA_VERSION,
  type ForgeAcceptanceCase,
  type ForgeAcceptanceCaseV2,
  type ForgeSignalInput,
} from "@t3tools/trading-contracts";

import {
  ForgeCapabilitySandbox,
  ForgeCapabilitySandboxLive,
  forgeSha256Hex,
  ForgeSandboxConfig,
  ForgeSandboxError,
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
import { ForgeBuilderError, type ForgeCapabilityBuilderShape } from "./CapabilityBuilder.ts";
import {
  declaredImports,
  DETECTOR_SDK_SCHEMA_VERSION,
  ForgeCapabilityBuilder,
  ForgeCapabilityBuilderLive,
  forgeBundleSha256,
  FORGE_RUNNER_EVALUATE,
  FORGE_RUNNER_EVALUATE_V2,
  FORGE_RUNNER_TEST,
  FORGE_RUNNER_TYPECHECK,
  FORGE_SDK_SOURCE_V2,
  forgeDetectorBundleSha256,
  readAuthoringWorkspace,
  validateAuthoredArtifacts,
  validateAuthoredDetectorArtifacts,
  validateDiagnosticsAgainstInput,
} from "./CapabilityBuilder.ts";

const ENV = "env_builder";
const CAPABILITY = "wash-detector";
const IMAGE = "registry.local/forge-runner@sha256:" + "ab".repeat(32);

// ---------------------------------------------------------------------------
// Fixtures: the authored workspace and the scripted container
// ---------------------------------------------------------------------------

const manifestJson = (version: number, capabilityId = CAPABILITY): string =>
  JSON.stringify({
    capabilityId,
    version,
    schemaVersion: FORGE_SDK_SCHEMA_VERSION,
    description: "flag coordinated wash trading across the approved pools",
  });

/**
 * A validated bundle query: structurally identical to the pinned reference
 * (field sets, nesting, variables), byte-different (operation name, spacing)
 * — exactly what a generated query.graphql legitimately looks like.
 */
const CAPABILITY_QUERY = `query GeneratedSwaps($pool: String!, $first: Int!, $cursor: ID!, $block: Int!, $from: BigInt!, $to: BigInt!) {
  swaps(first: $first, where: { pool: $pool, id_gt: $cursor, timestamp_gte: $from, timestamp_lte: $to }, block: { number: $block }, orderBy: id, orderDirection: asc) {
    id timestamp sender recipient amount0 amount1 sqrtPriceX96 tick logIndex transaction { id }
  }
  _meta(block: { number: $block }) { deployment block { number hash } }
}`;

const goodArtifacts = (version = 1): Record<string, string> => ({
  "query.graphql": CAPABILITY_QUERY,
  "signal.ts": [
    'import type { ReadSignal, SignalInput, SignalOutput } from "./sdk";',
    "export const readSignal: ReadSignal = (input: SignalInput): SignalOutput => {",
    '  return { reading: { kind: "insufficient", reason: "fixture detector" }, diagnostics: [] };',
    "};",
  ].join("\n"),
  "signal.test.ts": [
    'import { readSignal } from "./signal";',
    'import { describe, test, expect } from "./sdk";',
    'describe("signal", () => { test("compiles", () => { expect(readSignal).toBeDefined(); }); });',
  ].join("\n"),
  "manifest.json": manifestJson(version),
});

const writeWorkspace = async (contents: Record<string, string>): Promise<string> => {
  const dir = NodePath.join(await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "forge-stage-")));
  for (const [name, content] of Object.entries(contents)) {
    await NodeFs.writeFile(NodePath.join(dir, name), content, "utf8");
  }
  return dir;
};

const inputWindow = (): ForgeSignalInput => ({
  evidence: {
    mode: "live",
    provider: "the-graph",
    deploymentId: "dep",
    blockNumber: "1000",
    blockHash: "0x" + "cd".repeat(32),
    fetchedAtMs: 1_000,
    windowEndMs: 900,
    querySha256: "q",
    responseSha256: "r",
    complete: true,
  },
  pools: [
    {
      poolId: "pool-a",
      moveBps: 42,
      quoteVolumeMicros: "500000",
      tradeCount: 2,
      observationIds: ["tx1:1", "tx1:2"],
    },
  ],
});

const acceptanceCase = (): ForgeAcceptanceCase => ({
  name: "insufficient fixture",
  input: inputWindow(),
  expected: { kind: "insufficient", reason: "fixture detector" },
});

/**
 * The scripted container: typecheck and tests pass; evaluate echoes a
 * canned SignalOutput for the input it was fed. Calls are recorded so tests
 * can assert what the host actually ran.
 */
const makeHappyRunner = (outputFor?: (input: ForgeSignalInput) => unknown) => {
  const requests: Array<ForgeContainerRunRequest> = [];
  const runner: ForgeContainerRunnerShape = {
    available: Effect.succeed(true),
    run: (request) =>
      Effect.sync(() => {
        requests.push(request);
        const head = request.entrypoint[0];
        if (head === FORGE_RUNNER_TYPECHECK[0] || head === FORGE_RUNNER_TEST[0]) {
          return { exitCode: 0, stdout: "", stderr: "", killed: null };
        }
        if (head === FORGE_RUNNER_EVALUATE[0]) {
          const input = JSON.parse(request.stdin ?? "{}") as ForgeSignalInput;
          const stdout = JSON.stringify(
            outputFor === undefined
              ? { reading: { kind: "insufficient", reason: "fixture detector" }, diagnostics: [] }
              : outputFor(input),
          );
          return { exitCode: 0, stdout, stderr: "", killed: null };
        }
        return { exitCode: 1, stdout: "", stderr: "unknown entrypoint", killed: null };
      }),
  };
  return { runner, requests };
};

const layers = (runner: ForgeContainerRunnerShape, stateRoot: string) =>
  ForgeCapabilityBuilderLive.pipe(
    Layer.provide(
      ForgeCapabilitySandboxLive.pipe(
        Layer.provide(
          Layer.succeed(ForgeSandboxConfig, {
            imageRef: IMAGE,
            buildBudgetMs: 30_000,
            evaluationBudgetMs: 2_000,
          }),
        ),
        Layer.provide(Layer.succeed(ForgeContainerRunner, runner)),
      ),
    ),
    Layer.provide(
      ForgeCapabilityStoreLive.pipe(
        Layer.provide(Layer.succeed(ForgeCapabilityStoreConfig, { stateRoot })),
      ),
    ),
  );

const storeAt = (stateRoot: string): Promise<ForgeCapabilityStoreShape> =>
  Effect.runPromise(
    Effect.provide(
      ForgeCapabilityStoreLive.pipe(
        Layer.provide(Layer.succeed(ForgeCapabilityStoreConfig, { stateRoot })),
      ),
    )(ForgeCapabilityStore),
  );

// The layer supplies every requirement; the double cast only silences the
// provide-chain's residual type the runtime provably satisfies.
const builderWith = (
  runner: ForgeContainerRunnerShape,
  stateRoot: string,
): Promise<ForgeCapabilityBuilderShape> =>
  Effect.runPromise(
    Effect.provide(layers(runner, stateRoot))(ForgeCapabilityBuilder) as unknown as Effect.Effect<
      ForgeCapabilityBuilderShape,
      ForgeBuilderError
    >,
  );

/** The failure shape every builder refusal carries, as plain data. */
interface BuilderFailureShape {
  readonly kind: string;
  readonly reason: string;
}

const expectBuilderFailure = async (
  effect: Effect.Effect<unknown, ForgeBuilderError>,
): Promise<BuilderFailureShape> => {
  const exit = await Effect.runPromise(Effect.exit(effect));
  assert.isTrue(exit._tag === "Failure", "expected the build to fail");
  if (exit._tag !== "Failure") throw new Error("unreachable");
  const squashed = Cause.squash(exit.cause);
  assert.instanceOf(squashed, ForgeBuilderError);
  const failure = (squashed as ForgeBuilderError).failure;
  return failure;
};

// ---------------------------------------------------------------------------
// Static validation
// ---------------------------------------------------------------------------

describe("static artifact validation", () => {
  it("declares the imports a generated file references", () => {
    assert.deepEqual(declaredImports('import { a } from "./sdk"; export * from "./signal";'), [
      "./sdk",
      "./signal",
    ]);
    assert.deepEqual(declaredImports('const x = require("node:fs");'), ["node:fs"]);
    assert.deepEqual(declaredImports('await import("child_process");'), ["child_process"]);
  });

  it("accepts the good four-artifact bundle at the right identity", () => {
    const result = validateAuthoredArtifacts({
      contents: goodArtifacts(1),
      expectedCapabilityId: CAPABILITY,
      expectedVersion: 1,
    });
    assert.equal(result.status, "ok");
  });

  it("refuses wrong version, foreign manifests, hostile imports, and oversized bundles", () => {
    const wrongVersion = validateAuthoredArtifacts({
      contents: goodArtifacts(2),
      expectedCapabilityId: CAPABILITY,
      expectedVersion: 1,
    });
    assert.equal(wrongVersion.status, "refused");

    const foreignSdk = validateAuthoredArtifacts({
      contents: {
        ...goodArtifacts(1),
        "signal.ts": 'import { read } from "node:fs"; export const readSignal = read;',
      },
      expectedCapabilityId: CAPABILITY,
      expectedVersion: 1,
    });
    assert.equal(foreignSdk.status, "refused");
    if (foreignSdk.status === "refused") assert.include(foreignSdk.reason, "node:fs");

    const childProcess = validateAuthoredArtifacts({
      contents: {
        ...goodArtifacts(1),
        "signal.test.ts": 'import { exec } from "child_process"; export const x = exec;',
      },
      expectedCapabilityId: CAPABILITY,
      expectedVersion: 1,
    });
    assert.equal(childProcess.status, "refused");

    const oversized = validateAuthoredArtifacts({
      contents: {
        ...goodArtifacts(1),
        "signal.ts": "// " + "x".repeat(256 * 1024),
      },
      expectedCapabilityId: CAPABILITY,
      expectedVersion: 1,
    });
    assert.equal(oversized.status, "refused");
    if (oversized.status === "refused") assert.include(oversized.reason, "cap");

    const missing = validateAuthoredArtifacts({
      contents: { "signal.ts": "x", "manifest.json": manifestJson(1) },
      expectedCapabilityId: CAPABILITY,
      expectedVersion: 1,
    });
    assert.equal(missing.status, "refused");

    const extra = validateAuthoredArtifacts({
      contents: { ...goodArtifacts(1), "evil.sh": "rm -rf /" },
      expectedCapabilityId: CAPABILITY,
      expectedVersion: 1,
    });
    assert.equal(extra.status, "refused");
  });

  it("refuses a query.graphql that is not structurally the pinned query", () => {
    const mutation = validateAuthoredArtifacts({
      contents: {
        ...goodArtifacts(1),
        "query.graphql": "mutation M($pool: String!) { swaps { id } }",
      },
      expectedCapabilityId: CAPABILITY,
      expectedVersion: 1,
    });
    assert.equal(mutation.status, "refused");
    if (mutation.status === "refused") assert.include(mutation.reason, "query.graphql");

    const missingField = validateAuthoredArtifacts({
      contents: { ...goodArtifacts(1), "query.graphql": CAPABILITY_QUERY.replace(" tick", "") },
      expectedCapabilityId: CAPABILITY,
      expectedVersion: 1,
    });
    assert.equal(missingField.status, "refused");
    if (missingField.status === "refused") assert.include(missingField.reason, '"tick"');

    const garbage = validateAuthoredArtifacts({
      contents: { ...goodArtifacts(1), "query.graphql": "SELECT * FROM swaps" },
      expectedCapabilityId: CAPABILITY,
      expectedVersion: 1,
    });
    assert.equal(garbage.status, "refused");

    const empty = validateAuthoredArtifacts({
      contents: { ...goodArtifacts(1), "query.graphql": "" },
      expectedCapabilityId: CAPABILITY,
      expectedVersion: 1,
    });
    assert.equal(empty.status, "refused");
    if (empty.status === "refused") assert.include(empty.reason, "empty");
  });

  it("reads a real workspace and refuses symlinks, extras, and traversal-shaped names", async () => {
    const clean = await writeWorkspace(goodArtifacts(1));
    try {
      const contents = await readAuthoringWorkspace(clean);
      assert.deepEqual(Object.keys(contents).sort(), [
        "manifest.json",
        "query.graphql",
        "signal.test.ts",
        "signal.ts",
      ]);
    } finally {
      await NodeFs.rm(clean, { recursive: true, force: true });
    }

    const withSymlink = await writeWorkspace(goodArtifacts(1));
    try {
      // Replace a real artifact with a symlink to an outside file.
      await NodeFs.unlink(NodePath.join(withSymlink, "signal.ts"));
      await NodeFs.symlink("/etc/hosts", NodePath.join(withSymlink, "signal.ts"));
      await readAuthoringWorkspace(withSymlink).then(
        () => assert.fail("a symlinked artifact must refuse"),
        (error) => assert.match(String(error), /symlink/),
      );
    } finally {
      await NodeFs.rm(withSymlink, { recursive: true, force: true });
    }

    const withExtra = await writeWorkspace(goodArtifacts(1));
    try {
      await NodeFs.writeFile(NodePath.join(withExtra, "notes.txt"), "hi", "utf8");
      await readAuthoringWorkspace(withExtra).then(
        () => assert.fail("an extra file must refuse"),
        (error) => assert.match(String(error), /unexpected file/),
      );
    } finally {
      await NodeFs.rm(withExtra, { recursive: true, force: true });
    }
  });

  it("validates diagnostics against the input window", () => {
    const input = inputWindow();
    const ok = validateDiagnosticsAgainstInput(
      {
        reading: { kind: "insufficient", reason: "x" },
        diagnostics: [{ poolId: "pool-a", tradeIds: ["tx1:1"] }],
      },
      input,
    );
    assert.isNull(ok);
    const foreignTrade = validateDiagnosticsAgainstInput(
      {
        reading: { kind: "insufficient", reason: "x" },
        diagnostics: [{ poolId: "pool-a", tradeIds: ["tx9:9"] }],
      },
      input,
    );
    assert.isNotNull(foreignTrade);
    assert.include(foreignTrade, "tx9:9");
    const foreignPool = validateDiagnosticsAgainstInput(
      {
        reading: { kind: "insufficient", reason: "x" },
        diagnostics: [{ poolId: "pool-z", tradeIds: [] }],
      },
      input,
    );
    assert.isNotNull(foreignPool);
  });
});

// ---------------------------------------------------------------------------
// The prepare → check pipeline
// ---------------------------------------------------------------------------

describe("prepare", () => {
  it("walks requested → inspecting → authoring and hands back a semantics-free brief", async () => {
    const root = NodePath.join(
      await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "forge-builder-")),
    );
    const staging = await writeWorkspace(goodArtifacts(1));
    try {
      const { runner } = makeHappyRunner();
      const builder = await builderWith(runner, root);
      const { build, brief } = await Effect.runPromise(
        builder.prepare({
          environmentId: ENV,
          threadId: "th_1",
          capabilityId: CAPABILITY,
          requestedSemantics: "detect coordinated wash trading across the pools",
          stagingDir: staging,
        }),
      );
      assert.equal(build.stage, "authoring");
      assert.deepEqual(
        build.stages.map((stage) => stage.stage),
        ["requested", "inspecting", "authoring"],
      );
      assert.equal(brief.schemaVersion, FORGE_SDK_SCHEMA_VERSION);
      assert.include(brief.sdkSource, "schema version");
      // The brief carries types and schema text — never a detector.
      assert.notInclude(brief.sdkSource, "coordinated && ");
      assert.include(brief.dataSchema, "observationIds");
      assert.equal(
        brief.artifactContract,
        "query.graphql, signal.ts, signal.test.ts, manifest.json",
      );
    } finally {
      await NodeFs.rm(root, { recursive: true, force: true });
      await NodeFs.rm(staging, { recursive: true, force: true });
    }
  });
});

describe("check", () => {
  const setup = async () => {
    const root = NodePath.join(
      await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "forge-builder-")),
    );
    const staging = await writeWorkspace(goodArtifacts(1));
    const { runner, requests } = makeHappyRunner();
    const builder = await builderWith(runner, root);
    const prepared = await Effect.runPromise(
      builder.prepare({
        environmentId: ENV,
        capabilityId: CAPABILITY,
        requestedSemantics: "detect coordinated wash trading",
        stagingDir: staging,
      }),
    );
    return { root, staging, runner, requests, builder, buildId: prepared.build.buildId };
  };

  it("runs typecheck, generated tests, acceptance and determinism, then stages READY with host hashes", async () => {
    const ctx = await setup();
    try {
      const result = await Effect.runPromise(
        ctx.builder.check({
          buildId: ctx.buildId,
          environmentId: ENV,
          stagingDir: ctx.staging,
          acceptanceCases: [acceptanceCase()],
        }),
      );
      assert.equal(result.build.stage, "ready");
      assert.isDefined(result.staged);
      assert.equal(result.staged?.version.version, 1);
      assert.equal(result.staged?.version.bundleSha256, forgeBundleSha256(goodArtifacts(1)));

      // The receipt carries the host's checks and hashes.
      assert.deepEqual(
        (result.build.checks ?? []).map((check) => check.name),
        ["typecheck", "generated-tests", "acceptance", "determinism"],
      );
      assert.equal(result.build.acceptance?.passed, 1);
      assert.equal(result.build.bundleSha256, forgeBundleSha256(goodArtifacts(1)));

      // What actually ran in containment: typecheck, tests, acceptance,
      // determinism rerun — every run mounted the sdk beside the artifacts.
      const entrypointHeads = ctx.requests.map((request) => request.entrypoint[0]);
      assert.equal(entrypointHeads.filter((head) => head === FORGE_RUNNER_TYPECHECK[0]).length, 1);
      assert.equal(entrypointHeads.filter((head) => head === FORGE_RUNNER_TEST[0]).length, 1);
      assert.equal(entrypointHeads.filter((head) => head === FORGE_RUNNER_EVALUATE[0]).length, 3);
      for (const request of ctx.requests) {
        const mounted = request.files.map((file) => file.path);
        assert.include(mounted, "sdk.ts");
        assert.include(mounted, "signal.ts");
        assert.equal(request.imageRef, IMAGE);
      }

      // Ready is NOT installed: the store has no active version.
      const store = await storeAt(ctx.root);
      assert.isNull(
        await Effect.runPromise(
          store.activeState({ environmentId: ENV, capabilityId: CAPABILITY }),
        ),
      );
      assert.isEmpty(await Effect.runPromise(store.listCatalog(ENV)));
    } finally {
      await NodeFs.rm(ctx.root, { recursive: true, force: true });
      await NodeFs.rm(ctx.staging, { recursive: true, force: true });
    }
  });

  it("fails the build when the generated tests fail — nothing stages", async () => {
    const ctx = await setup();
    try {
      const failing: ForgeContainerRunnerShape = {
        available: Effect.succeed(true),
        run: (request) =>
          Effect.sync(() => {
            if (request.entrypoint[0] === FORGE_RUNNER_TEST[0]) {
              return { exitCode: 1, stdout: "", stderr: "1 test failed", killed: null };
            }
            if (request.entrypoint[0] === FORGE_RUNNER_TYPECHECK[0]) {
              return { exitCode: 0, stdout: "", stderr: "", killed: null };
            }
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                reading: { kind: "insufficient", reason: "fixture detector" },
                diagnostics: [],
              }),
              stderr: "",
              killed: null,
            };
          }),
      };
      const builder = await builderWith(failing, ctx.root);
      const failure = await expectBuilderFailure(
        builder.check({
          buildId: ctx.buildId,
          environmentId: ENV,
          stagingDir: ctx.staging,
          acceptanceCases: [acceptanceCase()],
        }),
      );
      assert.include(failure.reason, "generated tests failed closed");

      const store = await storeAt(ctx.root);
      const build = await Effect.runPromise(store.getBuild(ctx.buildId));
      assert.equal(build?.stage, "failed");
      assert.isEmpty(await Effect.runPromise(store.listCatalog(ENV)));
    } finally {
      await NodeFs.rm(ctx.root, { recursive: true, force: true });
      await NodeFs.rm(ctx.staging, { recursive: true, force: true });
    }
  });

  it("fails the build when an acceptance expectation disagrees — a pass string grants nothing", async () => {
    const ctx = await setup();
    try {
      // The container always answers "ready coordinated" — but the acceptance
      // case expects insufficient. The HOST compares; the container's own
      // view of itself is irrelevant.
      const liar = makeHappyRunner(() => ({
        reading: {
          kind: "ready",
          regime: "coordinated",
          agreement: 1,
          eligiblePoolIds: ["pool-a"],
        },
        diagnostics: [],
      }));
      const builder = await builderWith(liar.runner, ctx.root);
      const failure = await expectBuilderFailure(
        builder.check({
          buildId: ctx.buildId,
          environmentId: ENV,
          stagingDir: ctx.staging,
          acceptanceCases: [acceptanceCase()],
        }),
      );
      assert.include(failure.reason, "acceptance failed");
    } finally {
      await NodeFs.rm(ctx.root, { recursive: true, force: true });
      await NodeFs.rm(ctx.staging, { recursive: true, force: true });
    }
  });

  it("fails the build when the capability is not deterministic", async () => {
    const ctx = await setup();
    try {
      let flip = false;
      const flaky = makeHappyRunner(() => {
        flip = !flip;
        return {
          reading: flip
            ? { kind: "insufficient", reason: "fixture detector" }
            : { kind: "insufficient", reason: "fixture detector (different)" },
          diagnostics: [],
        };
      });
      const builder = await builderWith(flaky.runner, ctx.root);
      const failure = await expectBuilderFailure(
        builder.check({
          buildId: ctx.buildId,
          environmentId: ENV,
          stagingDir: ctx.staging,
          acceptanceCases: [acceptanceCase()],
        }),
      );
      assert.include(failure.reason, "deterministic");
    } finally {
      await NodeFs.rm(ctx.root, { recursive: true, force: true });
      await NodeFs.rm(ctx.staging, { recursive: true, force: true });
    }
  });

  it("refuses a cancelled build outright", async () => {
    const ctx = await setup();
    try {
      const store = await storeAt(ctx.root);
      await Effect.runPromise(
        store.appendBuildStage({
          buildId: ctx.buildId,
          stage: "cancelled",
          detail: "user cancelled",
        }),
      );
      const failure = await expectBuilderFailure(
        ctx.builder.check({
          buildId: ctx.buildId,
          environmentId: ENV,
          stagingDir: ctx.staging,
          acceptanceCases: [acceptanceCase()],
        }),
      );
      assert.include(failure.reason, "cancelled");
    } finally {
      await NodeFs.rm(ctx.root, { recursive: true, force: true });
      await NodeFs.rm(ctx.staging, { recursive: true, force: true });
    }
  });

  it("fails closed when the sandbox is unavailable (Docker down)", async () => {
    const ctx = await setup();
    try {
      const down: ForgeContainerRunnerShape = {
        available: Effect.succeed(false),
        run: () =>
          Effect.fail(
            new ForgeSandboxError({ kind: "sandbox_unavailable", reason: "docker is down" }),
          ),
      };
      const builder = await builderWith(down, ctx.root);
      const failure = await expectBuilderFailure(
        builder.check({
          buildId: ctx.buildId,
          environmentId: ENV,
          stagingDir: ctx.staging,
          acceptanceCases: [acceptanceCase()],
        }),
      );
      assert.include(failure.reason, "typecheck failed closed");
    } finally {
      await NodeFs.rm(ctx.root, { recursive: true, force: true });
      await NodeFs.rm(ctx.staging, { recursive: true, force: true });
    }
  });

  it("versions a revision above the active one and keeps the identity chain", async () => {
    const root = NodePath.join(
      await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "forge-builder-")),
    );
    try {
      const { runner } = makeHappyRunner();
      const builder = await builderWith(runner, root);
      const store = await storeAt(root);

      // v1: build, check, install (installation is the store's CAS step).
      const stagingV1 = await writeWorkspace(goodArtifacts(1));
      const first = await Effect.runPromise(
        builder.prepare({
          environmentId: ENV,
          capabilityId: CAPABILITY,
          requestedSemantics: "v1",
          stagingDir: stagingV1,
        }),
      );
      const checkedV1 = await Effect.runPromise(
        builder.check({
          buildId: first.build.buildId,
          environmentId: ENV,
          stagingDir: stagingV1,
          acceptanceCases: [acceptanceCase()],
        }),
      );
      assert.equal(checkedV1.staged?.version.version, 1);
      const installed = await Effect.runPromise(
        store.install({
          environmentId: ENV,
          capabilityId: CAPABILITY,
          version: 1,
          bundleSha256: checkedV1.build.bundleSha256 ?? "",
          expectedActiveVersion: null,
        }),
      );
      assert.equal(installed.status, "installed");

      // v2: the next build must be version 2, not an overwrite of v1.
      const stagingV2 = await writeWorkspace(goodArtifacts(2));
      const second = await Effect.runPromise(
        builder.prepare({
          environmentId: ENV,
          capabilityId: CAPABILITY,
          requestedSemantics: "v2 ignores tiny trades",
          stagingDir: stagingV2,
        }),
      );
      const checkedV2 = await Effect.runPromise(
        builder.check({
          buildId: second.build.buildId,
          environmentId: ENV,
          stagingDir: stagingV2,
          acceptanceCases: [acceptanceCase()],
        }),
      );
      assert.equal(checkedV2.staged?.version.version, 2);
      assert.notEqual(
        checkedV2.staged?.version.bundleSha256,
        checkedV1.staged?.version.bundleSha256,
      );
      // v1 bytes remain exactly what they were.
      assert.equal(
        await Effect.runPromise(
          store.readArtifact({
            environmentId: ENV,
            capabilityId: CAPABILITY,
            version: 1,
            path: "signal.ts",
          }),
        ),
        goodArtifacts(1)["signal.ts"],
      );
      await NodeFs.rm(stagingV1, { recursive: true, force: true });
      await NodeFs.rm(stagingV2, { recursive: true, force: true });
    } finally {
      await NodeFs.rm(root, { recursive: true, force: true });
    }
  });
});

it.effect("bounds the complete check pipeline and records a failed build", () =>
  Effect.gen(function* () {
    const root = yield* Effect.promise(() =>
      NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "forge-builder-budget-")),
    );
    const staging = yield* Effect.promise(() => writeWorkspace(goodArtifacts(1)));
    const started = yield* Deferred.make<void>();
    const runner: ForgeContainerRunnerShape = {
      available: Effect.succeed(true),
      run: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
    };
    const builder = yield* Effect.promise(() => builderWith(runner, root));
    const prepared = yield* builder.prepare({
      environmentId: ENV,
      capabilityId: CAPABILITY,
      requestedSemantics: "detect coordinated moves",
      stagingDir: staging,
    });
    const check = yield* builder
      .check({
        buildId: prepared.build.buildId,
        environmentId: ENV,
        stagingDir: staging,
        acceptanceCases: [],
      })
      .pipe(Effect.exit, Effect.forkChild);
    yield* Deferred.await(started);
    yield* TestClock.adjust("30 seconds");
    const outcome = yield* Fiber.join(check);
    assert.equal(outcome._tag, "Failure");
    const store = yield* Effect.promise(() => storeAt(root));
    assert.equal((yield* store.getBuild(prepared.build.buildId))?.stage, "failed");
    yield* Effect.promise(() =>
      Promise.all([
        NodeFs.rm(root, { recursive: true, force: true }),
        NodeFs.rm(staging, { recursive: true, force: true }),
      ]),
    );
  }),
);

// ---------------------------------------------------------------------------
// Detector-program (v2)
// ---------------------------------------------------------------------------

const DETECTOR_ENV = "env_builder";
const DETECTOR_CAPABILITY = "flag-detector";

/** The authored detector: matched when a boolean fact is true, a monotone
 *  counter carried in state, unknown while any source is incomplete. */
const v2DetectorSource = [
  'import type { Detect, DetectorProgramInput, DetectorProgramOutput } from "./sdk";',
  "export const detect: Detect = (input: DetectorProgramInput): DetectorProgramOutput => {",
  "  const incomplete = input.sources",
  "    .filter((source) => !source.complete)",
  "    .map((source) => source.sourceId);",
  "  const prior = (input.priorState ?? {}) as { count?: number };",
  "  const nextState = { count: (prior.count ?? 0) + 1 };",
  "  if (incomplete.length > 0)",
  '    return { result: { status: "unknown", missingSourceIds: incomplete, explanation: "incomplete source" }, nextState };',
  "  const matched = input.facts.some(",
  '    (fact) => fact.value.kind === "boolean" && fact.value.value,',
  "  );",
  "  if (matched)",
  "    return {",
  '      result: { status: "matched", occurrenceKey: "flag-occurrence",',
  "        evidenceIds: input.facts.flatMap((fact) => fact.evidence.map((ref) => ref.id)),",
  "        facts: input.facts, validUntilMs: input.asOfMs + 60_000 },",
  "      nextState,",
  "    };",
  '  return { result: { status: "not-matched", evidenceIds: [], explanation: "flag not set" }, nextState };',
  "};",
].join("\n");

const v2DetectorTest = [
  'import { describe, expect, test } from "./sdk";',
  'import { detect } from "./detector";',
  'describe("detector", () => { test("detect is defined", () => { expect(detect).toBeDefined(); }); });',
].join("\n");

const v2ManifestJson = (version: number, capabilityId = DETECTOR_CAPABILITY): string =>
  JSON.stringify({
    manifestVersion: 2,
    capabilityId,
    version,
    semantics: "boolean-flag detector with a monotone counter",
    requiredSourceIds: ["src_graph_1"],
    outputFactKeys: ["flag"],
    artifacts: [
      { role: "sdk", path: "sdk.ts", sha256: forgeSha256Hex(FORGE_SDK_SOURCE_V2) },
      { role: "detector", path: "detector.ts", sha256: forgeSha256Hex(v2DetectorSource) },
      { role: "acceptance", path: "detector.test.ts", sha256: forgeSha256Hex(v2DetectorTest) },
    ],
    createdAtMs: 1_700_000_000_000,
  });

const goodDetectorArtifacts = (version = 1): Record<string, string> => ({
  "detector.ts": v2DetectorSource,
  "detector.test.ts": v2DetectorTest,
  "manifest.json": v2ManifestJson(version),
});

const v2EvidenceRef = {
  id: "ev_1",
  environmentId: DETECTOR_ENV,
  sourceId: "src_graph_1",
  mode: "live",
  contentSha256: "a".repeat(64),
  eventAtMs: 1_700_000_000_000,
  availableAtMs: 1_700_000_001_000,
  availabilityBasis: "recorded",
  timePrecision: "second",
  capturedAtMs: 1_700_000_002_000,
  expiresAtMs: 1_700_000_600_000,
  sourceRevision: "rev-1",
} as const;

const v2FlagFact = {
  id: "fact_1",
  key: "flag",
  entityId: "pool-a",
  value: { kind: "boolean", value: true },
  evidence: [v2EvidenceRef],
} as const;

const v2Source = (complete: boolean) => ({
  sourceId: "src_graph_1",
  evidenceId: "ev_1",
  mode: "live" as const,
  contentSha256: "a".repeat(64),
  complete,
  eventAtMs: 1_700_000_000_000,
  availableAtMs: 1_700_000_001_000,
  availabilityBasis: "recorded" as const,
  expiresAtMs: 1_700_000_600_000,
  sourceRevision: "rev-1",
});

const v2CaseInput = (
  facts: ReadonlyArray<typeof v2FlagFact>,
  sources: ReadonlyArray<ReturnType<typeof v2Source>>,
  priorState?: unknown,
) => ({
  programSchemaVersion: 2 as const,
  asOfMs: 1_700_000_060_000,
  inputDigest: "b".repeat(64),
  facts,
  sources,
  ...(priorState === undefined ? {} : { priorState }),
});

const matchedCase: ForgeAcceptanceCaseV2 = {
  name: "matched-when-flag-true",
  input: v2CaseInput([v2FlagFact], [v2Source(true)], { count: 4 }),
  expected: {
    result: {
      status: "matched",
      occurrenceKey: "flag-occurrence",
      evidenceIds: ["ev_1"],
      facts: [v2FlagFact],
      validUntilMs: 1_700_000_120_000,
    },
    nextState: { count: 5 },
  },
};

const unknownOnIncompleteCase: ForgeAcceptanceCaseV2 = {
  name: "unknown-on-incomplete-source",
  input: v2CaseInput([], [v2Source(false)]),
  expected: {
    result: {
      status: "unknown",
      missingSourceIds: ["src_graph_1"],
      explanation: "incomplete source",
    },
    nextState: { count: 1 },
  },
};

/** The JS mirror of `v2DetectorSource`: what the real container would run. */
const mirrorDetect = (input: {
  readonly facts: ReadonlyArray<{
    readonly value: { readonly kind: string; readonly value: unknown };
    readonly evidence: ReadonlyArray<{ readonly id: string }>;
  }>;
  readonly sources: ReadonlyArray<{ readonly complete: boolean; readonly sourceId: string }>;
  readonly priorState?: unknown;
  readonly asOfMs: number;
}): { readonly result: unknown; readonly nextState: unknown } => {
  const incomplete = input.sources.filter((source) => !source.complete).map((s) => s.sourceId);
  const prior = (input.priorState ?? {}) as { count?: number };
  const nextState = { count: (prior.count ?? 0) + 1 };
  if (incomplete.length > 0) {
    return {
      result: { status: "unknown", missingSourceIds: incomplete, explanation: "incomplete source" },
      nextState,
    };
  }
  const matched = input.facts.some((fact) => fact.value.kind === "boolean" && fact.value.value);
  if (matched) {
    return {
      result: {
        status: "matched",
        occurrenceKey: "flag-occurrence",
        evidenceIds: input.facts.flatMap((fact) => fact.evidence.map((ref) => ref.id)),
        facts: input.facts,
        validUntilMs: input.asOfMs + 60_000,
      },
      nextState,
    };
  }
  return {
    result: { status: "not-matched", evidenceIds: [], explanation: "flag not set" },
    nextState,
  };
};

/** The scripted v2 container: typecheck/tests pass; evaluate-v2 mirrors the
 *  fixture detector for the sealed input it was fed. */
const makeHappyDetectorRunner = () => {
  const requests: Array<ForgeContainerRunRequest> = [];
  const runner: ForgeContainerRunnerShape = {
    available: Effect.succeed(true),
    run: (request) =>
      Effect.sync(() => {
        requests.push(request);
        const head = request.entrypoint[0];
        if (head === FORGE_RUNNER_TYPECHECK[0] || head === FORGE_RUNNER_TEST[0]) {
          return { exitCode: 0, stdout: "", stderr: "", killed: null };
        }
        if (head === FORGE_RUNNER_EVALUATE_V2[0]) {
          return {
            exitCode: 0,
            stdout: JSON.stringify(mirrorDetect(JSON.parse(request.stdin ?? "{}"))),
            stderr: "",
            killed: null,
          };
        }
        return { exitCode: 1, stdout: "", stderr: "unknown entrypoint", killed: null };
      }),
  };
  return { runner, requests };
};

const detectorSetup = async () => {
  const root = NodePath.join(
    await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "forge-builder-v2-")),
  );
  const staging = await writeWorkspace(goodDetectorArtifacts(1));
  const { runner, requests } = makeHappyDetectorRunner();
  const builder = await builderWith(runner, root);
  const prepared = await Effect.runPromise(
    builder.prepare({
      environmentId: DETECTOR_ENV,
      capabilityId: DETECTOR_CAPABILITY,
      requestedSemantics: "detect the boolean flag with a counter",
      stagingDir: staging,
      manifestVersion: 2,
    }),
  );
  return { root, staging, runner, requests, builder, buildId: prepared.build.buildId };
};

describe("detector v2 static artifact validation", () => {
  it("accepts the good three-file bundle at the right identity", () => {
    const result = validateAuthoredDetectorArtifacts({
      contents: goodDetectorArtifacts(1),
      expectedCapabilityId: DETECTOR_CAPABILITY,
      expectedVersion: 1,
    });
    assert.equal(result.status, "ok");
  });

  it("refuses wrong identity, a v1-shaped manifest, and a foreign sdk pin", () => {
    const wrongVersion = validateAuthoredDetectorArtifacts({
      contents: goodDetectorArtifacts(2),
      expectedCapabilityId: DETECTOR_CAPABILITY,
      expectedVersion: 1,
    });
    assert.equal(wrongVersion.status, "refused");

    const wrongCapability = validateAuthoredDetectorArtifacts({
      contents: goodDetectorArtifacts(1),
      expectedCapabilityId: "other-detector",
      expectedVersion: 1,
    });
    assert.equal(wrongCapability.status, "refused");

    // A v1 manifest has no manifestVersion: it must not decode as v2.
    const v1Shaped = validateAuthoredDetectorArtifacts({
      contents: { ...goodDetectorArtifacts(1), "manifest.json": manifestJson(1) },
      expectedCapabilityId: DETECTOR_CAPABILITY,
      expectedVersion: 1,
    });
    assert.equal(v1Shaped.status, "refused");

    const wrongSdkPin = validateAuthoredDetectorArtifacts({
      contents: {
        ...goodDetectorArtifacts(1),
        "manifest.json": v2ManifestJson(1).replace(
          forgeSha256Hex(FORGE_SDK_SOURCE_V2),
          "0".repeat(64),
        ),
      },
      expectedCapabilityId: DETECTOR_CAPABILITY,
      expectedVersion: 1,
    });
    assert.equal(wrongSdkPin.status, "refused");
    if (wrongSdkPin.status === "refused") assert.include(wrongSdkPin.reason, "sdk");
  });

  it("refuses a missing test file, a hostile import, and an oversized bundle", () => {
    const missingTest = validateAuthoredDetectorArtifacts({
      contents: {
        "detector.ts": v2DetectorSource,
        "manifest.json": v2ManifestJson(1),
      },
      expectedCapabilityId: DETECTOR_CAPABILITY,
      expectedVersion: 1,
    });
    assert.equal(missingTest.status, "refused");
    if (missingTest.status === "refused")
      assert.include(missingTest.reason, "detector bundle must be exactly");

    const hostile = validateAuthoredDetectorArtifacts({
      contents: {
        ...goodDetectorArtifacts(1),
        "detector.ts": v2DetectorSource.replace(
          'import type { Detect, DetectorProgramInput, DetectorProgramOutput } from "./sdk";',
          'import { read } from "node:fs";\nimport type { Detect } from "./sdk";\nexport const r = read;',
        ),
        "manifest.json": v2ManifestJson(1).replace(
          forgeSha256Hex(v2DetectorSource),
          forgeSha256Hex(
            v2DetectorSource.replace(
              'import type { Detect, DetectorProgramInput, DetectorProgramOutput } from "./sdk";',
              'import { read } from "node:fs";\nimport type { Detect } from "./sdk";\nexport const r = read;',
            ),
          ),
        ),
      },
      expectedCapabilityId: DETECTOR_CAPABILITY,
      expectedVersion: 1,
    });
    assert.equal(hostile.status, "refused");
    if (hostile.status === "refused") assert.include(hostile.reason, "node:fs");

    const oversized = validateAuthoredDetectorArtifacts({
      contents: {
        ...goodDetectorArtifacts(1),
        "detector.ts": "// " + "x".repeat(FORGE_MAX_BUNDLE_BYTES),
      },
      expectedCapabilityId: DETECTOR_CAPABILITY,
      expectedVersion: 1,
    });
    assert.equal(oversized.status, "refused");
    if (oversized.status === "refused") assert.include(oversized.reason, "cap");
  });
});

describe("detector v2 prepare", () => {
  it("hands back the v2 SDK, the sealed-facts data schema, and the v2 artifact contract", async () => {
    const root = NodePath.join(
      await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "forge-builder-v2-")),
    );
    const staging = await writeWorkspace(goodDetectorArtifacts(1));
    try {
      const { runner } = makeHappyDetectorRunner();
      const builder = await builderWith(runner, root);
      const { build, brief } = await Effect.runPromise(
        builder.prepare({
          environmentId: DETECTOR_ENV,
          capabilityId: DETECTOR_CAPABILITY,
          requestedSemantics: "detect the boolean flag",
          stagingDir: staging,
          manifestVersion: 2,
        }),
      );
      assert.equal(build.stage, "authoring");
      assert.equal(brief.schemaVersion, DETECTOR_SDK_SCHEMA_VERSION);
      assert.include(brief.sdkSource, "detector-program SDK");
      assert.include(brief.sdkSource, "DetectionResult");
      assert.notInclude(brief.sdkSource, "SignalOutput");
      // The brief tells the author how to pin the sdk artifact the host mounts.
      assert.include(brief.dataSchema, forgeSha256Hex(FORGE_SDK_SOURCE_V2));
      assert.include(brief.dataSchema, "as-of the host clock");
      assert.include(brief.artifactContract, "detector.test.ts");
    } finally {
      await NodeFs.rm(root, { recursive: true, force: true });
      await NodeFs.rm(staging, { recursive: true, force: true });
    }
  });
});

describe("detector v2 check", () => {
  it("runs typecheck, tests, v2 acceptance with state, determinism, then stages READY", async () => {
    const ctx = await detectorSetup();
    try {
      const result = await Effect.runPromise(
        ctx.builder.check({
          buildId: ctx.buildId,
          environmentId: DETECTOR_ENV,
          stagingDir: ctx.staging,
          acceptanceCases: [],
          acceptanceV2: [matchedCase, unknownOnIncompleteCase],
        }),
      );
      assert.equal(result.build.stage, "ready");
      assert.isDefined(result.staged);

      // The staged bundle: authored files + the exact host SDK bytes.
      const expectedContents = {
        ...goodDetectorArtifacts(1),
        "sdk.ts": FORGE_SDK_SOURCE_V2,
      };
      assert.deepEqual(
        result.staged?.version.bundleSha256,
        forgeDetectorBundleSha256(expectedContents),
      );
      assert.equal(result.staged?.contents["sdk.ts"], FORGE_SDK_SOURCE_V2);

      // Staging route-around: exactly four hash entries (the store's current
      // shape) and a v1-decodable header tagged as detector-program v2.
      assert.deepEqual(
        result.staged?.version.artifacts.map((artifact) => artifact.path),
        ["detector.test.ts", "detector.ts", "manifest.json", "sdk.ts"],
      );
      assert.equal(result.staged?.version.manifest.schemaVersion, FORGE_SDK_SCHEMA_VERSION);
      assert.match(result.staged?.version.manifest.description ?? "", /^\[detector-program v2\] /);

      assert.deepEqual(
        (result.build.checks ?? []).map((check) => check.name),
        ["typecheck", "generated-tests", "acceptance", "determinism"],
      );
      assert.equal(result.build.acceptance?.passed, 2);

      // What ran in containment: shared typecheck/test, evaluate-v2 for each
      // case plus the determinism double-run — and never a v1 evaluate head.
      const heads = ctx.requests.map((request) => request.entrypoint[0]);
      assert.equal(heads.filter((head) => head === FORGE_RUNNER_EVALUATE_V2[0]).length, 4);
      assert.equal(heads.filter((head) => head === FORGE_RUNNER_EVALUATE[0]).length, 0);
      for (const request of ctx.requests) {
        const mounted = request.files.map((file) => file.path);
        assert.include(mounted, "sdk.ts");
        assert.include(mounted, "detector.ts");
        assert.include(mounted, "detector.test.ts");
        assert.include(mounted, "manifest.json");
      }

      // The route-around's whole point: the store can read the staged v2
      // version back through its strict decode.
      const store = await storeAt(ctx.root);
      const readBack = await Effect.runPromise(
        store.readVersion({
          environmentId: DETECTOR_ENV,
          capabilityId: DETECTOR_CAPABILITY,
          version: 1,
        }),
      );
      assert.equal(readBack?.bundleSha256, result.staged?.version.bundleSha256);
      // Ready is NOT installed.
      assert.isNull(
        await Effect.runPromise(
          store.activeState({ environmentId: DETECTOR_ENV, capabilityId: DETECTOR_CAPABILITY }),
        ),
      );
    } finally {
      await NodeFs.rm(ctx.root, { recursive: true, force: true });
      await NodeFs.rm(ctx.staging, { recursive: true, force: true });
    }
  });

  it("fails the build when acceptance disagrees on nextState — a matched result alone grants nothing", async () => {
    const ctx = await detectorSetup();
    try {
      const builder = await builderWith(ctx.runner, ctx.root);
      const failure = await expectBuilderFailure(
        builder.check({
          buildId: ctx.buildId,
          environmentId: DETECTOR_ENV,
          stagingDir: ctx.staging,
          acceptanceCases: [],
          acceptanceV2: [
            { ...matchedCase, expected: { ...matchedCase.expected, nextState: { count: 99 } } },
          ],
        }),
      );
      assert.include(failure.reason, "acceptance failed");
      const store = await storeAt(ctx.root);
      assert.equal((await Effect.runPromise(store.getBuild(ctx.buildId)))?.stage, "failed");
    } finally {
      await NodeFs.rm(ctx.root, { recursive: true, force: true });
      await NodeFs.rm(ctx.staging, { recursive: true, force: true });
    }
  });

  it("refuses to certify a v2 bundle with zero acceptance cases", async () => {
    const ctx = await detectorSetup();
    try {
      const failure = await expectBuilderFailure(
        ctx.builder.check({
          buildId: ctx.buildId,
          environmentId: DETECTOR_ENV,
          stagingDir: ctx.staging,
          acceptanceCases: [],
        }),
      );
      assert.include(failure.reason, "at least one independent host acceptance case is required");
      const store = await storeAt(ctx.root);
      assert.equal((await Effect.runPromise(store.getBuild(ctx.buildId)))?.stage, "failed");
    } finally {
      await NodeFs.rm(ctx.root, { recursive: true, force: true });
      await NodeFs.rm(ctx.staging, { recursive: true, force: true });
    }
  });

  it("fails the build when the detector is not deterministic in its state", async () => {
    const ctx = await detectorSetup();
    try {
      let evaluateRuns = 0;
      let flip = false;
      // The acceptance run answers honestly; only the determinism double-run
      // drifts, so the failure is attributed to determinism, not acceptance.
      const flaky: ForgeContainerRunnerShape = {
        available: Effect.succeed(true),
        run: (request) =>
          Effect.sync(() => {
            if (request.entrypoint[0] === FORGE_RUNNER_EVALUATE_V2[0]) {
              const mirrored = mirrorDetect(JSON.parse(request.stdin ?? "{}"));
              evaluateRuns += 1;
              if (evaluateRuns === 1) {
                return { exitCode: 0, stdout: JSON.stringify(mirrored), stderr: "", killed: null };
              }
              flip = !flip;
              return {
                exitCode: 0,
                stdout: JSON.stringify({
                  ...mirrored,
                  nextState: { ...(mirrored.nextState as { count: number }), drift: flip ? 1 : 2 },
                }),
                stderr: "",
                killed: null,
              };
            }
            return { exitCode: 0, stdout: "", stderr: "", killed: null };
          }),
      };
      const builder = await builderWith(flaky, ctx.root);
      const failure = await expectBuilderFailure(
        builder.check({
          buildId: ctx.buildId,
          environmentId: DETECTOR_ENV,
          stagingDir: ctx.staging,
          acceptanceCases: [],
          acceptanceV2: [matchedCase],
        }),
      );
      assert.include(failure.reason, "deterministic");
    } finally {
      await NodeFs.rm(ctx.root, { recursive: true, force: true });
      await NodeFs.rm(ctx.staging, { recursive: true, force: true });
    }
  });

  it("keeps the v1 pipeline untouched for a v1 manifest (the discriminator)", async () => {
    // A v1 workspace next to v2 files in the same store root: the v1 build
    // must run the v1 path exactly (v1 evaluate head, v1 bundle hash).
    const ctx = await detectorSetup();
    try {
      const stagingV1 = await writeWorkspace(goodArtifacts(1));
      const { runner: v1Runner, requests: v1Requests } = makeHappyRunner();
      const builder = await builderWith(v1Runner, ctx.root);
      const prepared = await Effect.runPromise(
        builder.prepare({
          environmentId: ENV,
          capabilityId: CAPABILITY,
          requestedSemantics: "v1 pool signal beside a v2 build",
          stagingDir: stagingV1,
        }),
      );
      const checked = await Effect.runPromise(
        builder.check({
          buildId: prepared.build.buildId,
          environmentId: ENV,
          stagingDir: stagingV1,
          acceptanceCases: [acceptanceCase()],
        }),
      );
      assert.equal(checked.build.stage, "ready");
      assert.equal(checked.staged?.version.bundleSha256, forgeBundleSha256(goodArtifacts(1)));
      assert.equal(
        v1Requests.filter((request) => request.entrypoint[0] === FORGE_RUNNER_EVALUATE[0]).length,
        3,
      );
      assert.equal(
        v1Requests.filter((request) => request.entrypoint[0] === FORGE_RUNNER_EVALUATE_V2[0])
          .length,
        0,
      );
      await NodeFs.rm(stagingV1, { recursive: true, force: true });
    } finally {
      await NodeFs.rm(ctx.root, { recursive: true, force: true });
      await NodeFs.rm(ctx.staging, { recursive: true, force: true });
    }
  });

  it("fails closed on a v2 workspace whose static validation refuses", async () => {
    const root = NodePath.join(
      await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "forge-builder-v2-")),
    );
    const hostileStaging = await writeWorkspace({
      ...goodDetectorArtifacts(1),
      "detector.test.ts": "",
    });
    try {
      const { runner, requests } = makeHappyDetectorRunner();
      const builder = await builderWith(runner, root);
      const prepared = await Effect.runPromise(
        builder.prepare({
          environmentId: DETECTOR_ENV,
          capabilityId: DETECTOR_CAPABILITY,
          requestedSemantics: "hostile",
          stagingDir: hostileStaging,
          manifestVersion: 2,
        }),
      );
      const failure = await expectBuilderFailure(
        builder.check({
          buildId: prepared.build.buildId,
          environmentId: DETECTOR_ENV,
          stagingDir: hostileStaging,
          acceptanceCases: [],
          acceptanceV2: [matchedCase],
        }),
      );
      assert.include(failure.reason, "detector.test.ts is empty");
      // Nothing ran in containment: static validation refuses first.
      assert.isEmpty(requests);
    } finally {
      await NodeFs.rm(root, { recursive: true, force: true });
      await NodeFs.rm(hostileStaging, { recursive: true, force: true });
    }
  });
});

describe("the v2 SDK string compiles and runs under the runner's tsc contract", () => {
  // Resolves the workspace's own tsc (the same 6.0.x line the image pins)
  // across npm and pnpm layouts; the container itself installs npm-style.
  const resolveTsc = (): string | null => {
    const root = NodePath.resolve(process.cwd(), "../..");
    const direct = NodePath.join(root, "node_modules", "typescript", "bin", "tsc");
    if (NodeFsSync.existsSync(direct)) return direct;
    const pnpm = NodePath.join(root, "node_modules", ".pnpm");
    if (NodeFsSync.existsSync(pnpm)) {
      const entry = NodeFsSync.readdirSync(pnpm).find((name) => /^typescript@/.test(name));
      if (entry !== undefined) {
        const candidate = NodePath.join(pnpm, entry, "node_modules", "typescript", "bin", "tsc");
        if (NodeFsSync.existsSync(candidate)) return candidate;
      }
    }
    return null;
  };

  it("compiles FORGE_SDK_SOURCE_V2 with the fixture detector under --strict, and the sync entry runs", async () => {
    const resolved = resolveTsc();
    if (resolved === null)
      assert.fail("a local typescript compiler must exist to compile the SDK string");
    const tscPath = resolved;
    const workDir = await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "forge-sdk-compile-"));
    const outDir = await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "forge-sdk-out-"));
    try {
      await NodeFs.writeFile(NodePath.join(workDir, "sdk.ts"), FORGE_SDK_SOURCE_V2, "utf8");
      await NodeFs.writeFile(NodePath.join(workDir, "detector.ts"), v2DetectorSource, "utf8");
      await NodeFs.writeFile(NodePath.join(workDir, "detector.test.ts"), v2DetectorTest, "utf8");
      // The runner's exact compile invocation.
      const compiled = spawnSync(
        process.execPath,
        [
          tscPath,
          "--strict",
          "--target",
          "ES2022",
          "--lib",
          "ES2022",
          "--module",
          "commonjs",
          "--moduleResolution",
          "node",
          "--ignoreDeprecations",
          "6.0",
          "--skipLibCheck",
          "--outDir",
          outDir,
          NodePath.join(workDir, "sdk.ts"),
          NodePath.join(workDir, "detector.test.ts"),
          NodePath.join(workDir, "detector.ts"),
        ],
        { encoding: "utf8", maxBuffer: 64 * 1024, cwd: workDir },
      );
      assert.equal(
        compiled.status,
        0,
        `the v2 SDK must compile under the runner's flags: ${compiled.stdout}${compiled.stderr}`,
      );

      // The compiled entry is the SYNC contract the runner calls.
      const detectorJs = NodePath.join(outDir, "detector.js");
      const imported = (await import(pathToFileURL(detectorJs).href)) as unknown as {
        readonly detect?: (input: unknown) => {
          readonly result: unknown;
          readonly nextState: unknown;
        };
        readonly default?: {
          readonly detect: (input: unknown) => {
            readonly result: unknown;
            readonly nextState: unknown;
          };
        };
      };
      const detect = imported.detect ?? imported.default?.detect;
      assert.isDefined(detect, "the compiled detector must export detect");
      if (detect === undefined) throw new Error("unreachable");
      const output = detect(matchedCase.input);
      assert.deepEqual(output.result, matchedCase.expected.result);
      assert.deepEqual(output.nextState, matchedCase.expected.nextState);
    } finally {
      await NodeFs.rm(workDir, { recursive: true, force: true });
      await NodeFs.rm(outDir, { recursive: true, force: true });
    }
  });
});
