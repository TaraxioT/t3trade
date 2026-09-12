/**
 * T3 Forge contracts — the Uniswap observation source and the fee-policy
 * boundary it feeds.
 *
 * Forge is the one place T3 Trade looks past Hyperliquid: it reads real
 * Uniswap v3 WETH/USDC swaps from The Graph network on Ethereum mainnet,
 * lets an in-app agent build a coordination detector over them, and — later
 * phases — publishes that detector's verdict as a fee policy to a fixed
 * Uniswap v4 hook on Sepolia. Those are two different chains doing two
 * different jobs, so they are two different labels here and never one
 * `TradingVenue`: `TradingVenue` stays Hyperliquid-only, and Forge owns its
 * own `ForgeObservationChain` (mainnet, read-only) and `ForgeExecutionChain`
 * (Sepolia, the only chain Forge may ever write).
 *
 * Everything numeric in an observation is exact. `sqrtPriceX96` and token
 * amounts arrive as decimal integer strings and are normalized with BigInt
 * rational arithmetic into a `ForgeExactRatio` whose parts are decimal
 * integer strings — floats never touch the exact path. The `_micros` fields
 * are display and chart quantities derived from the ratio by integer
 * division at a fixed 1e6 scale, so a chart point and a policy input can
 * never disagree about the third decimal.
 *
 * This module is schemas and pure arithmetic only. The network adapter lives
 * in `apps/server/src/trading/forge/GraphSource.ts`; semantic detector logic
 * is produced at runtime by the capability builder (F2), never here.
 *
 * @module TradingForge
 */
import { Schema } from "effect";

import { EvmAddress, UnixMillis } from "./primitives.ts";

// ---------------------------------------------------------------------------
// Chain labels
// ---------------------------------------------------------------------------

/**
 * The chain Forge observes. Mainnet, read-only, through The Graph — nothing
 * on this chain is ever signed.
 */
export const ForgeObservationChain = Schema.Literals(["ethereum-mainnet"]);
export type ForgeObservationChain = typeof ForgeObservationChain.Type;

/** The one chain Forge may ever write to: Sepolia, via the fixed v4 hook. */
export const ForgeExecutionChain = Schema.Literals(["sepolia"]);
export type ForgeExecutionChain = typeof ForgeExecutionChain.Type;

export const FORGE_OBSERVATION_CHAIN: ForgeObservationChain = "ethereum-mainnet";
export const FORGE_EXECUTION_CHAIN: ForgeExecutionChain = "sepolia";

// ---------------------------------------------------------------------------
// Window and normalization constants
// ---------------------------------------------------------------------------

/**
 * How much pre-window history an observation fetch must cover so anchor
 * selection has every candidate, not just the nearest trade.
 *
 * The detector anchors a window on the last qualifying trade before it
 * starts. "Nearest" is not "qualifying": the F5 revision exists because the
 * nearest pre-window trade can be a tiny one while an earlier, meaningful
 * one sits just behind it. The fetch therefore covers a fixed five-minute
 * buffer before the window and reports every swap in it as an anchor
 * candidate; which candidate qualifies is runtime detector semantics, never
 * a property of the fetch.
 */
export const FORGE_ANCHOR_CANDIDATE_WINDOW_SECONDS = 300;

/**
 * The most history a single observation window may span. Mainnet v3 pools
 * trade constantly; an unbounded window would be an unbounded GraphQL walk,
 * and the historical-comparison use only needs a bounded, comparable slice.
 */
export const FORGE_MAX_WINDOW_SECONDS = 24 * 60 * 60;

/** Fixed scale of every `_micros` quantity: 1e6 sub-units per whole unit. */
export const FORGE_MICROS_SCALE = 1_000_000;

/** The most points a per-pool chart series may carry (U0 handoff cap). */
export const FORGE_MAX_SERIES_POINTS = 720;

/** The base/quote pair every approved Forge pool trades. */
export const FORGE_BASE_SYMBOL = "WETH";
export const FORGE_QUOTE_SYMBOL = "USDC";

/**
 * How a per-pool series prices its axis. A literal, not free text, so two
 * surfaces cannot label the same number differently.
 */
export const ForgeQuoteUnits = Schema.Literals(["USDC-per-WETH"]);
export type ForgeQuoteUnits = typeof ForgeQuoteUnits.Type;

// ---------------------------------------------------------------------------
// Pool and source identity
// ---------------------------------------------------------------------------

/**
 * A pool identifier as envelopes and read models carry it: opaque and
 * non-empty. Strict address validation belongs to the approved-pool registry
 * (`ForgePoolIdentity.poolId`); an envelope must be able to echo a requested
 * pool id honestly on a refusal path, malformed or not.
 */
const PoolRef = Schema.String.check(Schema.isNonEmpty());

/** One side of a Uniswap pool, as the subgraph reports it. */
export const ForgeTokenMetadata = Schema.Struct({
  address: EvmAddress,
  symbol: Schema.String,
  /** ERC-20 decimals. WETH 18, USDC 6. */
  decimals: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type ForgeTokenMetadata = typeof ForgeTokenMetadata.Type;

/**
 * One approved WETH/USDC pool.
 *
 * `baseIsToken1` records which slot WETH occupies (Uniswap orders tokens by
 * address, and USDC sorts before WETH, so in every real WETH/USDC pool WETH
 * is token1 — but the arithmetic takes the flag, not the symbol, so a pool
 * list typo cannot silently invert a price).
 */
export const ForgePoolIdentity = Schema.Struct({
  chain: ForgeObservationChain,
  poolId: EvmAddress,
  /** Fee tier in hundredths of a basis point: 500 = 0.05%, 3000 = 0.30%. */
  feeTierHundredthsBps: Schema.Int,
  label: Schema.String,
  token0: ForgeTokenMetadata,
  token1: ForgeTokenMetadata,
  /** True when the base asset (WETH) is this pool's token1. */
  baseIsToken1: Schema.Boolean,
});
export type ForgePoolIdentity = typeof ForgePoolIdentity.Type;

/**
 * The configured Graph source: where to read and what is approved. Host
 * configuration only — credentials live server-side and are never part of
 * this schema, never ride a URL, and never appear in output.
 */
export const ForgeSourceConfig = Schema.Struct({
  kind: Schema.Literals(["uniswap-v3-graph"]),
  /** Query endpoint, e.g. `https://api.thegraph.com/subgraphs/id/...`. */
  endpoint: Schema.String.check(Schema.isPattern(/^https:\/\//)),
  /** Deployment id the endpoint serves, carried into provenance. */
  deployment: Schema.String.check(Schema.isNonEmpty()),
  /** Indexing-status endpoint used to measure chain-head lag. */
  indexingEndpoint: Schema.String.check(Schema.isPattern(/^https:\/\//)),
  /** The only pools this source may ever serve. One to three. */
  pools: Schema.Array(ForgePoolIdentity),
  /** Indexed-head lag beyond which a pinned fetch is `stale`. */
  maxLagBlocks: Schema.Int.check(Schema.isGreaterThan(0)),
  /** GraphQL page size; The Graph caps `first` at 1000. */
  pageSize: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(1000)),
  /** Hard cap on swaps per window fetch, across all pages. */
  maxSwapsPerFetch: Schema.Int.check(Schema.isGreaterThan(0)),
}).check(
  Schema.makeFilter(
    (input) =>
      (input.pools.length >= 1 && input.pools.length <= 3) ||
      "A Forge source serves one to three approved pools, no more.",
  ),
);
export type ForgeSourceConfig = typeof ForgeSourceConfig.Type;

// ---------------------------------------------------------------------------
// Exact normalization
// ---------------------------------------------------------------------------

/** A base-10 integer string, optionally negative — the subgraph's number form. */
const IntegerString = Schema.String.check(Schema.isPattern(/^-?[0-9]+$/));

/**
 * An exact non-negative rational, as decimal integer strings.
 *
 * BigInt cannot ride JSON; strings can, and stay exact. Both parts strictly
 * positive — a price of zero or a division by zero is a malformed
 * observation, not a cheap one.
 */
export const ForgeExactRatio = Schema.Struct({
  numerator: IntegerString.check(Schema.isPattern(/^[1-9][0-9]*$/)),
  denominator: IntegerString.check(Schema.isPattern(/^[1-9][0-9]*$/)),
});
export type ForgeExactRatio = typeof ForgeExactRatio.Type;

/** Unix seconds — the timestamp unit every EVM source speaks. */
const UnixSeconds = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** 2^192, the squared shift: `sqrtPriceX96^2 / 2^192` is the raw price. */
const Q192 = 1n << 192n;

const parseBigint = (value: string): bigint => {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
};

/** `10^n` for a non-negative exponent. */
const pow10 = (exponent: number): bigint => 10n ** BigInt(exponent);

/** Euclid on BigInt; every ratio this module emits is reduced by it. */
const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcd(b, a % b));

/**
 * Exact quote-per-base price from a pool's `sqrtPriceX96`.
 *
 * `sqrtPriceX96 = sqrt(rawPrice) * 2^96` where `rawPrice` is token1 per
 * token0 in raw units, so the human-scale price is
 * `sqrtPriceX96^2 * 10^(d0 - d1) / 2^192` — token1 per token0, decimals
 * adjusted. When the base asset (WETH) is token0 that IS quote-per-base;
 * when the base is token1 the ratio is base-per-quote and must be inverted.
 * All BigInt; no float exists anywhere in this path. The result is reduced
 * to lowest terms so the wire form stays small without losing exactness.
 *
 * Returns `null` for a malformed `sqrtPriceX96` (zero, negative, or not an
 * integer string) — a bad field is an error to surface, never a zero price.
 */
export function forgeExactQuotePerBase(input: {
  readonly sqrtPriceX96: string;
  readonly token0Decimals: number;
  readonly token1Decimals: number;
  readonly baseIsToken1: boolean;
}): ForgeExactRatio | null {
  const sqrt = parseBigint(input.sqrtPriceX96);
  if (sqrt <= 0n || !/^[0-9]+$/.test(input.sqrtPriceX96)) return null;

  // `sqrt^2 * 10^(d0 - d1)` over `2^192`, with a negative decimal exponent
  // moved into the denominator so every term stays an integer. The exponent
  // is token0 minus token1 — the pools' slot order, not base vs quote.
  const exponent = input.token0Decimals - input.token1Decimals;
  let numerator = sqrt * sqrt;
  let denominator = Q192;
  if (exponent >= 0) {
    numerator *= pow10(exponent);
  } else {
    denominator *= pow10(-exponent);
  }

  // token1-per-token0. Base-as-token1 means this is base-per-quote: invert.
  const [ratioNumerator, ratioDenominator] = input.baseIsToken1
    ? [denominator, numerator]
    : [numerator, denominator];
  const common = gcd(ratioNumerator, ratioDenominator);
  return {
    numerator: (ratioNumerator / common).toString(10),
    denominator: (ratioDenominator / common).toString(10),
  };
}

/**
 * The `_micros` rendering of an exact ratio: `floor(numerator * 1e6 /
 * denominator)`, computed in BigInt and widened to a float only after the
 * division. Every price the chart or a policy reads passes through here, so
 * "what the ratio says" and "what the UI shows" are the same number.
 */
export function forgeRatioMicros(ratio: ForgeExactRatio): number {
  const numerator = parseBigint(ratio.numerator);
  const denominator = parseBigint(ratio.denominator);
  if (numerator <= 0n || denominator <= 0n) return 0;
  return Number((numerator * BigInt(FORGE_MICROS_SCALE)) / denominator);
}

/**
 * The stable-quote leg of one swap, exact: the absolute USDC amount, as the
 * raw decimal string and its micros rendering. One side of every WETH/USDC
 * swap is USDC, and wash-trade volume is measured in the stable leg because
 * a coordinated pair of trades moves the quote amount, not the base.
 *
 * Returns `null` when the chosen leg is not a non-negative integer string.
 */
export function forgeQuoteVolume(input: {
  readonly amount0: string;
  readonly amount1: string;
  readonly quoteIsToken1: boolean;
  readonly quoteDecimals: number;
}): { readonly quoteVolumeRaw: string; readonly quoteVolumeMicros: number } | null {
  const leg = input.quoteIsToken1 ? input.amount1 : input.amount0;
  if (!/^-?[0-9]+$/.test(leg)) return null;
  const raw = parseBigint(leg);
  // The subgraph signs amounts against the pool; the quote volume of a swap
  // is the magnitude of its stable leg either way.
  const absolute = raw < 0n ? -raw : raw;
  const scale = pow10(input.quoteDecimals);
  const micros = (absolute * BigInt(FORGE_MICROS_SCALE)) / scale;
  return {
    quoteVolumeRaw: absolute.toString(10),
    quoteVolumeMicros: Number(micros),
  };
}

// ---------------------------------------------------------------------------
// Observations and window fetches
// ---------------------------------------------------------------------------

/**
 * One normalized mainnet swap.
 *
 * Everything the detector needs and nothing it does not: identity, raw
 * amounts, the exact price after the swap, and the stable-quote volume.
 * `observationId` (`transactionHash:logIndex`) is the provenance key every
 * series point and evaluation diagnostic refers back to.
 */
export const ForgeSwapObservation = Schema.Struct({
  chain: ForgeObservationChain,
  poolId: EvmAddress,
  observationId: Schema.String.check(Schema.isNonEmpty()),
  transactionHash: Schema.String.check(Schema.isPattern(/^0x[0-9a-fA-F]{64}$/)),
  logIndex: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  timestamp: UnixSeconds,
  sender: Schema.String,
  recipient: Schema.String,
  /** Raw token0 delta, signed, base-10 string. */
  amount0: IntegerString,
  /** Raw token1 delta, signed, base-10 string. */
  amount1: IntegerString,
  sqrtPriceX96: IntegerString.check(Schema.isPattern(/^[0-9]+$/)),
  tick: Schema.Int,
  /** Which slot the base asset occupied in this pool. */
  baseIsToken1: Schema.Boolean,
  /** Exact quote-per-base price after the swap. */
  priceQuotePerBase: ForgeExactRatio,
  /** Integer-division rendering of `priceQuotePerBase` at 1e6. */
  priceQuotePerBaseMicros: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  /** Absolute USDC leg, raw base units. */
  quoteVolumeRaw: Schema.String.check(Schema.isPattern(/^[0-9]+$/)),
  /** Absolute USDC leg at 1e6 per whole USDC. */
  quoteVolumeMicros: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type ForgeSwapObservation = typeof ForgeSwapObservation.Type;

/**
 * Why a fetch landed in each state — the one-line cause a surface shows.
 * `stale` and `unavailable` always carry one; `complete` and `empty` never
 * need to.
 */
export const ForgeFetchStatus = Schema.Literals(["complete", "empty", "stale", "unavailable"]);
export type ForgeFetchStatus = typeof ForgeFetchStatus.Type;

/**
 * Whether the pre-window buffer held any anchor candidates.
 *
 * `missing` is honest absence: no swap at all in the five minutes before
 * the window started. A window whose anchor buffer is empty is still
 * servable — it just cannot support an anchored reading, and nothing
 * downstream may invent one.
 */
export const ForgeAnchorCoverage = Schema.Literals(["covered", "missing"]);
export type ForgeAnchorCoverage = typeof ForgeAnchorCoverage.Type;

/** One pre-window swap offered as an anchor candidate, with its age. */
export const ForgeAnchorCandidate = Schema.Struct({
  observation: ForgeSwapObservation,
  /** How many seconds before the window this candidate traded. */
  ageBeforeWindowSeconds: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type ForgeAnchorCandidate = typeof ForgeAnchorCandidate.Type;

/**
 * One pinned-block window fetch for one pool.
 *
 * States, and only these:
 * - `complete` — every page served the pinned block; the window (plus the
 *   pre-window anchor buffer) is covered.
 * - `empty` — the pinned source was healthy and the window genuinely holds
 *   no swaps. Never fabricated zeros.
 * - `stale` — the fetch succeeded but the indexed head lags the chain head
 *   by more than `maxLagBlocks` (or freshness could not be proven). Data is
 *   served, labeled; live fee policy must refuse it.
 * - `unavailable` — transport, auth, GraphQL, validation, or block-pin
 *   failure. `reason` names it. Never zeros, never a fixture.
 *
 * Every carrying state records the pinned block (and hash when the source
 * serves one) so "one block across all pages and pools" is checkable from
 * the result alone. `duplicatesDropped` counts same-key rows the fetch
 * collapsed, so a re-serving page is visible rather than silent.
 */
/** Credential-free request bytes retained for reproducible research captures. */
export const ForgeQueryCapture = Schema.Struct({
  /** Independent pin verification when a provider omits Graph block hashes.
   * Retained with query bytes; never claims the hash came from Graph. */
  blockHashVerification: Schema.optional(
    Schema.Array(
      Schema.Struct({
        method: Schema.Literal("independent-rpc"),
        chainId: Schema.Literal(1),
        blockNumber: Schema.Int,
        beforeHash: Schema.String.check(Schema.isPattern(/^0x[0-9a-f]{64}$/)),
        afterHash: Schema.String.check(Schema.isPattern(/^0x[0-9a-f]{64}$/)),
      }),
    ),
  ),
  query: Schema.String,
  variables: Schema.Array(
    Schema.Struct({
      pool: Schema.String,
      first: Schema.Number,
      cursor: Schema.String,
      block: Schema.Number,
      from: Schema.String,
      to: Schema.String,
    }),
  ),
});
export type ForgeQueryCapture = typeof ForgeQueryCapture.Type;

export const ForgeWindowFetch = Schema.Struct({
  poolId: PoolRef,
  status: ForgeFetchStatus,
  reason: Schema.optional(Schema.String),
  /** The single block every page of this fetch was pinned to. */
  pinnedBlock: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  pinnedBlockHash: Schema.optional(Schema.String),
  deployment: Schema.optional(Schema.String),
  fetchedAtMs: UnixMillis,
  /** Original window bounds, unix seconds. */
  window: Schema.optional(
    Schema.Struct({
      startedAt: UnixSeconds,
      endedAt: UnixSeconds,
    }),
  ),
  /** True when this window is retained as an explicitly historical capture. */
  historical: Schema.Boolean,
  observations: Schema.optional(Schema.Array(ForgeSwapObservation)),
  anchorCoverage: Schema.optional(ForgeAnchorCoverage),
  /** Every swap in the five-minute pre-window buffer, oldest first. */
  anchorCandidates: Schema.optional(Schema.Array(ForgeAnchorCandidate)),
  /** Indexed-head lag measured at fetch time, chain head minus indexed. */
  lagBlocks: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  /** Rows dropped because (chain, transaction, log) was already present. */
  duplicatesDropped: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  queryCapture: Schema.optional(ForgeQueryCapture),
  /** SHA-256 over the canonical fetch artifact. */
  sourceDigest: Schema.optional(Schema.String),
}).check(
  Schema.makeFilter(
    (input) =>
      (input.status !== "stale" && input.status !== "unavailable") ||
      input.reason !== undefined ||
      "A stale or unavailable fetch must say why; silence would read as healthy.",
  ),
);
export type ForgeWindowFetch = typeof ForgeWindowFetch.Type;

// ---------------------------------------------------------------------------
// Source health
// ---------------------------------------------------------------------------

/**
 * What the indexing-status probe says about the source right now.
 *
 * `stale` means the indexed head is measurably behind the chain head;
 * `unavailable` means the probe failed or reported an unhealthy subgraph.
 * This is metadata for surfaces and gates — it never fabricates data.
 */
export const ForgeSourceHealth = Schema.Struct({
  status: Schema.Literals(["healthy", "stale", "unavailable"]),
  reason: Schema.optional(Schema.String),
  latestBlock: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  chainHeadBlock: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  lagBlocks: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  probedAtMs: UnixMillis,
});
export type ForgeSourceHealth = typeof ForgeSourceHealth.Type;

// ---------------------------------------------------------------------------
// Evidence persistence boundary
// ---------------------------------------------------------------------------

/**
 * The durable handle to one retained fetch.
 *
 * Raw observations are stored against `evidenceId` and read back by id
 * through authenticated transport — they are never stuffed into events or
 * evaluations. Records carry provenance (endpoint without credentials,
 * deployment, pinned block, digest) so a retained window can be proven
 * without replaying it.
 */
export const ForgeEvidenceRecord = Schema.Struct({
  evidenceId: Schema.String.check(Schema.isNonEmpty()),
  environmentId: Schema.String.check(Schema.isNonEmpty()),
  poolId: PoolRef,
  historical: Schema.Boolean,
  /** The query endpoint, credentials never included. */
  endpoint: Schema.String,
  deployment: Schema.String,
  pinnedBlock: Schema.Int.check(Schema.isGreaterThan(0)),
  pinnedBlockHash: Schema.optional(Schema.String),
  windowStart: UnixSeconds,
  windowEnd: UnixSeconds,
  fetchedAtMs: UnixMillis,
  digest: Schema.String.check(Schema.isNonEmpty()),
  observationCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type ForgeEvidenceRecord = typeof ForgeEvidenceRecord.Type;

/** A retained historical capture across the approved pools, one pinned block. */
export const ForgeHistoricalCapture = Schema.Struct({
  environmentId: Schema.String.check(Schema.isNonEmpty()),
  pinnedBlock: Schema.Int.check(Schema.isGreaterThan(0)),
  window: Schema.Struct({ startedAt: UnixSeconds, endedAt: UnixSeconds }),
  capturedAtMs: UnixMillis,
  pools: Schema.Array(
    Schema.Struct({
      poolId: PoolRef,
      evidenceId: Schema.String.check(Schema.isNonEmpty()),
      observationCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      anchorCoverage: ForgeAnchorCoverage,
    }),
  ),
});
export type ForgeHistoricalCapture = typeof ForgeHistoricalCapture.Type;

// ---------------------------------------------------------------------------
// Capability evaluations, jobs, and fee policy
// ---------------------------------------------------------------------------

/**
 * One run of an installed capability version over a sealed source window.
 *
 * Identity-first: environment and (when a conversation caused it) thread,
 * with the observation and execution chain labels carried separately so a
 * record can never claim it executed on the chain it observed. Detector
 * semantics are the capability's runtime output — this schema carries the
 * verdict's provenance, not the verdict itself.
 */
export const ForgeEvaluationStatus = Schema.Literals(["pending", "complete", "failed"]);
export type ForgeEvaluationStatus = typeof ForgeEvaluationStatus.Type;

export const ForgeEvaluation = Schema.Struct({
  evaluationId: Schema.String.check(Schema.isNonEmpty()),
  environmentId: Schema.String.check(Schema.isNonEmpty()),
  /** The thread whose conversation asked for this; absent when env-scoped. */
  threadId: Schema.optional(Schema.String),
  capabilityId: Schema.optional(Schema.String),
  capabilityVersion: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  observationChain: ForgeObservationChain,
  executionChain: ForgeExecutionChain,
  window: Schema.Struct({ startedAt: UnixSeconds, endedAt: UnixSeconds }),
  /** Historical windows are labeled here and can never drive live policy. */
  historical: Schema.Boolean,
  pinnedBlock: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  sourceDigest: Schema.optional(Schema.String),
  /** Evidence rows backing this evaluation, read back by id. */
  evidenceIds: Schema.Array(Schema.String),
  status: ForgeEvaluationStatus,
  /** Present on `failed`; never a success detail. */
  failureReason: Schema.optional(Schema.String),
  createdAtMs: UnixMillis,
  completedAtMs: Schema.optional(UnixMillis),
});
export type ForgeEvaluation = typeof ForgeEvaluation.Type;

/** The reactor jobs the Forge lifecycle runs, with provider-independent control. */
export const ForgeJobKind = Schema.Literals([
  "build",
  "evaluation",
  "revision",
  "policy-publication",
]);
export type ForgeJobKind = typeof ForgeJobKind.Type;

export const ForgeJobStatus = Schema.Literals([
  "queued",
  "running",
  "complete",
  "failed",
  "cancelled",
]);
export type ForgeJobStatus = typeof ForgeJobStatus.Type;

export const ForgeJob = Schema.Struct({
  jobId: Schema.String.check(Schema.isNonEmpty()),
  kind: ForgeJobKind,
  status: ForgeJobStatus,
  environmentId: Schema.String.check(Schema.isNonEmpty()),
  threadId: Schema.optional(Schema.String),
  createdAtMs: UnixMillis,
  startedAtMs: Schema.optional(UnixMillis),
  completedAtMs: Schema.optional(UnixMillis),
  /** Progress or failure line; a cancelled job says what was cancelled. */
  detail: Schema.optional(Schema.String),
});
export type ForgeJob = typeof ForgeJob.Type;

/**
 * The fee tier the fixed v4 hook can apply, in hundredths of a basis point.
 * The hook accepts exactly these two values (0.05% and 0.30%); the contract
 * narrows to them so nothing upstream can propose a fee the hook would
 * reject — or silently round.
 */
export const ForgeHookFeeHundredthsBps = Schema.Literals([500, 3000]);
export type ForgeHookFeeHundredthsBps = typeof ForgeHookFeeHundredthsBps.Type;

/** The fee the hook charges with no confirmed detection policy in force. */
export const FORGE_HOOK_BASELINE_FEE: ForgeHookFeeHundredthsBps = 3000;

export const ForgePolicyStatus = Schema.Literals([
  "draft",
  "submitted",
  "confirmed",
  "expired",
  "failed",
]);
export type ForgePolicyStatus = typeof ForgePolicyStatus.Type;

/**
 * A fee policy publication bound to the observation that produced it.
 *
 * `executionChain` is Sepolia and only Sepolia. `sourceEvaluationId`,
 * `observationDigest`, and the expiry keep the on-chain fee attributable to
 * the exact sealed window that justified it; an expired or stale policy
 * means baseline fee, never a held-over detection fee.
 */
export const ForgePolicy = Schema.Struct({
  policyId: Schema.String.check(Schema.isNonEmpty()),
  environmentId: Schema.String.check(Schema.isNonEmpty()),
  threadId: Schema.optional(Schema.String),
  executionChain: ForgeExecutionChain,
  hookAddress: Schema.optional(EvmAddress),
  /** The fee applied while this policy is confirmed and unexpired. */
  detectionFeeHundredthsBps: ForgeHookFeeHundredthsBps,
  status: ForgePolicyStatus,
  sourceEvaluationId: Schema.optional(Schema.String),
  observationDigest: Schema.optional(Schema.String),
  /** Unix seconds after which the hook reverts to the baseline fee. */
  expiresAtUnix: Schema.optional(UnixSeconds),
  publishedAtMs: Schema.optional(UnixMillis),
  txHash: Schema.optional(Schema.String),
  createdAtMs: UnixMillis,
});
export type ForgePolicy = typeof ForgePolicy.Type;

// ---------------------------------------------------------------------------
// Per-pool chart series (UI handoff)
// ---------------------------------------------------------------------------

/**
 * One point of a per-pool series: a real swap, priced exactly, with the
 * observation it came from. Pool activity is never coerced into candle
 * OHLC — a swap series with per-point provenance is its own shape.
 */
export const ForgePoolSeriesPoint = Schema.Struct({
  /** Unix seconds, the observation's own timestamp. */
  t: UnixSeconds,
  priceQuotePerBaseMicros: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  quoteVolumeMicros: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  /** `transactionHash:logIndex` — the provenance id. */
  observationId: Schema.String.check(Schema.isNonEmpty()),
});
export type ForgePoolSeriesPoint = typeof ForgePoolSeriesPoint.Type;

/** An interval inside the domain with no observations beyond the gap bound. */
export const ForgeSeriesGap = Schema.Struct({
  fromUtcMs: UnixMillis,
  toUtcMs: UnixMillis,
});
export type ForgeSeriesGap = typeof ForgeSeriesGap.Type;

/**
 * The UTC millisecond span a series claims. Start may equal end (a single
 * instant) but never exceed it — an inverted domain is a caller bug, and a
 * chart drawing it would show negative time.
 */
export const ForgeUtcDomain = Schema.Struct({
  start: UnixMillis,
  end: UnixMillis,
}).check(
  Schema.makeFilter(
    (input) => input.start <= input.end || "A UTC domain cannot end before it starts.",
  ),
);
export type ForgeUtcDomain = typeof ForgeUtcDomain.Type;

/** The anchor a series window resolved, or its honest absence. */
export const ForgeSeriesAnchor = Schema.Struct({
  status: ForgeAnchorCoverage,
  observationId: Schema.optional(Schema.String),
  priceQuotePerBaseMicros: Schema.optional(Schema.Number),
  ageBeforeWindowSeconds: Schema.optional(Schema.Int),
});
export type ForgeSeriesAnchor = typeof ForgeSeriesAnchor.Type;

/**
 * One pre-window anchor candidate as a surface needs it: which swap, at what
 * price and volume, how old. The COMPLETE candidate set is the coverage
 * guarantee — anchor selection (and the F5 "nearest one is tiny" revision)
 * happens over all of these, never over a single nearest row.
 */
export const ForgeSeriesAnchorCandidate = Schema.Struct({
  observationId: Schema.String.check(Schema.isNonEmpty()),
  priceQuotePerBaseMicros: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  quoteVolumeMicros: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  ageBeforeWindowSeconds: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type ForgeSeriesAnchorCandidate = typeof ForgeSeriesAnchorCandidate.Type;

/**
 * The bounded per-pool series a chart renders: explicit UTC domain, real
 * points, the anchor the window resolved, the gaps in it, where it came
 * from, and how healthy that source is. Points are swaps the subgraph
 * served — a quiet pool renders a short series with gaps, never
 * interpolated ones.
 */
export const ForgePoolSeries = Schema.Struct({
  poolId: PoolRef,
  chain: ForgeObservationChain,
  quoteUnits: ForgeQuoteUnits,
  /** The exact UTC millisecond domain the series claims. */
  domainUtcMs: ForgeUtcDomain,
  /** The point cap applied; always ≤ FORGE_MAX_SERIES_POINTS. */
  maxPoints: Schema.Int.check(Schema.isGreaterThan(0)),
  points: Schema.Array(ForgePoolSeriesPoint),
  anchor: ForgeSeriesAnchor,
  /** Every pre-window candidate in the anchor buffer, oldest first. */
  anchorCandidates: Schema.Array(ForgeSeriesAnchorCandidate),
  gaps: Schema.Array(ForgeSeriesGap),
  coverage: Schema.Struct({
    firstObservedUnixSeconds: Schema.optional(UnixSeconds),
    lastObservedUnixSeconds: Schema.optional(UnixSeconds),
  }),
  provenance: Schema.Struct({
    deployment: Schema.String,
    pinnedBlock: Schema.optional(Schema.Int),
    sourceDigest: Schema.optional(Schema.String),
    evidenceId: Schema.optional(Schema.String),
    fetchedAtMs: UnixMillis,
  }),
  health: ForgeSourceHealth,
});
export type ForgePoolSeries = typeof ForgePoolSeries.Type;

/**
 * The discovery list: what Forge sources exist and how they are doing,
 * independent of any Hyperliquid market row. A thread with `threadMarket =
 * null` still sees this — Forge is a source in its own right, not an
 * attachment to a Hyperliquid focus.
 */
export const ForgeSourceListing = Schema.Struct({
  config: ForgeSourceConfig,
  pools: Schema.Array(
    Schema.Struct({
      poolId: EvmAddress,
      label: Schema.String,
      feeTierHundredthsBps: Schema.Int,
      quoteUnits: ForgeQuoteUnits,
    }),
  ),
  health: ForgeSourceHealth,
});
export type ForgeSourceListing = typeof ForgeSourceListing.Type;

// ---------------------------------------------------------------------------
// Series assembly (pure)
// ---------------------------------------------------------------------------

/**
 * Gaps in a point series against its domain.
 *
 * A gap is any interval longer than `maxGapSeconds` with no observation:
 * domain start to first point, between consecutive points, and last point
 * to domain end. A series over a domain it never covers reports that whole
 * span as a gap, so a surface cannot mistake silence for calm.
 */
export function forgeSeriesGaps(
  points: ReadonlyArray<{ readonly t: number }>,
  domainStartSeconds: number,
  domainEndSeconds: number,
  maxGapSeconds: number,
): ReadonlyArray<ForgeSeriesGap> {
  const toMs = (seconds: number): number => seconds * 1000;
  const gaps: Array<ForgeSeriesGap> = [];
  const bounds: ReadonlyArray<number> = [
    domainStartSeconds,
    ...points.map((point) => point.t),
    domainEndSeconds,
  ];
  for (let index = 1; index < bounds.length; index += 1) {
    const from = bounds[index - 1];
    const to = bounds[index];
    if (from === undefined || to === undefined) continue;
    if (to - from > maxGapSeconds) {
      gaps.push({ fromUtcMs: toMs(from), toUtcMs: toMs(to) });
    }
  }
  return gaps;
}

/**
 * Downsample a point series to at most `maxPoints`, keeping the newest
 * points and never interpolating. The oldest overflow is dropped and the
 * domain's left edge says so through `coverage`, which the caller serves.
 */
export function capSeriesPoints<T extends { readonly t: number }>(
  points: ReadonlyArray<T>,
  maxPoints: number,
): ReadonlyArray<T> {
  if (points.length <= maxPoints) return [...points];
  return points.slice(points.length - maxPoints);
}
