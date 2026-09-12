/**
 * Direct handler tests for the `trading_forge` lifecycle and the `forge`
 * fetch keys of `trading_look` (T3-14 / F2).
 *
 * What is pinned here:
 * - `trading_look`'s forge discovery is served from the capability store at
 *   runtime: an empty catalog is an honest empty answer, an unknown id is
 *   named in `unavailable`, and an installed capability with a committed
 *   evaluation serves catalog, latest and history.
 * - `approve_pool` is refused on the agent path, unconditionally — pool
 *   approval is a human act through the user-service path.
 * - The direct user controls (pause/resume/uninstall) work with nothing but
 *   the store behind them — no provider, no reactor loop.
 * - `status` reports provider jobs and observed data as separate records.
 * - `prepare` names a missing workspace instead of inventing a path.
 */
// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off globalConsole:off preferSchemaOverJson:off - real files under temp roots are the fixture; receipts are wall-clock data; JSON is the storage codec under test.

import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs/promises";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { runMigrations } from "../../../persistence/Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  FORGE_SDK_SCHEMA_VERSION,
  type TradingForgeResult,
  type TradingObservation,
} from "@t3tools/trading-contracts";
import { TradingToolRejectedError } from "@t3tools/trading-contracts/tools";
import { HyperliquidGateway } from "@t3tools/hyperliquid";
import { TradingMissionServiceLive } from "../../../trading/TradingMissionService.ts";
import { TradingMarketArchive } from "../../../trading/TradingMarketArchive.ts";
import {
  ForgeCapabilityStore,
  ForgeCapabilityStoreConfig,
  ForgeCapabilityStoreLive,
  type ForgeCapabilityStoreShape,
} from "../../../trading/forge/CapabilityStore.ts";
import { ForgeReactor } from "../../../trading/forge/ForgeReactor.ts";
import { ForgeCapabilityBuilder } from "../../../trading/forge/CapabilityBuilder.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { handlers } from "./handlers.ts";

const ENV_ID = EnvironmentId.make("env_forge_handler");
const THREAD = ThreadId.make("thread_forge_handler");
const CAPABILITY = "wash-detector";

const invocationScope: McpInvocationContext.McpInvocationScope = {
  environmentId: ENV_ID,
  threadId: THREAD,
  providerSessionId: "sess_forge",
  providerInstanceId: ProviderInstanceId.make("pi_forge"),
  capabilities: new Set(["trading"]),
  issuedAt: Date.now(),
};

/** The gateway is yielded before the fetch path decides what it needs; a
 * die-if-touched stand-in keeps a forge-only look off any exchange. */
const stubGateway = Layer.succeed(HyperliquidGateway, {
  getMarketSnapshot: () => Effect.die("no exchange in the forge handler tests"),
} as unknown as HyperliquidGateway["Service"]);

const storeOver = (stateRoot: string) =>
  ForgeCapabilityStoreLive.pipe(
    Layer.provide(Layer.succeed(ForgeCapabilityStoreConfig, { stateRoot })),
  );

/** The reactor stub: jobs are data here; the queue itself has its own tests. */
const stubReactor = (
  jobs: ReadonlyArray<{
    readonly jobId: string;
    readonly status: string;
    readonly detail?: string;
  }> = [],
) =>
  Layer.succeed(ForgeReactor, {
    enqueueEvaluation: () => Effect.die("not used here"),
    drain: () => Effect.void,
    cancel: () => Effect.succeed(false),
    listJobs: () =>
      Effect.succeed(
        jobs.map((job) => ({
          ...job,
          kind: "evaluation" as const,
          environmentId: ENV_ID,
          capabilityId: CAPABILITY,
          createdAtMs: 0,
        })),
      ),
    observedStatus: () => Effect.succeed(null),
  } as unknown as ForgeReactor["Service"]);

const provide = (stateRoot: string, extra: Layer.Layer<ForgeReactor> = stubReactor()) =>
  Layer.mergeAll(
    Layer.succeed(McpInvocationContext.McpInvocationContext, invocationScope),
    stubGateway,
    storeOver(stateRoot),
    TradingMissionServiceLive,
    extra,
    Layer.succeed(ForgeCapabilityBuilder, {
      prepare: () => Effect.die("not used here"),
      check: () => Effect.die("not used here"),
    } as unknown as ForgeCapabilityBuilder["Service"]),
    // The archive seam is yielded before the fetch path decides what a
    // forge-only look needs; a die-if-touched stand-in keeps it unused.
    Layer.succeed(TradingMarketArchive, {
      read: () => Effect.die("no archive in the forge handler tests"),
    } as unknown as TradingMarketArchive["Service"]),
  ).pipe(Layer.provideMerge(NodeSqliteClient.layerMemory()));

/** One handler call, over a migrated memory database. The cast is explicit:
 * the handler effects type their full service set; only the ones this call
 * actually reaches are provided, and an unused service is never resolved. */
const call = <A, E>(
  effect: Effect.Effect<A, E>,
  stateRoot: string,
  extra?: Layer.Layer<ForgeReactor>,
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* runMigrations({});
      return yield* effect;
    }).pipe(Effect.provide(provide(stateRoot, extra))),
  );

const storeAt = (stateRoot: string): Promise<ForgeCapabilityStoreShape> =>
  Effect.runPromise(Effect.provide(storeOver(stateRoot))(ForgeCapabilityStore));

/** Install one fixture capability version directly through the store's CAS. */
const seedInstalledCapability = async (store: ForgeCapabilityStoreShape): Promise<void> => {
  const contents: Record<string, string> = {
    "query.graphql": "query { swaps { id } }",
    "signal.ts": "export const readSignal = 1;",
    "signal.test.ts": 'test("x", () => {});',
    "manifest.json": JSON.stringify({
      capabilityId: CAPABILITY,
      version: 1,
      schemaVersion: FORGE_SDK_SCHEMA_VERSION,
      description: "fixture detector",
    }),
  };
  const bundleSha256 = NodeCrypto.createHash("sha256")
    .update(Object.values(contents).join("\n"))
    .digest("hex");
  const staged = await Effect.runPromise(
    store.stageVersion(
      ENV_ID,
      {
        capabilityId: CAPABILITY,
        version: 1,
        bundleSha256,
        artifacts: Object.entries(contents).map(([path, content]) => ({
          path,
          sha256: NodeCrypto.createHash("sha256").update(content).digest("hex"),
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
      environmentId: ENV_ID,
      capabilityId: CAPABILITY,
      version: 1,
      bundleSha256,
      expectedActiveVersion: null,
    }),
  );
  assert.equal(installed.status, "installed");
};

const tempRoot = async (): Promise<string> =>
  NodePath.join(await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "forge-handler-")));

it("trading_look serves forge discovery from the store, empty included", async () => {
  const root = await tempRoot();
  try {
    // The empty catalog is the honest pre-first-request answer.
    const empty = await call(
      handlers.trading_look({ fetch: ["forge"] }) as unknown as Effect.Effect<
        TradingObservation,
        TradingToolRejectedError
      >,
      root,
    );
    assert.deepEqual(empty.forge?.catalog, []);
    assert.isUndefined(empty.forge?.latest);
    assert.isUndefined(empty.unavailable);

    // An id nothing is installed under is named, never silently empty.
    const unknown = await call(
      handlers.trading_look({ fetch: [`forge:${CAPABILITY}`] }) as unknown as Effect.Effect<
        TradingObservation,
        TradingToolRejectedError
      >,
      root,
    );
    assert.include(unknown.unavailable?.[0]?.reason ?? "", "not installed");

    // Install + commit one evaluation: catalog, latest and history serve it.
    const store = await storeAt(root);
    await seedInstalledCapability(store);
    await Effect.runPromise(
      store.recordEvaluation({
        evaluationId: "feval_fixture",
        environmentId: ENV_ID,
        capabilityId: CAPABILITY,
        capabilityVersion: 1,
        bundleSha256: "ab".repeat(32),
        window: { startedAt: 0, endedAt: 60_000 },
        historical: false,
        evidenceIds: ["forge_ev_fixture"],
        status: "complete",
        reading: { kind: "insufficient", reason: "fixture" },
        createdAtMs: 1_000,
        completedAtMs: 1_100,
      }),
    );
    const served = await call(
      handlers.trading_look({
        fetch: ["forge", `forge:${CAPABILITY}`, `forge:${CAPABILITY}:history`],
      }) as unknown as Effect.Effect<TradingObservation, TradingToolRejectedError>,
      root,
    );
    assert.equal(served.forge?.catalog.length, 1);
    assert.equal(served.forge?.catalog[0]?.capabilityId, CAPABILITY);
    assert.equal(served.forge?.catalog[0]?.status, "installed");
    assert.isDefined(served.forge?.latest);
    assert.equal(served.forge?.history?.length, 1);
  } finally {
    await NodeFs.rm(root, { recursive: true, force: true });
  }
});

it("an agent cannot self-approve a pool, but can propose one for the human", async () => {
  const root = await tempRoot();
  try {
    const approved = await call(
      handlers.trading_forge({
        action: "approve_pool",
        capabilityId: CAPABILITY,
      }) as unknown as Effect.Effect<TradingForgeResult, TradingToolRejectedError>,
      root,
    );
    assert.equal(approved.outcome, "rejected");
    assert.equal(approved.reason, "agent_cannot_approve");
    assert.include(approved.detail ?? "", "human");

    const proposed = await call(
      handlers.trading_forge({
        action: "propose_pool",
        poolId: "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640",
        reason: "the 0.05% WETH/USDC pool",
      }) as unknown as Effect.Effect<TradingForgeResult, TradingToolRejectedError>,
      root,
    );
    assert.equal(proposed.outcome, "accepted");
    assert.equal(proposed.proposals?.[0]?.status, "proposed");
  } finally {
    await NodeFs.rm(root, { recursive: true, force: true });
  }
});

it("the direct user controls work with only the store behind them", async () => {
  const root = await tempRoot();
  try {
    await seedInstalledCapability(await storeAt(root));

    const paused = await call(
      handlers.trading_forge({
        action: "pause",
        capabilityId: CAPABILITY,
      }) as unknown as Effect.Effect<TradingForgeResult, TradingToolRejectedError>,
      root,
    );
    assert.equal(paused.outcome, "accepted");
    assert.equal(paused.catalog?.[0]?.status, "paused");

    const resumed = await call(
      handlers.trading_forge({
        action: "resume",
        capabilityId: CAPABILITY,
      }) as unknown as Effect.Effect<TradingForgeResult, TradingToolRejectedError>,
      root,
    );
    assert.equal(resumed.outcome, "accepted");
    assert.equal(resumed.catalog?.[0]?.status, "installed");

    const uninstalled = await call(
      handlers.trading_forge({
        action: "uninstall",
        capabilityId: CAPABILITY,
      }) as unknown as Effect.Effect<TradingForgeResult, TradingToolRejectedError>,
      root,
    );
    assert.equal(uninstalled.outcome, "accepted");
    assert.isEmpty(uninstalled.catalog);
  } finally {
    await NodeFs.rm(root, { recursive: true, force: true });
  }
});

it("status reports provider jobs and observed data separately", async () => {
  const root = await tempRoot();
  try {
    await seedInstalledCapability(await storeAt(root));
    const status = await call(
      handlers.trading_forge({
        action: "status",
        capabilityId: CAPABILITY,
      }) as unknown as Effect.Effect<TradingForgeResult, TradingToolRejectedError>,
      root,
      stubReactor([{ jobId: "fjob_1", status: "complete", detail: "evaluation committed" }]),
    );
    assert.equal(status.outcome, "accepted");
    assert.equal(status.jobs?.length, 1);
    assert.equal(status.jobs?.[0]?.status, "complete");
    // The data half: no committed evaluation exists, so it says so as an
    // absence — distinct from the job's success.
    assert.isDefined(status.dataStatus);
    assert.isUndefined(status.dataStatus?.lastEvaluation);
  } finally {
    await NodeFs.rm(root, { recursive: true, force: true });
  }
});

it("prepare names a missing workspace instead of inventing a path", async () => {
  const root = await tempRoot();
  try {
    const refused = await call(
      handlers.trading_forge({
        action: "prepare",
        capabilityId: CAPABILITY,
        requestedSemantics: "detect coordinated wash trading",
      }) as unknown as Effect.Effect<TradingForgeResult, TradingToolRejectedError>,
      root,
    );
    // The memory database has no provider_session_runtime row for this thread,
    // so there is no workspace root: a named refusal, never a silent path.
    assert.equal(refused.outcome, "rejected");
    assert.equal(refused.reason, "no_workspace");

    const needsInput = await call(
      handlers.trading_forge({ action: "prepare" }) as unknown as Effect.Effect<
        TradingForgeResult,
        TradingToolRejectedError
      >,
      root,
    );
    assert.equal(needsInput.outcome, "rejected");
    assert.equal(needsInput.reason, "needs_input");
  } finally {
    await NodeFs.rm(root, { recursive: true, force: true });
  }
});
