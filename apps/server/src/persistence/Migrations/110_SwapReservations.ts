import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Swap reservations (110) — the atomic admission ledger for protected swap
 * execution. `execution_swap_reservations` is the durable claim a protected
 * admission transaction writes: the occurrence/stage slot it consumed, the
 * transaction slot it occupies against the envelope's maxTransactions, the
 * exact input reserved, and the worst-case fee wei held back.
 *
 * Rules the shape itself enforces:
 *
 * - ONE reservation per (envelope, stage): the partial unique index is the
 *   storage predicate a racing writer cannot dodge — the replay guard for
 *   "same persistent signal / duplicate block / restart cannot create a
 *   second spend".
 * - Reservation status is one-way:
 *   `reserved → settled-success | settled-revert | released`, with
 *   `released` the named pre-sign release path (a refused or withdrawn
 *   admission gives the input back before anything was signed).
 * - Caps (`maxTransactions`, `maxConcurrentIntents`) are NOT schema — they
 *   are envelope fields the admission transaction re-reads and enforces by
 *   counting committed rows (storage admission, not schema alone).
 * - The reservation's amounts are exact decimal strings, one denomination
 *   per envelope (enforced at the envelope contract); fees are wei.
 *
 * Registered by the coordinator in Migrations.ts; this file only defines it.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS execution_swap_reservations (
      reservation_id    TEXT PRIMARY KEY,
      environment_id    TEXT NOT NULL,
      envelope_id       TEXT NOT NULL,
      proposal_id       TEXT NOT NULL,
      intent_id         TEXT NOT NULL,
      stage_key         TEXT NOT NULL,
      chain_id          TEXT NOT NULL,
      input_asset       TEXT NOT NULL,
      amount_in_raw     TEXT NOT NULL,
      fees_reserved_wei TEXT NOT NULL,
      status            TEXT NOT NULL CHECK (
        status IN ('reserved','settled-success','settled-revert','released')
      ),
      created_at_ms     INTEGER NOT NULL,
      settled_at_ms     INTEGER,
      released_at_ms    INTEGER,
      release_reason    TEXT
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_swap_reservations_stage
      ON execution_swap_reservations (envelope_id, stage_key)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_execution_swap_reservations_envelope_status
      ON execution_swap_reservations (envelope_id, status)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_execution_swap_reservations_intent
      ON execution_swap_reservations (intent_id)
  `;
});
