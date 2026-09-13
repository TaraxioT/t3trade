/**
 * UniswapQuoteService — exact-input quotes over Sepolia with fresh route
 * validation (P5 slice 2).
 *
 * What this module is:
 *
 * - The approved-route registry (`T3_SWAP_ROUTES`): the vetted-allowlist
 *   discipline GraphSource applies to pools, applied to swap routes. The
 *   registry ships EMPTY on purpose — unlike the three vetted mainnet pools,
 *   no Sepolia pool identity can be verified from this repository offline, so
 *   a code-declared default set would be an unverified claim about where a
 *   swap executes. The live setup declares every route; there is no default
 *   set for the environment to narrow, which is why there is no narrowing
 *   step here at all.
 * - `quoteExactInput`: one read-only `eth_call` against the route's quoter,
 *   folded into an immutable `SwapQuoteRecord` whose id is derived from its
 *   content. A repricing is a NEW record (new quotedAtMs at minimum, so a new
 *   id) — never a mutation of a retained one. The service is stateless and
 *   deterministic from its inputs; retaining what an envelope binds to is
 *   P5.3/P5.4's job.
 *
 * What this module is NOT (by scope, enforced by construction):
 *
 * - No intent building, no admission, no idempotency ledger — P5.4.
 * - No signer, no broadcast, no private-key material anywhere.
 * - Nothing that could reach Hyperliquid or weaken a trading guard; the only
 *   side effect is one JSON-RPC read through the shared
 *   `ForgeSepoliaTransport` the forge adapter already uses.
 *
 * Every outcome is named: `quoted` or `refused` with a reason string. The
 * service never throws and never clamps an amount — a malformed or
 * out-of-range input is a refusal the caller can show, not a smaller number
 * nobody asked for.
 *
 * @module UniswapQuoteService
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Layer, Schema } from "effect";
import { keccak256, toBytes } from "viem";

import {
  EXECUTION_ENVELOPE_MAX_SLIPPAGE_BPS,
  SwapQuoteRecord,
  swapQuoteId,
} from "@t3tools/trading-contracts";

import { ForgeSepoliaTransport } from "./UniswapTestnetAdapter.ts";
import { V4_MAX_TICK_SPACING, V4_MIN_TICK_SPACING } from "./SepoliaTarget.ts";
import { SpotMainnetTransport } from "./SpotMainnetTarget.ts";
import { encodeProtectedExactInput, type ProtectedSwapPlan } from "./MainnetProtectedRouter.ts";
import {
  QUOTE_EXACT_AMOUNT_MAX,
  decodeQuoteExactInputSingleResult,
  encodeQuoteExactInputSingle,
} from "./QuoterAbi.ts";
import { forgeSha256Hex } from "./CapabilitySandbox.ts";
import { forgeJsonEncode } from "./ForgeJsonEncode.ts";

// ---------------------------------------------------------------------------
// The approved-route registry
// ---------------------------------------------------------------------------

/** Sepolia's chain id as the route vocabulary carries it (decimal string). */
export const SWAP_ROUTE_SEPOLIA_CHAIN_ID = "11155111";

/** Ethereum mainnet's chain id as the route vocabulary carries it (decimal string). */
export const SWAP_ROUTE_MAINNET_CHAIN_ID = "1";

/** The native-currency marker: address(0) names native ETH in a route's token pair. */
export const SWAP_NATIVE_CURRENCY_ADDRESS = `0x${"0".repeat(40)}`;

/** The one routing vocabulary; anything else is refused by name. */
export type SwapRouteType = "v4-exact-input-single" | "ur-v3-exact-input";

/**
 * One approved swap route: the exact pool, direction, and quoter a quote or
 * (later, P5.4) an exact-input intent may use. Addresses are validated and
 * lowercased at resolution so quote identities stay byte-deterministic
 * regardless of the config's casing.
 *
 * Two route families exist, discriminated by `routeType`:
 *
 * - `v4-exact-input-single` (Sepolia drafts): a v4 PoolSwapTest target with
 *   the pool key the test contract settles against. This family produces
 *   UNPROTECTED draft bytes only — admission always ends at the
 *   broadcaster-missing refusal.
 * - `ur-v3-exact-input` (the protected mainnet lane): a Universal Router
 *   target over one v3 pool identified by `weth`/`feeTier` and the ERC20
 *   side, where exactly one of tokenIn/tokenOut is the native-currency
 *   marker. Quotes on this family carry the full v3 execution identity
 *   (block, code hashes, measured fees) and only the protected admission
 *   service may prepare them.
 */
export interface SwapRouteSpecBase {
  /** Registry identity; proposals and quote records bind to it. */
  readonly routeId: string;
  readonly routeType: SwapRouteType;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly quoterAddress: string;
  /**
   * The exact-input target a prepared transaction is addressed to: the v4
   * PoolSwapTest helper for drafts, the Universal Router for the protected
   * lane. Required per route so a route can never be quotable but not
   * executable.
   */
  readonly swapTargetAddress: string;
  /** Display label for surfaces; never parsed, never an identity. */
  readonly label?: string;
}

export interface V4SwapRouteSpec extends SwapRouteSpecBase {
  readonly routeType: "v4-exact-input-single";
  readonly chainId: typeof SWAP_ROUTE_SEPOLIA_CHAIN_ID;
  readonly poolKey: {
    readonly currency0: string;
    readonly currency1: string;
    readonly fee: number;
    readonly tickSpacing: number;
    readonly hooks: string;
  };
  /** currency0 -> currency1 when true; must agree with tokenIn/tokenOut. */
  readonly zeroForOne: boolean;
}

export interface UrV3SwapRouteSpec extends SwapRouteSpecBase {
  readonly routeType: "ur-v3-exact-input";
  readonly chainId: typeof SWAP_ROUTE_MAINNET_CHAIN_ID;
  /** The canonical WETH9 the v3 pool trades against the native side. */
  readonly weth: string;
  /** The v3 pool's fee tier in hundredths of a bip (500 = 0.05%). */
  readonly feeTier: number;
  /** The ERC20 side of the pool (exactly one route side is the native marker). */
  readonly erc20: string;
}

export type SwapRouteSpec = V4SwapRouteSpec | UrV3SwapRouteSpec;

/**
 * The route-config digest (the quote-identity field `routeConfigDigest`):
 * SHA-256 over the canonical key-sorted JSON of the RESOLVED route spec.
 * Admission recomputes it from the CURRENT registry, so a config change —
 * different pool, target, quoter, or fee tier — invalidates every retained
 * quote for that routeId, exactly as 03 requires ("reject old config even
 * when routeId is unchanged").
 */
export const swapRouteConfigDigest = (route: SwapRouteSpec): string => {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (typeof value === "object" && value !== null) {
      const source = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(source).sort()) {
        if (source[key] === undefined) continue;
        out[key] = canonical(source[key]);
      }
      return out;
    }
    return value;
  };
  // Bare 64-hex to match the contracts' Sha256Hex identity pattern (no 0x).
  return forgeSha256Hex(forgeJsonEncode(canonical(route)));
};

/** Resolved route settings. `configured: false` carries the named reason. */
export interface SwapRouteSettings {
  readonly configured: boolean;
  readonly reason?: string;
  readonly routes?: ReadonlyArray<SwapRouteSpec>;
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Read the approved swap-route registry out of an env bag. Exposed for tests.
 *
 * `T3_SWAP_ROUTES` is a JSON array of route specs. Absent or empty means an
 * honestly unconfigured registry (there is NO default set — see the module
 * note); malformed JSON, a non-array payload, or any invalid entry refuses
 * the WHOLE registry with a reason naming the variable, the entry index, and
 * the offending value where one exists (an unknown routeType is named so
 * UniswapX/order/bridge-style configs are refused by name, never silently).
 */
export const resolveSwapRouteSettings = (
  env: Record<string, string | undefined>,
): SwapRouteSettings => {
  const raw = env.T3_SWAP_ROUTES?.trim();
  if (raw === undefined || raw === "") {
    return { configured: false, reason: "no swap routes are configured (T3_SWAP_ROUTES)" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    return { configured: false, reason: `T3_SWAP_ROUTES is not valid JSON: ${String(cause)}` };
  }
  if (!Array.isArray(parsed)) {
    return { configured: false, reason: "T3_SWAP_ROUTES must be a JSON array of route specs" };
  }

  const routes: Array<SwapRouteSpec> = [];
  const seen = new Set<string>();
  for (let index = 0; index < parsed.length; index += 1) {
    const refuse = (detail: string): SwapRouteSettings => ({
      configured: false,
      reason: `T3_SWAP_ROUTES entry ${index}: ${detail}`,
    });
    const entry = parsed[index];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return refuse("route spec is not an object");
    }
    const record = entry as Record<string, unknown>;

    const routeId = record["routeId"];
    if (typeof routeId !== "string" || routeId.trim() === "") {
      return refuse("routeId must be a non-empty string");
    }
    const id = routeId.trim();
    if (seen.has(id)) {
      return refuse(`duplicate routeId '${id}'`);
    }
    const routeType = record["routeType"];
    if (routeType !== "v4-exact-input-single" && routeType !== "ur-v3-exact-input") {
      return refuse(
        `unsupported routeType '${String(routeType)}' — only 'v4-exact-input-single' and 'ur-v3-exact-input' are supported (UniswapX, order, and bridge routes are refused by name)`,
      );
    }
    const chainId = record["chainId"];
    const expectedChain =
      routeType === "v4-exact-input-single"
        ? SWAP_ROUTE_SEPOLIA_CHAIN_ID
        : SWAP_ROUTE_MAINNET_CHAIN_ID;
    if (chainId !== expectedChain) {
      return refuse(
        `chainId must be "${expectedChain}" for routeType ${routeType}, got '${String(chainId)}'`,
      );
    }

    // Addresses: 20-byte hex, stored lowercase as the canonical identity.
    const addressField = (value: unknown): string | null =>
      typeof value === "string" && EVM_ADDRESS.test(value.trim())
        ? value.trim().toLowerCase()
        : null;
    const tokenIn = addressField(record["tokenIn"]);
    if (tokenIn === null) return refuse("tokenIn is not a 20-byte address");
    const tokenOut = addressField(record["tokenOut"]);
    if (tokenOut === null) return refuse("tokenOut is not a 20-byte address");
    const quoterAddress = addressField(record["quoterAddress"]);
    if (quoterAddress === null) return refuse("quoterAddress is not a 20-byte address");
    // Required per route (P5.4): the swap target a prepared exact-input
    // transaction is addressed to. A route without one can be priced but
    // never executed, so it is refused at resolution, not at execution.
    const swapTargetAddress = addressField(record["swapTargetAddress"]);
    if (swapTargetAddress === null) return refuse("swapTargetAddress is not a 20-byte address");
    if (swapTargetAddress === quoterAddress) {
      return refuse("swapTargetAddress must differ from quoterAddress");
    }
    if (tokenIn === tokenOut) {
      return refuse("tokenIn and tokenOut must differ");
    }
    if (record["label"] !== undefined && typeof record["label"] !== "string") {
      return refuse("label must be a string when present");
    }
    const label = record["label"];

    if (routeType === "ur-v3-exact-input") {
      // The protected mainnet family: exactly one side is the native marker,
      // the other names the ERC20; `weth` carries the canonical WETH9 the
      // pool trades; `feeTier` names the one v3 pool. The Universal Router
      // target is mandatory and must not be the native marker.
      const weth = addressField(record["weth"]);
      if (weth === null) return refuse("weth is not a 20-byte address");
      if (weth === SWAP_NATIVE_CURRENCY_ADDRESS) {
        return refuse("weth must be the canonical WETH9 contract, not the native marker");
      }
      const feeTier = record["feeTier"];
      if (
        typeof feeTier !== "number" ||
        !Number.isInteger(feeTier) ||
        feeTier < 0 ||
        feeTier > 1_000_000
      ) {
        return refuse("feeTier must be an integer in [0, 1000000] (v3 hundredths of a bip)");
      }
      const nativeSides =
        (tokenIn === SWAP_NATIVE_CURRENCY_ADDRESS ? 1 : 0) +
        (tokenOut === SWAP_NATIVE_CURRENCY_ADDRESS ? 1 : 0);
      if (nativeSides !== 1) {
        return refuse(
          "exactly one of tokenIn/tokenOut must be the native marker 0x0 for a ur-v3 route",
        );
      }
      const erc20 = tokenIn === SWAP_NATIVE_CURRENCY_ADDRESS ? tokenOut : tokenIn;
      if (erc20 === weth) {
        return refuse("the ERC20 side must differ from weth");
      }
      seen.add(id);
      routes.push({
        routeId: id,
        chainId: SWAP_ROUTE_MAINNET_CHAIN_ID,
        routeType,
        tokenIn,
        tokenOut,
        quoterAddress,
        swapTargetAddress,
        weth,
        feeTier,
        erc20,
        ...(label === undefined ? {} : { label }),
      });
      continue;
    }

    // The v4 draft family: the pool key and its direction.
    const poolKeyRaw = record["poolKey"];
    if (typeof poolKeyRaw !== "object" || poolKeyRaw === null || Array.isArray(poolKeyRaw)) {
      return refuse("poolKey is not an object");
    }
    const poolKeyRecord = poolKeyRaw as Record<string, unknown>;
    const currency0 = addressField(poolKeyRecord["currency0"]);
    if (currency0 === null) return refuse("poolKey.currency0 is not a 20-byte address");
    const currency1 = addressField(poolKeyRecord["currency1"]);
    if (currency1 === null) return refuse("poolKey.currency1 is not a 20-byte address");
    const hooks = addressField(poolKeyRecord["hooks"]);
    if (hooks === null) return refuse("poolKey.hooks is not a 20-byte address");
    const fee = poolKeyRecord["fee"];
    if (typeof fee !== "number" || !Number.isInteger(fee) || fee < 0 || fee > 1_000_000) {
      return refuse("poolKey.fee must be an integer in [0, 1000000]");
    }
    const tickSpacing = poolKeyRecord["tickSpacing"];
    if (
      typeof tickSpacing !== "number" ||
      !Number.isInteger(tickSpacing) ||
      tickSpacing < V4_MIN_TICK_SPACING ||
      tickSpacing > V4_MAX_TICK_SPACING
    ) {
      return refuse(
        `poolKey.tickSpacing must be an integer in [${V4_MIN_TICK_SPACING}, ${V4_MAX_TICK_SPACING}]`,
      );
    }
    if (typeof record["zeroForOne"] !== "boolean") {
      return refuse("zeroForOne must be a boolean");
    }
    const zeroForOne = record["zeroForOne"];

    // A v4 exact-input-single quote/swap is only defined for the pool's own
    // currency pair, with the direction implied by which side tokenIn is. A
    // route that disagrees could never produce an honest quote — every call
    // would revert at the pool — so it is refused here, with the reason
    // naming the inconsistency instead of a runtime RPC error naming nothing.
    const tokenIsPoolPair =
      (tokenIn === currency0 && tokenOut === currency1) ||
      (tokenIn === currency1 && tokenOut === currency0);
    if (!tokenIsPoolPair) {
      return refuse("tokenIn/tokenOut must be the pool's currency0/currency1 pair");
    }
    if (zeroForOne !== (tokenIn === currency0)) {
      return refuse("zeroForOne must be true exactly when tokenIn is poolKey.currency0");
    }

    seen.add(id);
    routes.push({
      routeId: id,
      chainId: SWAP_ROUTE_SEPOLIA_CHAIN_ID,
      routeType,
      tokenIn,
      tokenOut,
      quoterAddress,
      swapTargetAddress,
      poolKey: { currency0, currency1, fee, tickSpacing, hooks },
      zeroForOne,
      ...(label === undefined ? {} : { label }),
    });
  }
  return { configured: true, routes };
};

/** Route lookup over resolved settings; null when the id is not approved. */
export const routeFor = (settings: SwapRouteSettings, routeId: string): SwapRouteSpec | null => {
  if (!settings.configured || settings.routes === undefined) return null;
  return settings.routes.find((route) => route.routeId === routeId) ?? null;
};

/** Per-call resolution, so a route changed between reads takes effect without a restart. */
export class SwapRouteConfig extends Context.Service<
  SwapRouteConfig,
  { readonly resolve: Effect.Effect<SwapRouteSettings> }
>()("t3/trading/forge/UniswapQuoteService/SwapRouteConfig") {}

export const SwapRouteConfigLive = Layer.succeed(
  SwapRouteConfig,
  SwapRouteConfig.of({
    resolve: Effect.sync(() => resolveSwapRouteSettings(process.env)),
  }),
);

// ---------------------------------------------------------------------------
// The quote service
// ---------------------------------------------------------------------------

/** Default and floor for a quote's lifetime. Below the floor a quote would
 *  expire inside the pricing round trip, so the floor is enforced upward. */
export const QUOTE_TTL_DEFAULT_MS = 30_000;
export const QUOTE_TTL_MIN_MS = 1_000;

/**
 * DRAFT-ONLY gas placeholder, wei: 400k gas units at a 100 gwei ceiling.
 * Used solely by the Sepolia v4 draft lane, whose submission refusal is
 * UNCONDITIONAL — those bytes are never signable, so the placeholder can
 * only over-reserve an inspectable draft, never under-reserve a spend. The
 * protected mainnet lane never uses it: its quotes carry measured
 * `gasUnitsMeasured` × `maxFeePerGasWei` worst-case reservations, and a fee
 * that cannot be bounded refuses the quote outright.
 */
export const QUOTE_GAS_ESTIMATE_WEI_PLACEHOLDER = "40000000000000000";

export interface QuoteExactInputInput {
  readonly routeId: string;
  /** Exact input amount, raw units; a positive decimal integer string. */
  readonly amountInRaw: string;
  /** Caller-supplied quote time, so tests and callers control the clock. */
  readonly now: number;
  /** Quote lifetime; defaults to {@link QUOTE_TTL_DEFAULT_MS}, floored at 1s. */
  readonly quoteTtlMs?: number;
  /**
   * Slippage allowance applied to the quoted output, bps. Defaults to 0 — an
   * exact quote; the policy layer passes its own envelope-capped value.
   */
  readonly maxSlippageBps?: number;
}

export type SwapQuoteOutcome =
  | { readonly status: "quoted"; readonly record: SwapQuoteRecord }
  | { readonly status: "refused"; readonly reason: string };

export interface UniswapQuoteServiceShape {
  readonly quoteExactInput: (input: QuoteExactInputInput) => Effect.Effect<SwapQuoteOutcome>;
}

export class UniswapQuoteService extends Context.Service<
  UniswapQuoteService,
  UniswapQuoteServiceShape
>()("t3/trading/forge/UniswapQuoteService") {}

/**
 * URLs are the only credential-bearing text the RPC failure channel can
 * carry (provider keys ride the rpcUrl path), so they never survive into a
 * refusal reason.
 */
const redactRpcDetail = (detail: string): string =>
  detail.replace(/https?:\/\/[^\s"'<>]+/g, "[redacted-url]");

const POSITIVE_DECIMAL = /^(0|[1-9][0-9]*)$/;

const decodeQuoteRecord = Schema.decodeUnknownEffect(SwapQuoteRecord);

// ---------------------------------------------------------------------------
// The mainnet QuoterV2 v3 codec (pinned; see the artifact for probes)
// ---------------------------------------------------------------------------

/**
 * The deployed mainnet QuoterV2's `quoteExactInputSingle` signature, verified
 * LIVE against 0x61fFE014bA17989E743c5F6cB21bF9697530B21e (2026-09-13): the
 * current v3-periphery interface
 * https://raw.githubusercontent.com/Uniswap/v3-periphery/main/contracts/interfaces/IQuoterV2.sol
 * declares `(address tokenIn, address tokenOut, uint256 amountIn, uint24 fee,
 * uint160 sqrtPriceLimitX96)` — selector 0xc6a5026a, confirmed by a
 * successful mainnet eth_call in both directions. The older 4-field shape and
 * the bool-variant shape both revert on this deployment.
 */
const QUOTERV2_EXACT_INPUT_SINGLE_SELECTOR = "0xc6a5026a";

const padUint = (value: bigint): string => value.toString(16).padStart(64, "0");
const padAddress = (value: string): string =>
  value.toLowerCase().replace(/^0x/, "").padStart(64, "0");

/** Calldata for the QuoterV2 exact-input-single quote; read-only, no value. */
const encodeQuoterV2ExactInputSingle = (input: {
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly amountIn: bigint;
  readonly fee: number;
}): string =>
  QUOTERV2_EXACT_INPUT_SINGLE_SELECTOR +
  padAddress(input.tokenIn) +
  padAddress(input.tokenOut) +
  padUint(input.amountIn) +
  padUint(BigInt(input.fee)) +
  padUint(0n);

/** The quoter's static four-word return, or null when the shape is wrong. */
const decodeQuoterV2Result = (
  data: unknown,
): { readonly amountOut: bigint; readonly gasEstimate: bigint } | null => {
  if (typeof data !== "string" || !data.startsWith("0x") || data.length !== 2 + 64 * 4) return null;
  const body = data.slice(2);
  if (!/^[0-9a-fA-F]+$/.test(body)) return null;
  return {
    amountOut: BigInt(`0x${body.slice(0, 64)}`),
    gasEstimate: BigInt(`0x${body.slice(64 * 3, 64 * 4)}`),
  };
};

/** keccak256 hex of runtime code bytes, the target-code identity quotes pin. */
const codeHashOf = (code: unknown): string | null => {
  if (typeof code !== "string" || !code.startsWith("0x") || code.length <= 2) return null;
  try {
    return keccak256(toBytes(code as `0x${string}`));
  } catch {
    return null;
  }
};

/** Decimal-string → BigInt; null on anything inexact. */
const exactDecimal = (value: string | undefined | null): bigint | null =>
  typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value) ? BigInt(value) : null;

export const makeUniswapQuoteService = Effect.gen(function* () {
  const routeConfig = yield* SwapRouteConfig;
  const transport = yield* ForgeSepoliaTransport;
  // The mainnet lane is OPTIONAL at composition: runtimes that have not wired
  // a mainnet RPC still quote Sepolia drafts, and a ur-v3 route refuses by
  // name instead of dying at layer build (the runtimeLayer compatibility
  // rule — a new required dep would break the existing wiring).
  const mainnetTransportOption = yield* Effect.serviceOption(SpotMainnetTransport);

  const quoteExactInput = (input: QuoteExactInputInput): Effect.Effect<SwapQuoteOutcome> =>
    Effect.gen(function* () {
      const settings = yield* routeConfig.resolve;
      if (!settings.configured) {
        return {
          status: "refused" as const,
          reason: `unconfigured: ${settings.reason ?? "swap routes are not configured"}`,
        };
      }
      const route = routeFor(settings, input.routeId);
      if (route === null) {
        return {
          status: "refused" as const,
          reason: `route-unapproved: ${input.routeId} is not in the approved route registry`,
        };
      }
      if (
        typeof input.amountInRaw !== "string" ||
        !POSITIVE_DECIMAL.test(input.amountInRaw) ||
        BigInt(input.amountInRaw) <= 0n
      ) {
        return {
          status: "refused" as const,
          reason: "invalid-amount: amountInRaw must be a positive decimal integer string",
        };
      }
      // The quoter's params field is uint128; an amount beyond it cannot be
      // encoded, so it is refused here rather than thrown by the codec.
      if (BigInt(input.amountInRaw) > QUOTE_EXACT_AMOUNT_MAX) {
        return {
          status: "refused" as const,
          reason: "invalid-amount: amountInRaw exceeds the uint128 quoter bound",
        };
      }
      const slippageBps = input.maxSlippageBps ?? 0;
      if (
        !Number.isInteger(slippageBps) ||
        slippageBps < 0 ||
        slippageBps > EXECUTION_ENVELOPE_MAX_SLIPPAGE_BPS
      ) {
        return {
          status: "refused" as const,
          reason: `invalid-slippage: maxSlippageBps must be an integer in [0, ${EXECUTION_ENVELOPE_MAX_SLIPPAGE_BPS}]`,
        };
      }
      if (!Number.isSafeInteger(input.now) || input.now < 0) {
        return {
          status: "refused" as const,
          reason: "invalid-clock: now must be a nonnegative safe integer",
        };
      }
      if (
        input.quoteTtlMs !== undefined &&
        (!Number.isSafeInteger(input.quoteTtlMs) || input.quoteTtlMs < 0)
      ) {
        return {
          status: "refused" as const,
          reason: "invalid-ttl: quoteTtlMs must be a nonnegative safe integer",
        };
      }
      const ttlMs = Math.max(QUOTE_TTL_MIN_MS, input.quoteTtlMs ?? QUOTE_TTL_DEFAULT_MS);
      if (!Number.isSafeInteger(input.now + ttlMs)) {
        return {
          status: "refused" as const,
          reason: "invalid-ttl: expiry exceeds the safe integer range",
        };
      }

      if (route.routeType === "ur-v3-exact-input") {
        return yield* quoteUrV3ExactInput(route, input, slippageBps, ttlMs);
      }

      // One read-only eth_call against the route's quoter at the chain head.
      // The same failure/redaction discipline as the adapter's callView: an
      // RPC error or a non-hex result is a named unavailability.
      const data = encodeQuoteExactInputSingle({
        poolKey: {
          currency0: route.poolKey.currency0 as `0x${string}`,
          currency1: route.poolKey.currency1 as `0x${string}`,
          fee: route.poolKey.fee,
          tickSpacing: route.poolKey.tickSpacing,
          hooks: route.poolKey.hooks as `0x${string}`,
        },
        zeroForOne: route.zeroForOne,
        exactAmountRaw: input.amountInRaw,
      });
      const call = yield* transport
        .request("eth_call", [{ to: route.quoterAddress, data }, "latest"])
        .pipe(
          Effect.mapError(redactRpcDetail),
          Effect.map((value): { readonly ok: true; readonly value: unknown } => ({
            ok: true,
            value,
          })),
          Effect.catch((reason): Effect.Effect<{ readonly ok: false; readonly reason: string }> =>
            Effect.succeed({ ok: false, reason }),
          ),
        );
      if (!call.ok) {
        return { status: "refused" as const, reason: `quote-unavailable: ${call.reason}` };
      }
      if (typeof call.value !== "string" || !/^0x[0-9a-fA-F]*$/.test(call.value)) {
        return {
          status: "refused" as const,
          reason: `quote-unavailable: eth_call returned a non-hex result for ${route.quoterAddress}`,
        };
      }
      const decoded = decodeQuoteExactInputSingleResult(call.value);
      if (!decoded.ok) {
        return { status: "refused" as const, reason: decoded.refusal };
      }
      const amountOut = BigInt(decoded.amountOut);
      // An honest zero is not a usable quote: the pool cannot produce the
      // output leg, and minting a zero-output record would hand admission a
      // min-out of zero — the one value that must never reach a swap.
      if (amountOut <= 0n) {
        return { status: "refused" as const, reason: "quote-unavailable: zero output" };
      }
      // Exact floor: amountOut * (1 - bps/10000), truncated, never rounded up.
      const minAmountOutRaw = (amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
      if (minAmountOutRaw === 0n) {
        return {
          status: "refused" as const,
          reason: "quote-unavailable: slippage rounds minimum output to zero",
        };
      }

      const record: SwapQuoteRecord = {
        quoteId: swapQuoteId({
          chainId: route.chainId,
          routeId: route.routeId,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          amountInRaw: input.amountInRaw,
          minAmountOutRaw: minAmountOutRaw.toString(10),
          quotedAtMs: input.now,
          expiresAtMs: input.now + ttlMs,
        }),
        chainId: route.chainId,
        routeId: route.routeId,
        tokenIn: route.tokenIn,
        tokenOut: route.tokenOut,
        amountInRaw: input.amountInRaw,
        minAmountOutRaw: minAmountOutRaw.toString(10),
        gasEstimateWei: QUOTE_GAS_ESTIMATE_WEI_PLACEHOLDER,
        quotedAtMs: input.now,
        expiresAtMs: input.now + ttlMs,
        basis: "eth_call",
      };
      // Self-check: the record this service built must satisfy the shared
      // contract it claims to be (expiry strictly after pricing included). A
      // construction bug surfaces as a named refusal here, never as a
      // malformed value handed to admission.
      return yield* decodeQuoteRecord(record).pipe(
        Effect.map((validated): SwapQuoteOutcome => ({ status: "quoted", record: validated })),
        Effect.orElseSucceed((): SwapQuoteOutcome => ({
          status: "refused",
          reason: "quote-unavailable: quote record failed contract validation",
        })),
      );
    });

  /**
   * The protected mainnet lane's quote: complete execution identity and
   * MEASURED fees, or a named refusal. Every field 03 requires a funded gate
   * to verify is produced here — coherent block (number + hash), route
   * config digest, quoter/target runtime-code hashes, quoted output, gas
   * estimate from the actual protected calldata, and EIP-1559 bounds from
   * fee history. Anything that cannot be measured refuses: a fee that cannot
   * be bounded is not quoted, it is unavailable.
   */
  const quoteUrV3ExactInput = (
    route: UrV3SwapRouteSpec,
    input: QuoteExactInputInput,
    slippageBps: number,
    ttlMs: number,
  ): Effect.Effect<SwapQuoteOutcome> =>
    Effect.gen(function* () {
      if (Option.isNone(mainnetTransportOption)) {
        return {
          status: "refused" as const,
          reason:
            "quote-unavailable: the mainnet RPC transport is not wired into this runtime, so a ur-v3 route cannot be priced",
        };
      }
      const rpc = mainnetTransportOption.value;
      // A named helper so every RPC failure reads as a refusal, never a die.
      const call = <A>(
        method: string,
        params: ReadonlyArray<unknown>,
        read: (value: unknown) => A | null,
      ): Effect.Effect<A, string> =>
        rpc.request(method, [...params]).pipe(
          Effect.mapError(redactRpcDetail),
          Effect.flatMap((value): Effect.Effect<A, string> => {
            const parsed = read(value);
            return parsed === null
              ? Effect.fail(`${method} returned an unusable result`)
              : Effect.succeed(parsed);
          }),
        );

      // Chain binding first: the RPC must BE mainnet before anything it says
      // is allowed to become quote identity.
      const chainId = yield* call("eth_chainId", [], (value) =>
        typeof value === "string" && value === "0x1" ? value : null,
      ).pipe(Effect.catch((reason): Effect.Effect<string, never> => Effect.succeed(reason)));
      if (chainId !== "0x1") {
        return {
          status: "refused" as const,
          reason: `quote-unavailable: the mainnet RPC did not identify as chain 1 (${chainId})`,
        };
      }

      // Pin the coherent block: number first, then every read at that block.
      const blockNumberHex = yield* call("eth_blockNumber", [], (value) =>
        typeof value === "string" && /^0x[0-9a-f]+$/.test(value) ? value : null,
      ).pipe(Effect.catch((reason) => Effect.succeed(`error:${reason}`)));
      if (typeof blockNumberHex !== "string" || blockNumberHex.startsWith("error:")) {
        return {
          status: "refused" as const,
          reason: `quote-unavailable: cannot pin a quote block (${String(blockNumberHex).slice("error:".length)})`,
        };
      }
      const blockNumber = BigInt(blockNumberHex).toString(10);

      // Target-code identity at the pinned block: both the quoter and the
      // swap target must carry code whose keccak256 the record pins.
      const bareCodeHash = (code: unknown): string | null => {
        const hash = codeHashOf(code);
        return hash === null ? null : hash.replace(/^0x/, "");
      };
      const quoterCodeHash = yield* call(
        "eth_getCode",
        [route.quoterAddress, blockNumberHex],
        bareCodeHash,
      ).pipe(Effect.catch((reason) => Effect.succeed(`error:${reason}` as const)));
      if (typeof quoterCodeHash !== "string" || quoterCodeHash.startsWith("error:")) {
        return {
          status: "refused" as const,
          reason: "quote-unavailable: the quoter's runtime code could not be read and hashed",
        };
      }
      const targetCodeHash = yield* call(
        "eth_getCode",
        [route.swapTargetAddress, blockNumberHex],
        bareCodeHash,
      ).pipe(Effect.catch((reason) => Effect.succeed(`error:${reason}` as const)));
      if (typeof targetCodeHash !== "string" || targetCodeHash.startsWith("error:")) {
        return {
          status: "refused" as const,
          reason: "quote-unavailable: the swap target's runtime code could not be read and hashed",
        };
      }

      // The quote itself, at the pinned block, through the v3 QuoterV2.
      const amountIn = BigInt(input.amountInRaw);
      const quoteData = encodeQuoterV2ExactInputSingle({
        tokenIn: route.tokenIn === SWAP_NATIVE_CURRENCY_ADDRESS ? route.weth : route.tokenIn,
        tokenOut: route.tokenOut === SWAP_NATIVE_CURRENCY_ADDRESS ? route.weth : route.tokenOut,
        amountIn,
        fee: route.feeTier,
      });
      const quoted = yield* call(
        "eth_call",
        [{ to: route.quoterAddress, data: quoteData }, blockNumberHex],
        decodeQuoterV2Result,
      ).pipe(Effect.catch((reason) => Effect.succeed(`error:${reason}` as const)));
      if (typeof quoted === "string") {
        return {
          status: "refused" as const,
          reason: `quote-unavailable: the v3 quoter call failed at block ${blockNumber}`,
        };
      }
      if (quoted.amountOut <= 0n) {
        return { status: "refused" as const, reason: "quote-unavailable: zero output" };
      }
      const minAmountOutRaw = (quoted.amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
      if (minAmountOutRaw === 0n) {
        return {
          status: "refused" as const,
          reason: "quote-unavailable: slippage rounds minimum output to zero",
        };
      }

      // The block's hash, read back for the same pinned number: together
      // with the number it fixes the state the price was taken against.
      const blockHash = yield* call(
        "eth_getBlockByNumber",
        [blockNumberHex, false],
        (value): string | null => {
          if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
          const hash = (value as Record<string, unknown>)["hash"];
          return typeof hash === "string" && /^0x[0-9a-f]{64}$/.test(hash) ? hash.slice(2) : null;
        },
      ).pipe(Effect.catch((reason) => Effect.succeed(`error:${reason}` as const)));
      if (typeof blockHash !== "string" || blockHash.startsWith("error:")) {
        return {
          status: "refused" as const,
          reason: "quote-unavailable: the pinned quote block's hash could not be read",
        };
      }

      // EIP-1559 bounds from fee history: next-block base fee plus the 50th
      // percentile priority. maxFee = 2× base + priority (the standard
      // headroom bound); a missing/zero bound refuses.
      const feeBounds = yield* call(
        "eth_feeHistory",
        ["0x1", "latest", [50]],
        (value): { readonly maxFee: bigint; readonly priority: bigint } | null => {
          if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
          const baseFees = (value as Record<string, unknown>)["baseFeePerGas"];
          const rewards = (value as Record<string, unknown>)["reward"];
          if (!Array.isArray(baseFees) || baseFees.length < 2) return null;
          if (!Array.isArray(rewards) || rewards.length < 1 || !Array.isArray(rewards[0]))
            return null;
          // Quantity words arrive as 0x-prefixed hex.
          const hexQuantity = (input: unknown): bigint | null =>
            typeof input === "string" && /^0x[0-9a-fA-F]+$/.test(input) ? BigInt(input) : null;
          const nextBase = hexQuantity(baseFees[1]);
          const priority = hexQuantity(rewards[0][0]);
          if (nextBase === null || nextBase <= 0n || priority === null) return null;
          return { maxFee: nextBase * 2n + priority, priority };
        },
      ).pipe(Effect.catch((reason) => Effect.succeed(`error:${reason}` as const)));
      if (typeof feeBounds === "string") {
        return {
          status: "refused" as const,
          reason: "quote-unavailable: EIP-1559 fee bounds could not be measured for this route",
        };
      }
      const { maxFee, priority } = feeBounds;

      // Measured gas: estimate the ACTUAL protected calldata (encode with a
      // unit minOut so the estimate measures the swap, not the protection).
      // Estimation requires the funding account; an unfunded or refusing
      // estimate leaves the fee unbounded, which refuses the quote.
      const spotTarget = rpc.target();
      const accountAddress = spotTarget === null ? null : spotTarget.accountAddress;
      if (accountAddress === null) {
        return {
          status: "refused" as const,
          reason:
            "quote-unavailable: the spot mainnet account address is not configured, so execution gas cannot be estimated",
        };
      }
      const estimatePlan: ProtectedSwapPlan = {
        direction:
          route.tokenIn === SWAP_NATIVE_CURRENCY_ADDRESS ? "native-in" : "erc20-in-native-out",
        chainId: 1,
        router: route.swapTargetAddress,
        weth: route.weth,
        erc20: route.erc20,
        recipient: "0x0000000000000000000000000000000000000001",
        amountInRaw: input.amountInRaw,
        minAmountOutRaw: "1",
        deadlineUnix: Math.floor(input.now / 1000) + Math.floor(ttlMs / 1000) + 60,
        feeTier: route.feeTier,
      };
      const estimateCall = encodeProtectedExactInput(estimatePlan);
      const gasUnits = yield* call(
        "eth_estimateGas",
        [
          {
            from: accountAddress,
            to: estimateCall.to,
            data: estimateCall.data,
            value: estimateCall.value,
          },
          blockNumberHex,
        ],
        (value) =>
          typeof value === "string" && /^0x[0-9a-f]+$/.test(value) ? BigInt(value) : null,
      ).pipe(Effect.catch((reason) => Effect.succeed(`error:${reason}` as const)));
      if (typeof gasUnits !== "bigint" || gasUnits <= 0n) {
        return {
          status: "refused" as const,
          reason:
            "quote-unavailable: execution gas could not be estimated for the protected calldata (the funding account must exist for estimation)",
        };
      }

      const routeDigest = swapRouteConfigDigest(route);
      const worstCaseFeeWei = gasUnits * maxFee;
      const record: SwapQuoteRecord = {
        quoteId: swapQuoteId({
          chainId: route.chainId,
          routeId: route.routeId,
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          amountInRaw: input.amountInRaw,
          minAmountOutRaw: minAmountOutRaw.toString(10),
          quotedAtMs: input.now,
          expiresAtMs: input.now + ttlMs,
          routeConfigDigest: routeDigest,
          quotedBlockNumber: blockNumber,
          quotedBlockHash: blockHash,
          quotedAmountOutRaw: quoted.amountOut.toString(10),
          quoterCodeHash,
          targetCodeHash,
          gasUnitsMeasured: gasUnits.toString(10),
          maxFeePerGasWei: maxFee.toString(10),
          maxPriorityFeePerGasWei: priority.toString(10),
        }),
        chainId: route.chainId,
        routeId: route.routeId,
        tokenIn: route.tokenIn,
        tokenOut: route.tokenOut,
        amountInRaw: input.amountInRaw,
        minAmountOutRaw: minAmountOutRaw.toString(10),
        gasEstimateWei: worstCaseFeeWei.toString(10),
        quotedAtMs: input.now,
        expiresAtMs: input.now + ttlMs,
        basis: "eth_call",
        routeConfigDigest: routeDigest,
        quotedBlockNumber: blockNumber,
        quotedBlockHash: blockHash,
        quotedAmountOutRaw: quoted.amountOut.toString(10),
        quoterCodeHash,
        targetCodeHash,
        gasUnitsMeasured: gasUnits.toString(10),
        maxFeePerGasWei: maxFee.toString(10),
        maxPriorityFeePerGasWei: priority.toString(10),
      };
      return yield* decodeQuoteRecord(record).pipe(
        Effect.map((validated): SwapQuoteOutcome => ({ status: "quoted", record: validated })),
        Effect.orElseSucceed((): SwapQuoteOutcome => ({
          status: "refused",
          reason: "quote-unavailable: quote record failed contract validation",
        })),
      );
    }).pipe(
      Effect.catch((reason): Effect.Effect<SwapQuoteOutcome, never> =>
        Effect.succeed({
          status: "refused" as const,
          reason: `quote-unavailable: ${redactRpcDetail(String(reason))}`,
        }),
      ),
    );

  return UniswapQuoteService.of({ quoteExactInput });
});

/**
 * The quote service layer. Deliberately open about `SwapRouteConfig` and
 * `ForgeSepoliaTransport`: the wiring point composes them over the ONE
 * memoized transport instance the forge adapter already uses, and tests
 * inject fakes at those seams.
 */
export const UniswapQuoteServiceLive = Layer.effect(UniswapQuoteService, makeUniswapQuoteService);

// ---------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------

/**
 * The two-point freshness rule's first point: was the record still live when
 * it was priced? Fresh strictly before `expiresAtMs` — the expiry instant
 * itself is stale. Admission (P5.4) re-checks against the SAME record's
 * expiry before committing spend; this helper never substitutes for that
 * second check.
 */
export const validateQuoteFresh = (record: SwapQuoteRecord, asOfMs: number): boolean =>
  Number.isSafeInteger(asOfMs) && asOfMs >= record.quotedAtMs && asOfMs < record.expiresAtMs;
