/**
 * ExecutionPolicyService — the generated execution policy's host: the durable
 * envelope store and the evaluator that turns an approved envelope plus an
 * armed capability's latest committed detector evaluation into ONE validated,
 * persisted ExecutionProposal (or a named refusal).
 *
 * The division of labor is the pool-proposal rule ("policy proposes / host
 * admits"): the generated policy program is CODE IN THE CAPABILITY BUNDLE
 * (the `execution-policy` artifact at policy.ts) and runs contained in the
 * sandbox; this service seals the input, validates the output against the
 * envelope, and admits nothing to execution — a proposal here is a decision,
 * never an order. Swap-intent flow and signing are P5.4 and later.
 *
 * Envelope approval has its OWN authenticated origin, deliberately separate
 * from the F0 spend-grant machinery: `proposeEnvelope` is the tool-side path
 * (an envelope lands as `proposed`, nothing more), while `approveEnvelope` is
 * a direct user-service method the tool layer will refuse to call (P5.4 wires
 * that refusal). The env-derived F0 origin "server-config" is rejected here
 * by name — see the check in `approveEnvelope`.
 *
 * SQL only: the exchange, any signer, and any network are unreachable from
 * this module. Every clock arrives as an explicit `now` on the input (the
 * sealed-input discipline — `asOfMs` is the only time the policy program ever
 * sees), so the service carries no Clock dependency.
 *
 * @module ExecutionPolicyService
 */
// @effect-diagnostics nodeBuiltinImport:off - node:crypto is the host's own identity computation (the CapabilitySandbox precedent).
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { Schema } from "effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  CapabilityManifestV2,
  decodeDetectorState,
  DetectorStateEnvelope,
  detectorArtifactPaths,
  encodeDetectorState,
  ExecutionEnvelope,
  ExecutionEnvelopeStatus,
  PolicyProgramInputV2,
  PolicyProgramOutputV2,
  proposalId,
  remainingInputBudget,
  withinInputBudget,
  type DetectorEvaluationRecordV2,
  ExecutionProposal,
  type ExecutionRefusal,
  type PersistedProposalRecord,
  type PersistedProposalSummary,
} from "@t3tools/trading-contracts";
import { toPersistenceSqlError, PersistenceSqlError } from "../../persistence/Errors.ts";
import { forgeJsonEncode } from "./ForgeJsonEncode.ts";
import {
  forgeSha256Hex,
  FORGE_RUNNER_EVALUATE_POLICY,
  ForgeCapabilitySandbox,
  ForgeSandboxError,
  type ForgeCapabilitySandboxShape,
  type ForgeSandboxFile,
} from "./CapabilitySandbox.ts";
import {
  ForgeCapabilityStore,
  versionProgramKind,
  type ForgeCapabilityStoreShape,
} from "./CapabilityStore.ts";
import { DetectorRunStore } from "./DetectorRunStore.ts";

/** The most proposal rows one listing read will return. */
const MAX_LISTED_PROPOSALS = 100;

/** The prior-proposals window the sealed input carries (the contracts cap). */
const PRIOR_PROPOSALS_WINDOW = 20;

/**
 * The F0 env-derived grant origin (makeForgeGrantGuard's
 * GRANT_APPROVED_VIA_SERVER_CONFIG precedent in ForgeIntentLedgerSqlite.ts).
 * Reusing it for envelope approval would let an environment variable approve
 * execution authority; it is refused by name below and must never appear in
 * `execution_envelope_approvals.approved_via`.
 */
const FORBIDDEN_APPROVAL_ORIGIN = "server-config";

// ---------------------------------------------------------------------------
// Envelope identity — content-derived by this service
// ---------------------------------------------------------------------------

/**
 * Key-sorted, undefined-dropping canonical JSON (the `detectorProgram.ts`
 * normalization, restated host-side): an envelope's stored bytes are a
 * function of their content, not of which caller built the object, so the
 * byte-compare on re-propose is meaningful.
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

/**
 * The envelope's content identity: `env_` plus the first 24 hex characters of
 * the SHA-256 over the fixed-shape identity array (environment, revision, the
 * canonical envelope bytes). Same bytes re-propose idempotently; any changed
 * content is a different envelope.
 */
const envelopeIdFor = (environmentId: string, revision: number, canonicalJson: string): string =>
  `env_${forgeSha256Hex(
    forgeJsonEncode(["trading_execution.envelope.v1", environmentId, revision, canonicalJson]),
  ).slice(0, 24)}`;

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

export type EnvelopeProposeOutcome =
  | { readonly status: "proposed"; readonly envelopeId: string }
  | { readonly status: "already-proposed"; readonly envelopeId: string }
  | {
      readonly status: "refused";
      readonly reason: "invalid-envelope" | "envelope-id-collision";
      readonly detail: string;
    };

export type EnvelopeTransitionOutcome =
  | { readonly status: "approved" | "revoked"; readonly envelopeId: string }
  | {
      readonly status: "refused";
      readonly reason:
        | "not-found"
        | "invalid-envelope"
        | "not-proposed"
        | "not-approved"
        | "expired"
        | "forbidden-origin";
      readonly detail: string;
    };

/**
 * The refusal names `evaluatePolicy` can emit. Everything that exists in the
 * frozen {@link ExecutionRefusal} vocabulary uses its literal; the extensions
 * are execution-side integrity failures that vocabulary does not name:
 *
 * - `execution-unavailable` — the contained policy run itself could not run.
 * - `state-revision-conflict` — the policy-state CAS lost; nothing written.
 * - `invalid-policy-output` — the generated program's output failed host
 *   validation (unknown candidate, wrong evaluation binding, malformed state).
 * - `invalid-policy-state` — the stored policy state row does not decode.
 */
export type PolicyEvaluationRefusalName =
  | ExecutionRefusal
  | "execution-unavailable"
  | "state-revision-conflict"
  | "invalid-policy-output"
  | "invalid-policy-state";

export type PolicyEvaluationOutcome =
  | {
      readonly status: "proposed";
      readonly proposalId: string;
      readonly proposal: ExecutionProposal;
    }
  | { readonly status: "already-proposed"; readonly proposalId: string }
  | { readonly status: "no-proposal"; readonly reason: string }
  | {
      readonly status: "refused";
      readonly refusal: PolicyEvaluationRefusalName;
      readonly detail: string;
    };

/** One envelope row as the reads serve it. */
export interface ExecutionEnvelopeView {
  readonly envelopeId: string;
  readonly environmentId: string;
  readonly capabilityId: string | null;
  readonly revision: number;
  readonly status: ExecutionEnvelopeStatus;
  /** The decoded grant, or null when the stored bytes do not decode. */
  readonly envelope: ExecutionEnvelope | null;
  readonly proposedAtMs: number;
  readonly approvedAtMs: number | null;
  readonly approvedVia: string | null;
  readonly revokedAtMs: number | null;
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export interface ExecutionPolicyServiceShape {
  /**
   * Land an envelope as `proposed` — the tool-side path. Validates the grant,
   * derives its content id, and INSERTs; it NEVER approves. Idempotent on
   * identical bytes; the same id with different bytes is a collision that
   * fails loudly (the ForgeSourceStore discipline).
   */
  readonly proposeEnvelope: (input: {
    readonly environmentId: string;
    readonly envelope: ExecutionEnvelope;
    readonly now: number;
    readonly proposedVia: string;
    /** The capability this envelope binds (at most one, at proposal time). */
    readonly capabilityId: string;
  }) => Effect.Effect<EnvelopeProposeOutcome, PersistenceSqlError>;

  /**
   * The DIRECT user-service approval path: one-way `proposed → approved`,
   * recorded with its own authenticated origin row. The tool layer will
   * refuse to call this (the pool-proposal `agent_cannot_approve` gate; P5.4
   * wires the same refusal for envelopes) — approval is a human act.
   */
  readonly approveEnvelope: (input: {
    readonly envelopeId: string;
    readonly now: number;
    readonly approvedVia: string;
    readonly approverNote?: string | undefined;
  }) => Effect.Effect<EnvelopeTransitionOutcome, PersistenceSqlError>;

  /** One-way `approved → revoked`. Revocation invalidates the envelope. */
  readonly revokeEnvelope: (input: {
    readonly envelopeId: string;
    readonly now: number;
  }) => Effect.Effect<EnvelopeTransitionOutcome, PersistenceSqlError>;

  /**
   * Run the generated execution policy for a capability: gates (envelope
   * approval/expiry/revocation, bundle pinning, committed detector evidence,
   * budget), then the contained `propose` run, then host-side validation, then
   * ONE transaction persisting the proposal and advancing the policy state.
   */
  readonly evaluatePolicy: (input: {
    readonly environmentId: string;
    readonly capabilityId: string;
    readonly now: number;
  }) => Effect.Effect<PolicyEvaluationOutcome, PersistenceSqlError>;

  /** The latest envelope row for a capability (any status), or null. */
  readonly envelopeFor: (input: {
    readonly environmentId: string;
    readonly capabilityId: string;
  }) => Effect.Effect<ExecutionEnvelopeView | null, PersistenceSqlError>;

  /** Proposals under an envelope, newest first, at most `limit` (≤100). */
  readonly listProposals: (input: {
    readonly envelopeId: string;
    readonly limit?: number | undefined;
  }) => Effect.Effect<ReadonlyArray<PersistedProposalRecord>, PersistenceSqlError>;
}

export class ExecutionPolicyService extends Context.Service<
  ExecutionPolicyService,
  ExecutionPolicyServiceShape
>()("t3/trading/forge/ExecutionPolicyService") {}

const sqlFail = (operation: string) => toPersistenceSqlError(`ExecutionPolicyService.${operation}`);

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

/** The policy-program output decoder — module-level, outside generators. */
const decodePolicyProgramOutput = (value: unknown): unknown =>
  Schema.decodeUnknownSync(PolicyProgramOutputV2)(value);

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
  readonly envelope_revision: number;
  readonly detector_evaluation_id: string;
  readonly stage_key: string | null;
  readonly proposal_json: string;
  readonly status: string;
  readonly proposed_at_ms: number;
}

const toEnvelopeView = (row: EnvelopeRow): ExecutionEnvelopeView => ({
  envelopeId: row.envelope_id,
  environmentId: row.environment_id,
  capabilityId: row.capability_id,
  revision: row.revision,
  status: (Schema.is(ExecutionEnvelopeStatus)(row.status)
    ? row.status
    : "draft") as ExecutionEnvelopeStatus,
  envelope: decodeEnvelopeBytes(row.envelope_json),
  proposedAtMs: row.proposed_at_ms,
  approvedAtMs: row.approved_at_ms,
  approvedVia: row.approved_via,
  revokedAtMs: row.revoked_at_ms,
});

/**
 * The recorded-availability rule for using committed detector evidence at
 * `now` — the execution-side enforcement point of `researchEvidence.ts`'s
 * `eligibleAt` discipline (the named-but-unbuilt P5 seam). A committed
 * evaluation record carries its sealed `asOfMs` and evidence ids, not per-ref
 * availability fields, so the conservative local mirror is: the evaluation's
 * own recorded as-of must not be in the future. Only recorded (committed)
 * evidence exists in the store by construction — estimates never land there.
 */
const evidenceEligible = (evaluation: DetectorEvaluationRecordV2, now: number): boolean =>
  evaluation.asOfMs <= now;

/** The exact-decimal amount of a stored swap proposal, or null when malformed. */
const amountInOf = (proposalJson: string): string | null => {
  const proposal = decodeProposalJson(proposalJson);
  return proposal !== null && proposal.kind === "swap" ? proposal.amountInRaw : null;
};

/** Whether two proposals are byte-equal business content (both schema-decoded,
 *  so key order cannot differ). */
const proposalBytesEqual = (storedJson: string, proposal: ExecutionProposal): boolean => {
  const stored = decodeProposalJson(storedJson);
  return stored !== null && forgeJsonEncode(stored) === forgeJsonEncode(proposal);
};

/** Stringify an error for the SQL-failure classifier; total. Routes through
 *  the sanctioned encode helper (the diagnostics budget discipline). */
const describeSqlError = (error: unknown): string => {
  try {
    return forgeJsonEncode(error);
  } catch {
    return String(error);
  }
};

export const makeExecutionPolicyService = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store: ForgeCapabilityStoreShape = yield* ForgeCapabilityStore;
  const sandbox: ForgeCapabilitySandboxShape = yield* ForgeCapabilitySandbox;
  const detectorRuns = yield* DetectorRunStore;

  const proposeEnvelope: ExecutionPolicyServiceShape["proposeEnvelope"] = ({
    environmentId,
    envelope,
    now,
    capabilityId,
  }) =>
    Effect.gen(function* () {
      // Boundary validation before any write: the schema's own filters
      // (candidate uniqueness, distinct tokens, count and cap bounds).
      if (!Schema.is(ExecutionEnvelope)(envelope)) {
        return {
          status: "refused" as const,
          reason: "invalid-envelope" as const,
          detail: "the envelope does not satisfy the ExecutionEnvelope contract",
        };
      }
      if (envelope.environmentId !== environmentId) {
        return {
          status: "refused" as const,
          reason: "invalid-envelope" as const,
          detail: `the envelope names environment ${envelope.environmentId}, the proposal is for ${environmentId}`,
        };
      }
      // IMMUTABLE BYTES: the canonical serialization is what is stored and
      // what every later byte-compare runs against.
      const canonicalJson = forgeJsonEncode(canonical(envelope));
      const envelopeId = envelopeIdFor(environmentId, envelope.revision, canonicalJson);

      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const existing = yield* sql<Pick<EnvelopeRow, "envelope_json">>`
              SELECT envelope_json FROM execution_envelopes WHERE envelope_id = ${envelopeId}
            `;
            if (existing[0] !== undefined) {
              if (existing[0].envelope_json === canonicalJson) {
                return { status: "already-proposed" as const, envelopeId };
              }
              // A content-derived id can never change meaning.
              return {
                status: "refused" as const,
                reason: "envelope-id-collision" as const,
                detail: "envelope id collision: the stored envelope bytes differ",
              };
            }
            yield* sql`
              INSERT INTO execution_envelopes (
                envelope_id, environment_id, capability_id, revision, account_id,
                status, envelope_json, proposed_at_ms
              ) VALUES (
                ${envelopeId}, ${environmentId}, ${capabilityId}, ${envelope.revision},
                ${envelope.accountId}, 'proposed', ${canonicalJson}, ${now}
              )
            `;
            // DOES NOT APPROVE: the row lands as `proposed`; approval is a
            // separate authenticated act (approveEnvelope).
            return { status: "proposed" as const, envelopeId };
          }),
        )
        .pipe(Effect.mapError(sqlFail("proposeEnvelope")));
    });

  const approveEnvelope: ExecutionPolicyServiceShape["approveEnvelope"] = ({
    envelopeId,
    now,
    approvedVia,
    approverNote,
  }) =>
    Effect.gen(function* () {
      // APPROVAL ORIGIN (the grant-guard precedent): "server-config" is the
      // F0 env-derived spend-grant origin and must NEVER approve an execution
      // envelope — env vars are not an authenticated user act. Generalized
      // execution keeps its own origin vocabulary.
      if (approvedVia === FORBIDDEN_APPROVAL_ORIGIN) {
        return {
          status: "refused" as const,
          reason: "forbidden-origin" as const,
          detail:
            'approvedVia "server-config" is the F0 env-derived grant origin and can never approve an execution envelope',
        };
      }
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const existing = yield* sql<Pick<EnvelopeRow, "status" | "envelope_json">>`
              SELECT status, envelope_json FROM execution_envelopes WHERE envelope_id = ${envelopeId}
            `;
            const row = existing[0];
            if (row === undefined) {
              return {
                status: "refused" as const,
                reason: "not-found" as const,
                detail: `no envelope ${envelopeId}`,
              };
            }
            const envelope = decodeEnvelopeBytes(row.envelope_json);
            if (envelope === null) {
              return {
                status: "refused" as const,
                reason: "invalid-envelope" as const,
                detail: "the stored envelope bytes do not decode; approval refuses",
              };
            }
            // One-way transition: only a `proposed` envelope can be approved.
            if (row.status !== "proposed") {
              return {
                status: "refused" as const,
                reason: "not-proposed" as const,
                detail: `envelope status is ${row.status}, only a proposed envelope can be approved`,
              };
            }
            if (now >= envelope.expiresAtMs) {
              return {
                status: "refused" as const,
                reason: "expired" as const,
                detail: `the envelope expired at ${envelope.expiresAtMs}`,
              };
            }
            yield* sql`
              UPDATE execution_envelopes
              SET status = 'approved', approved_at_ms = ${now}, approved_via = ${approvedVia}
              WHERE envelope_id = ${envelopeId} AND status = 'proposed'
            `;
            // INSERT-only approval audit row.
            yield* sql`
              INSERT INTO execution_envelope_approvals (
                envelope_id, approved_via, approved_at_ms, approver_note
              ) VALUES (${envelopeId}, ${approvedVia}, ${now}, ${approverNote ?? null})
            `;
            const verify = yield* sql<Pick<EnvelopeRow, "status">>`
              SELECT status FROM execution_envelopes WHERE envelope_id = ${envelopeId}
            `;
            if (verify[0]?.status !== "approved") {
              return yield* new PersistenceSqlError({
                operation: "ExecutionPolicyService.approveEnvelope",
                detail:
                  "approval verification failed after update; the transaction rolled back and nothing was approved",
              });
            }
            return { status: "approved" as const, envelopeId };
          }),
        )
        .pipe(Effect.mapError(sqlFail("approveEnvelope")));
    });

  const revokeEnvelope: ExecutionPolicyServiceShape["revokeEnvelope"] = ({ envelopeId, now }) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const existing = yield* sql<Pick<EnvelopeRow, "status">>`
            SELECT status FROM execution_envelopes WHERE envelope_id = ${envelopeId}
          `;
          const row = existing[0];
          if (row === undefined) {
            return {
              status: "refused" as const,
              reason: "not-found" as const,
              detail: `no envelope ${envelopeId}`,
            };
          }
          // One-way transition: only an `approved` envelope can be revoked.
          if (row.status !== "approved") {
            return {
              status: "refused" as const,
              reason: "not-approved" as const,
              detail: `envelope status is ${row.status}, only an approved envelope can be revoked`,
            };
          }
          yield* sql`
            UPDATE execution_envelopes
            SET status = 'revoked', revoked_at_ms = ${now}
            WHERE envelope_id = ${envelopeId} AND status = 'approved'
          `;
          const verify = yield* sql<Pick<EnvelopeRow, "status">>`
            SELECT status FROM execution_envelopes WHERE envelope_id = ${envelopeId}
          `;
          if (verify[0]?.status !== "revoked") {
            return yield* new PersistenceSqlError({
              operation: "ExecutionPolicyService.revokeEnvelope",
              detail:
                "revocation verification failed after update; the transaction rolled back and nothing was revoked",
            });
          }
          return { status: "revoked" as const, envelopeId };
        }),
      )
      .pipe(Effect.mapError(sqlFail("revokeEnvelope")));

  const evaluatePolicy: ExecutionPolicyServiceShape["evaluatePolicy"] = ({
    environmentId,
    capabilityId,
    now,
  }) =>
    Effect.gen(function* () {
      const refuse = (refusal: PolicyEvaluationRefusalName, detail: string) => ({
        status: "refused" as const,
        refusal,
        detail,
      });

      // Gate 1 — the capability must be actively installed (paused pauses
      // proposing exactly as it pauses detector evaluation).
      const active = yield* store
        .activeState({ environmentId, capabilityId })
        .pipe(Effect.mapError(sqlFail("evaluatePolicy.activeState")));
      if (active === null || active.status === "uninstalled") {
        return refuse("unconfigured", `${capabilityId} is not installed; nothing to propose for`);
      }
      if (active.status === "paused") {
        return refuse("paused", `${capabilityId} is paused; proposing refuses until resumed`);
      }

      // Gate 2 — the LATEST envelope for this capability, overall. Revoking
      // the newest grant never silently falls back to an older approved one:
      // the latest row's status decides.
      const envelopeRows = yield* sql<EnvelopeRow>`
        SELECT envelope_id, environment_id, capability_id, revision, status, envelope_json,
               proposed_at_ms, approved_at_ms, approved_via, revoked_at_ms
        FROM execution_envelopes
        WHERE environment_id = ${environmentId} AND capability_id = ${capabilityId}
        ORDER BY proposed_at_ms DESC, rowid DESC
        LIMIT 1
      `;
      const envelopeRow = envelopeRows[0];
      if (envelopeRow === undefined) {
        return refuse("envelope-not-approved", `no envelope has been proposed for ${capabilityId}`);
      }
      if (envelopeRow.status === "revoked") {
        return refuse("envelope-revoked", `envelope ${envelopeRow.envelope_id} is revoked`);
      }
      const envelope = decodeEnvelopeBytes(envelopeRow.envelope_json);
      if (envelope === null) {
        return refuse(
          "envelope-not-approved",
          `envelope ${envelopeRow.envelope_id} does not decode; approval cannot be trusted`,
        );
      }
      if (now >= envelope.expiresAtMs) {
        return refuse("envelope-expired", `the envelope expired at ${envelope.expiresAtMs}`);
      }
      if (envelopeRow.status !== "approved") {
        return refuse(
          "envelope-not-approved",
          `envelope status is ${envelopeRow.status}; only an approved envelope proposes`,
        );
      }

      // Gate 3 — the installed bundle must be exactly the two programs the
      // envelope pinned, by content hash. Any drift is a changed bundle: the
      // user re-approves a new revision, never a silent re-bind.
      const manifestJson = yield* store
        .readArtifact({
          environmentId,
          capabilityId,
          version: active.version,
          path: "manifest.json",
        })
        .pipe(Effect.mapError(sqlFail("evaluatePolicy.readArtifact")));
      if (manifestJson === null) {
        return refuse(
          "bundle-changed",
          `manifest.json of v${active.version} is missing from the store`,
        );
      }
      if (versionProgramKind(manifestJson) !== "v2") {
        return refuse(
          "bundle-changed",
          `the installed v${active.version} bundle is not a detector-program v2 bundle`,
        );
      }
      const manifest = decodeManifestV2(manifestJson);
      if (manifest === null) {
        return refuse("bundle-changed", "the installed v2 manifest does not decode");
      }
      const paths = detectorArtifactPaths(manifest);
      if ("refusal" in paths) {
        return refuse("bundle-changed", `the installed v2 manifest is invalid: ${paths.refusal}`);
      }
      if (!paths.paths.includes("policy.ts") || !paths.paths.includes("detector.ts")) {
        return refuse(
          "bundle-changed",
          "the installed bundle declares no execution-policy artifact at policy.ts",
        );
      }
      // The sandbox receives the bundle files exactly as the reactor stages
      // them: every declared role path plus manifest.json, hash-verified reads.
      const files: Array<ForgeSandboxFile> = [];
      for (const path of [...paths.paths, "manifest.json"]) {
        const content = yield* store
          .readArtifact({ environmentId, capabilityId, version: active.version, path })
          .pipe(Effect.mapError(sqlFail("evaluatePolicy.readArtifact")));
        if (content === null) {
          return refuse(
            "bundle-changed",
            `artifact ${path} of v${active.version} is missing from the store`,
          );
        }
        files.push({ path, content });
      }
      const detectorBytes = files.find((file) => file.path === "detector.ts")?.content ?? "";
      const policyBytes = files.find((file) => file.path === "policy.ts")?.content ?? "";
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

      // Gate 4 — committed detector evidence. Only a MATCHED evaluation ever
      // reaches the policy; the other outcomes are valid non-actions.
      const evaluation = yield* detectorRuns
        .latestEvaluation(environmentId, capabilityId)
        .pipe(Effect.mapError(sqlFail("evaluatePolicy.latestEvaluation")));
      if (evaluation === null) {
        return refuse(
          "stale-evidence",
          "no committed detector evaluation exists for this capability",
        );
      }
      if (evaluation.result.status !== "matched") {
        const why =
          evaluation.result.status === "not-matched" || evaluation.result.status === "unknown"
            ? evaluation.result.explanation
            : "";
        return {
          status: "no-proposal" as const,
          reason: `detector result ${evaluation.result.status}: ${why}`,
        };
      }
      if (evaluation.version !== active.version) {
        return refuse(
          "bundle-changed",
          `the committed evaluation is from v${evaluation.version}, the installed bundle is v${active.version}`,
        );
      }
      if (!evidenceEligible(evaluation, now)) {
        return refuse(
          "stale-evidence",
          `the committed evaluation's recorded as-of ${evaluation.asOfMs} is after now ${now}`,
        );
      }

      // Gate 5 — the POLICY's own state lineage (never the detector's row).
      const stateRows = yield* sql<{
        readonly state_json: string;
        readonly state_revision: number;
      }>`
        SELECT state_json, state_revision FROM execution_policy_state
        WHERE environment_id = ${environmentId} AND capability_id = ${capabilityId}
      `;
      let priorState: unknown = undefined;
      let observedRevision: number | null = null;
      if (stateRows[0] !== undefined) {
        const decoded = decodeDetectorState(stateRows[0].state_json);
        if (!decoded.ok) {
          return refuse(
            "invalid-policy-state",
            `the committed policy state does not decode (${decoded.failure})`,
          );
        }
        priorState = decoded.envelope;
        observedRevision = stateRows[0].state_revision;
      }

      // Gate 6 — the explicit remaining budget: settled (executed) and
      // in-flight (executing) swap proposals deducted, fail closed. A ledger
      // row that does not decode, or whose amount is not an exact decimal
      // integer, makes the budget CORRUPT, not zero: folding malformed rows
      // to zero would show the FULL cap as spendable, so the evaluation
      // refuses by name instead of proposing against an unreadable ledger.
      // The verdict is order-independent — one malformed row anywhere in the
      // ledger (before or after valid rows) refuses the whole fold.
      const budgetRows = yield* sql<{ readonly status: string; readonly proposal_json: string }>`
        SELECT status, proposal_json FROM execution_proposals
        WHERE envelope_id = ${envelopeRow.envelope_id} AND stage_key IS NOT NULL
      `;
      let settledRaw = "0";
      let inFlightRaw = "0";
      {
        let settled = 0n;
        let inFlight = 0n;
        let corrupt: string | null = null;
        for (const row of budgetRows) {
          const amount = amountInOf(row.proposal_json);
          if (amount === null || !/^(0|[1-9][0-9]*)$/.test(amount)) {
            // Do not echo the corrupt bytes into the refusal detail; naming
            // the status is enough to locate the row.
            corrupt = `a proposal in status ${row.status} does not decode to a swap with an exact decimal amount`;
            break;
          }
          const value = BigInt(amount);
          if (row.status === "executed") settled += value;
          if (row.status === "executing") inFlight += value;
        }
        if (corrupt !== null) {
          return refuse(
            "corrupt-budget-ledger",
            `the spend ledger under ${envelopeRow.envelope_id} is corrupt: ${corrupt}; refusing rather than reporting a fresh budget`,
          );
        }
        settledRaw = settled.toString();
        inFlightRaw = inFlight.toString();
      }
      const remainingInputCapRaw = remainingInputBudget({
        capTotalRaw: envelope.inputCapTotalRaw,
        settledRaw,
        inFlightRaw,
      });

      // The prior-proposals window: stage-bearing proposals only, newest-last.
      const priorRows = yield* sql<{
        readonly stage_key: string;
        readonly proposal_json: string;
        readonly proposed_at_ms: number;
      }>`
        SELECT stage_key, proposal_json, proposed_at_ms FROM execution_proposals
        WHERE envelope_id = ${envelopeRow.envelope_id} AND stage_key IS NOT NULL
        ORDER BY proposed_at_ms DESC, rowid DESC
        LIMIT ${PRIOR_PROPOSALS_WINDOW}
      `;
      const priorProposals: Array<PersistedProposalSummary> = [];
      for (const row of [...priorRows].reverse()) {
        const proposal = decodeProposalJson(row.proposal_json);
        if (proposal === null || proposal.kind !== "swap") continue;
        priorProposals.push({
          stageKey: row.stage_key,
          kind: "swap",
          amountInRaw: proposal.amountInRaw,
          occurredAtMs: row.proposed_at_ms,
        });
      }

      // The sealed input. `now` is the ONLY clock the program ever sees.
      const programInput = {
        policySchemaVersion: 2 as const,
        asOfMs: now,
        envelope,
        detectorEvaluation: {
          evaluationId: evaluation.evaluationId,
          asOfMs: evaluation.asOfMs,
          result: {
            status: "matched" as const,
            occurrenceKey: evaluation.result.occurrenceKey,
            validUntilMs: evaluation.result.validUntilMs,
          },
        },
        priorProposals,
        remainingInputCapRaw,
        ...(priorState === undefined ? {} : { priorState }),
      };
      // The frozen input schema is the boundary contract: an input that fails
      // it never crosses into containment.
      if (!Schema.is(PolicyProgramInputV2)(programInput)) {
        return refuse("invalid-policy-output", "the sealed policy input failed its own contract");
      }

      // The contained run.
      const run = yield* Effect.exit(
        sandbox.runEvaluation({
          files,
          entrypoint: [...FORGE_RUNNER_EVALUATE_POLICY],
          stdinJson: forgeJsonEncode(programInput),
          decodeResult: decodePolicyProgramOutput,
        }),
      );
      if (run._tag === "Failure") {
        const squashed = Cause.squash(run.cause);
        return refuse(
          "execution-unavailable",
          squashed instanceof ForgeSandboxError
            ? squashed.failure.reason
            : String(squashed).slice(0, 300),
        );
      }
      const output = run.value as PolicyProgramOutputV2;

      // Host-side output validation — everything re-checked, nothing trusted.
      if (!Schema.is(DetectorStateEnvelope)(output.nextState)) {
        return refuse("invalid-policy-output", "the policy's next state is not a state envelope");
      }
      const encodedState = encodeDetectorState(output.nextState);
      if (!encodedState.ok) {
        return refuse(
          "invalid-policy-output",
          `the policy's next state failed the envelope contract (${encodedState.failure})`,
        );
      }
      const proposal = output.proposal;
      if (proposal.kind === "swap") {
        const candidate = envelope.candidates.find(
          (entry) => entry.candidateId === proposal.candidateId,
        );
        if (candidate === undefined) {
          return refuse(
            "invalid-policy-output",
            `candidateId ${proposal.candidateId} is not predeclared in the envelope`,
          );
        }
        // NEVER clamp: an amount outside the caps is the policy's refusal to
        // re-propose, not a smaller swap it never made.
        if (
          !withinInputBudget({
            proposedRaw: proposal.amountInRaw,
            perSwapCapRaw: envelope.inputCapPerSwapRaw,
            remainingRaw: remainingInputCapRaw,
          })
        ) {
          return refuse(
            "budget-exhausted",
            `proposed ${proposal.amountInRaw} exceeds the per-swap cap ${envelope.inputCapPerSwapRaw} or the remaining budget ${remainingInputCapRaw}; refusing, never clamping`,
          );
        }
        if (proposal.detectorEvaluationId !== evaluation.evaluationId) {
          return refuse(
            "invalid-policy-output",
            "the swap proposal names a detector evaluation other than the one just read",
          );
        }
        if (proposal.occurrenceKey !== evaluation.result.occurrenceKey) {
          return refuse(
            "invalid-policy-output",
            "the swap proposal's occurrence key does not echo the committed evaluation",
          );
        }
      }
      // Hash re-check immediately before persist (the bytes are in hand).
      if (
        forgeSha256Hex(detectorBytes) !== envelope.detectorBundleSha256 ||
        forgeSha256Hex(policyBytes) !== envelope.policyBundleSha256
      ) {
        return refuse("bundle-changed", "the envelope hash re-check failed before persist");
      }

      // Persist: ONE transaction — proposal INSERT plus policy state CAS.
      const newProposalId = proposalId({
        envelopeRevision: envelope.revision,
        capabilityId,
        detectorEvaluationId: evaluation.evaluationId,
        stageKey: proposal.kind === "swap" ? proposal.stageKey : null,
        proposedAtMs: now,
      });
      const proposalJson = forgeJsonEncode(proposal);

      const persist = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            // Stage re-read under the transaction: the deterministic dedup
            // and conflict path; the partial unique index below remains the
            // storage backstop a racing writer cannot dodge.
            if (proposal.kind === "swap") {
              const existing = yield* sql<
                Pick<ProposalRow, "proposal_id" | "detector_evaluation_id" | "proposal_json">
              >`
                SELECT proposal_id, detector_evaluation_id, proposal_json
                FROM execution_proposals
                WHERE envelope_id = ${envelopeRow.envelope_id} AND stage_key = ${proposal.stageKey}
              `;
              const found = existing[0];
              if (found !== undefined) {
                if (
                  found.detector_evaluation_id === evaluation.evaluationId &&
                  proposalBytesEqual(found.proposal_json, proposal)
                ) {
                  // Same evaluation, same stage, same bytes: the replay
                  // collapses onto the existing proposal. Nothing written.
                  return { status: "already-proposed" as const, proposalId: found.proposal_id };
                }
                return {
                  status: "refused" as const,
                  refusal: "stage-already-executed" as const,
                  detail: `stage ${proposal.stageKey} already has a proposal under this envelope`,
                };
              }
            }
            // Policy state CAS: the row must still be exactly what this
            // evaluation observed before the program ran.
            const current = yield* sql<{ readonly state_revision: number }>`
              SELECT state_revision FROM execution_policy_state
              WHERE environment_id = ${environmentId} AND capability_id = ${capabilityId}
            `;
            const currentRow = current[0];
            if (observedRevision === null) {
              if (currentRow !== undefined) {
                return {
                  status: "refused" as const,
                  refusal: "state-revision-conflict" as const,
                  detail: `expected no prior policy state but found revision ${currentRow.state_revision}`,
                };
              }
            } else if (currentRow === undefined || currentRow.state_revision !== observedRevision) {
              return {
                status: "refused" as const,
                refusal: "state-revision-conflict" as const,
                detail: `expected policy state revision ${observedRevision} but found ${currentRow === undefined ? "none" : currentRow.state_revision}`,
              };
            }
            // Writes: proposal first, then the conditioned state advance, then
            // the read-back verify — a failed verify FAILS the effect so the
            // whole transaction rolls back rather than committing a proposal
            // whose state did not advance.
            yield* sql`
              INSERT INTO execution_proposals (
                proposal_id, environment_id, capability_id, envelope_id, envelope_revision,
                detector_evaluation_id, stage_key, proposal_json, status, proposed_at_ms
              ) VALUES (
                ${newProposalId}, ${environmentId}, ${capabilityId}, ${envelopeRow.envelope_id},
                ${envelope.revision}, ${evaluation.evaluationId},
                ${proposal.kind === "swap" ? proposal.stageKey : null},
                ${proposalJson}, 'proposed', ${now}
              )
            `;
            if (observedRevision === null) {
              yield* sql`
                INSERT INTO execution_policy_state (
                  environment_id, capability_id, state_json, state_revision, updated_at_ms
                ) VALUES (
                  ${environmentId}, ${capabilityId}, ${encodedState.serialized}, 0, ${now}
                )
              `;
            } else {
              yield* sql`
                UPDATE execution_policy_state SET
                  state_json = ${encodedState.serialized},
                  state_revision = ${observedRevision + 1},
                  updated_at_ms = ${now}
                WHERE environment_id = ${environmentId}
                  AND capability_id = ${capabilityId}
                  AND state_revision = ${observedRevision}
              `;
            }
            const wantRevision = observedRevision === null ? 0 : observedRevision + 1;
            const verify = yield* sql<{
              readonly state_revision: number;
              readonly state_json: string;
            }>`
              SELECT state_revision, state_json FROM execution_policy_state
              WHERE environment_id = ${environmentId} AND capability_id = ${capabilityId}
            `;
            if (
              verify[0]?.state_revision !== wantRevision ||
              verify[0]?.state_json !== encodedState.serialized
            ) {
              return yield* new PersistenceSqlError({
                operation: "ExecutionPolicyService.evaluatePolicy",
                detail:
                  "policy state advance verification failed after upsert; the transaction rolled back and nothing was committed",
              });
            }
            return { status: "proposed" as const, proposalId: newProposalId };
          }),
        )
        .pipe(
          Effect.mapError(sqlFail("evaluatePolicy.persist")),
          Effect.catch((error: PersistenceSqlError) => {
            // The storage-predicate backstop: a concurrent duplicate stage
            // surfaced as a unique-index violation, not the re-read.
            const text = describeSqlError(error);
            if (
              text.includes("idx_execution_proposals_envelope_stage") ||
              /UNIQUE constraint failed[^\n]*execution_proposals/.test(text)
            ) {
              return Effect.succeed({
                status: "refused" as const,
                refusal: "stage-already-executed" as const,
                detail: "the stage uniqueness index refused a concurrent duplicate",
              });
            }
            return Effect.fail(error);
          }),
        );

      if (persist.status === "refused" || persist.status === "already-proposed") return persist;
      return { status: "proposed" as const, proposalId: persist.proposalId, proposal };
    }).pipe(Effect.mapError(sqlFail("evaluatePolicy")));

  const envelopeFor: ExecutionPolicyServiceShape["envelopeFor"] = ({
    environmentId,
    capabilityId,
  }) =>
    sql<EnvelopeRow>`
      SELECT envelope_id, environment_id, capability_id, revision, status, envelope_json,
             proposed_at_ms, approved_at_ms, approved_via, revoked_at_ms
      FROM execution_envelopes
      WHERE environment_id = ${environmentId} AND capability_id = ${capabilityId}
      ORDER BY proposed_at_ms DESC, rowid DESC
      LIMIT 1
    `.pipe(
      Effect.mapError(sqlFail("envelopeFor")),
      Effect.map((rows) => (rows[0] === undefined ? null : toEnvelopeView(rows[0]))),
    );

  const listProposals: ExecutionPolicyServiceShape["listProposals"] = ({ envelopeId, limit }) =>
    sql<ProposalRow>`
      SELECT proposal_id, environment_id, capability_id, envelope_id, envelope_revision,
             detector_evaluation_id, stage_key, proposal_json, status, proposed_at_ms
      FROM execution_proposals
      WHERE envelope_id = ${envelopeId}
      ORDER BY proposed_at_ms DESC, rowid DESC
      LIMIT ${Math.min(Math.max(limit ?? 50, 1), MAX_LISTED_PROPOSALS)}
    `.pipe(
      Effect.mapError(sqlFail("listProposals")),
      // Undecodable rows are skipped, never thrown (the listing discipline).
      Effect.map((rows) =>
        rows.flatMap((row) => {
          const proposal = decodeProposalJson(row.proposal_json);
          return proposal === null
            ? []
            : [
                {
                  proposalId: row.proposal_id,
                  envelopeRevision: row.envelope_revision,
                  environmentId: row.environment_id,
                  capabilityId: row.capability_id,
                  detectorEvaluationId: row.detector_evaluation_id,
                  proposal,
                  proposedAtMs: row.proposed_at_ms,
                  status: row.status as PersistedProposalRecord["status"],
                },
              ];
        }),
      ),
    );

  return {
    proposeEnvelope,
    approveEnvelope,
    revokeEnvelope,
    evaluatePolicy,
    envelopeFor,
    listProposals,
  } satisfies ExecutionPolicyServiceShape;
});

export const ExecutionPolicyServiceLive = Layer.effect(
  ExecutionPolicyService,
  makeExecutionPolicyService,
);
