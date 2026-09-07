/**
 * Agent population: spawns the roster, owns actor locks, and walks agents
 * along authored waypoint paths with GSAP. Owner: agent system worker.
 *
 * Locks: acquire(id) reserves an agent for exactly one story; a second
 * acquire while held returns undefined. Stories must acquire before calling
 * walk(); if a walk is issued while another walk is running, the new walk
 * cleanly replaces the old one (old promise resolves immediately and the
 * agent resets to its idle pose), so uncoordinated callers cannot corrupt
 * state, but acquiring remains the intended discipline.
 *
 * Idle life: when no story owns an agent, the system walks its authored
 * wander loop at a leisurely pace with short pauses and a natural blink, all
 * driven from one shared ticker with per-agent schedules from seededRandom.
 * There is no self-triggered comedy: background workers only move with
 * purpose (wander loops plus story tasking), and expressions change only
 * through story calls. Under reducedMotion agents still walk (idle wandering
 * and story walks alike, at a calmer cadence); blinks keep their cadence.
 */
import { gsap } from "gsap";
import type { DioramaContext } from "../core/context.js";
import { DEPTH, seededRandom } from "../config/world.js";
import type { AgentRole } from "../config/palette.js";
import { POPULATION, type AgentDef } from "../config/population.js";
import {
  createAgentImpl,
  type Agent,
  type AgentImpl,
  type AgentMicroLife,
  type Expression,
} from "./agent.js";
import { createAgentFx } from "./fx.js";

export interface AgentSystem {
  agents: Map<string, Agent>;
  /** Reserve an agent for a story; returns undefined when busy or missing. */
  acquire(id: string): Agent | undefined;
  release(id: string): void;
  /** Walk an agent through waypoints; resolves when the walk completes. */
  walk(
    agent: Agent,
    waypoints: { x: number; y: number }[],
    opts?: { speed?: number; ease?: "arrive" },
  ): Promise<void>;
  /** Idle-loop wandering between story tasks (started by the system). */
  startIdleLife(): void;
  /** Cheap population counters for the QA debug hook. */
  activity(): { moving: number; reacting: number; total: number };
}

/** Default walking speed in world units per second. */
export const WALK_SPEED = 85;
/** Leisurely idle-wander speed. */
const IDLE_SPEED = 55;
/** Role pace variation applied when the caller does not set a speed. */
const ROLE_SPEED: Record<AgentRole, number> = {
  execution: 1.08,
  operations: 1.08,
  analysis: 0.92,
  research: 1,
  strategy: 1,
  risk: 1,
  reconciliation: 1,
};

/** Deterministic FNV-1a hash of an id, normalized to [0,1). */
const hashAgent = (id: string): number => {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
};

type IdleState = "waiting" | "walking";

interface Runtime {
  def: AgentDef;
  impl: AgentImpl & AgentMicroLife;
  rng: () => number;
  /** Live walk timeline, if any (idle or story). */
  walk: gsap.core.Timeline | null;
  /** Resolver for the promise returned by the current walk. */
  walkResolve: (() => void) | null;
  /** Accumulated path distance for the leg cycle. */
  phase: number;
  idle: IdleState;
  waitUntil: number;
  wanderIndex: number;
  nextBlinkAt: number;
}

interface Lock {
  agent: Agent;
  acquiredBy: string;
}

export function createPopulation(ctx: DioramaContext): AgentSystem {
  const agents = new Map<string, Agent>();
  const runtimes = new Map<string, Runtime>();
  const locks = new Map<string, Lock>();
  let elapsed = 0;
  let idleLifeEnabled = false;

  // Comic marks / card bursts / rolling props: installed here, consumed by
  // story tasking (stories call the fx delegates directly).
  createAgentFx(ctx);

  const restingExpression = (def: AgentDef): Expression =>
    (def.restingExpression as Expression | undefined) ?? "neutral";

  const updateDepth = (rt: Runtime): void => {
    rt.impl.root.zIndex = rt.impl.root.y + DEPTH.base;
  };

  // --- spawn ---------------------------------------------------------------
  POPULATION.forEach((def, index) => {
    const impl = createAgentImpl(def.id, def.role, def.variant, ctx.reducedMotion);
    const first = def.wander[0];
    impl.root.position.set(first.x, first.y);
    impl.setExpression(restingExpression(def));
    ctx.layers.sortable.addChild(impl.root);
    const rt: Runtime = {
      def,
      impl,
      rng: seededRandom(1000 + index * 7919),
      walk: null,
      walkResolve: null,
      phase: 0,
      idle: "waiting",
      waitUntil: 0,
      wanderIndex: 0,
      nextBlinkAt: 2 + seededRandom(index + 101)() * 4,
    };
    updateDepth(rt);
    agents.set(def.id, impl);
    runtimes.set(def.id, rt);
  });

  ctx.onCleanup(() => {
    for (const rt of runtimes.values()) {
      rt.walk?.kill();
      rt.walkResolve?.();
      rt.impl.dispose();
      rt.impl.root.destroy({ children: true });
    }
    runtimes.clear();
    agents.clear();
    locks.clear();
  });

  // --- walking -------------------------------------------------------------
  const finishWalk = (rt: Runtime): void => {
    rt.walk = null;
    rt.phase = 0;
    rt.impl.setWalkPose(0, false);
    rt.impl.restPose();
    const resolve = rt.walkResolve;
    rt.walkResolve = null;
    resolve?.();
  };

  const startWalk = (
    rt: Runtime,
    waypoints: { x: number; y: number }[],
    speed: number,
    ease?: "arrive",
  ): Promise<void> => {
    return new Promise<void>((resolve) => {
      // A new walk cleanly replaces any walk in flight: the superseded caller
      // resolves immediately and the pose resets before the new path starts.
      rt.walk?.kill();
      rt.walkResolve?.();
      rt.walkResolve = resolve;
      // Suppress idle wandering while this (potentially story-owned) walk runs;
      // stories are still expected to acquire the agent first.
      rt.idle = "waiting";
      rt.waitUntil = elapsed + 5;

      const root = rt.impl.root;
      const arrive = ease === "arrive";
      // In arrive mode the agent keeps facing its actual destination instead
      // of snapping per segment, so curved paths lose the vertex-turn read.
      const destDx = waypoints.length > 0 ? waypoints[waypoints.length - 1].x - root.x : 0;

      // Long segments gain a perpendicular midpoint offset (10-18u) so paths
      // curve; magnitude and side are deterministic from the agent id hash.
      const curved: { x: number; y: number }[] = [];
      {
        let px = root.x;
        let py = root.y;
        for (const target of waypoints) {
          const dx = target.x - px;
          const dy = target.y - py;
          const dist = Math.hypot(dx, dy);
          if (arrive && dist > 140) {
            const side = hashAgent(rt.def.id) < 0.5 ? 1 : -1;
            const mag = 10 + hashAgent(`${rt.def.id}:${curved.length}`) * 8;
            curved.push({
              x: px + dx * 0.5 + (-dy / dist) * mag * side,
              y: py + dy * 0.5 + (dx / dist) * mag * side,
            });
          }
          curved.push(target);
          px = target.x;
          py = target.y;
        }
      }

      const state = { t: 0 };
      // Reused scratch point; no per-frame allocation in onUpdate.
      const from = { x: root.x, y: root.y };
      const tl = gsap.timeline({
        onComplete: () => finishWalk(rt),
        onKill: () => {
          if (rt.walkResolve) finishWalk(rt);
        },
      });
      rt.walk = tl;

      const segCount = curved.length;
      let segIndex = 0;
      for (const target of curved) {
        const dx = target.x - from.x;
        const dy = target.y - from.y;
        const dist = Math.hypot(dx, dy);
        const start = { x: from.x, y: from.y };
        if (dist < 0.5) {
          from.x = target.x;
          from.y = target.y;
          continue;
        }
        const duration = Math.max(dist / speed, 0.05);
        // Arrive walks ease into and out of the whole path: the first and
        // last segment get sine.inOut so starts and stops feel weighted.
        const segEase =
          arrive && (segIndex === 0 || segIndex === segCount - 1) ? "sine.inOut" : "none";
        tl.to(state, {
          t: 1,
          duration,
          ease: segEase,
          onUpdate: () => {
            root.x = start.x + dx * state.t;
            root.y = start.y + dy * state.t;
            updateDepth(rt);
            rt.phase += (dist / duration) * gsap.ticker.deltaRatio(60) * (1 / 60);
            rt.impl.setWalkPose(rt.phase, true);
            if (Math.abs(dx) > 1) rt.impl.faceLeft(arrive ? destDx < 0 : dx < 0);
          },
          onStart: () => {
            if (Math.abs(dx) > 1) rt.impl.faceLeft(arrive ? destDx < 0 : dx < 0);
            // 2-frame lean into the dominant travel direction (reset by restPose).
            const lateral = Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 4;
            rt.impl.setLean(lateral ? (dx < 0 ? -1 : 1) : 0);
          },
        });
        from.x = target.x;
        from.y = target.y;
        state.t = 0;
        segIndex++;
      }
      if (tl.duration() === 0) finishWalk(rt);
    });
  };

  // --- locks ---------------------------------------------------------------
  const acquireLocked = (id: string, label: string): Agent | undefined => {
    const agent = agents.get(id);
    if (!agent || locks.has(id)) return undefined;
    locks.set(id, { agent, acquiredBy: label });
    // Take the agent out of idle life: cancel its idle walk.
    const rt = runtimes.get(id);
    if (rt) {
      rt.walk?.kill();
    }
    return agent;
  };

  const acquire = (id: string): Agent | undefined => acquireLocked(id, "story");

  const release = (id: string): void => {
    if (!locks.delete(id)) return;
    const rt = runtimes.get(id);
    if (!rt) return;
    rt.impl.setExpression(restingExpression(rt.def));
    if (idleLifeEnabled) {
      // Resume wandering from the nearest authored point after a short pause.
      let best = 0;
      let bestDist = Infinity;
      rt.def.wander.forEach((w, i) => {
        const d = Math.hypot(w.x - rt.impl.root.x, w.y - rt.impl.root.y);
        if (d < bestDist) {
          bestDist = d;
          best = i;
        }
      });
      rt.wanderIndex = best;
      rt.idle = "waiting";
      rt.waitUntil = elapsed + 0.8;
    }
  };

  // --- idle life -----------------------------------------------------------
  const startIdleLife = (): void => {
    // Reduced motion keeps locomotion: miniature agents walking between
    // authored posts is scene content, not a vestibular trigger. There is no
    // other idle motion to suppress.
    idleLifeEnabled = true;
    for (const rt of runtimes.values()) {
      rt.idle = "waiting";
      // Variant-staggered starts so no district settles into sync.
      rt.waitUntil = elapsed + rt.def.variant * 1.8 + rt.rng() * 0.5;
    }
  };

  // One shared ticker drives idle wandering and blinks.
  const unregisterTick = ctx.onTick((_ticker) => {
    const dt = gsap.ticker.deltaRatio(60) / 60;
    elapsed += dt;
    if (!idleLifeEnabled) return;
    for (const rt of runtimes.values()) {
      if (locks.has(rt.def.id)) continue;
      if (rt.idle === "waiting" && rt.walk === null && elapsed >= rt.waitUntil) {
        // Advance along the authored loop two points at a time so idle
        // movement reads as travel, not vibration at a desk.
        const count = rt.def.wander.length;
        const first = (rt.wanderIndex + 1) % count;
        const second = (rt.wanderIndex + 2) % count;
        const legs =
          count >= 2 && first !== second
            ? [rt.def.wander[first], rt.def.wander[second]]
            : [rt.def.wander[first]];
        rt.wanderIndex = count >= 2 && first !== second ? second : first;
        const walked = startWalk(rt, legs, IDLE_SPEED, "arrive");
        // startWalk resets idle to "waiting"; mark the stroll after the call
        // so the completion callback can schedule the next pause.
        rt.idle = "walking";
        void walked.then(() => {
          if (rt.idle === "walking") {
            rt.idle = "waiting";
            // 0.5-1.6 s pause between strolls; calmer under reduced motion.
            const base = 0.5 + rt.rng() * 1.1;
            rt.waitUntil = elapsed + (ctx.reducedMotion ? base * 1.8 : base);
          }
        });
      }
      if (elapsed >= rt.nextBlinkAt) {
        // Blink cadence jitters per variant so crowds never blink in unison.
        rt.nextBlinkAt = elapsed + 2.2 + rt.def.variant * 1.6 + rt.rng() * 3;
        if (rt.walk === null) rt.impl.blink();
      }
    }
  });
  ctx.onCleanup(unregisterTick);

  const system: AgentSystem & PopulationExtras = {
    agents,
    acquire,
    release,
    walk: (agent, waypoints, opts) => {
      const rt = runtimes.get(agent.id);
      if (!rt) {
        return Promise.reject(new Error(`walk: unknown agent ${agent.id}`));
      }
      const speed = opts?.speed ?? WALK_SPEED * ROLE_SPEED[agent.role];
      return startWalk(rt, waypoints, speed, opts?.ease);
    },
    startIdleLife,
    activity: () => {
      let moving = 0;
      let reacting = 0;
      for (const rt of runtimes.values()) {
        if (rt.walk !== null || rt.impl.isMoving()) moving++;
        if (rt.impl.isReacting()) reacting++;
      }
      return { moving, reacting, total: runtimes.size };
    },
    acquireWithLabel: acquireLocked,
    locksHeld: () => {
      const out = new Map<string, string>();
      for (const [id, lock] of locks) out.set(id, lock.acquiredBy);
      return out;
    },
  };
  // The population owns its idle life: purposeful wandering starts as soon
  // as the system exists (at a calmer cadence under reduced motion).
  startIdleLife();
  return system;
}

/** Convenience lookup used by directors and stories. */
export function getAgent(system: AgentSystem, id: string): Agent | undefined {
  return system.agents.get(id);
}

/** Population size (frozen roster length). */
export const agentCount = POPULATION.length;

/**
 * Extra system controls beyond the frozen AgentSystem interface: labeled
 * acquisition for debugging and a read-only view of held locks.
 */
export interface PopulationExtras {
  /** acquire with a label recorded for lock debugging. */
  acquireWithLabel(id: string, label: string): Agent | undefined;
  /** Map of agent id -> acquiring label for currently held locks. */
  locksHeld(): Map<string, string>;
}

/** Cast only when the extras are needed; createPopulation always provides them. */
export function populationExtras(system: AgentSystem): PopulationExtras {
  return system as AgentSystem & PopulationExtras;
}
