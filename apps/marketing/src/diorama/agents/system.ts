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
 * wander loop at a leisurely pace with 1.5-4 s pauses and occasional
 * micro-life (weight shift, look-around, expression flicker, blink), all
 * driven from one shared ticker with per-agent schedules from seededRandom.
 * All of that motion is disabled under reducedMotion: agents hold their
 * first wander point and resting expression.
 */
import { gsap } from "gsap";
import type { DioramaContext } from "../core/context.js";
import { DEPTH, seededRandom } from "../config/world.js";
import { POPULATION, type AgentDef } from "../config/population.js";
import { createAgentImpl, type Agent, type AgentImpl, type AgentMicroLife, type Expression } from "./agent.js";

export interface AgentSystem {
  agents: Map<string, Agent>;
  /** Reserve an agent for a story; returns undefined when busy or missing. */
  acquire(id: string): Agent | undefined;
  release(id: string): void;
  /** Walk an agent through waypoints; resolves when the walk completes. */
  walk(agent: Agent, waypoints: { x: number; y: number }[], opts?: { speed?: number }): Promise<void>;
  /** Idle-loop wandering between story tasks (started by the system). */
  startIdleLife(): void;
}

/** Default walking speed in world units per second. */
export const WALK_SPEED = 85;
/** Leisurely idle-wander speed. */
const IDLE_SPEED = 55;

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
  nextLifeAt: number;
  nextBlinkAt: number;
  lifeRevert: gsap.core.Tween | null;
}

interface Lock {
  agent: Agent;
  acquiredBy: string;
}

const IDLE_EXPRESSIONS: Expression[] = [
  "neutral",
  "focused",
  "curious",
  "satisfied",
];

export function createPopulation(ctx: DioramaContext): AgentSystem {
  const agents = new Map<string, Agent>();
  const runtimes = new Map<string, Runtime>();
  const locks = new Map<string, Lock>();
  let elapsed = 0;
  let idleLifeEnabled = false;

  const restingExpression = (def: AgentDef): Expression =>
    (def.restingExpression as Expression | undefined) ?? "neutral";

  const updateDepth = (rt: Runtime): void => {
    rt.impl.root.zIndex = rt.impl.root.y + DEPTH.base;
  };

  // --- spawn ---------------------------------------------------------------
  POPULATION.forEach((def, index) => {
    const impl = createAgentImpl(def.id, def.role);
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
      nextLifeAt: 4 + seededRandom(index + 1)() * 6,
      nextBlinkAt: 2 + seededRandom(index + 101)() * 4,
      lifeRevert: null,
    };
    updateDepth(rt);
    agents.set(def.id, impl);
    runtimes.set(def.id, rt);
  });

  ctx.onCleanup(() => {
    for (const rt of runtimes.values()) {
      rt.walk?.kill();
      rt.walkResolve?.();
      rt.lifeRevert?.kill();
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

      for (const target of waypoints) {
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
        tl.to(
          state,
          {
            t: 1,
            duration,
            ease: "none",
            onUpdate: () => {
              root.x = start.x + dx * state.t;
              root.y = start.y + dy * state.t;
              updateDepth(rt);
              rt.phase += (dist / duration) * gsap.ticker.deltaRatio(60) * (1 / 60);
              rt.impl.setWalkPose(rt.phase, true);
              if (Math.abs(dx) > 1) rt.impl.faceLeft(dx < 0);
            },
            onStart: () => {
              if (Math.abs(dx) > 1) rt.impl.faceLeft(dx < 0);
              // 2-frame lean into the dominant travel direction (reset by restPose).
              const lateral = Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 4;
              rt.impl.setLean(lateral ? (dx < 0 ? -1 : 1) : 0);
            },
          },
        );
        from.x = target.x;
        from.y = target.y;
        state.t = 0;
      }
      if (tl.duration() === 0) finishWalk(rt);
    });
  };

  // --- locks ---------------------------------------------------------------
  const acquireLocked = (id: string, label: string): Agent | undefined => {
    const agent = agents.get(id);
    if (!agent || locks.has(id)) return undefined;
    locks.set(id, { agent, acquiredBy: label });
    // Take the agent out of idle life: cancel its idle walk and micro-life.
    const rt = runtimes.get(id);
    if (rt) {
      rt.walk?.kill();
      rt.lifeRevert?.kill();
      rt.lifeRevert = null;
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
  const scheduleNextLife = (rt: Runtime): void => {
    rt.nextLifeAt = elapsed + 5 + rt.rng() * 4; // average every 5-9 s
  };

  const idleLifeEvent = (rt: Runtime): void => {
    const roll = rt.rng();
    const impl = rt.impl;
    if (roll < 0.24) {
      // expression flicker, then back to resting
      const expr = IDLE_EXPRESSIONS[Math.floor(rt.rng() * IDLE_EXPRESSIONS.length)];
      impl.setExpression(expr);
      rt.lifeRevert?.kill();
      rt.lifeRevert = gsap.delayedCall(1.2, () => {
        impl.setExpression(restingExpression(rt.def));
        rt.lifeRevert = null;
      });
    } else if (roll < 0.44) {
      // look around with a tiny step: flip + curious + weight shift, revert
      const wasLeft = rt.rng() < 0.5;
      impl.faceLeft(wasLeft);
      impl.setExpression("curious");
      impl.shift();
      rt.lifeRevert?.kill();
      rt.lifeRevert = gsap.delayedCall(1.6, () => {
        impl.setExpression(restingExpression(rt.def));
        rt.lifeRevert = null;
      });
    } else if (roll < 0.6 && rt.idle === "waiting") {
      // satisfied head-bob laugh
      impl.laugh();
      rt.lifeRevert?.kill();
      rt.lifeRevert = null;
    } else if (roll < 0.74 && rt.idle === "waiting") {
      // impatient foot tap
      impl.tap();
    } else if (roll < 0.88 && rt.idle === "waiting") {
      impl.shift(); // weight shift, self-reverting
    } else if (rt.idle === "waiting") {
      impl.react("tilt");
    }
    scheduleNextLife(rt);
  };

  const startIdleLife = (): void => {
    if (ctx.reducedMotion) {
      // Pose only: agents stay at their first wander point with their
      // resting expression; no walks, no micro-life, no blinks.
      for (const rt of runtimes.values()) {
        rt.impl.setExpression(restingExpression(rt.def));
      }
      return;
    }
    idleLifeEnabled = true;
    for (const rt of runtimes.values()) {
      rt.idle = "waiting";
      rt.waitUntil = elapsed + rt.rng() * 2; // staggered starts
      scheduleNextLife(rt);
    }
  };

  // One shared ticker drives idle wandering, micro-life and blinks.
  const unregisterTick = ctx.onTick((_ticker) => {
    const dt = gsap.ticker.deltaRatio(60) / 60;
    elapsed += dt;
    if (!idleLifeEnabled) return;
    for (const rt of runtimes.values()) {
      if (locks.has(rt.def.id)) continue;
      if (rt.idle === "waiting" && rt.walk === null && elapsed >= rt.waitUntil) {
        // Advance to the next authored wander point (looping).
        rt.wanderIndex = (rt.wanderIndex + 1) % rt.def.wander.length;
        const target = rt.def.wander[rt.wanderIndex];
        rt.idle = "walking";
        void startWalk(rt, [target], IDLE_SPEED).then(() => {
          if (rt.idle === "walking") {
            rt.idle = "waiting";
            rt.waitUntil = elapsed + 1.5 + rt.rng() * 2.5; // 1.5-4 s pause
          }
        });
      }
      if (elapsed >= rt.nextLifeAt && rt.walk === null) {
        idleLifeEvent(rt);
      }
      if (elapsed >= rt.nextBlinkAt) {
        rt.nextBlinkAt = elapsed + 2.5 + rt.rng() * 3.5;
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
      const speed = opts?.speed ?? (ctx.reducedMotion ? WALK_SPEED * 6 : WALK_SPEED);
      return startWalk(rt, waypoints, speed);
    },
    startIdleLife,
    acquireWithLabel: acquireLocked,
    locksHeld: () => {
      const out = new Map<string, string>();
      for (const [id, lock] of locks) out.set(id, lock.acquiredBy);
      return out;
    },
  };
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
