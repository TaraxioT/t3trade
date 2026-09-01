/**
 * Event director: seeded, deterministic scheduler that runs micro-stories
 * with actor and station locks, staggering calm and busy periods.
 * Owner: director worker.
 *
 * Scheduler shape:
 * - calm 4-7 s, then a "loop iteration" in one of two modes:
 *   - cycle mode: the 18 lifecycle stories run in order with 0.8-1.5 s gaps
 *     so a viewer can follow one trade end to end;
 *   - scatter mode: 5-7 weighted single stories (19-24 pool plus lifecycle
 *     singles), up to 2 concurrent when they share no agents or stations.
 * - cycle mode is forced whenever the previous iteration was scatter, so the
 *   full lifecycle chain plays at least every other iteration (~4 min loop).
 * - same seed = same show: all variation comes from seededRandom(20260901).
 *
 * Locks: a story starts only when every listed agent is acquirable and no
 * listed station is busy. Stations are tracked in a local Set; agents through
 * AgentSystem.acquire/release. All locks release in a finally block.
 *
 * stop(): sets a cancelled flag checked between awaits (waits resolve early,
 * stories skip remaining steps), after which locks release as in-flight
 * stories unwind. GSAP timelines created by stories register their own
 * cleanup via ctx.onCleanup.
 */
import type { DioramaContext } from "../core/context.js";
import type { Agent } from "../agents/agent.js";
import type { AgentSystem } from "../agents/system.js";
import type { RailSystem } from "./rails.js";
import type { Simulation } from "./simulation.js";
import type { StationId } from "../config/stations.js";
import { seededRandom } from "../config/world.js";
import { LIFECYCLE_CHAIN, SCATTER_POOL, STORIES, STORY_MAP } from "./stories.js";

export interface Director {
  start(): void;
  stop(): void;
  /** Run one story immediately by id (used by interaction/Explore). */
  runStory(id: string): Promise<void>;
}

export interface DirectorDeps {
  agents: AgentSystem;
  rails: RailSystem;
  simulation: Simulation;
}

export function createDirector(ctx: DioramaContext, deps: DirectorDeps): Director {
  const rng = seededRandom(20260901);
  const busyStations = new Set<StationId>();
  let cancelled = false;
  let running = false;

  const cancelledNow = (): boolean => cancelled;

  /** Content wait; resolves immediately once stopped or already elapsed. */
  const wait = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      if (cancelled || ms <= 0) {
        resolve();
        return;
      }
      setTimeout(resolve, ms);
    });

  /** Decorative beat: skipped under reduced motion or once stopped. */
  const beat = (ms: number): Promise<void> =>
    ctx.reducedMotion || cancelled ? Promise.resolve() : wait(ms);

  const scatterCandidates = STORIES.map((story) => story.id);

  /** Weighted pick with no immediate repeat; returns undefined when stuck. */
  const pickScatter = (lastId: string | null): string | undefined => {
    const pool = scatterCandidates.filter((id) => id !== lastId);
    if (pool.length === 0) return undefined;
    // Lifecycle stories carry the show's spine, texture stories half weight.
    const weight = (id: string): number => (SCATTER_POOL.includes(id) ? 0.5 : 1);
    let total = 0;
    for (const id of pool) total += weight(id);
    let roll = rng() * total;
    for (const id of pool) {
      roll -= weight(id);
      if (roll <= 0) return id;
    }
    return pool[pool.length - 1];
  };

  /**
   * Run one story under full locking. Resolves with true when the story
   * actually started; resolves gracefully (false) when locks were unavailable
   * or the story id is unknown, so a missing dependency never stalls the show.
   */
  const runStoryLocked = async (id: string): Promise<boolean> => {
    const story = STORY_MAP.get(id);
    if (!story || cancelled) return false;
    if (story.stations.some((station) => busyStations.has(station))) return false;

    const cast = new Map<string, Agent>();
    for (const agentId of story.agents) {
      const agent = deps.agents.acquire(agentId);
      if (!agent) {
        for (const held of cast.values()) deps.agents.release(held.id);
        return false;
      }
      cast.set(agentId, agent);
    }
    for (const station of story.stations) busyStations.add(station);

    try {
      await story.run({
        ctx,
        agents: deps.agents,
        rails: deps.rails,
        simulation: deps.simulation,
        rng,
        cast,
        wait,
        beat,
        cancelled: cancelledNow,
      });
    } catch (err) {
      // One warning per failure; the show keeps going.
      console.warn(`[diorama/director] story ${id} failed:`, err);
    } finally {
      for (const station of story.stations) busyStations.delete(station);
      for (const agentId of cast.keys()) deps.agents.release(agentId);
    }
    return true;
  };

  /** Cycle mode: the lifecycle chain, in order, with short gaps. */
  const runCycle = async (): Promise<void> => {
    for (const id of LIFECYCLE_CHAIN) {
      if (cancelled) return;
      await runStoryLocked(id);
      await wait(800 + rng() * 700);
    }
  };

  /** Scatter mode: 5-7 singles, up to 2 concurrent when disjoint. */
  const runScatter = async (): Promise<void> => {
    const target = 5 + Math.floor(rng() * 3); // 5..7 stories
    let lastId: string | null = null;
    let launched = 0;
    const inFlight: Promise<unknown>[] = [];

    while (launched < target && !cancelled) {
      const id = pickScatter(lastId);
      if (!id) break;
      // Concurrency cap: at most 2 stories alive at once. Lock checking inside
      // runStoryLocked guarantees disjoint agents/stations for both.
      if (inFlight.length >= 2) {
        await Promise.race(inFlight);
        continue;
      }
      const promise = runStoryLocked(id);
      // Self-remove from the in-flight list as stories settle.
      promise.then(() => {
        const ix = inFlight.indexOf(promise);
        if (ix >= 0) inFlight.splice(ix, 1);
      });
      inFlight.push(promise);
      lastId = id;
      launched += 1;
      await wait(1500 + rng() * 1500); // short calm between launches
    }
    await Promise.all(inFlight);
  };

  /** The looping timeline: calm, then alternating cycle/scatter iterations. */
  const loop = async (): Promise<void> => {
    let lastMode: "cycle" | "scatter" | null = null;
    while (!cancelled) {
      await wait(4000 + rng() * 3000); // calm 4-7 s
      if (cancelled) break;
      // Chain at least every other iteration; otherwise 50/50.
      const mode: "cycle" | "scatter" =
        lastMode === "scatter" ? "cycle" : rng() < 0.5 ? "cycle" : "scatter";
      if (mode === "cycle") await runCycle();
      else await runScatter();
      lastMode = mode;
    }
  };

  return {
    start(): void {
      if (running) return;
      running = true;
      cancelled = false;
      void loop();
    },
    stop(): void {
      cancelled = true;
      running = false;
    },
    async runStory(id: string): Promise<void> {
      await runStoryLocked(id);
    },
  };
}
