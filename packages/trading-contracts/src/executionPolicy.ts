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
import { FORGE_CAPABILITY_ID_PATTERN } from "./observation.ts";
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
  readonly expiresAtMs: number;
}): string {
  return JSON.stringify([
    "trading_execution.quote.v2",
    input.chainId,
    input.routeId,
    input.tokenIn,
    input.tokenOut,
    input.amountInRaw,
    input.minAmountOutRaw,
    input.quotedAtMs,
    input.expiresAtMs,
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
 * `quotedAtMs` at minimum, so it mints a new id. Quotes with identical
 * execution terms and validity collapse to the same identity.
 */
export function swapQuoteId(input: {
  readonly chainId: string;
  readonly routeId: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly amountInRaw: string;
  readonly minAmountOutRaw: string;
  readonly quotedAtMs: number;
  readonly expiresAtMs: number;
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

// ---------------------------------------------------------------------------
// Sealed policy-program I/O (the generated execution policy's boundary)
// ---------------------------------------------------------------------------

/**
 * The bound on a `not-matched`/`unknown` explanation inside the policy input.
 * The full `DetectionResult` carries fact and evidence arrays the sealed input
 * must not bloat with; the mirror below keeps only the bounded summary (the
 * `ForgeDetectorResultSummary` discipline).
 */
export const POLICY_EXPLANATION_MAX_CHARS = 500;

/** The bound on the prior-proposals window the host seals into the input. */
export const POLICY_PRIOR_PROPOSALS_MAX = 20;

/**
 * The three-shape detector result the policy program sees — a deliberate
 * local mirror of the `ForgeDetectorResultSummary` shape (itself the bounded
 * mirror of `researchEvidence.ts`'s authoritative `DetectionResult`), restated
 * here so this module keeps its dependency surface unchanged and avoids any
 * cross-package import cycle. `matched` carries the occurrence identity and
 * how long the match stands; the other two carry the program's own bounded
 * "why". Keep the three statuses and their meaning in sync with the
 * authoritative vocabulary.
 */
export const DetectorResultForPolicy = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("matched"),
    occurrenceKey: TradingId,
    validUntilMs: UnixMillis,
  }),
  Schema.Struct({
    status: Schema.Literal("not-matched"),
    explanation: Schema.String.check(Schema.isMaxLength(POLICY_EXPLANATION_MAX_CHARS)),
  }),
  Schema.Struct({
    status: Schema.Literal("unknown"),
    explanation: Schema.String.check(Schema.isMaxLength(POLICY_EXPLANATION_MAX_CHARS)),
  }),
]);
export type DetectorResultForPolicy = typeof DetectorResultForPolicy.Type;

/**
 * One already-persisted proposal, bounded for the sealed input: the stage it
 * took, what kind it was, its input amount when it was a swap, and when it
 * occurred. No quote, no identity fields — the policy reasons over its own
 * history, it does not re-derive it.
 */
export const PersistedProposalSummary = Schema.Struct({
  stageKey: Schema.String.check(Schema.isNonEmpty()),
  kind: Schema.Literals(["wait", "price", "swap", "stop-future-actions", "complete"]),
  amountInRaw: Schema.optional(DecimalIntegerString),
  occurredAtMs: UnixMillis,
});
export type PersistedProposalSummary = typeof PersistedProposalSummary.Type;

/**
 * Everything a generated execution policy is fed, exactly. The host seals
 * this; the policy program has no clock, no fetch, and no view outside it.
 *
 * - `asOfMs` — the host-provided evaluation clock, the ONLY time the policy
 *   ever sees (the same rule as the detector input).
 * - `envelope` — the host-verified, immutable, user-approved grant. The
 *   program proposes INSIDE it; it can never widen it.
 * - `detectorEvaluation` — the latest committed detector evaluation, bounded
 *   through {@link DetectorResultForPolicy}. Only a `matched` evaluation ever
 *   reaches the policy (the other outcomes are valid non-actions the host
 *   returns without running the program).
 * - `priorProposals` — the newest-last bounded window of this envelope's
 *   already-persisted proposals, so a deterministic policy can see what it
 *   already decided.
 * - `remainingInputCapRaw` — the host-computed remaining spend (settled +
 *   in-flight deducted). Informative for the program; the host re-checks any
 *   proposed amount against the envelope caps itself and NEVER clamps.
 * - `priorState` — the policy's own carried state (a SEPARATE lineage from
 *   the detector's state; the same envelope wrapper and byte cap apply, but
 *   the rows never mix).
 */
export const PolicyProgramInputV2 = Schema.Struct({
  policySchemaVersion: Schema.Literal(2),
  asOfMs: UnixMillis,
  envelope: ExecutionEnvelope,
  detectorEvaluation: Schema.Struct({
    evaluationId: TradingId,
    asOfMs: UnixMillis,
    result: DetectorResultForPolicy,
  }),
  priorProposals: Schema.Array(PersistedProposalSummary).check(
    Schema.isMaxLength(POLICY_PRIOR_PROPOSALS_MAX),
  ),
  remainingInputCapRaw: DecimalIntegerString,
  priorState: Schema.optional(Schema.Unknown),
});
export type PolicyProgramInputV2 = typeof PolicyProgramInputV2.Type;

/**
 * What a policy program returns: one proposal and the state it wants carried
 * to the next evaluation. The host validates the proposal against the
 * envelope and the budget, and the next state against the envelope contract
 * (the detector state envelope, same 256 KiB cap), before persisting either.
 */
export const PolicyProgramOutputV2 = Schema.Struct({
  proposal: ExecutionProposal,
  nextState: Schema.Unknown,
});
export type PolicyProgramOutputV2 = typeof PolicyProgramOutputV2.Type;

// ---------------------------------------------------------------------------
// Persisted proposal records
// ---------------------------------------------------------------------------

/**
 * Where a persisted proposal stands. One-way: `proposed → executing →
 * executed`, with `proposed → rejected` / `proposed|executing → superseded`
 * as the honest exits. No proposal row is ever deleted; the swap-kind stage
 * uniqueness is a storage predicate (a partial unique index over
 * `(envelope_id, stage_key)` where the stage is present).
 */
export const PersistedProposalStatus = Schema.Literals([
  "proposed",
  "rejected",
  "executing",
  "executed",
  "superseded",
]);
export type PersistedProposalStatus = typeof PersistedProposalStatus.Type;

/**
 * One persisted policy proposal: the decision, its identity, and the
 * committed detector evaluation it was derived from. `proposalId` is
 * content-derived (see {@link proposalId}) so a replay of the same evaluation
 * at the same stage collapses instead of double-proposing.
 */
export const PersistedProposalRecord = Schema.Struct({
  proposalId: TradingId,
  envelopeRevision: Schema.Int.check(Schema.isGreaterThan(0)),
  environmentId: TradingId,
  capabilityId: Schema.String.check(Schema.isPattern(FORGE_CAPABILITY_ID_PATTERN)),
  detectorEvaluationId: TradingId,
  proposal: ExecutionProposal,
  proposedAtMs: UnixMillis,
  status: PersistedProposalStatus,
});
export type PersistedProposalRecord = typeof PersistedProposalRecord.Type;

/**
 * The canonical serialization a proposal's content identity is taken over: a
 * fixed-shape array under a version tag (the `serializeDetectorEvaluationIdentity`
 * precedent — never an object, whose key order a serializer could reorder).
 * `stageKey` is the proposal's stage when it is swap-kind, null otherwise.
 */
export function serializeProposalIdentity(input: {
  readonly envelopeRevision: number;
  readonly capabilityId: string;
  readonly detectorEvaluationId: string;
  readonly stageKey: string | null;
  readonly proposedAtMs: number;
}): string {
  return JSON.stringify([
    "trading_execution.proposal.v1",
    input.envelopeRevision,
    input.capabilityId,
    input.detectorEvaluationId,
    input.stageKey,
    input.proposedAtMs,
  ]);
}

/**
 * The content identity of one persisted proposal: `pprop_` plus the first 24
 * hex characters of the SHA-256 over the canonical identity serialization. A
 * re-evaluation of the same detector evaluation at the same stage and clock
 * collapses to the same id (idempotent); a changed evaluation, stage, or
 * clock does not. The host still treats the (envelope, stage) pair as the
 * authoritative replay guard — the identity makes the common replay collapse,
 * the storage predicate makes the race impossible.
 */
export function proposalId(input: {
  readonly envelopeRevision: number;
  readonly capabilityId: string;
  readonly detectorEvaluationId: string;
  readonly stageKey: string | null;
  readonly proposedAtMs: number;
}): string {
  return `pprop_${sha256Hex(serializeProposalIdentity(input)).slice(0, 24)}`;
}

// ---------------------------------------------------------------------------
// Swap intents (P5.4 — the local execution path's durable unit)
// ---------------------------------------------------------------------------

/**
 * Where a swap intent stands. One-way:
 * `prepared → submit-refused | submitted`, and `submitted → confirmed |
 * reverted | unknown` once receipts exist (the last three are declared so the
 * state machine is honest from day one; only `prepared` and `submit-refused`
 * are reachable while no signer is authorized). `unknown` PRESERVES ambiguity
 * rather than resolving it — the same rule {@link ExecutionIntentStatus}
 * states for the general flow.
 */
export const SwapIntentStatus = Schema.Literals([
  "prepared",
  "submit-refused",
  "submitted",
  "confirmed",
  "reverted",
  "unknown",
]);
export type SwapIntentStatus = typeof SwapIntentStatus.Type;

/**
 * The canonical serialization a swap intent's content identity is taken over
 * (the fixed-shape-array rule every identity in this module follows). The
 * prepared transaction rides as its own canonical JSON string, so a changed
 * calldata, value, or gas ceiling is a changed identity.
 */
export function serializeSwapIntentIdentity(input: {
  readonly proposalId: string;
  readonly quoteId: string;
  readonly preparedTxJson: string;
}): string {
  return JSON.stringify([
    "trading_execution.swap_intent.v1",
    input.proposalId,
    input.quoteId,
    input.preparedTxJson,
  ]);
}

/**
 * The content identity of one swap intent: `sint_` plus the first 24 hex
 * characters of the SHA-256 over the canonical identity serialization.
 * Re-preparing the same proposal against the same quote with the same
 * prepared bytes collapses to the same id (idempotent); a changed quote or
 * changed prepared transaction mints a new id, which the ONE-intent-per-
 * proposal storage predicate turns into the `superseded-quote` refusal —
 * repricing is a NEW proposal, never a mutation of a retained intent.
 */
export function swapIntentId(input: {
  readonly proposalId: string;
  readonly quoteId: string;
  readonly preparedTxJson: string;
}): string {
  return `sint_${sha256Hex(serializeSwapIntentIdentity(input)).slice(0, 24)}`;
}

/**
 * One prepared exact-input swap: the proposal that authorized it, the quote
 * it priced against, and the exact unsigned transaction bytes that would be
 * signed. The record carries NO authority of its own — every field was
 * re-validated against the envelope at preparation time, and submission is
 * a separate, refusing-by-default step. `preparedTxJson` is the canonical
 * `{ to, data, value, chainId, gasWei, nonce: null }` serialization; the
 * nonce and concrete gas are stamped only by an authorized signer pass (the
 * F0 draft-only gas-stamp precedent), which does not exist yet.
 */
export const SwapIntentRecord = Schema.Struct({
  intentId: TradingId,
  environmentId: TradingId,
  envelopeId: TradingId,
  proposalId: TradingId,
  quoteId: TradingId,
  routeId: Schema.String.check(Schema.isNonEmpty()),
  tokenIn: ExecutionEvmAddress,
  tokenOut: ExecutionEvmAddress,
  amountInRaw: DecimalIntegerString,
  minAmountOutRaw: DecimalIntegerString,
  /** The envelope candidate's recipient — where the output must land. */
  recipient: ExecutionEvmAddress,
  /** The approved route's swap target (the PoolSwapTest-style contract). */
  swapTargetAddress: ExecutionEvmAddress,
  preparedTxJson: Schema.String.check(Schema.isNonEmpty()),
  status: SwapIntentStatus,
  preparedAtMs: UnixMillis,
  attemptAtMs: Schema.optional(UnixMillis),
  refusalReason: Schema.optional(Schema.String),
});
export type SwapIntentRecord = typeof SwapIntentRecord.Type;
