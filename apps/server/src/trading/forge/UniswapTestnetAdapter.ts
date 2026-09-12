/**
 * UniswapTestnetAdapter — the typed seam between T3 Forge and Ethereum
 * Sepolia, and the boundary every chain write must cross.
 *
 * Read paths (chain id check, hook views, policy events, receipts, swap-fee
 * evidence) go through an injected JSON-RPC transport; tests inject a fake,
 * production composes the shared HTTP client.
 *
 * Write paths are UNSIGNED, DURABLE INTENTS and nothing more, by design:
 *
 * - `buildIntent` encodes a typed record (idempotency-keyed, target-bound to
 *   the configured Sepolia hook/periphery) and persists it in the intent
 *   ledger. It never signs and never broadcasts.
 * - `broadcastIntent` refuses — with a named `ForgeBroadcastRefused` reason —
 *   unless the F0 spend grant is configured and unexpired by CHAIN time, the
 *   intent is within the grant's caps, the aggregate gas budget is not
 *   exhausted, and the target matches the intent kind. The only thing it
 *   hands to the chain is an injected `SignedTransactionBroadcaster`; this
 *   module defines that seam and deliberately ships only a refusing
 *   implementation. The grant-controlled human signer lands with the live
 *   pass, and until then every refusal is correct behavior, not a failure to
 *   work around.
 * - `reconcileIntent` is the uncertain-broadcast state machine: a submitted
 *   tx without a receipt stays `submitted` until a receipt settles it or the
 *   bounded timeout turns it `unknown`. Terminal states never move, gas is
 *   accounted exactly once, and re-checking is idempotent.
 *
 * No private-key material exists anywhere in this file. Nothing here calls
 * Hyperliquid or touches its signers.
 *
 * @module UniswapTestnetAdapter
 */
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { Layer, Schema } from "effect";
import * as NodeCrypto from "node:crypto";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import {
  decodeEventLog,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  fromHex,
  keccak256,
  numberToHex,
  parseAbi,
  type Abi,
  type Hex,
} from "viem";

import {
  SEPOLIA_CHAIN_ID,
  resolveForgeTestnetSettings,
  type ForgeSpendGrant,
  type ForgeTestnetSettings,
  type ForgeTestnetTarget,
} from "./SepoliaTarget.ts";
import {
  POSITION_MANAGER_ACTIONS,
  V4_MAX_SQRT_PRICE,
  V4_MIN_SQRT_PRICE,
  encodeDecreaseLiquidityParams,
  encodeIncreaseLiquidityParams,
  encodeMintPositionParams,
  encodeModifyLiquiditiesUnlockData,
  positionManagerAbi,
  swapRouteAbi,
} from "./PeripheryAbi.ts";

// ---------------------------------------------------------------------------
// The fixed hook's ABI (contracts/forge/src/ForgeFeeHook.sol, frozen in 4a)
// ---------------------------------------------------------------------------

/**
 * Exact signatures of the deployed hook. The `Policy` return of `getPolicy`
 * is declared as an unnamed tuple so the decode is positional and stable.
 */
const forgeHookAbi = parseAbi([
  "function publishPolicy(bytes32 poolId, uint256 revision, uint256 expiry, bytes32 evidenceDigest)",
  "function revokePolicy(bytes32 poolId)",
  "function pause()",
  "function unpause()",
  "function setOperator(address newOperator)",
  "function policyActive() view returns (bool)",
  "function effectiveFee(bytes32 poolId) view returns (uint24)",
  "function beforeSwapFeeOverride(bytes32 poolId) view returns (uint24)",
  "function getPolicy() view returns ((uint256 revision, uint256 expiry, bytes32 evidenceDigest) policy)",
  "function boundPoolId() view returns (bytes32)",
  "function owner() view returns (address)",
  "function operator() view returns (address)",
  "function paused() view returns (bool)",
  "function BASELINE_FEE() view returns (uint24)",
  "function POLICY_FEE() view returns (uint24)",
  "event PolicyPublished(bytes32 indexed poolId, uint256 revision, uint256 expiry, bytes32 evidenceDigest)",
  "event PolicyRevoked(bytes32 indexed poolId, uint256 revision)",
  "event Paused()",
  "event Unpaused()",
  "event OperatorSet(address indexed newOperator)",
]) as unknown as Abi;

/** PoolManager calls and events this adapter encodes/decodes (pinned v4-core). */
const poolManagerAbi = parseAbi([
  "function initialize((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, uint160 sqrtPriceX96) returns (int24 tick)",
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
  "event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)",
]) as unknown as Abi;

// The PositionManager (modifyLiquidities) and PoolSwapTest (swap) fragments
// live in PeripheryAbi.ts, pinned against the deployed verified sources.

// ---------------------------------------------------------------------------
// Pool identity, computed locally (mirrors the hook's own pure functions)
// ---------------------------------------------------------------------------

export interface PoolKeyLike {
  readonly currency0: string;
  readonly currency1: string;
  readonly fee: number;
  readonly tickSpacing: number;
}

const POOL_KEY_PARAMS = [
  { type: "address", name: "currency0" },
  { type: "address", name: "currency1" },
  { type: "uint24", name: "fee" },
  { type: "int24", name: "tickSpacing" },
] as const;

/**
 * The hook's binding id: keccak256(abi.encode(currency0, currency1, fee,
 * tickSpacing)) — the pool identity minus the hook address, exactly what
 * `ForgeFeeHook.bindingIdForPool` computes on-chain.
 */
export function forgeBindingId(poolKey: PoolKeyLike): Hex {
  return keccak256(
    encodeAbiParameters(
      [...POOL_KEY_PARAMS],
      [poolKey.currency0 as Hex, poolKey.currency1 as Hex, poolKey.fee, poolKey.tickSpacing],
    ),
  );
}

/**
 * The full v4 pool id: keccak256(abi.encode(currency0, currency1, fee,
 * tickSpacing, hooks)) — the value PoolManager emits as `id` in Swap and
 * ModifyLiquidity events.
 */
export function forgeFullPoolId(poolKey: PoolKeyLike & { readonly hookAddress: string }): Hex {
  return keccak256(
    encodeAbiParameters(
      [...POOL_KEY_PARAMS, { type: "address", name: "hooks" }],
      [
        poolKey.currency0 as Hex,
        poolKey.currency1 as Hex,
        poolKey.fee,
        poolKey.tickSpacing,
        poolKey.hookAddress as Hex,
      ],
    ),
  );
}

// ---------------------------------------------------------------------------
// Intent records — the durable, unsigned unit of every Forge write
// ---------------------------------------------------------------------------

export type ForgeIntentKind =
  | "publish-policy"
  | "revoke-policy"
  | "pause"
  | "unpause"
  | "initialize-pool"
  | "add-liquidity"
  | "remove-liquidity"
  | "bounded-swap";

/**
 * The honest tx states: `draft` (never handed to the chain), `submitted` (a
 * tx hash exists, outcome pending), `confirmed`/`reverted` (receipt settled,
 * terminal), `unknown` (no receipt within the bounded timeout, or the chain
 * no longer knows the tx).
 */
export type ForgeTransactionState = "draft" | "submitted" | "confirmed" | "reverted" | "unknown";

export type ForgeIntentRequest =
  | {
      readonly kind: "publish-policy";
      readonly environmentId: string;
      readonly bindingId: string;
      readonly revision: string;
      readonly expiryUnix: number;
      readonly evidenceDigest: string;
      readonly idempotencyKey?: string;
    }
  | {
      readonly kind: "revoke-policy";
      readonly environmentId: string;
      readonly bindingId: string;
      readonly idempotencyKey?: string;
    }
  | { readonly kind: "pause"; readonly environmentId: string; readonly idempotencyKey?: string }
  | { readonly kind: "unpause"; readonly environmentId: string; readonly idempotencyKey?: string }
  | {
      readonly kind: "initialize-pool";
      readonly environmentId: string;
      readonly sqrtPriceX96: string;
      readonly idempotencyKey?: string;
    }
  | {
      readonly kind: "add-liquidity";
      readonly environmentId: string;
      readonly tickLower: number;
      readonly tickUpper: number;
      readonly liquidity: string;
      readonly salt?: string;
      /** Token deposits this add may move; grant-capped at broadcast. */
      readonly deposits: ReadonlyArray<{ readonly token: string; readonly amountRaw: string }>;
      /** Present to add to an existing NFT position; absent to MINT a new one. */
      readonly tokenId?: string;
      /**
       * Recipient of the minted position NFT. Required when minting — there is
       * no safe default for who owns a position.
       */
      readonly ownerAddress?: string;
      readonly idempotencyKey?: string;
    }
  | {
      readonly kind: "remove-liquidity";
      readonly environmentId: string;
      readonly tickLower: number;
      readonly tickUpper: number;
      readonly liquidity: string;
      readonly salt?: string;
      /** The existing NFT position being decreased; DECREASE is tokenId-keyed. */
      readonly tokenId: string;
      /** Minimum outputs; each defaults to 1 raw unit when omitted. */
      readonly minAmount0Raw?: string;
      readonly minAmount1Raw?: string;
      readonly idempotencyKey?: string;
    }
  | {
      readonly kind: "bounded-swap";
      readonly environmentId: string;
      readonly zeroForOne: boolean;
      /** Exact-in (negative) or exact-out (positive), raw, never zero. */
      readonly amountSpecifiedRaw: string;
      /**
       * Required, nonzero, inside the open TickMath sqrt-price interval. A
       * zero limit is outside the usable range; bounded swaps are
       * machine-generated and always carry an explicit bound.
       */
      readonly sqrtPriceLimitX96: string;
      /** Declared quote-leg size of the swap, raw; grant-capped at broadcast. */
      readonly quoteAmountRaw: string;
      readonly idempotencyKey?: string;
    };

/** What an intent may spend — the numbers the grant caps are checked against. */
export interface ForgeIntentSpend {
  readonly deposits?: ReadonlyArray<{ readonly token: string; readonly amountRaw: string }>;
  readonly swapQuoteAmountRaw?: string;
}

/** The unsigned transaction a grant-controlled signer would sign, never more. */
export interface ForgeUnsignedTransaction {
  readonly chainId: typeof SEPOLIA_CHAIN_ID;
  readonly to: string;
  readonly data: Hex;
  readonly valueWei: string;
  /**
   * Enforceable gas ceiling, stamped by the future prepared-transaction pass.
   * A claim without these fields refuses: an unenforceable reservation is
   * worse than none. EIP-1559 takes gasLimit x maxFeePerGasWei; legacy takes
   * gasLimit x gasPriceWei.
   */
  readonly gasLimit?: string;
  readonly maxFeePerGasWei?: string;
  readonly maxPriorityFeePerGasWei?: string;
  readonly gasPriceWei?: string;
  /** Assigned when a signer prepares a concrete transaction. */
  readonly nonce?: number;
}

export interface ForgeReceiptSnapshot {
  readonly txHash: string;
  readonly status: "confirmed" | "reverted";
  readonly blockNumber: number;
  readonly gasUsedUnits: string;
  readonly effectiveGasPriceWei: string;
  readonly gasCostWei: string;
  readonly hookEvents: ReadonlyArray<ForgePolicyEvent>;
  readonly poolEvents: ReadonlyArray<ForgePoolEvent>;
}

export interface ForgeIntentRecord {
  readonly intentId: string;
  readonly idempotencyKey: string;
  readonly kind: ForgeIntentKind;
  readonly environmentId: string;
  readonly createdAtMs: number;
  readonly unsigned: ForgeUnsignedTransaction;
  readonly spend: ForgeIntentSpend;
  readonly status: ForgeTransactionState;
  readonly txHash?: string;
  readonly submittedAtMs?: number;
  readonly settledAtBlockNumber?: number;
  readonly gasCostWei?: string;
  /** Exactly-once accounting flag: gas enters the budget total one time. */
  readonly gasAccounted: boolean;
  readonly receipt?: ForgeReceiptSnapshot;
  readonly lastRefusal?: {
    readonly reason: ForgeBroadcastRefusalReason;
    readonly detail: string;
    readonly refusedAtMs: number;
  };
  /**
   * The request's semantic parameters (revision, expiry, digests, ticks…),
   * as string map. The calldata stays the source of truth for the chain; the
   * map exists so policy/position reads can reconstruct state from ledger
   * records without re-decoding ABI.
   */
  readonly params: Readonly<Record<string, string>>;
  readonly summary: string;
}

// ---------------------------------------------------------------------------
// Read-path result types
// ---------------------------------------------------------------------------

export interface ForgeHookState {
  readonly hookAddress: string;
  readonly chainId: typeof SEPOLIA_CHAIN_ID;
  readonly boundPoolId: string;
  readonly policy: {
    readonly revision: string;
    readonly expiryUnix: string;
    readonly evidenceDigest: string;
  };
  readonly policyActive: boolean;
  readonly paused: boolean;
  readonly owner: string;
  readonly operator: string;
  /** The bound pool's effective LP fee in hundredths of a bip (500/3000). */
  readonly effectiveFeeHundredthsBps: number;
  /** Raw override the hook returns on the wire: OVERRIDE_FEE_FLAG | fee. */
  readonly beforeSwapFeeOverrideRaw: string;
  readonly baselineFeeHundredthsBps: number;
  readonly policyFeeHundredthsBps: number;
  readonly asOfBlockNumber: number;
  readonly asOfBlockTimestampUnix: number;
  readonly fetchedAtMs: number;
}

export type ForgeHookStateRead =
  | { readonly status: "ok"; readonly state: ForgeHookState }
  | { readonly status: "unavailable"; readonly reason: string };

export type ForgePolicyEvent =
  | {
      readonly kind: "PolicyPublished";
      readonly blockNumber: number;
      readonly logIndex: number;
      readonly txHash: string;
      readonly poolId: string;
      readonly revision: string;
      readonly expiryUnix: string;
      readonly evidenceDigest: string;
    }
  | {
      readonly kind: "PolicyRevoked";
      readonly blockNumber: number;
      readonly logIndex: number;
      readonly txHash: string;
      readonly poolId: string;
      readonly revision: string;
    }
  | {
      readonly kind: "Paused";
      readonly blockNumber: number;
      readonly logIndex: number;
      readonly txHash: string;
    }
  | {
      readonly kind: "Unpaused";
      readonly blockNumber: number;
      readonly logIndex: number;
      readonly txHash: string;
    }
  | {
      readonly kind: "OperatorSet";
      readonly blockNumber: number;
      readonly logIndex: number;
      readonly txHash: string;
      readonly newOperator: string;
    };

export type ForgePoolEvent =
  | {
      readonly kind: "Initialize";
      readonly blockNumber: number;
      readonly logIndex: number;
      readonly txHash: string;
      readonly poolId: string;
      readonly fee: number;
      readonly tickSpacing: number;
      readonly hooks: string;
      readonly sqrtPriceX96: string;
      readonly tick: number;
    }
  | {
      readonly kind: "Swap";
      readonly blockNumber: number;
      readonly logIndex: number;
      readonly txHash: string;
      readonly poolId: string;
      readonly amount0: string;
      readonly amount1: string;
      readonly sqrtPriceX96: string;
      readonly liquidity: string;
      readonly tick: number;
      /** The TOTAL swap fee in hundredths of a bip, as PoolManager emitted it. */
      readonly totalSwapFeeHundredthsBps: number;
    }
  | {
      readonly kind: "ModifyLiquidity";
      readonly sender: string;
      readonly blockNumber: number;
      readonly logIndex: number;
      readonly txHash: string;
      readonly poolId: string;
      readonly tickLower: number;
      readonly tickUpper: number;
      readonly liquidityDelta: string;
      readonly salt: string;
    };

export type ForgePolicyEventsRead =
  | { readonly status: "ok"; readonly events: ReadonlyArray<ForgePolicyEvent> }
  | { readonly status: "unavailable"; readonly reason: string };

export type ForgeTransactionResolution =
  | { readonly state: "confirmed"; readonly receipt: ForgeReceiptSnapshot }
  | { readonly state: "reverted"; readonly receipt: ForgeReceiptSnapshot }
  | { readonly state: "submitted"; readonly detail: "pending-in-mempool" }
  | { readonly state: "unknown"; readonly detail: "timeout-no-receipt" | "tx-not-found" };

/** One swap's fee split inside a decoded receipt. */
export interface ForgeSwapFeeEntry {
  readonly poolId: string;
  readonly inOurPool: boolean;
  /** PoolManager's emitted `fee`: the TOTAL swap fee in hundredths of a bip. */
  readonly totalSwapFeeHundredthsBps: number;
  /** Executed LP fee; null unless transaction-order evidence proves it. */
  readonly lpFeeHundredthsBps: number | null;
  readonly lpFeeAsOf: "receipt-block" | "latest" | null;
  /** Executed protocol fee; the total Swap fee alone does not establish it. */
  readonly protocolFeeHundredthsBps: number | null;
}

/**
 * Swap-fee evidence for one receipt. The Swap event carries the TOTAL fee;
 * executed LP/protocol components remain unknown without transaction-order evidence.
 */
export interface ForgeSwapFeeEvidence {
  readonly txHash: string;
  readonly blockNumber: number;
  readonly swaps: ReadonlyArray<ForgeSwapFeeEntry>;
}

export type ForgeSwapFeeEvidenceRead =
  | { readonly status: "ok"; readonly evidence: ForgeSwapFeeEvidence }
  | { readonly status: "unavailable"; readonly reason: string };

// ---------------------------------------------------------------------------
// Named errors — refusals are typed facts, not exceptions to hide
// ---------------------------------------------------------------------------

export type ForgeBroadcastRefusalReason =
  | "unconfigured"
  | "wrong-target"
  | "grant-missing"
  | "grant-expired"
  | "chain-time-unavailable"
  | "over-cap"
  | "budget-exhausted"
  | "idempotency-conflict"
  | "broadcaster-missing"
  | "execution-unavailable";

export class ForgeBroadcastRefused extends Schema.TaggedErrorClass<ForgeBroadcastRefused>()(
  "ForgeBroadcastRefused",
  {
    reason: Schema.Literals([
      "unconfigured",
      "wrong-target",
      "grant-missing",
      "grant-expired",
      "chain-time-unavailable",
      "over-cap",
      "budget-exhausted",
      "idempotency-conflict",
      "broadcaster-missing",
      "execution-unavailable",
    ]),
    detail: Schema.String,
  },
) {}

export class ForgeIntentBuildError extends Schema.TaggedErrorClass<ForgeIntentBuildError>()(
  "ForgeIntentBuildError",
  {
    reason: Schema.Literals(["unconfigured", "invalid-params"]),
    detail: Schema.String,
  },
) {}

// ---------------------------------------------------------------------------
// Injected seams
// ---------------------------------------------------------------------------

export class ForgeTestnetConfig extends Context.Service<
  ForgeTestnetConfig,
  { readonly resolve: Effect.Effect<ForgeTestnetSettings> }
>()("t3/trading/forge/UniswapTestnetAdapter/ForgeTestnetConfig") {}

export const ForgeTestnetConfigLive = Layer.succeed(
  ForgeTestnetConfig,
  ForgeTestnetConfig.of({
    resolve: Effect.sync(() =>
      resolveForgeTestnetSettings(process.env as Record<string, string | undefined>),
    ),
  }),
);

export interface ForgeSepoliaRpcTransportShape {
  /** One JSON-RPC call. Fails with a reason string; never throws, never retries. */
  readonly request: (
    method: string,
    params: ReadonlyArray<unknown>,
  ) => Effect.Effect<unknown, string>;
}

export class ForgeSepoliaTransport extends Context.Service<
  ForgeSepoliaTransport,
  ForgeSepoliaRpcTransportShape
>()("t3/trading/forge/UniswapTestnetAdapter/ForgeSepoliaTransport") {}

/**
 * HttpClient-backed JSON-RPC. The endpoint comes from configuration; the
 * request body carries method and params only, so no credential can ride a
 * URL. Tests inject a fake at this seam.
 */
export const ForgeSepoliaTransportLive = Layer.effect(
  ForgeSepoliaTransport,
  Effect.gen(function* () {
    const config = yield* ForgeTestnetConfig;
    const client = yield* HttpClient.HttpClient;
    let nextId = 0;
    return ForgeSepoliaTransport.of({
      request: (method, params) =>
        Effect.gen(function* () {
          const settings = yield* config.resolve;
          if (!settings.configured || settings.target === undefined) {
            return yield* Effect.fail(settings.reason ?? "forge sepolia target not configured");
          }
          const id = (nextId += 1);
          const response = yield* HttpClientRequest.post(settings.target.rpcUrl).pipe(
            HttpClientRequest.bodyJson({ jsonrpc: "2.0", id, method, params: [...params] }),
            Effect.flatMap(client.execute),
            Effect.flatMap((res) => res.json),
            Effect.mapError((cause): string => `sepolia rpc transport failed: ${String(cause)}`),
          );
          const body = response as { result?: unknown; error?: { message?: string } } | null;
          if (body !== null && typeof body === "object" && body.error !== undefined) {
            return yield* Effect.fail(
              `sepolia rpc error from ${method}: ${body.error.message ?? "unknown"}`,
            );
          }
          return body === null || body === undefined ? undefined : body.result;
        }),
    });
  }),
);

/**
 * The broadcast seam this module will NOT implement. A human/grant-controlled
 * signer receives the unsigned transaction plus the intent record and is
 * solely responsible for producing a signature. Until that exists, every
 * broadcast refuses with `broadcaster-missing`.
 */
export interface SignedTransactionBroadcasterShape {
  readonly broadcast: (input: {
    readonly transaction: ForgeUnsignedTransaction;
    readonly intent: ForgeIntentRecord;
  }) => Effect.Effect<{ readonly txHash: string }, ForgeBroadcastRefused | string>;
}

export class SignedTransactionBroadcaster extends Context.Service<
  SignedTransactionBroadcaster,
  SignedTransactionBroadcasterShape
>()("t3/trading/forge/UniswapTestnetAdapter/SignedTransactionBroadcaster") {}

/** The only implementation this phase ships: an honest, named refusal. */
export const SignedTransactionBroadcasterUnavailable = Layer.succeed(SignedTransactionBroadcaster, {
  broadcast: () =>
    new ForgeBroadcastRefused({
      reason: "broadcaster-missing",
      detail:
        "no grant-controlled signer is wired; the supervised live pass provides SignedTransactionBroadcaster",
    }),
});

export interface ForgeIntentLedgerShape {
  /** Only a durable implementation with atomic admission may enable signing. */
  readonly durableAdmission?: {
    /** Atomically claim a draft and reserve an enforceable maximum gas cost
     * within this grant. Persist unknown before returning true. False means
     * another claimant/state change won. No implementation ships yet. */
    readonly claim: (
      record: ForgeIntentRecord,
      grantId: string,
      gasBudgetWei: string,
    ) => Effect.Effect<boolean>;
  };
  /** Upsert by intentId; idempotent for identical records. */
  readonly upsert: (record: ForgeIntentRecord) => Effect.Effect<void>;
  readonly find: (intentId: string) => Effect.Effect<ForgeIntentRecord | null>;
  readonly findByIdempotencyKey: (key: string) => Effect.Effect<ForgeIntentRecord | null>;
  /** Exhaustive internal history; presentation limits must never drive accounting. */
  readonly listAll: Effect.Effect<ReadonlyArray<ForgeIntentRecord>>;
  readonly listRecent: (limit?: number) => Effect.Effect<ReadonlyArray<ForgeIntentRecord>>;
  /** Sum of gasCostWei across records whose gas has been accounted. */
  readonly totalAccountedGasWei: Effect.Effect<string>;
  /**
   * Release a settled intent's gas reservation (actual cost recorded via the
   * settled record). Optional: only durable ledgers carry reservations.
   */
  readonly settleGas?: (intentId: string, gasCostWei: string) => Effect.Effect<void>;
  /** Durable scoped control state (the persistent local pause). Optional. */
  readonly readPaused?: (scope: string) => Effect.Effect<boolean>;
  readonly writePaused?: (scope: string, paused: boolean) => Effect.Effect<void>;
}

export class ForgeIntentLedger extends Context.Service<ForgeIntentLedger, ForgeIntentLedgerShape>()(
  "t3/trading/forge/UniswapTestnetAdapter/ForgeIntentLedger",
) {}

// ---------------------------------------------------------------------------
// The immutable approved-grant guard seam
// ---------------------------------------------------------------------------

export type ForgeGrantGuardVerdict =
  | { readonly status: "recorded" }
  | { readonly status: "verified" }
  | { readonly status: "retarget"; readonly detail: string };

export interface ForgeGrantGuardShape {
  /**
   * Record the first sighting of a grantId, or verify that the resolved grant
   * still matches it in every binding field (chain, hook, operator, caps,
   * budget, expiry). The durable implementation is INSERT-only: changing the
   * configured target can never silently retarget an approved grant.
   */
  readonly recordOrVerify: (
    grant: ForgeSpendGrant,
  ) => Effect.Effect<ForgeGrantGuardVerdict, string>;
}

export class ForgeGrantGuard extends Context.Service<ForgeGrantGuard, ForgeGrantGuardShape>()(
  "t3/trading/forge/UniswapTestnetAdapter/ForgeGrantGuard",
) {}

/**
 * In-memory ledger. The record type is deliberately durable — stable ids,
 * JSON-transportable fields, exactly-once accounting flags — so the
 * SQL-backed implementation (forge intents migration, owned by the reactor
 * phase) is a drop-in replacement for this seam, not a redesign.
 */
export const makeInMemoryForgeIntentLedger = Effect.sync(() => {
  const byId = new Map<string, ForgeIntentRecord>();
  const byKey = new Map<string, ForgeIntentRecord>();
  const shape: ForgeIntentLedgerShape = {
    upsert: (record) =>
      Effect.sync(() => {
        byId.set(record.intentId, record);
        byKey.set(record.idempotencyKey, record);
      }),
    find: (intentId) => Effect.sync(() => byId.get(intentId) ?? null),
    findByIdempotencyKey: (key) => Effect.sync(() => byKey.get(key) ?? null),
    listAll: Effect.sync(() => [...byId.values()].toReversed()),
    // Recency is INSERTION order, not the clock: two intents built in the
    // same millisecond still have an unambiguous "newest".
    listRecent: (limit = 20) =>
      Effect.sync(() => {
        const all = [...byId.values()];
        const capped = Math.min(limit, 100);
        return all.slice(Math.max(0, all.length - capped)).toReversed();
      }),
    totalAccountedGasWei: Effect.sync(() =>
      [...byId.values()]
        .reduce(
          (total, record) =>
            record.gasAccounted ? total + BigInt(record.gasCostWei ?? "0") : total,
          0n,
        )
        .toString(10),
    ),
  };
  return shape;
});

export const ForgeIntentLedgerInMemory = Layer.effect(
  ForgeIntentLedger,
  makeInMemoryForgeIntentLedger,
);

// ---------------------------------------------------------------------------
// Small decode/normalize helpers
// ---------------------------------------------------------------------------

const ZERO_BYTES32 = `0x${"00".repeat(32)}` as Hex;
const isHex32 = (value: string): boolean => /^0x[0-9a-fA-F]{64}$/.test(value);
const isNonNegativeIntString = (value: string): boolean => /^[0-9]+$/.test(value);
const isSignedIntString = (value: string): boolean => /^-?[0-9]+$/.test(value);
const isAddress = (value: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(value);

const blockNumberOf = (hex: unknown): number | null =>
  typeof hex === "string" && /^0x[0-9a-fA-F]+$/.test(hex)
    ? Number(fromHex(hex as Hex, "bigint"))
    : null;

const bigintValue = (value: unknown): string | null => {
  if (typeof value === "bigint") return value.toString(10);
  if (typeof value === "number" && Number.isInteger(value)) return value.toString(10);
  return null;
};

const numberValue = (value: unknown): number | null => (typeof value === "number" ? value : null);

/** Deterministic id: same idempotency key, same intent id, forever. */
const intentIdFor = (idempotencyKey: string): string =>
  `forge_intent_${NodeCrypto.createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 24)}`;

/**
 * Deterministic JSON regardless of key order, at every nesting level. (A
 * `JSON.stringify` replacer ARRAY would silently drop nested keys — the
 * exact bug two same-keyed deposit intents once exposed.)
 */
const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

export const immutableTargetFingerprint = (target: ForgeTestnetTarget): string =>
  stableStringify({
    chainId: target.chainId,
    poolKey: target.poolKey,
    poolManager: target.poolManager,
    positionManager: target.positionManager,
    swapRoute: target.swapRoute,
  });

const immutableIntentFingerprint = (record: ForgeIntentRecord): string =>
  stableStringify({
    intentId: record.intentId,
    idempotencyKey: record.idempotencyKey,
    kind: record.kind,
    environmentId: record.environmentId,
    createdAtMs: record.createdAtMs,
    unsigned: record.unsigned,
    spend: record.spend,
    params: record.params,
  });

const canonicalKey = (request: ForgeIntentRequest): string => {
  const rest = { ...request } as Record<string, unknown>;
  delete rest.idempotencyKey;
  return `${request.environmentId}:${request.kind}:${NodeCrypto.createHash("sha256")
    .update(stableStringify(rest))
    .digest("hex")
    .slice(0, 32)}`;
};

// ---------------------------------------------------------------------------
// The adapter service
// ---------------------------------------------------------------------------

/**
 * How long a built liquidity intent stays submittable: the deadline encoded
 * into modifyLiquidities is build time plus this window. Generous enough for
 * the supervised broadcast flow; a draft that outlives it reverts on chain
 * rather than executing — the safe direction.
 */
export const FORGE_LIQUIDITY_DEADLINE_SECONDS = 3600;

/** Validate one optional minimum-output leg; default 1 raw unit, never zero. */
const boundedMinOut = (
  raw: string | undefined,
  name: string,
): Effect.Effect<string, ForgeIntentBuildError> =>
  raw === undefined
    ? Effect.succeed("1")
    : isNonNegativeIntString(raw) && raw !== "0"
      ? Effect.succeed(raw)
      : new ForgeIntentBuildError({
          reason: "invalid-params",
          detail: `${name} must be a positive integer string`,
        });

export interface UniswapTestnetAdapterShape {
  readonly settings: Effect.Effect<ForgeTestnetSettings>;

  /** eth_chainId, checked against Sepolia — refuse to touch any other chain. */
  readonly checkChainId: Effect.Effect<
    | { readonly ok: true; readonly chainId: typeof SEPOLIA_CHAIN_ID }
    | { readonly ok: false; readonly reason: string }
  >;

  readonly readChainHead: Effect.Effect<
    | { readonly status: "ok"; readonly blockNumber: number; readonly timestampUnix: number }
    | { readonly status: "unavailable"; readonly reason: string }
  >;

  /** All hook views pinned to one block, with that block's timestamp. */
  readonly readHookState: Effect.Effect<ForgeHookStateRead>;

  readonly getPolicyEvents: (input: {
    readonly fromBlock: number;
    readonly toBlock: number;
  }) => Effect.Effect<ForgePolicyEventsRead>;

  /**
   * Resolve one transaction against the chain: receipt → settled; no receipt
   * and known to the node → submitted; past the bounded timeout or unknown
   * to the node → unknown. `nowMs` is supplied by the caller so tests (and
   * the service) control the clock without sleeping.
   */
  readonly resolveTransaction: (input: {
    readonly txHash: string;
    readonly submittedAtMs: number;
    readonly nowMs: number;
    readonly timeoutMs: number;
  }) => Effect.Effect<ForgeTransactionResolution, string>;

  /** Build (and durably record) an unsigned intent. Idempotent by key. */
  readonly buildIntent: (
    request: ForgeIntentRequest,
  ) => Effect.Effect<ForgeIntentRecord, ForgeIntentBuildError>;

  /**
   * The grant gate. Every refusal is a named `ForgeBroadcastRefused`; a
   * success means the injected broadcaster returned a tx hash and the record
   * is `submitted`. Broadcasting an already-submitted record returns it
   * unchanged — the idempotent re-check, never a second broadcast.
   */
  readonly broadcastIntent: (input: {
    readonly intent: ForgeIntentRecord;
  }) => Effect.Effect<{ readonly record: ForgeIntentRecord }, ForgeBroadcastRefused | string>;

  /** The uncertain-broadcast state machine over the intent ledger. */
  readonly reconcileIntent: (intentId: string) => Effect.Effect<ForgeIntentRecord | null, string>;

  /** Decode swap-fee evidence (LP vs total) from a receipt. */
  readonly readSwapFeeEvidence: (txHash: string) => Effect.Effect<ForgeSwapFeeEvidenceRead>;
}

export class UniswapTestnetAdapter extends Context.Service<
  UniswapTestnetAdapter,
  UniswapTestnetAdapterShape
>()("t3/trading/forge/UniswapTestnetAdapter") {}

/** The one configured target an intent kind may ever touch. */
const expectedTargetFor = (kind: ForgeIntentKind, target: ForgeTestnetTarget): string =>
  kind === "publish-policy" || kind === "revoke-policy" || kind === "pause" || kind === "unpause"
    ? target.hookAddress
    : kind === "initialize-pool"
      ? target.poolManager
      : kind === "add-liquidity" || kind === "remove-liquidity"
        ? target.positionManager
        : target.swapRoute;

export const makeUniswapTestnetAdapter = Effect.gen(function* () {
  const config = yield* ForgeTestnetConfig;
  const transport = yield* ForgeSepoliaTransport;
  const ledger = yield* ForgeIntentLedger;
  const broadcaster = yield* SignedTransactionBroadcaster;
  // Mandatory: without immutable approved-grant verification the broadcast
  // layer cannot even be constructed — the fail-closed shape of this seam.
  const grantGuard = yield* ForgeGrantGuard;

  const rpc = (method: string, params: ReadonlyArray<unknown>): Effect.Effect<unknown, string> =>
    transport.request(method, params);

  const rpcOrNull = (
    method: string,
    params: ReadonlyArray<unknown>,
  ): Effect.Effect<unknown | null, string> =>
    rpc(method, params).pipe(
      Effect.map((value) => (value === null || value === undefined ? null : value)),
    );

  const callView = (
    to: string,
    data: Hex,
    block: "latest" | { readonly hex: Hex },
  ): Effect.Effect<Hex, string> =>
    rpc("eth_call", [{ to, data }, block === "latest" ? "latest" : block.hex]).pipe(
      Effect.flatMap((result) =>
        typeof result === "string" && /^0x[0-9a-fA-F]*$/.test(result)
          ? Effect.succeed(result as Hex)
          : Effect.fail(`eth_call returned a non-hex result for ${to}`),
      ),
    );

  const checkChainId: UniswapTestnetAdapterShape["checkChainId"] = rpc("eth_chainId", []).pipe(
    Effect.map(
      (
        result,
      ):
        | { readonly ok: true; readonly chainId: typeof SEPOLIA_CHAIN_ID }
        | { readonly ok: false; readonly reason: string } => {
        const parsed = typeof result === "string" ? blockNumberOf(result) : null;
        if (parsed === SEPOLIA_CHAIN_ID) return { ok: true, chainId: SEPOLIA_CHAIN_ID };
        return {
          ok: false,
          reason: `chain id ${parsed ?? "unreadable"} at the configured endpoint; Forge writes only Sepolia (${SEPOLIA_CHAIN_ID})`,
        };
      },
    ),
    Effect.catch((cause) =>
      Effect.succeed({
        ok: false as const,
        reason: `eth_chainId failed: ${String(cause)}`,
      }),
    ),
  );

  const readChainHead: UniswapTestnetAdapterShape["readChainHead"] = Effect.gen(function* () {
    const block = yield* rpcOrNull("eth_getBlockByNumber", ["latest", false]);
    if (block === null || typeof block !== "object") {
      return {
        status: "unavailable" as const,
        reason: "eth_getBlockByNumber returned no latest block",
      };
    }
    const record = block as Record<string, unknown>;
    const blockNumber = blockNumberOf(record["number"]);
    const timestamp = blockNumberOf(record["timestamp"]);
    if (blockNumber === null || timestamp === null) {
      return { status: "unavailable" as const, reason: "latest block carried no number/timestamp" };
    }
    return { status: "ok" as const, blockNumber, timestampUnix: timestamp };
  }).pipe(
    Effect.catch((cause) =>
      Effect.succeed({
        status: "unavailable" as const,
        reason: `chain head read failed: ${String(cause)}`,
      }),
    ),
  );

  const decodePolicyTuple = (raw: unknown): ForgeHookState["policy"] | null => {
    // getPolicy returns one tuple with named components; viem may decode it
    // as an object or wrap it — accept the object form and the array form.
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
      const record = raw as Record<string, unknown>;
      const revisionStr = bigintValue(record["revision"]);
      const expiryStr = bigintValue(record["expiry"]);
      if (
        revisionStr === null ||
        expiryStr === null ||
        typeof record["evidenceDigest"] !== "string"
      ) {
        return null;
      }
      return {
        revision: revisionStr,
        expiryUnix: expiryStr,
        evidenceDigest: record["evidenceDigest"],
      };
    }
    if (Array.isArray(raw)) {
      const inner = Array.isArray(raw[0]) ? raw[0] : raw;
      const [revision, expiry, digest] = inner;
      const revisionStr = bigintValue(revision);
      const expiryStr = bigintValue(expiry);
      if (revisionStr === null || expiryStr === null || typeof digest !== "string") return null;
      return { revision: revisionStr, expiryUnix: expiryStr, evidenceDigest: digest };
    }
    return null;
  };

  const readHookState: UniswapTestnetAdapterShape["readHookState"] = Effect.gen(function* () {
    const settings = yield* config.resolve;
    if (!settings.configured || settings.target === undefined) {
      return {
        status: "unavailable" as const,
        reason: settings.reason ?? "forge sepolia target not configured",
      };
    }
    const target = settings.target;
    const head = yield* readChainHead;
    if (head.status !== "ok") {
      return { status: "unavailable" as const, reason: `cannot pin hook reads: ${head.reason}` };
    }
    const block = { hex: numberToHex(head.blockNumber) };

    // One pinned-block view call; decode failures are named, never guessed.
    const call = (fn: string, args: readonly unknown[] = []): Effect.Effect<unknown, string> =>
      callView(
        target.hookAddress,
        encodeFunctionData({
          abi: forgeHookAbi,
          functionName: fn,
          args: [...args] as readonly unknown[],
        }),
        block,
      ).pipe(
        Effect.flatMap((data) =>
          Effect.try({
            try: () => decodeFunctionResult({ abi: forgeHookAbi, functionName: fn, data }),
            catch: (cause): string => `hook view ${fn} decode failed: ${String(cause)}`,
          }),
        ),
      );

    const policyRaw = yield* call("getPolicy");
    const policy = decodePolicyTuple(policyRaw);
    if (policy === null) {
      return {
        status: "unavailable" as const,
        reason: "hook getPolicy returned an unreadable policy",
      };
    }
    const policyActive = yield* call("policyActive");
    const paused = yield* call("paused");
    const owner = yield* call("owner");
    const operator = yield* call("operator");
    const boundPoolId = yield* call("boundPoolId");
    const baseline = yield* call("BASELINE_FEE");
    const policyFee = yield* call("POLICY_FEE");
    // effectiveFee takes the BINDING id, never the hook's own address.
    const bindingId = forgeBindingId(target.poolKey);
    const effective = yield* call("effectiveFee", [bindingId]);
    const overrideRaw = yield* call("beforeSwapFeeOverride", [bindingId]);

    if (
      typeof policyActive !== "boolean" ||
      typeof paused !== "boolean" ||
      typeof owner !== "string" ||
      typeof operator !== "string" ||
      typeof boundPoolId !== "string" ||
      bigintValue(effective) === null ||
      bigintValue(overrideRaw) === null
    ) {
      return {
        status: "unavailable" as const,
        reason: "a hook view decoded to an unexpected type",
      };
    }

    const state: ForgeHookState = {
      hookAddress: target.hookAddress,
      chainId: SEPOLIA_CHAIN_ID,
      boundPoolId,
      policy,
      policyActive,
      paused,
      owner: owner.toLowerCase(),
      operator: operator.toLowerCase(),
      effectiveFeeHundredthsBps: Number(bigintValue(effective)),
      beforeSwapFeeOverrideRaw: bigintValue(overrideRaw)!,
      baselineFeeHundredthsBps: Number(baseline),
      policyFeeHundredthsBps: Number(policyFee),
      asOfBlockNumber: head.blockNumber,
      asOfBlockTimestampUnix: head.timestampUnix,
      fetchedAtMs: yield* Clock.currentTimeMillis,
    };
    return { status: "ok" as const, state };
  }).pipe(
    Effect.catch((cause) =>
      Effect.succeed({
        status: "unavailable" as const,
        reason: `hook state read failed: ${String(cause)}`,
      }),
    ),
  );

  const decodeHookLog = (log: Record<string, unknown>): ForgePolicyEvent | null => {
    try {
      const decoded = decodeEventLog({
        abi: forgeHookAbi,
        data: (log["data"] as Hex) ?? "0x",
        topics: [...(log["topics"] as readonly Hex[])] as [Hex, ...Hex[]],
      });
      const args = decoded.args as unknown as Record<string, unknown>;
      const blockNumber = blockNumberOf(log["blockNumber"]) ?? 0;
      const logIndex = Number(log["logIndex"] ?? 0);
      const txHash = typeof log["transactionHash"] === "string" ? log["transactionHash"] : "";
      if (decoded.eventName === "PolicyPublished") {
        return {
          kind: "PolicyPublished",
          blockNumber,
          logIndex,
          txHash,
          poolId: String(args["poolId"] ?? ""),
          revision: bigintValue(args["revision"]) ?? "0",
          expiryUnix: bigintValue(args["expiry"]) ?? "0",
          evidenceDigest: String(args["evidenceDigest"] ?? ""),
        };
      }
      if (decoded.eventName === "PolicyRevoked") {
        return {
          kind: "PolicyRevoked",
          blockNumber,
          logIndex,
          txHash,
          poolId: String(args["poolId"] ?? ""),
          revision: bigintValue(args["revision"]) ?? "0",
        };
      }
      if (decoded.eventName === "Paused") return { kind: "Paused", blockNumber, logIndex, txHash };
      if (decoded.eventName === "Unpaused")
        return { kind: "Unpaused", blockNumber, logIndex, txHash };
      if (decoded.eventName === "OperatorSet") {
        return {
          kind: "OperatorSet",
          blockNumber,
          logIndex,
          txHash,
          newOperator: String(args["newOperator"] ?? ""),
        };
      }
      return null;
    } catch {
      return null;
    }
  };

  const decodePoolLog = (log: Record<string, unknown>): ForgePoolEvent | null => {
    try {
      const decoded = decodeEventLog({
        abi: poolManagerAbi,
        data: (log["data"] as Hex) ?? "0x",
        topics: [...(log["topics"] as readonly Hex[])] as [Hex, ...Hex[]],
      });
      const args = decoded.args as unknown as Record<string, unknown>;
      const blockNumber = blockNumberOf(log["blockNumber"]) ?? 0;
      const logIndex = Number(log["logIndex"] ?? 0);
      const txHash = typeof log["transactionHash"] === "string" ? log["transactionHash"] : "";
      if (decoded.eventName === "Swap") {
        return {
          kind: "Swap",
          blockNumber,
          logIndex,
          txHash,
          poolId: String(args["id"] ?? ""),
          amount0: bigintValue(args["amount0"]) ?? "0",
          amount1: bigintValue(args["amount1"]) ?? "0",
          sqrtPriceX96: bigintValue(args["sqrtPriceX96"]) ?? "0",
          liquidity: bigintValue(args["liquidity"]) ?? "0",
          tick: numberValue(args["tick"]) ?? 0,
          totalSwapFeeHundredthsBps: Number(bigintValue(args["fee"]) ?? "0"),
        };
      }
      if (decoded.eventName === "Initialize") {
        return {
          kind: "Initialize",
          blockNumber,
          logIndex,
          txHash,
          poolId: String(args["id"] ?? ""),
          fee: Number(bigintValue(args["fee"]) ?? "0"),
          tickSpacing: numberValue(args["tickSpacing"]) ?? 0,
          hooks: String(args["hooks"] ?? "").toLowerCase(),
          sqrtPriceX96: bigintValue(args["sqrtPriceX96"]) ?? "0",
          tick: numberValue(args["tick"]) ?? 0,
        };
      }
      if (decoded.eventName === "ModifyLiquidity") {
        return {
          kind: "ModifyLiquidity",
          sender: String(args["sender"] ?? "").toLowerCase(),
          blockNumber,
          logIndex,
          txHash,
          poolId: String(args["id"] ?? ""),
          tickLower: numberValue(args["tickLower"]) ?? 0,
          tickUpper: numberValue(args["tickUpper"]) ?? 0,
          liquidityDelta: bigintValue(args["liquidityDelta"]) ?? "0",
          salt: String(args["salt"] ?? ""),
        };
      }
      return null;
    } catch {
      return null;
    }
  };

  const getPolicyEvents: UniswapTestnetAdapterShape["getPolicyEvents"] = ({ fromBlock, toBlock }) =>
    Effect.gen(function* () {
      const settings = yield* config.resolve;
      if (!settings.configured || settings.target === undefined) {
        return {
          status: "unavailable" as const,
          reason: settings.reason ?? "forge sepolia target not configured",
        };
      }
      const raw = yield* rpc("eth_getLogs", [
        {
          address: settings.target.hookAddress,
          fromBlock: numberToHex(fromBlock),
          toBlock: numberToHex(toBlock),
        },
      ]);
      if (!Array.isArray(raw)) {
        return { status: "unavailable" as const, reason: "eth_getLogs returned a non-array" };
      }
      const events: Array<ForgePolicyEvent> = [];
      for (const entry of raw) {
        if (typeof entry !== "object" || entry === null) continue;
        const decoded = decodeHookLog(entry as Record<string, unknown>);
        if (decoded !== null) events.push(decoded);
      }
      events.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
      return { status: "ok" as const, events };
    }).pipe(
      Effect.catch((cause) =>
        Effect.succeed({
          status: "unavailable" as const,
          reason: `policy event fetch failed: ${String(cause)}`,
        }),
      ),
    );

  const decodeReceipt = (
    receipt: Record<string, unknown>,
    target: ForgeTestnetTarget,
  ): ForgeReceiptSnapshot | { readonly reason: string } => {
    const status = blockNumberOf(receipt["status"]);
    const blockNumber = blockNumberOf(receipt["blockNumber"]);
    if (status === null || blockNumber === null) {
      return { reason: "receipt carried unreadable status/block fields" };
    }
    if (
      typeof receipt["gasUsed"] !== "string" ||
      typeof receipt["effectiveGasPrice"] !== "string"
    ) {
      return { reason: "receipt carried unreadable gas fields" };
    }
    const gasUsed = fromHex(receipt["gasUsed"] as Hex, "bigint");
    const gasPrice = fromHex(receipt["effectiveGasPrice"] as Hex, "bigint");

    const hookEvents: Array<ForgePolicyEvent> = [];
    const poolEvents: Array<ForgePoolEvent> = [];
    const logs = receipt["logs"];
    if (Array.isArray(logs)) {
      for (const entry of logs) {
        if (typeof entry !== "object" || entry === null) continue;
        const log = entry as Record<string, unknown>;
        const address = typeof log["address"] === "string" ? log["address"].toLowerCase() : "";
        if (address === target.hookAddress) {
          const decoded = decodeHookLog(log);
          if (decoded !== null) hookEvents.push(decoded);
        } else if (address === target.poolManager) {
          const decoded = decodePoolLog(log);
          if (decoded !== null) poolEvents.push(decoded);
        }
      }
    }
    return {
      txHash: typeof receipt["transactionHash"] === "string" ? receipt["transactionHash"] : "",
      status: status === 1 ? "confirmed" : "reverted",
      blockNumber,
      gasUsedUnits: gasUsed.toString(10),
      effectiveGasPriceWei: gasPrice.toString(10),
      gasCostWei: (gasUsed * gasPrice).toString(10),
      hookEvents,
      poolEvents,
    };
  };

  const resolveTransaction: UniswapTestnetAdapterShape["resolveTransaction"] = ({
    txHash,
    submittedAtMs,
    nowMs,
    timeoutMs,
  }) =>
    Effect.gen(function* () {
      const settings = yield* config.resolve;
      if (!settings.configured || settings.target === undefined) {
        return yield* Effect.fail(settings.reason ?? "forge sepolia target not configured");
      }
      const receipt = yield* rpcOrNull("eth_getTransactionReceipt", [txHash]);
      if (receipt !== null && typeof receipt === "object") {
        const decoded = decodeReceipt(receipt as Record<string, unknown>, settings.target);
        if ("reason" in decoded) return yield* Effect.fail(decoded.reason);
        return decoded.status === "confirmed"
          ? { state: "confirmed" as const, receipt: decoded }
          : { state: "reverted" as const, receipt: decoded };
      }
      const tx = yield* rpcOrNull("eth_getTransactionByHash", [txHash]);
      if (tx !== null) {
        if (nowMs - submittedAtMs > timeoutMs) {
          return { state: "unknown" as const, detail: "timeout-no-receipt" as const };
        }
        return { state: "submitted" as const, detail: "pending-in-mempool" as const };
      }
      return { state: "unknown" as const, detail: "tx-not-found" as const };
    });

  // ------------------------------------------------------------------ intents

  const validate = (
    condition: boolean,
    detail: string,
  ): Effect.Effect<void, ForgeIntentBuildError> =>
    condition ? Effect.void : new ForgeIntentBuildError({ reason: "invalid-params", detail });

  const buildIntent: UniswapTestnetAdapterShape["buildIntent"] = (request) =>
    Effect.gen(function* () {
      const settings = yield* config.resolve;
      if (!settings.configured || settings.target === undefined) {
        return yield* new ForgeIntentBuildError({
          reason: "unconfigured",
          detail: settings.reason ?? "forge sepolia target not configured",
        });
      }
      const target = settings.target;
      const poolKeyArgs: ReadonlyArray<string | number> = [
        target.poolKey.currency0,
        target.poolKey.currency1,
        target.poolKey.fee,
        target.poolKey.tickSpacing,
        target.poolKey.hookAddress,
      ];
      const createdAtMs = yield* Clock.currentTimeMillis;
      const requestFingerprint = canonicalKey(request);
      const targetFingerprint = immutableTargetFingerprint(target);
      const idempotencyKey = request.idempotencyKey ?? requestFingerprint;

      const existing = yield* ledger.findByIdempotencyKey(idempotencyKey);
      if (existing !== null) {
        // Idempotent build: the same key returns the durable record. A key
        // reused for a different KIND of intent is a caller bug and refuses.
        if (
          existing.kind !== request.kind ||
          existing.environmentId !== request.environmentId ||
          existing.params.requestFingerprint !== requestFingerprint ||
          existing.params.targetFingerprint !== targetFingerprint
        ) {
          return yield* new ForgeIntentBuildError({
            reason: "invalid-params",
            detail: `idempotency key '${idempotencyKey}' already names a ${existing.kind} intent (${existing.intentId})`,
          });
        }
        return existing;
      }

      const spend: {
        deposits?: ReadonlyArray<{ readonly token: string; readonly amountRaw: string }>;
        swapQuoteAmountRaw?: string;
      } = {};
      const params: Record<string, string> = { requestFingerprint, targetFingerprint };
      let data: Hex;
      let to: string;
      let summary: string;

      switch (request.kind) {
        case "publish-policy": {
          yield* validate(isHex32(request.bindingId), "bindingId must be a 32-byte hex value");
          yield* validate(
            isNonNegativeIntString(request.revision),
            "revision must be a non-negative integer string",
          );
          yield* validate(
            Number.isInteger(request.expiryUnix) && request.expiryUnix > 0,
            "expiryUnix must be a positive integer",
          );
          yield* validate(
            isHex32(request.evidenceDigest),
            "evidenceDigest must be a 32-byte hex value",
          );
          params.bindingId = request.bindingId;
          params.revision = request.revision;
          params.expiryUnix = String(request.expiryUnix);
          params.evidenceDigest = request.evidenceDigest;
          to = target.hookAddress;
          data = encodeFunctionData({
            abi: forgeHookAbi,
            functionName: "publishPolicy",
            args: [
              request.bindingId as Hex,
              BigInt(request.revision),
              BigInt(request.expiryUnix),
              request.evidenceDigest as Hex,
            ],
          });
          summary = `publish policy revision ${request.revision} expiry ${request.expiryUnix}`;
          break;
        }
        case "revoke-policy": {
          yield* validate(isHex32(request.bindingId), "bindingId must be a 32-byte hex value");
          params.bindingId = request.bindingId;
          to = target.hookAddress;
          data = encodeFunctionData({
            abi: forgeHookAbi,
            functionName: "revokePolicy",
            args: [request.bindingId as Hex],
          });
          summary = "revoke policy";
          break;
        }
        case "pause":
        case "unpause": {
          to = target.hookAddress;
          data = encodeFunctionData({ abi: forgeHookAbi, functionName: request.kind });
          summary = request.kind === "pause" ? "pause hook (baseline fee)" : "unpause hook";
          break;
        }
        case "initialize-pool": {
          yield* validate(
            isNonNegativeIntString(request.sqrtPriceX96) && request.sqrtPriceX96 !== "0",
            "sqrtPriceX96 must be a positive integer string",
          );
          params.sqrtPriceX96 = request.sqrtPriceX96;
          to = target.poolManager;
          data = encodeFunctionData({
            abi: poolManagerAbi,
            functionName: "initialize",
            args: [poolKeyArgs as unknown as readonly string[], BigInt(request.sqrtPriceX96)],
          });
          summary = `initialize pool sqrtPriceX96 ${request.sqrtPriceX96}`;
          break;
        }
        case "add-liquidity":
        case "remove-liquidity": {
          yield* validate(
            Number.isInteger(request.tickLower) &&
              Number.isInteger(request.tickUpper) &&
              request.tickLower < request.tickUpper,
            "tickLower must be an integer below tickUpper",
          );
          yield* validate(
            request.tickLower % target.poolKey.tickSpacing === 0 &&
              request.tickUpper % target.poolKey.tickSpacing === 0,
            `ticks must be multiples of the pool tick spacing ${target.poolKey.tickSpacing}`,
          );
          yield* validate(
            isNonNegativeIntString(request.liquidity) && request.liquidity !== "0",
            "liquidity must be a positive integer string",
          );
          params.tickLower = String(request.tickLower);
          params.tickUpper = String(request.tickUpper);
          params.liquidity = request.liquidity;
          params.salt = request.salt ?? ZERO_BYTES32;
          to = target.positionManager;

          const poolCurrencies: ReadonlyArray<`0x${string}`> = [
            target.poolKey.currency0,
            target.poolKey.currency1,
          ];
          // The on-chain pull/payout bounds, derived from declared deposits.
          // An add with no declared deposits is unprovable and refuses: the
          // encoded maxima, not self-reported metadata, are the guard.
          const depositByToken = new Map<string, string>();
          if (request.kind === "add-liquidity") {
            yield* validate(
              request.deposits.length > 0,
              "a liquidity add must declare its deposits",
            );
            for (const deposit of request.deposits) {
              yield* validate(
                isAddress(deposit.token),
                `deposit token ${deposit.token} is not an address`,
              );
              yield* validate(
                isNonNegativeIntString(deposit.amountRaw),
                `deposit amount for ${deposit.token} must be a non-negative integer string`,
              );
              const token = deposit.token.toLowerCase() as `0x${string}`;
              yield* validate(
                poolCurrencies.includes(token),
                `deposit token ${deposit.token} is not one of the pool currencies`,
              );
              // Duplicate tokens sum: the aggregate the cap must bound.
              const existing = depositByToken.get(token) ?? "0";
              depositByToken.set(
                token,
                (BigInt(existing) + BigInt(deposit.amountRaw)).toString(10),
              );
            }
            // The encoded maxima must sit at or below the grant cap floor at
            // build time; the broadcast re-checks against the live grant.
            const buildGrant = settings.grant;
            if (buildGrant !== undefined) {
              for (const [token, amount] of depositByToken) {
                const cap = buildGrant.tokenCaps.find((entry) => entry.token === token);
                yield* validate(
                  cap !== undefined && BigInt(amount) <= BigInt(cap.maxAmountRaw),
                  `deposit ${amount} exceeds the grant cap ${cap?.maxAmountRaw ?? "(none)"} for ${token}`,
                );
              }
            }
          }
          const amount0 = depositByToken.get(target.poolKey.currency0) ?? "0";
          const amount1 = depositByToken.get(target.poolKey.currency1) ?? "0";

          const deadlineUnix = Math.floor(createdAtMs / 1000) + FORGE_LIQUIDITY_DEADLINE_SECONDS;
          params.deadlineUnix = String(deadlineUnix);
          params.amount0Bound = request.kind === "add-liquidity" ? amount0 : "0";
          params.amount1Bound = request.kind === "add-liquidity" ? amount1 : "0";

          // One action per intent: MINT a new position, or INCREASE/DECREASE
          // an existing tokenId, through the deployed PositionManager's
          // modifyLiquidities (see PeripheryAbi for the pin).
          const nowAction =
            request.kind === "add-liquidity"
              ? request.tokenId === undefined
                ? POSITION_MANAGER_ACTIONS.MINT_POSITION
                : POSITION_MANAGER_ACTIONS.INCREASE_LIQUIDITY
              : POSITION_MANAGER_ACTIONS.DECREASE_LIQUIDITY;
          if (request.kind === "add-liquidity" && request.tokenId !== undefined) {
            yield* validate(
              isNonNegativeIntString(request.tokenId),
              "tokenId must be a non-negative integer string",
            );
            params.tokenId = request.tokenId;
            params.action = "increase";
          } else if (request.kind === "add-liquidity") {
            yield* validate(
              request.ownerAddress !== undefined && isAddress(request.ownerAddress),
              "a minted position must name an owner address",
            );
            params.action = "mint";
            params.owner = request.ownerAddress!.toLowerCase();
          } else {
            yield* validate(
              isNonNegativeIntString(request.tokenId),
              "remove-liquidity requires the NFT position tokenId (a non-negative integer string)",
            );
            params.tokenId = request.tokenId;
            params.action = "decrease";
          }

          const paramBytes =
            request.kind === "add-liquidity"
              ? request.tokenId === undefined
                ? encodeMintPositionParams({
                    poolKey: target.poolKey,
                    tickLower: request.tickLower,
                    tickUpper: request.tickUpper,
                    liquidity: request.liquidity,
                    amount0Max: amount0,
                    amount1Max: amount1,
                    owner: params.owner! as `0x${string}`,
                  })
                : encodeIncreaseLiquidityParams({
                    tokenId: request.tokenId,
                    liquidity: request.liquidity,
                    amount0Max: amount0,
                    amount1Max: amount1,
                  })
              : encodeDecreaseLiquidityParams({
                  tokenId: request.tokenId,
                  liquidity: request.liquidity,
                  // A nonzero minimum-out per leg: >0 default or an explicit
                  // user value. Zero would accept a fully-dusted removal.
                  amount0Min: yield* boundedMinOut(request.minAmount0Raw, "minAmount0Raw"),
                  amount1Min: yield* boundedMinOut(request.minAmount1Raw, "minAmount1Raw"),
                });
          if (request.kind === "add-liquidity") spend.deposits = request.deposits;
          data = encodeFunctionData({
            abi: positionManagerAbi,
            functionName: "modifyLiquidities",
            args: [
              encodeModifyLiquiditiesUnlockData([nowAction], [paramBytes]),
              BigInt(deadlineUnix),
            ],
          });
          summary = `${request.kind === "add-liquidity" ? (params.action === "mint" ? "mint" : "increase") : "decrease"} liquidity ${request.liquidity}${params.tokenId === undefined ? ` ticks [${request.tickLower}, ${request.tickUpper}]` : ` position ${params.tokenId}`}`;
          break;
        }
        case "bounded-swap": {
          yield* validate(typeof request.zeroForOne === "boolean", "zeroForOne must be a boolean");
          yield* validate(
            isSignedIntString(request.amountSpecifiedRaw) && request.amountSpecifiedRaw !== "0",
            "amountSpecifiedRaw must be a non-zero signed integer string",
          );
          yield* validate(
            isNonNegativeIntString(request.quoteAmountRaw),
            "quoteAmountRaw must be a non-negative integer string",
          );
          // An omitted or zero price limit is outside the usable TickMath
          // range and would revert (or bound nothing); machine-generated
          // bounded swaps always carry an explicit limit inside the open
          // interval. Direction-vs-current-price cannot be proven offline —
          // the interval bound is the hard execution bound, and zero fails
          // it like any other out-of-range value.
          yield* validate(
            isNonNegativeIntString(request.sqrtPriceLimitX96),
            "sqrtPriceLimitX96 is required and must be a non-negative integer string",
          );
          const limit = BigInt(request.sqrtPriceLimitX96);
          yield* validate(
            limit > V4_MIN_SQRT_PRICE && limit < V4_MAX_SQRT_PRICE,
            `sqrtPriceLimitX96 must lie strictly inside the TickMath interval (${V4_MIN_SQRT_PRICE}, ${V4_MAX_SQRT_PRICE})`,
          );
          params.zeroForOne = String(request.zeroForOne);
          params.amountSpecifiedRaw = request.amountSpecifiedRaw;
          params.sqrtPriceLimitX96 = request.sqrtPriceLimitX96;
          params.quoteAmountRaw = request.quoteAmountRaw;
          spend.swapQuoteAmountRaw = request.quoteAmountRaw;
          to = target.swapRoute;
          data = encodeFunctionData({
            abi: swapRouteAbi,
            functionName: "swap",
            args: [
              poolKeyArgs as unknown as readonly string[],
              [request.zeroForOne, BigInt(request.amountSpecifiedRaw), limit],
              [false, false],
              "0x",
            ],
          });
          summary = `bounded swap ${request.amountSpecifiedRaw} zeroForOne=${request.zeroForOne}`;
          break;
        }
        default:
          return yield* new ForgeIntentBuildError({
            reason: "invalid-params",
            detail: `unknown intent kind ${(request as { kind: string }).kind}`,
          });
      }

      const record: ForgeIntentRecord = {
        intentId: intentIdFor(idempotencyKey),
        idempotencyKey,
        kind: request.kind,
        environmentId: request.environmentId,
        createdAtMs,
        unsigned: { chainId: SEPOLIA_CHAIN_ID, to, data, valueWei: "0" },
        spend,
        status: "draft",
        gasAccounted: false,
        params,
        summary,
      };
      yield* ledger.upsert(record);
      return record;
    });

  const broadcastIntent: UniswapTestnetAdapterShape["broadcastIntent"] = ({ intent }) =>
    Effect.gen(function* () {
      const settings = yield* config.resolve;
      if (!settings.configured || settings.target === undefined) {
        return yield* new ForgeBroadcastRefused({
          reason: "unconfigured",
          detail: settings.reason ?? "forge sepolia target not configured",
        });
      }
      const target = settings.target;

      const stored = yield* ledger.find(intent.intentId);
      if (
        stored === null ||
        immutableIntentFingerprint(stored) !== immutableIntentFingerprint(intent)
      ) {
        return yield* new ForgeBroadcastRefused({
          reason: "idempotency-conflict",
          detail: "intent does not match its retained immutable transaction",
        });
      }
      if (stored.txHash !== undefined) return { record: stored };
      if (stored.status !== "draft") {
        return yield* new ForgeBroadcastRefused({
          reason: "idempotency-conflict",
          detail: "submission outcome is uncertain; reconcile before any new operation",
        });
      }

      // Target binding: the intent kind's one configured target, and nothing
      // else on any chain, may receive this transaction.
      const expected = expectedTargetFor(intent.kind, target);
      const allowed = new Set([
        target.hookAddress,
        target.poolManager,
        target.positionManager,
        target.swapRoute,
      ]);
      if (
        intent.params.targetFingerprint !== immutableTargetFingerprint(target) ||
        intent.unsigned.to !== expected ||
        !allowed.has(intent.unsigned.to) ||
        intent.unsigned.chainId !== SEPOLIA_CHAIN_ID
      ) {
        return yield* new ForgeBroadcastRefused({
          reason: "wrong-target",
          detail: `${intent.kind} intent targets ${intent.unsigned.to} on chain ${intent.unsigned.chainId}; only ${expected} on Sepolia is permitted`,
        });
      }

      // The F0 grant gate. No grant, no broadcast — the state this project
      // is in until the human records approved values.
      const grant = settings.grant;
      if (grant === undefined) {
        return yield* new ForgeBroadcastRefused({
          reason: "grant-missing",
          detail: settings.grantMissingReason ?? "no approved forge spend grant",
        });
      }

      const chain = yield* checkChainId;
      if (
        !chain.ok ||
        grant.chainId !== target.chainId ||
        grant.hookAddress !== target.hookAddress
      ) {
        return yield* new ForgeBroadcastRefused({
          reason: "wrong-target",
          detail: chain.ok ? "grant target does not match" : chain.reason,
        });
      }
      // Grant expiry is decided by chain time, never a client clock.
      const head = yield* readChainHead;
      if (head.status !== "ok") {
        return yield* new ForgeBroadcastRefused({
          reason: "chain-time-unavailable",
          detail: `cannot verify grant expiry against chain time: ${head.reason}`,
        });
      }
      if (grant.expiresAtUnix <= head.timestampUnix) {
        return yield* new ForgeBroadcastRefused({
          reason: "grant-expired",
          detail: `grant expired at ${grant.expiresAtUnix}; chain block timestamp is ${head.timestampUnix}`,
        });
      }

      // Immutable grant binding: the FIRST recorded sighting of this grantId
      // is the authority. A resolved grant that differs in any binding field
      // (chain, hook, operator, caps, budget, expiry) — for example after a
      // T3_FORGE_SEPOLIA_HOOK_ADDRESS change — is a retarget and refuses. A
      // guard that cannot answer is treated the same way: fail closed.
      const verdict = yield* grantGuard.recordOrVerify(grant).pipe(
        Effect.catch((cause): Effect.Effect<ForgeGrantGuardVerdict, never> =>
          Effect.succeed({
            status: "retarget",
            detail: `immutable grant verification failed: ${String(cause)}`,
          }),
        ),
      );
      if (verdict.status === "retarget") {
        return yield* new ForgeBroadcastRefused({
          reason: "wrong-target",
          detail: verdict.detail,
        });
      }

      // Per-token deposit caps and the per-swap quote cap.
      if (intent.spend.deposits !== undefined) {
        for (const deposit of intent.spend.deposits) {
          const cap = grant.tokenCaps.find((entry) => entry.token === deposit.token.toLowerCase());
          if (cap === undefined) {
            return yield* new ForgeBroadcastRefused({
              reason: "over-cap",
              detail: `token ${deposit.token} is not covered by grant ${grant.grantId}`,
            });
          }
          if (BigInt(deposit.amountRaw) > BigInt(cap.maxAmountRaw)) {
            return yield* new ForgeBroadcastRefused({
              reason: "over-cap",
              detail: `deposit ${deposit.amountRaw} exceeds the grant cap ${cap.maxAmountRaw} for ${deposit.token}`,
            });
          }
        }
      }
      if (intent.spend.swapQuoteAmountRaw !== undefined) {
        if (BigInt(intent.spend.swapQuoteAmountRaw) > BigInt(grant.perSwapMaxQuoteRaw)) {
          return yield* new ForgeBroadcastRefused({
            reason: "over-cap",
            detail: `swap quote leg ${intent.spend.swapQuoteAmountRaw} exceeds the per-swap grant cap ${grant.perSwapMaxQuoteRaw}`,
          });
        }
      }

      // Settled gas is an early refusal only. The mandatory durable admission
      // below must reserve the enforceable transaction maximum before signing.
      const accounted = BigInt(yield* ledger.totalAccountedGasWei);
      if (accounted >= BigInt(grant.aggregateGasBudgetWei)) {
        return yield* new ForgeBroadcastRefused({
          reason: "budget-exhausted",
          detail: `aggregate gas ${accounted} wei already at or past the grant budget ${grant.aggregateGasBudgetWei} wei`,
        });
      }

      // The execution ladder every intent — policy, liquidity, or swap — now
      // climbs: (1) validated, bounded calldata encoded at build time against
      // the pinned deployed periphery; (2) the immutable approved-grant
      // binding verified above; (3) the MANDATORY durable admission claim
      // below (an in-memory or missing claim implementation refuses, and a
      // claim on a record without enforceable gas fields refuses — until the
      // prepared-transaction pass stamps them, nothing can pass here); and
      // (4) the signer-broadcaster seam, which still refuses with
      // broadcaster-missing until the supervised live pass wires a
      // grant-controlled signer. Nothing new can execute; the machinery above
      // it is real.
      if (ledger.durableAdmission === undefined) {
        return yield* new ForgeBroadcastRefused({
          reason: "execution-unavailable",
          detail: "durable atomic submission and gas reservation are not configured",
        });
      }
      const claimed = yield* ledger.durableAdmission.claim(
        stored,
        grant.grantId,
        grant.aggregateGasBudgetWei,
      );
      if (!claimed) {
        return yield* new ForgeBroadcastRefused({
          reason: "idempotency-conflict",
          detail: "intent is already claimed or the gas reservation was refused",
        });
      }
      // A durable unknown claim survives interruption, ambiguous transport
      // errors, and process death. Never turn it back into a retryable draft.
      const sent = yield* broadcaster.broadcast({ transaction: stored.unsigned, intent: stored });
      const nowMs = yield* Clock.currentTimeMillis;
      const submitted: ForgeIntentRecord = {
        ...intent,
        status: "submitted",
        txHash: sent.txHash,
        submittedAtMs: nowMs,
      };
      yield* ledger.upsert(submitted);
      return { record: submitted };
    }).pipe(
      Effect.catchTag("ForgeBroadcastRefused", (refused) =>
        Effect.gen(function* () {
          // The refusal is durable too: an audit trail of why nothing moved,
          // marked on the LEDGER's copy so a stale caller record cannot
          // clobber newer state.
          const current = yield* ledger.find(intent.intentId);
          if (current !== null && current.txHash === undefined) {
            const nowMs = yield* Clock.currentTimeMillis;
            yield* ledger.upsert({
              ...current,
              lastRefusal: { reason: refused.reason, detail: refused.detail, refusedAtMs: nowMs },
            });
          }
          return yield* new ForgeBroadcastRefused({
            reason: refused.reason,
            detail: refused.detail,
          });
        }),
      ),
    );

  const reconcileIntent: UniswapTestnetAdapterShape["reconcileIntent"] = (intentId) =>
    Effect.gen(function* () {
      const record = yield* ledger.find(intentId);
      if (record === null) return null;
      // Terminal states are immutable; reconciling them again must not
      // re-count gas or move anything. Drafts have nothing on chain.
      if (
        record.status === "confirmed" ||
        record.status === "reverted" ||
        record.status === "draft"
      ) {
        return record;
      }
      const txHash = record.txHash;
      const submittedAtMs = record.submittedAtMs;
      if (txHash === undefined || submittedAtMs === undefined) return record;

      const settings = yield* config.resolve;
      if (
        settings.target === undefined ||
        record.params.targetFingerprint !== immutableTargetFingerprint(settings.target)
      ) {
        return yield* Effect.fail("intent belongs to another or unconfigured execution target");
      }
      const timeoutMs = settings.target.reconciliationTimeoutMs;
      const nowMs = yield* Clock.currentTimeMillis;
      const resolution = yield* resolveTransaction({ txHash, submittedAtMs, nowMs, timeoutMs });

      if (resolution.state === "confirmed" || resolution.state === "reverted") {
        const settled: ForgeIntentRecord = {
          ...record,
          status: resolution.state,
          settledAtBlockNumber: resolution.receipt.blockNumber,
          gasCostWei: resolution.receipt.gasCostWei,
          // Exactly once: gas enters the aggregate budget on settlement and
          // never again, however many times reconcile runs.
          gasAccounted: true,
          receipt: resolution.receipt,
        };
        yield* ledger.upsert(settled);
        // Release the admission reservation against the actual cost. Failure
        // here leaves the reservation held — the safe direction — and the
        // open-intent sweep settles it later.
        if (ledger.settleGas !== undefined) {
          yield* ledger
            .settleGas(settled.intentId, resolution.receipt.gasCostWei)
            .pipe(
              Effect.catch((cause) =>
                Effect.logWarning(
                  `forge intent ${settled.intentId} gas settle failed: ${String(cause)}`,
                ),
              ),
            );
        }
        return settled;
      }
      if (resolution.state === "unknown" && record.status !== "unknown") {
        const unknown: ForgeIntentRecord = { ...record, status: "unknown" };
        yield* ledger.upsert(unknown);
        return unknown;
      }
      return record;
    });

  const readSwapFeeEvidence: UniswapTestnetAdapterShape["readSwapFeeEvidence"] = (txHash) =>
    Effect.gen(function* () {
      const settings = yield* config.resolve;
      if (!settings.configured || settings.target === undefined) {
        return {
          status: "unavailable" as const,
          reason: settings.reason ?? "forge sepolia target not configured",
        };
      }
      const target = settings.target;
      const receipt = yield* rpcOrNull("eth_getTransactionReceipt", [txHash]);
      if (receipt === null || typeof receipt !== "object") {
        return { status: "unavailable" as const, reason: `no receipt for ${txHash}` };
      }
      const decoded = decodeReceipt(receipt as Record<string, unknown>, target);
      if ("reason" in decoded) {
        return { status: "unavailable" as const, reason: decoded.reason };
      }
      if (decoded.status !== "confirmed") {
        return { status: "unavailable" as const, reason: `transaction ${txHash} is not confirmed` };
      }
      const swaps = decoded.poolEvents.filter(
        (event): event is Extract<ForgePoolEvent, { readonly kind: "Swap" }> =>
          event.kind === "Swap",
      );
      if (swaps.length === 0) {
        return {
          status: "unavailable" as const,
          reason: `receipt ${txHash} carries no PoolManager Swap event`,
        };
      }
      const ourPoolId = forgeFullPoolId(target.poolKey).toLowerCase();

      const entries: Array<ForgeSwapFeeEntry> = [];
      for (const swap of swaps) {
        const inOurPool = swap.poolId.toLowerCase() === ourPoolId;
        // End-of-block state can include later policy writes; latest state
        // is even less specific. Neither proves this swap's executed split.
        entries.push({
          poolId: swap.poolId,
          inOurPool,
          totalSwapFeeHundredthsBps: swap.totalSwapFeeHundredthsBps,
          lpFeeHundredthsBps: null,
          lpFeeAsOf: null,
          protocolFeeHundredthsBps: null,
        });
      }
      return {
        status: "ok" as const,
        evidence: { txHash, blockNumber: decoded.blockNumber, swaps: entries },
      };
    }).pipe(
      Effect.catch((cause) =>
        Effect.succeed({
          status: "unavailable" as const,
          reason: `swap fee evidence read failed: ${String(cause)}`,
        }),
      ),
    );

  return UniswapTestnetAdapter.of({
    settings: config.resolve,
    checkChainId,
    readChainHead,
    readHookState,
    getPolicyEvents,
    resolveTransaction,
    buildIntent,
    broadcastIntent,
    reconcileIntent,
    readSwapFeeEvidence,
  });
});

/**
 * Open about its four dependencies. Tests inject the fake transport, the
 * in-memory ledger, and a fake (or refusing) broadcaster; the wiring point
 * composes the live HTTP transport and — only at the supervised live pass —
 * the grant-controlled signer.
 */
export const UniswapTestnetAdapterLive = Layer.effect(
  UniswapTestnetAdapter,
  makeUniswapTestnetAdapter,
);
