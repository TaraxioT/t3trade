/**
 * TradingControlService — the §14.7 deterministic user-control API.
 *
 * Seven controls, one service, and one rule that shapes all of it: none of
 * them may require a harness turn. §14.7 puts it plainly — "their availability
 * does not depend on the bound harness being online". A user who wants out of
 * a position must be able to get out while the provider process is dead, the
 * session is unreachable, or the model is mid-thought.
 *
 * What that rules out is a specific temptation: routing these through the same
 * `trading_preview_order` checklist the harness uses. That checklist needs a
 * current strategy version, a matching authority version, and a harness run
 * holding the decision lease — three things that are absent precisely when
 * these buttons matter most. So the risk-reducing controls take the
 * preview-free reduce-only path instead (`submitReduceOnlyIoc`), which is safe
 * for a different reason: the exchange itself will not let a reduce-only order
 * open or extend a position.
 *
 * What is NOT bypassed is T3's safety boundary. §14.7: "The deterministic
 * buttons bypass discretionary harness reasoning — never T3's safety
 * boundary." Every control still goes through the signer, the nonce lane,
 * canonical reconciliation, and — where it matters most — the protection
 * reconciliation, so cancelling entries cannot strip a partial fill of its
 * stop.
 *
 * The §14.7 controls: pause, resume, cancelEntries, reducePosition
 * (25/50/75/100%), closePosition, revoke, closeAndRevoke — reached from the
 * workspace's buttons over WS RPC. No MCP tools carry these names: the
 * harness's own way out is `trading_exit`.
 *
 * @module TradingControlService
 */
import { Context, Effect, Schema } from "effect";
import * as Result from "effect/Result";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { HyperliquidGateway } from "@t3tools/hyperliquid";
import { HyperliquidInfoClient } from "@t3tools/hyperliquid/InfoClient";
import type { TradingOrderResult } from "@t3tools/trading-contracts/execution";
import { PROTECTION_SIZE_EPSILON } from "@t3tools/trading-contracts/protection";

import { HyperliquidExecutionService } from "./HyperliquidExecutionService.ts";
import { HyperliquidReconciler } from "./HyperliquidReconciler.ts";
import { cancelOrdersBestEffort, readRestingIncreasingOrders } from "./RestingIncreasingOrders.ts";
import { TradingMissionService } from "./TradingMissionService.ts";
import { TradingProtectionService } from "./TradingProtectionService.ts";

/** A deterministic control could not be carried out. */
export class TradingControlError extends Schema.TaggedErrorClass<TradingControlError>()(
  "TradingControlError",
  {
    reason: Schema.Literals([
      "mission_not_found",
      "transition_rejected",
      "exchange_action_failed",
      "reduction_percent_required",
    ]),
    detail: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return `TradingControlError(${this.reason})${this.detail ? `: ${this.detail}` : ""}`;
  }
}

/** Every control names the mission it acts on. */
export interface ControlInput {
  readonly missionId: string;
}

/** A control that reaches the exchange also needs the canonical identity. */
export interface ExchangeControlInput extends ControlInput {
  readonly masterAddress: string;
  readonly market: string;
}

/**
 * What a submitted-but-unconfirmed close must say: an IOC may have executed,
 * so the only truthful report is that the outcome is unknown — never a
 * numeric size, "Already flat", or "Position closed" (prompt 06A).
 */
export const CLOSE_OUTCOME_UNKNOWN =
  "Close outcome unknown: an order may have executed; position could not be confirmed.";

/** What a control did. */
export interface ControlOutcome {
  /** The mission status after the control, when it changed one. */
  readonly status?: string | undefined;
  /**
   * Signed canonical position size after the control. `null` when a submitted
   * order's effect could not be confirmed — an unknown outcome is never
   * reported as a numeric (and especially never as zero) size.
   */
  readonly positionSize: number | null;
  /** Cloids the control cancelled. */
  readonly cancelledCloids: ReadonlyArray<string>;
  /** Human-readable summary for the workspace. */
  readonly summary: string;
}

/**
 * One held market's result in a mission finalization pass (RC01).
 */
export interface MissionFinalizationMarket {
  readonly market: string;
  /**
   * What the pass established: `flat` only from a canonical read, `remains`
   * with the confirmed signed size, `unknown` when a read could not confirm,
   * `failed` when the bounded close attempt itself failed, and `unprocessed`
   * when the market joined the mission during finalization.
   */
  readonly outcome: "flat" | "remains" | "unknown" | "failed" | "unprocessed";
  /** Signed canonical size; `null` when it could not be confirmed. */
  readonly positionSize: number | null;
  /** Why the market kept the authority, in the exchange's or error's own words. */
  readonly reason?: string;
}

/** What a mission-level close-and-finalize did (RC01). */
export interface MissionFinalizationOutcome {
  /**
   * The mission status this operation left, when it changed one: the single
   * terminal status when finalized, otherwise the entry-blocking status the
   * pass established. Undefined when the mission was left exactly as it was.
   */
  readonly status?: string | undefined;
  /** Whether the single terminal transition happened. */
  readonly finalized: boolean;
  readonly markets: ReadonlyArray<MissionFinalizationMarket>;
  /** Only cloids the exchange acknowledged as cancelled. */
  readonly cancelledCloids: ReadonlyArray<string>;
  /** Human-readable summary for the workspace. */
  readonly summary: string;
}

/**
 * The deterministic control service. Harness tools and workspace buttons
 * converge here (§14.7: "one control service, two entry points").
 */
export class TradingControlService extends Context.Service<
  TradingControlService,
  {
    /** Block new entries, scale-ins, reversals, and re-entry. Protection stays live. */
    readonly pause: (input: ControlInput) => Effect.Effect<ControlOutcome, TradingControlError>;

    /** Re-enable a paused mission. A blocked mission is not resumable here (§16.4). */
    readonly resume: (input: ControlInput) => Effect.Effect<ControlOutcome, TradingControlError>;

    /**
     * Cancel every resting position-increasing order, protecting any filled
     * slice first (§17.3). The position itself is left alone.
     */
    readonly cancelEntries: (
      input: ExchangeControlInput,
    ) => Effect.Effect<ControlOutcome, TradingControlError>;

    /** Reduce the canonical position by a percentage via a reduce-only IOC. */
    readonly reducePosition: (
      input: ExchangeControlInput & { readonly percent: number },
    ) => Effect.Effect<ControlOutcome, TradingControlError>;

    /** Close the canonical position entirely. */
    readonly closePosition: (
      input: ExchangeControlInput,
    ) => Effect.Effect<ControlOutcome, TradingControlError>;

    /** End autonomous authority permanently, preserving any valid protection. */
    readonly revoke: (input: ControlInput) => Effect.Effect<ControlOutcome, TradingControlError>;

    /**
     * Close every held market, then revoke — the one-click way out (RC01).
     *
     * Mission-level on purpose: a mission is every market it holds, and
     * authority ends exactly once, only after canonical flat is confirmed
     * across the whole held set and mission-owned increasing orders can no
     * longer reopen exposure. A failed or unknown market keeps the authority.
     */
    readonly closeAndRevokeMission: (
      input: ControlInput,
    ) => Effect.Effect<MissionFinalizationOutcome, TradingControlError>;

    /**
     * End a mission because its thread was settled or deleted (RC01).
     *
     * The same all-market finalization gate as {@link closeAndRevokeMission};
     * only the terminal status differs — the §11.1 completed-versus-revoked
     * rule: a mission that traded and was not blocked ends `completed`.
     */
    readonly endMissionForThreadEnding: (
      input: ControlInput,
    ) => Effect.Effect<MissionFinalizationOutcome, TradingControlError>;

    /**
     * Close or reduce a MANUAL position — the account-scoped §14.7 control
     * (final-form Phase 7). Same bounded reduce-only IOC loop as the mission
     * buttons, cloid in the manual namespace, no mission state touched.
     *
     * Refuses (in the outcome, so the panel shows the reason verbatim) when an
     * active mission holds the market: a mission-owned position's way out is
     * the mission's own controls, never this one.
     *
     * The caller runs the manual reconcile afterwards — this method moves the
     * exchange and reports canonical truth; converging the local rows is the
     * reconciler's job.
     */
    readonly closeManualPosition: (input: {
      readonly accountId: string;
      readonly masterAddress: string;
      readonly market: string;
      /** 25/50/75/100; omitted means a full close. */
      readonly percent?: number | undefined;
    }) => Effect.Effect<ManualCloseOutcome, TradingControlError>;
  }
>()("t3/trading/TradingControlService") {}

/** How an account-scoped manual close ended. */
export type ManualCloseOutcome =
  | {
      readonly outcome: "done";
      /** Signed canonical position size after the control. */
      readonly positionSize: number;
      readonly summary: string;
    }
  | { readonly outcome: "refused"; readonly reason: string; readonly detail: string };

/** How many reduce-only attempts one button press makes before reporting back. */
const REDUCTION_ATTEMPTS = 2;

/**
 * What the bounded reduce loop learned: either a confirmed canonical end
 * state, or — when a submitted order's effect could not be re-read — nothing
 * that may be narrated as a size (06A).
 */
type ReductionResult =
  | {
      readonly kind: "confirmed";
      /** Signed canonical size before the first submission (reduceLoop's own read). */
      readonly startingSize: number;
      readonly positionSize: number;
      readonly closedSize: number;
      readonly failureReason: string | null;
    }
  | { readonly kind: "unknown" };

/**
 * The truthful three-way close report (R2-2): what actually happened on the
 * exchange, not what was attempted. A close that filled nothing is a FAILURE
 * and says so, carrying the exchange's own rejection verbatim — the old
 * "Position partly closed" for an untouched position sent Round 2's operator
 * away believing the exit had half worked while the exchange had refused it
 * outright.
 */
export const describeCloseOutcome = (input: {
  readonly market: string;
  readonly positionSize: number;
  readonly closedSize: number;
  readonly failureReason: string | null;
}): string => {
  const remains = `${Math.abs(input.positionSize)} ${input.market} remains.`;
  const exchangeSaid = input.failureReason === null ? "" : ` Exchange said: ${input.failureReason}`;
  if (Math.abs(input.positionSize) <= PROTECTION_SIZE_EPSILON) return "Position closed.";
  if (input.closedSize <= PROTECTION_SIZE_EPSILON) {
    return `Close failed; nothing filled and ${remains}${exchangeSaid}`;
  }
  return `Position partly closed; ${remains}${exchangeSaid}`;
};

/** True when the position flipped side or grew in absolute size during a reduction (06D). */
export const reductionChangedDuring = (startingSize: number, positionSize: number): boolean => {
  const signChanged =
    Math.abs(startingSize) > PROTECTION_SIZE_EPSILON &&
    Math.abs(positionSize) > PROTECTION_SIZE_EPSILON &&
    Math.sign(startingSize) !== Math.sign(positionSize);
  return signChanged || Math.abs(positionSize) > Math.abs(startingSize) + PROTECTION_SIZE_EPSILON;
};

/**
 * The observed-reduction report (06D): the canonical NET position change the
 * exchange shows, never a fill attributed from the delta. Only a same-side
 * decrease (or a confirmed flat) earns a percentage — rounded to at most two
 * decimals; a sign change or grown exposure says the position changed and
 * names the confirmed current size instead.
 */
export const describeReductionOutcome = (input: {
  readonly market: string;
  readonly startingSize: number;
  readonly positionSize: number;
  readonly requestedPercent: number;
}): string => {
  if (reductionChangedDuring(input.startingSize, input.positionSize)) {
    return (
      `Position changed during reduction; confirm current position before retrying. ` +
      `Confirmed current position: ${input.positionSize} ${input.market}.`
    );
  }
  const start = Math.abs(input.startingSize);
  const observed =
    start <= PROTECTION_SIZE_EPSILON
      ? 0
      : Math.round(((start - Math.abs(input.positionSize)) / start) * 10_000) / 100;
  return (
    `Position size decreased by ${observed}% ` +
    `(${input.startingSize} to ${input.positionSize} ${input.market}); ` +
    `requested ${input.requestedPercent}%.`
  );
};

/**
 * The acknowledged-only entry-cancellation summary (RC03): all confirmed,
 * some confirmed, or none confirmed — never "cancelled N" for a batch whose
 * acknowledgements did not arrive.
 */
export const describeEntryCancellation = (
  requested: number,
  report: {
    readonly acknowledged: ReadonlyArray<string>;
    readonly unconfirmed: ReadonlyArray<{ readonly cloid: string; readonly reason: string }>;
  },
): string => {
  const confirmed = report.acknowledged.length;
  const unconfirmed = report.unconfirmed.length;
  if (unconfirmed === 0) return `Cancelled ${confirmed} resting entry order(s).`;
  if (confirmed > 0) {
    return (
      `Cancelled ${confirmed} of ${requested} resting entry order(s); ` +
      `${unconfirmed} could not be confirmed.`
    );
  }
  return `Cancellation was not confirmed for ${requested} resting entry order(s).`;
};

export const makeTradingControlService = Effect.gen(function* () {
  // SQL and the gateway are captured at layer build, not demanded per call.
  // §14.7's controls are invoked straight from a workspace button; making the
  // caller thread a database handle and an exchange reader in would put the
  // burden in exactly the wrong place.
  const sql = yield* SqlClient.SqlClient;
  const missions = yield* TradingMissionService;
  const execution = yield* HyperliquidExecutionService;
  const reconciler = yield* HyperliquidReconciler;
  const protection = yield* TradingProtectionService;
  const gateway = yield* HyperliquidGateway;
  const info = yield* HyperliquidInfoClient;

  /**
   * Reconcile with the captured services supplied, so a control's caller never
   * has to carry them. Failures are logged rather than raised: the canonical
   * re-read that follows is what decides the outcome, and a control that
   * already moved the position must report what it did.
   */
  const reconcileNow = (input: ExchangeControlInput) =>
    reconciler
      .reconcile(
        {
          missionId: input.missionId,
          masterAddress: input.masterAddress,
          market: input.market,
        },
        "after_position_update",
      )
      .pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.provideService(HyperliquidGateway, gateway),
        Effect.provideService(HyperliquidInfoClient, info),
        Effect.catch(() => Effect.void),
      );

  /**
   * Read the canonical position and the price a reduce-only exit would cross.
   *
   * A failed account read is a typed control failure, never a flat position:
   * swallowing it here is how a dead exchange read used to become "Already
   * flat." (06A). The book read keeps its best-effort fallback — a missing
   * crossing price only degrades the reference price, it does not misreport
   * exposure.
   */
  const readPosition = (input: ExchangeControlInput, operation: string) =>
    Effect.gen(function* () {
      const snapshot = yield* gateway.getAccountSnapshot(input.masterAddress as `0x${string}`).pipe(
        Effect.mapError(
          (cause) =>
            new TradingControlError({
              reason: "exchange_action_failed",
              detail: `${operation}: canonical account read failed: ${
                cause instanceof Error ? cause.message : String(cause)
              }`,
            }),
        ),
      );
      const position = snapshot.positions.find((p) => p.market === input.market);
      if (position === undefined || position.size === 0) return { size: 0, crossingPrice: 0 };

      const book = yield* gateway.getOrderBook(input.market).pipe(
        Effect.map((b) => b.bestBidOffer),
        Effect.orElseSucceed(() => undefined),
      );
      const crossing = position.size > 0 ? book?.bidPrice : book?.askPrice;
      return { size: position.size, crossingPrice: crossing ?? position.entryPrice };
    });

  const transitionTo = (
    missionId: string,
    to: "paused" | "analysing" | "revoked" | "completed",
  ): Effect.Effect<string, TradingControlError> =>
    Effect.gen(function* () {
      const expectedVersion = yield* missions.getMissionVersion(missionId);
      const updated = yield* missions.transition({ missionId, to, expectedVersion });
      return updated.status;
    }).pipe(
      Effect.mapError(
        (cause) =>
          new TradingControlError({
            reason: "transition_rejected",
            detail: cause instanceof Error ? cause.message : String(cause),
          }),
      ),
    );

  /**
   * The one bounded reduce loop: submit reduce-only IOCs until the target
   * size is gone or the attempts run out, re-reading canonical state between
   * attempts. The mission and manual lanes were two copies of this loop
   * differing only in which submit primitive they used and whether a
   * mission-scoped reconcile runs between attempts — so those two seams are
   * the parameters, and everything else is shared.
   *
   * Bounded for the same reason the emergency close is: an IOC fills what the
   * book will take and cancels the rest, so a button that loops until flat
   * could loop for a long time paying fees. Two attempts, then an honest
   * report of what is left.
   */
  const reduceLoop = (input: {
    readonly exchangeInput: ExchangeControlInput;
    readonly targetSize: number;
    readonly submit: (
      attempt: number,
      signedSize: number,
      referencePrice: number,
    ) => Effect.Effect<ReadonlyArray<TradingOrderResult>, TradingControlError>;
    /** Runs after each submit; the mission lane reconciles, the manual one waits on the reconciler's own cadence. */
    readonly betweenAttempts: Effect.Effect<void>;
    readonly logContext: string;
    /** Names the operation in read-failure details, e.g. "close position". */
    readonly readOperation: string;
  }): Effect.Effect<ReductionResult, TradingControlError> =>
    Effect.gen(function* () {
      let position = yield* readPosition(
        input.exchangeInput,
        `${input.readOperation} (initial read)`,
      );
      const signedStartingSize = position.size;
      const startingSize = Math.abs(position.size);
      let remainingToClose = Math.min(input.targetSize, startingSize);
      // The exchange's own words for the attempts that did not fill, so the
      // caller can report a close that closed nothing as the failure it is
      // (R2-2) instead of narrating success.
      const failureReasons: Array<string> = [];

      for (let attempt = 0; attempt < REDUCTION_ATTEMPTS; attempt++) {
        if (remainingToClose <= PROTECTION_SIZE_EPSILON) break;
        if (Math.abs(position.size) <= PROTECTION_SIZE_EPSILON) break;

        const signed = position.size > 0 ? remainingToClose : -remainingToClose;
        const results = yield* input.submit(attempt, signed, position.crossingPrice).pipe(
          Effect.tapError((cause) =>
            Effect.logWarning(
              `${input.logContext}: reduce attempt ${attempt} did not submit: ${cause.message}`,
            ),
          ),
          Effect.catch((cause) => {
            failureReasons.push(cause.detail ?? cause.message);
            return Effect.succeed([] as ReadonlyArray<TradingOrderResult>);
          }),
        );
        for (const row of results) {
          if (row.status === "error") {
            failureReasons.push(row.reason ?? "rejected without a reason");
          }
        }

        yield* input.betweenAttempts;

        // A submitted order's effect is decided by the re-read. When that read
        // fails the outcome is unknown: stop (never retry on a stale size) and
        // say so — no numeric size, no "closed", no "flat" (06A).
        const reread = yield* readPosition(
          input.exchangeInput,
          `${input.readOperation} (post-submit read)`,
        ).pipe(Effect.result);
        if (Result.isFailure(reread)) return { kind: "unknown" } as const;

        const before = Math.abs(position.size);
        position = reread.success;
        const closed = before - Math.abs(position.size);
        remainingToClose = Math.max(0, remainingToClose - closed);
      }

      return {
        kind: "confirmed" as const,
        startingSize: signedStartingSize,
        positionSize: position.size,
        closedSize: Math.max(0, startingSize - Math.abs(position.size)),
        /** The most recent rejection, verbatim; null when nothing was refused. */
        failureReason: failureReasons.at(-1) ?? null,
      };
    });

  /** The mission lane of {@link reduceLoop}. */
  const reduceBy = (input: ExchangeControlInput & { readonly targetSize: number }) =>
    reduceLoop({
      exchangeInput: input,
      targetSize: input.targetSize,
      submit: (attempt, signedSize, referencePrice) =>
        execution
          .submitReduceOnlyIoc({
            missionId: input.missionId,
            market: input.market,
            positionSize: signedSize,
            referencePrice,
            attempt,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new TradingControlError({
                  reason: "exchange_action_failed",
                  detail: cause.message,
                }),
            ),
          ),
      betweenAttempts: reconcileNow(input),
      logContext: "control",
      readOperation: "control reduce",
    });

  const pause: TradingControlService["Service"]["pause"] = (input) =>
    Effect.gen(function* () {
      const status = yield* transitionTo(input.missionId, "paused");
      // Deliberately does NOT touch resting protection. §14.7's paused card
      // says the stop stays live on-exchange, and it means it: pausing is
      // about not opening anything new, not about standing down the stop.
      return {
        status,
        positionSize: 0,
        cancelledCloids: [],
        summary: "Paused. New entries are blocked; protection stays live on-exchange.",
      } satisfies ControlOutcome;
    });

  const resume: TradingControlService["Service"]["resume"] = (input) =>
    Effect.gen(function* () {
      const status = yield* transitionTo(input.missionId, "analysing");
      return {
        status,
        positionSize: 0,
        cancelledCloids: [],
        summary: "Resumed.",
      } satisfies ControlOutcome;
    });

  const revoke: TradingControlService["Service"]["revoke"] = (input) =>
    Effect.gen(function* () {
      const status = yield* transitionTo(input.missionId, "revoked");
      // §14.6: revocation ends autonomous authority and preserves valid
      // protection if a position remains. Cancelling the stop here would end
      // the authority and the safety net in one move.
      return {
        status,
        positionSize: 0,
        cancelledCloids: [],
        summary: "Authority revoked. Any remaining protection stays live on-exchange.",
      } satisfies ControlOutcome;
    });

  const cancelEntries: TradingControlService["Service"]["cancelEntries"] = (input) =>
    Effect.gen(function* () {
      // The shared read in `RestingIncreasingOrders` — the same rows §16.4
      // exhaustion and the §17.5 emergency close cancel. A failed read stops
      // here: it must never be answered as "no entries" (06A).
      const increasing = yield* readRestingIncreasingOrders(input.missionId).pipe(
        Effect.mapError(
          (cause) =>
            new TradingControlError({
              reason: "exchange_action_failed",
              detail: `cancel entries: resting-order read failed: ${
                cause instanceof Error ? cause.message : String(cause)
              }`,
            }),
        ),
        Effect.provideService(SqlClient.SqlClient, sql),
      );
      if (increasing.length === 0) {
        const position = yield* readPosition(input, "cancel entries (position read)");
        return {
          positionSize: position.size,
          cancelledCloids: [],
          summary: "No resting entry orders to cancel.",
        } satisfies ControlOutcome;
      }

      // §17.3: protect the filled slice BEFORE cancelling, because a partial
      // parent's linked children are cancelled with it. The stop price comes
      // from the execution record the harness authorised, not from anything
      // the button supplies.
      const stopPrice = increasing.find((row) => row.stop_price !== null)?.stop_price ?? null;
      const cloids = increasing.map((row) => row.cloid);

      if (stopPrice === null) {
        // No recorded stop to reconcile against; cancel plainly. This is the
        // pre-Phase-5 record shape, not a new state. RC03: the acknowledged
        // count is what the exchange confirmed — a mixed or fully failed batch
        // says so instead of claiming every requested cloid.
        const report = yield* cancelOrdersBestEffort({
          orders: increasing,
          logContext: "cancel entries",
        }).pipe(Effect.provideService(HyperliquidExecutionService, execution));
        const position = yield* readPosition(input, "cancel entries (position read)");
        return {
          positionSize: position.size,
          cancelledCloids: report.acknowledged,
          summary: describeEntryCancellation(increasing.length, {
            acknowledged: report.acknowledged,
            unconfirmed: report.unconfirmed,
          }),
        } satisfies ControlOutcome;
      }

      const outcome = yield* protection
        .cancelEntriesWithProtection({
          missionId: input.missionId,
          executionSequence: 0,
          masterAddress: input.masterAddress,
          market: input.market,
          stopPrice,
          cloids,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new TradingControlError({
                reason: "exchange_action_failed",
                detail: cause.message,
              }),
          ),
        );

      if (outcome.status === "escalate") {
        return {
          positionSize: outcome.positionSize,
          cancelledCloids: [],
          summary: "Entry orders left in place: the filled size could not be protected first.",
        } satisfies ControlOutcome;
      }

      // RC03: the protection-aware branch reports the same acknowledged-only
      // truth. Protection was established first, so an unconfirmed cancel is a
      // still-resting entry — not an unprotected-exposure problem.
      const cancellation = outcome.entryCancellation;
      return {
        positionSize: outcome.positionSize,
        cancelledCloids: cancellation?.acknowledged ?? [],
        summary:
          cancellation === undefined
            ? "Cancelled entry orders; the filled size stays protected."
            : `${describeEntryCancellation(cancellation.acknowledged.length + cancellation.unconfirmed.length, cancellation)} The filled size stays protected.`,
      } satisfies ControlOutcome;
    });

  const reducePosition: TradingControlService["Service"]["reducePosition"] = (input) =>
    Effect.gen(function* () {
      const position = yield* readPosition(input, "reduce position (initial read)");
      if (Math.abs(position.size) <= PROTECTION_SIZE_EPSILON) {
        return {
          positionSize: 0,
          cancelledCloids: [],
          summary: "Already flat.",
        } satisfies ControlOutcome;
      }

      const targetSize = Math.abs(position.size) * (input.percent / 100);
      const reduced = yield* reduceBy({ ...input, targetSize });
      if (reduced.kind === "unknown") {
        return {
          positionSize: null,
          cancelledCloids: [],
          summary: CLOSE_OUTCOME_UNKNOWN,
        } satisfies ControlOutcome;
      }

      // Protection is sized to the position, so a smaller position needs a
      // smaller stop — and the old one is oversized until it is replaced.
      // Reduce-only protection cannot over-close, so this is a tidy-up rather
      // than a safety fix, but leaving it stale would misreport coverage.
      return {
        positionSize: reduced.positionSize,
        cancelledCloids: [],
        // 06D: the success line reports the OBSERVED canonical decrease, not
        // the requested percentage; a sign flip or grown exposure is narrated
        // as a changed position, never as an attributed fill.
        summary:
          reduced.closedSize <= PROTECTION_SIZE_EPSILON &&
          !reductionChangedDuring(reduced.startingSize, reduced.positionSize)
            ? `Reduce failed; nothing filled and ${Math.abs(reduced.positionSize)} ${input.market} remains.` +
              (reduced.failureReason === null ? "" : ` Exchange said: ${reduced.failureReason}`)
            : describeReductionOutcome({
                market: input.market,
                startingSize: reduced.startingSize,
                positionSize: reduced.positionSize,
                requestedPercent: input.percent,
              }),
      } satisfies ControlOutcome;
    });

  const closePosition: TradingControlService["Service"]["closePosition"] = (input) =>
    Effect.gen(function* () {
      const position = yield* readPosition(input, "close position (initial read)");
      if (Math.abs(position.size) <= PROTECTION_SIZE_EPSILON) {
        return {
          positionSize: 0,
          cancelledCloids: [],
          summary: "Already flat.",
        } satisfies ControlOutcome;
      }

      const closed = yield* reduceBy({ ...input, targetSize: Math.abs(position.size) });
      if (closed.kind === "unknown") {
        return {
          positionSize: null,
          cancelledCloids: [],
          summary: CLOSE_OUTCOME_UNKNOWN,
        } satisfies ControlOutcome;
      }
      return {
        positionSize: closed.positionSize,
        cancelledCloids: [],
        // Truthful three-way report (R2-2): closed, partly closed, or — when
        // nothing filled — a failure carrying the exchange's verbatim reason,
        // never "partly closed" for a position that did not move.
        summary: describeCloseOutcome({
          market: input.market,
          positionSize: closed.positionSize,
          closedSize: closed.closedSize,
          failureReason: closed.failureReason,
        }),
      } satisfies ControlOutcome;
    });

  /**
   * Statuses that already refuse new entries at the preview checklist, so a
   * finalization pass starting from one needs no additional guard write.
   * Pausing a `blocked` mission on top would erase its persisted reason, which
   * is why blocked is treated as already-guarded rather than re-paused.
   */
  const ENTRY_BLOCKED_STATUSES: ReadonlySet<string> = new Set([
    "paused",
    "blocked",
    "agent_unavailable",
  ]);

  /**
   * Whether the mission ever recorded a fill — the completed-versus-revoked
   * fact for thread ending (§11.1: a mission that never traded has no result
   * to report and is simply revoked).
   */
  const hasRealizedFills = (missionId: string) =>
    sql<{ fill_count: number }>`
      SELECT COUNT(*) AS fill_count FROM trading_fills WHERE mission_id = ${missionId}
    `.pipe(
      Effect.map((rows) => (rows[0]?.fill_count ?? 0) > 0),
      Effect.mapError(
        (cause) =>
          new TradingControlError({
            reason: "exchange_action_failed",
            detail: `finalize mission: fill-count read failed: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
          }),
      ),
    );

  /**
   * The truthful blocked-finalization summary (RC01): every non-flat market in
   * its own words, then why authority was kept. "Still open" is reserved for a
   * confirmed nonzero position; anything unconfirmed says so.
   */
  const summarizeBlockedFinalization = (
    markets: ReadonlyArray<MissionFinalizationMarket>,
    cancellationReason: string | null,
  ): string => {
    const parts = markets
      .filter((market) => market.outcome !== "flat")
      .map((market) => {
        switch (market.outcome) {
          case "remains":
            return `${market.market} is still open (${market.positionSize} ${market.market})`;
          case "unknown":
            return `${market.market} could not be confirmed`;
          case "failed":
            return `${market.market} close attempt failed${market.reason ? `: ${market.reason}` : ""}`;
          case "unprocessed":
            return `${market.market} was not processed (${market.reason ?? "joined during finalization"})`;
          default:
            return `${market.market}: ${market.outcome}`;
        }
      });
    if (cancellationReason !== null) {
      parts.push(`increasing-order cancellation is unconfirmed: ${cancellationReason}`);
    }
    const unconfirmed =
      cancellationReason !== null ||
      markets.some((market) => market.outcome !== "flat" && market.outcome !== "remains");
    const kept = unconfirmed ? "the position could not be confirmed" : "a position is still open";
    return `${parts.join("; ")}. Authority was not revoked because ${kept}.`;
  };

  /**
   * The one mission-level close-and-finalize (R1/RC01).
   *
   * Order of operations, each because of the failure it prevents:
   *
   *   1. Establish the entry block first, so what is being unwound cannot
   *      grow while it is unwound (existing lifecycle + checklist guard).
   *   2. Cancel mission-owned increasing orders before closing, so a resting
   *      entry cannot refill mid-close — with evidence: an unconfirmed
   *      cancellation is finalization-blocking, never rounded up to success.
   *   3. Attempt a bounded close on EVERY held market; one market's failure
   *      never stops the others.
   *   4. Immediately before the single terminal transition, re-resolve the
   *      held set and re-read canonical state per market: flat as observed at
   *      this final read is the gate — a new market, an unreadable market, or
   *      any confirmed nonzero position keeps the authority nonterminal.
   *   5. Transition exactly once.
   *
   * Cancellation evidence is honestly conservative until RC03 lands the typed
   * acknowledgement report: the void best-effort primitive can confirm
   * nothing, so any discovered resting order blocks terminal finalization.
   */
  const finalizeMission = (input: {
    readonly missionId: string;
    readonly terminal: "revoked" | "completed";
  }): Effect.Effect<MissionFinalizationOutcome, TradingControlError> =>
    Effect.gen(function* () {
      const mission = yield* missions.getMission(input.missionId).pipe(
        Effect.mapError(
          (cause) =>
            new TradingControlError({
              reason: "mission_not_found",
              detail: `finalize mission: ${cause instanceof Error ? cause.message : String(cause)}`,
            }),
        ),
      );

      // A repeated event must neither revoke twice nor submit close orders
      // under an authority that already ended.
      if (mission.status === "revoked" || mission.status === "completed") {
        return {
          status: mission.status,
          finalized: true,
          markets: [],
          cancelledCloids: [],
          summary: `Mission already ${mission.status}; nothing to finalize.`,
        } satisfies MissionFinalizationOutcome;
      }

      const masterAddress = yield* missions.getMasterWalletAddress(mission.tradingAccountId).pipe(
        Effect.mapError(
          (cause) =>
            new TradingControlError({
              reason: "mission_not_found",
              detail: `finalize mission: master wallet could not be resolved: ${
                cause instanceof Error ? cause.message : String(cause)
              }`,
            }),
        ),
      );

      // --- step 1: block new entries using the existing mechanisms ----------
      let guardedStatus: string | undefined;
      if (!ENTRY_BLOCKED_STATUSES.has(mission.status)) {
        // Failure to establish the block stops the finalization: unwinding a
        // position the mission may still increase is the race this gate is for.
        guardedStatus = yield* transitionTo(input.missionId, "paused");
      }

      // --- step 2: cancel what could reopen exposure, with evidence ---------
      // RC03: the typed acknowledgement report decides. Only an empty
      // unconfirmed list (with a successful discovery read) counts as
      // confirmed; any unconfirmed or undiscoverable resting increasing order
      // keeps the authority nonterminal, even with every position flat.
      let cancellationConfirmed = true;
      let cancellationReason: string | null = null;
      let acknowledgedCloids: ReadonlyArray<string> = [];
      const discovered = yield* readRestingIncreasingOrders(input.missionId).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.result,
      );
      if (Result.isFailure(discovered)) {
        cancellationConfirmed = false;
        cancellationReason =
          "the resting-order read failed, so resting entries may reopen exposure";
      } else if (discovered.success.length > 0) {
        const report = yield* cancelOrdersBestEffort({
          orders: discovered.success,
          logContext: "finalize mission",
        }).pipe(Effect.provideService(HyperliquidExecutionService, execution));
        acknowledgedCloids = report.acknowledged;
        if (report.unconfirmed.length > 0) {
          cancellationConfirmed = false;
          cancellationReason =
            `${report.unconfirmed.length} of ${discovered.success.length} resting increasing ` +
            `order(s) were not confirmed cancelled (${report.unconfirmed
              .map((entry) => entry.cloid)
              .join(", ")})`;
        }
      }

      // --- step 3: bounded close attempt on every held market ----------------
      const results = new Map<string, MissionFinalizationMarket>();
      for (const market of mission.markets) {
        const closed = yield* closePosition({
          missionId: input.missionId,
          masterAddress,
          market,
        }).pipe(Effect.result);
        if (Result.isFailure(closed)) {
          results.set(market, {
            market,
            outcome: "failed",
            positionSize: null,
            reason: closed.failure.detail ?? closed.failure.message,
          });
          continue;
        }
        const outcome = closed.success;
        if (outcome.positionSize === null) {
          results.set(market, {
            market,
            outcome: "unknown",
            positionSize: null,
            reason: outcome.summary,
          });
        } else if (Math.abs(outcome.positionSize) <= PROTECTION_SIZE_EPSILON) {
          results.set(market, { market, outcome: "flat", positionSize: 0 });
        } else {
          results.set(market, {
            market,
            outcome: "remains",
            positionSize: outcome.positionSize,
            reason: outcome.summary,
          });
        }
      }

      // --- step 4: fresh canonical confirmation across the current held set --
      const fresh = yield* missions.getMission(input.missionId).pipe(
        Effect.mapError(
          (cause) =>
            new TradingControlError({
              reason: "mission_not_found",
              detail: `finalize mission: held-set re-read failed: ${
                cause instanceof Error ? cause.message : String(cause)
              }`,
            }),
        ),
      );
      for (const market of fresh.markets) {
        if (!results.has(market)) {
          results.set(market, {
            market,
            outcome: "unprocessed",
            positionSize: null,
            reason: "the market joined the mission during finalization",
          });
          continue;
        }
        // The close pass's word is not the gate's word: a failed or unknown
        // close may actually have filled, and a close that reported flat may
        // have been refilled. The confirmation read decides.
        const position = yield* readPosition(
          { missionId: input.missionId, masterAddress, market },
          `finalize mission (confirmation read, ${market})`,
        ).pipe(Effect.result);
        if (Result.isFailure(position)) {
          results.set(market, {
            market,
            outcome: "unknown",
            positionSize: null,
            reason: "the confirmation read failed",
          });
          continue;
        }
        const size = position.success.size;
        if (Math.abs(size) > PROTECTION_SIZE_EPSILON) {
          results.set(market, {
            market,
            outcome: "remains",
            positionSize: size,
            reason: "a confirmed position remains after the bounded close",
          });
        } else {
          results.set(market, { market, outcome: "flat", positionSize: 0 });
        }
      }

      const marketResults = [...results.values()];
      const blocked =
        !cancellationConfirmed || marketResults.some((market) => market.outcome !== "flat");

      if (blocked) {
        return {
          ...(guardedStatus === undefined ? {} : { status: guardedStatus }),
          finalized: false,
          markets: marketResults,
          cancelledCloids: acknowledgedCloids,
          summary: summarizeBlockedFinalization(marketResults, cancellationReason),
        } satisfies MissionFinalizationOutcome;
      }

      // --- step 5: the single terminal transition ---------------------------
      const status = yield* transitionTo(input.missionId, input.terminal);
      return {
        status,
        finalized: true,
        markets: marketResults,
        cancelledCloids: acknowledgedCloids,
        summary:
          `All ${marketResults.length} held market(s) confirmed flat. ` +
          (input.terminal === "revoked" ? "Authority revoked." : "Mission completed."),
      } satisfies MissionFinalizationOutcome;
    });

  const closeAndRevokeMission: TradingControlService["Service"]["closeAndRevokeMission"] = (
    input,
  ) => finalizeMission({ missionId: input.missionId, terminal: "revoked" });

  const endMissionForThreadEnding: TradingControlService["Service"]["endMissionForThreadEnding"] = (
    input,
  ) =>
    Effect.gen(function* () {
      // The §11.1 completed-versus-revoked fact is captured BEFORE the
      // finalization pass: the pass may pause an active mission, and `blocked`
      // read after a pause would have erased the reason the rule asks about.
      const mission = yield* missions.getMission(input.missionId).pipe(
        Effect.mapError(
          (cause) =>
            new TradingControlError({
              reason: "mission_not_found",
              detail: `end mission for thread: ${cause instanceof Error ? cause.message : String(cause)}`,
            }),
        ),
      );
      const traded = yield* hasRealizedFills(input.missionId);
      const terminal =
        traded && mission.status !== "blocked" ? ("completed" as const) : ("revoked" as const);
      return yield* finalizeMission({ missionId: input.missionId, terminal });
    });

  const closeManualPosition: TradingControlService["Service"]["closeManualPosition"] = (input) =>
    Effect.gen(function* () {
      // D4: a mission-owned market's exits belong to the mission's controls.
      // The held-set table is the authority record since migration 079 — both
      // held primary and held secondary markets refuse — and a failed read is
      // a typed failure, never "nobody holds it" (06B).
      const owning = yield* sql<{ readonly mission_id: string; readonly status: string }>`
        SELECT m.mission_id, m.status
        FROM trading_mission_markets h
        JOIN trading_missions m ON m.mission_id = h.mission_id
        WHERE h.venue = 'hyperliquid' AND h.market = ${input.market}
          AND h.released_at IS NULL
          AND m.status NOT IN ('revoked', 'completed')
        LIMIT 1
      `.pipe(
        Effect.mapError(
          (cause) =>
            new TradingControlError({
              reason: "exchange_action_failed",
              detail: `manual close: held-market ownership read failed: ${
                cause instanceof Error ? cause.message : String(cause)
              }`,
            }),
        ),
      );
      const owner = owning[0];
      if (owner !== undefined) {
        return {
          outcome: "refused",
          reason: "market_owned_by_mission",
          detail:
            `mission ${owner.mission_id} (${owner.status}) holds the ${input.market} ` +
            "authority; use the mission's own controls to reduce or close it",
        } satisfies ManualCloseOutcome;
      }

      const exchangeInput = {
        missionId: "",
        masterAddress: input.masterAddress,
        market: input.market,
      };
      let position = yield* readPosition(exchangeInput, "manual close (initial read)");
      if (Math.abs(position.size) <= PROTECTION_SIZE_EPSILON) {
        return {
          outcome: "done",
          positionSize: 0,
          summary: "Already flat.",
        } satisfies ManualCloseOutcome;
      }

      const percent = input.percent ?? 100;
      const reduced = yield* reduceLoop({
        exchangeInput,
        targetSize: Math.abs(position.size) * (percent / 100),
        submit: (attempt, signedSize, referencePrice) =>
          execution
            .submitManualReduceOnlyIoc({
              accountId: input.accountId,
              market: input.market,
              positionSize: signedSize,
              referencePrice,
              attempt,
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new TradingControlError({
                    reason: "exchange_action_failed",
                    detail: cause.message,
                  }),
              ),
            ),
        // No mission to reconcile under; the account reconciler's own cadence
        // picks the fills up.
        betweenAttempts: Effect.void,
        logContext: "manual close",
        readOperation: "manual close",
      });
      if (reduced.kind === "unknown") {
        // The wire contract's done-variant carries a numeric size; an unknown
        // outcome has none, so it travels the existing typed error channel
        // rather than fabricating a number (06A).
        return yield* Effect.fail(
          new TradingControlError({
            reason: "exchange_action_failed",
            detail: CLOSE_OUTCOME_UNKNOWN,
          }),
        );
      }
      return {
        outcome: "done",
        positionSize: reduced.positionSize,
        // Truthful report (R2-2/06D): a partial reduce that filled reports the
        // OBSERVED canonical decrease with the requested percent alongside;
        // anything else — including a close that filled NOTHING — goes through
        // the shared three-way close description, exchange reason verbatim.
        summary:
          (percent !== 100 && reduced.closedSize > PROTECTION_SIZE_EPSILON) ||
          reductionChangedDuring(reduced.startingSize, reduced.positionSize)
            ? describeReductionOutcome({
                market: input.market,
                startingSize: reduced.startingSize,
                positionSize: reduced.positionSize,
                requestedPercent: percent,
              })
            : describeCloseOutcome({
                market: input.market,
                positionSize: reduced.positionSize,
                closedSize: reduced.closedSize,
                failureReason: reduced.failureReason,
              }),
      } satisfies ManualCloseOutcome;
    });

  return TradingControlService.of({
    pause,
    resume,
    cancelEntries,
    reducePosition,
    closePosition,
    revoke,
    closeAndRevokeMission,
    endMissionForThreadEnding,
    closeManualPosition,
  });
});

export const TradingControlServiceLive = Layer.effect(
  TradingControlService,
  makeTradingControlService,
);
