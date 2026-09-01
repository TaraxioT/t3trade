/**
 * Diorama event bus: the single typed semantic input seam for the scene.
 * Stories, the director, and (in a future cycle) a validated product bridge
 * dispatch here; systems/sceneBindings.ts is the only semantic consumer.
 * Owner: bus lane (freeze §3, addendum §A).
 *
 * Contract: a strictly typed discriminated union on `type` — no unknown, no
 * open string maps, no product imports. Delivery is synchronous and ordered;
 * listeners are snapshotted before iteration so (un)subscribing during a
 * dispatch never affects the in-flight pass; one failing listener is isolated
 * (warned, skipped) so later listeners still run. A listener that dispatches
 * re-entrantly does not recurse: the nested event is queued and drained after
 * the current snapshot completes, preserving global dispatch order in
 * delivery and in history. The bus is inert after destroy. `history()` is a
 * read-only debug accessor for the `__dioramaDebug` QA seam — it exposes no
 * way to mutate bus state.
 */

/**
 * Exact mission status union shown on MISSION and the HUD (freeze §2;
 * addendum §A.1 adds "Agent unavailable" for product union completeness).
 */
export type MissionStatus =
  | "Initializing"
  | "Analysing"
  | "Waiting"
  | "Executing"
  | "Position open"
  | "Paused"
  | "Blocked"
  | "Revoked"
  | "Completed"
  | "Agent unavailable";

/** Why a mission is blocked; mirrors the product's refusal reasons. */
export type BlockedReason =
  | "cumulative_loss_limit"
  | "protection_failure"
  | "wake_budget_exhausted";

/**
 * Execution-record progression. Deliberately `diorama.*`: the product exposes
 * these as execution-record state, not as an orchestration event.
 */
export type ExecutionStatus =
  | "previewed"
  | "reserved"
  | "signed"
  | "submitted"
  | "accepted"
  | "filled"
  | "rejected"
  | "cancelled"
  | "failed";

/**
 * Documented rejection reasons carried on `diorama.execution-status` when
 * status is "rejected" (addendum §A.4). The event field itself stays
 * `reason?: string` so product-forward reasons still type; bindings map the
 * documented values to product-true sentences and guard scans.
 */
export type ExecutionRejectionReason =
  | "cumulative_loss_limit"
  | "protection_failure"
  | "wake_budget_exhausted"
  | "stop_required";

/** Mission reconcile triggers; the product also refetches manually. */
export type ReconcileTrigger =
  | "server_startup"
  | "websocket_reconnect"
  | "before_execution"
  | "after_submission"
  | "after_fill"
  | "after_position_update"
  | "before_resuming_paused_mission"
  | "periodic_while_position_open";

export type AccountInvalidatedReason = `reconcile:${ReconcileTrigger}` | "reconcile:manual";

/**
 * Lifecycle controls are status transitions; risk controls reach exchange
 * state. The separation is product-significant, so they are distinct events.
 */
export type MissionControl =
  | "trading.mission.pause"
  | "trading.mission.resume"
  | "trading.mission.revoke";

export type RiskControl =
  | "cancel_entries"
  | "reduce_position"
  | "close_position"
  | "close_and_revoke";

export type ReductionPercent = 25 | 50 | 75 | 100;

/** Scene-safe protection state carried by account-view-refetched. */
export type ProtectionState = "resting_on_exchange" | "server_executed" | "unprotected";

/** Simulated tool-port health, matching the MCP hub's retained port states. */
export type ToolHealth = "green" | "amber" | "red";

export type DioramaEvent =
  | { type: "trading.mission-create-requested"; missionId: string; market?: string }
  | { type: "trading.mission-run-started"; cause: string }
  | {
      type: "trading.mission-status-changed";
      status: MissionStatus;
      blockedReason?: BlockedReason;
    }
  | { type: "trading.execution-requested"; market: string; side: "buy" | "sell"; size: string }
  | { type: "trading.order-place-requested"; market: string }
  | { type: "trading.mission-watch-registered"; watchId: string; asset: string }
  | { type: "trading.mission-watch-cancelled"; watchId: string }
  | { type: "trading.mission-watch-fired"; watchId: string }
  | { type: "trading.mission-control-requested"; control: MissionControl }
  /**
   * Discriminated pair (addendum §A.3): reduce_position REQUIRES its percent;
   * every other control carries no reductionPercent.
   */
  | {
      type: "trading.mission-risk-control-requested";
      control: Exclude<RiskControl, "reduce_position">;
    }
  | {
      type: "trading.mission-risk-control-requested";
      control: "reduce_position";
      reductionPercent: ReductionPercent;
    }
  | {
      type: "diorama.execution-status";
      status: ExecutionStatus;
      /**
       * Populated on "rejected": product-true guard/ticket reason. Documented
       * values (ExecutionRejectionReason): "cumulative_loss_limit" |
       * "protection_failure" | "wake_budget_exhausted" | "stop_required".
       */
      reason?: string;
    }
  | { type: "diorama.account-invalidated"; reason: AccountInvalidatedReason }
  | {
      type: "diorama.account-view-refetched";
      market: string;
      hasPosition: boolean;
      protection: ProtectionState;
    }
  | { type: "diorama.tool-health-changed"; port: number; health: ToolHealth }
  | { type: "diorama.archive-health-changed"; healthy: boolean }
  | { type: "diorama.market-regime-changed"; regime: string };

export type DioramaEventListener = (event: DioramaEvent) => void;

/** Read-only history entry; `t` is a monotonic performance.now() ms stamp. */
export interface DioramaHistoryEntry {
  event: DioramaEvent;
  t: number;
}

/** Cap so a long-lived session cannot grow the debug trail without bound. */
export const EVENT_HISTORY_CAP = 100;

export interface DioramaEventBus {
  dispatch(event: DioramaEvent): void;
  /** Returns an unsubscribe function; subscribing after destroy is a no-op. */
  subscribe(listener: DioramaEventListener): () => void;
  lastEvent(): DioramaEvent | null;
  /** Copy of the recent trail, oldest first, capped at EVENT_HISTORY_CAP. */
  history(): DioramaHistoryEntry[];
  destroy(): void;
}

export function createEventBus(): DioramaEventBus {
  const listeners = new Set<DioramaEventListener>();
  const trail: DioramaHistoryEntry[] = [];
  /** Re-entrant dispatches, drained after the current snapshot completes. */
  const queued: DioramaEvent[] = [];
  let last: DioramaEvent | null = null;
  let destroyed = false;
  let delivering = false;

  /** Record into the debug trail in global dispatch order. */
  function record(event: DioramaEvent): void {
    last = event;
    trail.push({ event, t: performance.now() });
    if (trail.length > EVENT_HISTORY_CAP) trail.shift();
  }

  /** Deliver one event to the current listener snapshot; failures isolate. */
  function deliver(event: DioramaEvent): void {
    // Snapshot before iteration: a listener that (un)subscribes during
    // delivery changes only future passes, never the in-flight one.
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (error) {
        console.warn("[diorama] event listener failed", error);
      }
    }
  }

  return {
    dispatch(event: DioramaEvent): void {
      if (destroyed) return;
      // Events are immutable by convention; the trail keeps the dispatched
      // reference so QA can correlate history entries with delivery.
      if (delivering) {
        queued.push(event);
        return;
      }
      delivering = true;
      try {
        record(event);
        deliver(event);
        // Drain re-entrant dispatches breadth-first so delivery order equals
        // global dispatch order. A drain-phase dispatch joins the queue.
        while (queued.length > 0 && !destroyed) {
          const next = queued.shift();
          if (next === undefined) break;
          record(next);
          deliver(next);
        }
        queued.length = 0;
      } finally {
        delivering = false;
      }
    },
    subscribe(listener: DioramaEventListener): () => void {
      if (destroyed) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    lastEvent(): DioramaEvent | null {
      return destroyed ? null : last;
    },
    history(): DioramaHistoryEntry[] {
      return destroyed ? [] : [...trail];
    },
    destroy(): void {
      destroyed = true;
      listeners.clear();
      trail.length = 0;
      queued.length = 0;
      last = null;
    },
  };
}
