/**
 * Pinned ABI fragments and encoders for the official Uniswap v4 periphery
 * this adapter writes through, plus the swap route.
 *
 * Pin source (verified contract source read from sepolia.etherscan.io,
 * chain 11155111, read 2026-09-12):
 *  - PositionManager 0x429ba70129df741B2Ca2a85BC3A2a3328e5c09b4:
 *    `modifyLiquidities(bytes unlockData, uint256 deadline)` where
 *    unlockData = abi.encode(bytes actions, bytes[] params) (BaseActionsRouter
 *    decodeActions). Deployed `_handleAction` param tuples, exactly as
 *    implemented on chain:
 *      INCREASE_LIQUIDITY = 0x00: (uint256 tokenId, uint256 liquidity,
 *        uint128 amount0Max, uint128 amount1Max, bytes hookData)
 *      DECREASE_LIQUIDITY = 0x01: (uint256 tokenId, uint256 liquidity,
 *        uint128 amount0Min, uint128 amount1Min, bytes hookData)
 *      MINT_POSITION = 0x02: (PoolKey poolKey, int24 tickLower, int24 tickUpper,
 *        uint256 liquidity, uint128 amount0Max, uint128 amount1Max,
 *        address owner, bytes hookData) — NO salt; the tokenId is the salt.
 *      BURN_POSITION = 0x03: (uint256 tokenId, uint128 amount0Min,
 *        uint128 amount1Min, bytes hookData)
 *    Payment is pulled through Permit2; approvals are live-pass setup.
 *  - PoolSwapTest 0x9b6b46e2c869aa39918db7f52f5557fe577b6eee:
 *    `swap(PoolManagerKey key, SwapParams params, TestSettings testSettings,
 *    bytes hookData) payable returns (int256 delta)` with
 *    TestSettings = (bool takeClaims, bool settleUsingBurn).
 *
 * TickMath bounds are cross-checked against the vendored v4-core at
 * contracts/forge/lib/v4-core/src/libraries/TickMath.sol.
 *
 * @module PeripheryAbi
 */
import { encodeAbiParameters, parseAbi, parseAbiParameters, type Abi, type Hex } from "viem";

// ---------------------------------------------------------------------------
// PositionManager — modifyLiquidities entrypoint
// ---------------------------------------------------------------------------

/** Action codes as dispatched by the deployed PositionManager `_handleAction`. */
export const POSITION_MANAGER_ACTIONS = {
  INCREASE_LIQUIDITY: 0x00,
  DECREASE_LIQUIDITY: 0x01,
  MINT_POSITION: 0x02,
  BURN_POSITION: 0x03,
} as const;

/** The deployed PositionManager's single unlocked entrypoint. */
export const positionManagerAbi = parseAbi([
  "function modifyLiquidities(bytes unlockData, uint256 deadline)",
]) as unknown as Abi;

/** The PoolKey tuple type every periphery action carries, declared once. */
const POOL_KEY_TYPE =
  "(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)";

const MINT_PARAMS = parseAbiParameters(
  `${POOL_KEY_TYPE} poolKey, int24 tickLower, int24 tickUpper, uint256 liquidity, uint128 amount0Max, uint128 amount1Max, address owner, bytes hookData`,
);
const INCREASE_PARAMS = parseAbiParameters(
  "uint256 tokenId, uint256 liquidity, uint128 amount0Max, uint128 amount1Max, bytes hookData",
);
const DECREASE_PARAMS = parseAbiParameters(
  "uint256 tokenId, uint256 liquidity, uint128 amount0Min, uint128 amount1Min, bytes hookData",
);
const UNLOCK_DATA_PARAMS = parseAbiParameters("bytes actions, bytes[] params");

export interface PeripheryPoolKeyArgs {
  /** Address-bearing fields are hex strings as viem types them. */
  readonly currency0: `0x${string}`;
  readonly currency1: `0x${string}`;
  readonly fee: number;
  readonly tickSpacing: number;
  readonly hookAddress: `0x${string}`;
}

/** MINT_POSITION params: a new position identified by its future tokenId. */
export const encodeMintPositionParams = (input: {
  readonly poolKey: PeripheryPoolKeyArgs;
  readonly tickLower: number;
  readonly tickUpper: number;
  readonly liquidity: string;
  /** On-chain pull ceiling for the pool's currency0; the grant cap floor. */
  readonly amount0Max: string;
  /** On-chain pull ceiling for the pool's currency1; the grant cap floor. */
  readonly amount1Max: string;
  readonly owner: `0x${string}`;
}): Hex =>
  encodeAbiParameters(MINT_PARAMS, [
    {
      currency0: input.poolKey.currency0,
      currency1: input.poolKey.currency1,
      fee: input.poolKey.fee,
      tickSpacing: input.poolKey.tickSpacing,
      hooks: input.poolKey.hookAddress,
    },
    input.tickLower,
    input.tickUpper,
    BigInt(input.liquidity),
    BigInt(input.amount0Max),
    BigInt(input.amount1Max),
    input.owner,
    "0x",
  ]);

/** INCREASE_LIQUIDITY params: add liquidity to an existing tokenId. */
export const encodeIncreaseLiquidityParams = (input: {
  readonly tokenId: string;
  readonly liquidity: string;
  readonly amount0Max: string;
  readonly amount1Max: string;
}): Hex =>
  encodeAbiParameters(INCREASE_PARAMS, [
    BigInt(input.tokenId),
    BigInt(input.liquidity),
    BigInt(input.amount0Max),
    BigInt(input.amount1Max),
    "0x",
  ]);

/** DECREASE_LIQUIDITY params: remove liquidity from an existing tokenId. */
export const encodeDecreaseLiquidityParams = (input: {
  readonly tokenId: string;
  readonly liquidity: string;
  readonly amount0Min: string;
  readonly amount1Min: string;
}): Hex =>
  encodeAbiParameters(DECREASE_PARAMS, [
    BigInt(input.tokenId),
    BigInt(input.liquidity),
    BigInt(input.amount0Min),
    BigInt(input.amount1Min),
    "0x",
  ]);

/** unlockData = abi.encode(bytes actions, bytes[] params), one entry per action. */
export const encodeModifyLiquiditiesUnlockData = (
  actions: ReadonlyArray<number>,
  params: ReadonlyArray<Hex>,
): Hex =>
  encodeAbiParameters(UNLOCK_DATA_PARAMS, [
    `0x${actions.map((action) => action.toString(16).padStart(2, "0")).join("")}`,
    [...params],
  ]);

// ---------------------------------------------------------------------------
// PoolSwapTest — the bounded swap route
// ---------------------------------------------------------------------------

/**
 * The official Sepolia PoolSwapTest route. `TestSettings(false, false)`:
 * take no ERC-6909 claims, settle by paying tokens (the ERC-20 path).
 */
export const swapRouteAbi = parseAbi([
  "function swap((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, (bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96) params, (bool takeClaims, bool settleUsingBurn) testSettings, bytes hookData) payable returns (int256 delta)",
]) as unknown as Abi;

// ---------------------------------------------------------------------------
// TickMath bounds (pinned v4-core TickMath.sol)
// ---------------------------------------------------------------------------

/** The smallest usable sqrt price; a swap limit must stay strictly above it. */
export const V4_MIN_SQRT_PRICE = 4295128739n;
/** The largest usable sqrt price; a swap limit must stay strictly below it. */
export const V4_MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n;
