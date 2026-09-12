// @effect-diagnostics preferSchemaOverJson:off - canonical serialization is hashed to bind retained provenance.
/**
 * What the fee-policy lifecycle claims, held to its contract.
 *
 * The layer graph in every test contains NO agent-provider service — the
 * direct controls building and broadcasting here IS the "works with the
 * provider stopped" proof, by construction. The fake Sepolia chain serves
 * every RPC response (hand-composed logs, no encoder round-trips); the
 * evidence store is a real in-memory SQLite with migrations, seeded through
 * the same layer the service reads from. No sleeps: every transition awaits
 * the service's own reads and receipts.
 *
 * @module FeePolicyService.test
 */
import { createHash } from "node:crypto";
import { ForgeCapabilityStore, type ForgeCapabilityStoreShape } from "./CapabilityStore.ts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { keccak256, toBytes } from "viem";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../../persistence/Migrations.ts";
import {
  FeePolicyConfig,
  FeePolicyService,
  FeePolicyServiceLive,
  resolveFeePolicySettings,
  type FeePolicySettings,
} from "./FeePolicyService.ts";
import {
  ForgeSourceStore,
  ForgeSourceStoreLive,
  type ForgeSourceStoreShape,
} from "./ForgeSourceStore.ts";
import {
  ForgeBroadcastRefused,
  ForgeTestnetConfig,
  ForgeIntentLedger,
  makeInMemoryForgeIntentLedger,
  ForgeSepoliaTransport,
  SignedTransactionBroadcaster,
  ForgeGrantGuard,
  UniswapTestnetAdapterLive,
  forgeBindingId,
  forgeFullPoolId,
  type ForgeSepoliaRpcTransportShape,
  type SignedTransactionBroadcasterShape,
} from "./UniswapTestnetAdapter.ts";
import {
  resolveForgeTestnetSettings,
  SEPOLIA_V4_ADDRESSES,
  type ForgeTestnetSettings,
} from "./SepoliaTarget.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const HOOK = `0x${"ab".repeat(19)}80`;
const C0 = `0x${"11".repeat(20)}`;
const C1 = `0x${"22".repeat(20)}`;
const TICK_SPACING = 60;
const FULL_POOL_ID = forgeFullPoolId({
  currency0: C0,
  currency1: C1,
  fee: 0x800000,
  tickSpacing: TICK_SPACING,
  hookAddress: HOOK,
});
const BINDING = forgeBindingId({
  currency0: C0,
  currency1: C1,
  fee: 0x800000,
  tickSpacing: TICK_SPACING,
});

const BLOCK = 7_500_000;
const BLOCK_TS = 1_775_700_000;
const DIGEST_HEX = "cd".repeat(32);
const BUNDLE_HASH = "ef".repeat(32);
const aggregateDigest = createHash("sha256")
  .update(JSON.stringify([DIGEST_HEX]))
  .digest("hex");
const EVIDENCE_DIGEST = `0x${createHash("sha256")
  .update(
    JSON.stringify({
      environmentId: "env-1",
      evaluationId: "eval-1",
      bundleSha256: BUNDLE_HASH,
      sourceDigest: aggregateDigest,
    }),
  )
  .digest("hex")}`;
/** The official Sepolia PoolManager, checksummed as a real RPC serves it. */
const POOL_MANAGER = "0xE03A1074c86CFeDd5C142C4F04F1a1536e203543";

const TARGET_ENV: Record<string, string | undefined> = {
  T3_FORGE_SEPOLIA_RPC_URL: "https://sepolia.test/rpc",
  T3_FORGE_SEPOLIA_HOOK_ADDRESS: HOOK,
  T3_FORGE_SEPOLIA_CURRENCY0: C0,
  T3_FORGE_SEPOLIA_CURRENCY1: C1,
  T3_FORGE_SEPOLIA_TICK_SPACING: String(TICK_SPACING),
};

const GRANT_ENV: Record<string, string | undefined> = {
  T3_FORGE_GRANT_ID: "f0-demo-grant",
  T3_FORGE_GRANT_TOKEN0_CAP_RAW: "10000000000000000000000",
  T3_FORGE_GRANT_TOKEN1_CAP_RAW: "10000000000",
  T3_FORGE_GRANT_PER_SWAP_MAX_QUOTE_RAW: "500000000",
  T3_FORGE_GRANT_AGGREGATE_GAS_WEI: "100000000000000000",
  T3_FORGE_GRANT_OPERATOR_ADDRESS: `0x${"77".repeat(20)}`,
  T3_FORGE_GRANT_EXPIRES_AT_UNIX: String(BLOCK_TS + 86_400),
};

/** Evidence window that ends comfortably before the fake chain time. */
const EVIDENCE_WINDOW = { start: BLOCK_TS - 1_200, end: BLOCK_TS - 600 };
/** A window whose derived expiry would already be in the chain's past. */
const STALE_WINDOW = { start: BLOCK_TS - 30_000, end: BLOCK_TS - 30_000 + 600 };

const word = (value: string | bigint): string =>
  (typeof value === "bigint" ? value.toString(16) : value.replace(/^0x/, "")).padStart(64, "0");
const wordSigned = (value: bigint): string =>
  (value < 0n ? 2n ** 256n + value : value).toString(16).padStart(64, "0");
const topic0 = (signature: string): string => keccak256(toBytes(signature));

/** Mutable fake chain: a stateful Sepolia stand-in with hand-composed logs. */
const makeFakeChain = (options?: {
  readonly advancePerBlockRead?: number;
  readonly failHookViews?: boolean;
  readonly effectiveFeeAtBlock?: (block: number) => number | "fail";
}) => {
  const state = {
    blockNumber: BLOCK,
    blockTimestamp: BLOCK_TS,
    hook: {
      revision: 0n,
      expiry: 0n,
      evidenceDigest: `0x${"0".repeat(64)}`,
      policyActive: false,
      paused: false,
      effectiveFee: 3000,
    },
    receipts: new Map<string, Record<string, unknown>>(),
    txs: new Map<string, unknown>(),
  };
  const selector = (signature: string) => keccak256(toBytes(signature)).slice(0, 10);
  const routes: Record<string, () => string> = {
    [selector("policyActive()")]: () => word(state.hook.policyActive ? 1n : 0n),
    [selector("paused()")]: () => word(state.hook.paused ? 1n : 0n),
    [selector("owner()")]: () => word("aa".repeat(20)),
    [selector("operator()")]: () => word("77".repeat(20)),
    [selector("boundPoolId()")]: () => BINDING.slice(2),
    [selector("BASELINE_FEE()")]: () => word(3000n),
    [selector("POLICY_FEE()")]: () => word(500n),
    [selector("getPolicy()")]: () =>
      word(state.hook.revision) +
      word(state.hook.expiry) +
      word(state.hook.evidenceDigest.slice(2)),
    [selector("effectiveFee(bytes32)")]: () => word(BigInt(state.hook.effectiveFee)),
    [selector("beforeSwapFeeOverride(bytes32)")]: () =>
      word(0x400000n | BigInt(state.hook.effectiveFee)),
  };

  const shape: ForgeSepoliaRpcTransportShape = {
    request: (method, params) =>
      Effect.gen(function* () {
        if (method === "eth_chainId") return "0xaa36a7";
        if (method === "eth_getBlockByNumber") {
          const advance = options?.advancePerBlockRead ?? 0;
          if (advance > 0) {
            state.blockNumber += advance;
            state.blockTimestamp += advance * 12;
          }
          return {
            number: "0x" + state.blockNumber.toString(16),
            timestamp: "0x" + state.blockTimestamp.toString(16),
            hash: "0x" + "9a".repeat(32),
          };
        }
        if (method === "eth_call") {
          if (options?.failHookViews === true) {
            return yield* Effect.fail("eth_call reverted");
          }
          const call = params[0] as { data: string };
          const block = params[1];
          const pinned = typeof block === "string" && block !== "latest";
          const sel = call.data.slice(0, 10);
          if (
            sel === selector("effectiveFee(bytes32)") &&
            pinned &&
            options?.effectiveFeeAtBlock !== undefined
          ) {
            const served = options.effectiveFeeAtBlock(Number(block));
            if (served === "fail") return yield* Effect.fail("missing trie node");
            return "0x" + word(BigInt(served));
          }
          const route = routes[sel];
          if (route === undefined) return yield* Effect.fail(`no fake route for ${sel}`);
          return "0x" + route();
        }
        if (method === "eth_getTransactionReceipt")
          return state.receipts.get(params[0] as string) ?? null;
        if (method === "eth_getTransactionByHash")
          return state.txs.get(params[0] as string) ?? null;
        return yield* Effect.fail(`fake chain does not serve ${method}`);
      }),
  };
  return { shape, state };
};

/** Confirms a tx with a PolicyPublished log, mutating the hook like the chain would. */
const confirmPolicyPublish = (
  fake: ReturnType<typeof makeFakeChain>,
  txHash: string,
  input: { revision: bigint; expiry: bigint; digest: string; blockNumber?: number },
) => {
  const blockNumber = input.blockNumber ?? fake.state.blockNumber + 1;
  fake.state.receipts.set(txHash, {
    transactionHash: txHash,
    status: "0x1",
    blockNumber: "0x" + blockNumber.toString(16),
    gasUsed: "0x186a0",
    effectiveGasPrice: "0x3b9aca00",
    logs: [
      {
        address: HOOK,
        topics: [topic0("PolicyPublished(bytes32,uint256,uint256,bytes32)"), BINDING],
        data: "0x" + word(input.revision) + word(input.expiry) + word(input.digest.slice(2)),
        blockNumber: "0x" + blockNumber.toString(16),
        transactionHash: txHash,
        logIndex: "0x0",
      },
    ],
  });
  fake.state.txs.set(txHash, { hash: txHash });
  fake.state.hook.revision = input.revision;
  fake.state.hook.expiry = input.expiry;
  fake.state.hook.evidenceDigest = input.digest;
  fake.state.hook.policyActive = true;
  fake.state.hook.effectiveFee = 500;
};

/** Confirms a tx with a ModifyLiquidity log on the forge pool. */
const confirmModifyLiquidity = (
  fake: ReturnType<typeof makeFakeChain>,
  txHash: string,
  input: { tickLower: number; tickUpper: number; liquidityDelta: bigint },
) => {
  const blockNumber = fake.state.blockNumber + 1;
  fake.state.receipts.set(txHash, {
    transactionHash: txHash,
    status: "0x1",
    blockNumber: "0x" + blockNumber.toString(16),
    gasUsed: "0x186a0",
    effectiveGasPrice: "0x3b9aca00",
    logs: [
      {
        address: POOL_MANAGER,
        topics: [
          topic0("ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)"),
          FULL_POOL_ID,
          `0x${word("aa".repeat(20))}`,
        ],
        data:
          "0x" +
          wordSigned(BigInt(input.tickLower)) +
          wordSigned(BigInt(input.tickUpper)) +
          wordSigned(input.liquidityDelta) +
          word("00".repeat(32)),
        blockNumber: "0x" + blockNumber.toString(16),
        transactionHash: txHash,
        logIndex: "0x0",
      },
    ],
  });
  fake.state.txs.set(txHash, { hash: txHash });
};

const makeFakeBroadcaster = () => {
  let next = 1;
  const shape: SignedTransactionBroadcasterShape = {
    broadcast: () => Effect.succeed({ txHash: "0x" + (next++).toString(16).padStart(64, "0") }),
  };
  return shape;
};

// ---------------------------------------------------------------------------
// Layers — one layer exposes the service AND its store, one SQLite for both
// ---------------------------------------------------------------------------

const refusingBroadcaster: SignedTransactionBroadcasterShape = {
  broadcast: () =>
    new ForgeBroadcastRefused({
      reason: "broadcaster-missing",
      detail: "no grant-controlled signer is wired in this test",
    }),
};

const serviceLayer = (
  transport: ForgeSepoliaRpcTransportShape,
  env: Record<string, string | undefined>,
  broadcaster: SignedTransactionBroadcasterShape = refusingBroadcaster,
  feePolicySettings?: Partial<FeePolicySettings>,
) =>
  FeePolicyServiceLive.pipe(
    Layer.provide(
      Layer.effect(
        ForgeCapabilityStore,
        Effect.gen(function* () {
          const source = yield* ForgeSourceStore;
          // Only the two read-only boundaries this service consumes are mocked.
          const readOnlyStore: Pick<ForgeCapabilityStoreShape, "activeState" | "latestEvaluation"> =
            {
              activeState: () =>
                Effect.succeed({ version: 1, bundleSha256: BUNDLE_HASH, status: "installed" }),
              latestEvaluation: () =>
                Effect.gen(function* () {
                  const record = yield* source
                    .readRecord("forge_ev_fresh")
                    .pipe(Effect.orElseSucceed(() => null));
                  if (record === null) return null;
                  return {
                    evaluationId: "eval-1",
                    environmentId: "env-1",
                    capabilityId: "detector",
                    capabilityVersion: 1,
                    bundleSha256: BUNDLE_HASH,
                    window: {
                      startedAt: record.windowStart * 1000,
                      endedAt: record.windowEnd * 1000,
                    },
                    historical: false,
                    pinnedBlock: record.pinnedBlock,
                    sourceDigest: createHash("sha256")
                      .update(JSON.stringify([record.digest]))
                      .digest("hex"),
                    evidenceIds: [record.evidenceId],
                    status: "complete",
                    reading: {
                      kind: "ready",
                      regime: "coordinated",
                      agreement: 1,
                      eligiblePoolIds: [C1],
                    },
                    createdAtMs: record.fetchedAtMs,
                  } as const;
                }),
            };
          return readOnlyStore as ForgeCapabilityStoreShape;
        }),
      ),
    ),
    Layer.provideMerge(
      UniswapTestnetAdapterLive.pipe(
        Layer.provide(
          Layer.succeed(ForgeTestnetConfig, {
            resolve: Effect.sync((): ForgeTestnetSettings => resolveForgeTestnetSettings(env)),
          }),
        ),
        Layer.provide(Layer.succeed(ForgeSepoliaTransport, ForgeSepoliaTransport.of(transport))),
        Layer.provideMerge(admittedTestLedger),
        Layer.provideMerge(Layer.succeed(SignedTransactionBroadcaster, broadcaster)),
        Layer.provideMerge(permissiveGrantGuard),
      ),
    ),
    // provideMerge exposes the store (and its SQLite) to the test, so the
    // evidence rows the service reads are the rows the test seeds.
    Layer.provideMerge(
      ForgeSourceStoreLive.pipe(Layer.provideMerge(NodeSqliteClient.layerMemory())),
    ),
    Layer.provideMerge(
      Layer.succeed(FeePolicyConfig, {
        resolve: Effect.sync(() =>
          resolveFeePolicySettings({
            ...(feePolicySettings?.policyDurationSeconds === undefined
              ? {}
              : {
                  T3_FORGE_POLICY_DURATION_SECONDS: String(feePolicySettings.policyDurationSeconds),
                }),
            ...(feePolicySettings?.snapshotMaxLagBlocks === undefined
              ? {}
              : {
                  T3_FORGE_SNAPSHOT_MAX_LAG_BLOCKS: String(feePolicySettings.snapshotMaxLagBlocks),
                }),
          }),
        ),
      }),
    ),
  );

/** Migrate + seed one evidence row through the layer's own store. */
const seedEvidence = (
  store: ForgeSourceStoreShape,
  input: {
    readonly evidenceId: string;
    readonly historical: boolean;
    readonly digest?: string;
    readonly window?: { readonly start: number; readonly end: number };
  },
) =>
  store.insert({
    record: {
      evidenceId: input.evidenceId,
      environmentId: "env-1",
      poolId: C1,
      historical: input.historical,
      endpoint: "https://graph.test/subgraphs/id/dep",
      deployment: "dep",
      pinnedBlock: 22_000_000,
      windowStart: input.window?.start ?? EVIDENCE_WINDOW.start,
      windowEnd: input.window?.end ?? EVIDENCE_WINDOW.end,
      fetchedAtMs: 1_775_700_000_000,
      digest: input.digest ?? DIGEST_HEX,
      observationCount: 3,
    },
    observations: [],
  });

// Test-only simulation of durable admission. It proves service state transitions,
// not actual persistence or gas enforcement. Production has no implementation.
// Permissive grant-guard double: these tests exercise fee-policy and pool
// behavior, not grant immutability (which has its own dedicated suites over
// the real SQL guard).
const permissiveGrantGuard = Layer.succeed(ForgeGrantGuard, {
  recordOrVerify: () => Effect.succeed({ status: "verified" as const }),
});

const MINT_OWNER = `0x${"0e".repeat(20)}`;

const admittedTestLedger = Layer.effect(
  ForgeIntentLedger,
  Effect.gen(function* () {
    const ledger = yield* makeInMemoryForgeIntentLedger;
    const claimed = new Set<string>();
    return ForgeIntentLedger.of({
      ...ledger,
      durableAdmission: {
        claim: (record) =>
          Effect.gen(function* () {
            const won = yield* Effect.sync(() => {
              if (claimed.has(record.intentId)) return false;
              claimed.add(record.intentId);
              return true;
            });
            if (!won) return false;
            yield* ledger.upsert({ ...record, status: "unknown" });
            return true;
          }),
      },
    });
  }),
);

const ENV = { ...TARGET_ENV, ...GRANT_ENV };
const PUBLISH_INPUT = {
  environmentId: "env-1",
  evidenceId: "forge_ev_fresh",
  sourceEvaluationId: "eval-1",
  capabilityId: "detector",
  capabilityVersion: 1,
} as const;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("readPoolProposal", () => {
  it.effect("exposes the exact pool proposal, binding id, and grant state", () =>
    Effect.gen(function* () {
      const service = yield* FeePolicyService.pipe(
        Effect.provide(serviceLayer(makeFakeChain().shape, ENV)),
      );
      const proposal = yield* service.readPoolProposal;
      assert.equal(proposal.status, "ok");
      if (proposal.status !== "ok") return;
      assert.equal(proposal.target.chainName, "sepolia");
      assert.equal(proposal.target.chainId, 11155111);
      assert.equal(proposal.target.poolKey.fee, 0x800000);
      assert.equal(proposal.target.bindingId, BINDING);
      assert.equal(proposal.target.fullPoolId, FULL_POOL_ID);
      assert.equal(proposal.grant.status, "approved");
    }),
  );

  it.effect("names the missing grant honestly", () =>
    Effect.gen(function* () {
      const service = yield* FeePolicyService.pipe(
        Effect.provide(serviceLayer(makeFakeChain().shape, TARGET_ENV)),
      );
      const proposal = yield* service.readPoolProposal;
      assert.equal(proposal.status, "ok");
      if (proposal.status !== "ok") return;
      assert.equal(proposal.grant.status, "missing");
      assert.include(
        proposal.grant.status === "missing" ? proposal.grant.missingReason : "",
        "T3_FORGE_GRANT_ID",
      );
    }),
  );
});

describe("publishFromEvidence", () => {
  it.effect("builds from fresh evidence: source-derived expiry, chain+1 revision", () =>
    Effect.gen(function* () {
      const fake = makeFakeChain();
      fake.state.hook.revision = 3n;
      const layer = serviceLayer(fake.shape, ENV);
      return yield* Effect.gen(function* () {
        yield* runMigrations({});
        const store = yield* ForgeSourceStore;
        yield* seedEvidence(store, { evidenceId: PUBLISH_INPUT.evidenceId, historical: false });
        const service = yield* FeePolicyService;

        const result = yield* service.publishFromEvidence({ ...PUBLISH_INPUT });
        assert.equal(result.status, "ok");
        if (result.status !== "ok") return;
        // Revision = max(chain 3, local 0) + 1; expiry = windowEnd + 900s.
        assert.equal(result.record.params["revision"], "4");
        assert.equal(result.record.params["expiryUnix"], String(EVIDENCE_WINDOW.end + 900));
        assert.equal(result.record.params["evidenceDigest"], EVIDENCE_DIGEST);
        assert.equal(result.record.params["sourceEvaluationId"], "eval-1");
        assert.equal(result.record.unsigned.to, HOOK);
        assert.equal(result.record.status, "draft");
        assert.ok(result.record.unsigned.data.startsWith("0xb9d299c3"));
        assert.equal(result.record.params["bindingId"], BINDING);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("refuses historical evidence and missing evidence", () =>
    Effect.gen(function* () {
      const layer = serviceLayer(makeFakeChain().shape, ENV);
      return yield* Effect.gen(function* () {
        yield* runMigrations({});
        const store = yield* ForgeSourceStore;
        yield* seedEvidence(store, { evidenceId: "forge_ev_hist", historical: true });
        const service = yield* FeePolicyService;

        const historical = yield* service.publishFromEvidence({
          ...PUBLISH_INPUT,
          evidenceId: "forge_ev_hist",
        });
        assert.equal(historical.status, "refused");
        if (historical.status === "refused") assert.equal(historical.reason, "historical-evidence");

        const missing = yield* service.publishFromEvidence({
          ...PUBLISH_INPUT,
          evidenceId: "forge_ev_none",
        });
        assert.equal(missing.status, "refused");
        if (missing.status === "refused") assert.equal(missing.reason, "evidence-not-found");
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("refuses an expiry that is not in the chain's future", () =>
    Effect.gen(function* () {
      const layer = serviceLayer(makeFakeChain().shape, ENV);
      return yield* Effect.gen(function* () {
        yield* runMigrations({});
        const store = yield* ForgeSourceStore;
        yield* seedEvidence(store, {
          evidenceId: PUBLISH_INPUT.evidenceId,
          historical: false,
          window: STALE_WINDOW,
        });
        const service = yield* FeePolicyService;

        const result = yield* service.publishFromEvidence({
          ...PUBLISH_INPUT,
          evidenceId: PUBLISH_INPUT.evidenceId,
        });
        assert.equal(result.status, "refused");
        if (result.status === "refused") assert.equal(result.reason, "expiry-not-future");
      }).pipe(Effect.provide(layer));
    }),
  );
});

describe("local pause and direct controls (no provider anywhere)", () => {
  it.effect("safety controls build under local pause; exposure intents refuse", () =>
    Effect.gen(function* () {
      const layer = serviceLayer(makeFakeChain().shape, ENV);
      const seeded = yield* Effect.gen(function* () {
        yield* runMigrations({});
        const store = yield* ForgeSourceStore;
        yield* seedEvidence(store, { evidenceId: PUBLISH_INPUT.evidenceId, historical: false });
        return yield* FeePolicyService;
      }).pipe(Effect.provide(layer));

      const controls = yield* seeded.setLocalPause(true);
      assert.equal(controls.localPause, true);
      assert.equal(
        controls.controls.find((control) => control.name === "unpause")?.blockedBy,
        "local-pause",
      );
      assert.equal(controls.controls.find((control) => control.name === "pause")?.blockedBy, null);

      const publish = yield* seeded.publishFromEvidence({ ...PUBLISH_INPUT });
      assert.equal(publish.status, "refused");
      if (publish.status === "refused") assert.equal(publish.reason, "locally-paused");

      const unpause = yield* seeded.requestUnpause({ environmentId: "env-1" });
      assert.equal(unpause.status, "refused");

      // Safety-reducing controls keep working — the provider-stopped
      // guarantee: no provider service exists in this layer at all.
      const pause = yield* seeded.requestPause({ environmentId: "env-1" });
      assert.equal(pause.status, "ok");
      const revoke = yield* seeded.requestRevoke({ environmentId: "env-1" });
      assert.equal(revoke.status, "ok");
      const remove = yield* seeded.requestRemoveLiquidity({
        environmentId: "env-1",
        tickLower: -60,
        tickUpper: 60,
        liquidity: "1000",
        tokenId: "7",
      });
      assert.equal(remove.status, "ok");
      assert.ok(
        remove.status === "ok" &&
          remove.record.unsigned.to === SEPOLIA_V4_ADDRESSES.positionManager.toLowerCase(),
      );
    }),
  );

  it.effect("broadcast maps local-pause, broadcaster-missing, and grant refusals", () =>
    Effect.gen(function* () {
      const fake = makeFakeChain();
      const layer = serviceLayer(fake.shape, ENV);
      const pauseIntentId = yield* Effect.gen(function* () {
        yield* runMigrations({});
        const service = yield* FeePolicyService;
        yield* service.setLocalPause(true);

        const pause = yield* service.requestPause({ environmentId: "env-1" });
        assert.ok(pause.status === "ok");
        // pause is safety: broadcast proceeds past local pause but stops at
        // the (unwired) signer seam with the named refusal.
        const broadcast = yield* service.broadcast(
          pause.status === "ok" ? pause.record.intentId : "",
        );
        assert.equal(broadcast.status, "refused");
        if (broadcast.status === "refused")
          assert.equal(broadcast.refusal.reason, "broadcaster-missing");

        // Exposure intents refuse at BUILD time under local pause — an
        // earlier gate than broadcast, same protection.
        const exposure = yield* service.requestInitializePool({
          environmentId: "env-1",
          sqrtPriceX96: "79228162514264337593543950336",
        });
        assert.equal(exposure.status, "refused");
        if (exposure.status === "refused") assert.equal(exposure.reason, "locally-paused");
        return null;
      }).pipe(Effect.provide(layer));
      void pauseIntentId;

      const noGrant = yield* FeePolicyService.pipe(
        Effect.provide(serviceLayer(makeFakeChain().shape, TARGET_ENV, makeFakeBroadcaster())),
      );
      const noGrantPause = yield* noGrant.requestPause({ environmentId: "env-1" });
      const noGrantBroadcast = yield* noGrant.broadcast(
        noGrantPause.status === "ok" ? noGrantPause.record.intentId : "",
      );
      assert.equal(noGrantBroadcast.status, "refused");
      if (noGrantBroadcast.status === "refused")
        assert.equal(noGrantBroadcast.refusal.reason, "grant-missing");
    }),
  );
});

describe("policy lifecycle: publish → confirm → expire → baseline, with snapshots", () => {
  it.effect("tracks local vs chain state and module hashes across the whole lifecycle", () =>
    Effect.gen(function* () {
      const fake = makeFakeChain();
      fake.state.hook.revision = 3n;
      const broadcaster = makeFakeBroadcaster();
      const layer = serviceLayer(fake.shape, ENV, broadcaster);
      return yield* Effect.gen(function* () {
        yield* runMigrations({});
        const store = yield* ForgeSourceStore;
        yield* seedEvidence(store, { evidenceId: PUBLISH_INPUT.evidenceId, historical: false });
        const service = yield* FeePolicyService;

        // 1. Publish (draft) — local says draft, chain still holds revision 3.
        const publish = yield* service.publishFromEvidence({ ...PUBLISH_INPUT });
        assert.ok(publish.status === "ok");
        const draftState = yield* service.readPolicyState;
        assert.equal(draftState.status, "ok");
        assert.equal(draftState.local.policy?.status, "draft");
        assert.equal(draftState.chain.snapshot?.policy.revision, "3");
        assert.equal(draftState.moduleHash.installed, BUNDLE_HASH);
        assert.equal(draftState.moduleHash.confirmedOnChain, null); // zero digest on chain
        assert.equal(draftState.moduleHash.match, null);

        // 2. Broadcast + reconcile with the receipt — chain and local agree.
        const intentId = publish.status === "ok" ? publish.record.intentId : "";
        const sent = yield* service.broadcast(intentId);
        assert.equal(sent.status, "submitted");
        const txHash = sent.status === "submitted" ? (sent.record.txHash ?? "") : "";
        assert.notEqual(txHash, "");
        confirmPolicyPublish(fake, txHash, {
          revision: 4n,
          expiry: BigInt(EVIDENCE_WINDOW.end + 900),
          digest: EVIDENCE_DIGEST,
        });
        const reconciled = yield* service.reconcile(intentId);
        assert.equal(reconciled[0]?.status, "confirmed");

        const confirmedState = yield* service.readPolicyState;
        assert.equal(confirmedState.status, "ok");
        assert.equal(confirmedState.local.policy?.status, "confirmed");
        assert.equal(confirmedState.local.pendingConfirmation, false);
        assert.equal(confirmedState.chain.snapshot?.policy.revision, "4");
        assert.equal(confirmedState.chain.snapshot?.effectiveFeeHundredthsBps, 500);
        assert.equal(confirmedState.chain.stale, false);
        assert.equal(confirmedState.moduleHash.match, true);
        assert.equal(confirmedState.effectiveFeeHundredthsBps, 500);

        // 3. The chain moves past expiry — the policy lapses to baseline, and
        //    expiry is judged by the chain snapshot's own time, not a clock.
        fake.state.blockTimestamp = EVIDENCE_WINDOW.end + 900 + 12;
        fake.state.hook.policyActive = false;
        fake.state.hook.effectiveFee = 3000;
        const expiredState = yield* service.readPolicyState;
        assert.equal(expiredState.status, "ok");
        assert.equal(expiredState.local.policy?.status, "expired");
        assert.equal(expiredState.effectiveFeeHundredthsBps, 3000);
        assert.equal(expiredState.chain.snapshot?.policyActive, false);

        // 4. Reconcile is idempotent: terminal state never moves or re-counts.
        const again = yield* service.reconcile(intentId);
        assert.equal(again[0]?.status, "confirmed");
        assert.deepEqual(again[0], reconciled[0]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("marks a snapshot stale when the head races ahead of the pinned read", () =>
    Effect.gen(function* () {
      // The chain advances 3 blocks per block-read; the snapshot pins to the
      // block it saw and the freshness read sees a later head.
      const fake = makeFakeChain({ advancePerBlockRead: 3 });
      const service = yield* FeePolicyService.pipe(
        Effect.provide(serviceLayer(fake.shape, ENV, undefined, { snapshotMaxLagBlocks: 1 })),
      );
      const state = yield* service.readPolicyState;
      assert.equal(state.status, "ok");
      assert.equal(state.chain.stale, true);
      assert.include(state.chain.staleReason ?? "", "max lag 1");
    }),
  );

  it.effect("a confirmed revoke fails the local policy and returns the pool to baseline", () =>
    Effect.gen(function* () {
      const fake = makeFakeChain();
      const broadcaster = makeFakeBroadcaster();
      const layer = serviceLayer(fake.shape, ENV, broadcaster);
      return yield* Effect.gen(function* () {
        yield* runMigrations({});
        const store = yield* ForgeSourceStore;
        yield* seedEvidence(store, { evidenceId: PUBLISH_INPUT.evidenceId, historical: false });
        const service = yield* FeePolicyService;

        const publish = yield* service.publishFromEvidence({ ...PUBLISH_INPUT });
        assert.ok(publish.status === "ok");

        const revoke = yield* service.requestRevoke({ environmentId: "env-1" });
        assert.ok(revoke.status === "ok");
        const revokeIntentId = revoke.status === "ok" ? revoke.record.intentId : "";
        const sent = yield* service.broadcast(revokeIntentId);
        assert.equal(sent.status, "submitted");
        const txHash = sent.status === "submitted" ? (sent.record.txHash ?? "") : "";
        const blockNumber = fake.state.blockNumber + 1;
        fake.state.receipts.set(txHash, {
          transactionHash: txHash,
          status: "0x1",
          blockNumber: "0x" + blockNumber.toString(16),
          gasUsed: "0x186a0",
          effectiveGasPrice: "0x3b9aca00",
          logs: [
            {
              address: HOOK,
              topics: [topic0("PolicyRevoked(bytes32,uint256)"), BINDING],
              data: "0x" + word(4n),
              blockNumber: "0x" + blockNumber.toString(16),
              transactionHash: txHash,
              logIndex: "0x0",
            },
          ],
        });
        fake.state.txs.set(txHash, { hash: txHash });
        fake.state.hook.expiry = 0n;
        fake.state.hook.evidenceDigest = `0x${"0".repeat(64)}`;
        fake.state.hook.policyActive = false;
        fake.state.hook.effectiveFee = 3000;

        const reconciled = yield* service.reconcile(revokeIntentId);
        assert.equal(reconciled[0]?.status, "confirmed");
        const state = yield* service.readPolicyState;
        assert.equal(state.status, "ok");
        assert.equal(state.local.policy?.status, "failed");
        assert.equal(state.effectiveFeeHundredthsBps, 3000);
      }).pipe(Effect.provide(layer));
    }),
  );
});

describe("position state", () => {
  it.effect("proposed → pending → confirmed from receipt truth, then removal-pending", () =>
    Effect.gen(function* () {
      const fake = makeFakeChain();
      const broadcaster = makeFakeBroadcaster();
      const { service, ledger } = yield* Effect.gen(function* () {
        return { service: yield* FeePolicyService, ledger: yield* ForgeIntentLedger };
      }).pipe(Effect.provide(serviceLayer(fake.shape, ENV, broadcaster)));

      const none = yield* service.readPositionState;
      assert.equal(none.status, "ok");
      assert.equal(none.position.status, "none");

      const add = yield* service.requestAddLiquidity({
        environmentId: "env-1",
        tickLower: -60,
        tickUpper: 60,
        liquidity: "1000000000000000000",
        ownerAddress: MINT_OWNER,
        deposits: [
          { token: C0, amountRaw: "1000" },
          { token: C1, amountRaw: "2000" },
        ],
      });
      assert.ok(add.status === "ok");
      const proposed = yield* service.readPositionState;
      assert.equal(proposed.position.status, "proposed");
      assert.equal(proposed.position.tickLower, -60);
      assert.equal(proposed.position.tickUpper, 60);
      assert.equal(proposed.position.liquidity, null);

      const addIntentId = add.status === "ok" ? add.record.intentId : "";
      // Liquidity broadcasts now climb the real guard/admission ladder and
      // submit through the signer seam; the receipt projection below is then
      // exercised on a manually seeded confirmation for that same intent.
      const broadcasted = yield* service.broadcast(addIntentId);
      assert.equal(broadcasted.status, "submitted");
      assert.ok(add.status === "ok");
      const sent = {
        record: {
          ...add.record,
          status: "submitted" as const,
          txHash: `0x${"12".repeat(32)}`,
          submittedAtMs: 0,
        },
      };
      yield* ledger.upsert(sent.record);
      const pending = yield* service.readPositionState;
      assert.equal(pending.position.status, "pending");

      confirmModifyLiquidity(fake, sent.record.txHash, {
        tickLower: -60,
        tickUpper: 60,
        liquidityDelta: 1_000_000_000_000_000_000n,
      });
      yield* service.reconcile(addIntentId);
      const confirmed = yield* service.readPositionState;
      assert.equal(confirmed.position.status, "confirmed");
      assert.equal(confirmed.position.liquidity, "1000000000000000000");
      assert.equal(confirmed.position.positionId, null); // honest placeholder

      const remove = yield* service.requestRemoveLiquidity({
        environmentId: "env-1",
        tickLower: -60,
        tickUpper: 60,
        liquidity: "1000000000000000000",
        tokenId: "7",
      });
      assert.ok(remove.status === "ok");
      const removing = yield* service.broadcast(
        remove.status === "ok" ? remove.record.intentId : "",
      );
      assert.equal(removing.status, "submitted");
      assert.ok(remove.status === "ok");
      yield* ledger.upsert({
        ...remove.record,
        status: "submitted",
        txHash: `0x${"13".repeat(32)}`,
        submittedAtMs: 0,
      });
      const removalPending = yield* service.readPositionState;
      assert.equal(removalPending.position.status, "removal-pending");
    }),
  );
});

describe("swap fee evidence through the service", () => {
  const swapReceipt = (txHash: string, blockNumber: number, fee: number) => ({
    transactionHash: txHash,
    status: "0x1",
    blockNumber: "0x" + blockNumber.toString(16),
    gasUsed: "0x186a0",
    effectiveGasPrice: "0x3b9aca00",
    logs: [
      {
        address: POOL_MANAGER,
        topics: [
          topic0("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)"),
          FULL_POOL_ID,
          `0x${word("11".repeat(20))}`,
        ],
        data:
          "0x" +
          wordSigned(-2_500_000n) +
          wordSigned(1_250_000_000_000_000_000n) +
          word(2n ** 96n) +
          word(1_000_000_000n) +
          wordSigned(-196204n) +
          word(BigInt(fee)),
        blockNumber: "0x" + blockNumber.toString(16),
        transactionHash: txHash,
        logIndex: "0x1",
      },
    ],
  });

  it.effect("decodes total 500 and 3000 receipts without inventing an executed fee split", () =>
    Effect.gen(function* () {
      const fake = makeFakeChain({
        // Even blocks served the policy fee, odd blocks the baseline.
        effectiveFeeAtBlock: (block) => (block % 2 === 0 ? 500 : 3000),
      });
      const service = yield* FeePolicyService.pipe(Effect.provide(serviceLayer(fake.shape, ENV)));

      const policyTx = "0x" + "aa".repeat(32);
      const baselineTx = "0x" + "bb".repeat(32);
      fake.state.receipts.set(policyTx, swapReceipt(policyTx, BLOCK + 2, 500));
      fake.state.receipts.set(baselineTx, swapReceipt(baselineTx, BLOCK + 3, 3000));

      const policyRead = yield* service.readSwapFeeEvidence(policyTx);
      assert.equal(policyRead.status, "ok");
      if (policyRead.status === "ok") {
        const swap = policyRead.evidence.swaps[0];
        assert.ok(swap !== undefined);
        assert.equal(swap.inOurPool, true);
        assert.equal(swap.totalSwapFeeHundredthsBps, 500);
        assert.equal(swap.lpFeeHundredthsBps, null);
        assert.equal(swap.protocolFeeHundredthsBps, null);
      }
      const baselineRead = yield* service.readSwapFeeEvidence(baselineTx);
      assert.equal(baselineRead.status, "ok");
      if (baselineRead.status === "ok") {
        const swap = baselineRead.evidence.swaps[0];
        assert.ok(swap !== undefined);
        assert.equal(swap.totalSwapFeeHundredthsBps, 3000);
        assert.equal(swap.lpFeeHundredthsBps, null);
        assert.equal(swap.protocolFeeHundredthsBps, null);
      }
    }),
  );
});

describe("policy safety regressions", () => {
  it.effect("pause, unpause, pause creates distinct operations without a provider", () =>
    Effect.gen(function* () {
      const service = yield* FeePolicyService.pipe(
        Effect.provide(serviceLayer(makeFakeChain().shape, ENV)),
      );
      const first = yield* service.requestPause({ environmentId: "env-1" });
      const middle = yield* service.requestUnpause({ environmentId: "env-1" });
      const last = yield* service.requestPause({ environmentId: "env-1" });
      assert.ok(first.status === "ok" && middle.status === "ok" && last.status === "ok");
      assert.notEqual(first.record.intentId, last.record.intentId);
      assert.notEqual(first.record.idempotencyKey, last.record.idempotencyKey);
    }),
  );

  it.effect("rejects foreign evidence, wrong installed version and oversized duration", () =>
    Effect.gen(function* () {
      yield* runMigrations({});
      const store = yield* ForgeSourceStore;
      yield* seedEvidence(store, { evidenceId: PUBLISH_INPUT.evidenceId, historical: false });
      const service = yield* FeePolicyService;
      const foreign = yield* service.publishFromEvidence({
        ...PUBLISH_INPUT,
        environmentId: "other-env",
      });
      assert.ok(foreign.status === "refused");
      assert.equal(foreign.reason, "evidence-environment");
      const wrongVersion = yield* service.publishFromEvidence({
        ...PUBLISH_INPUT,
        capabilityVersion: 2,
      });
      assert.ok(wrongVersion.status === "refused");
      assert.equal(wrongVersion.reason, "evaluation-mismatch");
      const duration = yield* service.publishFromEvidence({
        ...PUBLISH_INPUT,
        policyDurationSeconds: 901,
      });
      assert.ok(duration.status === "refused");
      assert.equal(duration.reason, "invalid-duration");
      const missingIdentity = yield* service.publishFromEvidence({
        environmentId: "env-1",
        evidenceId: PUBLISH_INPUT.evidenceId,
        sourceEvaluationId: "eval-1",
      });
      assert.ok(missingIdentity.status === "refused");
      assert.equal(missingIdentity.reason, "installed-evaluation-required");
    }).pipe(Effect.provide(serviceLayer(makeFakeChain().shape, ENV))),
  );
});

it.effect("retains policy, pending work and liquidity beyond presentation history limits", () => {
  const fake = makeFakeChain();
  return Effect.gen(function* () {
    yield* runMigrations({});
    const source = yield* ForgeSourceStore;
    yield* seedEvidence(source, { evidenceId: PUBLISH_INPUT.evidenceId, historical: false });
    const service = yield* FeePolicyService;
    const ledger = yield* ForgeIntentLedger;
    const publish = yield* service.publishFromEvidence(PUBLISH_INPUT);
    assert.ok(publish.status === "ok");
    const add = yield* service.requestAddLiquidity({
      environmentId: "env-1",
      tickLower: -60,
      tickUpper: 60,
      liquidity: "1000",
      ownerAddress: MINT_OWNER,
      deposits: [{ token: C0, amountRaw: "1000" }],
    });
    assert.ok(add.status === "ok");
    const txHash = `0x${"51".repeat(32)}`;
    yield* ledger.upsert({ ...add.record, status: "submitted", txHash, submittedAtMs: 0 });
    confirmModifyLiquidity(fake, txHash, { tickLower: -60, tickUpper: 60, liquidityDelta: 1000n });
    const pause = yield* service.requestPause({ environmentId: "env-1" });
    assert.ok(pause.status === "ok");
    for (let i = 0; i < 110; i++) {
      yield* ledger.upsert({
        ...pause.record,
        intentId: `filler-${i}`,
        idempotencyKey: `filler-${i}`,
      });
    }
    assert.equal((yield* service.readPolicyState).local.policy?.policyId, publish.record.intentId);
    const reconciled = yield* service.reconcile();
    assert.equal(
      reconciled.find((record) => record.intentId === add.record.intentId)?.status,
      "confirmed",
    );
    const position = yield* service.readPositionState;
    assert.equal(position.position.liquidity, "1000");
    assert.equal(position.position.status, "confirmed");

    // Duplicate receipt references must not count a chain log twice.
    const settled = yield* ledger.find(add.record.intentId);
    assert.ok(settled !== null);
    yield* ledger.upsert({
      ...settled,
      intentId: "duplicate-receipt",
      idempotencyKey: "duplicate-receipt",
    });
    assert.equal((yield* service.readPositionState).position.liquidity, "1000");

    // A newer record for another target is not local state for this target.
    yield* ledger.upsert({
      ...publish.record,
      intentId: "foreign-target",
      idempotencyKey: "foreign-target",
      environmentId: "other-env",
      params: { ...publish.record.params, targetFingerprint: "another-target" },
    });
    assert.equal((yield* service.readPolicyState).local.policy?.policyId, publish.record.intentId);
    // The unscoped API must refuse mixed environments instead of choosing one.
    yield* ledger.upsert({
      ...publish.record,
      intentId: "foreign-env",
      idempotencyKey: "foreign-env",
      environmentId: "other-env",
    });
    const ambiguous = yield* service.readPolicyState;
    assert.equal(ambiguous.status, "unavailable");
    assert.equal(ambiguous.local.policy, null);
  }).pipe(Effect.provide(serviceLayer(fake.shape, ENV)));
});

it.effect("does not merge separate receipt ranges or use reverted proposal ticks", () => {
  const fake = makeFakeChain();
  return Effect.gen(function* () {
    const service = yield* FeePolicyService;
    const ledger = yield* ForgeIntentLedger;
    const add = yield* service.requestAddLiquidity({
      environmentId: "env-1",
      tickLower: -60,
      tickUpper: 60,
      liquidity: "1000",
      ownerAddress: MINT_OWNER,
      deposits: [{ token: C0, amountRaw: "1000" }],
    });
    assert.ok(add.status === "ok");
    const txHash = `0x${"61".repeat(32)}`;
    yield* ledger.upsert({ ...add.record, status: "submitted", txHash, submittedAtMs: 0 });
    confirmModifyLiquidity(fake, txHash, { tickLower: -60, tickUpper: 60, liquidityDelta: 1000n });
    yield* service.reconcile(add.record.intentId);
    const other = yield* service.requestAddLiquidity({
      environmentId: "env-1",
      tickLower: 120,
      tickUpper: 180,
      liquidity: "2000",
      ownerAddress: MINT_OWNER,
      deposits: [{ token: C0, amountRaw: "500" }],
    });
    assert.ok(other.status === "ok");
    yield* ledger.upsert({ ...other.record, status: "reverted" });
    const existing = yield* service.readPositionState;
    assert.equal(existing.position.tickLower, -60);
    assert.equal(existing.position.liquidity, "1000");
    const secondHash = `0x${"62".repeat(32)}`;
    yield* ledger.upsert({
      ...other.record,
      status: "submitted",
      txHash: secondHash,
      submittedAtMs: 0,
    });
    confirmModifyLiquidity(fake, secondHash, {
      tickLower: 120,
      tickUpper: 180,
      liquidityDelta: 2000n,
    });
    yield* service.reconcile(other.record.intentId);
    const multi = yield* service.readPositionState;
    assert.equal(multi.status, "unavailable");
    assert.equal(multi.position.liquidity, null);
    assert.include(multi.reason ?? "", "multiple");
  }).pipe(Effect.provide(serviceLayer(fake.shape, ENV)));
});
