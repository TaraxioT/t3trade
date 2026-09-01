/**
 * Simulated campus state: statuses, budgets, health, mission phase. A single
 * observable store the director mutates and the UI reads. Owner: director
 * worker.
 *
 * The frozen CampusState fields are the UI contract; the mutation helpers are
 * the director's write surface so state changes always notify subscribers.
 */
import type { DioramaContext } from "../core/context.js";

export type PortHealth = "green" | "amber" | "red";

/** Number of MCP tool ports shown on the hub and health console. */
export const MCP_PORT_COUNT = 8;

export interface CampusState {
  missionPhase: string;
  lossAllowancePct: number;
  paused: boolean;
  mcpPortHealth: PortHealth[];
  lastRefusal: string;
}

export interface Simulation {
  state: CampusState;
  subscribe(fn: (state: CampusState) => void): () => void;
  /** Consume percentage points of the loss allowance reservoir. */
  consumeLoss(pct: number): void;
  /** Consume a fraction of the tool spend reservoir (0..1). */
  consumeTools(fraction: number): void;
  setPortHealth(port: number, health: PortHealth): void;
  setPhase(phase: string): void;
  setPaused(paused: boolean): void;
  refuse(reason: string): void;
}

export function createSimulation(ctx: DioramaContext): Simulation {
  void ctx; // simulation is pure state; no rendering depends on the context

  const state: CampusState = {
    missionPhase: "Waiting",
    lossAllowancePct: 82,
    paused: false,
    mcpPortHealth: Array.from({ length: MCP_PORT_COUNT }, () => "green" as PortHealth),
    lastRefusal: "LOSS BUDGET SPENT",
  };

  const subscribers = new Set<(state: CampusState) => void>();

  /** Shallow snapshot so subscribers never mutate the live state. */
  const snapshot = (): CampusState => ({
    ...state,
    mcpPortHealth: [...state.mcpPortHealth],
  });

  const notify = (): void => {
    const snap = snapshot();
    for (const fn of subscribers) fn(snap);
  };

  const clampPct = (v: number): number => Math.max(0, Math.min(100, v));

  return {
    state,
    subscribe(fn: (state: CampusState) => void): () => void {
      subscribers.add(fn);
      fn(snapshot());
      return () => {
        subscribers.delete(fn);
      };
    },
    consumeLoss(pct: number): void {
      state.lossAllowancePct = clampPct(state.lossAllowancePct - pct);
      notify();
    },
    consumeTools(fraction: number): void {
      // Tool spend has no frozen display field yet; modeled as a no-op until
      // the UI exposes it. The BudgetMeter station animates its own reservoirs.
      void fraction;
    },
    setPortHealth(port: number, health: PortHealth): void {
      if (port < 0 || port >= state.mcpPortHealth.length) return;
      if (state.mcpPortHealth[port] === health) return;
      state.mcpPortHealth[port] = health;
      notify();
    },
    setPhase(phase: string): void {
      if (state.missionPhase === phase) return;
      state.missionPhase = phase;
      notify();
    },
    setPaused(paused: boolean): void {
      if (state.paused === paused) return;
      state.paused = paused;
      notify();
    },
    refuse(reason: string): void {
      state.lastRefusal = reason.toUpperCase();
      notify();
    },
  };
}
