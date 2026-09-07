/**
 * Event director v3: seeded, deterministic scheduler for the one-flow room.
 * Owner: director worker.
 *
 * Two story lanes share the actor/station locks, plus a heartbeat lane:
 * - spine: the single lifecycle scenario (SPINE_ID) starts immediately on
 *   start() — the arrival moment IS the first pass — and loops with a
 *   4.5–6 s breath between passes. The story owns its inter-beat timing;
 *   the director only owns the inter-attempt lock retry (250–400 ms) and
 *   never skips a beat: a contended spine retries until locks free up.
 * - texture: at most one ambient story at a time, and none at all until the
 *   first spine pass completes. Launches are spaced 12–18 s apart measured
 *   launch-to-launch (the timestamp is stamped when a story starts, not when
 *   it settles), each story id cools down for 40 s, and ambient refusals
 *   (s-refusal) stay at least 90 s apart. The comedy lane is deleted
 *   (freeze §7).
 * - heartbeats: one cheap glow pulse every 2.4–3.2 s, round-robin over the
 *   frozen seven-station target list. Busy targets are skipped. The exchange
 *   port is never pulsed as ambience, and district banners are not stations,
 *   so neither can appear here.
 *
 * All waits are tracked and cleared on stop(); locks always release in
 * finally; same seed = same show.
 */
import gsap from "gsap";
import type { DioramaContext } from "../core/context.js";
import type { Agent } from "../agents/agent.js";
import type { AgentSystem } from "../agents/system.js";
import type { RailSystem } from "./rails.js";
import type { Simulation } from "./simulation.js";
import type { DistrictId, StationId } from "../config/stations.js";
import { STATIONS } from "../config/stations.js";
import { seededRandom } from "../config/world.js";
import { getStation } from "../core/registry.js";
import { SPINE_ID, STORY_MAP, TEXTURE_POOL } from "./stories.js";

/**
 * Station-agnostic glow pulse for stations without a frozen animation api.
 * Tweens the registered root's alpha; the director's district heartbeats are
 * the only caller. The tween is short-lived and self-terminating; route
 * teardown's gsap.globalTimeline.clear() is the cleanup, so NO per-call
 * cleanup is registered (heartbeats fire every few seconds and per-call
 * registrations would grow the cleanup list without bound).
 */
function glowPulse(id: StationId, dip = 0.5, seconds = 0.9): void {
  const station = getStation(id);
  if (!station) return;
  gsap.to(station.root, {
    alpha: dip,
    duration: seconds / 2,
    yoyo: true,
    repeat: 1,
    ease: "sine.inOut",
  });
}

// --- Freeze §7 constants -----------------------------------------------------

/** Pause between full spine passes; the spine owns everything inside a pass. */
const SPINE_BREATH_MIN_MS = 4_500;
const SPINE_BREATH_MAX_MS = 6_000;
/** Spine inter-attempt lock retry: the spine never skips a beat. */
const SPINE_RETRY_MIN_MS = 250;
const SPINE_RETRY_MAX_MS = 400;
/** The <=45 s first-pass budget is owned by the story's durationHint; the
 * director only warns when a pass blows through the hard ceiling. */
const SPINE_RUN_WARN_MS = 60_000;

/** Ambient texture: one story alive at a time (concurrency 1 by construction:
 * the texture loop awaits each run before scheduling the next attempt). */
const TEXTURE_SPACING_MIN_MS = 12_000;
const TEXTURE_SPACING_MAX_MS = 18_000;
const TEXTURE_COOLDOWN_MS = 40_000;
/** Ambient refusals are a texture, not a rhythm section: >=90 s apart. */
const REFUSAL_STORY_ID = "s-refusal";
const REFUSAL_SPACING_MS = 90_000;
/** Back-off when every texture candidate is cooling down or locked. */
const TEXTURE_RETRY_MIN_MS = 2_000;
const TEXTURE_RETRY_MAX_MS = 4_000;

/** Heartbeat cadence over the frozen round-robin target list. */
const HEARTBEAT_MIN_MS = 2_400;
const HEARTBEAT_MAX_MS = 3_200;
/** A district counts as alive for one full heartbeat round (7 targets at the
 * 3.2 s worst case is 22.4 s) plus margin. */
const HEARTBEAT_ALIVE_HORIZON_MS = 24_000;

/** Exact frozen heartbeat targets, in round-robin order. hyperliquidVenue is
 * deliberately absent: exchange authority is never pulsed as ambience. */
const HEARTBEAT_TARGETS: StationId[] = [
  "marketData",
  "missionBoard",
  "holoCore",
  "signalTower",
  "budgetMeter",
  "protection",
  "reconciliationDock",
];

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
  /** Last texture LAUNCH moment (performance.now); spacing is measured
   * launch-to-launch, not settle-to-launch, so a long story cannot stretch
   * the 12-18 s cadence by its own duration. */
  let lastLaunchAt = -Infinity;
  /** Last s-refusal settle; arms the >=90 s ambient-refusal spacing. */
  let lastRefusalAt = 0;
  /** Notified in the settle finally of every story run, whichever lane launched it. */
  const settleListeners = new Set<(id: string) => void>();
  /** Tracked timeouts so stop() leaves no pending waits behind. */
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let cancelled = false;
  let runningStarted = false;
  /** Incremented by every start(): lane loops capture their generation and
   * exit when it is stale. Settling waits on stop() wakes old loops, and
   * without this token a fast start() could un-cancel one into running
   * alongside the new generation (two spines racing the shared locks). */
  let generation = 0;
  /** Resolved when the first spine pass completes; the texture lane waits on
   * it so the arrival moment belongs to the spine alone (freeze §7). */
  let firstPassGate = Promise.resolve();
  let openFirstPassGate = (): void => {};
  const armFirstPassGate = (): void => {
    firstPassGate = new Promise<void>((resolve) => {
      openFirstPassGate = resolve;
    });
  };

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
   * stopped. Beats are not fully skipped under reduced motion because stories
   * walk instead of teleporting; without pauses the sequence would rush. */
  const beat = (ms: number): Promise<void> =>
    cancelled
      ? Promise.resolve()
      : ctx.reducedMotion
        ? wait(Math.min(Math.round(ms * 0.4), 1200))
        : wait(ms);

  const districtOf = (station: StationId): DistrictId => STATIONS[station]?.district ?? "floor";

  const districtsOf = (stations: StationId[]): Set<DistrictId> => {
    const set = new Set<DistrictId>();
    for (const station of stations) set.add(districtOf(station));
    return set;
  };

  const districtsAlive = (): Partial<Record<DistrictId, boolean>> => {
    const alive: Partial<Record<DistrictId, boolean>> = {};
    // Heartbeats pulse one target per 2.4-3.2 s tick round-robin over seven
    // stations, so a full round is at most 22.4 s; the horizon credits a
    // district until its next pulse is due. Running stories credit directly.
    const horizon = now() - HEARTBEAT_ALIVE_HORIZON_MS;
    for (const story of running) {
      for (const district of story.districts) alive[district] = true;
    }
    for (const [district, at] of heartbeatAt) {
      if (at >= horizon) alive[district] = true;
    }
    return alive;
  };

  /**
   * Run one story under full locking. Resolves true when the story ran to
   * completion (success, failure, or cancel); resolves gracefully (false)
   * when locks were unavailable or the id is unknown, so a busy room never
   * stalls the show. `onLaunch` fires synchronously at the launch moment —
   * locks acquired, story starting — not at settle.
   */
  const runStoryLocked = async (id: string, onLaunch?: () => void): Promise<boolean> => {
    const story = STORY_MAP.get(id);
    if (!story || cancelled) return false;
    if (story.locks.some((station) => busyStations.has(station))) return false;

    const cast = new Map<string, Agent>();
    for (const agentId of story.agents) {
      const agent = deps.agents.acquire(agentId);
      if (!agent) {
        for (const held of cast.values()) deps.agents.release(held.id);
        return false;
      }
      cast.set(agentId, agent);
    }
    for (const station of story.locks) busyStations.add(station);

    const entry: RunningStory = { id, districts: districtsOf(story.locks) };
    running.add(entry);
    // The launch moment is HERE: locks held, story about to run. Spacing and
    // duration metrics anchor to this instant, not to the settle below.
    onLaunch?.();
    // A stop() followed by start() flips `cancelled` back to false; without
    // this per-run generation snapshot an old story suspended mid-walk would
    // resume its remaining beats as a zombie alongside the fresh show.
    const runGeneration = generation;

    try {
      // Built as a local (not an inline literal) so the call survives
      // StoryDeps field changes from the parallel stories rewrite without
      // excess-property check failures.
      const storyDeps = {
        ctx,
        agents: deps.agents,
        rails: deps.rails,
        simulation: deps.simulation,
        rng,
        cast,
        wait,
        beat,
        cancelled: () => cancelled || runGeneration !== generation,
      };
      await story.run(storyDeps);
    } catch (err) {
      // One warning per failure; the show keeps going.
      console.warn(`[diorama/director] story ${id} failed:`, err);
    } finally {
      running.delete(entry);
      for (const station of story.locks) busyStations.delete(station);
      for (const agentId of cast.keys()) deps.agents.release(agentId);
      lastRunAt.set(id, now());
      // Every refusal run arms the ambient spacing, including explicit card
      // actions, so texture never stacks onto a fresh refusal. Card actions
      // themselves stay exempt from the gate (freeze §8).
      if (id === REFUSAL_STORY_ID) lastRefusalAt = now();
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

  /** Spine lane: the one lifecycle scenario, looping forever. Started first
   * and immediately; everything else waits for its first pass. */
  const spineLoop = async (gen: number): Promise<void> => {
    if (!STORY_MAP.has(SPINE_ID)) {
      console.warn(
        `[diorama/director] spine story "${SPINE_ID}" missing from STORY_MAP; spine lane idle`,
      );
      openFirstPassGate();
      return;
    }
    let firstPass = true;
    while (!cancelled && gen === generation) {
      const startedAt = now();
      const started = await runStoryLocked(SPINE_ID);
      if (cancelled || gen !== generation) return;
      if (started) {
        if (firstPass) {
          firstPass = false;
          // Texture gating: ambient stories wait for the readable first pass.
          openFirstPassGate();
        }
        const durationMs = now() - startedAt;
        if (durationMs > SPINE_RUN_WARN_MS) {
          console.warn(
            `[diorama/director] spine pass took ${(durationMs / 1000).toFixed(1)}s ` +
              `(contract: <=45s per durationHint, warn >60s)`,
          );
        }
        // One breath between full passes; inter-beat gaps inside a pass
        // belong to the story.
        await wait(SPINE_BREATH_MIN_MS + rng() * (SPINE_BREATH_MAX_MS - SPINE_BREATH_MIN_MS));
      } else {
        // Locks contended (a card story or texture holds a spine station):
        // retry on the short inter-attempt cadence until the room frees up.
        await wait(SPINE_RETRY_MIN_MS + rng() * (SPINE_RETRY_MAX_MS - SPINE_RETRY_MIN_MS));
      }
    }
  };

  /** Texture candidates right now: per-story cooldown, plus the ambient
   * refusal spacing for s-refusal. */
  const textureCandidates = (): string[] => {
    const at = now();
    return TEXTURE_POOL.filter((id) => {
      if ((lastRunAt.get(id) ?? -Infinity) > at - TEXTURE_COOLDOWN_MS) return false;
      if (id === REFUSAL_STORY_ID && at - lastRefusalAt < REFUSAL_SPACING_MS) return false;
      return true;
    });
  };

  /** Try to launch one ambient texture story. Concurrency is 1 by
   * construction: the caller awaits this (and therefore the whole run)
   * before attempting the next launch. Resolves true when something launched;
   * the launch timestamp is stamped at the launch moment, not at settle. */
  const launchTexture = async (): Promise<boolean> => {
    const candidates = textureCandidates();
    // Random draw per attempt so busy locks skip to another candidate
    // instead of stalling the lane.
    for (let attempt = 0; attempt < candidates.length; attempt += 1) {
      const index = Math.floor(rng() * candidates.length);
      const [id] = candidates.splice(index, 1);
      const launched = await runStoryLocked(id, () => {
        lastLaunchAt = now();
      });
      if (launched) return true;
    }
    return false;
  };

  const textureLoop = async (gen: number): Promise<void> => {
    // Freeze §7: no ambient story until the first spine pass completes.
    await firstPassGate;
    while (!cancelled && gen === generation) {
      if (lastLaunchAt !== -Infinity) {
        // Launch-to-launch spacing, measured from the previous launch moment
        // so the cadence stays inside the frozen 12-18 s band regardless of
        // how long the previous story ran.
        const gap =
          TEXTURE_SPACING_MIN_MS + rng() * (TEXTURE_SPACING_MAX_MS - TEXTURE_SPACING_MIN_MS);
        const untilDue = lastLaunchAt + gap - now();
        if (untilDue > 0) await wait(untilDue);
        if (cancelled || gen !== generation) return;
      }
      const launched = await launchTexture();
      if (cancelled || gen !== generation) return;
      if (!launched) {
        // Everything is cooling down or locked; back off and re-poll.
        await wait(TEXTURE_RETRY_MIN_MS + rng() * (TEXTURE_RETRY_MAX_MS - TEXTURE_RETRY_MIN_MS));
      }
    }
  };

  /** Heartbeat lane: one cheap pulse per tick, round-robin over the frozen
   * seven-station list, so every district breathes even when no story runs.
   * Busy targets are skipped — a story-owned station lights itself. */
  const heartbeatLoop = async (gen: number): Promise<void> => {
    let cursor = Math.floor(rng() * HEARTBEAT_TARGETS.length);
    while (!cancelled && gen === generation) {
      const station = HEARTBEAT_TARGETS[cursor % HEARTBEAT_TARGETS.length];
      cursor += 1;
      if (!busyStations.has(station)) {
        if (!ctx.reducedMotion) glowPulse(station, 0.55, 1.0);
        heartbeatAt.set(districtOf(station), now());
      }
      await wait(HEARTBEAT_MIN_MS + rng() * (HEARTBEAT_MAX_MS - HEARTBEAT_MIN_MS));
    }
  };

  return {
    start(): void {
      if (runningStarted) return;
      runningStarted = true;
      cancelled = false;
      generation += 1;
      armFirstPassGate();
      // Arrival: the spine IS the arrival burst. It launches immediately and
      // runs alone until its first pass completes; no texture burst.
      void spineLoop(generation);
      void textureLoop(generation);
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
      // Wake the texture lane if it is parked on the first-pass gate.
      openFirstPassGate();
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
