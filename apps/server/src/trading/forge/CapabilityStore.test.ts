/**
 * CapabilityStore — immutability, CAS, restart survival, and path separation.
 *
 * Real files under a temp state root (no SQLite, no network). A "restart" is
 * a second store instance over the same root. The signer-separation guard is
 * exercised with real temp directories.
 */
// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off globalConsole:off preferSchemaOverJson:off - real files under temp roots are the fixture; receipts are wall-clock data; JSON is the storage codec under test.

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeFs from "node:fs/promises";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import {
  FORGE_CAPABILITY_ARTIFACT_PATHS,
  FORGE_SDK_SCHEMA_VERSION,
  type ForgeCapabilityVersion,
} from "@t3tools/trading-contracts";

import type { ForgeCapabilityStoreShape } from "./CapabilityStore.ts";
import {
  defaultForgeStateRoot,
  ensureForgeStateOutsideSignerBase,
  ForgeCapabilityStore,
  ForgeCapabilityStoreConfig,
  ForgeCapabilityStoreLive,
  forgeSignerSecretsRoot,
  ForgeStoreError,
  safeJoinStorePath,
} from "./CapabilityStore.ts";
import * as NodeCrypto from "node:crypto";

const ENV = "env_test";

const storeLayer = (stateRoot: string) =>
  ForgeCapabilityStoreLive.pipe(
    Layer.provide(Layer.succeed(ForgeCapabilityStoreConfig, { stateRoot })),
  );

const storeWith = (stateRoot: string): Promise<ForgeCapabilityStoreShape> =>
  Effect.runPromise(Effect.provide(storeLayer(stateRoot))(ForgeCapabilityStore));

const artifactContents = (suffix = ""): Record<string, string> => ({
  "query.graphql": `query { swaps { id ${suffix}} }`,
  "signal.ts": `export const read = 1; ${suffix}`,
  "signal.test.ts": `test("ok", () => {}); ${suffix}`,
  "manifest.json": JSON.stringify({
    capabilityId: "wash-detector",
    version: 1,
    schemaVersion: FORGE_SDK_SCHEMA_VERSION,
    description: "flag coordinated wash trading",
  }),
});

const hashedVersion = (
  contents: Record<string, string>,
  version = 1,
): { version: ForgeCapabilityVersion; contents: Record<string, string>; bundleSha256: string } => {
  const artifacts = FORGE_CAPABILITY_ARTIFACT_PATHS.map((path) => ({
    path,
    sha256: NodeCrypto.createHash("sha256")
      .update(contents[path] ?? "")
      .digest("hex"),
    bytes: Buffer.byteLength(contents[path] ?? "", "utf8"),
  }));
  const bundleSha256 = NodeCrypto.createHash("sha256")
    .update(FORGE_CAPABILITY_ARTIFACT_PATHS.map((path) => contents[path] ?? "").join("\n"))
    .digest("hex");
  return {
    version: {
      capabilityId: "wash-detector",
      version,
      bundleSha256,
      artifacts,
      manifest: {
        capabilityId: "wash-detector",
        version,
        schemaVersion: FORGE_SDK_SCHEMA_VERSION,
        description: "flag coordinated wash trading",
      },
      createdAtMs: 1_000,
    },
    contents,
    bundleSha256,
  };
};

const stageAndInstall = async (
  store: ForgeCapabilityStoreShape,
  version: number,
  expectedActiveVersion: number | null,
) => {
  const prepared = hashedVersion(artifactContents(), version);
  const staged = await Effect.runPromise(
    store.stageVersion(ENV, prepared.version, prepared.contents),
  );
  assert.equal(staged.status, "staged");
  return Effect.runPromise(
    store.install({
      environmentId: ENV,
      capabilityId: "wash-detector",
      version,
      bundleSha256: prepared.bundleSha256,
      expectedActiveVersion,
    }),
  );
};

describe("path separation", () => {
  it("separates the default state root from the signer secrets tree", () => {
    const home = NodeOs.homedir();
    const state = defaultForgeStateRoot(home);
    const secrets = forgeSignerSecretsRoot(home);
    assert.isFalse(
      NodePath.resolve(state) === NodePath.resolve(secrets) ||
        NodePath.resolve(state).startsWith(NodePath.resolve(secrets) + NodePath.sep),
    );
  });

  it("refuses a state root inside the signer secrets tree", () => {
    const home = NodeOs.tmpdir();
    const secrets = NodePath.join(home, "t3-signer-home", "secrets");
    assert.throws(() =>
      ensureForgeStateOutsideSignerBase(NodePath.join(secrets, "forge"), secrets),
    );
    assert.throws(() => ensureForgeStateOutsideSignerBase(secrets, secrets));
    // Beside, not inside: fine.
    ensureForgeStateOutsideSignerBase(NodePath.join(home, "t3-signer-home", "appstate"), secrets);
  });

  it("refuses unsafe store path segments", () => {
    const root = NodePath.join(NodeOs.tmpdir(), "store-root");
    assert.equal(
      safeJoinStorePath(root, ["env_1", "history.json"]),
      NodePath.resolve(root, "env_1", "history.json"),
    );
    assert.throws(() => safeJoinStorePath(root, ["../escape"]));
    assert.throws(() => safeJoinStorePath(root, ["env_1/../../escape"]));
    assert.throws(() => safeJoinStorePath(root, ["/etc"]));
    assert.throws(() => safeJoinStorePath(root, [""]));
  });
});

describe("build receipts", () => {
  it("starts, appends stages, and survives restart", async () => {
    const root = NodePath.join(
      await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "forge-store-")),
    );
    try {
      const store = await storeWith(root);
      const started = await Effect.runPromise(
        store.startBuild({
          environmentId: ENV,
          threadId: "th_1",
          requestedSemantics: "detect coordinated wash trading",
        }),
      );
      assert.equal(started.stage, "requested");
      const advanced = await Effect.runPromise(
        store.appendBuildStage({ buildId: started.buildId, stage: "authoring" }),
      );
      assert.equal(advanced.stage, "authoring");
      assert.equal(advanced.stages.length, 2);

      const reopened = await storeWith(root);
      const read = await Effect.runPromise(reopened.getBuild(started.buildId));
      assert.isNotNull(read);
      assert.equal(read?.stage, "authoring");
      assert.equal(read?.stages.length, 2);
    } finally {
      await NodeFs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("immutable versions", () => {
  it("stages once, is idempotent on identical bytes, and refuses tampering", async () => {
    const root = NodePath.join(
      await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "forge-store-")),
    );
    try {
      const store = await storeWith(root);
      const prepared = hashedVersion(artifactContents());
      const first = await Effect.runPromise(
        store.stageVersion(ENV, prepared.version, prepared.contents),
      );
      assert.equal(first.status, "staged");

      // Same bytes again: idempotent.
      const again = await Effect.runPromise(
        store.stageVersion(ENV, prepared.version, prepared.contents),
      );
      assert.equal(again.status, "staged");

      // Different bytes, same version: tampering.
      const tampered = hashedVersion(artifactContents("-changed"), 1);
      const refused = await Effect.runPromise(
        store.stageVersion(ENV, tampered.version, tampered.contents),
      );
      assert.equal(refused.status, "refused");
      if (refused.status === "refused") assert.equal(refused.reason, "tampered");

      // The stored bytes are still the originals.
      const artifact = await Effect.runPromise(
        store.readArtifact({
          environmentId: ENV,
          capabilityId: "wash-detector",
          version: 1,
          path: "signal.ts",
        }),
      );
      assert.equal(artifact, prepared.contents["signal.ts"]);
    } finally {
      await NodeFs.rm(root, { recursive: true, force: true });
    }
  });

  it("serves artifacts only by flat artifact name", async () => {
    const root = NodePath.join(
      await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "forge-store-")),
    );
    try {
      const store = await storeWith(root);
      const prepared = hashedVersion(artifactContents());
      await Effect.runPromise(store.stageVersion(ENV, prepared.version, prepared.contents));
      for (const path of ["../history.json", "bundles", "/etc/passwd"]) {
        const attempt = await Effect.runPromise(
          store.readArtifact({
            environmentId: ENV,
            capabilityId: "wash-detector",
            version: 1,
            path,
          }),
        );
        assert.isNull(attempt, path);
      }
    } finally {
      await NodeFs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("installation CAS", () => {
  it("installs v1 with expectedActiveVersion null, refuses the wrong hash, and refuses reinstall", async () => {
    const root = NodePath.join(
      await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "forge-store-")),
    );
    try {
      const store = await storeWith(root);
      const prepared = hashedVersion(artifactContents());
      await Effect.runPromise(store.stageVersion(ENV, prepared.version, prepared.contents));

      // Unknown version.
      const unknown = await Effect.runPromise(
        store.install({
          environmentId: ENV,
          capabilityId: "wash-detector",
          version: 9,
          bundleSha256: prepared.bundleSha256,
          expectedActiveVersion: null,
        }),
      );
      assert.equal(unknown.status, "refused");
      if (unknown.status === "refused") assert.equal(unknown.reason, "unknown_version");

      // Hash mismatch: only the exact tested bytes install.
      const mismatched = await Effect.runPromise(
        store.install({
          environmentId: ENV,
          capabilityId: "wash-detector",
          version: 1,
          bundleSha256: "0".repeat(64),
          expectedActiveVersion: null,
        }),
      );
      assert.equal(mismatched.status, "refused");
      if (mismatched.status === "refused") assert.equal(mismatched.reason, "hash_mismatch");

      const installed = await stageAndInstall(store, 1, null);
      assert.equal(installed.status, "installed");

      const again = await Effect.runPromise(
        store.install({
          environmentId: ENV,
          capabilityId: "wash-detector",
          version: 1,
          bundleSha256: prepared.bundleSha256,
          expectedActiveVersion: 1,
        }),
      );
      assert.equal(again.status, "refused");
      if (again.status === "refused") assert.equal(again.reason, "already_installed");
    } finally {
      await NodeFs.rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a stale CAS against a newer active version", async () => {
    const root = NodePath.join(
      await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "forge-store-")),
    );
    try {
      const store = await storeWith(root);
      assert.equal((await stageAndInstall(store, 1, null)).status, "installed");
      // Someone else already moved to v2; a stale v1-expecting candidate cannot overwrite.
      assert.equal((await stageAndInstall(store, 2, 1)).status, "installed");
      const stale = await Effect.runPromise(
        store.install({
          environmentId: ENV,
          capabilityId: "wash-detector",
          version: 3,
          bundleSha256: hashedVersion(artifactContents(), 3).bundleSha256,
          expectedActiveVersion: 1,
        }),
      );
      // v3 was never staged, so this is unknown_version — stage it first for the CAS check.
      assert.equal(stale.status, "refused");
      const prepared = hashedVersion(artifactContents(), 3);
      await Effect.runPromise(store.stageVersion(ENV, prepared.version, prepared.contents));
      const staleCas = await Effect.runPromise(
        store.install({
          environmentId: ENV,
          capabilityId: "wash-detector",
          version: 3,
          bundleSha256: prepared.bundleSha256,
          expectedActiveVersion: 1,
        }),
      );
      assert.equal(staleCas.status, "refused");
      if (staleCas.status === "refused") assert.equal(staleCas.reason, "active_version_mismatch");
      assert.include((staleCas as { detail: string }).detail, "v2");
    } finally {
      await NodeFs.rm(root, { recursive: true, force: true });
    }
  });

  it("catalog, pause/resume/uninstall survive a restart", async () => {
    const root = NodePath.join(
      await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "forge-store-")),
    );
    try {
      const store = await storeWith(root);
      await stageAndInstall(store, 1, null);
      assert.isTrue(
        await Effect.runPromise(store.pause({ environmentId: ENV, capabilityId: "wash-detector" })),
      );
      let catalog = await Effect.runPromise(store.listCatalog(ENV));
      assert.equal(catalog.length, 1);
      assert.equal(catalog[0]?.status, "paused");

      // Restart: same view from disk.
      const reopened = await storeWith(root);
      catalog = await Effect.runPromise(reopened.listCatalog(ENV));
      assert.equal(catalog.length, 1);
      assert.equal(catalog[0]?.status, "paused");
      assert.equal(catalog[0]?.version, 1);
      assert.equal(catalog[0]?.capabilityId, "wash-detector");

      assert.isTrue(
        await Effect.runPromise(
          reopened.resume({ environmentId: ENV, capabilityId: "wash-detector" }),
        ),
      );
      assert.equal((await Effect.runPromise(reopened.listCatalog(ENV)))[0]?.status, "installed");

      // Uninstall with the provider stopped: it is a store operation.
      assert.isTrue(
        await Effect.runPromise(
          reopened.uninstall({ environmentId: ENV, capabilityId: "wash-detector" }),
        ),
      );
      assert.isEmpty(await Effect.runPromise(reopened.listCatalog(ENV)));
      assert.isNull(
        await Effect.runPromise(
          reopened.activeState({ environmentId: ENV, capabilityId: "wash-detector" }),
        ),
      );
      // Reinstalling after uninstall works (bundles are immutable, not deleted).
      assert.equal((await stageAndInstall(reopened, 1, null)).status, "installed");
    } finally {
      await NodeFs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("evaluations, pools and policies", () => {
  it("records evaluations and reads latest/history back, deduped", async () => {
    const root = NodePath.join(
      await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "forge-store-")),
    );
    try {
      const store = await storeWith(root);
      const evaluation = (id: string, completed: number) => ({
        evaluationId: id,
        environmentId: ENV,
        capabilityId: "wash-detector",
        capabilityVersion: 1,
        bundleSha256: "ab".repeat(32),
        window: { startedAt: 0, endedAt: 60_000 },
        historical: false,
        evidenceIds: ["forge_ev_1"],
        status: "complete" as const,
        reading: {
          kind: "ready" as const,
          regime: "quiet" as const,
          agreement: 0,
          eligiblePoolIds: [],
        },
        createdAtMs: completed - 100,
        completedAtMs: completed,
      });
      await Effect.runPromise(store.recordEvaluation(evaluation("fe_1", 1_000)));
      await Effect.runPromise(store.recordEvaluation(evaluation("fe_1", 1_000)));
      await Effect.runPromise(store.recordEvaluation(evaluation("fe_2", 2_000)));
      const history = await Effect.runPromise(
        store.listEvaluations({ environmentId: ENV, capabilityId: "wash-detector" }),
      );
      assert.equal(history.length, 2);
      const latest = await Effect.runPromise(
        store.latestEvaluation({ environmentId: ENV, capabilityId: "wash-detector" }),
      );
      assert.equal(latest?.evaluationId, "fe_2");
    } finally {
      await NodeFs.rm(root, { recursive: true, force: true });
    }
  });

  it("an agent cannot self-approve a pool: approval only exists as a direct user path", async () => {
    const root = NodePath.join(
      await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "forge-store-")),
    );
    try {
      const store = await storeWith(root);
      const proposal = await Effect.runPromise(
        store.proposePool({
          environmentId: ENV,
          poolId: "0xabc",
          threadId: "th_agent",
          reason: "the agent asked",
        }),
      );
      assert.equal(proposal.status, "proposed");

      // No approved pool yet: a policy binding refuses.
      await Effect.runPromise(
        store.bindPolicy({
          environmentId: ENV,
          capabilityId: "wash-detector",
          capabilityVersion: 1,
          bundleSha256: "ab".repeat(32),
          poolId: "0xabc",
          detectionFeeHundredthsBps: 500,
        }),
      ).then(
        () => assert.fail("bindPolicy must refuse without an approved pool"),
        (error) => assert.instanceOf(error, ForgeStoreError),
      );

      // The direct user-service path approves.
      const approved = await Effect.runPromise(
        store.approvePool({ environmentId: ENV, proposalId: proposal.proposalId }),
      );
      assert.equal(approved?.status, "approved");

      const binding = await Effect.runPromise(
        store.bindPolicy({
          environmentId: ENV,
          capabilityId: "wash-detector",
          capabilityVersion: 1,
          bundleSha256: "ab".repeat(32),
          poolId: "0xabc",
          detectionFeeHundredthsBps: 500,
        }),
      );
      assert.equal(binding.status, "draft");
      const revoked = await Effect.runPromise(
        store.revokePolicy({ environmentId: ENV, policyId: binding.policyId }),
      );
      assert.equal(revoked?.status, "revoked");
    } finally {
      await NodeFs.rm(root, { recursive: true, force: true });
    }
  });
});

it("serializes concurrent history writes without dropping builds", async () => {
  const root = await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "forge-store-race-"));
  try {
    const store = await storeWith(root);
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        Effect.runPromise(
          store.startBuild({
            environmentId: ENV,
            capabilityId: `cap-${index}`,
            requestedSemantics: "check",
          }),
        ),
      ),
    );
    assert.equal((await Effect.runPromise(store.listBuilds({ environmentId: ENV }))).length, 8);
  } finally {
    await NodeFs.rm(root, { recursive: true, force: true });
  }
});

it("never revives a cancelled build", async () => {
  const root = await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "forge-store-cancel-"));
  try {
    const store = await storeWith(root);
    const build = await Effect.runPromise(
      store.startBuild({ environmentId: ENV, requestedSemantics: "check" }),
    );
    await Effect.runPromise(store.appendBuildStage({ buildId: build.buildId, stage: "cancelled" }));
    const result = await Effect.runPromise(
      store.appendBuildStage({ buildId: build.buildId, stage: "ready" }).pipe(Effect.exit),
    );
    assert.equal(result._tag, "Failure");
    assert.equal((await Effect.runPromise(store.getBuild(build.buildId)))?.stage, "cancelled");
  } finally {
    await NodeFs.rm(root, { recursive: true, force: true });
  }
});

it("rejects changed stored artifact bytes at install", async () => {
  const root = await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "forge-store-tamper-"));
  try {
    const store = await storeWith(root);
    const prepared = hashedVersion(artifactContents());
    await Effect.runPromise(store.stageVersion(ENV, prepared.version, prepared.contents));
    const path = NodePath.join(root, ENV, "bundles", "wash-detector", "v1.json");
    const saved = JSON.parse(await NodeFs.readFile(path, "utf8"));
    saved.contents["signal.ts"] = "changed bytes";
    await NodeFs.writeFile(path, JSON.stringify(saved));
    const result = await Effect.runPromise(
      store.install({
        environmentId: ENV,
        capabilityId: "wash-detector",
        version: 1,
        bundleSha256: prepared.bundleSha256,
        expectedActiveVersion: null,
      }),
    );
    assert.equal(result.status, "refused");
    if (result.status === "refused") assert.equal(result.reason, "hash_mismatch");
  } finally {
    await NodeFs.rm(root, { recursive: true, force: true });
  }
});

it("allocates beyond retained versions and preserves corrupt sealed bytes", async () => {
  const root = await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "forge-store-version-"));
  try {
    const store = await storeWith(root);
    const prepared = hashedVersion(artifactContents());
    const scope = { environmentId: ENV, capabilityId: "wash-detector" };
    assert.equal(await Effect.runPromise(store.nextVersion(scope)), 1);
    await Effect.runPromise(store.stageVersion(ENV, prepared.version, prepared.contents));
    assert.equal(await Effect.runPromise(store.nextVersion(scope)), 2);
    const path = NodePath.join(root, ENV, "bundles", "wash-detector", "v1.json");
    await NodeFs.writeFile(path, "corrupt retained data");
    const result = await Effect.runPromise(
      store.stageVersion(ENV, prepared.version, prepared.contents).pipe(Effect.exit),
    );
    assert.equal(result._tag, "Failure");
    assert.equal(await NodeFs.readFile(path, "utf8"), "corrupt retained data");
    assert.equal(await Effect.runPromise(store.nextVersion(scope)), 2);
  } finally {
    await NodeFs.rm(root, { recursive: true, force: true });
  }
});
