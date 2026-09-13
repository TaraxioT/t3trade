import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Swap broadcast lifecycle (111) — the durable attempt/receipt state for the
 * protected execution lane. Two tables, both keyed by intent:
 *
 * - `execution_swap_attempts` — ONE row per protected intent, created at
 *   admission. It carries the IMMUTABLE unsigned intent bytes plus, once
 *   stamped, the IMMUTABLE signing snapshot (nonce, gas limit, EIP-1559 fee
 *   caps, chain id, deadline) — the exact fields a deterministic local
 *   signature commits to. `signed_tx_rlp` holds the broadcast-capable signed
 *   bytes needed for identical-byte recovery; it is never surfaced through
 *   general logs or views. The status machine is one-way:
 *   `reserved → signed → broadcast-uncertain → included → confirmed |
 *   reverted`, with the named exits `sign-refused` (nothing signed),
 *   `released-before-sign` (reservation released, no signature exists), and
 *   `unknown` (ambiguity PRESERVED with its reservation until a receipt or
 *   reconciliation resolves it).
 * - `execution_swap_receipts` — INSERT-only, unique by transaction hash:
 *   receipt settlement is idempotent by construction. A success row settles
 *   the ACTUAL input/output/fees with the validated transfer/withdrawal
 *   evidence; a reverted row settles fees only and releases the principal;
 *   an unknown outcome writes no row and retains the reservation.
 *
 * Registered by the coordinator in Migrations.ts; this file only defines it.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS execution_swap_attempts (
      intent_id             TEXT PRIMARY KEY,
      reservation_id        TEXT NOT NULL,
      environment_id        TEXT NOT NULL,
      envelope_id           TEXT NOT NULL,
      unsigned_tx_json      TEXT NOT NULL,
      calldata_digest       TEXT NOT NULL,
      status                TEXT NOT NULL CHECK (
        status IN (
          'reserved','signed','broadcast-uncertain','included','confirmed','reverted',
          'unknown','sign-refused','released-before-sign'
        )
      ),
      signing_snapshot_json TEXT,
      signed_tx_rlp         TEXT,
      signed_tx_hash        TEXT,
      reserved_at_ms        INTEGER NOT NULL,
      signed_at_ms          INTEGER,
      broadcast_at_ms       INTEGER,
      resolved_at_ms        INTEGER,
      refusal_reason        TEXT
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_swap_attempts_tx_hash
      ON execution_swap_attempts (signed_tx_hash) WHERE signed_tx_hash IS NOT NULL
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS execution_swap_receipts (
      tx_hash              TEXT PRIMARY KEY,
      intent_id            TEXT NOT NULL,
      reservation_id       TEXT NOT NULL,
      status               TEXT NOT NULL CHECK (status IN ('success','reverted')),
      block_number         INTEGER NOT NULL,
      block_hash           TEXT NOT NULL,
      gas_used             TEXT NOT NULL,
      effective_gas_price  TEXT NOT NULL,
      actual_fee_wei       TEXT NOT NULL,
      actual_input_raw     TEXT,
      actual_output_raw    TEXT,
      evidence_json        TEXT,
      settled_at_ms        INTEGER NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_execution_swap_receipts_intent
      ON execution_swap_receipts (intent_id)
  `;
});
