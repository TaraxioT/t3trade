/**
 * ForgeIntentLedgerSqlite — the durable intent ledger, the atomic admission
 * claim with gas reservation, the scoped control state (persistent local
 * pause), and the immutable approved-grant record.
 *
 * This is the drop-in SQL implementation of the adapter's `ForgeIntentLedger`
 * seam. Writes are serialized by the shared SQLite client (one connection
 * behind one semaphore permit), so `withTransaction` gives the claim the
 * compare-and-set it needs: the winner is decided by a unique claim id written
 * by a conditional UPDATE and read back inside the same transaction.
 *
 * Fail-closed rules encoded here:
 * - A claim on a record without enforceable gas fields (gasLimit x fee) loses:
 *   an unenforceable reservation is worse than none.
 * - Unknown submissions keep their reservation; only settleGas (called on
 *   confirmed/reverted receipts) releases it.
 * - The first recorded grant for a grantId is the authority forever. A later
 *   resolved grant that differs in ANY binding field is a retarget, never an
 *   update — `forge_grant_approvals` is INSERT-only.
 *
 * @module ForgeIntentLedgerSqlite
 */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { randomUUID } from "node:crypto";

import {
  ForgeGrantGuard,
  ForgeIntentLedger,
  type ForgeBroadcastRefusalReason,
  type ForgeGrantGuardShape,
  type ForgeGrantGuardVerdict,
  type ForgeIntentLedgerShape,
  type ForgeIntentRecord,
  type ForgeIntentSpend,
  type ForgeReceiptSnapshot,
  type ForgeTransactionState,
} from "./UniswapTestnetAdapter.ts";
import type { ForgeSpendGrant } from "./SepoliaTarget.ts";
import { SEPOLIA_CHAIN_ID } from "./SepoliaTarget.ts";
import { toPersistenceSqlError, type PersistenceSqlError } from "../../persistence/Errors.ts";
import { forgeJsonEncode } from "./ForgeJsonEncode.ts";

/** The persisted prepared transaction retained at claim time, verbatim. */
export interface ForgePreparedTransaction {
  readonly intentId: string;
  readonly grantId: string;
  readonly preparedAtMs: number;
  /** The unsigned transaction as claimed — exact calldata, gas fields, nonce. */
  readonly unsigned: ForgeIntentRecord["unsigned"];
  readonly gasReservedWei: string;
}

export interface ForgeIntentLedgerSqliteShape extends ForgeIntentLedgerShape {
  readonly durableAdmission: {
    readonly claim: (
      record: ForgeIntentRecord,
      grantId: string,
      gasBudgetWei: string,
    ) => Effect.Effect<boolean>;
  };
  /**
   * Release a settled intent's gas reservation; records the actual cost.
   * Storage faults die at this seam (see the service construction notes):
   * these channels are total like the base shape's.
   */
  readonly settleGas: (intentId: string, gasCostWei: string) => Effect.Effect<void>;
  readonly readPaused: (scope: string) => Effect.Effect<boolean>;
  readonly writePaused: (scope: string, paused: boolean) => Effect.Effect<void>;
  /** Live (unsettled) gas reservations — in-flight budget, not spent budget. */
  readonly totalReservedGasWei: Effect.Effect<string>;
}

const sqlFail = (operation: string) =>
  toPersistenceSqlError(`ForgeIntentLedgerSqlite.${operation}`);

// ---------------------------------------------------------------------------
// Row <-> record mapping
// ---------------------------------------------------------------------------

interface IntentRow {
  readonly intent_id: string;
  readonly idempotency_key: string;
  readonly environment_id: string;
  readonly kind: string;
  readonly created_at_ms: number;
  readonly unsigned_json: string;
  readonly status: string;
  readonly tx_hash: string | null;
  readonly submitted_at_ms: number | null;
  readonly settled_at_block_number: number | null;
  readonly gas_cost_wei: string | null;
  readonly gas_accounted: number;
  readonly receipt_json: string | null;
  readonly last_refusal_json: string | null;
  readonly spend_json: string;
  readonly params_json: string;
  readonly summary: string;
  readonly gas_reserved_wei: string | null;
}

// Column list shared by every read query; kept identical to the INSERT.

/** Parse JSON or return the corrupt marker (null) — never throws. */
const parseJsonOr = (raw: string | null): unknown =>
  raw === null
    ? undefined
    : (() => {
        try {
          return JSON.parse(raw);
        } catch {
          return null;
        }
      })();

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const decodeSpend = (raw: string): ForgeIntentSpend => {
  const parsed = asRecord(parseJsonOr(raw));
  if (parsed === null) return {};
  const spend: {
    deposits?: Array<{ readonly token: string; readonly amountRaw: string }>;
    swapQuoteAmountRaw?: string;
  } = {};
  const deposits = parsed["deposits"];
  if (Array.isArray(deposits)) {
    const entries: Array<{ readonly token: string; readonly amountRaw: string }> = [];
    for (const entry of deposits) {
      const record = asRecord(entry);
      if (
        record !== null &&
        typeof record["token"] === "string" &&
        typeof record["amountRaw"] === "string"
      ) {
        entries.push({ token: record["token"], amountRaw: record["amountRaw"] });
      }
    }
    spend.deposits = entries;
  }
  if (typeof parsed["swapQuoteAmountRaw"] === "string") {
    spend.swapQuoteAmountRaw = parsed["swapQuoteAmountRaw"];
  }
  return spend;
};

const decodeParams = (raw: string): Record<string, string> => {
  const parsed = asRecord(parseJsonOr(raw));
  if (parsed === null) return {};
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string") params[key] = value;
  }
  return params;
};

const decodeReceipt = (raw: string | null): ForgeReceiptSnapshot | undefined => {
  const parsed = asRecord(parseJsonOr(raw));
  if (parsed === null) return undefined;
  const status = parsed["status"];
  const hookEvents = Array.isArray(parsed["hookEvents"]) ? parsed["hookEvents"] : [];
  const poolEvents = Array.isArray(parsed["poolEvents"]) ? parsed["poolEvents"] : [];
  if (
    typeof parsed["txHash"] !== "string" ||
    (status !== "confirmed" && status !== "reverted") ||
    typeof parsed["blockNumber"] !== "number" ||
    typeof parsed["gasUsedUnits"] !== "string" ||
    typeof parsed["effectiveGasPriceWei"] !== "string" ||
    typeof parsed["gasCostWei"] !== "string"
  ) {
    return undefined;
  }
  return {
    txHash: parsed["txHash"],
    status,
    blockNumber: parsed["blockNumber"],
    gasUsedUnits: parsed["gasUsedUnits"],
    effectiveGasPriceWei: parsed["effectiveGasPriceWei"],
    gasCostWei: parsed["gasCostWei"],
    hookEvents: hookEvents as ForgeReceiptSnapshot["hookEvents"],
    poolEvents: poolEvents as ForgeReceiptSnapshot["poolEvents"],
  };
};

const decodeLastRefusal = (raw: string | null): ForgeIntentRecord["lastRefusal"] => {
  const parsed = asRecord(parseJsonOr(raw));
  if (
    parsed === null ||
    typeof parsed["reason"] !== "string" ||
    typeof parsed["detail"] !== "string" ||
    typeof parsed["refusedAtMs"] !== "number"
  ) {
    return undefined;
  }
  return {
    reason: parsed["reason"] as ForgeBroadcastRefusalReason,
    detail: parsed["detail"],
    refusedAtMs: parsed["refusedAtMs"],
  };
};

/** Reconstruct the unsigned transaction, optional gas fields included. */
const decodeUnsigned = (raw: string): ForgeIntentRecord["unsigned"] | null => {
  const parsed = asRecord(parseJsonOr(raw));
  if (parsed === null) return null;
  if (
    typeof parsed["chainId"] !== "number" ||
    typeof parsed["to"] !== "string" ||
    typeof parsed["data"] !== "string" ||
    typeof parsed["valueWei"] !== "string"
  ) {
    return null;
  }
  const unsigned: {
    chainId: ForgeIntentRecord["unsigned"]["chainId"];
    to: string;
    data: ForgeIntentRecord["unsigned"]["data"];
    valueWei: string;
    gasLimit?: string;
    maxFeePerGasWei?: string;
    maxPriorityFeePerGasWei?: string;
    gasPriceWei?: string;
    nonce?: number;
  } = {
    chainId: parsed["chainId"] as ForgeIntentRecord["unsigned"]["chainId"],
    to: parsed["to"],
    data: parsed["data"] as ForgeIntentRecord["unsigned"]["data"],
    valueWei: parsed["valueWei"],
  };
  for (const key of [
    "gasLimit",
    "maxFeePerGasWei",
    "maxPriorityFeePerGasWei",
    "gasPriceWei",
  ] as const) {
    if (typeof parsed[key] === "string") unsigned[key] = parsed[key] as string;
  }
  if (typeof parsed["nonce"] === "number") unsigned.nonce = parsed["nonce"];
  return unsigned;
};

const toRecord = (row: IntentRow): ForgeIntentRecord => {
  const receipt = decodeReceipt(row.receipt_json);
  const lastRefusal = decodeLastRefusal(row.last_refusal_json);
  return {
    intentId: row.intent_id,
    idempotencyKey: row.idempotency_key,
    kind: row.kind as ForgeIntentRecord["kind"],
    environmentId: row.environment_id,
    createdAtMs: row.created_at_ms,
    unsigned: decodeUnsigned(row.unsigned_json) ?? {
      // A corrupt unsigned payload cannot be reconstructed honestly. The
      // structurally invalid shape below fails the adapter's immutable
      // transaction and target-binding checks, so it can never broadcast.
      chainId: SEPOLIA_CHAIN_ID,
      to: "",
      data: "0x",
      valueWei: "0",
    },
    spend: decodeSpend(row.spend_json),
    status: row.status as ForgeTransactionState,
    ...(row.tx_hash === null ? {} : { txHash: row.tx_hash }),
    ...(row.submitted_at_ms === null ? {} : { submittedAtMs: row.submitted_at_ms }),
    ...(row.settled_at_block_number === null
      ? {}
      : { settledAtBlockNumber: row.settled_at_block_number }),
    ...(row.gas_cost_wei === null ? {} : { gasCostWei: row.gas_cost_wei }),
    gasAccounted: row.gas_accounted === 1,
    ...(receipt === undefined ? {} : { receipt }),
    ...(lastRefusal === undefined ? {} : { lastRefusal }),
    params: decodeParams(row.params_json),
    summary: row.summary,
  };
};

// ---------------------------------------------------------------------------
// Gas reservation arithmetic
// ---------------------------------------------------------------------------

const bigIntOr = (value: string | undefined): bigint | null => {
  if (value === undefined || !/^[0-9]+$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
};

/**
 * The enforceable maximum gas cost of the prepared transaction:
 * gasLimit x maxFeePerGasWei (EIP-1559) or gasLimit x gasPriceWei (legacy).
 * Null when the record carries no enforceable gas fields — a claim on such a
 * record must lose, because an unenforceable reservation is worse than none.
 */
export const maxGasWeiOf = (unsigned: ForgeIntentRecord["unsigned"]): string | null => {
  const gasLimit = bigIntOr(unsigned.gasLimit);
  if (gasLimit === null || gasLimit <= 0n) return null;
  if (unsigned.maxFeePerGasWei !== undefined) {
    const fee = bigIntOr(unsigned.maxFeePerGasWei);
    return fee === null || fee < 0n ? null : (gasLimit * fee).toString(10);
  }
  if (unsigned.gasPriceWei !== undefined) {
    const price = bigIntOr(unsigned.gasPriceWei);
    return price === null || price < 0n ? null : (gasLimit * price).toString(10);
  }
  return null;
};

// ---------------------------------------------------------------------------
// The ledger service
// ---------------------------------------------------------------------------

export const makeForgeIntentLedgerSqlite = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsert: ForgeIntentLedgerShape["upsert"] = (record) =>
    sql`
      INSERT INTO forge_intents (
        intent_id, idempotency_key, environment_id, kind, created_at_ms, unsigned_json,
        status, tx_hash, submitted_at_ms, settled_at_block_number, gas_cost_wei,
        gas_accounted, receipt_json, last_refusal_json, spend_json, params_json, summary
      ) VALUES (
        ${record.intentId}, ${record.idempotencyKey}, ${record.environmentId}, ${record.kind},
        ${record.createdAtMs}, ${JSON.stringify(record.unsigned)},
        ${record.status}, ${record.txHash ?? null}, ${record.submittedAtMs ?? null},
        ${record.settledAtBlockNumber ?? null}, ${record.gasCostWei ?? null},
        ${record.gasAccounted ? 1 : 0},
        ${record.receipt === undefined ? null : JSON.stringify(record.receipt)},
        ${record.lastRefusal === undefined ? null : JSON.stringify(record.lastRefusal)},
        ${JSON.stringify(record.spend)}, ${JSON.stringify(record.params)}, ${record.summary}
      )
      ON CONFLICT (intent_id) DO UPDATE SET
        status = excluded.status,
        tx_hash = excluded.tx_hash,
        submitted_at_ms = excluded.submitted_at_ms,
        settled_at_block_number = excluded.settled_at_block_number,
        gas_cost_wei = excluded.gas_cost_wei,
        gas_accounted = excluded.gas_accounted,
        receipt_json = excluded.receipt_json,
        last_refusal_json = excluded.last_refusal_json,
        spend_json = excluded.spend_json,
        params_json = excluded.params_json,
        summary = excluded.summary,
        -- The retained unsigned transaction is immutable with ONE documented
        -- exception: the prepared-transaction pass stamps enforceable gas
        -- fields (gasLimit/fees/nonce) onto a still-draft record exactly
        -- once, and ONLY those fields — to/data/value/chainId can never
        -- change after the draft is retained. A stamp on an already-stamped
        -- draft or any non-draft row is ignored.
        unsigned_json = CASE
          WHEN forge_intents.status = 'draft'
               AND json_extract(forge_intents.unsigned_json, '$.gasLimit') IS NULL
               AND json_extract(excluded.unsigned_json, '$.gasLimit') IS NOT NULL
            THEN json_set(forge_intents.unsigned_json,
              '$.gasLimit', json_extract(excluded.unsigned_json, '$.gasLimit'),
              '$.maxFeePerGasWei', json_extract(excluded.unsigned_json, '$.maxFeePerGasWei'),
              '$.maxPriorityFeePerGasWei', json_extract(excluded.unsigned_json, '$.maxPriorityFeePerGasWei'),
              '$.gasPriceWei', json_extract(excluded.unsigned_json, '$.gasPriceWei'),
              '$.nonce', json_extract(excluded.unsigned_json, '$.nonce'))
          ELSE forge_intents.unsigned_json
        END
      -- A delayed reconciliation/refusal write must not undo settlement or
      -- turn an admitted transaction back into an unsigned draft. Terminal
      -- rows are immutable; unknown -> submitted remains valid when a
      -- broadcaster returns its hash after the durable claim.
      WHERE forge_intents.status NOT IN ('confirmed', 'reverted')
        AND (excluded.status <> 'draft' OR forge_intents.status = 'draft')
    `.pipe(
      Effect.asVoid,
      Effect.mapError(sqlFail("upsert")),
      // The ledger seam models storage as infallible infrastructure (the
      // in-memory implementation cannot fail either): a SQLite fault is a
      // loud defect, never a silent success or a bypassed refusal.
      Effect.orDie,
    );

  const find: ForgeIntentLedgerShape["find"] = (intentId) =>
    sql<IntentRow>`
      SELECT intent_id, idempotency_key, environment_id, kind, created_at_ms,
             unsigned_json, status, tx_hash, submitted_at_ms, settled_at_block_number,
             gas_cost_wei, gas_accounted, receipt_json, last_refusal_json, spend_json,
             params_json, summary, gas_reserved_wei
      FROM forge_intents WHERE intent_id = ${intentId}
    `.pipe(
      Effect.mapError(sqlFail("find")),
      Effect.map((rows) => (rows[0] === undefined ? null : toRecord(rows[0]))),
      Effect.orDie,
    );

  const findByIdempotencyKey: ForgeIntentLedgerShape["findByIdempotencyKey"] = (key) =>
    sql<IntentRow>`
      SELECT intent_id, idempotency_key, environment_id, kind, created_at_ms,
             unsigned_json, status, tx_hash, submitted_at_ms, settled_at_block_number,
             gas_cost_wei, gas_accounted, receipt_json, last_refusal_json, spend_json,
             params_json, summary, gas_reserved_wei
      FROM forge_intents WHERE idempotency_key = ${key}
    `.pipe(
      Effect.mapError(sqlFail("findByIdempotencyKey")),
      Effect.map((rows) => (rows[0] === undefined ? null : toRecord(rows[0]))),
      Effect.orDie,
    );

  const listAll: ForgeIntentLedgerShape["listAll"] = sql<IntentRow>`
    SELECT intent_id, idempotency_key, environment_id, kind, created_at_ms,
           unsigned_json, status, tx_hash, submitted_at_ms, settled_at_block_number,
           gas_cost_wei, gas_accounted, receipt_json, last_refusal_json, spend_json,
           params_json, summary, gas_reserved_wei
    FROM forge_intents ORDER BY created_at_ms DESC, rowid DESC
  `.pipe(
    Effect.mapError(sqlFail("listAll")),
    Effect.map((rows) => rows.map(toRecord)),
    Effect.orDie,
  );

  const listRecent: ForgeIntentLedgerShape["listRecent"] = (limit = 20) =>
    sql<IntentRow>`
      SELECT intent_id, idempotency_key, environment_id, kind, created_at_ms,
             unsigned_json, status, tx_hash, submitted_at_ms, settled_at_block_number,
             gas_cost_wei, gas_accounted, receipt_json, last_refusal_json, spend_json,
             params_json, summary, gas_reserved_wei
      FROM forge_intents ORDER BY created_at_ms DESC, rowid DESC
      LIMIT ${Math.min(limit, 100)}
    `.pipe(
      Effect.mapError(sqlFail("listRecent")),
      Effect.map((rows) => rows.map(toRecord)),
      Effect.orDie,
    );

  const totalAccountedGasWei: ForgeIntentLedgerShape["totalAccountedGasWei"] = sql<{
    readonly gas_cost_wei: string | null;
  }>`
    SELECT gas_cost_wei FROM forge_intents WHERE gas_accounted = 1
  `.pipe(
    Effect.mapError(sqlFail("totalAccountedGasWei")),
    Effect.map((rows) =>
      rows
        .reduce(
          (total, row) => total + (row.gas_cost_wei === null ? 0n : BigInt(row.gas_cost_wei)),
          0n,
        )
        .toString(10),
    ),
    Effect.orDie,
  );

  const totalReservedGasWei: ForgeIntentLedgerSqliteShape["totalReservedGasWei"] = sql<{
    readonly gas_reserved_wei: string | null;
  }>`
    SELECT gas_reserved_wei FROM forge_intents
    WHERE gas_reserved_wei IS NOT NULL AND gas_settled = 0
  `.pipe(
    Effect.mapError(sqlFail("totalReservedGasWei")),
    Effect.map((rows) =>
      rows
        .reduce(
          (total, row) =>
            total + (row.gas_reserved_wei === null ? 0n : BigInt(row.gas_reserved_wei)),
          0n,
        )
        .toString(10),
    ),
    Effect.orDie,
  );

  /**
   * The atomic admission claim. One transaction: existence + draft + unclaimed
   * checks, the budget check (accounted + live reservations + this maximum),
   * then a conditional UPDATE guarded on the pre-claim state so exactly one
   * concurrent claimant can win. The claim persists `unknown` — durable
   * through interruption — before any side effect can run. A SQL failure or a
   * losing comparison both surface as `false`: fail closed.
   */
  const claim: ForgeIntentLedgerSqliteShape["durableAdmission"]["claim"] = (
    record,
    grantId,
    gasBudgetWei,
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const maxGasWei = maxGasWeiOf(record.unsigned);
          if (maxGasWei === null) return false;
          const current = yield* sql<{ readonly status: string; readonly claim_id: string | null }>`
            SELECT status, claim_id FROM forge_intents WHERE intent_id = ${record.intentId}
          `;
          const row = current[0];
          if (row === undefined || row.status !== "draft" || row.claim_id !== null) return false;

          // Budget across ALL grants, mirroring the adapter's global
          // totalAccountedGasWei semantics: never lets more through than the
          // strictest reading of the budget.
          const [accountedRows, reservedRows] = yield* Effect.all([
            sql<{ readonly gas_cost_wei: string | null }>`
              SELECT gas_cost_wei FROM forge_intents WHERE gas_accounted = 1
            `,
            sql<{ readonly gas_reserved_wei: string | null }>`
              SELECT gas_reserved_wei FROM forge_intents
              WHERE gas_reserved_wei IS NOT NULL AND gas_settled = 0
            `,
          ]);
          const accounted = accountedRows.reduce(
            (total, r) => total + (r.gas_cost_wei === null ? 0n : BigInt(r.gas_cost_wei)),
            0n,
          );
          const reserved = reservedRows.reduce(
            (total, r) => total + (r.gas_reserved_wei === null ? 0n : BigInt(r.gas_reserved_wei)),
            0n,
          );
          if (accounted + reserved + BigInt(maxGasWei) > BigInt(gasBudgetWei)) return false;

          const claimId = randomUUID();
          const nowMs = yield* Clock.currentTimeMillis;
          const prepared: ForgePreparedTransaction = {
            intentId: record.intentId,
            grantId,
            preparedAtMs: nowMs,
            unsigned: record.unsigned,
            gasReservedWei: maxGasWei,
          };

          yield* sql`
            UPDATE forge_intents SET
              status = 'unknown', grant_id = ${grantId}, claimed_at_ms = ${nowMs},
              claim_id = ${claimId}, gas_reserved_wei = ${maxGasWei},
              gas_settled = 0, prepared_json = ${forgeJsonEncode(prepared)}
            WHERE intent_id = ${record.intentId} AND status = 'draft' AND claim_id IS NULL
          `;
          const verify = yield* sql<{ readonly claim_id: string | null }>`
            SELECT claim_id FROM forge_intents WHERE intent_id = ${record.intentId}
          `;
          return verify[0]?.claim_id === claimId;
        }),
      )
      .pipe(
        Effect.mapError(sqlFail("claim")),
        // A claim that cannot be proven won is lost: fail closed, never
        // broadcast on a reservation that may not exist.
        Effect.catch(() => Effect.succeed(false)),
      );

  /**
   * Release a settled intent's reservation and record the actual cost.
   * Idempotent. The terminal-status predicate is storage-enforced: only a
   * confirmed or reverted record can release a reservation — an `unknown`
   * submission keeps its reservation (fail closed against budget escape) no
   * matter which caller invokes this.
   */
  const settleGas: ForgeIntentLedgerSqliteShape["settleGas"] = (intentId, gasCostWei) =>
    sql`
      UPDATE forge_intents
      SET gas_settled = 1, gas_reserved_wei = NULL,
          gas_cost_wei = ${gasCostWei}, gas_accounted = 1
      WHERE intent_id = ${intentId} AND gas_settled = 0
        AND status IN ('confirmed', 'reverted')
        AND gas_cost_wei = ${gasCostWei}
    `.pipe(Effect.asVoid, Effect.mapError(sqlFail("settleGas")), Effect.orDie);

  const readPaused: ForgeIntentLedgerSqliteShape["readPaused"] = (scope) =>
    sql<{ readonly paused: number }>`
      SELECT paused FROM forge_control_state WHERE scope = ${scope}
    `.pipe(
      Effect.mapError(sqlFail("readPaused")),
      Effect.map((rows) => rows[0]?.paused === 1),
      Effect.orDie,
    );

  const writePaused: ForgeIntentLedgerSqliteShape["writePaused"] = (scope, paused) =>
    Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      yield* sql`
        INSERT INTO forge_control_state (scope, paused, updated_at_ms)
        VALUES (${scope}, ${paused ? 1 : 0}, ${nowMs})
        ON CONFLICT (scope) DO UPDATE SET
          paused = excluded.paused, updated_at_ms = excluded.updated_at_ms
      `;
    }).pipe(Effect.mapError(sqlFail("writePaused")), Effect.orDie);

  return {
    durableAdmission: { claim },
    upsert,
    find,
    findByIdempotencyKey,
    listAll,
    listRecent,
    totalAccountedGasWei,
    settleGas,
    readPaused,
    writePaused,
    totalReservedGasWei,
  } satisfies ForgeIntentLedgerSqliteShape;
});

/** Provides the adapter's ForgeIntentLedger tag with the durable implementation. */
export const ForgeIntentLedgerSqliteLive = Layer.effect(
  ForgeIntentLedger,
  makeForgeIntentLedgerSqlite,
);

// ---------------------------------------------------------------------------
// The immutable approved-grant guard (tag lives in UniswapTestnetAdapter with
// the other forge service seams; this is the durable implementation)
// ---------------------------------------------------------------------------

interface GrantApprovalRow {
  readonly grant_id: string;
  readonly chain_id: number;
  readonly hook_address: string;
  readonly token_caps_json: string;
  readonly per_swap_max_quote_raw: string;
  readonly aggregate_gas_budget_wei: string;
  readonly operator_address: string;
  readonly expires_at_unix: number;
  readonly approved_via: string;
}

/** Canonical cap list: lowercase tokens, sorted, raw amounts. */
const canonicalCaps = (
  caps: ReadonlyArray<{ readonly token: string; readonly maxAmountRaw: string }>,
): Array<{ readonly token: string; readonly maxAmountRaw: string }> =>
  caps
    .map((cap) => ({ token: cap.token.toLowerCase(), maxAmountRaw: cap.maxAmountRaw }))
    .sort((a, b) => (a.token < b.token ? -1 : a.token > b.token ? 1 : 0));

const decodeCaps = (
  raw: string,
): ReadonlyArray<{ readonly token: string; readonly maxAmountRaw: string }> | null => {
  const parsed = parseJsonOr(raw);
  if (!Array.isArray(parsed)) return null;
  const caps: Array<{ readonly token: string; readonly maxAmountRaw: string }> = [];
  for (const entry of parsed) {
    const record = asRecord(entry);
    if (
      record === null ||
      typeof record["token"] !== "string" ||
      typeof record["maxAmountRaw"] !== "string"
    ) {
      return null;
    }
    caps.push({ token: record["token"], maxAmountRaw: record["maxAmountRaw"] });
  }
  return caps;
};

const normAddress = (value: string): string => value.trim().toLowerCase();

/** Render a persistence SQL error's message plus its underlying cause. */
const sqlErrorDetail = (error: unknown): string => {
  const record = error as {
    readonly message?: string;
    readonly reason?: { readonly cause?: unknown };
  };
  const message = record?.message ?? String(error);
  const cause = record?.reason?.cause;
  return cause === undefined || cause === null ? message : `${message} (${String(cause)})`;
};

/** First binding-field mismatch between a recorded approval and a grant, or null. */
const bindingMismatch = (row: GrantApprovalRow, grant: ForgeSpendGrant): string | null => {
  if (row.chain_id !== grant.chainId) return "chainId";
  if (normAddress(row.hook_address) !== normAddress(grant.hookAddress)) return "hookAddress";
  if (normAddress(row.operator_address) !== normAddress(grant.operatorAddress)) {
    return "operatorAddress";
  }
  if (BigInt(row.per_swap_max_quote_raw) !== BigInt(grant.perSwapMaxQuoteRaw)) {
    return "perSwapMaxQuoteRaw";
  }
  if (BigInt(row.aggregate_gas_budget_wei) !== BigInt(grant.aggregateGasBudgetWei)) {
    return "aggregateGasBudgetWei";
  }
  if (row.expires_at_unix !== grant.expiresAtUnix) return "expiresAtUnix";
  const recorded = decodeCaps(row.token_caps_json);
  const resolved = canonicalCaps(grant.tokenCaps);
  if (recorded === null || recorded.length !== resolved.length) return "tokenCaps";
  for (let index = 0; index < recorded.length; index += 1) {
    if (
      recorded[index]!.token !== resolved[index]!.token ||
      BigInt(recorded[index]!.maxAmountRaw) !== BigInt(resolved[index]!.maxAmountRaw)
    ) {
      return "tokenCaps";
    }
  }
  return null;
};

/**
 * The only legitimate origin of a recorded grant today: the operator-authored
 * server environment (T3_FORGE_GRANT_* resolved by SepoliaTarget). Recording
 * the origin makes the approval chain explicit — the first sighting of a
 * grant is recorded AS config approval, never as tool- or query-supplied
 * authority. Generalized execution (P5) will require its own authenticated
 * approval origin; this constant must not be reused for it.
 */
const GRANT_APPROVED_VIA_SERVER_CONFIG = "server-config";

export const makeForgeGrantGuard = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const recordOrVerify: ForgeGrantGuardShape["recordOrVerify"] = (grant) =>
    Effect.gen(function* () {
      const rows = yield* sql<GrantApprovalRow>`
        SELECT grant_id, chain_id, hook_address, token_caps_json, per_swap_max_quote_raw,
               aggregate_gas_budget_wei, operator_address, expires_at_unix, approved_via
        FROM forge_grant_approvals WHERE grant_id = ${grant.grantId}
      `;
      const existing = rows[0];
      if (existing === undefined) {
        const nowMs = yield* Clock.currentTimeMillis;

        // INSERT-only: the first recorded grant for this id is the authority,
        // and the row names where the approval came from.
        yield* sql`
          INSERT INTO forge_grant_approvals (
            grant_id, chain_id, hook_address, token_caps_json, per_swap_max_quote_raw,
            aggregate_gas_budget_wei, operator_address, expires_at_unix, approved_via,
            recorded_at_ms
          ) VALUES (
            ${grant.grantId}, ${grant.chainId}, ${normAddress(grant.hookAddress)},
            ${forgeJsonEncode(canonicalCaps(grant.tokenCaps))},
            ${grant.perSwapMaxQuoteRaw}, ${grant.aggregateGasBudgetWei},
            ${normAddress(grant.operatorAddress)}, ${grant.expiresAtUnix},
            ${GRANT_APPROVED_VIA_SERVER_CONFIG}, ${nowMs}
          )
        `;
        return { status: "recorded" as const };
      }
      const mismatch = bindingMismatch(existing, grant);
      if (mismatch !== null) {
        return {
          status: "retarget" as const,
          detail: `approved grant '${grant.grantId}' is bound to a different ${mismatch}; refusing to retarget`,
        };
      }
      return { status: "verified" as const };
    }).pipe(
      Effect.mapError((error) => `forge grant approval store error: ${sqlErrorDetail(error)}`),
    );

  return ForgeGrantGuard.of({ recordOrVerify });
});

export const ForgeGrantGuardLive = Layer.effect(ForgeGrantGuard, makeForgeGrantGuard);
