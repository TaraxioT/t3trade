/**
 * Event director v2: seeded, deterministic scheduler with separate activity
 * budgets so the room never looks dead at the default camera.
 * Owner: director worker.
 *
 * Four lanes run concurrently on top of the same actor/station locks:
 * - spine: the 16-story lifecycle chain, looping end to end with short gaps.
 *   This is the readable "one trade from research to reconciliation" story.
 * - texture: weighted ambient singles (system stories, floor choreography,
 *   and the market-structure desk welcome) with up to TEXTURE_CONCURRENCY
 *   disjoint stories alive.
 * - comedy: harmless slapstick, one gag at a time, per-gag cooldown plus a
 *   global comedy gap so the same joke never machine-guns.
 * - heartbeats: staggered, cheap section pulses plus slow regime/phase drift
 *   so no section goes quiet for long.
 *
 * There is no initial calm: start() launches the spine and two texture
 * singles immediately as an arrival burst. All waits are tracked and cleared
 * on stop(); locks always release in finally. Same seed = same show.
 */
import type { DioramaContext } from "../core/context.js";
import type { Agent } from "../agents/agent.js";
import type { AgentSystem } from "../agents/system.js";
import type { RailSystem } from "./rails.js";
import type { Simulation } from "./simulation.js";
import type { DistrictId, StationId } from "../config/stations.js";
import { STATIONS } from "../config/stations.js";
import { seededRandom } from "../config/world.js";
import { COMEDY_POOL, LIFECYCLE_CHAIN, STORY_MAP, TEXTURE_POOL, glowPulse } from "./stories.js";

/** Concurrent disjoint texture stories (spine and comedy are extra lanes). */
const TEXTURE_CONCURRENCY = 3;
/** Minimum spacing between comedy gags, and per-gag cooldown. */
const COMEDY_GAP_MS = 11_000;
const COMEDY_COOLDOWN_MS = 45_000;
/** Texture single cooldown so one story does not dominate. */
const TEXTURE_COOLDOWN_MS = 18_000;
/** Heartbeat cadence: one section per fire, round-robin. With three
 * sections this gives every section a pulse inside the 3 s dead-section
 * budget even when no story touches it. */
const HEARTBEAT_MIN_MS = 350;
const HEARTBEAT_JITTER_MS = 200;

export interface ActivitySnapshot {
  /** Story ids currently running across all lanes. */
  stories: string[];
  /** Agents visibly moving / reacting (from the agent system; 0 if unavailable). */
  moving: number;
  reacting: number;
  total: number;
  /** Districts touched by a running story or a recent heartbeat. */
  districts: Partial<Record<DistrictId, boolean>>;
}

export interface Director {
  start(): void;
  stop(): void;
  /** Run one story immediately by id (used by interaction/Explore). Bypasses
   * cooldowns but still respects actor and station locks. */
  runStory(id: string): Promise<void>;
  /** True while the named story currently holds its locks. */
  isRunning(id: string): boolean;
  /** True while ANY running story holds this station. The info card uses
   * this to show busy when a different story owns the focused station. */
  isStationBusy(id: string): boolean;
  /** Observe every story settle (any lane, success, failure, or cancelled).
   * Returns an unsubscribe. Dependent UI (the info card's busy button) uses
   * this instead of owning the promise of only its own launches. */
  onStorySettle(cb: (id: string) => void): () => void;
  /** QA/ debug snapshot of current activity. */
  activity(): ActivitySnapshot;
}

export interface DirectorDeps {
  agents: AgentSystem;
  rails: RailSystem;
  simulation: Simulation;
}

interface RunningStory {
  id: string;
  districts: Set<DistrictId>;
}

export function createDirector(ctx: DioramaContext, deps: DirectorDeps): Director {
  const rng = seededRandom(20260901);
  const busyStations = new Set<StationId>();
  /** Stories currently holding locks; removed in the same finally that releases. */
  const running = new Set<RunningStory>();
  /** District -> last heartbeat ms (performance.now) for the alive metric. */
  const heartbeatAt = new Map<DistrictId, number>();
  const lastRunAt = new Map<string, number>();
  /** Notified in the settle finally of every story run, whichever lane launched it. */
  const settleListeners = new Set<(id: string) => void>();
  /** Tracked timeouts so stop() leaves no pending waits behind. */
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let cancelled = false;
  let runningStarted = false;
  let lastComedyAt = 0;
  /** Incremented by every start(): lane loops capture their generation and
   * exit when it is stale. Settling waits on stop() wakes old loops, and
   * without this token a fast start() could un-cancel one into running
   * alongside the new generation (two spines racing the shared index). */
  let generation = 0;

  const now = (): number => performance.now();

  /** Pending wait resolvers, so stop() can settle every in-flight story:
   * resolving the wait lets the story reach its finally block and release
   * actor and station locks instead of parking forever. */
  const waiters = new Set<() => void>();

  /** Content wait; resolves immediately once stopped or already elapsed. */
  const wait = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      if (cancelled || ms <= 0) {
        resolve();
        return;
      }
      const settle = (): void => {
        timers.delete(timer);
        waiters.delete(settle);
        resolve();
      };
      const timer = setTimeout(settle, ms);
      timers.add(timer);
      waiters.add(settle);
    });

  /** Decorative beat: calmer (shortened) under reduced motion, skipped once
   * stopped. Beats are no longer fully skipped because stories walk instead
   * of teleporting; without pauses the sequence would rush. */
  const beat = (ms: number): Promise<void> =>
    cancelled
      ? Promise.resolve()
      : ctx.reducedMotion
        ? wait(Math.min(Math.round(ms * 0.4), 1200))
        : wait(ms);

  const districtsOf = (stations: StationId[]): Set<DistrictId> => {
    const set = new Set<DistrictId>();
    for (const station of stations) set.add(STATIONS[station]?.district ?? "floor");
    return set;
  };

  const districtsAlive = (): Partial<Record<DistrictId, boolean>> => {
    const alive: Partial<Record<DistrictId, boolean>> = {};
    // Heartbeats fire one section per 350-550 ms over three sections, so a
    // 5.5 s horizon credits a section only while its pulse is plausibly
    // still on screen (max cycle ~1.65 s) plus generous margin.
    const horizon = now() - 5_500;
    for (const story of running) {
      for (const district of story.districts) alive[district] = true;
    }
    for (const [district, at] of heartbeatAt) {
      if (at >= horizon) alive[district] = true;
    }
    return alive;
  };

  /**
   * Run one story under full locking. Resolves true when the story started;
   * resolves gracefully (false) when locks were unavailable or the id is
   * unknown, so a busy room never stalls the show.
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

    const entry: RunningStory = { id, districts: districtsOf(story.stations) };
    running.add(entry);
    // A stop() followed by start() flips `cancelled` back to false; without
    // this per-run generation snapshot an old story suspended mid-walk would
    // resume its remaining beats as a zombie alongside the fresh show.
    const runGeneration = generation;

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
        cancelled: () => cancelled || runGeneration !== generation,
      });
    } catch (err) {
      // One warning per failure; the show keeps going.
      console.warn(`[diorama/director] story ${id} failed:`, err);
    } finally {
      running.delete(entry);
      for (const station of story.stations) busyStations.delete(station);
      for (const agentId of cast.keys()) deps.agents.release(agentId);
      lastRunAt.set(id, now());
      // A story instance may have been launched by any lane, not only the
      // info card that waits on it; notify settle listeners (e.g. the card's
      // busy button) so dependent UI never sticks on a finished story.
      for (const notify of settleListeners) {
        try {
          notify(id);
        } catch {
          // Listener defects must not break lock release.
        }
      }
    }
    return true;
  };

  /** Try to launch one story from a candidate pool, respecting cooldowns.
   * Resolves true when something launched. */
  const launchFrom = async (pool: string[], cooldownMs: number): Promise<boolean> => {
    const at = now();
    const candidates = pool.filter((id) => (lastRunAt.get(id) ?? -Infinity) <= at - cooldownMs);
    // Weighted shuffle-ish: up to 6 attempts so busy locks skip to the next
    // candidate instead of stalling the lane.
    for (let attempt = 0; attempt < 6 && candidates.length > 0; attempt += 1) {
      const index = Math.floor(rng() * candidates.length);
      const [id] = candidates.splice(index, 1);
      if (await runStoryLocked(id)) return true;
    }
    return false;
  };

  /** Spine lane: the lifecycle chain, looping with short gaps. The spine
   * NEVER skips a beat: when a beat's locks are contended it retries after a
   * short pause, because the chain's ordering (protection before signing,
   * order before acknowledgment) is the safety story the diorama tells.
   * Texture and comedy lanes stay opportunistic and may skip. */
  const spineLoop = async (gen: number): Promise<void> => {
    let index = 0;
    while (!cancelled && gen === generation) {
      const id = LIFECYCLE_CHAIN[index];
      const started = await runStoryLocked(id);
      if (cancelled || gen !== generation) return;
      if (started) {
        index = (index + 1) % LIFECYCLE_CHAIN.length;
        if (index === 0) {
          // One breath between full lifecycle passes; other lanes keep moving.
          await wait(2000 + rng() * 2000);
        } else {
          await wait(700 + rng() * 600);
        }
      } else {
        await wait(400 + rng() * 500);
      }
    }
  };

  /** Texture lane: weighted ambient singles, capped concurrency. */
  const textureLoop = async (gen: number): Promise<void> => {
    let inFlight = 0;
    while (!cancelled && gen === generation) {
      if (inFlight < TEXTURE_CONCURRENCY) {
        const promise = launchFrom(TEXTURE_POOL, TEXTURE_COOLDOWN_MS);
        inFlight += 1;
        void promise.then(() => {
          inFlight -= 1;
        });
        await wait(1200 + rng() * 1400);
      } else {
        await wait(600 + rng() * 600);
      }
    }
  };

  /** Comedy lane: one gag at a time with a global gap and per-gag cooldowns. */
  const comedyLoop = async (gen: number): Promise<void> => {
    // Let the room establish itself for a few seconds before the first gag.
    await wait(4500 + rng() * 2500);
    while (!cancelled && gen === generation) {
      const at = now();
      if (at - lastComedyAt >= COMEDY_GAP_MS) {
        const launched = await launchFrom(COMEDY_POOL, COMEDY_COOLDOWN_MS);
        lastComedyAt = now();
        if (!launched) await wait(2500 + rng() * 1500);
      } else {
        await wait(1200 + rng() * 1200);
      }
    }
  };

  // Heartbeat targets: one station per section that reads as a pulse. The
  // authority seam between the floor and the guarded east section is NOT
  // pulsed here: it sweeps once when approval binds (s-human-approval calls
  // world/seam.ts pulseSeam), so the seam means authority, not ambience.
  const HEARTBEAT_TARGETS: Partial<Record<DistrictId, StationId[]>> = {
    research: ["missionBoard", "sandbox", "researchTools", "budgetPlanning"],
    floor: ["tradingFloor", "eventClock", "hyperliquidVenue"],
    risk: ["budgetMeter", "protection", "stateStore", "observability"],
  };
  const heartbeatOrder = Object.keys(HEARTBEAT_TARGETS) as DistrictId[];

  /** Heartbeat lane: cheap staggered pulses so no district goes dark. */
  const heartbeatLoop = async (gen: number): Promise<void> => {
    let cursor = Math.floor(rng() * heartbeatOrder.length);
    while (!cancelled && gen === generation) {
      const district = heartbeatOrder[cursor % heartbeatOrder.length];
      cursor += 1;
      const targets = HEARTBEAT_TARGETS[district] ?? [];
      const station = targets.find((candidate) => !busyStations.has(candidate));
      if (station && !ctx.reducedMotion) {
        glowPulse(ctx, station, 0.55, 1.0);
        heartbeatAt.set(district, now());
      } else if (station) {
        heartbeatAt.set(district, now());
      }
      await wait(HEARTBEAT_MIN_MS + rng() * HEARTBEAT_JITTER_MS);
    }
  };

  return {
    start(): void {
      if (runningStarted) return;
      runningStarted = true;
      cancelled = false;
      generation += 1;
      // Arrival burst: the spine plus two texture singles immediately; no
      // room-wide calm after load.
      void spineLoop(generation);
      void textureLoop(generation);
      void comedyLoop(generation);
      void heartbeatLoop(generation);
    },
    stop(): void {
      cancelled = true;
      runningStarted = false;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      // Settle every pending wait so in-flight stories reach their finally
      // blocks and release actor and station locks (the cancelled flag makes
      // their remaining beats no-ops). Observable lock state is NOT cleared
      // here: the stories' finally blocks own the release.
      for (const settle of waiters) settle();
      waiters.clear();
    },
    async runStory(id: string): Promise<void> {
      await runStoryLocked(id);
    },
    isRunning(id: string): boolean {
      for (const story of running) {
        if (story.id === id) return true;
      }
      return false;
    },
    isStationBusy(id: string): boolean {
      return busyStations.has(id as StationId);
    },
    onStorySettle(cb: (id: string) => void): () => void {
      settleListeners.add(cb);
      return () => settleListeners.delete(cb);
    },
    activity(): ActivitySnapshot {
      // The agent system exposes activity counters when the character lane is
      // present; guard so the snapshot works at every integration state.
      const systemActivity = deps.agents.activity?.();
      return {
        stories: [...running].map((story) => story.id),
        moving: systemActivity?.moving ?? 0,
        reacting: systemActivity?.reacting ?? 0,
        total: systemActivity?.total ?? 0,
        districts: districtsAlive(),
      };
    },
  };
}
