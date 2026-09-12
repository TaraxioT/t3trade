import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * The Forge intent ledger and its durable control state.
 *
 * `forge_intents` is one row per retained unsigned intent: the immutable
 * transaction identity in columns, the mutable outcome (status, tx hash,
 * receipt, refusals) updated as the intent moves through the broadcast state
 * machine, and the durable-admission bookkeeping (claim id, reserved gas,
 * retained prepared transaction) written only by the atomic claim.
 *
 * `forge_control_state` holds scoped durable controls (the persistent local
 * pause). `forge_grant_approvals` is INSERT-only: the first recorded grant for
 * an id is the authority forever, so a later env change can never silently
 * retarget an approved grant — a mismatch is a retarget refusal, not an
 * update.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS forge_intents (
      intent_id                TEXT PRIMARY KEY,
      idempotency_key          TEXT NOT NULL UNIQUE,
      environment_id           TEXT NOT NULL,
      kind                     TEXT NOT NULL,
      created_at_ms            INTEGER NOT NULL,
      unsigned_json            TEXT NOT NULL,
      status                   TEXT NOT NULL,
      tx_hash                  TEXT,
      submitted_at_ms          INTEGER,
      settled_at_block_number  INTEGER,
      gas_cost_wei             TEXT,
      gas_accounted            INTEGER NOT NULL DEFAULT 0,
      receipt_json             TEXT,
      last_refusal_json        TEXT,
      spend_json               TEXT NOT NULL,
      params_json              TEXT NOT NULL,
      summary                  TEXT NOT NULL,
      grant_id                 TEXT,
      claimed_at_ms            INTEGER,
      claim_id                 TEXT,
      gas_reserved_wei         TEXT,
      gas_settled              INTEGER NOT NULL DEFAULT 0,
      prepared_json            TEXT
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_forge_intents_env_time
      ON forge_intents (environment_id, created_at_ms)
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS forge_control_state (
      scope         TEXT PRIMARY KEY,
      paused        INTEGER NOT NULL DEFAULT 0,
      updated_at_ms INTEGER NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS forge_grant_approvals (
      grant_id                 TEXT PRIMARY KEY,
      chain_id                 INTEGER NOT NULL,
      hook_address             TEXT NOT NULL,
      token_caps_json          TEXT NOT NULL,
      per_swap_max_quote_raw   TEXT NOT NULL,
      aggregate_gas_budget_wei TEXT NOT NULL,
      operator_address         TEXT NOT NULL,
      expires_at_unix          INTEGER NOT NULL,
      approved_via             TEXT NOT NULL,
      recorded_at_ms           INTEGER NOT NULL
    )
  `;
});
