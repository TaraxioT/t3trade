import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * The swap-intent store (P5.4) — one row per prepared exact-input swap.
 *
 * `execution_swap_intents` is the durable unit of the local execution path:
 * the proposal that authorized the swap, the quote it priced against, and
 * the exact unsigned transaction bytes that would be signed. Rules the shape
 * itself enforces:
 *
 * - ONE intent per proposal, ever. The unique index over `proposal_id` makes
 *   re-preparation of the same proposal against a CHANGED quote (a new
 *   content id, hence a new `intent_id`) a constraint violation the service
 *   maps to the `superseded-quote` refusal — repricing means a NEW proposal,
 *   never a mutation of a retained intent.
 * - The status CHECK enumerates the whole one-way state machine
 *   (prepared → submit-refused | submitted → confirmed | reverted | unknown)
 *   from day one, even though only the first two are reachable while no
 *   signer is authorized. `prepared_tx_json` is the canonical prepared
 *   transaction bytes and is IMMUTABLE after insert; the only later writes
 *   are the one-way status transitions plus `attempt_at_ms` /
 *   `refusal_reason`.
 * - Nothing here touches the F0 `forge_intents` tables: the swap's authority
 *   is the execution envelope, not the hook spend grant, so the two ledgers
 *   never share rows.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS execution_swap_intents (
      intent_id          TEXT PRIMARY KEY,
      environment_id     TEXT NOT NULL,
      envelope_id        TEXT NOT NULL,
      proposal_id        TEXT NOT NULL,
      quote_id           TEXT NOT NULL,
      route_id           TEXT NOT NULL,
      token_in           TEXT NOT NULL,
      token_out          TEXT NOT NULL,
      amount_in_raw      TEXT NOT NULL,
      min_amount_out_raw TEXT NOT NULL,
      recipient          TEXT NOT NULL,
      swap_target        TEXT NOT NULL,
      prepared_tx_json   TEXT NOT NULL,
      status             TEXT NOT NULL CHECK (status IN ('prepared','submit-refused','submitted','confirmed','reverted','unknown')),
      prepared_at_ms     INTEGER NOT NULL,
      attempt_at_ms      INTEGER,
      refusal_reason     TEXT
    )
  `;
  // The one-intent-per-proposal predicate: a storage backstop the writer
  // cannot dodge, the same discipline the (envelope, stage) partial unique
  // index applies to proposals (04:113).
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_swap_intents_proposal
      ON execution_swap_intents (proposal_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_execution_swap_intents_envelope_time
      ON execution_swap_intents (envelope_id, prepared_at_ms DESC)
  `;
});
