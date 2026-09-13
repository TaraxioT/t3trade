/**
 * SwapReservationStore — the protected execution lane's atomic admission and
 * reservation ledger.
 *
 * ONE SQLite transaction performs the whole admission (03: "Atomic admission
 * and transaction lifecycle"): recheck the envelope's status/version/
 * revocation/expiry, re-read the proposal, claim the unique occurrence+stage
 * slot, claim a transaction slot against the envelope's maxTransactions and
 * maxConcurrentIntents by COUNTING COMMITTED RESERVATIONS (caps enforced in
 * storage admission, not schema alone), fold the spend ledger (a corrupt row
 * refuses by name), reserve the exact input plus worst-case fees, and insert
 * the immutable unsigned intent and its attempt row. Either everything
 * commits or nothing does; the partial unique index on (envelope_id,
 * stage_key) is the storage predicate a racing writer cannot dodge.
 *
 * The intent this store writes is PROTECTED mainnet calldata: the plan is
 * built host-side from the envelope candidate, the CURRENT route registry
 * entry, and the quote's identity fields; the calldata is encoded through
 * MainnetProtectedRouter and decoded back and compared field-by-field
 * BEFORE the row is written — an encoder bug or a tampered field is a
 * refusal, never persisted bytes. The quote must carry the complete v3
 * execution identity (route-config digest equal to the CURRENT registry
 * digest, pinned block, quoted output, code hashes, measured fees); a quote
 * lacking any of it never admits.
 *
 * SQL + pure codecs only: no RPC, no signer, no broadcast. The broadcast
 * lifecycle (SwapBroadcastLifecycle) owns what happens after admission.
 *
 * @module SwapReservationStore
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  ExecutionEnvelope,
  ExecutionProposal,
  remainingInputBudget,
  SwapIntentRecord,
  swapIntentId,
  swapQuoteId,
  withinInputBudget,
  type ExecutionRefusal,
  type SwapQuoteRecord,
} from "@t3tools/trading-contracts";
import { keccak256, toBytes } from "viem";
import { toPersistenceSqlError, PersistenceSqlError } from "../../persistence/Errors.ts";
import { forgeJsonEncode } from "./ForgeJsonEncode.ts";
import { forgeSha256Hex } from "./CapabilitySandbox.ts";
import {
  ForgeCapabilityStore,
  versionProgramKind,
  type ForgeCapabilityStoreShape,
} from "./CapabilityStore.ts";
import {
  encodeProtectedExactInput,
  minimumOutFromQuote,
  protectedCalldataDigest,
  verifyProtectedCalldata,
  type ProtectedSwapPlan,
} from "./MainnetProtectedRouter.ts";
import { SwapRouteConfig, routeFor, swapRouteConfigDigest } from "./UniswapQuoteService.ts";
import { CapabilityManifestV2, detectorArtifactPaths } from "@t3tools/trading-contracts";
import { SpotMainnetTransport, verifySpotMainnetTarget } from "./SpotMainnetTarget.ts";

/**
 * The refusal names protected admission can emit. The frozen
 * {@link ExecutionRefusal} vocabulary covers the shared grounds; the
 * extensions name admission-specific facts:
 *
 * - `transaction-cap-exceeded` — maxTransactions already consumed.
 * - `concurrency-cap-exceeded` — maxConcurrentIntents already in flight.
 * - `quote-identity-missing` — the quote predates the v3 identity contract
 *   (no digest/block/fees) or disagrees with the CURRENT route config.
 * - `calldata-verification-failed` — the decode-back comparison failed.
 * - `gas-cap-exceeded` — measured worst-case fees exceed the envelope's
 *   maxGasWei (refused, never clamped).
 * - `deadline-out-of-range` — the requested deadline is outside the
 *   admission bounds.
 * - `admission-unavailable` — required retained state is unavailable.
 */
export type ProtectedAdmissionRefusalName =
  | ExecutionRefusal
  | "transaction-cap-exceeded"
  | "concurrency-cap-exceeded"
  | "quote-identity-missing"
  | "quote-identity-mismatch"
  | "stage-released"
  | "target-verification-failed"
  | "mainnet-transport-unavailable"
  | "calldata-verification-failed"
  | "gas-cap-exceeded"
  | "deadline-out-of-range"
  | "admission-unavailable";

export type ProtectedAdmissionOutcome =
  | {
      readonly status: "refused";
      readonly refusal: ProtectedAdmissionRefusalName;
      readonly detail: string;
    }
  | {
      /** Idempotent replay: the same stage already holds a reservation. */
      readonly status: "already-admitted";
      readonly reservationId: string;
      readonly intentId: string;
    }
  | {
      readonly status: "admitted";
      readonly reservationId: string;
      readonly intent: SwapIntentRecord;
      readonly plan: ProtectedSwapPlan;
      readonly feesReservedWei: string;
    };

/** The signed view of one reservation row. */
export interface SwapReservationView {
  readonly reservationId: string;
  readonly environmentId: string;
  readonly envelopeId: string;
  readonly proposalId: string;
  readonly intentId: string;
  readonly stageKey: string;
  readonly chainId: string;
  readonly inputAsset: string;
  readonly amountInRaw: string;
  readonly feesReservedWei: string;
  readonly status: "reserved" | "settled-success" | "settled-revert" | "released";
  readonly createdAtMs: number;
  readonly settledAtMs: number | null;
  readonly releasedAtMs: number | null;
  readonly releaseReason: string | null;
}

/** Deadline bounds: at least 60s of runway, at most one hour. */
const DEADLINE_MIN_AHEAD_SECONDS = 60;
const DEADLINE_MAX_AHEAD_SECONDS = 3_600;

export interface SwapReservationStoreShape {
  /**
   * Atomically admit one protected exact-input swap: all rechecks, claims,
   * reservations, and the immutable unsigned intent in ONE transaction.
   */
  readonly admitProtectedSwap: (input: {
    readonly environmentId: string;
    readonly proposalId: string;
    readonly quote: SwapQuoteRecord;
    /** execute(deadline) value, unix seconds. */
    readonly deadlineUnix: number;
    readonly now: number;
  }) => Effect.Effect<ProtectedAdmissionOutcome, PersistenceSqlError>;

  /** The reservation for an intent, or null. */
  readonly reservationForIntent: (
    intentId: string,
  ) => Effect.Effect<SwapReservationView | null, PersistenceSqlError>;

  /**
   * The named pre-sign release: a reserved admission that will not be signed
   * gives the input back and frees the stage slot's budget hold. One-way.
   */
  readonly releaseReservation: (input: {
    readonly reservationId: string;
    readonly reason: string;
    readonly now: number;
  }) => Effect.Effect<
    { readonly status: "released" | "already-released" | "not-found" | "not-releasable" },
    PersistenceSqlError
  >;
}

export class SwapReservationStore extends Context.Service<
  SwapReservationStore,
  SwapReservationStoreShape
>()("t3/trading/forge/SwapReservationStore") {}

const sqlFail = (operation: string) => toPersistenceSqlError(`SwapReservationStore.${operation}`);

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

interface EnvelopeRow {
  readonly envelope_id: string;
  readonly environment_id: string;
  readonly capability_id: string | null;
  readonly revision: number;
  readonly status: string;
  readonly envelope_json: string;
}

interface ProposalRow {
  readonly proposal_id: string;
  readonly environment_id: string;
  readonly capability_id: string;
  readonly envelope_id: string;
  readonly envelope_revision: number;
  readonly stage_key: string | null;
  readonly proposal_json: string;
  readonly status: string;
}

/** Key-sorted, undefined-dropping canonical JSON (the stored-bytes rule). */
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

/** Stringify an error for the unique-index classifier; total. */
const describeSqlError = (error: unknown): string => {
  try {
    return forgeJsonEncode(error);
  } catch {
    return String(error);
  }
};

const EXACT_DECIMAL = /^(0|[1-9][0-9]*)$/;

export const makeSwapReservationStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store: ForgeCapabilityStoreShape = yield* ForgeCapabilityStore;
  const routeConfig = yield* SwapRouteConfig;
  // The funded lane's RPC seam, OPTIONAL at composition (fail-closed at
  // admission): runtimes that have not wired a mainnet transport cannot
  // verify code identity and refuse protected admissions outright.
  const mainnetTransportOption = yield* Effect.serviceOption(SpotMainnetTransport);

  const reservationForIntent: SwapReservationStoreShape["reservationForIntent"] = (intentId) =>
    sql<{
      readonly reservation_id: string;
      readonly environment_id: string;
      readonly envelope_id: string;
      readonly proposal_id: string;
      readonly intent_id: string;
      readonly stage_key: string;
      readonly chain_id: string;
      readonly input_asset: string;
      readonly amount_in_raw: string;
      readonly fees_reserved_wei: string;
      readonly status: string;
      readonly created_at_ms: number;
      readonly settled_at_ms: number | null;
      readonly released_at_ms: number | null;
      readonly release_reason: string | null;
    }>`
      SELECT reservation_id, environment_id, envelope_id, proposal_id, intent_id, stage_key,
             chain_id, input_asset, amount_in_raw, fees_reserved_wei, status, created_at_ms,
             settled_at_ms, released_at_ms, release_reason
      FROM execution_swap_reservations WHERE intent_id = ${intentId}
    `.pipe(
      Effect.mapError(sqlFail("reservationForIntent")),
      Effect.map((rows) => {
        const row = rows[0];
        return row === undefined
          ? null
          : {
              reservationId: row.reservation_id,
              environmentId: row.environment_id,
              envelopeId: row.envelope_id,
              proposalId: row.proposal_id,
              intentId: row.intent_id,
              stageKey: row.stage_key,
              chainId: row.chain_id,
              inputAsset: row.input_asset,
              amountInRaw: row.amount_in_raw,
              feesReservedWei: row.fees_reserved_wei,
              status: row.status as SwapReservationView["status"],
              createdAtMs: row.created_at_ms,
              settledAtMs: row.settled_at_ms,
              releasedAtMs: row.released_at_ms,
              releaseReason: row.release_reason,
            };
      }),
    );

  const releaseReservation: SwapReservationStoreShape["releaseReservation"] = ({
    reservationId,
    reason,
    now,
  }) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{ readonly status: string; readonly proposal_id: string }>`
            SELECT status, proposal_id FROM execution_swap_reservations WHERE reservation_id = ${reservationId}
          `;
          const row = rows[0];
          if (row === undefined) return { status: "not-found" as const };
          if (row.status === "released") return { status: "already-released" as const };
          if (row.status !== "reserved") return { status: "not-releasable" as const };
          yield* sql`
            UPDATE execution_swap_reservations
            SET status = 'released', released_at_ms = ${now}, release_reason = ${reason}
            WHERE reservation_id = ${reservationId} AND status = 'reserved'
          `;
          // The release is the pre-sign exit for the WHOLE admission: the
          // attempt records released-before-sign (the documented state), and
          // the proposal lands in a terminal no-spend state so the budget
          // folds stop counting it in flight — all in this transaction.
          yield* sql`
            UPDATE execution_swap_attempts
            SET status = 'released-before-sign', refusal_reason = ${`released: ${reason}`}
            WHERE reservation_id = ${reservationId} AND status = 'reserved'
          `;
          yield* sql`
            UPDATE execution_proposals SET status = 'rejected'
            WHERE proposal_id = ${row.proposal_id} AND status = 'executing'
          `;
          const verify = yield* sql<{ readonly status: string }>`
            SELECT status FROM execution_swap_reservations WHERE reservation_id = ${reservationId}
          `;
          if (verify[0]?.status !== "released") {
            return yield* new PersistenceSqlError({
              operation: "SwapReservationStore.releaseReservation",
              detail:
                "release verification failed; the transaction rolled back and the reservation stands",
            });
          }
          return { status: "released" as const };
        }),
      )
      .pipe(Effect.mapError(sqlFail("releaseReservation")));

  const admitProtectedSwap: SwapReservationStoreShape["admitProtectedSwap"] = ({
    environmentId,
    proposalId,
    quote,
    deadlineUnix,
    now,
  }) =>
    Effect.gen(function* () {
      const refuse = (refusal: ProtectedAdmissionRefusalName, detail: string) => ({
        status: "refused" as const,
        refusal,
        detail,
      });

      // -- Pre-admission validation over retained state (reads only) -------

      const proposalRows = yield* sql<ProposalRow>`
        SELECT proposal_id, environment_id, capability_id, envelope_id, envelope_revision,
               stage_key, proposal_json, status
        FROM execution_proposals WHERE proposal_id = ${proposalId}
      `.pipe(Effect.mapError(sqlFail("admitProtectedSwap.proposal")));
      const proposalRow = proposalRows[0];
      if (proposalRow === undefined || proposalRow.environment_id !== environmentId) {
        return refuse(
          "admission-unavailable",
          `no swap proposal ${proposalId} in this environment`,
        );
      }
      const proposal = decodeProposalJson(proposalRow.proposal_json);
      if (proposal === null || proposal.kind !== "swap") {
        return refuse(
          "admission-unavailable",
          `proposal ${proposalId} is not a decodable swap proposal`,
        );
      }
      if (proposalRow.stage_key === null) {
        return refuse(
          "stage-already-executed",
          "the proposal carries no stage; only a staged swap admits",
        );
      }
      if (proposalRow.status === "executing" || proposalRow.status === "rejected") {
        // An executing or released-then-rejected stage may only be the
        // idempotent replay of an admission that already claimed it — the
        // reservation must exist and say which.
        const existingRows = yield* sql<{
          readonly reservation_id: string;
          readonly intent_id: string;
          readonly status: string;
        }>`
          SELECT reservation_id, intent_id, status FROM execution_swap_reservations
          WHERE envelope_id = ${proposalRow.envelope_id} AND stage_key = ${proposalRow.stage_key}
        `.pipe(Effect.mapError(sqlFail("admitProtectedSwap.replay")));
        const existing = existingRows[0];
        if (existing !== undefined) {
          if (existing.status === "released") {
            // A released stage is consumed, not idempotently re-admitted;
            // the refusal names the release and its reservation.
            return refuse(
              "stage-released",
              `the stage's reservation ${existing.reservation_id} was released before signing; the stage is consumed and must never re-admit`,
            );
          }
          if (proposalRow.status === "executing") {
            return {
              status: "already-admitted" as const,
              reservationId: existing.reservation_id,
              intentId: existing.intent_id,
            };
          }
        }
        return refuse(
          "stage-already-executed",
          `proposal status is ${proposalRow.status}${existing === undefined ? " with no reservation" : ""}; the stage is consumed`,
        );
      }
      if (proposalRow.status !== "proposed") {
        return refuse(
          "stage-already-executed",
          `proposal status is ${proposalRow.status}; only a proposed swap with a stage admits`,
        );
      }

      const envelopeRows = yield* sql<EnvelopeRow>`
        SELECT envelope_id, environment_id, capability_id, revision, status, envelope_json
        FROM execution_envelopes WHERE envelope_id = ${proposalRow.envelope_id}
      `.pipe(Effect.mapError(sqlFail("admitProtectedSwap.envelope")));
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
          `envelope status is ${envelopeRow.status}; only an approved envelope admits`,
        );
      }
      if (envelopeRow.revision !== proposalRow.envelope_revision) {
        return refuse(
          "envelope-not-approved",
          `the proposal binds envelope revision ${proposalRow.envelope_revision}, the stored revision is ${envelopeRow.revision}`,
        );
      }

      const candidate = envelope.candidates.find(
        (entry) => entry.candidateId === proposal.candidateId,
      );
      if (candidate === undefined) {
        return refuse(
          "admission-unavailable",
          `candidateId ${proposal.candidateId} is not predeclared`,
        );
      }

      // Bundle pins: the installed bundle must still hash to the envelope's
      // pins at admission (a changed bundle is re-approved, never honored).
      const active = yield* store
        .activeState({ environmentId, capabilityId: proposalRow.capability_id })
        .pipe(Effect.mapError(sqlFail("admitProtectedSwap.activeState")));
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
        .pipe(Effect.mapError(sqlFail("admitProtectedSwap.readArtifact")));
      if (manifestJson === null || versionProgramKind(manifestJson) !== "v2") {
        return refuse("bundle-changed", `manifest.json of v${active.version} is missing or not v2`);
      }
      const manifest = decodeManifestV2(manifestJson);
      if (manifest === null) {
        return refuse("bundle-changed", "the installed v2 manifest does not decode");
      }
      const paths = detectorArtifactPaths(manifest);
      if (
        "refusal" in paths ||
        !paths.paths.includes("policy.ts") ||
        !paths.paths.includes("detector.ts")
      ) {
        return refuse(
          "bundle-changed",
          "the installed bundle does not declare the pinned artifacts",
        );
      }
      const detectorBytes = yield* store
        .readArtifact({
          environmentId,
          capabilityId: proposalRow.capability_id,
          version: active.version,
          path: "detector.ts",
        })
        .pipe(Effect.mapError(sqlFail("admitProtectedSwap.readArtifact")));
      const policyBytes = yield* store
        .readArtifact({
          environmentId,
          capabilityId: proposalRow.capability_id,
          version: active.version,
          path: "policy.ts",
        })
        .pipe(Effect.mapError(sqlFail("admitProtectedSwap.readArtifact")));
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

      // -- The route + quote identity ---------------------------------------

      const settings = yield* routeConfig.resolve.pipe(
        Effect.mapError(sqlFail("admitProtectedSwap.routes")),
      );
      const route = routeFor(settings, quote.routeId);
      if (route === null) {
        return refuse(
          "route-unapproved",
          `route ${quote.routeId} is not in the approved route registry`,
        );
      }
      if (route.routeType !== "ur-v3-exact-input") {
        return refuse(
          "route-unapproved",
          `route ${quote.routeId} is ${route.routeType}; protected admission requires a ur-v3 route`,
        );
      }
      if (quote.chainId !== route.chainId || quote.chainId !== candidate.chainId) {
        return refuse(
          "stale-quote",
          `chain binding: quote ${quote.chainId}, route ${route.chainId}, candidate ${candidate.chainId} are not one chain`,
        );
      }
      if (
        quote.tokenIn.toLowerCase() !== candidate.tokenIn.toLowerCase() ||
        quote.tokenOut.toLowerCase() !== candidate.tokenOut.toLowerCase()
      ) {
        return refuse(
          "stale-quote",
          "the quote's pair does not match the envelope candidate exactly",
        );
      }
      if (quote.amountInRaw !== proposal.amountInRaw) {
        return refuse(
          "stale-quote",
          `amountInRaw mismatch: quote ${quote.amountInRaw}, proposal ${proposal.amountInRaw}`,
        );
      }
      if (quote.expiresAtMs <= now) {
        return refuse(
          "stale-quote",
          `quote ${quote.quoteId} expired at ${quote.expiresAtMs}, now ${now}`,
        );
      }
      // The COMPLETE identity contract: every v3 field must be present, and
      // the digest must equal the CURRENT registry's digest for this route —
      // an old config is rejected even though the routeId is unchanged.
      const currentDigest = swapRouteConfigDigest(route);
      if (
        quote.routeConfigDigest === undefined ||
        quote.quotedBlockNumber === undefined ||
        quote.quotedBlockHash === undefined ||
        quote.quotedAmountOutRaw === undefined ||
        quote.quoterCodeHash === undefined ||
        quote.targetCodeHash === undefined ||
        quote.gasUnitsMeasured === undefined ||
        quote.maxFeePerGasWei === undefined ||
        quote.maxPriorityFeePerGasWei === undefined
      ) {
        return refuse(
          "quote-identity-missing",
          "the quote predates the v3 execution-identity contract (digest, block, output, code hashes, or measured fees absent)",
        );
      }
      if (quote.routeConfigDigest !== currentDigest) {
        return refuse(
          "quote-identity-missing",
          `the quote's route-config digest ${quote.routeConfigDigest} does not match the current registry digest ${currentDigest} for route ${route.routeId}; re-quote under the current config`,
        );
      }
      // PROVENANCE: the quote arrives from the caller on the tool path, so
      // its content-derived id is recomputed from its OWN fields — a record
      // whose id does not match its content is tampered or rebound, never a
      // price this host produced.
      const recomputedQuoteId = swapQuoteId({
        chainId: quote.chainId,
        routeId: quote.routeId,
        tokenIn: quote.tokenIn,
        tokenOut: quote.tokenOut,
        amountInRaw: quote.amountInRaw,
        minAmountOutRaw: quote.minAmountOutRaw,
        quotedAtMs: quote.quotedAtMs,
        expiresAtMs: quote.expiresAtMs,
        routeConfigDigest: quote.routeConfigDigest,
        quotedBlockNumber: quote.quotedBlockNumber,
        quotedBlockHash: quote.quotedBlockHash,
        quotedAmountOutRaw: quote.quotedAmountOutRaw,
        quoterCodeHash: quote.quoterCodeHash,
        targetCodeHash: quote.targetCodeHash,
        gasUnitsMeasured: quote.gasUnitsMeasured,
        maxFeePerGasWei: quote.maxFeePerGasWei,
        maxPriorityFeePerGasWei: quote.maxPriorityFeePerGasWei,
      });
      if (recomputedQuoteId !== quote.quoteId) {
        return refuse(
          "quote-identity-mismatch",
          `the quote's id ${quote.quoteId} does not match the id derived from its own content (${recomputedQuoteId}); the record is tampered or rebound`,
        );
      }
      // CODE IDENTITY AT ADMISSION: the quoter and the swap target must still
      // carry the code the quote pinned, and the target must pass its full
      // runtime verification. This needs the mainnet RPC; a funded lane
      // without one refuses closed rather than admit unverified.
      if (Option.isNone(mainnetTransportOption)) {
        return refuse(
          "mainnet-transport-unavailable",
          "the mainnet RPC transport is not wired; admission cannot verify the quoter/target code identity and refuses closed",
        );
      }
      const spotRpc = mainnetTransportOption.value;
      const spotTarget = spotRpc.target();
      if (spotTarget === null) {
        return refuse(
          "mainnet-transport-unavailable",
          "the spot mainnet target is unconfigured; admission cannot verify the target and refuses closed",
        );
      }
      const targetVerification = yield* verifySpotMainnetTarget(spotTarget, spotRpc.request);
      if ("refusals" in targetVerification) {
        return refuse(
          "target-verification-failed",
          `the spot mainnet target failed runtime verification: ${targetVerification.refusals.join("; ")}`,
        );
      }
      const liveCodeHash = (address: string): Effect.Effect<string | null, never> =>
        spotRpc.request("eth_getCode", [address, "latest"]).pipe(
          Effect.map((code): string | null => {
            if (typeof code !== "string" || !code.startsWith("0x") || code.length <= 2) return null;
            try {
              return keccak256(toBytes(code as `0x${string}`)).replace(/^0x/, "");
            } catch {
              return null;
            }
          }),
          Effect.catch(() => Effect.succeed<string | null>(null)),
        );
      const liveQuoterHash = yield* liveCodeHash(route.quoterAddress);
      const liveTargetHash = yield* liveCodeHash(route.swapTargetAddress);
      if (liveQuoterHash === null || liveQuoterHash !== quote.quoterCodeHash) {
        return refuse(
          "quote-identity-mismatch",
          `the quoter's live code hash ${liveQuoterHash ?? "unavailable"} does not match the quote's pin ${quote.quoterCodeHash}; the contract changed or the quote is rebound`,
        );
      }
      if (liveTargetHash === null || liveTargetHash !== quote.targetCodeHash) {
        return refuse(
          "quote-identity-mismatch",
          `the swap target's live code hash ${liveTargetHash ?? "unavailable"} does not match the quote's pin ${quote.targetCodeHash}; the contract changed or the quote is rebound`,
        );
      }

      // Slippage: the quote's floor must be exactly derivable from its own
      // quoted output under a slippage allowance no looser than the
      // envelope's approved cap.
      const floorAtCap = minimumOutFromQuote(quote.quotedAmountOutRaw, envelope.maxSlippageBps);
      if (!floorAtCap.ok) {
        return refuse("stale-quote", floorAtCap.refusal);
      }
      if (BigInt(quote.minAmountOutRaw) < BigInt(floorAtCap.minAmountOutRaw)) {
        return refuse(
          "stale-quote",
          `the quote's minimum output ${quote.minAmountOutRaw} is weaker than the envelope's ${envelope.maxSlippageBps} bps cap floor ${floorAtCap.minAmountOutRaw}`,
        );
      }
      if (BigInt(quote.minAmountOutRaw) > BigInt(quote.quotedAmountOutRaw)) {
        return refuse("stale-quote", "the quote's minimum output exceeds its own quoted output");
      }

      // Deadline bounds: enough runway to sign and broadcast, never absurd.
      const nowSeconds = Math.floor(now / 1000);
      if (
        !Number.isSafeInteger(deadlineUnix) ||
        deadlineUnix < nowSeconds + DEADLINE_MIN_AHEAD_SECONDS ||
        deadlineUnix > nowSeconds + DEADLINE_MAX_AHEAD_SECONDS
      ) {
        return refuse(
          "deadline-out-of-range",
          `deadline ${deadlineUnix} is outside [now+${DEADLINE_MIN_AHEAD_SECONDS}s, now+${DEADLINE_MAX_AHEAD_SECONDS}s]`,
        );
      }

      // Fees: measured worst case, never clamped.
      const worstCaseFeeWei = BigInt(quote.gasUnitsMeasured) * BigInt(quote.maxFeePerGasWei);
      if (worstCaseFeeWei > BigInt(envelope.maxGasWei)) {
        return refuse(
          "gas-cap-exceeded",
          `measured worst-case fees ${worstCaseFeeWei.toString(10)} wei exceed the envelope's maxGasWei ${envelope.maxGasWei}; refusing, never clamping`,
        );
      }

      // -- The protected plan + encode/decode verification -------------------

      const plan: ProtectedSwapPlan = {
        direction: route.tokenIn === `0x${"0".repeat(40)}` ? "native-in" : "erc20-in-native-out",
        chainId: 1,
        router: route.swapTargetAddress,
        weth: route.weth,
        erc20: route.erc20,
        recipient: candidate.recipient,
        amountInRaw: proposal.amountInRaw,
        minAmountOutRaw: quote.minAmountOutRaw,
        deadlineUnix,
        feeTier: route.feeTier,
      };
      const calldata = encodeProtectedExactInput(plan);
      const verification = verifyProtectedCalldata(plan, calldata);
      if (!verification.ok) {
        return refuse(
          "calldata-verification-failed",
          `the completed calldata does not match the approved plan: ${verification.refusals.join("; ")}`,
        );
      }
      const calldataDigest = protectedCalldataDigest(calldata);

      const preparedTxJson = forgeJsonEncode(
        canonical({
          to: calldata.to,
          data: calldata.data,
          value: calldata.value,
          chainId: 1,
          gas_wei: worstCaseFeeWei.toString(10),
          gas_units: quote.gasUnitsMeasured,
          max_fee_per_gas_wei: quote.maxFeePerGasWei,
          max_priority_fee_per_gas_wei: quote.maxPriorityFeePerGasWei,
          deadline_unix: deadlineUnix,
          calldata_digest: calldataDigest,
          nonce: null,
        }),
      );
      const intentId = swapIntentId({
        proposalId: proposalRow.proposal_id,
        quoteId: quote.quoteId,
        preparedTxJson,
      });
      const reservationId = `sres_${forgeSha256Hex(
        forgeJsonEncode([
          "trading_execution.swap_reservation.v1",
          proposalRow.envelope_id,
          proposalRow.stage_key,
        ]),
      ).slice(0, 24)}`;

      // -- THE transaction: every claim, cap, and write together ------------

      const persist = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            // Re-read the envelope INSIDE the transaction: revocation or
            // status change between validation and commit refuses here.
            const recheck = yield* sql<{ readonly status: string; readonly envelope_json: string }>`
              SELECT status, envelope_json FROM execution_envelopes
              WHERE envelope_id = ${proposalRow.envelope_id}
            `;
            const recheckRow = recheck[0];
            if (recheckRow === undefined || recheckRow.status !== "approved") {
              return {
                outcome: "refused" as const,
                refusal: "envelope-not-approved" as ProtectedAdmissionRefusalName,
                detail: `envelope status inside admission is ${recheckRow?.status ?? "missing"}`,
              };
            }
            const recheckEnvelope = decodeEnvelopeBytes(recheckRow.envelope_json);
            if (recheckEnvelope === null || now >= recheckEnvelope.expiresAtMs) {
              return {
                outcome: "refused" as const,
                refusal: "envelope-expired" as ProtectedAdmissionRefusalName,
                detail: "the envelope expired or stopped decoding inside the admission transaction",
              };
            }

            // Existing reservation for this stage: idempotent replay, a
            // released (consumed) stage, or a race.
            const existing = yield* sql<{
              readonly reservation_id: string;
              readonly intent_id: string;
              readonly status: string;
            }>`
              SELECT reservation_id, intent_id, status FROM execution_swap_reservations
              WHERE envelope_id = ${proposalRow.envelope_id} AND stage_key = ${proposalRow.stage_key}
            `;
            if (existing[0] !== undefined) {
              if (existing[0].status === "released") {
                return {
                  outcome: "refused" as const,
                  refusal: "stage-released" as ProtectedAdmissionRefusalName,
                  detail: `the stage's reservation ${existing[0].reservation_id} was released before signing; the stage is consumed and must never re-admit`,
                };
              }
              return { outcome: "already" as const, existing: existing[0] };
            }

            // Caps from COMMITTED rows: every non-released reservation is a
            // transaction slot; every `reserved` one is in flight.
            const counts = yield* sql<{
              readonly total: number;
              readonly inflight: number;
            }>`
              SELECT
                COUNT(*) AS total,
                SUM(CASE WHEN status = 'reserved' THEN 1 ELSE 0 END) AS inflight
              FROM execution_swap_reservations
              WHERE envelope_id = ${proposalRow.envelope_id} AND status != 'released'
            `;
            const total = counts[0]?.total ?? 0;
            const inflight = counts[0]?.inflight ?? 0;
            if (total >= envelope.maxTransactions) {
              return {
                outcome: "refused" as const,
                refusal: "transaction-cap-exceeded" as ProtectedAdmissionRefusalName,
                detail: `the envelope's maxTransactions ${envelope.maxTransactions} is already consumed (${total} admitted)`,
              };
            }
            if (inflight >= envelope.maxConcurrentIntents) {
              return {
                outcome: "refused" as const,
                refusal: "concurrency-cap-exceeded" as ProtectedAdmissionRefusalName,
                detail: `the envelope's maxConcurrentIntents ${envelope.maxConcurrentIntents} is already in flight (${inflight} reserved)`,
              };
            }

            // The budget fold INSIDE the transaction: settled and in-flight
            // spend (this reservation's input joins the in-flight side after
            // the insert below). Corrupt rows refuse by name.
            const ledgerRows = yield* sql<{
              readonly status: string;
              readonly proposal_json: string;
            }>`
              SELECT status, proposal_json FROM execution_proposals
              WHERE envelope_id = ${proposalRow.envelope_id} AND stage_key IS NOT NULL
            `;
            let settled = 0n;
            let inFlight = 0n;
            for (const row of ledgerRows) {
              const decoded = decodeProposalJson(row.proposal_json);
              const amount =
                decoded !== null && decoded.kind === "swap" ? decoded.amountInRaw : null;
              if (amount === null || !EXACT_DECIMAL.test(amount)) {
                return {
                  outcome: "refused" as const,
                  refusal: "corrupt-budget-ledger" as ProtectedAdmissionRefusalName,
                  detail: `a proposal in status ${row.status} does not decode to a swap with an exact decimal amount`,
                };
              }
              const value = BigInt(amount);
              if (row.status === "executed") settled += value;
              if (row.status === "executing") inFlight += value;
            }
            const remainingRaw = remainingInputBudget({
              capTotalRaw: envelope.inputCapTotalRaw,
              settledRaw: settled.toString(),
              inFlightRaw: inFlight.toString(),
            });
            if (
              !withinInputBudget({
                proposedRaw: proposal.amountInRaw,
                perSwapCapRaw: envelope.inputCapPerSwapRaw,
                remainingRaw,
              })
            ) {
              return {
                outcome: "refused" as const,
                refusal: "budget-exhausted" as ProtectedAdmissionRefusalName,
                detail: `proposed ${proposal.amountInRaw} exceeds the per-swap cap ${envelope.inputCapPerSwapRaw} or the remaining budget ${remainingRaw}; refusing, never clamping`,
              };
            }

            // The writes: reservation (the stage claim), the immutable
            // unsigned intent, the attempt row, and the proposal's move to
            // executing — all committed together or not at all.
            yield* sql`
              INSERT INTO execution_swap_reservations (
                reservation_id, environment_id, envelope_id, proposal_id, intent_id, stage_key,
                chain_id, input_asset, amount_in_raw, fees_reserved_wei, status, created_at_ms
              ) VALUES (
                ${reservationId}, ${environmentId}, ${proposalRow.envelope_id},
                ${proposalRow.proposal_id}, ${intentId}, ${proposalRow.stage_key},
                ${route.chainId}, ${candidate.tokenIn.toLowerCase()},
                ${proposal.amountInRaw}, ${worstCaseFeeWei.toString(10)}, 'reserved', ${now}
              )
            `;
            yield* sql`
              INSERT INTO execution_swap_intents (
                intent_id, environment_id, envelope_id, proposal_id, quote_id, route_id,
                token_in, token_out, amount_in_raw, min_amount_out_raw, recipient, swap_target,
                prepared_tx_json, status, prepared_at_ms, attempt_at_ms, refusal_reason
              ) VALUES (
                ${intentId}, ${environmentId}, ${proposalRow.envelope_id},
                ${proposalRow.proposal_id}, ${quote.quoteId}, ${route.routeId},
                ${candidate.tokenIn}, ${candidate.tokenOut}, ${proposal.amountInRaw},
                ${quote.minAmountOutRaw}, ${candidate.recipient}, ${calldata.to},
                ${preparedTxJson}, 'prepared', ${now}, NULL, NULL
              )
            `;
            yield* sql`
              INSERT INTO execution_swap_attempts (
                intent_id, reservation_id, environment_id, envelope_id,
                unsigned_tx_json, calldata_digest, status, reserved_at_ms
              ) VALUES (
                ${intentId}, ${reservationId}, ${environmentId}, ${proposalRow.envelope_id},
                ${preparedTxJson}, ${calldataDigest}, 'reserved', ${now}
              )
            `;
            yield* sql`
              UPDATE execution_proposals SET status = 'executing'
              WHERE proposal_id = ${proposalRow.proposal_id} AND status = 'proposed'
            `;
            const verifyReservation = yield* sql<{ readonly status: string }>`
              SELECT status FROM execution_swap_reservations WHERE reservation_id = ${reservationId}
            `;
            const verifyIntent = yield* sql<{ readonly status: string }>`
              SELECT status FROM execution_swap_intents WHERE intent_id = ${intentId}
            `;
            if (
              verifyReservation[0]?.status !== "reserved" ||
              verifyIntent[0]?.status !== "prepared"
            ) {
              return yield* new PersistenceSqlError({
                operation: "SwapReservationStore.admitProtectedSwap",
                detail:
                  "admission verification failed after writes; the transaction rolled back and nothing was reserved",
              });
            }
            return { outcome: "inserted" as const };
          }),
        )
        .pipe(
          Effect.mapError(sqlFail("admitProtectedSwap.persist")),
          Effect.catch((error: PersistenceSqlError) => {
            const text = describeSqlError(error);
            if (
              text.includes("idx_execution_swap_reservations_stage") ||
              /UNIQUE constraint failed[^\n]*execution_swap_reservations/.test(text) ||
              text.includes("idx_execution_swap_intents_proposal") ||
              /UNIQUE constraint failed[^\n]*execution_swap_intents/.test(text)
            ) {
              return Effect.succeed({
                outcome: "race-lost" as const,
              });
            }
            return Effect.fail(error);
          }),
        );

      if (persist.outcome === "refused") {
        return refuse(persist.refusal, persist.detail);
      }
      if (persist.outcome === "already") {
        return {
          status: "already-admitted" as const,
          reservationId: persist.existing.reservation_id,
          intentId: persist.existing.intent_id,
        };
      }
      if (persist.outcome === "race-lost") {
        return refuse(
          "stage-already-executed",
          "the stage uniqueness index refused a concurrent duplicate admission",
        );
      }

      const intent: SwapIntentRecord = {
        intentId,
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
        swapTargetAddress: calldata.to,
        preparedTxJson,
        status: "prepared",
        preparedAtMs: now,
      };
      return {
        status: "admitted" as const,
        reservationId,
        intent,
        plan,
        feesReservedWei: worstCaseFeeWei.toString(10),
      };
    }).pipe(Effect.mapError(sqlFail("admitProtectedSwap")));

  return {
    admitProtectedSwap,
    reservationForIntent,
    releaseReservation,
  } satisfies SwapReservationStoreShape;
});

export const SwapReservationStoreLive = Layer.effect(
  SwapReservationStore,
  makeSwapReservationStore,
);
