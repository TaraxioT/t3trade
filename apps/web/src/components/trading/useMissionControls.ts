/**
 * Binds one mission to the §14.7 control dispatchers.
 *
 * Per-mission rather than per-surface so a control's busy state belongs to the
 * mission it acts on, and a press on one mission cannot grey out another's way
 * out. Both dispatchers go straight to the server: §14.7's controls must work
 * while the harness is offline, so nothing here consults a session, a lease, or
 * a turn.
 *
 * The hook is shared because the strip now renders in two places — the
 * workspace list and the bound thread — and a second copy of this wiring would
 * be a second chance to get the busy semantics wrong.
 *
 * RC06: a dispatched command only proves the request was accepted. The
 * mission's `lastControlResult` — written by the reactor after the exchange
 * work finished, failed, or could not be confirmed — is what closes the loop,
 * and `resolveControlOutcome` is the derivation that decides whether it
 * answers THIS press, an older press, or nobody.
 *
 * @module useMissionControls
 */
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  OrchestrationTradingMission,
  TradingReductionPercent,
  TradingRiskControl,
} from "@t3tools/contracts";
import { useCallback, useState } from "react";

import { refreshTradingMissions } from "../../lib/tradingMissionsState";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useAtomCommand } from "../../state/use-atom-command";

export interface MissionControls {
  readonly isBusy: boolean;
  /**
   * Why the last command failed, or null. A pause that does not pause is the
   * one outcome the operator must not have to infer from a status that did
   * not move: `void send()` swallowed the rejection entirely, so a revoke refused
   * by the domain looked exactly like a revoke still in flight.
   */
  readonly error: string | null;
  /** The correlated outcome of the last risk-control press (RC06). */
  readonly outcome: ControlOutcomeView;
  readonly lifecycle: (
    type: "trading.mission.pause" | "trading.mission.resume" | "trading.mission.revoke",
  ) => void;
  readonly risk: (control: TradingRiskControl, reductionPercent?: TradingReductionPercent) => void;
}

/** What a §14.7 press is showing: nothing, in flight, or its durable result (RC06). */
export type ControlOutcomeView =
  | { readonly state: "idle" }
  | { readonly state: "pending"; readonly control: TradingRiskControl }
  | { readonly state: "interrupted"; readonly control: TradingRiskControl }
  | {
      readonly state: "result";
      readonly control: TradingRiskControl;
      readonly status: "completed" | "failed" | "unknown";
      readonly summary: string;
    };

/** A press whose result never landed stops waiting after this and reads as interrupted. */
export const CONTROL_RESULT_TIMEOUT_MILLIS = 30_000;

/** The one line a failed control shows. Never empty: a blank error reads as none. */
export function describeControlFailure(result: AtomCommandResult<unknown, unknown>): string | null {
  if (result._tag !== "Failure") return null;
  // An interrupt is a navigation or an unmount, not a refusal.
  if (isAtomCommandInterrupted(result)) return null;

  const squashed = squashAtomCommandFailure(result);
  const message = squashed instanceof Error ? squashed.message : String(squashed);
  return message.trim().length === 0 ? "The command failed." : message;
}

/**
 * Whether the mission's latest durable control result answers this surface's
 * press (RC06). A result answers a press when it is the same control and it
 * happened at or after the press — an older result belongs to an earlier
 * press, and a newer result for a different control belongs to another
 * surface's press; neither may clear this one's pending state.
 */
export function resolveControlOutcome(input: {
  readonly pending: { readonly control: TradingRiskControl; readonly dispatchedAt: number } | null;
  readonly lastControlResult: OrchestrationTradingMission["lastControlResult"];
  readonly nowMillis: number;
}): ControlOutcomeView {
  if (input.pending === null) {
    // Without a press in flight the mission's latest result is still worth
    // showing — it is the durable record of what the last control did.
    if (input.lastControlResult !== null) {
      return {
        state: "result",
        control: input.lastControlResult.control,
        status: input.lastControlResult.status,
        summary: input.lastControlResult.summary,
      };
    }
    return { state: "idle" };
  }
  const result = input.lastControlResult;
  if (
    result !== null &&
    result.control === input.pending.control &&
    Date.parse(result.occurredAt) >= input.pending.dispatchedAt - 1_000
  ) {
    return {
      state: "result",
      control: result.control,
      status: result.status,
      summary: result.summary,
    };
  }
  if (input.nowMillis - input.pending.dispatchedAt > CONTROL_RESULT_TIMEOUT_MILLIS) {
    return { state: "interrupted", control: input.pending.control };
  }
  return { state: "pending", control: input.pending.control };
}

export function useMissionControls(
  mission: Pick<OrchestrationTradingMission, "id" | "threadId" | "lastControlResult">,
  environmentId: EnvironmentId,
): MissionControls {
  const dispatchLifecycle = useAtomCommand(orchestrationEnvironment.missionControl);
  const dispatchRisk = useAtomCommand(orchestrationEnvironment.riskControl);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{
    readonly control: TradingRiskControl;
    readonly dispatchedAt: number;
  } | null>(null);

  const outcome = resolveControlOutcome({
    pending,
    lastControlResult: mission.lastControlResult,
    nowMillis: Date.now(),
  });

  const run = useCallback(
    (send: () => Promise<AtomCommandResult<unknown, unknown>>) => {
      setIsBusy(true);
      setError(null);
      void send()
        .then((result) => {
          const failure = describeControlFailure(result);
          setError(failure);
          // The projection is pull-only and polls every 3s. Refreshing on the
          // way out is what makes a successful control land in under a second
          // instead of whenever the timer next fires.
          if (failure === null) refreshTradingMissions(environmentId);
        })
        .finally(() => setIsBusy(false));
    },
    [environmentId],
  );

  const lifecycle = useCallback<MissionControls["lifecycle"]>(
    (type) => {
      setPending(null);
      run(() =>
        dispatchLifecycle({
          environmentId,
          input: { type, threadId: mission.threadId, missionId: mission.id },
        }),
      );
    },
    [dispatchLifecycle, environmentId, mission.id, mission.threadId, run],
  );

  const risk = useCallback<MissionControls["risk"]>(
    (control, reductionPercent) => {
      // RC06: the accepted dispatch means the request landed, not that the
      // control ran. The pending marker stays until the correlated durable
      // result arrives (or times out as interrupted).
      setPending({ control, dispatchedAt: Date.now() });
      run(() =>
        dispatchRisk({
          environmentId,
          input: {
            threadId: mission.threadId,
            missionId: mission.id,
            control,
            ...(reductionPercent === undefined ? {} : { reductionPercent }),
          },
        }),
      );
    },
    [dispatchRisk, environmentId, mission.id, mission.threadId, run],
  );

  // The two dispatchers are memoized; the object around them deliberately is
  // not. Memoizing it over `isBusy` — a value that changes on every press —
  // bought nothing and made the dependency list read as though it did.
  return { isBusy, error, outcome, lifecycle, risk };
}
