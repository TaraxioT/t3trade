/**
 * The one chain Forge may ever write: Ethereum Sepolia, official Uniswap v4
 * addresses, and the F0 spend-grant shape every broadcast is gated on.
 *
 * Configuration only — no RPC, no signing, no chain access. The adapter
 * (`UniswapTestnetAdapter.ts`) resolves these settings per call, so a grant
 * approved or revoked by the human takes effect without a restart.
 *
 * The F0 grant is deliberately absent until the human records concrete
 * values. A missing grant is not an error to paper over: it is the state in
 * which every chain-mutating path must refuse.
 *
 * @module ForgeSepoliaTarget
 */

/** Sepolia's chain id. The adapter refuses any other chain. */
export const SEPOLIA_CHAIN_ID = 11155111;

/**
 * Official Uniswap v4 deployments on Sepolia (chain 11155111), verbatim from
 * the official deployments page,
 * https://developers.uniswap.org/llms.mdx/docs/protocols/v4/deployments
 * (fetched 2026-09-12; each entry links sepolia.etherscan.io there). v4-core
 * itself carries no per-chain addresses — these are periphery deployer
 * addresses — so the docs page is the source. Hosts may override the
 * periphery choices through env, but not the chain id.
 */
export const SEPOLIA_V4_ADDRESSES = {
  /** PoolManager — v4 pool state and swaps. */
  poolManager: "0xE03A1074c86CFeDd5C142C4F04F1a1536e203543",
  /** PositionManager — official periphery liquidity entry point. */
  positionManager: "0x429ba70129df741B2Ca2a85BC3A2a3328e5c09b4",
  /** StateView lens. Kept for reference; the adapter reads hook views directly. */
  stateView: "0xe1dd9c3fa50edb962e442f60dfbc432e24537e4c",
  /** V4Quoter lens. Reference only. */
  quoter: "0x61b3f2011a92d183c7dbadbda940a7555ccf9227",
  /**
   * The bounded-swap route: the official `PoolSwapTest` helper deployed on
   * Sepolia. One `swap(key, params, testSettings, hookData)` call settles a
   * swap against the PoolManager without the Universal Router's command
   * encoding; it exists on the official deployments page exactly for this.
   */
  swapRoute: "0x9b6b46e2c869aa39918db7f52f5557fe577b6eee",
  /** Permit2 — the official allowance layer PositionManager pulls through. */
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
} as const;

/**
 * v4 fee flags, verified against the pinned v4-core at
 * contracts/forge/lib/v4-core/src/libraries/LPFeeLibrary.sol:
 * `DYNAMIC_FEE_FLAG = 0x800000`, `OVERRIDE_FEE_FLAG = 0x400000`.
 * A Forge pool is ALWAYS initialized with the dynamic flag — the stored pool
 * fee stays 0 and every swap's fee comes from the hook's override, so fee
 * evidence is read from hook views and Swap receipts, never from the pool.
 */
export const V4_DYNAMIC_FEE_FLAG = 0x800000;
export const V4_OVERRIDE_FEE_FLAG = 0x400000;

/** v4 tick-spacing bounds from the pinned v4-core `TickSpacing` checks. */
export const V4_MIN_TICK_SPACING = 1;
export const V4_MAX_TICK_SPACING = 32768;

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const NON_NEGATIVE_INTEGER = /^-?[0-9]+$/;

/** True for a checksummed-or-lowercase 20-byte hex address. */
export const isEvmAddress = (value: string): boolean => EVM_ADDRESS.test(value);

/** True for a base-10 non-negative integer string (raw token/gas amounts). */
export const isNonNegativeIntegerString = (value: string): boolean =>
  NON_NEGATIVE_INTEGER.test(value) && !value.startsWith("-");

/** Numeric address comparison; v4 requires `currency0 < currency1`. */
export const sortsBefore = (a: string, b: string): boolean =>
  BigInt(a.toLowerCase()) < BigInt(b.toLowerCase());

/** The full pool identity the adapter encodes everywhere, fee always dynamic. */
export interface ForgePoolKeyConfig {
  /** The lower currency by address sort order. */
  readonly currency0: string;
  /** The higher currency by address sort order. */
  readonly currency1: string;
  /** Always {@link V4_DYNAMIC_FEE_FLAG}; not configurable. */
  readonly fee: typeof V4_DYNAMIC_FEE_FLAG;
  readonly tickSpacing: number;
  /** The one fixed hook this pool is governed by. */
  readonly hookAddress: string;
}

/** Resolved execution target: Sepolia, one hook, one pool, official periphery. */
export interface ForgeTestnetTarget {
  readonly chainId: typeof SEPOLIA_CHAIN_ID;
  readonly rpcUrl: string;
  readonly hookAddress: string;
  readonly poolKey: ForgePoolKeyConfig;
  readonly poolManager: string;
  readonly positionManager: string;
  readonly swapRoute: string;
  /** A submitted-but-unsettled tx becomes `unknown` after this long. */
  readonly reconciliationTimeoutMs: number;
}

/**
 * The F0 spend grant: the only authority a Forge broadcast may draw on.
 * A versioned grant names chain id, exact pair caps, per-swap max, aggregate
 * gas budget, operator and expiry — never invented, never borrowed from a
 * Hyperliquid mission. All amounts are raw base-10 integer strings so the
 * grant stays exact and JSON-transportable.
 */
export interface ForgeSpendGrant {
  readonly grantId: string;
  readonly chainId: typeof SEPOLIA_CHAIN_ID;
  readonly hookAddress: string;
  /** Per-token deposit caps, raw units; a token absent here cannot be deposited. */
  readonly tokenCaps: ReadonlyArray<{ readonly token: string; readonly maxAmountRaw: string }>;
  /** Maximum quote-leg size of one bounded swap, raw units. */
  readonly perSwapMaxQuoteRaw: string;
  /** Aggregate gas the grant may ever spend, wei. */
  readonly aggregateGasBudgetWei: string;
  /** The operator the hook must have authorized for policy writes. */
  readonly operatorAddress: string;
  /** Unix seconds; chain time (not a client clock) decides whether it has lapsed. */
  readonly expiresAtUnix: number;
}

export interface ForgeTestnetSettings {
  /** False when the target itself is not configured; `reason` names the vars. */
  readonly configured: boolean;
  readonly reason?: string;
  readonly target?: ForgeTestnetTarget;
  /** Present only when the F0 grant values exist and are coherent. */
  readonly grant?: ForgeSpendGrant;
  /** Why there is no grant — the honest state until the human records one. */
  readonly grantMissingReason?: string;
}

const toPositiveIntOr = (raw: string | undefined, fallback: number): number => {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export const DEFAULT_RECONCILIATION_TIMEOUT_MS = 300_000;

/**
 * The grant's env names, one list so the missing-grant reason can name them.
 * Exported for the evidence file and tests only.
 */
export const FORGE_GRANT_ENV_VARS = [
  "T3_FORGE_GRANT_ID",
  "T3_FORGE_GRANT_TOKEN0_CAP_RAW",
  "T3_FORGE_GRANT_TOKEN1_CAP_RAW",
  "T3_FORGE_GRANT_PER_SWAP_MAX_QUOTE_RAW",
  "T3_FORGE_GRANT_AGGREGATE_GAS_WEI",
  "T3_FORGE_GRANT_OPERATOR_ADDRESS",
  "T3_FORGE_GRANT_EXPIRES_AT_UNIX",
] as const;

interface RawEnv {
  readonly T3_FORGE_SEPOLIA_RPC_URL?: string;
  readonly T3_FORGE_SEPOLIA_HOOK_ADDRESS?: string;
  readonly T3_FORGE_SEPOLIA_CURRENCY0?: string;
  readonly T3_FORGE_SEPOLIA_CURRENCY1?: string;
  readonly T3_FORGE_SEPOLIA_TICK_SPACING?: string;
  readonly T3_FORGE_SEPOLIA_POOL_MANAGER?: string;
  readonly T3_FORGE_SEPOLIA_POSITION_MANAGER?: string;
  readonly T3_FORGE_SEPOLIA_SWAP_ROUTE?: string;
  readonly T3_FORGE_RECONCILIATION_TIMEOUT_MS?: string;
  readonly T3_FORGE_GRANT_ID?: string;
  readonly T3_FORGE_GRANT_TOKEN0_CAP_RAW?: string;
  readonly T3_FORGE_GRANT_TOKEN1_CAP_RAW?: string;
  readonly T3_FORGE_GRANT_PER_SWAP_MAX_QUOTE_RAW?: string;
  readonly T3_FORGE_GRANT_AGGREGATE_GAS_WEI?: string;
  readonly T3_FORGE_GRANT_OPERATOR_ADDRESS?: string;
  readonly T3_FORGE_GRANT_EXPIRES_AT_UNIX?: string;
}

/**
 * Read the Forge execution target out of an env bag. Exposed for tests.
 *
 * Missing required variables produce `configured: false` with the names in
 * the reason. The pool fee is not configurable — a Forge pool is dynamic-fee
 * by construction — and the currencies must arrive sorted as v4 requires.
 */
export const resolveForgeTestnetTarget = (env: RawEnv): ForgeTestnetTarget | { reason: string } => {
  const required: ReadonlyArray<[keyof RawEnv, string]> = [
    ["T3_FORGE_SEPOLIA_RPC_URL", "T3_FORGE_SEPOLIA_RPC_URL"],
    ["T3_FORGE_SEPOLIA_HOOK_ADDRESS", "T3_FORGE_SEPOLIA_HOOK_ADDRESS"],
    ["T3_FORGE_SEPOLIA_CURRENCY0", "T3_FORGE_SEPOLIA_CURRENCY0"],
    ["T3_FORGE_SEPOLIA_CURRENCY1", "T3_FORGE_SEPOLIA_CURRENCY1"],
    ["T3_FORGE_SEPOLIA_TICK_SPACING", "T3_FORGE_SEPOLIA_TICK_SPACING"],
  ];
  const missing = required.filter(([key]) => {
    const value = env[key];
    return value === undefined || value.trim() === "";
  });
  if (missing.length > 0) {
    return {
      reason: `forge sepolia target not configured (missing ${missing.map(([, name]) => name).join(", ")})`,
    };
  }

  const rpcUrl = env.T3_FORGE_SEPOLIA_RPC_URL!.trim();
  if (!rpcUrl.startsWith("https://")) {
    return { reason: "T3_FORGE_SEPOLIA_RPC_URL must be an https JSON-RPC endpoint" };
  }

  const hookAddress = env.T3_FORGE_SEPOLIA_HOOK_ADDRESS!.trim();
  const currency0 = env.T3_FORGE_SEPOLIA_CURRENCY0!.trim();
  const currency1 = env.T3_FORGE_SEPOLIA_CURRENCY1!.trim();
  if (!isEvmAddress(hookAddress)) {
    return { reason: "T3_FORGE_SEPOLIA_HOOK_ADDRESS is not a 20-byte address" };
  }
  if (!isEvmAddress(currency0) || !isEvmAddress(currency1)) {
    return { reason: "T3_FORGE_SEPOLIA_CURRENCY0/1 must both be 20-byte addresses" };
  }
  if (!sortsBefore(currency0, currency1)) {
    return {
      reason: "pool currencies must be sorted: T3_FORGE_SEPOLIA_CURRENCY0 sorts below CURRENCY1",
    };
  }

  const tickSpacing = Number(env.T3_FORGE_SEPOLIA_TICK_SPACING!.trim());
  if (
    !Number.isInteger(tickSpacing) ||
    tickSpacing < V4_MIN_TICK_SPACING ||
    tickSpacing > V4_MAX_TICK_SPACING
  ) {
    return {
      reason: `T3_FORGE_SEPOLIA_TICK_SPACING must be an integer in [${V4_MIN_TICK_SPACING}, ${V4_MAX_TICK_SPACING}]`,
    };
  }

  const optionalAddress = (
    raw: string | undefined,
    fallback: string,
  ): string | { reason: string } => {
    const value = raw?.trim();
    if (value === undefined || value === "") return fallback.toLowerCase();
    if (!isEvmAddress(value))
      return { reason: "optional sepolia address override is not a 20-byte address" };
    return value.toLowerCase();
  };

  const poolManager = optionalAddress(
    env.T3_FORGE_SEPOLIA_POOL_MANAGER,
    SEPOLIA_V4_ADDRESSES.poolManager,
  );
  if (typeof poolManager !== "string") return poolManager;
  const positionManager = optionalAddress(
    env.T3_FORGE_SEPOLIA_POSITION_MANAGER,
    SEPOLIA_V4_ADDRESSES.positionManager,
  );
  if (typeof positionManager !== "string") return positionManager;
  const swapRoute = optionalAddress(
    env.T3_FORGE_SEPOLIA_SWAP_ROUTE,
    SEPOLIA_V4_ADDRESSES.swapRoute,
  );
  if (typeof swapRoute !== "string") return swapRoute;

  return {
    chainId: SEPOLIA_CHAIN_ID,
    rpcUrl,
    hookAddress: hookAddress.toLowerCase(),
    poolKey: {
      currency0: currency0.toLowerCase(),
      currency1: currency1.toLowerCase(),
      fee: V4_DYNAMIC_FEE_FLAG,
      tickSpacing,
      hookAddress: hookAddress.toLowerCase(),
    },
    poolManager,
    positionManager,
    swapRoute,
    reconciliationTimeoutMs: toPositiveIntOr(
      env.T3_FORGE_RECONCILIATION_TIMEOUT_MS,
      DEFAULT_RECONCILIATION_TIMEOUT_MS,
    ),
  };
};

/**
 * Read the F0 spend grant out of an env bag — all values or none. Partial
 * grants do not exist: a half-specified budget is exactly the invented
 * budget the F3 gate forbids, so one missing variable means no grant and the
 * reason names every variable the human still has to record.
 */
export const resolveForgeSpendGrant = (
  env: RawEnv,
  expected: { readonly chainId: number; readonly hookAddress: string },
): ForgeSpendGrant | { reason: string } => {
  const missing = FORGE_GRANT_ENV_VARS.filter((name) => {
    const value = env[name];
    return value === undefined || value.trim() === "";
  });
  if (missing.length > 0) {
    return { reason: `no approved forge spend grant (missing ${missing.join(", ")})` };
  }

  const grantId = env.T3_FORGE_GRANT_ID!.trim();
  const cap0 = env.T3_FORGE_GRANT_TOKEN0_CAP_RAW!.trim();
  const cap1 = env.T3_FORGE_GRANT_TOKEN1_CAP_RAW!.trim();
  const perSwap = env.T3_FORGE_GRANT_PER_SWAP_MAX_QUOTE_RAW!.trim();
  const gasBudget = env.T3_FORGE_GRANT_AGGREGATE_GAS_WEI!.trim();
  const operator = env.T3_FORGE_GRANT_OPERATOR_ADDRESS!.trim();
  const expiry = Number(env.T3_FORGE_GRANT_EXPIRES_AT_UNIX!.trim());

  for (const [name, value] of [
    ["T3_FORGE_GRANT_TOKEN0_CAP_RAW", cap0],
    ["T3_FORGE_GRANT_TOKEN1_CAP_RAW", cap1],
    ["T3_FORGE_GRANT_PER_SWAP_MAX_QUOTE_RAW", perSwap],
    ["T3_FORGE_GRANT_AGGREGATE_GAS_WEI", gasBudget],
  ] as const) {
    if (!isNonNegativeIntegerString(value)) {
      return { reason: `${name} must be a non-negative base-10 integer string` };
    }
  }
  if (!isEvmAddress(operator)) {
    return { reason: "T3_FORGE_GRANT_OPERATOR_ADDRESS is not a 20-byte address" };
  }
  if (!Number.isInteger(expiry) || expiry <= 0) {
    return { reason: "T3_FORGE_GRANT_EXPIRES_AT_UNIX must be a positive unix seconds integer" };
  }

  const grant: ForgeSpendGrant = {
    grantId,
    chainId: SEPOLIA_CHAIN_ID,
    hookAddress: expected.hookAddress,
    tokenCaps: [],
    perSwapMaxQuoteRaw: perSwap,
    aggregateGasBudgetWei: gasBudget,
    operatorAddress: operator.toLowerCase(),
    expiresAtUnix: expiry,
  };
  // The grant target binding: a grant naming another hook or chain is not a
  // grant for this deployment. Chain id is fixed by construction here.
  if (expected.chainId !== SEPOLIA_CHAIN_ID) {
    return { reason: "spend grant chain id does not match the sepolia target" };
  }
  return grant;
};

/**
 * Target and grant in one resolved bag. A broken target hides the grant (its
 * caps are meaningless without a target); a missing grant never breaks the
 * target — reads still work, only broadcasts refuse.
 */
export const resolveForgeTestnetSettings = (env: RawEnv): ForgeTestnetSettings => {
  const target = resolveForgeTestnetTarget(env);
  if ("reason" in target) {
    return { configured: false, reason: target.reason };
  }
  const settings: ForgeTestnetSettings = {
    configured: true,
    target,
    grantMissingReason: "no approved forge spend grant",
  };
  const rawGrant: Record<string, string | undefined> = {};
  for (const name of FORGE_GRANT_ENV_VARS) rawGrant[name] = env[name];
  // The token cap entries must reference the configured pair addresses, so
  // the grant resolver receives them from the target once it exists.
  const grant = resolveForgeSpendGrant(env, {
    chainId: target.chainId,
    hookAddress: target.hookAddress,
  });
  if ("reason" in grant) {
    return { ...settings, grantMissingReason: grant.reason };
  }
  const tokenCaps = [
    { token: target.poolKey.currency0, maxAmountRaw: env.T3_FORGE_GRANT_TOKEN0_CAP_RAW!.trim() },
    { token: target.poolKey.currency1, maxAmountRaw: env.T3_FORGE_GRANT_TOKEN1_CAP_RAW!.trim() },
  ];
  return { ...settings, grant: { ...grant, tokenCaps } };
};
