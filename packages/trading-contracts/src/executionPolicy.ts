/**
 * Execution-policy contracts — the sealed vocabulary a generated execution
 * program proposes inside, and the immutable quote record its swap proposals
 * must bind to.
 *
 * The division of labor (the "policy proposes / host admits" rule the pool
 * proposals already follow): the generated program varies timing, size,
 * candidate, and stage INSIDE an envelope the user approved, and the host
 * validates, admits, and signs. This module seals the vocabulary both sides
 * speak:
 *
 * - `ExecutionEnvelope` is the immutable user-approved grant: which bundles
 *   (detector + policy, by content hash) may act, over which predeclared
 *   `SwapCandidate`s, under which input/gas/slippage/transaction ceilings,
 *   until when. Revisions are new envelopes, never edits.
 * - `ExecutionProposal` is one decision the policy emits: wait, price a
 *   candidate, swap one candidate now, stop future actions, or complete.
 *   A swap proposal carries no spending authority of its own — every amount
 *   must fit the envelope caps through {@link withinInputBudget}.
 * - `SwapQuoteRecord` is the immutable result of one exact-input quote. A
 *   repricing is a NEW record with a new id, never a mutation of a retained
 *   one; its identity is content-derived so a requote of the same numbers at
 *   the same millisecond collapses instead of double-recording.
 *
 * Rules this module enforces by construction:
 *
 * - Amounts are exact decimal integer strings with named units (raw token
 *   units, wei, bps). Quote-DERIVED decimals are never authorization amounts:
 *   decimals-adjusted or float-derived values may inform display and policy,
 *   but only raw integer caps and raw integer proposal amounts ever gate
 *   spending.
 * - A proposal outside the envelope is refused and re-proposed, NEVER
 *   clamped to fit. Clamping would turn a policy's decision into a different
 *   decision the user never approved.
 * - Budget math fails closed. `withinInputBudget` returns false on malformed
 *   input (nothing may spend on an unparseable cap), and
 *   `remainingInputBudget` returns "0" (a cap that cannot be understood
 *   authorizes nothing). Neither ever throws.
 *
 * Schemas and pure helpers only; the quote service, policy evaluator,
 * envelope store, and swap-intent flow live in the server (P5.2-P5.4).
 *
 * @module TradingExecutionPolicy
 */
import { Schema } from "effect";
import { sha256 } from "@noble/hashes/sha2";

import { TradingId, UnixMillis } from "./primitives.ts";
import { ChainIdString, DecimalIntegerString, Sha256Hex } from "./researchEvidence.ts";

// ---------------------------------------------------------------------------
// Address primitive
// ---------------------------------------------------------------------------

/**
 * An EVM address as the execution vocabulary carries it: `0x` plus exactly 40
 * hex characters (20 bytes). Stricter than `primitives.ts`'s published
 * `EvmAddress` template (`0x${string}`) because these records name concrete
 * token contracts and recipients that routing and admission must key on
 * exactly — a malformed address here is a refusal, never an echo.
 */
export const ExecutionEvmAddress = Schema.String.check(Schema.isPattern(/^0x[0-9a-fA-F]{40}$/));
export type ExecutionEvmAddress = typeof ExecutionEvmAddress.Type;

// ---------------------------------------------------------------------------
// Swap candidates
// ---------------------------------------------------------------------------

/**
 * One predeclared swap the envelope authorizes: a chain, an input token, an
 * output token, and the recipient the output must land on. Deliberately
 * amount-free — the caps live on the envelope, so a candidate can never carry
 * spending authority of its own.
 */
export const SwapCandidate = Schema.Struct({
  candidateId: Schema.String.check(Schema.isNonEmpty()),
  chainId: ChainIdString,
  tokenIn: ExecutionEvmAddress,
  tokenOut: ExecutionEvmAddress,
  /** The approved account the output tokens must land on. */
  recipient: ExecutionEvmAddress,
  /** Display label for surfaces; never parsed, never an identity. */
  label: Schema.optional(Schema.String.check(Schema.isNonEmpty())),
});
export type SwapCandidate = typeof SwapCandidate.Type;

// ---------------------------------------------------------------------------
// The execution envelope
// ---------------------------------------------------------------------------

/** The most candidates one envelope may predeclare (the file 04 ceiling). */
export const EXECUTION_ENVELOPE_CANDIDATES_MAX = 16;

/** The most intents the envelope allows in flight at once. */
export const EXECUTION_ENVELOPE_MAX_CONCURRENT_INTENTS = 8;

/** The slippage ceiling in basis points: 10_000 bps = 100%. */
export const EXECUTION_ENVELOPE_MAX_SLIPPAGE_BPS = 10_000;

/**
 * The immutable user-approved grant a generated execution policy acts inside.
 * `detectorBundleSha256` and `policyBundleSha256` bind the exact bundle bytes
 * (via the manifest artifact hashes) so a rebuild, edit, or version bump of
 * either program invalidates every admission under this envelope — a changed
 * bundle must be re-approved as a new revision, never silently honored.
 */
export const ExecutionEnvelope = Schema.Struct({
  /** Envelope revision; edits are new revisions, this must be > 0. */
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
  environmentId: TradingId,
  accountId: Schema.String.check(Schema.isNonEmpty()),
  expiresAtMs: UnixMillis,
  detectorBundleSha256: Sha256Hex,
  policyBundleSha256: Sha256Hex,
  candidates: Schema.Array(SwapCandidate).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(EXECUTION_ENVELOPE_CANDIDATES_MAX),
  ),
  /** Ceiling on the sum of all input amounts spent under this envelope. */
  inputCapTotalRaw: DecimalIntegerString,
  /** Ceiling on any single swap's input amount. */
  inputCapPerSwapRaw: DecimalIntegerString,
  maxGasWei: DecimalIntegerString,
  maxSlippageBps: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: EXECUTION_ENVELOPE_MAX_SLIPPAGE_BPS }),
  ),
  maxTransactions: Schema.Int.check(Schema.isGreaterThan(0)),
  maxConcurrentIntents: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: EXECUTION_ENVELOPE_MAX_CONCURRENT_INTENTS }),
  ),
}).check(
  // Candidate ids are how proposals bind to predeclared swaps; two candidates
  // sharing an id would make that binding ambiguous.
  Schema.makeFilter((input) => {
    const seen = new Set<string>();
    for (const candidate of input.candidates) {
      if (seen.has(candidate.candidateId)) {
        return `duplicate candidateId: ${candidate.candidateId}`;
      }
      seen.add(candidate.candidateId);
    }
    return true;
  }),
  // A swap of a token for itself is not a predeclared trade, it is a malformed
  // candidate; refusing it here keeps the whole envelope unapprovable rather
  // than letting a no-op leg through approval.
  Schema.makeFilter((input) => {
    for (const candidate of input.candidates) {
      if (candidate.tokenIn === candidate.tokenOut) {
        return `candidate ${candidate.candidateId} must have distinct tokenIn and tokenOut`;
      }
    }
    return true;
  }),
);
export type ExecutionEnvelope = typeof ExecutionEnvelope.Type;

// ---------------------------------------------------------------------------
// Execution proposals
// ---------------------------------------------------------------------------

/**
 * One decision the generated execution policy emits. The policy proposes; the
 * host admits. A `swap` carries no authority of its own — admission re-checks
 * the candidate against the envelope, the budget against settled + in-flight
 * spend, and the quote against its identity and expiry.
 *
 * `occurrenceKey` echoes the detector evaluation's committed occurrence key
 * and `stageKey` names the stage within it; together with
 * `detectorEvaluationId` they are the replay guard — each occurrence/stage may
 * execute once, ever.
 */
export const ExecutionProposal = Schema.Union([
  /** Nothing to do; the policy will be asked again. */
  Schema.Struct({
    kind: Schema.Literal("wait"),
  }),
  /** Fetch a quote for a candidate without committing to spend. */
  Schema.Struct({
    kind: Schema.Literal("price"),
    candidateId: Schema.String.check(Schema.isNonEmpty()),
    reason: Schema.String.check(Schema.isNonEmpty()),
  }),
  /** Execute one exact-input swap of a predeclared candidate now. */
  Schema.Struct({
    kind: Schema.Literal("swap"),
    candidateId: Schema.String.check(Schema.isNonEmpty()),
    amountInRaw: DecimalIntegerString,
    quoteId: TradingId,
    occurrenceKey: Schema.String.check(Schema.isNonEmpty()),
    stageKey: Schema.String.check(Schema.isNonEmpty()),
    detectorEvaluationId: TradingId,
  }),
  /** Refuse all further proposals under this envelope (host stops asking). */
  Schema.Struct({
    kind: Schema.Literal("stop-future-actions"),
    reason: Schema.String.check(Schema.isNonEmpty()),
  }),
  /** The policy's work is done; the envelope may retire. */
  Schema.Struct({
    kind: Schema.Literal("complete"),
    summary: Schema.String.check(Schema.isNonEmpty()),
  }),
]);
export type ExecutionProposal = typeof ExecutionProposal.Type;

// ---------------------------------------------------------------------------
// Quote records
// ---------------------------------------------------------------------------

/**
 * The canonical serialization a quote's content identity is taken over: a
 * fixed-shape array under a version tag (the `serializeDetectorEvaluationIdentity`
 * precedent — never an object, whose key order a serializer could reorder).
 * The quote service hashes this string to mint {@link swapQuoteId}.
 */
export function serializeSwapQuoteIdentity(input: {
  readonly chainId: string;
  readonly routeId: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly amountInRaw: string;
  readonly minAmountOutRaw: string;
  readonly quotedAtMs: number;
}): string {
  return JSON.stringify([
    "trading_execution.quote.v1",
    input.chainId,
    input.routeId,
    input.tokenIn,
    input.tokenOut,
    input.amountInRaw,
    input.minAmountOutRaw,
    input.quotedAtMs,
  ]);
}

// -- pure SHA-256 ------------------------------------------------------------
//
// The quote id is a content identity. The contracts package is shared with
// the browser, so `node:crypto` is not available here; hashing goes through
// @noble/hashes (module-private in `detectorProgram.ts`, restated here), and
// the tests pin it against Web Crypto.

/** SHA-256 over the UTF-8 encoding of `value`, as lowercase hex. */
function sha256Hex(value: string): string {
  const digest = sha256(new TextEncoder().encode(value));
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/**
 * The content identity of one quote: `sq_` plus the first 24 hex characters of
 * the SHA-256 over the canonical identity serialization. A reprice changes
 * `quotedAtMs` at minimum, so it always mints a new id; only a byte-identical
 * requote at the same millisecond collapses to the same one.
 */
export function swapQuoteId(input: {
  readonly chainId: string;
  readonly routeId: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly amountInRaw: string;
  readonly minAmountOutRaw: string;
  readonly quotedAtMs: number;
}): string {
  return `sq_${sha256Hex(serializeSwapQuoteIdentity(input)).slice(0, 24)}`;
}

/**
 * One immutable exact-input quote. `routeId` names the approved-route
 * registry entry that produced the numbers; `basis` records HOW the numbers
 * were obtained, and `eth_call` (a read-only simulation against real state)
 * is the only basis admitted so far — a quote whose provenance is not a named
 * basis is not a quote. The schema-level check pins the one ordering rule the
 * id exists to carry: a quote must expire strictly after it was taken, or
 * admission can never verify freshness against it.
 */
export const SwapQuoteRecord = Schema.Struct({
  quoteId: TradingId,
  chainId: ChainIdString,
  routeId: Schema.String.check(Schema.isNonEmpty()),
  tokenIn: ExecutionEvmAddress,
  tokenOut: ExecutionEvmAddress,
  amountInRaw: DecimalIntegerString,
  minAmountOutRaw: DecimalIntegerString,
  gasEstimateWei: DecimalIntegerString,
  quotedAtMs: UnixMillis,
  expiresAtMs: UnixMillis,
  basis: Schema.Literals(["eth_call"]),
}).check(
  Schema.makeFilter((input) =>
    input.expiresAtMs > input.quotedAtMs ? true : "expiresAtMs must be strictly after quotedAtMs",
  ),
);
export type SwapQuoteRecord = typeof SwapQuoteRecord.Type;

// ---------------------------------------------------------------------------
// Pure budget math
// ---------------------------------------------------------------------------

/**
 * Parse a non-negative exact decimal integer string (the
 * `DecimalIntegerString` pattern) into a BigInt. Null — never a throw — on
 * anything else: negative, fractional, leading-zero, empty, or non-string
 * input from a JavaScript caller.
 */
function parseNonNegativeRaw(value: string): bigint | null {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) return null;
  return BigInt(value);
}

/** The join-input shape {@link withinInputBudget} decides over. */
export interface WithinInputBudgetInput {
  readonly proposedRaw: string;
  readonly perSwapCapRaw: string;
  readonly remainingRaw: string;
}

/**
 * Whether a proposed input amount may be admitted: strictly positive, within
 * the per-swap cap, and within the remaining budget.
 *
 * Equal-to-cap is within (the caps are ceilings, not targets). Any malformed
 * input returns false — an amount that cannot be parsed exactly can never be
 * authorized, and comparing it loosely (NaN-style) would fail open. This
 * function never throws and never clamps: a proposal outside the caps is the
 * caller's refusal-and-reproposal, not a smaller swap the policy never made.
 */
export function withinInputBudget(input: WithinInputBudgetInput): boolean {
  const proposed = parseNonNegativeRaw(input.proposedRaw);
  const perSwapCap = parseNonNegativeRaw(input.perSwapCapRaw);
  const remaining = parseNonNegativeRaw(input.remainingRaw);
  if (proposed === null || perSwapCap === null || remaining === null) return false;
  return proposed > 0n && proposed <= perSwapCap && proposed <= remaining;
}

/** The join-input shape {@link remainingInputBudget} folds over. */
export interface RemainingInputBudgetInput {
  readonly capTotalRaw: string;
  readonly settledRaw: string;
  readonly inFlightRaw: string;
}

/**
 * The remaining spendable input under an envelope's total cap: the total cap
 * minus settled spend minus in-flight reservations, floored at zero, as an
 * exact decimal string.
 *
 * Malformed input returns "0" — the fail-closed twin of
 * {@link withinInputBudget}'s false. A cap or a spend ledger that cannot be
 * parsed exactly authorizes NOTHING, because treating an unparseable ledger
 * as zero-spend would double-spend, and treating it as absent would
 * overspend. Over-subscription (settled + in-flight beyond the cap, possible
 * only through a bug or a cap lowered by revision) floors at zero rather
 * than authorizing a negative remainder.
 */
export function remainingInputBudget(input: RemainingInputBudgetInput): string {
  const capTotal = parseNonNegativeRaw(input.capTotalRaw);
  const settled = parseNonNegativeRaw(input.settledRaw);
  const inFlight = parseNonNegativeRaw(input.inFlightRaw);
  if (capTotal === null || settled === null || inFlight === null) return "0";
  const remaining = capTotal - settled - inFlight;
  return remaining <= 0n ? "0" : remaining.toString();
}

// ---------------------------------------------------------------------------
// Statuses and refusal vocabulary
// ---------------------------------------------------------------------------

/**
 * Where an envelope stands in its lifecycle. `approved` is the only state
 * admissions may run under; `revoked` and `expired` are terminal refusals.
 */
export const ExecutionEnvelopeStatus = Schema.Literals([
  "draft",
  "proposed",
  "approved",
  "revoked",
  "expired",
]);
export type ExecutionEnvelopeStatus = typeof ExecutionEnvelopeStatus.Type;

/**
 * Where an execution intent stands. The happy path runs
 * proposed → quoted → admitted → prepared → submitted → confirmed | reverted;
 * `refused`, `expired`, and `cancelled-before-submission` are the honest exits;
 * `unknown` means ambiguity is PRESERVED (with its reservations) until a
 * receipt or reconciliation resolves it — never silently mapped to a terminal
 * state. The Forge intent statuses (draft|submitted|confirmed|reverted|unknown)
 * are a separate vocabulary and remain untouched.
 */
export const ExecutionIntentStatus = Schema.Literals([
  "proposed",
  "quoted",
  "admitted",
  "prepared",
  "submitted",
  "confirmed",
  "reverted",
  "refused",
  "expired",
  "cancelled-before-submission",
  "unknown",
]);
export type ExecutionIntentStatus = typeof ExecutionIntentStatus.Type;

/**
 * Every reason an execution admission may be refused. Kept as one closed
 * vocabulary so refusal paths are exhaustive by construction: a switch over
 * `ExecutionRefusal` the compiler can check, and a frozen array tests can
 * walk. Adding a reason is adding it here first, then the refusal path that
 * emits it.
 */
export type ExecutionRefusal =
  | "envelope-revoked"
  | "envelope-expired"
  | "envelope-not-approved"
  | "budget-exhausted"
  | "stale-evidence"
  | "stale-quote"
  | "occurrence-already-executed"
  | "stage-already-executed"
  | "bundle-changed"
  | "route-unapproved"
  | "unconfigured"
  | "paused"
  | "broadcaster-missing";

/**
 * The frozen {@link ExecutionRefusal} array, in the declared order. Frozen so
 * no consumer can extend the vocabulary at runtime; exhaustive-switch tests
 * iterate it to prove every member is handled.
 */
export const EXECUTION_REFUSALS: readonly ExecutionRefusal[] = Object.freeze([
  "envelope-revoked",
  "envelope-expired",
  "envelope-not-approved",
  "budget-exhausted",
  "stale-evidence",
  "stale-quote",
  "occurrence-already-executed",
  "stage-already-executed",
  "bundle-changed",
  "route-unapproved",
  "unconfigured",
  "paused",
  "broadcaster-missing",
]);
