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
import { Layer, Schema } from "effect";

import {
  EXECUTION_ENVELOPE_MAX_SLIPPAGE_BPS,
  SwapQuoteRecord,
  swapQuoteId,
} from "@t3tools/trading-contracts";

import { ForgeSepoliaTransport } from "./UniswapTestnetAdapter.ts";
import { V4_MAX_TICK_SPACING, V4_MIN_TICK_SPACING } from "./SepoliaTarget.ts";
import {
  QUOTE_EXACT_AMOUNT_MAX,
  decodeQuoteExactInputSingleResult,
  encodeQuoteExactInputSingle,
} from "./QuoterAbi.ts";

// ---------------------------------------------------------------------------
// The approved-route registry
// ---------------------------------------------------------------------------

/** Sepolia's chain id as the route vocabulary carries it (decimal string). */
export const SWAP_ROUTE_SEPOLIA_CHAIN_ID = "11155111";

/** The one routing path P5 supports; anything else is refused by name. */
export type SwapRouteType = "v4-exact-input-single";

/**
 * One approved swap route: the exact pool, direction, and quoter a quote or
 * (later, P5.4) an exact-input intent may use. Addresses are validated and
 * lowercased at resolution so quote identities stay byte-deterministic
 * regardless of the config's casing.
 */
export interface SwapRouteSpec {
  /** Registry identity; proposals and quote records bind to it. */
  readonly routeId: string;
  readonly chainId: typeof SWAP_ROUTE_SEPOLIA_CHAIN_ID;
  readonly routeType: SwapRouteType;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly quoterAddress: string;
  /**
   * The PoolSwapTest-style testnet contract an exact-input intent executes
   * through (P5.4): the quote's numbers come from `quoterAddress`, the
   * prepared transaction's `to` comes from here. Required per route so a
   * route can never be quotable but not executable.
   */
  readonly swapTargetAddress: string;
  readonly poolKey: {
    readonly currency0: string;
    readonly currency1: string;
    readonly fee: number;
    readonly tickSpacing: number;
    readonly hooks: string;
  };
  /** currency0 -> currency1 when true; must agree with tokenIn/tokenOut. */
  readonly zeroForOne: boolean;
  /** Display label for surfaces; never parsed, never an identity. */
  readonly label?: string;
}

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
    if (record["chainId"] !== SWAP_ROUTE_SEPOLIA_CHAIN_ID) {
      return refuse(
        `chainId must be "${SWAP_ROUTE_SEPOLIA_CHAIN_ID}" (Sepolia), got '${String(record["chainId"])}'`,
      );
    }
    if (record["routeType"] !== "v4-exact-input-single") {
      return refuse(
        `unsupported routeType '${String(record["routeType"])}' — only 'v4-exact-input-single' is supported (UniswapX, order, and bridge routes are refused by name)`,
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
    if (record["label"] !== undefined && typeof record["label"] !== "string") {
      return refuse("label must be a string when present");
    }
    const label = record["label"];

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
      routeType: "v4-exact-input-single",
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
 * Conservative gas-cost placeholder, wei: 400k gas units (a generous v4
 * single-hop swap) at a 100 gwei ceiling = 4e16. Real estimation is a later
 * live-gate refinement; whatever a quote carries, admission caps it by the
 * envelope's maxGasWei, so the placeholder can only over-reserve, never
 * overspend.
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

export const makeUniswapQuoteService = Effect.gen(function* () {
  const routeConfig = yield* SwapRouteConfig;
  const transport = yield* ForgeSepoliaTransport;

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
