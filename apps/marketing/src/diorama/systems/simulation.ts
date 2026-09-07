/**
 * Simulated campus state: statuses, budgets, health, mission phase. The
 * scenario-owned mutable store: sceneBindings mirrors bus events into it and
 * any remaining reader may subscribe. Owner: bus lane.
 *
 * The simulation emits no bus events itself — mission status changes arrive
 * as dispatched events (freeze §8) and sceneBindings writes them back here.
 * The CampusState fields are the UI contract; the mutation helpers are the
 * write surface so state changes always notify subscribers.
 *
 * Loss budget units are pinned (addendum §B.7): the reservoir tracks CUMULATIVE
 * USED percentage POINTS on a 0..100 scale; the remaining projection is
 * clamp(1 - usedPoints/100) as a 0..1 fraction. There is NO rollover or
 * replenish: once used reaches 100 the budget stays exhausted until a new
 * mission create resets it to 0.
 */
import type { DioramaContext } from "../core/context.js";

export type PortHealth = "green" | "amber" | "red";

/** Number of MCP tool ports shown on the hub and health console. */
export const MCP_PORT_COUNT = 8;

export interface CampusState {
  missionPhase: string;
  /** Cumulative loss-budget draw in percentage points, 0..100, no rollover. */
  lossBudgetUsedPoints: number;
  paused: boolean;
  mcpPortHealth: PortHealth[];
}

export interface Simulation {
  state: CampusState;
  subscribe(fn: (state: CampusState) => void): () => void;
  /** Consume percentage POINTS (0..100 scale) of the loss budget. */
  consumeLoss(points: number): void;
  /** Mission create: the loss budget resets to 0 used points. */
  resetLossBudget(): void;
  /** Remaining allowance as a fraction 0..1: clamp(1 - usedPoints/100). */
  lossRemainingFraction(): number;
  /** Consume a fraction of the tool spend reservoir (0..1). */
  consumeTools(fraction: number): void;
  setPortHealth(port: number, health: PortHealth): void;
  setPhase(phase: string): void;
  setPaused(paused: boolean): void;
}

export function createSimulation(ctx: DioramaContext): Simulation {
  void ctx; // simulation is pure state; no rendering depends on the context

  const state: CampusState = {
    missionPhase: "Waiting",
    lossBudgetUsedPoints: 0,
    paused: false,
    mcpPortHealth: Array.from({ length: MCP_PORT_COUNT }, () => "green" as PortHealth),
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

  const clamp = (v: number, min: number, max: number): number => Math.max(min, Math.min(max, v));

  return {
    state,
    subscribe(fn: (state: CampusState) => void): () => void {
      subscribers.add(fn);
      fn(snapshot());
      return () => {
        subscribers.delete(fn);
      };
    },
    consumeLoss(points: number): void {
      const used = clamp(state.lossBudgetUsedPoints + Math.max(0, points), 0, 100);
      if (used === state.lossBudgetUsedPoints) return;
      state.lossBudgetUsedPoints = used;
      notify();
    },
    resetLossBudget(): void {
      if (state.lossBudgetUsedPoints === 0) return;
      state.lossBudgetUsedPoints = 0;
      notify();
    },
    lossRemainingFraction(): number {
      return clamp(1 - state.lossBudgetUsedPoints / 100, 0, 1);
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
  };
}
