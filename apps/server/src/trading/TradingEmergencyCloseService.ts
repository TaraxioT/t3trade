/**
 * TradingEmergencyCloseService — the bounded emergency close (§17.5).
 *
 * Invoked when full protection cannot be confirmed inside the reconciliation
 * window. §17.5 is emphatic that this is "a deterministic safety action, not a
 * strategy decision": it runs without the harness, in a fixed order, a fixed
 * number of times, and it never waits for anyone to wake up and help.
 *
 * The order is the specification, and each step exists because of the failure
 * it prevents:
 *
 *   1. Mark the mission blocked and block all position increases — otherwise
 *      the thing being unwound can grow while it is being unwound.
 *   2. Cancel mission-owned non-reduce-only orders — a resting entry that
 *      fills mid-close re-opens the exposure just closed. Reduce-only orders
 *      are deliberately left alone: they are the protection.
 *   3. Read fresh canonical position and BBO — the size closed must be the
 *      size that exists now, not the size that existed when the trouble
 *      started.
 *   4. Submit a reduce-only marketable IOC for that size.
 *   5. Reconcile fills and the remaining position.
 *   6. Retry with a FRESH read and the REMAINING size, at most three attempts
 *      in total. An IOC fills what it can and cancels the rest, so a partial
 *      close is the expected case, not an error.
 *   7. If a position still remains: keep the mission blocked, preserve
 *      whatever protection can be placed, and report the exact remaining size
 *      and reason.
 *
 * The bound is what makes this safe to run deterministically. An unbounded
 * retry loop against a market that will not take the size is a way to keep
 * paying fees forever; three attempts and an honest "here is what is left" is
 * the behaviour §17.5 asks for.
 *
 * @module TradingEmergencyCloseService
 */
import { Context, Effect, Schema } from "effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { HyperliquidGateway } from "@t3tools/hyperliquid";
import { HyperliquidInfoClient } from "@t3tools/hyperliquid/InfoClient";
import { PROTECTION_SIZE_EPSILON } from "@t3tools/trading-contracts/protection";

import { HyperliquidExecutionService } from "./HyperliquidExecutionService.ts";
import { cancelOrdersBestEffort, readRestingIncreasingOrders } from "./RestingIncreasingOrders.ts";
import { HyperliquidReconciler } from "./HyperliquidReconciler.ts";
import { TradingMissionService } from "./TradingMissionService.ts";

/** §17.5: at most three bounded attempts. */
export const EMERGENCY_CLOSE_MAXIMUM_ATTEMPTS = 3;

/** What the emergency close is being asked to unwind. */
export interface EmergencyCloseInput {
  readonly missionId: string;
  /** The master-wallet address (§10.6) — canonical reads use it. */
  readonly masterAddress: string;
  readonly market: string;
  /** Why the close was triggered, carried into the user-facing notification. */
  readonly reason: string;
}

/**
 * How the procedure ended. A narrow three-way union (06C): flat is only ever
 * claimed from a canonical read, an unknown outcome never carries a numeric
 * size, and a last-known size is never presented as current.
 *
 * RC03 adds two typed facts alongside the prose: whether the mission-block
 * write was confirmed, and how many increasing-order cancellations remain
 * unconfirmed. Both survive flat, open, and unknown results — a close that
 * flattened the position while its entry cancellations or its block write
 * stayed unconfirmed is a different outcome than a clean one, and callers
 * must not parse the notice to tell them apart.
 */
export type EmergencyCloseOutcome =
  /** A canonical read confirmed flat. */
  | {
      readonly flat: true;
      readonly remainingSize: 0;
      /** How many of the three attempts were used. */
      readonly attempts: number;
      /** Carried only when a side effect (e.g. entry cancellation) is unconfirmed. */
      readonly failureNotice?: string | undefined;
      /** Whether the §17.5 mission-block write was confirmed (RC03). */
      readonly blockWriteConfirmed: boolean;
      /** Increasing-order cancellations the exchange did not confirm (RC03). */
      readonly unconfirmedCancellations: ReadonlyArray<{
        readonly cloid: string;
        readonly reason: string;
      }>;
    }
  /** A canonical read confirmed the position is still open. */
  | {
      readonly flat: false;
      /** Signed size still open, from a canonical read. */
      readonly remainingSize: number;
      readonly attempts: number;
      readonly failureNotice: string;
      readonly blockWriteConfirmed: boolean;
      readonly unconfirmedCancellations: ReadonlyArray<{
        readonly cloid: string;
        readonly reason: string;
      }>;
    }
  /** The canonical size could not be confirmed; a submitted order may have executed. */
  | {
      readonly flat: false;
      /** Unknown is null, never a guessed number. */
      readonly remainingSize: null;
      readonly attempts: number;
      readonly failureNotice: string;
      readonly blockWriteConfirmed: boolean;
      readonly unconfirmedCancellations: ReadonlyArray<{
        readonly cloid: string;
        readonly reason: string;
      }>;
    };

/**
 * The one rendering of an emergency-close result every caller shares (RC04).
 * Flat says flat; open carries the signed remaining size; unknown carries no
 * number; and the block-write/cancellation warnings ride along even on a flat
 * outcome — the open/unknown notices already embed them (RC03), and a flat
 * notice prefixes its own fact to the warnings the outcome carries.
 */
export const describeEmergencyCloseOutcome = (
  market: string,
  outcome: EmergencyCloseOutcome,
): string => {
  if (!outcome.flat) return outcome.failureNotice;
  const flat = `Emergency close flattened ${market}.`;
  return outcome.failureNotice === undefined ? flat : `${flat} ${outcome.failureNotice}`;
};

/**
 * The emergency close. One entry point, deterministic, harness-free.
 */
export class TradingEmergencyCloseService extends Context.Service<
  TradingEmergencyCloseService,
  {
    readonly emergencyClose: (
      input: EmergencyCloseInput,
    ) => Effect.Effect<
      EmergencyCloseOutcome,
      never,
      SqlClient.SqlClient | HyperliquidGateway | HyperliquidInfoClient
    >;
  }
>()("t3/trading/TradingEmergencyCloseService") {}

/** A fresh canonical read of what is left to close. */
interface RemainingPosition {
  readonly size: number;
  readonly markPrice: number;
}

/**
 * A canonical account read failed inside the emergency procedure. Internal
 * only: the public API stays never-error, but the failure is caught at read
 * boundaries and answered with the explicit unknown outcome, never with a
 * fabricated flat or a stale size (06C).
 */
class EmergencyReadFailure extends Schema.TaggedErrorClass<EmergencyReadFailure>()(
  "EmergencyReadFailure",
  {
    phase: Schema.String,
    cause: Schema.String,
  },
) {
  override get message(): string {
    return `${this.phase}: canonical account read failed: ${this.cause}`;
  }
}

/** What the notices say about the mission block — only claimed when its write succeeded. */
const blockSentence = (blockWriteFailed: boolean): string =>
  blockWriteFailed
    ? "The mission block was attempted but could not be confirmed."
    : "The mission stays blocked.";

/**
 * The unconfirmed-cancellation warning (RC03): discovery failure and
 * individual acknowledgement failure carry the same weight, and both survive
 * every close outcome.
 */
const cancellationWarningText = (cancellation: {
  readonly discoveryFailed: boolean;
  readonly unconfirmed: ReadonlyArray<{ readonly cloid: string; readonly reason: string }>;
}): string => {
  if (cancellation.discoveryFailed) {
    return (
      " Increasing-order cancellation was unconfirmed: the resting-order read failed, " +
      "so resting entries may reopen exposure."
    );
  }
  if (cancellation.unconfirmed.length === 0) return "";
  const cloids = cancellation.unconfirmed.map((entry) => entry.cloid).join(", ");
  return (
    ` Increasing-order cancellation was unconfirmed for ${cancellation.unconfirmed.length} ` +
    `order(s) (${cloids}); resting entries may reopen exposure.`
  );
};

export const makeTradingEmergencyCloseService = Effect.gen(function* () {
  const execution = yield* HyperliquidExecutionService;
  const reconciler = yield* HyperliquidReconciler;
  const missions = yield* TradingMissionService;

  /** §17.5 step 3: fresh canonical position + BBO, every attempt. */
  const readRemaining = (
    input: EmergencyCloseInput,
  ): Effect.Effect<RemainingPosition, EmergencyReadFailure, HyperliquidGateway> =>
    Effect.gen(function* () {
      const gateway = yield* HyperliquidGateway;
      const snapshot = yield* gateway.getAccountSnapshot(input.masterAddress as `0x${string}`).pipe(
        Effect.mapError(
          (cause) =>
            new EmergencyReadFailure({
              phase: "emergency close",
              cause: cause instanceof Error ? cause.message : String(cause),
            }),
        ),
      );
      const position = snapshot.positions.find((p) => p.market === input.market);
      if (position === undefined || position.size === 0) {
        return { size: 0, markPrice: 0 };
      }
      const book = yield* gateway.getOrderBook(input.market).pipe(
        Effect.map((b) => b.bestBidOffer),
        Effect.orElseSucceed(() => undefined),
      );
      // Price the IOC off the side it will cross. Falling back to the entry
      // price keeps the attempt possible when the book read fails; the IOC's
      // own slippage allowance is what makes it marketable either way.
      const crossing =
        position.size > 0 ? (book?.bidPrice ?? undefined) : (book?.askPrice ?? undefined);
      return { size: position.size, markPrice: crossing ?? position.entryPrice };
    });

  /**
   * §17.5 step 2: cancel mission-owned orders that could INCREASE the
   * position — the shared read + best-effort cancel in
   * `RestingIncreasingOrders`. Reduce-only orders stay: they are the
   * protection, and cancelling them is the opposite of what a safety action
   * should do. A failed discovery read never degrades to "nothing to cancel":
   * the close still proceeds (risk reduction must not die on a SQL error),
   * but the outcome carries an explicit warning that increasing-order
   * cancellation was unconfirmed — resting entries may reopen exposure (06C).
   * RC03: individual cancellation failures ride along with the same weight as
   * the discovery failure.
   */
  const cancelIncreasingOrders = (
    input: EmergencyCloseInput,
  ): Effect.Effect<
    {
      readonly discoveryFailed: boolean;
      readonly unconfirmed: ReadonlyArray<{ readonly cloid: string; readonly reason: string }>;
    },
    never,
    SqlClient.SqlClient
  > =>
    Effect.gen(function* () {
      const discovered = yield* readRestingIncreasingOrders(input.missionId).pipe(Effect.result);
      if (Result.isFailure(discovered)) {
        yield* Effect.logWarning(
          "emergency close: increasing-order cancellation unconfirmed: the resting-order read failed",
          { missionId: input.missionId, cause: String(discovered.failure) },
        );
        return { discoveryFailed: true, unconfirmed: [] };
      }
      const report = yield* cancelOrdersBestEffort({
        orders: discovered.success,
        logContext: "emergency close",
      }).pipe(Effect.provideService(HyperliquidExecutionService, execution));
      return { discoveryFailed: false, unconfirmed: report.unconfirmed };
    });

  const emergencyClose: TradingEmergencyCloseService["Service"]["emergencyClose"] = (input) =>
    Effect.gen(function* () {
      yield* Effect.logError("trading emergency close: starting", {
        missionId: input.missionId,
        reason: input.reason,
      });

      // --- §17.5 step 1: block the mission and every position increase ------
      //
      // First, before anything is cancelled or closed. A failure to record the
      // block does not stop the close — leaving exposure open because a status
      // write failed would be the worse outcome — but it is logged loudly and
      // remembered, so the notice never claims "the mission stays blocked" as
      // established fact (06C).
      let blockWriteFailed = false;
      yield* Effect.gen(function* () {
        const expectedVersion = yield* missions.getMissionVersion(input.missionId);
        yield* missions.transition({
          missionId: input.missionId,
          to: "blocked",
          expectedVersion,
          blockedReason: "protection_failure",
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            blockWriteFailed = true;
            yield* Effect.logError("emergency close: could not mark the mission blocked", {
              missionId: input.missionId,
              cause: String(cause),
            });
          }),
        ),
      );

      // --- §17.5 step 2: cancel what could grow the position ----------------
      const cancellation = yield* cancelIncreasingOrders(input);
      const cancelWarning = cancellationWarningText(cancellation);

      // --- §17.5 steps 3–6: up to three bounded attempts --------------------
      // Read boundaries catch a failed canonical read and answer with the
      // explicit unknown outcome: no numeric size, no fabricated flat, no
      // retry on a stale size (06C).
      const initialRead = yield* readRemaining(input).pipe(Effect.result);
      if (Result.isFailure(initialRead)) {
        yield* Effect.logError("trading emergency close: outcome unknown", {
          missionId: input.missionId,
          phase: "initial read",
          cause: initialRead.failure.cause,
        });
        return {
          flat: false,
          remainingSize: null,
          attempts: 0,
          failureNotice:
            `Emergency close outcome unknown for ${input.market}: the canonical position could ` +
            `not be read, so no order was submitted. ${blockSentence(blockWriteFailed)}` +
            ` Reason: ${input.reason}.${cancelWarning}`,
          blockWriteConfirmed: !blockWriteFailed,
          unconfirmedCancellations: cancellation.unconfirmed,
        } satisfies EmergencyCloseOutcome;
      }
      let remaining = initialRead.success;
      let attempts = 0;
      let readFailed: EmergencyReadFailure | null = null;

      while (
        readFailed === null &&
        Math.abs(remaining.size) > PROTECTION_SIZE_EPSILON &&
        attempts < EMERGENCY_CLOSE_MAXIMUM_ATTEMPTS
      ) {
        attempts++;

        yield* Effect.logWarning("trading emergency close: attempt", {
          missionId: input.missionId,
          attempt: attempts,
          size: remaining.size,
        });

        // §17.5 step 4: reduce-only marketable IOC for the size that exists
        // right now. A failed attempt does not abort the procedure — the fresh
        // read at the top of the next iteration is what decides whether there
        // is still work to do.
        yield* execution
          .submitReduceOnlyIoc({
            missionId: input.missionId,
            market: input.market,
            positionSize: remaining.size,
            referencePrice: remaining.markPrice,
            attempt: attempts,
          })
          .pipe(
            Effect.catchTag("TradingExecutionError", (cause) =>
              Effect.logWarning(
                `emergency close: attempt ${attempts} did not submit: ${cause.message}`,
              ).pipe(Effect.as([])),
            ),
          );

        // §17.5 step 5: reconcile fills and the remaining position.
        yield* reconciler
          .reconcile(
            {
              missionId: input.missionId,
              masterAddress: input.masterAddress,
              market: input.market,
            },
            "after_position_update",
          )
          .pipe(Effect.catch(() => Effect.void));

        // §17.5 step 6: a FRESH read and the REMAINING size. An IOC fills what
        // it can and cancels the rest, so a partial close is expected here. A
        // failed read here stops the procedure: the submitted order's effect
        // is unknown, and resubmitting against the pre-submit size would
        // double-close.
        const reread = yield* readRemaining(input).pipe(Effect.result);
        if (Result.isFailure(reread)) {
          readFailed = reread.failure;
          break;
        }
        remaining = reread.success;
      }

      if (readFailed !== null) {
        yield* Effect.logError("trading emergency close: outcome unknown", {
          missionId: input.missionId,
          phase: "post-submit read",
          attempts,
          cause: readFailed.cause,
        });
        return {
          flat: false,
          remainingSize: null,
          attempts,
          failureNotice:
            `Emergency close outcome unknown for ${input.market}: an order may have executed ` +
            `and the position could not be confirmed after ${attempts} attempt(s). ` +
            `${blockSentence(blockWriteFailed)} Reason: ${input.reason}.${cancelWarning}`,
          blockWriteConfirmed: !blockWriteFailed,
          unconfirmedCancellations: cancellation.unconfirmed,
        } satisfies EmergencyCloseOutcome;
      }

      if (Math.abs(remaining.size) <= PROTECTION_SIZE_EPSILON) {
        yield* Effect.logInfo("trading emergency close: flat", {
          missionId: input.missionId,
          attempts,
        });
        // RC03: a flat position does not retire the other two uncertainties.
        // A close that flattened while its block write or an entry
        // cancellation stayed unconfirmed is a different outcome than a clean
        // one, and the notice must say so rather than report only the flat.
        const flatWarnings = [
          ...(blockWriteFailed ? [blockSentence(true)] : []),
          ...(cancelWarning === "" ? [] : [cancelWarning.trim()]),
        ];
        return {
          flat: true,
          remainingSize: 0,
          attempts,
          ...(flatWarnings.length === 0 ? {} : { failureNotice: flatWarnings.join(" ") }),
          blockWriteConfirmed: !blockWriteFailed,
          unconfirmedCancellations: cancellation.unconfirmed,
        } satisfies EmergencyCloseOutcome;
      }

      // --- §17.5 step 7: still exposed. Stay blocked, say exactly what is left
      const failureNotice =
        `Emergency close did not flatten ${input.market}: ${remaining.size} remains after ` +
        `${attempts} attempts. ${blockSentence(blockWriteFailed)} Reason: ${input.reason}` +
        cancelWarning;
      yield* Effect.logError("trading emergency close: position remains", {
        missionId: input.missionId,
        remainingSize: remaining.size,
        attempts,
        reason: input.reason,
      });

      return {
        flat: false,
        remainingSize: remaining.size,
        attempts,
        failureNotice,
        blockWriteConfirmed: !blockWriteFailed,
        unconfirmedCancellations: cancellation.unconfirmed,
      } satisfies EmergencyCloseOutcome;
    });

  return TradingEmergencyCloseService.of({ emergencyClose });
});

export const TradingEmergencyCloseServiceLive = Layer.effect(
  TradingEmergencyCloseService,
  makeTradingEmergencyCloseService,
);
