import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * The execution-envelope boundary (P5.3) — the durable store under the
 * generated execution policy evaluator.
 *
 * Four tables, all beside the detector-run tables (migration 105) and never
 * mixed with them:
 *
 * - `execution_envelopes` — the immutable user-approved grants. `envelope_id`
 *   is content-derived by the SERVICE (environment + revision + canonical
 *   envelope JSON, sha256, `env_` prefix); `envelope_json` stores those exact
 *   canonical bytes IMMUTABLY — the only writes after INSERT are the one-way
 *   status transitions proposed → approved → revoked (and the derived
 *   `expired` label), enforced by the service, never a rewrite of the grant
 *   itself. `capability_id` binds an envelope to at most one capability at
 *   proposal time; the envelope's detector+policy artifact hashes pin the
 *   bundle bytes, so a changed bundle is a "bundle-changed" refusal, never a
 *   silent re-bind.
 * - `execution_envelope_approvals` — INSERT-only. `approved_via` is an
 *   AUTHENTICATED ORIGIN LITERAL. The F0 spend-grant origin "server-config"
 *   (see makeForgeGrantGuard's GRANT_APPROVED_VIA_SERVER_CONFIG precedent in
 *   ForgeIntentLedgerSqlite.ts) is FORBIDDEN here by the service: envelope
 *   approval must come through its own authenticated user path, never the
 *   env-derived grant origin.
 * - `execution_proposals` — one row per persisted policy proposal.
 *   `proposal_id` is content-derived; `stage_key` is the swap proposal's stage
 *   and NULL for every non-swap kind, so occurrence/stage uniqueness is a
 *   STORAGE predicate — the partial unique index refuses a second proposal
 *   for the same (envelope, stage) no matter which writer races. Status
 *   transitions are one-way (proposed → executing → executed, with rejected /
 *   superseded as the honest exits); rows are never deleted.
 * - `execution_policy_state` — the POLICY program's own carried state, one
 *   row per (environment, capability), advanced by compare-and-set on
 *   `state_revision` (the DetectorRunStore discipline). A SEPARATE lineage
 *   from `forge_detector_state`: the same envelope wrapper and byte cap, but
 *   the rows never mix — the detector's state and the policy's state advance
 *   independently.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS execution_envelopes (
      envelope_id    TEXT PRIMARY KEY,
      environment_id TEXT NOT NULL,
      capability_id  TEXT,
      revision       INTEGER NOT NULL,
      account_id     TEXT NOT NULL,
      status         TEXT NOT NULL CHECK (status IN ('draft','proposed','approved','revoked','expired')),
      envelope_json  TEXT NOT NULL,
      proposed_at_ms INTEGER NOT NULL,
      approved_at_ms INTEGER,
      approved_via   TEXT,
      revoked_at_ms  INTEGER
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_execution_envelopes_capability_latest
      ON execution_envelopes (environment_id, capability_id, proposed_at_ms DESC)
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS execution_envelope_approvals (
      envelope_id    TEXT PRIMARY KEY,
      approved_via   TEXT NOT NULL,
      approved_at_ms INTEGER NOT NULL,
      approver_note  TEXT
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS execution_proposals (
      proposal_id            TEXT PRIMARY KEY,
      environment_id         TEXT NOT NULL,
      capability_id          TEXT NOT NULL,
      envelope_id            TEXT NOT NULL,
      envelope_revision      INTEGER NOT NULL,
      detector_evaluation_id TEXT NOT NULL,
      stage_key              TEXT,
      proposal_json          TEXT NOT NULL,
      status                 TEXT NOT NULL CHECK (status IN ('proposed','rejected','executing','executed','superseded')),
      proposed_at_ms         INTEGER NOT NULL
    )
  `;
  // The stage uniqueness predicate: one proposal per (envelope, stage) where a
  // stage exists. Partial (WHERE stage_key IS NOT NULL) so non-swap proposals
  // never occupy a stage slot (04:113 — storage predicates, not writer hopes).
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_proposals_envelope_stage
      ON execution_proposals (envelope_id, stage_key) WHERE stage_key IS NOT NULL
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_execution_proposals_envelope_time
      ON execution_proposals (envelope_id, proposed_at_ms DESC)
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS execution_policy_state (
      environment_id TEXT NOT NULL,
      capability_id  TEXT NOT NULL,
      state_json     TEXT NOT NULL,
      state_revision INTEGER NOT NULL DEFAULT 0,
      updated_at_ms  INTEGER NOT NULL,
      PRIMARY KEY (environment_id, capability_id)
    )
  `;
});
