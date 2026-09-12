/**
 * What the Sepolia adapter claims, held to its contract.
 *
 * Every RPC response in here is a fixture served by a fake transport —
 * fixtures belong to tests, and the production path has no fixture fallback.
 *
 * The calldata vectors are HAND-DERIVED from the ABI, not echoes of the
 * encoder:
 *
 * - Selectors are frozen literals equal to the first 4 bytes of
 *   keccak256(ASCII of the canonical signature). `pause()` = 0x8456cb59 and
 *   `unpause()` = 0x3f4ba83a are the publicly known OpenZeppelin Pausable
 *   selectors (independent of viem); the rest were computed once from the
 *   noble keccak implementation and frozen.
 * - Argument words are composed in the test from explicit padding arithmetic
 *   (hex padStart to 32 bytes, two's-complement BigInt for negatives),
 *   per the ABI static-encoding rules.
 *
 * @module UniswapTestnetAdapter.test
 */
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { MigrationError } from "effect/unstable/sql/Migrator";
import {
  decodeAbiParameters,
  decodeFunctionData,
  keccak256,
  parseAbiParameters,
  toBytes,
  type Hex,
} from "viem";

import {
  ForgeTestnetConfig,
  ForgeIntentLedgerInMemory,
  ForgeIntentLedger,
  ForgeGrantGuard,
  makeInMemoryForgeIntentLedger,
  ForgeSepoliaTransport,
  SignedTransactionBroadcaster,
  SignedTransactionBroadcasterUnavailable,
  UniswapTestnetAdapter,
  UniswapTestnetAdapterLive,
  forgeBindingId,
  forgeFullPoolId,
  type ForgeIntentRecord,
  type ForgeSepoliaRpcTransportShape,
  type SignedTransactionBroadcasterShape,
} from "./UniswapTestnetAdapter.ts";
import { ForgeGrantGuardLive, ForgeIntentLedgerSqliteLive } from "./ForgeIntentLedgerSqlite.ts";
import { positionManagerAbi } from "./PeripheryAbi.ts";
import {
  resolveForgeTestnetSettings,
  SEPOLIA_V4_ADDRESSES,
  SEPOLIA_CHAIN_ID,
  type ForgeTestnetSettings,
} from "./SepoliaTarget.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

// ---------------------------------------------------------------------------
// Fixture addresses and env
// ---------------------------------------------------------------------------

/** A beforeSwap-flagged hook address (low 14 bits = 0x80), as CREATE2 would give. */
const HOOK = `0x${"ab".repeat(19)}80`;
const C0 = `0x${"11".repeat(20)}`;
const C1 = `0x${"22".repeat(20)}`;
const TICK_SPACING = 60;
const BINDING = forgeBindingId({
  currency0: C0,
  currency1: C1,
  fee: 0x800000,
  tickSpacing: TICK_SPACING,
});
const FULL_POOL_ID = forgeFullPoolId({
  currency0: C0,
  currency1: C1,
  fee: 0x800000,
  tickSpacing: TICK_SPACING,
  hookAddress: HOOK,
});
const ZERO_32 = `0x${"0".repeat(64)}`;

const BLOCK = 7_500_000;
const BLOCK_TS = 1_775_700_000;
const EVIDENCE_DIGEST = `0x${"cd".repeat(32)}`;

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

// ---------------------------------------------------------------------------
// Hand-derived ABI vectors
// ---------------------------------------------------------------------------

/**
 * Selector = keccak256(canonical signature)[0..4]. The literals below are
 * frozen; `selectorOf` recomputes one live from the noble keccak primitive
 * so a viem selector regression cannot hide behind a stale literal.
 */
const selectorOf = (signature: string): string => keccak256(toBytes(signature)).slice(0, 10);

const SEL = {
  pause: "0x8456cb59", // OpenZeppelin Pausable.pause — publicly known
  unpause: "0x3f4ba83a", // OpenZeppelin Pausable.unpause — publicly known
  publishPolicy: "0xb9d299c3",
  revokePolicy: "0xeb670690",
  initialize: "0x6276cbbe",
  modifyLiquidities: "0xdd46508f",
  swap: "0x2229d0b4",
} as const;

for (const [name, literal] of Object.entries(SEL)) {
  const signature = {
    pause: "pause()",
    unpause: "unpause()",
    publishPolicy: "publishPolicy(bytes32,uint256,uint256,bytes32)",
    revokePolicy: "revokePolicy(bytes32)",
    initialize: "initialize((address,address,uint24,int24,address),uint160)",
    modifyLiquidities: "modifyLiquidities(bytes,uint256)",
    swap: "swap((address,address,uint24,int24,address),(bool,int256,uint160),(bool,bool),bytes)",
  }[name as keyof typeof SEL];
  assert.equal(selectorOf(signature), literal, `frozen selector literal for ${name}`);
}

/** One left-padded 32-byte word from a hex string (no 0x) or BigInt. */
const word = (value: string | bigint): string =>
  (typeof value === "bigint" ? value.toString(16) : value.replace(/^0x/, "")).padStart(64, "0");

/** int256 two's complement of a negative BigInt. */
const wordSigned = (value: bigint): string =>
  (value < 0n ? 2n ** 256n + value : value).toString(16).padStart(64, "0");

// Test-side declarations of the DEPLOYED PositionManager param tuples
// (sepolia.etherscan.io verified source for 0x429ba7...09b4, read
// 2026-09-12) — deliberately independent of the adapter's own encoders so a
// regression in PeripheryAbi cannot echo itself green.
const TEST_POOL_KEY =
  "(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)";
const TEST_MINT_PARAMS = parseAbiParameters(
  `${TEST_POOL_KEY} poolKey, int24 tickLower, int24 tickUpper, uint256 liquidity, uint128 amount0Max, uint128 amount1Max, address owner, bytes hookData`,
);
const TEST_INCREASE_PARAMS = parseAbiParameters(
  "uint256 tokenId, uint256 liquidity, uint128 amount0Max, uint128 amount1Max, bytes hookData",
);
const TEST_DECREASE_PARAMS = parseAbiParameters(
  "uint256 tokenId, uint256 liquidity, uint128 amount0Min, uint128 amount1Min, bytes hookData",
);

/** Decode modifyLiquidities calldata back into actions, params and deadline. */
const decodeModifyLiquidities = (
  data: Hex,
): { readonly actions: Hex; readonly params: ReadonlyArray<Hex>; readonly deadline: bigint } => {
  const outer = decodeFunctionData({ abi: positionManagerAbi, data });
  assert.equal(outer.functionName, "modifyLiquidities");
  const [unlockData, deadline] = outer.args as [Hex, bigint];
  const [actions, params] = decodeAbiParameters(
    parseAbiParameters("bytes actions, bytes[] params"),
    unlockData,
  );
  return { actions, params, deadline };
};

// ---------------------------------------------------------------------------
// Fake Sepolia chain
// ---------------------------------------------------------------------------

interface FakeHookState {
  revision: bigint;
  expiry: bigint;
  evidenceDigest: Hex;
  policyActive: boolean;
  paused: boolean;
  effectiveFee: number;
  owner: Hex;
  operator: Hex;
}

interface FakeChainOptions {
  readonly chainIdHex?: string;
  blockNumber?: number;
  blockTimestamp?: number;
  hook?: FakeHookState;
  /** Called for eth_call views pinned to a past block; return "fail" to simulate a non-archive node. */
  effectiveFeeAtBlock?: (block: number) => number | "fail";
  /** Bump blockNumber/timestamp by this much on EVERY eth_getBlockByNumber. */
  advancePerBlockRead?: number;
  failBlockReads?: boolean;
  logs?: ReadonlyArray<Record<string, unknown>>;
}

const makeFakeChain = (options: FakeChainOptions) => {
  const state = {
    blockNumber: options.blockNumber ?? BLOCK,
    blockTimestamp: options.blockTimestamp ?? BLOCK_TS,
    receipts: new Map<string, Record<string, unknown>>(),
    txs: new Map<string, Record<string, unknown>>(),
    calls: Array<{ method: string; params: ReadonlyArray<unknown> }>(),
  };
  const hook: FakeHookState = options.hook ?? {
    revision: 0n,
    expiry: 0n,
    evidenceDigest: ZERO_32 as Hex,
    policyActive: false,
    paused: false,
    effectiveFee: 3000,
    owner: `0x${"aa".repeat(20)}` as Hex,
    operator: `0x${"77".repeat(20)}` as Hex,
  };

  const selectorRoutes: Record<string, (params: ReadonlyArray<unknown>) => string> = {
    [SEL.pause]: () => "",
    [SEL.unpause]: () => "",
    [selectorOf("policyActive()")]: () => word(hook.policyActive ? 1n : 0n),
    [selectorOf("paused()")]: () => word(hook.paused ? 1n : 0n),
    [selectorOf("owner()")]: () => word(hook.owner.slice(2)),
    [selectorOf("operator()")]: () => word(hook.operator.slice(2)),
    [selectorOf("boundPoolId()")]: () => BINDING.slice(2),
    [selectorOf("BASELINE_FEE()")]: () => word(3000n),
    [selectorOf("POLICY_FEE()")]: () => word(500n),
    [selectorOf("getPolicy()")]: () =>
      word(hook.revision) + word(hook.expiry) + word(hook.evidenceDigest.slice(2)),
    [selectorOf("effectiveFee(bytes32)")]: () => word(BigInt(hook.effectiveFee)),
    [selectorOf("beforeSwapFeeOverride(bytes32)")]: () =>
      hook.effectiveFee === 0 ? word(0n) : word(0x400000n | BigInt(hook.effectiveFee)),
  };

  const shape: ForgeSepoliaRpcTransportShape = {
    request: (method, params) =>
      Effect.gen(function* () {
        state.calls.push({ method, params });
        switch (method) {
          case "eth_chainId":
            return options.chainIdHex ?? "0xaa36a7";
          case "eth_getBlockByNumber": {
            if (options.failBlockReads === true) return yield* Effect.fail("block endpoint down");
            const advance = options.advancePerBlockRead ?? 0;
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
          case "eth_call": {
            const call = params[0] as { to: string; data: string };
            const block = params[1];
            const selector = call.data.slice(0, 10);
            // A pinned historical read (a bare hex block string, not
            // "latest") goes through the node-behavior hook so tests can
            // simulate a non-archive node failing on old state.
            if (
              selector === selectorOf("effectiveFee(bytes32)") &&
              typeof block === "string" &&
              block !== "latest" &&
              options.effectiveFeeAtBlock !== undefined
            ) {
              const served = options.effectiveFeeAtBlock(Number(block));
              if (served === "fail") return yield* Effect.fail("missing trie node");
              return "0x" + word(BigInt(served));
            }
            const route = selectorRoutes[selector];
            if (route === undefined)
              return yield* Effect.fail(`no fake route for selector ${selector}`);
            return "0x" + route(params);
          }
          case "eth_getLogs":
            return [...(options.logs ?? [])];
          case "eth_getTransactionReceipt": {
            const hash = params[0] as string;
            return state.receipts.get(hash) ?? null;
          }
          case "eth_getTransactionByHash": {
            const hash = params[0] as string;
            return state.txs.get(hash) ?? null;
          }
          default:
            return yield* Effect.fail(`fake chain does not serve ${method}`);
        }
      }),
  };
  return { shape, state, hook };
};

/** A broadcaster that records everything and hands back deterministic hashes. */
const makeFakeBroadcaster = () => {
  const sent: Array<{ to: string; data: string; chainId: number; idempotencyKey: string }> = [];
  let next = 1;
  const shape: SignedTransactionBroadcasterShape = {
    broadcast: ({ transaction, intent }) =>
      Effect.sync(() => {
        sent.push({
          to: transaction.to,
          data: transaction.data,
          chainId: transaction.chainId,
          idempotencyKey: intent.idempotencyKey,
        });
        const txHash = "0x" + (next++).toString(16).padStart(64, "0");
        return { txHash };
      }),
  };
  return { shape, sent };
};

// ---------------------------------------------------------------------------
// Log/receipt fixtures, hand-composed
// ---------------------------------------------------------------------------

const topic0 = (signature: string): string => keccak256(toBytes(signature));

/** PolicyPublished log: topics [topic0, poolId], data = revision|expiry|digest. */
const policyPublishedLog = (input: {
  blockNumber: number;
  txHash: string;
  logIndex?: number;
  revision?: bigint;
  expiry?: bigint;
  digest?: string;
}): Record<string, unknown> => ({
  address: HOOK,
  topics: [topic0("PolicyPublished(bytes32,uint256,uint256,bytes32)"), BINDING],
  data:
    "0x" +
    word(input.revision ?? 4n) +
    word(input.expiry ?? BigInt(BLOCK_TS + 900)) +
    word((input.digest ?? EVIDENCE_DIGEST).slice(2)),
  blockNumber: "0x" + input.blockNumber.toString(16),
  transactionHash: input.txHash,
  logIndex: "0x" + (input.logIndex ?? 0).toString(16),
});

/** PoolManager Swap log: topics [topic0, poolId, sender], data = 6 words. */
const swapLog = (input: {
  blockNumber: number;
  txHash: string;
  poolId: string;
  amount0?: bigint;
  amount1?: bigint;
  fee: number;
  logIndex?: number;
}): Record<string, unknown> => ({
  address: SEPOLIA_V4_ADDRESSES.poolManager,
  topics: [
    topic0("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)"),
    input.poolId,
    `0x${word("11".repeat(20))}`,
  ],
  data:
    "0x" +
    wordSigned(input.amount0 ?? -1_000_000n) +
    wordSigned(input.amount1 ?? 1_000_000n) +
    word(2n ** 96n) +
    word(1_000_000_000n) +
    wordSigned(-196204n) +
    word(BigInt(input.fee)),
  blockNumber: "0x" + input.blockNumber.toString(16),
  transactionHash: input.txHash,
  logIndex: "0x" + (input.logIndex ?? 1).toString(16),
});

const receiptOf = (input: {
  txHash: string;
  status: 0 | 1;
  blockNumber: number;
  gasUsed?: bigint;
  gasPrice?: bigint;
  logs?: ReadonlyArray<Record<string, unknown>>;
}): Record<string, unknown> => ({
  transactionHash: input.txHash,
  status: input.status === 1 ? "0x1" : "0x0",
  blockNumber: "0x" + input.blockNumber.toString(16),
  gasUsed: "0x" + (input.gasUsed ?? 100_000n).toString(16),
  effectiveGasPrice: "0x" + (input.gasPrice ?? 1_000_000_000n).toString(16),
  logs: [...(input.logs ?? [])],
});

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

const configLayer = (env: Record<string, string | undefined>) =>
  Layer.succeed(ForgeTestnetConfig, {
    resolve: Effect.sync((): ForgeTestnetSettings => resolveForgeTestnetSettings(env)),
  });

// A fresh migrated in-memory SQLite per guard-layer build — the real engine
// behind the immutable approved-grant table, only the database is disposable.
// The migrated client is the layer's OUTPUT (not a discarded side effect), so
// the database's scope is exactly the consumer layer's lifetime: a whole-test
// provide keeps it open for every broadcast the test makes. The chain is
// constructed inside the function on purpose — a module-level const would be
// one Effect-memoized layer shared (and closed) by whichever test built it
// first.
type TestSqliteLayerError = SqlError | MigrationError;

const migratedMemorySqlite = (): Layer.Layer<SqlClient.SqlClient, TestSqliteLayerError> =>
  Layer.effect(
    SqlClient.SqlClient,
    Effect.gen(function* () {
      yield* runMigrations({});
      return yield* SqlClient.SqlClient;
    }),
  ).pipe(Layer.provide(NodeSqliteClient.layerMemory()));

const freshGuardSqlite = (): Layer.Layer<ForgeGrantGuard, TestSqliteLayerError> =>
  ForgeGrantGuardLive.pipe(Layer.provide(migratedMemorySqlite()));

/** A fresh migrated memory client layer (the durable-ledger tests' provider). */
const migratedSqliteLayer = migratedMemorySqlite;

const adapterLayer = (
  transport: ForgeSepoliaRpcTransportShape,
  env: Record<string, string | undefined>,
  broadcaster: Layer.Layer<SignedTransactionBroadcaster> = SignedTransactionBroadcasterUnavailable,
  ledgerLayer: Layer.Layer<ForgeIntentLedger, TestSqliteLayerError> = admittedTestLedger,
  guardLayer: Layer.Layer<ForgeGrantGuard, TestSqliteLayerError> = freshGuardSqlite(),
) =>
  UniswapTestnetAdapterLive.pipe(
    Layer.provide(configLayer(env)),
    Layer.provide(Layer.succeed(ForgeSepoliaTransport, ForgeSepoliaTransport.of(transport))),
    Layer.provideMerge(ledgerLayer),
    Layer.provideMerge(broadcaster),
    Layer.provideMerge(guardLayer),
  );

// Test-only simulation of durable admission. It proves service state transitions,
// not actual persistence or gas enforcement. Production has no implementation.
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

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

describe("resolveForgeTestnetSettings", () => {
  it("configures the target and names the missing grant variables", () => {
    const settings = resolveForgeTestnetSettings(TARGET_ENV);
    assert.equal(settings.configured, true);
    assert.equal(settings.target?.hookAddress, HOOK);
    assert.equal(settings.target?.poolKey.fee, 0x800000);
    assert.equal(settings.grant, undefined);
    for (const name of ["T3_FORGE_GRANT_ID", "T3_FORGE_GRANT_TOKEN0_CAP_RAW"]) {
      assert.include(settings.grantMissingReason ?? "", name);
    }
  });

  it("resolves an approved grant bound to the configured hook", () => {
    const settings = resolveForgeTestnetSettings(ENV);
    const grant = settings.grant;
    assert.ok(grant !== undefined);
    assert.equal(grant.hookAddress, HOOK);
    assert.equal(grant.chainId, SEPOLIA_CHAIN_ID);
    assert.deepEqual(grant.tokenCaps, [
      { token: C0, maxAmountRaw: "10000000000000000000000" },
      { token: C1, maxAmountRaw: "10000000000" },
    ]);
  });

  it("refuses unsorted currencies and non-https endpoints", () => {
    const swapped = resolveForgeTestnetSettings({
      ...TARGET_ENV,
      T3_FORGE_SEPOLIA_CURRENCY0: C1,
      T3_FORGE_SEPOLIA_CURRENCY1: C0,
    });
    assert.equal(swapped.configured, false);
    assert.include(swapped.reason ?? "", "sorted");
    const http = resolveForgeTestnetSettings({
      ...TARGET_ENV,
      T3_FORGE_SEPOLIA_RPC_URL: "http://localhost:8545",
    });
    assert.equal(http.configured, false);
    assert.include(http.reason ?? "", "https");
  });
});

// ---------------------------------------------------------------------------
// Calldata vectors — hand-derived
// ---------------------------------------------------------------------------

describe("intent calldata vectors", () => {
  const keyWords =
    word(C0.slice(2)) +
    word(C1.slice(2)) +
    word(0x800000n) +
    word(BigInt(TICK_SPACING)) +
    word(HOOK.slice(2));

  it.effect("pause/unpause encode to the bare selectors", () => {
    const fake = makeFakeChain({});
    return Effect.gen(function* () {
      const adapter = yield* UniswapTestnetAdapter;
      const pause = yield* adapter.buildIntent({ kind: "pause", environmentId: "env-1" });
      assert.equal(pause.unsigned.data, "0x8456cb59");
      assert.equal(pause.unsigned.to, HOOK);
      assert.equal(pause.unsigned.valueWei, "0");
      const unpause = yield* adapter.buildIntent({ kind: "unpause", environmentId: "env-1" });
      assert.equal(unpause.unsigned.data, "0x3f4ba83a");
    }).pipe(Effect.provide(adapterLayer(fake.shape, ENV)));
  });

  it.effect("publishPolicy encodes selector + four hand-built words", () => {
    const fake = makeFakeChain({});
    return Effect.gen(function* () {
      const adapter = yield* UniswapTestnetAdapter;
      const record = yield* adapter.buildIntent({
        kind: "publish-policy",
        environmentId: "env-1",
        bindingId: BINDING,
        revision: "7",
        expiryUnix: 1_775_700_900,
        evidenceDigest: EVIDENCE_DIGEST,
      });
      // selector + bindingId word + revision word + expiry word + digest word
      const expected =
        SEL.publishPolicy +
        word(BINDING.slice(2)) +
        word(7n) +
        word(1_775_700_900n) +
        word(EVIDENCE_DIGEST.slice(2));
      assert.equal(record.unsigned.data, expected);
      assert.equal(record.params["revision"], "7");
      assert.equal(record.params["expiryUnix"], "1775700900");
    }).pipe(Effect.provide(adapterLayer(fake.shape, ENV)));
  });

  it.effect("revokePolicy encodes selector + binding word", () => {
    const fake = makeFakeChain({});
    return Effect.gen(function* () {
      const adapter = yield* UniswapTestnetAdapter;
      const record = yield* adapter.buildIntent({
        kind: "revoke-policy",
        environmentId: "env-1",
        bindingId: BINDING,
      });
      assert.equal(record.unsigned.data, SEL.revokePolicy + word(BINDING.slice(2)));
    }).pipe(Effect.provide(adapterLayer(fake.shape, ENV)));
  });

  it.effect("initialize encodes the pool key inline plus sqrtPriceX96", () => {
    const fake = makeFakeChain({});
    return Effect.gen(function* () {
      const adapter = yield* UniswapTestnetAdapter;
      const sqrtPrice = 2n ** 96n;
      const record = yield* adapter.buildIntent({
        kind: "initialize-pool",
        environmentId: "env-1",
        sqrtPriceX96: sqrtPrice.toString(10),
      });
      // Static tuple args encode inline (no offset word): 5 key words + 1.
      assert.equal(record.unsigned.data, SEL.initialize + keyWords + word(sqrtPrice));
      assert.equal(record.unsigned.to, SEPOLIA_V4_ADDRESSES.poolManager.toLowerCase());
    }).pipe(Effect.provide(adapterLayer(fake.shape, ENV)));
  });

  it.effect(
    "liquidity encodes the deployed PositionManager modifyLiquidities shape (MINT/INCREASE/DECREASE)",
    () => {
      const fake = makeFakeChain({});
      return Effect.gen(function* () {
        const adapter = yield* UniswapTestnetAdapter;
        const owner = `0x${"0e".repeat(20)}`;

        // MINT a new position: no tokenId, owner named, maxima from deposits.
        const mint = yield* adapter.buildIntent({
          kind: "add-liquidity",
          environmentId: "env-1",
          tickLower: -60,
          tickUpper: 60,
          liquidity: "1000000000000000000",
          deposits: [
            { token: C0, amountRaw: "1000" },
            { token: C1, amountRaw: "2000" },
          ],
          ownerAddress: owner,
        });
        assert.equal(mint.unsigned.to, SEPOLIA_V4_ADDRESSES.positionManager.toLowerCase());
        const minted = decodeModifyLiquidities(mint.unsigned.data);
        assert.equal(minted.actions, "0x02"); // MINT_POSITION
        const mintParams = decodeAbiParameters(TEST_MINT_PARAMS, minted.params[0]!);
        const [key, tickLower, tickUpper, liquidity, amount0Max, amount1Max, mintOwner, hookData] =
          mintParams;
        assert.equal(key.currency0, C0);
        assert.equal(key.currency1, C1);
        assert.equal(key.fee, 0x800000);
        assert.equal(key.tickSpacing, TICK_SPACING);
        assert.equal((key.hooks as string).toLowerCase(), HOOK);
        assert.equal(tickLower, -60);
        assert.equal(tickUpper, 60);
        assert.equal(liquidity, 1_000_000_000_000_000_000n);
        // The on-chain pull ceilings equal the declared deposits: the
        // encoded maxima, not self-reported metadata, bind the grant.
        assert.equal(amount0Max, 1000n);
        assert.equal(amount1Max, 2000n);
        assert.equal((mintOwner as string).toLowerCase(), owner);
        assert.equal(hookData, "0x");
        // The deadline is bounded: the record's own build time plus the
        // one-hour window (the record's clock, not the wall clock — the test
        // runtime may use a controlled clock).
        const builtSec = BigInt(Math.floor(mint.createdAtMs / 1000));
        assert.ok(minted.deadline > builtSec && minted.deadline <= builtSec + 3600n);

        // INCREASE an existing tokenId; an undeclared leg bounds to zero.
        const increase = yield* adapter.buildIntent({
          kind: "add-liquidity",
          environmentId: "env-1",
          tickLower: -60,
          tickUpper: 60,
          liquidity: "500",
          deposits: [{ token: C0, amountRaw: "77" }],
          tokenId: "7",
        });
        const increased = decodeModifyLiquidities(increase.unsigned.data);
        assert.equal(increased.actions, "0x00"); // INCREASE_LIQUIDITY
        const [tokenId, incLiquidity, inc0Max, inc1Max] = decodeAbiParameters(
          TEST_INCREASE_PARAMS,
          increased.params[0]!,
        );
        assert.equal(tokenId, 7n);
        assert.equal(incLiquidity, 500n);
        assert.equal(inc0Max, 77n);
        assert.equal(inc1Max, 0n);

        // DECREASE an existing tokenId; minimum outputs default to 1 raw unit.
        const decrease = yield* adapter.buildIntent({
          kind: "remove-liquidity",
          environmentId: "env-1",
          tickLower: -60,
          tickUpper: 60,
          liquidity: "500",
          tokenId: "7",
        });
        const decreased = decodeModifyLiquidities(decrease.unsigned.data);
        assert.equal(decreased.actions, "0x01"); // DECREASE_LIQUIDITY
        const [decTokenId, decLiquidity, min0, min1] = decodeAbiParameters(
          TEST_DECREASE_PARAMS,
          decreased.params[0]!,
        );
        assert.equal(decTokenId, 7n);
        assert.equal(decLiquidity, 500n);
        assert.equal(min0, 1n);
        assert.equal(min1, 1n);
        // Explicit nonzero minimum outputs survive verbatim.
        const explicit = yield* adapter.buildIntent({
          kind: "remove-liquidity",
          environmentId: "env-1",
          tickLower: -60,
          tickUpper: 60,
          liquidity: "500",
          tokenId: "7",
          minAmount0Raw: "42",
          minAmount1Raw: "43",
        });
        const [, , explicitMin0, explicitMin1] = decodeAbiParameters(
          TEST_DECREASE_PARAMS,
          decodeModifyLiquidities(explicit.unsigned.data).params[0]!,
        );
        assert.equal(explicitMin0, 42n);
        assert.equal(explicitMin1, 43n);
      }).pipe(Effect.provide(adapterLayer(fake.shape, ENV)));
    },
  );

  it.effect("bounded swap encodes the explicit price limit into PoolSwapTest", () => {
    const fake = makeFakeChain({});
    return Effect.gen(function* () {
      const adapter = yield* UniswapTestnetAdapter;
      const limit = 2n ** 96n;
      const record = yield* adapter.buildIntent({
        kind: "bounded-swap",
        environmentId: "env-1",
        zeroForOne: true,
        amountSpecifiedRaw: "-2500000",
        sqrtPriceLimitX96: limit.toString(10),
        quoteAmountRaw: "2500000",
      });
      // head: 5 key + 3 swap params + 2 test settings + offset; tail: length 0.
      // offset = (5 + 3 + 2 + 1) * 32 = 352 = 0x160.
      const expected =
        SEL.swap +
        keyWords +
        word(1n) + // zeroForOne = true
        wordSigned(-2_500_000n) +
        word(limit) + // sqrtPriceLimitX96 — explicit, never a zero default
        word(0n) + // takeClaims = false
        word(0n) + // settleUsingBurn = false
        word(0x160n) +
        word(0n);
      assert.equal(record.unsigned.data, expected);
      assert.equal(record.unsigned.to, SEPOLIA_V4_ADDRESSES.swapRoute.toLowerCase());
      assert.equal(record.spend.swapQuoteAmountRaw, "2500000");
    }).pipe(Effect.provide(adapterLayer(fake.shape, ENV)));
  });

  it.effect("build is idempotent by key and refuses key reuse across kinds", () => {
    const fake = makeFakeChain({});
    return Effect.gen(function* () {
      const adapter = yield* UniswapTestnetAdapter;
      const first = yield* adapter.buildIntent({ kind: "pause", environmentId: "env-1" });
      const second = yield* adapter.buildIntent({ kind: "pause", environmentId: "env-1" });
      assert.equal(second.intentId, first.intentId);
      const conflict = yield* adapter
        .buildIntent({
          kind: "unpause",
          environmentId: "env-1",
          idempotencyKey: first.idempotencyKey,
        })
        .pipe(Effect.flip);
      assert.include(conflict.detail, "already names");
    }).pipe(Effect.provide(adapterLayer(fake.shape, ENV)));
  });

  it.effect("rejects malformed publish params and non-multiple ticks", () => {
    const fake = makeFakeChain({});
    return Effect.gen(function* () {
      const adapter = yield* UniswapTestnetAdapter;
      const badDigest = yield* adapter
        .buildIntent({
          kind: "publish-policy",
          environmentId: "env-1",
          bindingId: BINDING,
          revision: "1",
          expiryUnix: 1_775_700_900,
          evidenceDigest: "0x1234",
        })
        .pipe(Effect.flip);
      assert.equal(badDigest.reason, "invalid-params");
      const badTicks = yield* adapter
        .buildIntent({
          kind: "add-liquidity",
          environmentId: "env-1",
          tickLower: -50,
          tickUpper: 60,
          liquidity: "1000",
          deposits: [],
        })
        .pipe(Effect.flip);
      assert.include(badTicks.detail, "tick spacing");
    }).pipe(Effect.provide(adapterLayer(fake.shape, ENV)));
  });
});

// ---------------------------------------------------------------------------
// View reads
// ---------------------------------------------------------------------------

describe("view reads", () => {
  it.effect("checks the chain id and refuses any chain that is not Sepolia", () =>
    Effect.gen(function* () {
      const ok = yield* UniswapTestnetAdapter.pipe(
        Effect.provide(adapterLayer(makeFakeChain({}).shape, ENV)),
        Effect.flatMap((adapter) => adapter.checkChainId),
      );
      assert.deepEqual(ok, { ok: true, chainId: SEPOLIA_CHAIN_ID });

      const wrong = yield* UniswapTestnetAdapter.pipe(
        Effect.provide(adapterLayer(makeFakeChain({ chainIdHex: "0x1" }).shape, ENV)),
        Effect.flatMap((adapter) => adapter.checkChainId),
      );
      assert.equal(wrong.ok, false);
      assert.include(wrong.ok === false ? wrong.reason : "", "chain id");
    }),
  );

  it.effect("reads every hook view pinned to one block", () => {
    const fake = makeFakeChain({
      hook: {
        revision: 4n,
        expiry: BigInt(BLOCK_TS + 600),
        evidenceDigest: EVIDENCE_DIGEST as Hex,
        policyActive: true,
        paused: false,
        effectiveFee: 500,
        owner: `0x${"aa".repeat(20)}` as Hex,
        operator: `0x${"77".repeat(20)}` as Hex,
      },
    });
    return Effect.gen(function* () {
      const read = yield* UniswapTestnetAdapter.pipe(
        Effect.flatMap((adapter) => adapter.readHookState),
      );
      assert.equal(read.status, "ok");
      if (read.status !== "ok") return;
      const state = read.state;
      assert.equal(state.policy.revision, "4");
      assert.equal(state.policy.expiryUnix, String(BLOCK_TS + 600));
      assert.equal(state.policy.evidenceDigest, EVIDENCE_DIGEST);
      assert.equal(state.policyActive, true);
      assert.equal(state.paused, false);
      assert.equal(state.effectiveFeeHundredthsBps, 500);
      assert.equal(state.beforeSwapFeeOverrideRaw, String(0x400000 | 500));
      assert.equal(state.baselineFeeHundredthsBps, 3000);
      assert.equal(state.policyFeeHundredthsBps, 500);
      assert.equal(state.asOfBlockNumber, BLOCK);
      assert.equal(state.boundPoolId, BINDING);
      // Every eth_call was pinned to the same block (bare hex on the wire).
      const pinned = fake.state.calls
        .filter((call) => call.method === "eth_call")
        .map((call) => call.params[1]);
      assert.ok(pinned.length >= 8);
      for (const block of pinned) {
        assert.equal(block, "0x" + BLOCK.toString(16));
      }
    }).pipe(Effect.provide(adapterLayer(fake.shape, ENV)));
  });

  it.effect("decodes policy events sorted by block and log index", () => {
    const fake = makeFakeChain({
      logs: [
        policyPublishedLog({
          blockNumber: BLOCK + 2,
          txHash: "0x" + "cc".repeat(32),
          logIndex: 0,
        }),
        {
          address: HOOK,
          topics: [topic0("Paused()")],
          data: "0x",
          blockNumber: "0x" + (BLOCK + 3).toString(16),
          transactionHash: "0x" + "dd".repeat(32),
          logIndex: "0x0",
        },
      ],
    });
    return Effect.gen(function* () {
      const read = yield* UniswapTestnetAdapter.pipe(
        Effect.flatMap((adapter) =>
          adapter.getPolicyEvents({ fromBlock: BLOCK, toBlock: BLOCK + 10 }),
        ),
      );
      assert.equal(read.status, "ok");
      if (read.status !== "ok") return;
      assert.deepEqual(
        read.events.map((event) => event.kind),
        ["PolicyPublished", "Paused"],
      );
      const published = read.events[0];
      assert.ok(published?.kind === "PolicyPublished");
      assert.equal(published.revision, "4");
      assert.equal(published.poolId, BINDING);
      assert.equal(published.evidenceDigest, EVIDENCE_DIGEST);
    }).pipe(Effect.provide(adapterLayer(fake.shape, ENV)));
  });
});

// ---------------------------------------------------------------------------
// Transaction state machine
// ---------------------------------------------------------------------------

describe("transaction state machine", () => {
  const TX = "0x" + "ee".repeat(32);

  it.effect(
    "submitted while known to the node, unknown after the bounded timeout or when not found",
    () => {
      const fake = makeFakeChain({});
      return Effect.gen(function* () {
        fake.state.txs.set(TX, { hash: TX });
        const adapter = yield* UniswapTestnetAdapter;
        const pending = yield* adapter.resolveTransaction({
          txHash: TX,
          submittedAtMs: 1_000_000,
          nowMs: 1_000_000 + 10_000,
          timeoutMs: 300_000,
        });
        assert.deepEqual(pending, { state: "submitted", detail: "pending-in-mempool" });

        const timeout = yield* adapter.resolveTransaction({
          txHash: TX,
          submittedAtMs: 1_000_000,
          nowMs: 1_000_000 + 300_001,
          timeoutMs: 300_000,
        });
        assert.deepEqual(timeout, { state: "unknown", detail: "timeout-no-receipt" });

        fake.state.txs.delete(TX);
        const notFound = yield* adapter.resolveTransaction({
          txHash: TX,
          submittedAtMs: 1_000_000,
          nowMs: 1_000_000 + 1,
          timeoutMs: 300_000,
        });
        assert.deepEqual(notFound, { state: "unknown", detail: "tx-not-found" });
      }).pipe(Effect.provide(adapterLayer(fake.shape, ENV)));
    },
  );

  it.effect("settles confirmed and reverted receipts with exact gas cost", () => {
    const fake = makeFakeChain({});
    return Effect.gen(function* () {
      fake.state.receipts.set(
        TX,
        receiptOf({
          txHash: TX,
          status: 1,
          blockNumber: BLOCK + 1,
          gasUsed: 150_000n,
          gasPrice: 2_000_000_000n,
          logs: [policyPublishedLog({ blockNumber: BLOCK + 1, txHash: TX })],
        }),
      );
      const adapter = yield* UniswapTestnetAdapter;
      const confirmed = yield* adapter.resolveTransaction({
        txHash: TX,
        submittedAtMs: 0,
        nowMs: 1,
        timeoutMs: 300_000,
      });
      assert.equal(confirmed.state, "confirmed");
      if (confirmed.state !== "confirmed") return;
      assert.equal(confirmed.receipt.gasCostWei, (150_000n * 2_000_000_000n).toString(10));
      assert.equal(confirmed.receipt.hookEvents.length, 1);
      assert.equal(confirmed.receipt.hookEvents[0]?.kind, "PolicyPublished");

      const REVERT_TX = "0x" + "ff".repeat(32);
      fake.state.receipts.set(
        REVERT_TX,
        receiptOf({ txHash: REVERT_TX, status: 0, blockNumber: BLOCK + 2 }),
      );
      const reverted = yield* adapter.resolveTransaction({
        txHash: REVERT_TX,
        submittedAtMs: 0,
        nowMs: 1,
        timeoutMs: 300_000,
      });
      assert.equal(reverted.state, "reverted");
    }).pipe(Effect.provide(adapterLayer(fake.shape, ENV)));
  });
});

// ---------------------------------------------------------------------------
// The grant gate and reconciliation
// ---------------------------------------------------------------------------

describe("broadcast grant gate", () => {
  it.effect("refuses with a named reason when there is no grant, and records it", () => {
    const fake = makeFakeChain({});
    const broadcaster = makeFakeBroadcaster();
    return Effect.gen(function* () {
      const adapter = yield* UniswapTestnetAdapter;
      const intent = yield* adapter.buildIntent({ kind: "pause", environmentId: "env-1" });
      const refusal = yield* adapter.broadcastIntent({ intent }).pipe(Effect.flip);
      assert.ok(typeof refusal !== "string");
      assert.equal(refusal.reason, "grant-missing");
      assert.include(refusal.detail, "T3_FORGE_GRANT_ID");
      assert.equal(broadcaster.sent.length, 0);
      // The refusal is durable on the ledger record.
      const stored = yield* adapter.buildIntent({ kind: "pause", environmentId: "env-1" });
      assert.equal(stored.lastRefusal?.reason, "grant-missing");
    }).pipe(
      Effect.provide(
        adapterLayer(
          fake.shape,
          TARGET_ENV,
          Layer.succeed(SignedTransactionBroadcaster, broadcaster.shape),
        ),
      ),
    );
  });

  it.effect("refuses when the grant has lapsed by chain time", () => {
    const expired = {
      ...ENV,
      T3_FORGE_GRANT_EXPIRES_AT_UNIX: String(BLOCK_TS), // equal means lapsed
    };
    const fake = makeFakeChain({});
    const broadcaster = makeFakeBroadcaster();
    return Effect.gen(function* () {
      const adapter = yield* UniswapTestnetAdapter;
      const intent = yield* adapter.buildIntent({ kind: "pause", environmentId: "env-1" });
      const refusal = yield* adapter.broadcastIntent({ intent }).pipe(Effect.flip);
      assert.ok(typeof refusal !== "string");
      assert.equal(refusal.reason, "grant-expired");
      assert.equal(broadcaster.sent.length, 0);
    }).pipe(
      Effect.provide(
        adapterLayer(
          fake.shape,
          expired,
          Layer.succeed(SignedTransactionBroadcaster, broadcaster.shape),
        ),
      ),
    );
  });

  it.effect("refuses when chain time cannot be read (fail closed)", () => {
    const fake = makeFakeChain({ failBlockReads: true });
    const broadcaster = makeFakeBroadcaster();
    return Effect.gen(function* () {
      const adapter = yield* UniswapTestnetAdapter;
      const intent = yield* adapter.buildIntent({ kind: "pause", environmentId: "env-1" });
      const refusal = yield* adapter.broadcastIntent({ intent }).pipe(Effect.flip);
      assert.ok(typeof refusal !== "string");
      assert.equal(refusal.reason, "chain-time-unavailable");
      assert.equal(broadcaster.sent.length, 0);
    }).pipe(
      Effect.provide(
        adapterLayer(
          fake.shape,
          ENV,
          Layer.succeed(SignedTransactionBroadcaster, broadcaster.shape),
        ),
      ),
    );
  });

  it.effect("refuses an intent whose target is not the kind's one configured address", () => {
    const fake = makeFakeChain({});
    const broadcaster = makeFakeBroadcaster();
    return Effect.gen(function* () {
      const adapter = yield* UniswapTestnetAdapter;
      const intent = yield* adapter.buildIntent({ kind: "pause", environmentId: "env-1" });
      const tampered: ForgeIntentRecord = {
        ...intent,
        unsigned: { ...intent.unsigned, to: `0x${"99".repeat(20)}` },
      };
      const refusal = yield* adapter.broadcastIntent({ intent: tampered }).pipe(Effect.flip);
      assert.ok(typeof refusal !== "string");
      assert.equal(refusal.reason, "idempotency-conflict");
      assert.include(refusal.detail, "immutable");
      assert.equal(broadcaster.sent.length, 0);
    }).pipe(
      Effect.provide(
        adapterLayer(
          fake.shape,
          ENV,
          Layer.succeed(SignedTransactionBroadcaster, broadcaster.shape),
        ),
      ),
    );
  });

  it.effect("refuses unprovable liquidity bounds and over-cap declarations at build", () => {
    const fake = makeFakeChain({});
    const broadcaster = makeFakeBroadcaster();
    return Effect.gen(function* () {
      const adapter = yield* UniswapTestnetAdapter;
      // A deposit over the grant cap refuses AT BUILD: the encoded on-chain
      // maximum is the guard, and it may never sit above the cap floor.
      const overDeposit = yield* adapter
        .buildIntent({
          kind: "add-liquidity",
          environmentId: "env-1",
          tickLower: -60,
          tickUpper: 60,
          liquidity: "1000000000",
          deposits: [{ token: C0, amountRaw: "20000000000000000000000" }],
          ownerAddress: `0x${"0e".repeat(20)}`,
        })
        .pipe(Effect.flip);
      assert.equal(overDeposit.reason, "invalid-params");
      assert.include(overDeposit.detail, "grant cap");

      // Duplicate tokens sum before the cap is applied.
      const summed = yield* adapter
        .buildIntent({
          kind: "add-liquidity",
          environmentId: "env-1",
          tickLower: -60,
          tickUpper: 60,
          liquidity: "1000",
          deposits: [
            { token: C0, amountRaw: "6000000000000000000000" },
            { token: C0, amountRaw: "6000000000000000000000" },
          ],
          ownerAddress: `0x${"0e".repeat(20)}`,
        })
        .pipe(Effect.flip);
      assert.include(summed.detail, "grant cap");

      // No declared deposits: an unprovable add refuses.
      const empty = yield* adapter
        .buildIntent({
          kind: "add-liquidity",
          environmentId: "env-1",
          tickLower: -60,
          tickUpper: 60,
          liquidity: "1000",
          deposits: [],
          ownerAddress: `0x${"0e".repeat(20)}`,
        })
        .pipe(Effect.flip);
      assert.include(empty.detail, "declare its deposits");

      // A token outside the pool currencies bounds nothing on chain.
      const foreign = yield* adapter
        .buildIntent({
          kind: "add-liquidity",
          environmentId: "env-1",
          tickLower: -60,
          tickUpper: 60,
          liquidity: "1000",
          deposits: [{ token: `0x${"99".repeat(20)}`, amountRaw: "1" }],
          ownerAddress: `0x${"0e".repeat(20)}`,
        })
        .pipe(Effect.flip);
      assert.include(foreign.detail, "pool currencies");

      // A mint with no named owner refuses — no safe default exists.
      const unowned = yield* adapter
        .buildIntent({
          kind: "add-liquidity",
          environmentId: "env-1",
          tickLower: -60,
          tickUpper: 60,
          liquidity: "1000",
          deposits: [{ token: C0, amountRaw: "1" }],
        })
        .pipe(Effect.flip);
      assert.include(unowned.detail, "owner");

      // DECREASE is tokenId-keyed; without one there is nothing to encode.
      // The type now requires tokenId, so this is a deliberate type-level
      // violation by an untrusted caller.
      const noTokenRequest = {
        kind: "remove-liquidity",
        environmentId: "env-1",
        tickLower: -60,
        tickUpper: 60,
        liquidity: "1000",
      } as unknown as Parameters<typeof adapter.buildIntent>[0];
      const noToken = yield* adapter.buildIntent(noTokenRequest).pipe(Effect.flip);
      assert.include(noToken.detail, "tokenId");

      // Zero minimum outputs refuse.
      const zeroMin = yield* adapter
        .buildIntent({
          kind: "remove-liquidity",
          environmentId: "env-1",
          tickLower: -60,
          tickUpper: 60,
          liquidity: "1000",
          tokenId: "7",
          minAmount0Raw: "0",
        })
        .pipe(Effect.flip);
      assert.include(zeroMin.detail, "minAmount0Raw");

      // Swap price limits: zero, sub-minimum and above-maximum all refuse.
      const limit = 2n ** 96n;
      for (const [name, badLimit] of [
        ["zero", "0"],
        ["below-min", "4295128739"],
        ["above-max", "1461446703485210103287273052203988822378723970342"],
      ] as const) {
        const refused = yield* adapter
          .buildIntent({
            kind: "bounded-swap",
            environmentId: "env-1",
            zeroForOne: true,
            amountSpecifiedRaw: "-2500000",
            sqrtPriceLimitX96: badLimit,
            quoteAmountRaw: "2500000",
          })
          .pipe(Effect.flip);
        assert.equal(refused.reason, "invalid-params", name);
        assert.include(refused.detail, "TickMath", name);
      }
      // Sanity: a mid-range limit builds.
      const ok = yield* adapter.buildIntent({
        kind: "bounded-swap",
        environmentId: "env-1",
        zeroForOne: true,
        amountSpecifiedRaw: "-2500000",
        sqrtPriceLimitX96: limit.toString(10),
        quoteAmountRaw: "2500000",
      });
      assert.equal(ok.kind, "bounded-swap");
      assert.equal(broadcaster.sent.length, 0);
    }).pipe(
      Effect.provide(
        adapterLayer(
          fake.shape,
          ENV,
          Layer.succeed(SignedTransactionBroadcaster, broadcaster.shape),
        ),
      ),
    );
  });

  it.effect("refuses at broadcast when the live grant no longer covers the spend", () => {
    const env = { ...ENV };
    const fake = makeFakeChain({});
    const broadcaster = makeFakeBroadcaster();
    return Effect.gen(function* () {
      const adapter = yield* UniswapTestnetAdapter;
      // Build under the full caps, then shrink the live grant before the
      // broadcast: the metadata passed build, the live cap still refuses.
      const deposit = yield* adapter.buildIntent({
        kind: "add-liquidity",
        environmentId: "env-1",
        tickLower: -60,
        tickUpper: 60,
        liquidity: "1000",
        deposits: [{ token: C0, amountRaw: "5000" }],
        ownerAddress: `0x${"0e".repeat(20)}`,
      });
      env.T3_FORGE_GRANT_TOKEN0_CAP_RAW = "1000";
      const depositRefusal = yield* adapter.broadcastIntent({ intent: deposit }).pipe(Effect.flip);
      assert.ok(typeof depositRefusal !== "string");
      assert.equal(depositRefusal.reason, "over-cap");
      assert.include(depositRefusal.detail, "grant cap");

      const overSwap = yield* adapter.buildIntent({
        kind: "bounded-swap",
        environmentId: "env-1",
        zeroForOne: true,
        amountSpecifiedRaw: "-600000000",
        sqrtPriceLimitX96: (2n ** 96n).toString(10),
        quoteAmountRaw: "600000000",
      });
      const swapRefusal = yield* adapter.broadcastIntent({ intent: overSwap }).pipe(Effect.flip);
      assert.ok(typeof swapRefusal !== "string");
      assert.equal(swapRefusal.reason, "over-cap");
      assert.include(swapRefusal.detail, "per-swap grant cap");
      assert.equal(broadcaster.sent.length, 0);
    }).pipe(
      Effect.provide(
        adapterLayer(
          fake.shape,
          env,
          Layer.succeed(SignedTransactionBroadcaster, broadcaster.shape),
        ),
      ),
    );
  });

  it.effect("refuses broadcast when the resolved grant retargets an approved grant", () => {
    const env = { ...ENV };
    const fake = makeFakeChain({});
    const broadcaster = makeFakeBroadcaster();
    return Effect.gen(function* () {
      const adapter = yield* UniswapTestnetAdapter;
      const intent = yield* adapter.buildIntent({ kind: "pause", environmentId: "env-1" });
      const sent = yield* adapter.broadcastIntent({ intent });
      assert.equal(sent.record.status, "submitted");

      // The operator repoints the hook env: same grantId, different binding.
      // configLayer resolves the (mutable) env on every settings read, so the
      // SAME adapter re-resolves the retargeted target — and the one guard
      // database of this layer build must refuse the retarget.
      env.T3_FORGE_SEPOLIA_HOOK_ADDRESS = `0x${"cd".repeat(19)}80`;
      // A fresh idempotency key: the same pause request against the new
      // target is a NEW intent, not a replay of the first.
      const rebuilt = yield* adapter.buildIntent({
        kind: "pause",
        environmentId: "env-1",
        idempotencyKey: "retarget-probe",
      });
      const refusal = yield* adapter.broadcastIntent({ intent: rebuilt }).pipe(Effect.flip);
      assert.ok(typeof refusal !== "string");
      assert.equal(refusal.reason, "wrong-target");
      assert.include(refusal.detail, "refusing to retarget");
      assert.equal(broadcaster.sent.length, 1);
    }).pipe(
      Effect.provide(
        adapterLayer(
          fake.shape,
          env,
          Layer.succeed(SignedTransactionBroadcaster, broadcaster.shape),
          admittedTestLedger,
          freshGuardSqlite(),
        ),
      ),
    );
  });

  it.effect("refuses once aggregate accounted gas reaches the grant budget", () => {
    // The budget is tight FROM THE START (exactly one intent's gas cost): the
    // immutable grant guard records this binding once, and exhaustion comes
    // from the ledger's accounted gas — not from a post-hoc env change the
    // guard would (correctly) refuse as a retarget.
    const env = { ...ENV, T3_FORGE_GRANT_AGGREGATE_GAS_WEI: "100000000000000" };
    const fake = makeFakeChain({});
    const broadcaster = makeFakeBroadcaster();
    return Effect.gen(function* () {
      const adapter = yield* UniswapTestnetAdapter;
      const first = yield* adapter.buildIntent({ kind: "pause", environmentId: "env-1" });
      const sent = yield* adapter.broadcastIntent({ intent: first });
      assert.equal(sent.record.txHash, "0x" + "1".padStart(64, "0"));
      fake.state.receipts.set(
        sent.record.txHash!,
        receiptOf({
          txHash: sent.record.txHash!,
          status: 1,
          blockNumber: BLOCK + 1,
          gasUsed: 100_000n,
          gasPrice: 1_000_000_000n,
        }),
      );
      const settled = yield* adapter.reconcileIntent(first.intentId);
      assert.equal(settled?.status, "confirmed");
      assert.equal(settled?.gasCostWei, "100000000000000");
      // Accounted 1e14 wei — exactly the whole budget: the next intent
      // cannot reserve anything.
      const second = yield* adapter.buildIntent({ kind: "unpause", environmentId: "env-1" });
      const refusal = yield* adapter.broadcastIntent({ intent: second }).pipe(Effect.flip);
      assert.ok(typeof refusal !== "string");
      assert.equal(refusal.reason, "budget-exhausted");
      assert.equal(broadcaster.sent.length, 1);
    }).pipe(
      Effect.provide(
        adapterLayer(
          fake.shape,
          env,
          Layer.succeed(SignedTransactionBroadcaster, broadcaster.shape),
        ),
      ),
    );
  });

  it.effect("broadcasts through the signer seam exactly once, then reconciles idempotently", () => {
    const fake = makeFakeChain({});
    const broadcaster = makeFakeBroadcaster();
    return Effect.gen(function* () {
      const adapter = yield* UniswapTestnetAdapter;
      const intent = yield* adapter.buildIntent({ kind: "pause", environmentId: "env-1" });
      const first = yield* adapter.broadcastIntent({ intent });
      assert.equal(first.record.status, "submitted");
      assert.ok(first.record.txHash !== undefined);
      // A real node holds a just-broadcast tx in its mempool.
      fake.state.txs.set(first.record.txHash, { hash: first.record.txHash });
      // Idempotent re-broadcast: same record, no second signer call.
      const again = yield* adapter.broadcastIntent({ intent: first.record });
      assert.equal(again.record.txHash, first.record.txHash);
      assert.equal(broadcaster.sent.length, 1);
      // The signer received the UNSIGNED transaction only.
      assert.equal(broadcaster.sent[0]?.chainId, SEPOLIA_CHAIN_ID);
      assert.equal(broadcaster.sent[0]?.data, "0x8456cb59");

      // Uncertain broadcast: no receipt yet, within the timeout.
      const pending = yield* adapter.reconcileIntent(intent.intentId);
      assert.equal(pending?.status, "submitted");

      // Receipt lands: PolicyPublished-style settlement with gas accounted once.
      fake.state.receipts.set(
        first.record.txHash!,
        receiptOf({
          txHash: first.record.txHash!,
          status: 1,
          blockNumber: BLOCK + 4,
          gasUsed: 120_000n,
          gasPrice: 1_500_000_000n,
          logs: [
            {
              address: HOOK,
              topics: [topic0("Paused()")],
              data: "0x",
              blockNumber: "0x" + (BLOCK + 4).toString(16),
              transactionHash: first.record.txHash!,
              logIndex: "0x0",
            },
          ],
        }),
      );
      const settled = yield* adapter.reconcileIntent(intent.intentId);
      assert.equal(settled?.status, "confirmed");
      assert.equal(settled?.gasAccounted, true);
      assert.equal(settled?.receipt?.hookEvents[0]?.kind, "Paused");
      // Reconcile again: terminal state is immutable, gas never recounted.
      const again2 = yield* adapter.reconcileIntent(intent.intentId);
      assert.deepEqual(again2, settled);
    }).pipe(
      Effect.provide(
        adapterLayer(
          fake.shape,
          ENV,
          Layer.succeed(SignedTransactionBroadcaster, broadcaster.shape),
        ),
      ),
    );
  });

  it.effect("an unknown (timed-out) intent can still settle later", () => {
    const fake = makeFakeChain({});
    const broadcaster = makeFakeBroadcaster();
    return Effect.gen(function* () {
      const adapter = yield* UniswapTestnetAdapter;
      const intent = yield* adapter.buildIntent({ kind: "unpause", environmentId: "env-1" });
      const sent = yield* adapter.broadcastIntent({ intent });
      // Node neither knows the tx nor has a receipt → unknown.
      const unknown = yield* adapter.reconcileIntent(intent.intentId);
      assert.equal(unknown?.status, "unknown");
      // The tx finally lands.
      fake.state.receipts.set(
        sent.record.txHash!,
        receiptOf({ txHash: sent.record.txHash!, status: 1, blockNumber: BLOCK + 9 }),
      );
      const settled = yield* adapter.reconcileIntent(intent.intentId);
      assert.equal(settled?.status, "confirmed");
    }).pipe(
      Effect.provide(
        adapterLayer(
          fake.shape,
          ENV,
          Layer.succeed(SignedTransactionBroadcaster, broadcaster.shape),
        ),
      ),
    );
  });

  it.effect("refuses with broadcaster-missing when no signer is wired", () => {
    const fake = makeFakeChain({});
    return Effect.gen(function* () {
      const adapter = yield* UniswapTestnetAdapter;
      const intent = yield* adapter.buildIntent({ kind: "pause", environmentId: "env-1" });
      const refusal = yield* adapter.broadcastIntent({ intent }).pipe(Effect.flip);
      assert.ok(typeof refusal !== "string");
      assert.equal(refusal.reason, "broadcaster-missing");
    }).pipe(Effect.provide(adapterLayer(fake.shape, ENV)));
  });
});

// ---------------------------------------------------------------------------
// Swap-fee evidence
// ---------------------------------------------------------------------------

describe("swap fee evidence", () => {
  const SWAP_TX = "0x" + "ab".repeat(32);

  it.effect("reports total fee while executed LP and protocol split stays unknown", () => {
    const fake = makeFakeChain({
      hook: {
        revision: 1n,
        expiry: BigInt(BLOCK_TS + 600),
        evidenceDigest: EVIDENCE_DIGEST as Hex,
        policyActive: true,
        paused: false,
        effectiveFee: 500,
        owner: `0x${"aa".repeat(20)}` as Hex,
        operator: `0x${"77".repeat(20)}` as Hex,
      },
      effectiveFeeAtBlock: () => 500,
    });
    return Effect.gen(function* () {
      fake.state.receipts.set(
        SWAP_TX,
        receiptOf({
          txHash: SWAP_TX,
          status: 1,
          blockNumber: BLOCK + 1,
          logs: [
            swapLog({ blockNumber: BLOCK + 1, txHash: SWAP_TX, poolId: FULL_POOL_ID, fee: 500 }),
          ],
        }),
      );
      const read = yield* UniswapTestnetAdapter.pipe(
        Effect.flatMap((adapter) => adapter.readSwapFeeEvidence(SWAP_TX)),
      );
      assert.equal(read.status, "ok");
      if (read.status !== "ok") return;
      const swap = read.evidence.swaps[0];
      assert.ok(swap !== undefined);
      assert.equal(swap.inOurPool, true);
      assert.equal(swap.totalSwapFeeHundredthsBps, 500);
      assert.equal(swap.lpFeeHundredthsBps, null);
      assert.equal(swap.lpFeeAsOf, null);
      assert.equal(swap.protocolFeeHundredthsBps, null);
    }).pipe(Effect.provide(adapterLayer(fake.shape, ENV)));
  });

  it.effect("baseline fee 3000 after expiry, and protocol fee honestly null when unknown", () => {
    const fake = makeFakeChain({
      effectiveFeeAtBlock: () => 3000,
    });
    return Effect.gen(function* () {
      fake.state.receipts.set(
        SWAP_TX,
        receiptOf({
          txHash: SWAP_TX,
          status: 1,
          blockNumber: BLOCK + 1,
          logs: [
            swapLog({ blockNumber: BLOCK + 1, txHash: SWAP_TX, poolId: FULL_POOL_ID, fee: 3500 }),
          ],
        }),
      );
      const read = yield* UniswapTestnetAdapter.pipe(
        Effect.flatMap((adapter) => adapter.readSwapFeeEvidence(SWAP_TX)),
      );
      assert.equal(read.status, "ok");
      if (read.status !== "ok") return;
      const swap = read.evidence.swaps[0];
      assert.ok(swap !== undefined);
      assert.equal(swap.totalSwapFeeHundredthsBps, 3500);
      assert.equal(swap.lpFeeHundredthsBps, null);
      assert.equal(swap.protocolFeeHundredthsBps, null);
    }).pipe(Effect.provide(adapterLayer(fake.shape, ENV)));
  });

  it.effect("does not substitute latest state for executed fee evidence", () => {
    const fake = makeFakeChain({
      effectiveFeeAtBlock: () => "fail",
    });
    return Effect.gen(function* () {
      fake.state.receipts.set(
        SWAP_TX,
        receiptOf({
          txHash: SWAP_TX,
          status: 1,
          blockNumber: BLOCK + 1,
          logs: [
            swapLog({ blockNumber: BLOCK + 1, txHash: SWAP_TX, poolId: FULL_POOL_ID, fee: 3000 }),
          ],
        }),
      );
      const read = yield* UniswapTestnetAdapter.pipe(
        Effect.flatMap((adapter) => adapter.readSwapFeeEvidence(SWAP_TX)),
      );
      assert.equal(read.status, "ok");
      if (read.status !== "ok") return;
      const swap = read.evidence.swaps[0];
      assert.ok(swap !== undefined);
      assert.equal(swap.lpFeeAsOf, null);
      assert.equal(swap.lpFeeHundredthsBps, null);
      assert.equal(fake.state.calls.filter((call) => call.method === "eth_call").length, 0);
    }).pipe(Effect.provide(adapterLayer(fake.shape, ENV)));
  });

  it.effect("marks foreign-pool swaps and refuses receipts without swaps", () =>
    Effect.gen(function* () {
      const fake = makeFakeChain({});
      const foreign = forgeFullPoolId({
        currency0: C0,
        currency1: C1,
        fee: 0x800000,
        tickSpacing: 10,
        hookAddress: HOOK,
      });
      fake.state.receipts.set(
        SWAP_TX,
        receiptOf({
          txHash: SWAP_TX,
          status: 1,
          blockNumber: BLOCK + 1,
          logs: [swapLog({ blockNumber: BLOCK + 1, txHash: SWAP_TX, poolId: foreign, fee: 3000 })],
        }),
      );
      const read = yield* UniswapTestnetAdapter.pipe(
        Effect.provide(adapterLayer(fake.shape, ENV)),
        Effect.flatMap((adapter) => adapter.readSwapFeeEvidence(SWAP_TX)),
      );
      assert.equal(read.status, "ok");
      if (read.status !== "ok") return;
      assert.equal(read.evidence.swaps[0]?.inOurPool, false);
      assert.equal(read.evidence.swaps[0]?.lpFeeHundredthsBps, null);

      const empty = "0x" + "ba".repeat(32);
      fake.state.receipts.set(empty, receiptOf({ txHash: empty, status: 1, blockNumber: BLOCK }));
      const refused = yield* UniswapTestnetAdapter.pipe(
        Effect.provide(adapterLayer(fake.shape, ENV)),
        Effect.flatMap((adapter) => adapter.readSwapFeeEvidence(empty)),
      );
      assert.equal(refused.status, "unavailable");
    }),
  );
});

describe("execution admission regressions", () => {
  it.effect("production in-memory ledger cannot reach the signer", () => {
    const fake = makeFakeBroadcaster();
    return Effect.gen(function* () {
      const adapter = yield* UniswapTestnetAdapter;
      const intent = yield* adapter.buildIntent({ kind: "pause", environmentId: "env-1" });
      const refusal = yield* adapter.broadcastIntent({ intent }).pipe(Effect.flip);
      assert.ok(typeof refusal !== "string");
      assert.equal(refusal.reason, "execution-unavailable");
      assert.equal(fake.sent.length, 0);
    }).pipe(
      Effect.provide(
        adapterLayer(
          makeFakeChain({}).shape,
          ENV,
          Layer.succeed(SignedTransactionBroadcaster, fake.shape),
          ForgeIntentLedgerInMemory,
        ),
      ),
    );
  });

  it.effect("an ambiguous broadcaster failure leaves a claimed intent unrepeatable", () => {
    let attempts = 0;
    const broadcaster: SignedTransactionBroadcasterShape = {
      broadcast: () =>
        Effect.gen(function* () {
          attempts++;
          return yield* Effect.fail("response lost after submission");
        }),
    };
    return Effect.gen(function* () {
      const adapter = yield* UniswapTestnetAdapter;
      const intent = yield* adapter.buildIntent({ kind: "pause", environmentId: "env-1" });
      yield* adapter.broadcastIntent({ intent }).pipe(Effect.flip);
      const second = yield* adapter.broadcastIntent({ intent }).pipe(Effect.flip);
      assert.ok(typeof second !== "string");
      assert.equal(second.reason, "idempotency-conflict");
      assert.equal(attempts, 1);
      assert.equal((yield* adapter.reconcileIntent(intent.intentId))?.status, "unknown");
    }).pipe(
      Effect.provide(
        adapterLayer(
          makeFakeChain({}).shape,
          ENV,
          Layer.succeed(SignedTransactionBroadcaster, broadcaster),
        ),
      ),
    );
  });

  it.effect("rejects modified calldata and a wrong RPC chain before signing", () => {
    const fake = makeFakeBroadcaster();
    return Effect.gen(function* () {
      const adapter = yield* UniswapTestnetAdapter;
      const intent = yield* adapter.buildIntent({ kind: "pause", environmentId: "env-1" });
      const mutated = yield* adapter
        .broadcastIntent({ intent: { ...intent, unsigned: { ...intent.unsigned, data: "0x" } } })
        .pipe(Effect.flip);
      assert.ok(typeof mutated !== "string");
      assert.equal(mutated.reason, "idempotency-conflict");
      const wrongChain = yield* adapter.broadcastIntent({ intent }).pipe(Effect.flip);
      assert.ok(typeof wrongChain !== "string");
      assert.equal(wrongChain.reason, "wrong-target");
      assert.equal(fake.sent.length, 0);
    }).pipe(
      Effect.provide(
        adapterLayer(
          makeFakeChain({ chainIdHex: "0x1" }).shape,
          ENV,
          Layer.succeed(SignedTransactionBroadcaster, fake.shape),
        ),
      ),
    );
  });
  it.effect(
    "the durable SQLite ledger refuses claims without enforceable gas, then admits exactly one",
    () => {
      const fake = makeFakeBroadcaster();
      const sqliteLedger = ForgeIntentLedgerSqliteLive.pipe(Layer.provide(migratedSqliteLayer()));
      const guard = freshGuardSqlite();
      return Effect.gen(function* () {
        const adapter = yield* UniswapTestnetAdapter;
        const ledger = yield* ForgeIntentLedger;

        // A freshly built record carries no gas fields (the prepared pass has
        // not run): the claim must lose and nothing reaches the signer.
        const bare = yield* adapter.buildIntent({ kind: "pause", environmentId: "env-1" });
        const bareRefusal = yield* adapter.broadcastIntent({ intent: bare }).pipe(Effect.flip);
        assert.ok(typeof bareRefusal !== "string");
        assert.equal(bareRefusal.reason, "idempotency-conflict");
        assert.include(bareRefusal.detail, "gas reservation was refused");
        assert.equal(fake.sent.length, 0);
        // The losing claim does not consume the draft: after the (simulated)
        // prepared-transaction pass stamps gas fields, the same intent claims.
        const prepared: ForgeIntentRecord = {
          ...bare,
          unsigned: {
            ...bare.unsigned,
            gasLimit: "100000",
            maxFeePerGasWei: "2000000000",
            maxPriorityFeePerGasWei: "1000000000",
          },
        };
        yield* ledger.upsert(prepared);
        const sent = yield* adapter.broadcastIntent({ intent: prepared });
        assert.equal(sent.record.status, "submitted");
        assert.equal(fake.sent.length, 1);

        // A SECOND intent, gas-stamped, admits once under concurrency.
        const other = yield* adapter.buildIntent({ kind: "unpause", environmentId: "env-1" });
        const otherPrepared: ForgeIntentRecord = {
          ...other,
          unsigned: { ...other.unsigned, gasLimit: "100000", maxFeePerGasWei: "2000000000" },
        };
        yield* ledger.upsert(otherPrepared);
        yield* Effect.all(
          [
            adapter.broadcastIntent({ intent: otherPrepared }).pipe(Effect.exit),
            adapter.broadcastIntent({ intent: otherPrepared }).pipe(Effect.exit),
          ],
          { concurrency: "unbounded" },
        );
        // One broadcast for the bare intent, exactly one more for the pair.
        assert.equal(fake.sent.length, 2);
      }).pipe(
        Effect.provide(
          adapterLayer(
            makeFakeChain({}).shape,
            ENV,
            Layer.succeed(SignedTransactionBroadcaster, fake.shape),
            sqliteLedger,
            guard,
          ),
        ),
      );
    },
  );

  it.effect("a claimed intent that cannot be signed stays claimed: reservations never leak", () => {
    const sqliteLedger = ForgeIntentLedgerSqliteLive.pipe(Layer.provide(migratedSqliteLayer()));
    return Effect.gen(function* () {
      // The production signer seam refuses — but the claim has already
      // happened. The record must be unknown with its reservation held,
      // and no retry may reach the (future) signer again.
      const adapter = yield* UniswapTestnetAdapter;
      const ledger = yield* ForgeIntentLedger;
      const intent = yield* adapter.buildIntent({ kind: "pause", environmentId: "env-1" });
      const prepared: ForgeIntentRecord = {
        ...intent,
        unsigned: { ...intent.unsigned, gasLimit: "100000", maxFeePerGasWei: "2000000000" },
      };
      yield* ledger.upsert(prepared);
      const refusal = yield* adapter.broadcastIntent({ intent: prepared }).pipe(Effect.flip);
      assert.ok(typeof refusal !== "string");
      assert.equal(refusal.reason, "broadcaster-missing");
      // The durable claim survived the refusal: unknown, reserved, stuck.
      const stored = yield* ledger.find(intent.intentId);
      assert.equal(stored?.status, "unknown");
      const retry = yield* adapter.broadcastIntent({ intent: prepared }).pipe(Effect.flip);
      assert.ok(typeof retry !== "string");
      assert.equal(retry.reason, "idempotency-conflict");
    }).pipe(
      Effect.provide(
        adapterLayer(
          makeFakeChain({}).shape,
          ENV,
          SignedTransactionBroadcasterUnavailable,
          sqliteLedger,
          freshGuardSqlite(),
        ),
      ),
    );
  });
});
