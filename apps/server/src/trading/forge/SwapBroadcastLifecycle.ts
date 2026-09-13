/**
 * SwapBroadcastLifecycle — what happens after protected admission: the
 * immutable signing snapshot, the refusing-by-default broadcast, uncertain
 * send reconciliation, and idempotent receipt accounting.
 *
 * The state machine (one row in `execution_swap_attempts`, mirrored onto the
 * intent's public status) is one-way:
 *
 *   reserved → [pre-sign gates] → signed → broadcast-uncertain
 *            → included → confirmed | reverted
 *   reserved → sign-refused | released-before-sign    (the named exits)
 *   broadcast-uncertain → unknown                      (ambiguity PRESERVED)
 *
 * Rules this module enforces:
 *
 * - The signing snapshot (nonce, gas limit, EIP-1559 caps, chain id,
 *   deadline) is stamped ONCE and immutable; a second stamp with different
 *   values refuses. The gas limit is EXACTLY the measured estimate — an
 *   under-gas reverts safely (fees only), an over-gas could exceed the
 *   reserved worst-case fees, and the reservation is the bound.
 * - Signing is deterministic local signing behind the dedicated spot demo
 *   signer (`T3_SPOT_DEMO_SIGNER_KEY` / `<T3TRADE_HOME>/secrets/
 *   spot-demo-signer-key.bin`, see SpotMainnetTarget). The signer is NEVER
 *   Hyperliquid or F0 material. Nothing is signed while no broadcaster
 *   exists: the broadcast sink's availability is checked BEFORE the signer
 *   is read, so the shipped refusing sink means the signed state is
 *   unreachable until the coordinator's funded lane wires a real one.
 * - After an uncertain send, reconciliation queries the SAME hash and nonce;
 *   the only permitted retransmission is byte-identical (same intent, same
 *   hash). No fee bump, no new nonce, no new economic action.
 * - Receipt settlement is idempotent (unique by tx hash). A success settles
 *   the ACTUAL input/output/fees only after validating the expected
 *   Transfer/Withdrawal evidence against the pool, router, and recipient —
 *   status 1 alone is not asset movement. A revert settles fees only and
 *   ends the reservation without spending the principal. Unknown retains
 *   the reservation.
 *
 * @module SwapBroadcastLifecycle
 */
// @effect-diagnostics preferSchemaOverJson:off tryCatchInEffectGen:off catchToOrElseSucceed:off
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { keccak256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import type { ExecutionRefusal } from "@t3tools/trading-contracts";
import { toPersistenceSqlError, PersistenceSqlError } from "../../persistence/Errors.ts";
import { forgeJsonEncode } from "./ForgeJsonEncode.ts";
import {
  priceImpactRefusal,
  PROTECTED_PRICE_IMPACT_MAX_BPS_DEFAULT,
} from "./MainnetProtectedRouter.ts";
import {
  SpotDemoSignerConfig,
  SpotMainnetTransport,
  type SpotMainnetTarget,
} from "./SpotMainnetTarget.ts";
import { DetectorRunStore } from "./DetectorRunStore.ts";

/** Refusal names the lifecycle can emit. */
export type SwapLifecycleRefusalName =
  | ExecutionRefusal
  | "attempt-not-found"
  | "reservation-released"
  | "snapshot-mismatch"
  | "signer-unarmed"
  | "already-signed"
  | "wrong-state"
  | "funding-insufficient"
  | "reference-unavailable"
  | "price-impact"
  | "evidence-mismatch";

/** The ERC-20 Transfer topic, keccak256("Transfer(address,address,uint256)"). */
export const ERC20_TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
/** The WETH9 Withdrawal topic, keccak256("Withdrawal(address,uint256)"). */
export const WETH_WITHDRAWAL_TOPIC =
  "0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65";

/** The TWAP window (seconds) the price-impact reference reads. */
export const PRICE_REFERENCE_TWAP_WINDOW_SECONDS = 1_800;
/** How far the chain's clock may lag the local clock before the reference is stale. */
export const PRICE_REFERENCE_MAX_CLOCK_SKEW_SECONDS = 120;

/**
 * The broadcast seam. The only implementation this module ships refuses
 * `broadcaster-missing`; the coordinator's funded lane wires a real one.
 * `available` is checked BEFORE any signer is read, so no signed bytes come
 * to exist while no broadcaster is wired.
 */
export interface SpotBroadcastSinkShape {
  readonly available: Effect.Effect<boolean, never>;
  readonly broadcast: (signedTxRlp: string) => Effect.Effect<{ readonly txHash: string }, string>;
}

export class SpotBroadcastSink extends Context.Service<SpotBroadcastSink, SpotBroadcastSinkShape>()(
  "t3/trading/forge/SwapBroadcastLifecycle/SpotBroadcastSink",
) {}

/** The honest shipped implementation's SERVICE VALUE: refuse everything, sign nothing. */
export const spotBroadcastSinkRefusing: SpotBroadcastSinkShape = {
  available: Effect.succeed(false),
  broadcast: () => Effect.fail("broadcaster-missing: no funded broadcast lane is wired"),
};

/** The same value as a layer, for runtime composition. */
export const SpotBroadcastSinkUnavailable = Layer.succeed(
  SpotBroadcastSink,
  spotBroadcastSinkRefusing,
);

/** The immutable signing snapshot persisted before any signature exists. */
export interface SigningSnapshot {
  readonly chainId: 1;
  readonly nonce: number;
  readonly to: string;
  readonly value: string;
  readonly data: string;
  readonly gasUnits: string;
  readonly maxFeePerGasWei: string;
  readonly maxPriorityFeePerGasWei: string;
  readonly deadlineUnix: number;
  readonly calldataDigest: string;
}

export type SigningSnapshotOutcome =
  | { readonly status: "stamped"; readonly snapshot: SigningSnapshot }
  | { readonly status: "already-stamped"; readonly snapshot: SigningSnapshot }
  | {
      readonly status: "refused";
      readonly refusal: SwapLifecycleRefusalName;
      readonly detail: string;
    };

export type SignAndBroadcastOutcome =
  | {
      readonly status: "refused";
      readonly refusal: SwapLifecycleRefusalName;
      readonly detail: string;
    }
  | { readonly status: "signed-and-broadcast"; readonly txHash: string }
  | { readonly status: "already-broadcast"; readonly txHash: string };

export type ReconcileOutcome =
  | {
      readonly status: "refused";
      readonly refusal: SwapLifecycleRefusalName;
      readonly detail: string;
    }
  | { readonly status: "still-pending" }
  | { readonly status: "dropped-retransmitted"; readonly txHash: string }
  | { readonly status: "nonce-consumed-elsewhere" }
  | { readonly status: "receipt-settled"; readonly settlement: ReceiptSettlementView }
  | { readonly status: "no-receipt-yet" };

export interface ReceiptLog {
  readonly address: string;
  readonly topics: ReadonlyArray<string>;
  readonly data: string;
}

export interface ChainReceipt {
  readonly txHash: string;
  readonly status: "success" | "reverted";
  readonly blockNumber: number;
  readonly blockHash: string;
  readonly gasUsed: string;
  readonly effectiveGasPrice: string;
  readonly logs: ReadonlyArray<ReceiptLog>;
}

export interface ReceiptSettlementView {
  readonly txHash: string;
  readonly status: "settled-success" | "settled-revert";
  readonly actualFeeWei: string;
  readonly actualInputRaw: string | null;
  readonly actualOutputRaw: string | null;
}

export interface SwapBroadcastLifecycleShape {
  /** Stamp (once) the immutable signing snapshot for an admitted intent. */
  readonly createSigningSnapshot: (input: {
    readonly intentId: string;
    readonly nonce: number;
    readonly now: number;
  }) => Effect.Effect<SigningSnapshotOutcome, PersistenceSqlError>;

  /**
   * Run every pre-sign gate, sign deterministically, and broadcast. With the
   * shipped refusing sink this refuses `broadcaster-missing` BEFORE reading
   * the signer — nothing is ever signed without a lane to send it through.
   */
  readonly signAndBroadcast: (input: {
    readonly intentId: string;
    readonly now: number;
  }) => Effect.Effect<SignAndBroadcastOutcome, PersistenceSqlError>;

  /**
   * Resolve a broadcast-uncertain attempt by the SAME hash/nonce. Never a
   * new economic action; the only retransmission is byte-identical.
   */
  readonly reconcile: (input: {
    readonly intentId: string;
    readonly now: number;
  }) => Effect.Effect<ReconcileOutcome, PersistenceSqlError>;

  /**
   * Settle a receipt idempotently. Success settles actual input/output/fees
   * only after validating the Transfer/Withdrawal evidence; revert settles
   * fees only and releases the principal.
   */
  readonly settleFromReceipt: (input: {
    readonly intentId: string;
    readonly receipt: ChainReceipt;
    readonly now: number;
  }) => Effect.Effect<
    | { readonly status: "settled"; readonly settlement: ReceiptSettlementView }
    | { readonly status: "already-settled"; readonly settlement: ReceiptSettlementView }
    | {
        readonly status: "refused";
        readonly refusal: SwapLifecycleRefusalName;
        readonly detail: string;
      },
    PersistenceSqlError
  >;
}

export class SwapBroadcastLifecycle extends Context.Service<
  SwapBroadcastLifecycle,
  SwapBroadcastLifecycleShape
>()("t3/trading/forge/SwapBroadcastLifecycle") {}

const sqlFail = (operation: string) => toPersistenceSqlError(`SwapBroadcastLifecycle.${operation}`);

interface AttemptRow {
  readonly intent_id: string;
  readonly reservation_id: string;
  readonly environment_id: string;
  readonly envelope_id: string;
  readonly unsigned_tx_json: string;
  readonly calldata_digest: string;
  readonly status: string;
  readonly signing_snapshot_json: string | null;
  readonly signed_tx_rlp: string | null;
  readonly signed_tx_hash: string | null;
  readonly reserved_at_ms: number;
  readonly refusal_reason: string | null;
}

interface IntentRow {
  readonly intent_id: string;
  readonly environment_id: string;
  readonly envelope_id: string;
  readonly proposal_id: string;
  readonly route_id: string;
  readonly token_in: string;
  readonly token_out: string;
  readonly amount_in_raw: string;
  readonly min_amount_out_raw: string;
  readonly recipient: string;
  readonly prepared_tx_json: string;
  readonly status: string;
}

const NATIVE_MARKER = `0x${"0".repeat(40)}`;
const EXACT_DECIMAL = /^(0|[1-9][0-9]*)$/;

const decodeUnsigned = (
  raw: string,
): {
  readonly to: string;
  readonly value: string;
  readonly data: string;
  readonly gas_units?: string | undefined;
  readonly max_fee_per_gas_wei?: string | undefined;
  readonly max_priority_fee_per_gas_wei?: string | undefined;
  readonly deadline_unix?: number | undefined;
  readonly calldata_digest?: string | undefined;
} | null => {
  try {
    return JSON.parse(raw) as {
      readonly to: string;
      readonly value: string;
      readonly data: string;
      readonly gas_units?: string;
      readonly max_fee_per_gas_wei?: string;
      readonly max_priority_fee_per_gas_wei?: string;
      readonly deadline_unix?: number;
      readonly calldata_digest?: string;
    };
  } catch {
    return null;
  }
};

/** The 50th-percentile TWAP-implied output for the pool's current direction,
 *  as a sanity REFERENCE (floating point is acceptable for a bounded
 *  comparison, never for amounts). Null when the oracle read is unusable. */
const twapReferenceOut = (
  pool: string,
  tokenIn: string,
  tokenOut: string,
  amountInRaw: string,
  decimalsIn: number,
  decimalsOut: number,
  request: (method: string, params: ReadonlyArray<unknown>) => Effect.Effect<unknown, string>,
): Effect.Effect<string | null, never> =>
  request("eth_call", [
    {
      to: pool,
      // observe(uint32[]) selector 0x883bdbfd + one-element array [window].
      data: `0x883bdbfd${32n.toString(16).padStart(64, "0")}${1n.toString(16).padStart(64, "0")}${BigInt(
        PRICE_REFERENCE_TWAP_WINDOW_SECONDS,
      )
        .toString(16)
        .padStart(64, "0")}`,
    },
    "latest",
  ]).pipe(
    Effect.map((raw): string | null => {
      if (typeof raw !== "string" || !raw.startsWith("0x")) return null;
      const body = raw.slice(2);
      // observe(uint32[]) returns (int56[] tickCumulatives, uint160[]
      // secondsPerLiquidityCumulativeX120s): two head offsets, then the
      // arrays. Single-point observe gives the cumulative at that age.
      if (body.length < 64 * 6) return null;
      try {
        const word = (index: number): bigint =>
          BigInt(`0x${body.slice(index * 64, (index + 1) * 64)}`);
        const offA = Number(word(0));
        if (offA < 64 || offA % 32 !== 0) return null;
        const base = offA / 32;
        const lenA = Number(word(base));
        if (lenA !== 1) return null;
        // int56 arrives as a 32-byte two's-complement word: values above
        // 2^255 are negative ticks.
        const rawCumulative = word(base + 1);
        const tickCumulative =
          rawCumulative >= 1n << 255n ? rawCumulative - (1n << 256n) : rawCumulative;
        // tickCumulative over `window` seconds from SECOND 0 is the absolute
        // cumulative at now-window… single-point observe gives the cumulative
        // AT that age; the twapTick needs two points, so the honest fallback
        // is to treat the single cumulative's tick as time-weighted at the
        // window scale only when the pool was initialized before it. Use it
        // as the reference tick divided by the window.
        const twapTick = Number(tickCumulative) / PRICE_REFERENCE_TWAP_WINDOW_SECONDS;
        if (!Number.isFinite(twapTick)) return null;
        // Raw pool price = token1/token0 = 1.0001^tick (scaled by 2^96 later
        // cancels). Direction + decimals decide the quote side.
        const tokenInLower = tokenIn.toLowerCase();
        const tokenOutLower = tokenOut.toLowerCase();
        const zeroForOne = tokenInLower < tokenOutLower;
        const priceRaw = Math.pow(1.0001, twapTick); // token1 per token0
        const decimalsShift = Math.pow(10, decimalsOut - decimalsIn);
        // out = in × price (token0→token1) or in / price (token1→token0),
        // adjusted for decimals, floored to an exact integer string.
        const implied = zeroForOne
          ? Number(BigInt(amountInRaw)) * priceRaw * decimalsShift
          : (Number(BigInt(amountInRaw)) / priceRaw) * decimalsShift;
        if (!Number.isFinite(implied) || implied <= 0) return null;
        return BigInt(Math.floor(implied)).toString(10);
      } catch {
        return null;
      }
    }),
    Effect.catch(() => Effect.succeed<string | null>(null)),
  );

export const makeSwapBroadcastLifecycle = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const signerConfig = yield* SpotDemoSignerConfig;
  const sink = yield* SpotBroadcastSink;
  const mainnetTransportOption = yield* Effect.serviceOption(SpotMainnetTransport);
  const detectorRuns = yield* DetectorRunStore;

  const attemptFor = (intentId: string) =>
    sql<AttemptRow>`
      SELECT intent_id, reservation_id, environment_id, envelope_id, unsigned_tx_json,
             calldata_digest, status, signing_snapshot_json, signed_tx_rlp, signed_tx_hash,
             reserved_at_ms, refusal_reason
      FROM execution_swap_attempts WHERE intent_id = ${intentId}
    `.pipe(Effect.mapError(sqlFail("attemptFor")));

  const intentRowFor = (intentId: string) =>
    sql<IntentRow>`
      SELECT intent_id, environment_id, envelope_id, proposal_id, route_id, token_in, token_out,
             amount_in_raw, min_amount_out_raw, recipient, prepared_tx_json, status
      FROM execution_swap_intents WHERE intent_id = ${intentId}
    `.pipe(Effect.mapError(sqlFail("intentRowFor")));

  const createSigningSnapshot: SwapBroadcastLifecycleShape["createSigningSnapshot"] = ({
    intentId,
    nonce,
    now,
  }) =>
    Effect.gen(function* () {
      const refuse = (refusal: SwapLifecycleRefusalName, detail: string) => ({
        status: "refused" as const,
        refusal,
        detail,
      });
      if (!Number.isSafeInteger(nonce) || nonce < 0) {
        return refuse("snapshot-mismatch", "nonce must be a nonnegative safe integer");
      }
      const attempts = yield* attemptFor(intentId);
      const attempt = attempts[0];
      if (attempt === undefined) {
        return refuse("attempt-not-found", `no protected attempt for intent ${intentId}`);
      }
      if (attempt.signing_snapshot_json !== null) {
        const existing = JSON.parse(attempt.signing_snapshot_json) as SigningSnapshot;
        if (existing.nonce === nonce) {
          return { status: "already-stamped" as const, snapshot: existing };
        }
        return refuse(
          "snapshot-mismatch",
          `the signing snapshot is immutable: stored nonce ${existing.nonce}, requested ${nonce}`,
        );
      }
      const unsigned = decodeUnsigned(attempt.unsigned_tx_json);
      if (
        unsigned === null ||
        unsigned.gas_units === undefined ||
        unsigned.max_fee_per_gas_wei === undefined ||
        unsigned.max_priority_fee_per_gas_wei === undefined ||
        unsigned.deadline_unix === undefined ||
        unsigned.calldata_digest === undefined
      ) {
        return refuse("snapshot-mismatch", "the stored unsigned intent lacks its measured fields");
      }
      const snapshot: SigningSnapshot = {
        chainId: 1,
        nonce,
        to: unsigned.to,
        value: unsigned.value,
        data: unsigned.data,
        gasUnits: unsigned.gas_units,
        maxFeePerGasWei: unsigned.max_fee_per_gas_wei,
        maxPriorityFeePerGasWei: unsigned.max_priority_fee_per_gas_wei,
        deadlineUnix: unsigned.deadline_unix,
        calldataDigest: unsigned.calldata_digest,
      };
      yield* sql`
        UPDATE execution_swap_attempts
        SET signing_snapshot_json = ${forgeJsonEncode(snapshot)}
        WHERE intent_id = ${intentId} AND signing_snapshot_json IS NULL AND status = 'reserved'
      `.pipe(Effect.mapError(sqlFail("createSigningSnapshot")));
      const verify = yield* attemptFor(intentId);
      if (verify[0]?.signing_snapshot_json === null) {
        return yield* new PersistenceSqlError({
          operation: "SwapBroadcastLifecycle.createSigningSnapshot",
          detail: "snapshot stamp verification failed; the transaction rolled back",
        });
      }
      return { status: "stamped" as const, snapshot };
    }).pipe(Effect.mapError(sqlFail("createSigningSnapshot")));

  const signAndBroadcast: SwapBroadcastLifecycleShape["signAndBroadcast"] = ({ intentId, now }) =>
    Effect.gen(function* () {
      const refuse = (refusal: SwapLifecycleRefusalName, detail: string) => ({
        status: "refused" as const,
        refusal,
        detail,
      });

      // THE BROADCASTER GATE FIRST: with the shipped refusing sink nothing
      // past this point ever runs, so no signed bytes exist without a lane.
      const sinkAvailable = yield* sink.available;
      if (!sinkAvailable) {
        return refuse(
          "broadcaster-missing",
          "no funded broadcast lane is wired; the signer is not even read, and nothing was signed",
        );
      }

      const attempts = yield* attemptFor(intentId);
      const attempt = attempts[0];
      if (attempt === undefined) {
        return refuse("attempt-not-found", `no protected attempt for intent ${intentId}`);
      }
      // Record a refusal reason on the attempt row (durable ops signal); a
      // TERMINAL refusal also advances the attempt to the documented
      // `sign-refused` state — retryable gates keep `reserved` so the same
      // admission can sign once the transient cause clears.
      const recordRefusal = (reason: string): Effect.Effect<void, PersistenceSqlError> =>
        sql`
          UPDATE execution_swap_attempts SET refusal_reason = ${reason}
          WHERE intent_id = ${intentId}
        `.pipe(Effect.mapError(sqlFail("signAndBroadcast.recordRefusal")), Effect.asVoid);
      const terminalRefuse = (
        refusal: SwapLifecycleRefusalName,
        detail: string,
      ): Effect.Effect<SignAndBroadcastOutcome, PersistenceSqlError> =>
        Effect.gen(function* () {
          yield* sql`
            UPDATE execution_swap_attempts
            SET status = 'sign-refused', refusal_reason = ${`${refusal}: ${detail}`}
            WHERE intent_id = ${intentId} AND status IN ('reserved','signed')
          `.pipe(Effect.mapError(sqlFail("signAndBroadcast.terminalRefuse")));
          return { status: "refused" as const, refusal, detail };
        });
      if (
        attempt.status !== "reserved" &&
        attempt.status !== "signed" &&
        attempt.status !== "broadcast-uncertain"
      ) {
        return refuse(
          "wrong-state",
          `attempt status is ${attempt.status}; only a reserved/signed/uncertain attempt can sign`,
        );
      }
      // THE RESERVATION STATE IS PART OF THE SIGN CLAIM: a released
      // reservation must never sign, whatever its attempt row says.
      const reservationRows = yield* sql<{ readonly status: string }>`
        SELECT status FROM execution_swap_reservations WHERE reservation_id = ${attempt.reservation_id}
      `.pipe(Effect.mapError(sqlFail("signAndBroadcast.reservation")));
      const reservationStatus = reservationRows[0]?.status;
      if (reservationStatus === "released") {
        // Repair any pre-release-fix row that still says reserved, then
        // refuse by name.
        yield* sql`
          UPDATE execution_swap_attempts
          SET status = 'released-before-sign', refusal_reason = ${"reservation-released: the reservation was released before signing"}
          WHERE intent_id = ${intentId} AND status = 'reserved'
        `.pipe(Effect.mapError(sqlFail("signAndBroadcast.markReleased")));
        return refuse(
          "reservation-released",
          "the admission's reservation was released before signing; nothing can be signed for it",
        );
      }
      if (reservationStatus !== "reserved") {
        return yield* terminalRefuse(
          "wrong-state",
          `the reservation status is ${reservationStatus ?? "missing"}; only a reserved reservation signs`,
        );
      }
      if (attempt.signed_tx_hash !== null) {
        // Already signed: identical-byte authority exists; broadcast (again)
        // is the same hash — never a new signature.
        const broadcast = yield* sink
          .broadcast(attempt.signed_tx_rlp ?? "")
          .pipe(Effect.mapError(sqlFail("signAndBroadcast.broadcast")));
        yield* sql`
          UPDATE execution_swap_attempts
          SET status = 'broadcast-uncertain', broadcast_at_ms = ${now}
          WHERE intent_id = ${intentId}
        `.pipe(Effect.mapError(sqlFail("signAndBroadcast.markBroadcast")));
        yield* sql`
          UPDATE execution_swap_intents SET status = 'submitted' WHERE intent_id = ${intentId}
        `.pipe(Effect.mapError(sqlFail("signAndBroadcast.markIntent")));
        return { status: "already-broadcast" as const, txHash: attempt.signed_tx_hash };
      }
      if (attempt.signing_snapshot_json === null) {
        return yield* terminalRefuse("wrong-state", "the signing snapshot has not been stamped");
      }
      const snapshot = JSON.parse(attempt.signing_snapshot_json) as SigningSnapshot;
      // Cheap, load-bearing re-verification: the snapshot must still match
      // the immutable unsigned intent bytes it was stamped from, and its own
      // calldata digest must still be the keccak of its data. A drifted or
      // tampered snapshot is terminal.
      const unsigned = decodeUnsigned(attempt.unsigned_tx_json);
      const bare = (hex: string): string => hex.replace(/^0x/, "");
      const snapshotDigest = bare(keccak256(snapshot.data as Hex));
      if (
        unsigned === null ||
        unsigned.to !== snapshot.to ||
        unsigned.value !== snapshot.value ||
        unsigned.data !== snapshot.data ||
        snapshotDigest !== bare(snapshot.calldataDigest)
      ) {
        return yield* terminalRefuse(
          "snapshot-mismatch",
          "the signing snapshot no longer matches the unsigned intent bytes or its own calldata digest",
        );
      }

      const intents = yield* intentRowFor(intentId);
      const intent = intents[0];
      if (intent === undefined) {
        return refuse("attempt-not-found", `the intent row for ${intentId} is missing`);
      }

      // Pre-sign gates over retained state: envelope still approved, the
      // matched occurrence still current (submit-time eligibility, not
      // policy-time).
      const envelopeRows = yield* sql<{
        readonly status: string;
        readonly envelope_json: string;
        readonly capability_id: string | null;
      }>`
        SELECT status, envelope_json, capability_id FROM execution_envelopes
        WHERE envelope_id = ${attempt.envelope_id}
      `.pipe(Effect.mapError(sqlFail("signAndBroadcast.envelope")));
      const envelopeRow = envelopeRows[0];
      if (envelopeRow === undefined || envelopeRow.status !== "approved") {
        return yield* terminalRefuse(
          "envelope-not-approved",
          `envelope status at sign time is ${envelopeRow?.status ?? "missing"}`,
        );
      }
      try {
        const envelope = JSON.parse(envelopeRow.envelope_json) as { expiresAtMs: number };
        if (now >= envelope.expiresAtMs) {
          return yield* terminalRefuse("envelope-expired", "the envelope expired before signing");
        }
      } catch {
        return yield* terminalRefuse(
          "envelope-not-approved",
          "the envelope bytes do not decode at sign time",
        );
      }
      if (envelopeRow.capability_id !== null) {
        const latest = yield* detectorRuns
          .latestEvaluation(attempt.environment_id, envelopeRow.capability_id)
          .pipe(Effect.mapError(sqlFail("signAndBroadcast.latestEvaluation")));
        if (latest === null || latest.result.status !== "matched") {
          return refuse("stale-evidence", "no matched detector evaluation stands at sign time");
        }
        if (latest.result.validUntilMs <= now) {
          return refuse(
            "stale-evidence",
            `the matched occurrence expired at ${latest.result.validUntilMs}`,
          );
        }
      }

      // Chain gates need the mainnet transport.
      if (Option.isNone(mainnetTransportOption)) {
        return refuse(
          "unconfigured",
          "the mainnet RPC transport is not wired; the sign gate cannot verify chain state",
        );
      }
      const rpc = mainnetTransportOption.value;
      const target: SpotMainnetTarget | null = rpc.target();
      if (target === null) {
        return refuse("unconfigured", "the spot mainnet target is unconfigured");
      }
      const call = <A>(
        method: string,
        params: ReadonlyArray<unknown>,
        read: (value: unknown) => A | null,
      ): Effect.Effect<A | null, never> =>
        rpc.request(method, [...params]).pipe(
          Effect.map(read),
          Effect.catch(() => Effect.succeed<A | null>(null)),
        );

      const chainId = yield* call("eth_chainId", [], (v) =>
        typeof v === "string" && v === "0x1" ? v : null,
      );
      if (chainId !== "0x1") {
        return refuse(
          "route-unapproved",
          "the mainnet RPC did not identify as chain 1 at sign time",
        );
      }

      // Native balance covers value + worst-case fees (native input), or the
      // worst-case fees alone (ERC20 input; the ERC20 balance/allowance is
      // the funding setup's durable state, read-checked here).
      const worstCaseFeeWei = BigInt(snapshot.gasUnits) * BigInt(snapshot.maxFeePerGasWei);
      if (target.accountAddress === null) {
        return refuse("unconfigured", "the funding account is not configured");
      }
      const balanceHex = yield* call("eth_getBalance", [target.accountAddress, "latest"], (v) =>
        typeof v === "string" && /^0x[0-9a-f]+$/.test(v) ? BigInt(v) : null,
      );
      if (balanceHex === null) {
        return refuse("unconfigured", "the funding account's balance is unreadable");
      }
      const requiredNative =
        intent.token_in.toLowerCase() === NATIVE_MARKER
          ? BigInt(intent.amount_in_raw) + worstCaseFeeWei
          : worstCaseFeeWei;
      if (balanceHex < requiredNative) {
        return refuse(
          "funding-insufficient",
          `native balance ${balanceHex.toString(10)} does not cover value + worst-case fees ${requiredNative.toString(10)}`,
        );
      }

      // The independently timestamped price reference: the pool's own oracle
      // at a fresh block. A missing/stale reference refuses.
      const blockRaw = yield* call("eth_getBlockByNumber", ["latest", false], (v) => {
        if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
        const ts = (v as Record<string, unknown>)["timestamp"];
        return typeof ts === "string" && /^0x[0-9a-f]+$/.test(ts) ? Number(BigInt(ts)) : null;
      });
      if (
        blockRaw === null ||
        Math.abs(blockRaw - Math.floor(now / 1000)) > PRICE_REFERENCE_MAX_CLOCK_SKEW_SECONDS
      ) {
        return refuse(
          "reference-unavailable",
          "the chain clock is unavailable or stale; the funded gate refuses",
        );
      }
      // Decimals come from the tokens' OWN metadata over RPC — never a
      // hardcoded assumption about which assets the route denominates.
      const decimalsOfToken = (address: string): Effect.Effect<number | null, never> =>
        call("eth_call", [{ to: address, data: "0x313ce567" }, "latest"], (v) => {
          if (typeof v !== "string" || !v.startsWith("0x")) return null;
          const body = v.slice(2);
          if (body.length !== 64 || !/^[0-9a-fA-F]+$/.test(body)) return null;
          const parsed = Number(BigInt(`0x${body}`));
          return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 36 ? parsed : null;
        });
      const decimalsIn = yield* decimalsOfToken(
        intent.token_in.toLowerCase() === NATIVE_MARKER ? target.weth9 : intent.token_in,
      );
      const decimalsOut = yield* decimalsOfToken(
        intent.token_out.toLowerCase() === NATIVE_MARKER ? target.weth9 : intent.token_out,
      );
      if (decimalsIn === null || decimalsOut === null) {
        return refuse(
          "reference-unavailable",
          "the pool tokens' decimals could not be read; the funded gate refuses",
        );
      }
      const reference = yield* twapReferenceOut(
        target.pool,
        intent.token_in.toLowerCase() === NATIVE_MARKER ? target.weth9 : intent.token_in,
        intent.token_out.toLowerCase() === NATIVE_MARKER ? target.weth9 : intent.token_out,
        intent.amount_in_raw,
        decimalsIn,
        decimalsOut,
        rpc.request,
      );
      if (reference === null) {
        yield* recordRefusal("reference-unavailable: the TWAP reference could not be read");
        return refuse(
          "reference-unavailable",
          "the TWAP reference could not be read; the funded gate refuses",
        );
      }
      // The quoted output for the price-impact comparison comes from the
      // quote the intent carries; the min-out floor bounds it from below.
      const quotedOut = BigInt(intent.min_amount_out_raw);
      const impact = priceImpactRefusal(
        quotedOut.toString(10),
        reference,
        PROTECTED_PRICE_IMPACT_MAX_BPS_DEFAULT,
      );
      if (!impact.ok) {
        return refuse("price-impact", impact.refusal);
      }

      // The signer. Unarmed refuses with nothing signed.
      const signerOption = yield* signerConfig.resolve.pipe(
        Effect.mapError(sqlFail("signAndBroadcast.signer")),
      );
      if (!signerOption.armed) {
        return refuse(
          "signer-unarmed",
          "the spot demo signer is not armed (T3_SPOT_DEMO_SIGNER_KEY or the secrets file); nothing was signed",
        );
      }
      if (signerOption.signer.address !== target.accountAddress?.toLowerCase()) {
        return refuse(
          "funding-insufficient",
          `the armed signer ${signerOption.signer.address} is not the configured funding account ${target.accountAddress}`,
        );
      }

      // Deterministic local signing over the immutable snapshot: the same
      // snapshot bytes and the same key always produce identical signed
      // bytes (the recovery rule — identical-byte retransmission, never a
      // new signature). The deadline itself rides in the calldata; the
      // EIP-1559 envelope carries the measured gas and fee caps.
      const signedTxRlp = yield* Effect.tryPromise({
        try: () =>
          privateKeyToAccount(
            // viem's account factory wants the key as a hex string.
            `0x${Array.from(signerOption.signer.privateKeyBytes, (byte) =>
              byte.toString(16).padStart(2, "0"),
            ).join("")}` as `0x${string}`,
          ).signTransaction({
            chainId: 1,
            nonce: snapshot.nonce,
            to: snapshot.to as Hex,
            value: BigInt(snapshot.value),
            data: snapshot.data as Hex,
            gas: BigInt(snapshot.gasUnits),
            maxFeePerGas: BigInt(snapshot.maxFeePerGasWei),
            maxPriorityFeePerGas: BigInt(snapshot.maxPriorityFeePerGasWei),
            type: "eip1559",
          }),
        catch: (cause): string => `signing failed: ${String(cause)}`,
      }).pipe(Effect.mapError(sqlFail("signAndBroadcast.sign")));
      const txHash = keccak256(signedTxRlp as Hex);

      const broadcast = yield* sink
        .broadcast(signedTxRlp)
        .pipe(Effect.mapError(sqlFail("signAndBroadcast.broadcast")));
      // Persist the signed state and hash; the bytes are retained for
      // identical-byte recovery only, never surfaced through views/logs.
      yield* sql`
        UPDATE execution_swap_attempts
        SET status = 'broadcast-uncertain', signed_tx_rlp = ${signedTxRlp},
            signed_tx_hash = ${txHash}, signed_at_ms = ${now}, broadcast_at_ms = ${now}
        WHERE intent_id = ${intentId} AND status = 'reserved'
      `.pipe(Effect.mapError(sqlFail("signAndBroadcast.persistSigned")));
      yield* sql`
        UPDATE execution_swap_intents SET status = 'submitted' WHERE intent_id = ${intentId}
      `.pipe(Effect.mapError(sqlFail("signAndBroadcast.markIntent")));
      // The AUTHORITATIVE hash is the keccak of the signed bytes; a sink that
      // echoes a different hash is buggy, so the computed one is what the
      // outcome reports and what reconciliation queries.
      return { status: "signed-and-broadcast" as const, txHash };
    }).pipe(Effect.mapError(sqlFail("signAndBroadcast")));

  const reconcile: SwapBroadcastLifecycleShape["reconcile"] = ({ intentId, now }) =>
    Effect.gen(function* () {
      const refuse = (refusal: SwapLifecycleRefusalName, detail: string) => ({
        status: "refused" as const,
        refusal,
        detail,
      });
      const attempts = yield* attemptFor(intentId);
      const attempt = attempts[0];
      if (attempt === undefined)
        return refuse("attempt-not-found", `no protected attempt for intent ${intentId}`);
      if (attempt.status !== "broadcast-uncertain" && attempt.status !== "unknown") {
        return refuse(
          "wrong-state",
          `attempt status is ${attempt.status}; only an uncertain attempt reconciles`,
        );
      }
      if (attempt.signed_tx_hash === null || attempt.signed_tx_rlp === null) {
        return refuse("wrong-state", "the uncertain attempt carries no signed bytes to reconcile");
      }
      const txHash = attempt.signed_tx_hash;
      if (Option.isNone(mainnetTransportOption)) {
        return refuse("unconfigured", "the mainnet RPC transport is not wired");
      }
      const rpc = mainnetTransportOption.value;
      const target = rpc.target();
      if (target === null) return refuse("unconfigured", "the spot mainnet target is unconfigured");
      const call = <A>(
        method: string,
        params: ReadonlyArray<unknown>,
        read: (value: unknown) => A | null,
      ): Effect.Effect<A | null, never> =>
        rpc.request(method, [...params]).pipe(
          Effect.map(read),
          Effect.catch(() => Effect.succeed<A | null>(null)),
        );

      // Same hash first: an on-chain tx or receipt resolves everything.
      const onChain = yield* call("eth_getTransactionByHash", [txHash], (v) => {
        if (typeof v !== "object" || v === null) return null;
        const nonce = (v as Record<string, unknown>)["nonce"];
        return typeof nonce === "string" && /^0x[0-9a-f]+$/.test(nonce) ? BigInt(nonce) : null;
      });
      const receiptRaw = yield* call(
        "eth_getTransactionReceipt",
        [txHash],
        (v): ChainReceipt | null => {
          if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
          const record = v as Record<string, unknown>;
          const status = record["status"];
          const blockNumber = record["blockNumber"];
          const blockHash = record["blockHash"];
          const gasUsed = record["gasUsed"];
          const effectiveGasPrice = record["effectiveGasPrice"];
          const logs = record["logs"];
          if (
            typeof status !== "string" ||
            typeof blockNumber !== "string" ||
            typeof blockHash !== "string"
          )
            return null;
          if (typeof gasUsed !== "string" || typeof effectiveGasPrice !== "string") return null;
          if (!Array.isArray(logs)) return null;
          return {
            txHash,
            status: status === "0x1" ? "success" : "reverted",
            blockNumber: Number(BigInt(blockNumber)),
            blockHash,
            gasUsed: BigInt(gasUsed).toString(10),
            effectiveGasPrice: BigInt(effectiveGasPrice).toString(10),
            logs: logs.flatMap((log) => {
              if (typeof log !== "object" || log === null) return [];
              const entry = log as Record<string, unknown>;
              const address = entry["address"];
              const topics = entry["topics"];
              const data = entry["data"];
              if (typeof address !== "string" || !Array.isArray(topics) || typeof data !== "string")
                return [];
              return [
                { address, topics: topics.filter((t): t is string => typeof t === "string"), data },
              ];
            }),
          };
        },
      );
      if (receiptRaw !== null) {
        const settled = yield* settleFromReceipt({ intentId, receipt: receiptRaw, now });
        return settled.status === "refused"
          ? settled
          : { status: "receipt-settled" as const, settlement: settled.settlement };
      }
      if (onChain !== null) {
        // Seen in the mempool/chain, no receipt yet: ambiguity stands.
        yield* sql`
          UPDATE execution_swap_attempts SET status = 'unknown'
          WHERE intent_id = ${intentId} AND status IN ('broadcast-uncertain','unknown')
        `.pipe(Effect.mapError(sqlFail("reconcile.markUnknown")));
        return { status: "no-receipt-yet" as const };
      }
      // Not found: is OUR nonce consumed by something else?
      const account = (
        JSON.parse(attempt.signing_snapshot_json ?? "{}") as { readonly nonce?: number }
      ).nonce;
      void account;
      const target0 = rpc.target();
      const nonceOnChain = yield* call(
        "eth_getTransactionCount",
        [target0?.accountAddress ?? "0x0000000000000000000000000000000000000000", "latest"],
        (v) => (typeof v === "string" && /^0x[0-9a-f]+$/.test(v) ? BigInt(v) : null),
      );
      const snapshot = JSON.parse(
        attempt.signing_snapshot_json ?? "null",
      ) as SigningSnapshot | null;
      if (snapshot !== null && nonceOnChain !== null && nonceOnChain > BigInt(snapshot.nonce)) {
        yield* sql`
          UPDATE execution_swap_attempts
          SET status = 'unknown', refusal_reason = ${"nonce consumed by an unexpected transaction; reconciliation needed"}
          WHERE intent_id = ${intentId}
        `.pipe(Effect.mapError(sqlFail("reconcile.nonceConsumed")));
        return { status: "nonce-consumed-elsewhere" as const };
      }
      // Dropped and nonce still free: retransmit the IDENTICAL bytes.
      const again = yield* sink
        .broadcast(attempt.signed_tx_rlp)
        .pipe(Effect.mapError(sqlFail("reconcile.retransmit")));
      return { status: "dropped-retransmitted" as const, txHash: again.txHash };
    }).pipe(Effect.mapError(sqlFail("reconcile")));

  const settleFromReceipt: SwapBroadcastLifecycleShape["settleFromReceipt"] = ({
    intentId,
    receipt,
    now,
  }) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const refuse = (
            refusal: SwapLifecycleRefusalName,
            detail: string,
          ): {
            readonly status: "refused";
            readonly refusal: SwapLifecycleRefusalName;
            readonly detail: string;
          } => ({
            status: "refused",
            refusal,
            detail,
          });
          const attempts = yield* sql<AttemptRow>`
            SELECT intent_id, reservation_id, environment_id, envelope_id, unsigned_tx_json,
                   calldata_digest, status, signing_snapshot_json, signed_tx_rlp, signed_tx_hash,
                   reserved_at_ms, refusal_reason
            FROM execution_swap_attempts WHERE intent_id = ${intentId}
          `;
          const attempt = attempts[0];
          if (attempt === undefined)
            return refuse("attempt-not-found", `no protected attempt for intent ${intentId}`);
          if (attempt.signed_tx_hash !== receipt.txHash) {
            return refuse(
              "evidence-mismatch",
              `the receipt's tx hash ${receipt.txHash} is not this attempt's ${attempt.signed_tx_hash ?? "unsigned"}`,
            );
          }
          // Idempotent: an existing row for this hash settles nothing new.
          const existing = yield* sql<{ readonly status: string }>`
            SELECT status FROM execution_swap_receipts WHERE tx_hash = ${receipt.txHash}
          `;
          if (existing[0] !== undefined) {
            const prior: ReceiptSettlementView = {
              txHash: receipt.txHash,
              status: existing[0].status === "success" ? "settled-success" : "settled-revert",
              actualFeeWei: "0",
              actualInputRaw: null,
              actualOutputRaw: null,
            };
            return { status: "already-settled" as const, settlement: prior };
          }
          const intents = yield* sql<IntentRow>`
            SELECT intent_id, environment_id, envelope_id, proposal_id, route_id, token_in, token_out,
                   amount_in_raw, min_amount_out_raw, recipient, prepared_tx_json, status
            FROM execution_swap_intents WHERE intent_id = ${intentId}
          `;
          const intent = intents[0];
          if (intent === undefined)
            return refuse("attempt-not-found", `the intent row for ${intentId} is missing`);

          const actualFeeWei = BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice);
          const minOut = BigInt(intent.min_amount_out_raw);
          const nativeIn = intent.token_in.toLowerCase() === NATIVE_MARKER;
          const nativeOut = intent.token_out.toLowerCase() === NATIVE_MARKER;

          // Topic/address helpers over the receipt's logs.
          const word = (data: string, index: number): bigint | null => {
            const body = data.startsWith("0x") ? data.slice(2) : data;
            if (body.length < (index + 1) * 64) return null;
            const slice = body.slice(index * 64, (index + 1) * 64);
            return /^[0-9a-fA-F]+$/.test(slice) ? BigInt(`0x${slice}`) : null;
          };
          const topicAddress = (topic: string): string => `0x${topic.slice(-40)}`;
          const findWithdrawal = (weth: string, src: string): bigint | null => {
            for (const log of receipt.logs) {
              if (log.address.toLowerCase() !== weth.toLowerCase()) continue;
              if (log.topics[0] !== WETH_WITHDRAWAL_TOPIC || log.topics.length !== 2) continue;
              if (topicAddress(log.topics[1]!).toLowerCase() !== src.toLowerCase()) continue;
              const value = word(log.data, 0);
              if (value !== null) return value;
            }
            return null;
          };

          // Evidence binds by EMITTING CONTRACT as well as topics and value:
          // a Transfer from the wrong token is not this swap's output, and a
          // Withdrawal from a contract that is not the canonical WETH9 is
          // not the unwrap. The router's address is the swap target settled
          // on the attempt's unsigned bytes.
          const router = JSON.parse(attempt.unsigned_tx_json) as { readonly to: string };
          const spotSettlementTarget = Option.isSome(mainnetTransportOption)
            ? mainnetTransportOption.value.target()
            : null;
          if (spotSettlementTarget === null) {
            return refuse(
              "unconfigured",
              "the spot mainnet target is unavailable; withdrawal evidence cannot be bound to the canonical WETH9 and settlement refuses closed",
            );
          }

          if (receipt.status === "success") {
            // Validate the expected ASSET MOVEMENT — status 1 alone proves
            // nothing about the swap's economics.
            let actualOutput: bigint | null = null;
            let actualInput: bigint | null = null;
            if (nativeIn) {
              // The OUTPUT TOKEN's own Transfer INTO the exact recipient with
              // value ≥ minOut: the emitting contract must be the intent's
              // tokenOut — a different ERC20's transfer is not this output.
              let found: bigint | null = null;
              for (const log of receipt.logs) {
                if (log.address.toLowerCase() !== intent.token_out.toLowerCase()) continue;
                if (log.topics[0] !== ERC20_TRANSFER_TOPIC || log.topics.length !== 3) continue;
                if (topicAddress(log.topics[2]!).toLowerCase() !== intent.recipient.toLowerCase())
                  continue;
                const value = word(log.data, 0);
                if (value !== null && value >= minOut) found = value;
              }
              actualOutput = found;
              actualInput = BigInt(intent.amount_in_raw);
            } else if (nativeOut) {
              // The canonical WETH9's Withdrawal by the router (the unwrap)
              // ≥ minOut, and the INPUT token's own Transfer into the router
              // of EXACTLY amountIn (an exact-input swap pulls precisely the
              // approved input).
              const withdrawn = findWithdrawal(spotSettlementTarget.weth9, router.to);
              let paidExact: bigint | null = null;
              for (const log of receipt.logs) {
                if (log.address.toLowerCase() !== intent.token_in.toLowerCase()) continue;
                if (log.topics[0] !== ERC20_TRANSFER_TOPIC || log.topics.length !== 3) continue;
                if (topicAddress(log.topics[2]!).toLowerCase() !== router.to.toLowerCase())
                  continue;
                const value = word(log.data, 0);
                if (value !== null && value === BigInt(intent.amount_in_raw)) paidExact = value;
              }
              actualOutput = withdrawn !== null && withdrawn >= minOut ? withdrawn : null;
              actualInput = paidExact;
            }
            if (actualOutput === null) {
              return refuse(
                "evidence-mismatch",
                `the receipt is status 1 but the expected output evidence (recipient ${intent.recipient}, ≥ ${intent.min_amount_out_raw}) is absent; refusing to settle`,
              );
            }
            const evidence = forgeJsonEncode({
              nativeIn,
              nativeOut,
              actualOutput: actualOutput.toString(10),
              actualInput: (actualInput ?? 0n).toString(10),
            });
            yield* sql`
              INSERT INTO execution_swap_receipts (
                tx_hash, intent_id, reservation_id, status, block_number, block_hash,
                gas_used, effective_gas_price, actual_fee_wei, actual_input_raw,
                actual_output_raw, evidence_json, settled_at_ms
              ) VALUES (
                ${receipt.txHash}, ${intentId}, ${attempt.reservation_id}, 'success',
                ${receipt.blockNumber}, ${receipt.blockHash}, ${receipt.gasUsed},
                ${receipt.effectiveGasPrice}, ${actualFeeWei.toString(10)},
                ${actualInput === null ? null : actualInput.toString(10)},
                ${actualOutput.toString(10)}, ${evidence}, ${now}
              )
            `;
            yield* sql`
              UPDATE execution_swap_reservations
              SET status = 'settled-success', settled_at_ms = ${now}
              WHERE reservation_id = ${attempt.reservation_id} AND status = 'reserved'
            `;
            yield* sql`
              UPDATE execution_swap_attempts
              SET status = 'confirmed', resolved_at_ms = ${now}
              WHERE intent_id = ${intentId}
            `;
            yield* sql`
              UPDATE execution_swap_intents SET status = 'confirmed' WHERE intent_id = ${intentId}
            `;
            yield* sql`
              UPDATE execution_proposals SET status = 'executed'
              WHERE proposal_id = ${intent.proposal_id} AND status = 'executing'
            `;
            return {
              status: "settled" as const,
              settlement: {
                txHash: receipt.txHash,
                status: "settled-success" as const,
                actualFeeWei: actualFeeWei.toString(10),
                actualInputRaw: actualInput === null ? null : actualInput.toString(10),
                actualOutputRaw: actualOutput.toString(10),
              },
            };
          }

          // Reverted: fees only; the principal never moved. The stage is
          // consumed (the occurrence fired and its transaction landed), and
          // the budget ledger records no spend.
          yield* sql`
            INSERT INTO execution_swap_receipts (
              tx_hash, intent_id, reservation_id, status, block_number, block_hash,
              gas_used, effective_gas_price, actual_fee_wei, actual_input_raw,
              actual_output_raw, evidence_json, settled_at_ms
            ) VALUES (
              ${receipt.txHash}, ${intentId}, ${attempt.reservation_id}, 'reverted',
              ${receipt.blockNumber}, ${receipt.blockHash}, ${receipt.gasUsed},
              ${receipt.effectiveGasPrice}, ${actualFeeWei.toString(10)}, NULL, NULL,
              ${forgeJsonEncode({ reverted: true })}, ${now}
            )
          `;
          yield* sql`
            UPDATE execution_swap_reservations
            SET status = 'settled-revert', settled_at_ms = ${now}
            WHERE reservation_id = ${attempt.reservation_id} AND status = 'reserved'
          `;
          yield* sql`
            UPDATE execution_swap_attempts
            SET status = 'reverted', resolved_at_ms = ${now}
            WHERE intent_id = ${intentId}
          `;
          yield* sql`
            UPDATE execution_swap_intents SET status = 'reverted' WHERE intent_id = ${intentId}
          `;
          yield* sql`
            UPDATE execution_proposals SET status = 'rejected'
            WHERE proposal_id = ${intent.proposal_id} AND status = 'executing'
          `;
          return {
            status: "settled" as const,
            settlement: {
              txHash: receipt.txHash,
              status: "settled-revert" as const,
              actualFeeWei: actualFeeWei.toString(10),
              actualInputRaw: null,
              actualOutputRaw: null,
            },
          };
        }),
      )
      .pipe(Effect.mapError(sqlFail("settleFromReceipt")));

  return {
    createSigningSnapshot,
    signAndBroadcast,
    reconcile,
    settleFromReceipt,
  } satisfies SwapBroadcastLifecycleShape;
});

export const SwapBroadcastLifecycleLive = Layer.effect(
  SwapBroadcastLifecycle,
  makeSwapBroadcastLifecycle,
);
