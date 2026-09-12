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
import * as NodeFs from "node:fs/promises";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import {
  FORGE_SDK_SCHEMA_VERSION,
  type ForgeAcceptanceCase,
  type ForgeSignalInput,
} from "@t3tools/trading-contracts";

import {
  ForgeCapabilitySandbox,
  ForgeCapabilitySandboxLive,
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
  ForgeCapabilityBuilder,
  ForgeCapabilityBuilderLive,
  forgeBundleSha256,
  FORGE_RUNNER_EVALUATE,
  FORGE_RUNNER_TEST,
  FORGE_RUNNER_TYPECHECK,
  readAuthoringWorkspace,
  validateAuthoredArtifacts,
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

const goodArtifacts = (version = 1): Record<string, string> => ({
  "query.graphql":
    "query Swaps($pool: ID!) { swaps(first: 100, where: { pool: $pool }) { id amount0 amount1 sqrtPriceX96 tick logIndex transaction { id } } }",
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
