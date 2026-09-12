/**
 * SwapExecutionService — the local execution path's host: turn one persisted
 * swap proposal plus a fresh quote into a prepared exact-input transaction,
 * then attempt its submission (P5 slice 4).
 *
 * The division of labor is the same "policy proposes / host admits" rule the
 * envelope evaluator enforces: the generated policy emitted the proposal
 * (P5.3), the quote service priced it (P5.2), and THIS service re-validates
 * everything against the immutable user-approved envelope before it builds a
 * single byte of calldata. The swap's authority is the ENVELOPE — never the
 * F0 hook spend grant — so this service writes its own
 * `execution_swap_intents` rows and never touches `forge_intents`.
 *
 * The ladder every preparation climbs (each step a named refusal; nothing is
 * written before the intent INSERT except that INSERT itself):
 *
 *  1. the proposal exists in this environment, is swap-kind, and is still
 *     `proposed` (an executing/executed stage is `stage-already-executed`);
 *  2. its envelope is approved, not revoked, and not expired;
 *  3. the installed bundle still hashes to the envelope's detector/policy
 *     pins (`bundle-changed` — a rebuilt bundle is re-approved, never
 *     silently honored);
 *  4. the quote is fresh (the two-point freshness rule's second point),
 *     its route is in the approved registry, and its pair and amount match
 *     the proposal's candidate exactly (`stale-quote` names the field);
 *  5. the amount fits the per-swap cap and the remaining envelope budget
 *     (`budget-exhausted`, never clamped);
 *  6. the unsigned transaction is built deterministically (PoolSwapTest
 *     calldata over the route's pool key) and persisted as one immutable
 *     intent row;
 *  7. submission is refused before calling any broadcaster.
 *
 * Step 7 is the honest end of this slice: no signer is authorized, so the
 * service refuses `broadcaster-missing` and the intent lands
 * durably as `submit-refused`. The asymmetry is deliberate and load-bearing:
 * a refused submission RESERVES NOTHING — the proposal stays `proposed`, no
 * budget is consumed, nothing is in flight — so the operator can re-price
 * and re-propose freely. Only an actual submission (a future, separately
 * authorized pass) would mark the stage executing and reserve budget.
 *
 * SQL only: no RPC (the quote arrived already priced), no signer, no
 * Hyperliquid import, no F0 ledger write. Every clock arrives as an explicit
 * `now` on the input.
 *
 * @module SwapExecutionService
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { encodeFunctionData, type Hex } from "viem";

import {
  CapabilityManifestV2,
  detectorArtifactPaths,
  ExecutionEnvelope,
  ExecutionEnvelopeStatus,
  ExecutionProposal,
  remainingInputBudget,
  SwapIntentRecord,
  swapIntentId,
  withinInputBudget,
  type ExecutionRefusal,
  type SwapQuoteRecord,
} from "@t3tools/trading-contracts";
import { toPersistenceSqlError, PersistenceSqlError } from "../../persistence/Errors.ts";
import { forgeJsonEncode } from "./ForgeJsonEncode.ts";
import { forgeSha256Hex } from "./CapabilitySandbox.ts";
import {
  ForgeCapabilityStore,
  versionProgramKind,
  type ForgeCapabilityStoreShape,
} from "./CapabilityStore.ts";
import {
  QUOTE_GAS_ESTIMATE_WEI_PLACEHOLDER,
  routeFor,
  SwapRouteConfig,
  validateQuoteFresh,
} from "./UniswapQuoteService.ts";
import { swapRouteAbi } from "./PeripheryAbi.ts";
import { SEPOLIA_CHAIN_ID } from "./SepoliaTarget.ts";
import type { ForgeBroadcastRefusalReason } from "./UniswapTestnetAdapter.ts";
import type { ExecutionEnvelopeView } from "./ExecutionPolicyService.ts";

/** The most intent rows one listing read will return. */
const MAX_LISTED_INTENTS = 100;

/**
 * v4's native-currency marker: address(0). A pool's currency0 may be the
 * native currency, addressed as this zero address (it always sorts first);
 * when the input token IS the marker, the swap is paid as msg.value on the
 * payable PoolSwapTest call rather than pulled as an ERC-20.
 */
const NATIVE_CURRENCY_ADDRESS = `0x${"0".repeat(40)}`;

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

/**
 * The refusal names `prepareAndAttempt` can emit. Everything the frozen
 * {@link ExecutionRefusal} vocabulary names uses its literal; the extensions
 * are swap-intent-side integrity facts that vocabulary does not name:
 *
 * - `proposal-not-found` — no such proposal in this environment.
 * - `proposal-not-swap` — the proposal is not a swap proposal (or its stored
 *   bytes do not decode).
 * - `invalid-policy-output` — the proposal's envelope binding is corrupt
 *   (its candidateId is not predeclared); unreachable absent corruption and
 *   refused, never assumed.
 * - `superseded-quote` — this proposal already has an intent prepared against
 *   a DIFFERENT quote; repricing is a new proposal, never a mutation.
 * - `execution-unavailable` — required retained execution state is unavailable.
 * - `broadcaster-missing` — draft preparation cannot submit unprotected calldata.
 *   Other F0 refusal names remain in the shared compatibility vocabulary.
 */
export type SwapExecutionRefusalName =
  | ExecutionRefusal
  | ForgeBroadcastRefusalReason
  | "proposal-not-found"
  | "proposal-not-swap"
  | "invalid-policy-output"
  | "superseded-quote"
  | "execution-unavailable";

export type SwapPrepareOutcome =
  | {
      readonly status: "refused";
      readonly refusal: SwapExecutionRefusalName;
      readonly detail: string;
    }
  | {
      /** Idempotent replay: same proposal, same quote, same prepared bytes. */
      readonly status: "already-prepared";
      readonly intent: SwapIntentRecord;
    }
  | {
      /** Prepared, then the submission attempt refused. Nothing executed. */
      readonly status: "submit-refused";
      readonly intent: SwapIntentRecord;
      readonly refusal: SwapExecutionRefusalName;
      readonly detail: string;
    }
  | {
      /**
       * Prepared and a wired broadcaster accepted the bytes. Unreachable
       * while the only shipped broadcaster refuses; declared so the state
       * machine is honest from day one (the tx-hash/receipt columns land
       * with the authorized live pass).
       */
      readonly status: "submitted";
      readonly intent: SwapIntentRecord;
    };

/** The host-computed budget ledger over one envelope's swap proposals. */
export interface EnvelopeBudgetView {
  readonly remainingInputCapRaw: string;
  readonly settledRaw: string;
  readonly inFlightRaw: string;
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export interface SwapExecutionServiceShape {
  /**
   * Prepare one exact-input swap from a persisted proposal plus a fresh
   * quote, then attempt its submission. Never throws; every unhappy path is
   * a named refusal in the outcome. Refusals BEFORE the intent INSERT write
   * nothing; the submission refusal is recorded ON the intent row (durable)
   * while the proposal itself stays `proposed`.
   */
  readonly prepareAndAttempt: (input: {
    readonly environmentId: string;
    readonly proposalId: string;
    readonly quote: SwapQuoteRecord;
    readonly now: number;
  }) => Effect.Effect<SwapPrepareOutcome, PersistenceSqlError>;

  /** The intent prepared for a proposal, or null when none exists. */
  readonly intentFor: (
    proposalId: string,
  ) => Effect.Effect<SwapIntentRecord | null, PersistenceSqlError>;

  /** Intents under an envelope, newest first, at most `limit` (≤100). */
  readonly listIntents: (input: {
    readonly envelopeId: string;
    readonly limit?: number | undefined;
  }) => Effect.Effect<ReadonlyArray<SwapIntentRecord>, PersistenceSqlError>;

  /**
   * The envelope row by id, in the P5.3 service's own view shape (the same
   * tables and decode; the evaluator only serves the LATEST envelope per
   * capability, execution needs the one a proposal actually binds).
   */
  readonly envelopeById: (
    envelopeId: string,
  ) => Effect.Effect<ExecutionEnvelopeView | null, PersistenceSqlError>;

  /**
   * The explicit remaining input budget under an envelope: settled (executed)
   * and in-flight (executing) swap proposals deducted, fail closed. Null
   * when the envelope row does not exist or its bytes do not decode.
   */
  readonly remainingInputBudgetFor: (
    envelopeId: string,
  ) => Effect.Effect<EnvelopeBudgetView | null, PersistenceSqlError>;
}

export class SwapExecutionService extends Context.Service<
  SwapExecutionService,
  SwapExecutionServiceShape
>()("t3/trading/forge/SwapExecutionService") {}

const sqlFail = (operation: string) => toPersistenceSqlError(`SwapExecutionService.${operation}`);

// -- decode helpers (module-level, throw contained) --------------------------

const decodeEnvelopeBytes = (raw: string): ExecutionEnvelope | null => {
  try {
    return Schema.decodeUnknownSync(ExecutionEnvelope)(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
};

const decodeProposalJson = (raw: string): ExecutionProposal | null => {
  try {
    return Schema.decodeUnknownSync(ExecutionProposal)(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
};

const decodeManifestV2 = (raw: string): CapabilityManifestV2 | null => {
  try {
    return Schema.decodeUnknownSync(CapabilityManifestV2)(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
};

/** Stringify an error for the SQL-failure classifier; total. */
const describeSqlError = (error: unknown): string => {
  try {
    return forgeJsonEncode(error);
  } catch {
    return String(error);
  }
};

interface EnvelopeRow {
  readonly envelope_id: string;
  readonly environment_id: string;
  readonly capability_id: string | null;
  readonly revision: number;
  readonly status: string;
  readonly envelope_json: string;
  readonly proposed_at_ms: number;
  readonly approved_at_ms: number | null;
  readonly approved_via: string | null;
  readonly revoked_at_ms: number | null;
}

interface ProposalRow {
  readonly proposal_id: string;
  readonly environment_id: string;
  readonly capability_id: string;
  readonly envelope_id: string;
  readonly proposal_json: string;
  readonly status: string;
  readonly proposed_at_ms: number;
}

interface IntentRow {
  readonly intent_id: string;
  readonly environment_id: string;
  readonly envelope_id: string;
  readonly proposal_id: string;
  readonly quote_id: string;
  readonly route_id: string;
  readonly token_in: string;
  readonly token_out: string;
  readonly amount_in_raw: string;
  readonly min_amount_out_raw: string;
  readonly recipient: string;
  readonly swap_target: string;
  readonly prepared_tx_json: string;
  readonly status: string;
  readonly prepared_at_ms: number;
  readonly attempt_at_ms: number | null;
  readonly refusal_reason: string | null;
}

const toEnvelopeView = (row: EnvelopeRow): ExecutionEnvelopeView => ({
  envelopeId: row.envelope_id,
  environmentId: row.environment_id,
  capabilityId: row.capability_id,
  revision: row.revision,
  status: (Schema.is(ExecutionEnvelopeStatus)(row.status)
    ? row.status
    : "draft") as ExecutionEnvelopeView["status"],
  envelope: decodeEnvelopeBytes(row.envelope_json),
  proposedAtMs: row.proposed_at_ms,
  approvedAtMs: row.approved_at_ms,
  approvedVia: row.approved_via,
  revokedAtMs: row.revoked_at_ms,
});

const toIntentRecord = (row: IntentRow): SwapIntentRecord | null => {
  const candidate: Record<string, unknown> = {
    intentId: row.intent_id,
    environmentId: row.environment_id,
    envelopeId: row.envelope_id,
    proposalId: row.proposal_id,
    quoteId: row.quote_id,
    routeId: row.route_id,
    tokenIn: row.token_in,
    tokenOut: row.token_out,
    amountInRaw: row.amount_in_raw,
    minAmountOutRaw: row.min_amount_out_raw,
    recipient: row.recipient,
    swapTargetAddress: row.swap_target,
    preparedTxJson: row.prepared_tx_json,
    status: row.status,
    preparedAtMs: row.prepared_at_ms,
    ...(row.attempt_at_ms === null ? {} : { attemptAtMs: row.attempt_at_ms }),
    ...(row.refusal_reason === null ? {} : { refusalReason: row.refusal_reason }),
  };
  return Schema.is(SwapIntentRecord)(candidate) ? (candidate as SwapIntentRecord) : null;
};

/** The exact-decimal amount of a stored swap proposal, or null when malformed. */
const amountInOf = (proposalJson: string): string | null => {
  const proposal = decodeProposalJson(proposalJson);
  return proposal !== null && proposal.kind === "swap" ? proposal.amountInRaw : null;
};

/**
 * Key-sorted, undefined-dropping canonical JSON input (the envelope store's
 * normalization, restated): the prepared transaction's stored bytes are a
 * function of their content, so the content id is stable across processes.
 */
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

export const makeSwapExecutionService = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store: ForgeCapabilityStoreShape = yield* ForgeCapabilityStore;
  const routeConfig = yield* SwapRouteConfig;

  const intentFor: SwapExecutionServiceShape["intentFor"] = (proposalId) =>
    sql<IntentRow>`
      SELECT intent_id, environment_id, envelope_id, proposal_id, quote_id, route_id,
             token_in, token_out, amount_in_raw, min_amount_out_raw, recipient, swap_target,
             prepared_tx_json, status, prepared_at_ms, attempt_at_ms, refusal_reason
      FROM execution_swap_intents WHERE proposal_id = ${proposalId}
    `.pipe(
      Effect.mapError(sqlFail("intentFor")),
      Effect.map((rows) => (rows[0] === undefined ? null : toIntentRecord(rows[0]))),
    );

  const listIntents: SwapExecutionServiceShape["listIntents"] = ({ envelopeId, limit }) =>
    sql<IntentRow>`
      SELECT intent_id, environment_id, envelope_id, proposal_id, quote_id, route_id,
             token_in, token_out, amount_in_raw, min_amount_out_raw, recipient, swap_target,
             prepared_tx_json, status, prepared_at_ms, attempt_at_ms, refusal_reason
      FROM execution_swap_intents
      WHERE envelope_id = ${envelopeId}
      ORDER BY prepared_at_ms DESC, rowid DESC
      LIMIT ${Math.min(Math.max(limit ?? 50, 1), MAX_LISTED_INTENTS)}
    `.pipe(
      Effect.mapError(sqlFail("listIntents")),
      // Undecodable rows are skipped, never thrown (the listing discipline).
      Effect.map((rows) =>
        rows.flatMap((row) => {
          const record = toIntentRecord(row);
          return record === null ? [] : [record];
        }),
      ),
    );

  const envelopeById: SwapExecutionServiceShape["envelopeById"] = (envelopeId) =>
    sql<EnvelopeRow>`
      SELECT envelope_id, environment_id, capability_id, revision, status, envelope_json,
             proposed_at_ms, approved_at_ms, approved_via, revoked_at_ms
      FROM execution_envelopes WHERE envelope_id = ${envelopeId}
    `.pipe(
      Effect.mapError(sqlFail("envelopeById")),
      Effect.map((rows) => (rows[0] === undefined ? null : toEnvelopeView(rows[0]))),
    );

  const budgetRowsFor = (envelopeId: string) =>
    sql<{ readonly status: string; readonly proposal_json: string }>`
      SELECT status, proposal_json FROM execution_proposals
      WHERE envelope_id = ${envelopeId} AND stage_key IS NOT NULL
    `;

  const remainingInputBudgetFor: SwapExecutionServiceShape["remainingInputBudgetFor"] = (
    envelopeId,
  ) =>
    Effect.gen(function* () {
      const envelopeRows = yield* sql<Pick<EnvelopeRow, "envelope_json">>`
        SELECT envelope_json FROM execution_envelopes WHERE envelope_id = ${envelopeId}
      `.pipe(Effect.mapError(sqlFail("remainingInputBudgetFor")));
      const envelope =
        envelopeRows[0] === undefined ? null : decodeEnvelopeBytes(envelopeRows[0].envelope_json);
      if (envelope === null) return null;
      const rows = yield* budgetRowsFor(envelopeId).pipe(
        Effect.mapError(sqlFail("remainingInputBudgetFor")),
      );
      // The same ledger fold the envelope evaluator runs: an unparseable
      // amount fails closed (malformed ledger authorizes nothing).
      let settled = 0n;
      let inFlight = 0n;
      let malformed = false;
      for (const row of rows) {
        const amount = amountInOf(row.proposal_json);
        if (amount === null || !/^(0|[1-9][0-9]*)$/.test(amount)) {
          malformed = true;
          break;
        }
        const value = BigInt(amount);
        if (row.status === "executed") settled += value;
        if (row.status === "executing") inFlight += value;
      }
      return {
        remainingInputCapRaw: remainingInputBudget({
          capTotalRaw: envelope.inputCapTotalRaw,
          settledRaw: malformed ? "0" : settled.toString(),
          inFlightRaw: malformed ? "0" : inFlight.toString(),
        }),
        settledRaw: settled.toString(),
        inFlightRaw: inFlight.toString(),
      };
    });

  const prepareAndAttempt: SwapExecutionServiceShape["prepareAndAttempt"] = ({
    environmentId,
    proposalId,
    quote,
    now,
  }) =>
    Effect.gen(function* () {
      const refuse = (refusal: SwapExecutionRefusalName, detail: string) => ({
        status: "refused" as const,
        refusal,
        detail,
      });

      // Gate 1 — the proposal: present, swap-kind, still proposed.
      const proposalRows = yield* sql<ProposalRow>`
        SELECT proposal_id, environment_id, capability_id, envelope_id, proposal_json, status,
               proposed_at_ms
        FROM execution_proposals WHERE proposal_id = ${proposalId}
      `.pipe(Effect.mapError(sqlFail("prepareAndAttempt.proposal")));
      const proposalRow = proposalRows[0];
      if (proposalRow === undefined || proposalRow.environment_id !== environmentId) {
        return refuse("proposal-not-found", `no swap proposal ${proposalId} in this environment`);
      }
      const proposal = decodeProposalJson(proposalRow.proposal_json);
      if (proposal === null) {
        return refuse("proposal-not-swap", `proposal ${proposalId} does not decode`);
      }
      if (proposal.kind !== "swap") {
        return refuse(
          "proposal-not-swap",
          `proposal ${proposalId} is ${proposal.kind}, not a swap`,
        );
      }
      if (proposalRow.status !== "proposed") {
        return refuse(
          "stage-already-executed",
          `proposal status is ${proposalRow.status}; only a proposed proposal may prepare`,
        );
      }

      // Gate 2 — the envelope: approved, not revoked, not expired.
      const envelopeRows = yield* sql<EnvelopeRow>`
        SELECT envelope_id, environment_id, capability_id, revision, status, envelope_json,
               proposed_at_ms, approved_at_ms, approved_via, revoked_at_ms
        FROM execution_envelopes WHERE envelope_id = ${proposalRow.envelope_id}
      `.pipe(Effect.mapError(sqlFail("prepareAndAttempt.envelope")));
      const envelopeRow = envelopeRows[0];
      if (envelopeRow === undefined) {
        return refuse(
          "envelope-not-approved",
          `the proposal's envelope ${proposalRow.envelope_id} no longer exists`,
        );
      }
      const envelope = decodeEnvelopeBytes(envelopeRow.envelope_json);
      if (envelope === null || envelope.environmentId !== environmentId) {
        return refuse(
          "envelope-not-approved",
          `envelope ${envelopeRow.envelope_id} does not decode for this environment`,
        );
      }
      if (envelopeRow.status === "revoked") {
        return refuse("envelope-revoked", `envelope ${envelopeRow.envelope_id} is revoked`);
      }
      if (now >= envelope.expiresAtMs) {
        return refuse("envelope-expired", `the envelope expired at ${envelope.expiresAtMs}`);
      }
      if (envelopeRow.status !== "approved") {
        return refuse(
          "envelope-not-approved",
          `envelope status is ${envelopeRow.status}; only an approved envelope executes`,
        );
      }

      // Gate 3 — the installed bundle still hashes to the envelope's pins.
      // A rebuilt or edited program is a changed bundle: the user re-approves
      // a new revision, it is never silently honored.
      const active = yield* store
        .activeState({ environmentId, capabilityId: proposalRow.capability_id })
        .pipe(Effect.mapError(sqlFail("prepareAndAttempt.activeState")));
      if (active === null || active.status === "uninstalled") {
        return refuse("unconfigured", `${proposalRow.capability_id} is not installed`);
      }
      if (active.status === "paused") {
        return refuse("paused", `${proposalRow.capability_id} is paused`);
      }
      const manifestJson = yield* store
        .readArtifact({
          environmentId,
          capabilityId: proposalRow.capability_id,
          version: active.version,
          path: "manifest.json",
        })
        .pipe(Effect.mapError(sqlFail("prepareAndAttempt.readArtifact")));
      if (manifestJson === null || versionProgramKind(manifestJson) !== "v2") {
        return refuse("bundle-changed", `manifest.json of v${active.version} is missing or not v2`);
      }
      const manifest = decodeManifestV2(manifestJson);
      if (manifest === null) {
        return refuse("bundle-changed", "the installed v2 manifest does not decode");
      }
      const paths = detectorArtifactPaths(manifest);
      if ("refusal" in paths || !paths.paths.includes("policy.ts")) {
        return refuse("bundle-changed", "the installed bundle declares no policy artifact");
      }
      const readArtifact = (path: string) =>
        store
          .readArtifact({
            environmentId,
            capabilityId: proposalRow.capability_id,
            version: active.version,
            path,
          })
          .pipe(Effect.mapError(sqlFail("prepareAndAttempt.readArtifact")));
      const detectorBytes = yield* readArtifact("detector.ts");
      const policyBytes = yield* readArtifact("policy.ts");
      if (detectorBytes === null || policyBytes === null) {
        return refuse("bundle-changed", "a pinned bundle artifact is missing from the store");
      }
      if (forgeSha256Hex(detectorBytes) !== envelope.detectorBundleSha256) {
        return refuse(
          "bundle-changed",
          "the installed detector artifact hash differs from the envelope's pin",
        );
      }
      if (forgeSha256Hex(policyBytes) !== envelope.policyBundleSha256) {
        return refuse(
          "bundle-changed",
          "the installed policy artifact hash differs from the envelope's pin",
        );
      }

      // Gate 4 — the quote: fresh, on an approved route, matching the
      // proposal's candidate pair and amount EXACTLY. This is the two-point
      // freshness rule's second point (validateQuoteFresh); the first was
      // the quote service's own at pricing time.
      if (!validateQuoteFresh(quote, now)) {
        return refuse(
          "stale-quote",
          `quote ${quote.quoteId} is not fresh at ${now} (quoted ${quote.quotedAtMs}, expires ${quote.expiresAtMs})`,
        );
      }
      const settings = yield* routeConfig.resolve.pipe(
        Effect.mapError(sqlFail("prepareAndAttempt.routes")),
      );
      const route = routeFor(settings, quote.routeId);
      if (route === null) {
        return refuse(
          "route-unapproved",
          `route ${quote.routeId} is not in the approved route registry${settings.configured ? "" : ` (${settings.reason ?? "unconfigured"})`}`,
        );
      }
      const candidate = envelope.candidates.find(
        (entry) => entry.candidateId === proposal.candidateId,
      );
      if (candidate === undefined) {
        // Immutable envelope bytes + P5.3's own validation make this
        // unreachable absent corruption; it is still refused, never assumed.
        return refuse(
          "invalid-policy-output",
          `candidateId ${proposal.candidateId} is not predeclared`,
        );
      }
      // The quote must match the proposal's candidate and amount EXACTLY —
      // the fields the policy decided on, named in the refusal when they
      // differ. These run BEFORE the route-pair check so a mismatch against
      // the PROPOSAL is a stale-quote naming the field, not a route fact.
      if (quote.tokenIn.toLowerCase() !== candidate.tokenIn.toLowerCase()) {
        return refuse(
          "stale-quote",
          `tokenIn mismatch: quote ${quote.tokenIn}, candidate ${candidate.tokenIn}`,
        );
      }
      if (quote.tokenOut.toLowerCase() !== candidate.tokenOut.toLowerCase()) {
        return refuse(
          "stale-quote",
          `tokenOut mismatch: quote ${quote.tokenOut}, candidate ${candidate.tokenOut}`,
        );
      }
      if (quote.amountInRaw !== proposal.amountInRaw) {
        return refuse(
          "stale-quote",
          `amountInRaw mismatch: quote ${quote.amountInRaw}, proposal ${proposal.amountInRaw}`,
        );
      }
      // And the quote must be a product of the route it names: a record
      // whose pair or chain disagrees with the approved route was not priced
      // by it, and admission cannot treat it as if it were.
      if (
        quote.chainId !== route.chainId ||
        quote.tokenIn.toLowerCase() !== route.tokenIn ||
        quote.tokenOut.toLowerCase() !== route.tokenOut
      ) {
        return refuse(
          "route-unapproved",
          `the quote's pair/chain does not match the approved route ${route.routeId}`,
        );
      }

      // Gate 5 — the budget re-check at preparation: within the per-swap cap
      // AND the remaining total over settled + in-flight. NEVER clamp: an
      // amount outside the caps is a refusal the policy must re-propose.
      const ledgerRows = yield* budgetRowsFor(proposalRow.envelope_id).pipe(
        Effect.mapError(sqlFail("prepareAndAttempt.budget")),
      );
      let settled = 0n;
      let inFlight = 0n;
      let malformed = false;
      for (const row of ledgerRows) {
        const amount = amountInOf(row.proposal_json);
        if (amount === null || !/^(0|[1-9][0-9]*)$/.test(amount)) {
          malformed = true;
          break;
        }
        const value = BigInt(amount);
        if (row.status === "executed") settled += value;
        if (row.status === "executing") inFlight += value;
      }
      const remainingRaw = remainingInputBudget({
        capTotalRaw: envelope.inputCapTotalRaw,
        settledRaw: malformed ? "0" : settled.toString(),
        inFlightRaw: malformed ? "0" : inFlight.toString(),
      });
      if (
        !withinInputBudget({
          proposedRaw: proposal.amountInRaw,
          perSwapCapRaw: envelope.inputCapPerSwapRaw,
          remainingRaw,
        })
      ) {
        return refuse(
          "budget-exhausted",
          `proposed ${proposal.amountInRaw} exceeds the per-swap cap ${envelope.inputCapPerSwapRaw} or the remaining budget ${remainingRaw}; refusing, never clamping`,
        );
      }

      // Build an inspectable draft only. PoolSwapTest has no min-output or
      // deadline parameter, and zero is not a valid v4 pool price bound.
      // These bytes must never be broadcast. The refusal below is unconditional
      // until an authorized execution adapter supplies protected calldata.
      // Gas/nonce are placeholders, not measured execution guarantees.
      const gasCeiling =
        BigInt(QUOTE_GAS_ESTIMATE_WEI_PLACEHOLDER) < BigInt(envelope.maxGasWei)
          ? QUOTE_GAS_ESTIMATE_WEI_PLACEHOLDER
          : envelope.maxGasWei;
      const data: Hex = encodeFunctionData({
        abi: swapRouteAbi,
        functionName: "swap",
        args: [
          {
            currency0: route.poolKey.currency0 as `0x${string}`,
            currency1: route.poolKey.currency1 as `0x${string}`,
            fee: route.poolKey.fee,
            tickSpacing: route.poolKey.tickSpacing,
            hooks: route.poolKey.hooks as `0x${string}`,
          },
          [route.zeroForOne, -BigInt(quote.amountInRaw), 0n],
          [false, false],
          "0x",
        ],
      });
      const valueWei = route.tokenIn === NATIVE_CURRENCY_ADDRESS ? quote.amountInRaw : "0";
      const preparedTxJson = forgeJsonEncode(
        canonical({
          to: route.swapTargetAddress,
          data,
          value: valueWei,
          chainId: SEPOLIA_CHAIN_ID,
          gasWei: gasCeiling,
          nonce: null,
        }),
      );

      // Persist the intent: content id over proposal + quote + prepared
      // bytes. ONE intent per proposal ever — the same content re-prepares
      // idempotently; a changed quote mints a new id, and the unique index
      // turns that into the superseded-quote refusal.
      const record: SwapIntentRecord = {
        intentId: swapIntentId({
          proposalId: proposalRow.proposal_id,
          quoteId: quote.quoteId,
          preparedTxJson,
        }),
        environmentId,
        envelopeId: proposalRow.envelope_id,
        proposalId: proposalRow.proposal_id,
        quoteId: quote.quoteId,
        routeId: route.routeId,
        tokenIn: candidate.tokenIn,
        tokenOut: candidate.tokenOut,
        amountInRaw: proposal.amountInRaw,
        minAmountOutRaw: quote.minAmountOutRaw,
        recipient: candidate.recipient,
        swapTargetAddress: route.swapTargetAddress,
        preparedTxJson,
        status: "prepared",
        preparedAtMs: now,
      };

      const persisted = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const existing = yield* sql<Pick<IntentRow, "intent_id" | "status">>`
              SELECT intent_id, status FROM execution_swap_intents
              WHERE proposal_id = ${proposalRow.proposal_id}
            `;
            const found = existing[0];
            if (found !== undefined) {
              if (found.intent_id === record.intentId) {
                // Idempotent replay: the identical content already prepared.
                // The stored row stands AS-IS — including a crash-window
                // `prepared` row that never reached its attempt; re-attempt
                // is the authorized-live-pass concern, not this slice's.
                return { outcome: "replay" as const };
              }
              return { outcome: "superseded" as const };
            }
            yield* sql`
              INSERT INTO execution_swap_intents (
                intent_id, environment_id, envelope_id, proposal_id, quote_id, route_id,
                token_in, token_out, amount_in_raw, min_amount_out_raw, recipient, swap_target,
                prepared_tx_json, status, prepared_at_ms, attempt_at_ms, refusal_reason
              ) VALUES (
                ${record.intentId}, ${environmentId}, ${record.envelopeId},
                ${record.proposalId}, ${record.quoteId}, ${record.routeId},
                ${record.tokenIn}, ${record.tokenOut}, ${record.amountInRaw},
                ${record.minAmountOutRaw}, ${record.recipient}, ${record.swapTargetAddress},
                ${record.preparedTxJson}, 'prepared', ${now}, NULL, NULL
              )
            `;
            const verify = yield* sql<Pick<IntentRow, "status">>`
              SELECT status FROM execution_swap_intents WHERE intent_id = ${record.intentId}
            `;
            if (verify[0]?.status !== "prepared") {
              return yield* new PersistenceSqlError({
                operation: "SwapExecutionService.prepareAndAttempt",
                detail:
                  "intent insert verification failed; the transaction rolled back and nothing was prepared",
              });
            }
            return { outcome: "inserted" as const };
          }),
        )
        .pipe(
          Effect.mapError(sqlFail("prepareAndAttempt.persist")),
          Effect.catch((error: PersistenceSqlError) => {
            // The storage-predicate backstop: a concurrent second intent for
            // the same proposal surfaced as the unique index, not the re-read.
            const text = describeSqlError(error);
            if (
              text.includes("idx_execution_swap_intents_proposal") ||
              /UNIQUE constraint failed[^\n]*execution_swap_intents/.test(text)
            ) {
              return Effect.succeed({ outcome: "superseded" as const });
            }
            return Effect.fail(error);
          }),
        );
      if (persisted.outcome === "replay") {
        const stored = yield* intentFor(proposalId).pipe(
          Effect.mapError(sqlFail("prepareAndAttempt.replay")),
        );
        return stored === null
          ? refuse("execution-unavailable", "the replayed intent no longer reads back")
          : { status: "already-prepared" as const, intent: stored };
      }
      if (persisted.outcome === "superseded") {
        return refuse(
          "superseded-quote",
          `proposal ${proposalId} already has an intent prepared against a different quote; repricing is a NEW proposal, never a mutation of a retained intent`,
        );
      }

      // PoolSwapTest cannot enforce the quote's minimum output or deadline.
      // Retain the draft for inspection, but do not pass these unprotected
      // bytes to any broadcaster, including one added for the F0 fee hook.
      // A future execution path needs separately authorized signing, protected
      // calldata, and atomic budget reservation before submitting anything.
      const refusal: SwapExecutionRefusalName = "broadcaster-missing";
      const detail =
        "swap submission is disabled: no authorized broadcaster with on-chain minimum-output and deadline enforcement is wired; nothing was submitted";
      const nextStatus = "submit-refused";
      const refusalReason = `${refusal}: ${detail}`;
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`
              UPDATE execution_swap_intents
              SET status = ${nextStatus}, attempt_at_ms = ${now}, refusal_reason = ${refusalReason}
              WHERE intent_id = ${record.intentId} AND status = 'prepared'
            `;
            const verify = yield* sql<Pick<IntentRow, "status">>`
              SELECT status FROM execution_swap_intents WHERE intent_id = ${record.intentId}
            `;
            if (verify[0]?.status !== nextStatus) {
              return yield* new PersistenceSqlError({
                operation: "SwapExecutionService.prepareAndAttempt",
                detail:
                  "attempt recording verification failed; the transaction rolled back and the intent stays prepared",
              });
            }
          }),
        )
        .pipe(Effect.mapError(sqlFail("prepareAndAttempt.attempt")));

      const attempted: SwapIntentRecord = {
        ...record,
        status: "submit-refused",
        attemptAtMs: now,
        refusalReason,
      };
      return { status: "submit-refused" as const, intent: attempted, refusal, detail };
    });

  return {
    prepareAndAttempt,
    intentFor,
    listIntents,
    envelopeById,
    remainingInputBudgetFor,
  } satisfies SwapExecutionServiceShape;
});

/** Uses the shared route registry, capability store, and ambient SQL client. */
export const SwapExecutionServiceLive = Layer.effect(
  SwapExecutionService,
  makeSwapExecutionService,
);
