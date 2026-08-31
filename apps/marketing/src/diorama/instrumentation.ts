/**
 * Frame/render instrumentation and the exact `window.__diorama` verification
 * surface (plan section 11).
 *
 * Pure data boundary: no THREE objects cross into this module. Snapshots and
 * renderer counters arrive through suppliers owned by main.ts (M09), which
 * also installs the hook via installHook once bootstrap is under way.
 */

import { BEAT_STARTS, DURATION_MS } from "./config";
import type {
  ActorSnapshot,
  BeatId,
  LifecycleState,
  PropSnapshot,
  WorldSnapshot,
  XYZ,
} from "./types";

// ---------------------------------------------------------------------------
// Public data contracts
// ---------------------------------------------------------------------------

/** Per-frame renderer counters, supplied by main.ts from renderer.info. */
export interface FrameInfo {
  readonly calls: number;
  readonly triangles: number;
  readonly points: number;
  readonly lines: number;
}

/** Full renderer counters for snapshots and probe results. */
export interface RendererCounters {
  readonly dpr: number;
  readonly width: number;
  readonly height: number;
  readonly calls: number;
  readonly triangles: number;
  readonly points: number;
  readonly lines: number;
  readonly geometries: number;
  readonly textures: number;
}

export interface FpsProbeOptions {
  readonly warmupMs?: number;
  readonly durationMs?: number;
}

export interface FpsProbeResult {
  readonly frames: number;
  readonly meanFps: number;
  readonly p95FrameMs: number;
  readonly maxFrameMs: number;
  readonly calls: number;
  readonly triangles: number;
  readonly dpr: number;
  readonly interrupted: boolean;
}

/** Canonical, JSON-serializable snapshot: world data plus renderer counters. */
export interface DioramaSnapshot extends WorldSnapshot {
  readonly renderer: RendererCounters;
}

/**
 * Callback surface main.ts (M09) supplies when installing the hook. The hook
 * delegates every mutating member here; main.ts owns the render loop, pause
 * arbitration, audio unlock, and teardown.
 */
export interface HookControllers {
  play(): void;
  pause(): void;
  seek(timeMs: number): void;
  jumpToBeat(id: BeatId, offsetMs?: number): void;
  /** Valid only while paused; main.ts enforces that rule. */
  step(deltaMs: number): void;
  setSound(enabled: boolean): Promise<boolean>;
  renderStatic(beatId?: BeatId): void;
  dispose(): void;
  readonly readyPromise: Promise<void>;
  readonly snapshotSupplier: () => WorldSnapshot;
  readonly rendererInfoSupplier: () => RendererCounters;
  /**
   * Optional probe override. When absent, the built-in probe orchestration
   * below runs using beginFpsProbe/endFpsProbe and the members above.
   */
  readonly probeFps?: (options?: FpsProbeOptions) => Promise<FpsProbeResult>;
}

/** The readonly facade exposed as window.__diorama (plan section 11). */
export interface DioramaHook {
  readonly version: 1;
  readonly ready: Promise<void>;
  readonly durationMs: 90000;
  readonly beatIds: readonly string[];
  jumpToBeat(id: string, offsetMs?: number): void;
  seek(timeMs: number): void;
  step(deltaMs: number): void;
  play(): void;
  pause(): void;
  setSound(enabled: boolean): Promise<boolean>;
  snapshot(): DioramaSnapshot;
  probeFps(options?: FpsProbeOptions): Promise<FpsProbeResult>;
  renderStatic(beatId?: string): void;
  dispose(): void;
}

declare global {
  interface Window {
    __diorama?: DioramaHook;
  }
}

export interface Instrumentation {
  markReady(): void;
  markFailed(reason: string): void;
  setLifecycle(state: LifecycleState): void;
  setPlaying(playing: boolean): void;
  setVisibility(visible: boolean, intersecting: boolean): void;
  setSound(enabled: boolean): void;
  /** Call once per rendered frame. Cheap; no allocation outside probes. */
  recordFrame(frameMs: number, info: FrameInfo): void;
  /** Reset and start a probe window. Frames during warmup are discarded. */
  beginFpsProbe(options?: FpsProbeOptions): void;
  /** Finish the probe and compute mean/p95/max from the measured window. */
  endFpsProbe(): FpsProbeResult;
  /** Canonical snapshot from a world supplier (sorted, rounded, immutable). */
  snapshotFrom(supplier: () => WorldSnapshot): DioramaSnapshot;
  /** Install window.__diorama backed by the given controllers. */
  installHook(controllers: HookControllers): void;
  /** Latest mirrored status, for M09 diagnostics and tests. */
  getStatus(): InstrumentationStatus;
}

/** Mirror of the lifecycle flags M09 reports through the setters. */
export interface InstrumentationStatus {
  readonly lifecycle: LifecycleState;
  readonly playing: boolean;
  readonly visible: boolean;
  readonly intersecting: boolean;
  readonly soundEnabled: boolean;
  readonly ready: boolean;
  readonly failedReason: string | null;
  readonly hookInstalled: boolean;
  readonly disposed: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ROLLING_WINDOW = 240;
/** 5 s at 120 Hz plus headroom; one preallocated buffer reused per probe. */
const PROBE_WINDOW_MAX = 720;
const DEFAULT_WARMUP_MS = 1000;
const DEFAULT_PROBE_DURATION_MS = 5000;

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

const roundXYZ = (p: XYZ): XYZ => ({ x: round3(p.x), y: round3(p.y), z: round3(p.z) });

const roundActor = (actor: ActorSnapshot): ActorSnapshot => ({
  ...actor,
  position: roundXYZ(actor.position),
  yaw: round3(actor.yaw),
});

const roundProp = (prop: PropSnapshot): PropSnapshot => ({
  ...prop,
  position: roundXYZ(prop.position),
  yaw: round3(prop.yaw),
});

const byId = (a: { readonly actorId: string }, b: { readonly actorId: string }): number =>
  a.actorId < b.actorId ? -1 : a.actorId > b.actorId ? 1 : 0;

const byPropId = (a: { readonly propId: string }, b: { readonly propId: string }): number =>
  a.propId < b.propId ? -1 : a.propId > b.propId ? 1 : 0;

const normalizeTime = (timeMs: number): number =>
  ((timeMs % DURATION_MS) + DURATION_MS) % DURATION_MS;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const EMPTY_COUNTERS: RendererCounters = {
  dpr: 0,
  width: 0,
  height: 0,
  calls: 0,
  triangles: 0,
  points: 0,
  lines: 0,
  geometries: 0,
  textures: 0,
};

const emptyResult = (interrupted: boolean): FpsProbeResult => ({
  frames: 0,
  meanFps: 0,
  p95FrameMs: 0,
  maxFrameMs: 0,
  calls: 0,
  triangles: 0,
  dpr: 0,
  interrupted,
});

/** Pure nearest-rank p95 over a plain sample list. Zero samples yields 0. */
export function computePercentile95(samples: readonly number[]): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(0.95 * sorted.length) - 1));
  return sorted[index] ?? 0;
}

/**
 * Browser-free self-check for the p95 path: a synthetic 100-frame probe with
 * samples 0.01..1.00 ms must produce frames=100, p95=0.95, max=1. Throws on
 * any mismatch. Call from a node script or M09 smoke startup; no DOM needed.
 */
export function selfCheckPercentile95(): void {
  const samples: number[] = [];
  for (let i = 1; i <= 100; i += 1) samples.push(i / 100);
  if (computePercentile95(samples) !== 0.95) {
    throw new Error("computePercentile95 self-check failed");
  }

  const inst = createInstrumentation();
  inst.beginFpsProbe({ warmupMs: 0, durationMs: 60000 });
  const frame = { calls: 0, triangles: 0, points: 0, lines: 0 };
  for (let i = 1; i <= 100; i += 1) inst.recordFrame(i / 100, frame);
  const result = inst.endFpsProbe();
  if (result.frames !== 100 || result.p95FrameMs !== 0.95 || result.maxFrameMs !== 1) {
    throw new Error(
      `probe p95 self-check failed: frames=${result.frames} p95=${result.p95FrameMs} max=${result.maxFrameMs}`,
    );
  }
}

interface ProbeState {
  readonly warmupMs: number;
  readonly durationMs: number;
  readonly startedAt: number;
  windowStartedAt: number | null;
  windowClosedAt: number | null;
  frames: number;
  sumMs: number;
  maxMs: number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export function createInstrumentation(): Instrumentation {
  // Rolling frame-ms window, always maintained outside probes too.
  const rollingFrames = new Float64Array(ROLLING_WINDOW);
  let rollingHead = 0;
  let rollingCount = 0;

  // Probe buffers, allocated once and reused.
  const probeFrames = new Float64Array(PROBE_WINDOW_MAX);
  const probeScratch = new Float64Array(PROBE_WINDOW_MAX);

  let probe: ProbeState | null = null;
  let lifecycle: LifecycleState = "loading";
  let playing = false;
  let visible = true;
  let intersecting = true;
  let soundEnabled = false;
  let readyMarked = false;
  let failedReason: string | null = null;
  let hookInstalled = false;
  let disposed = false;
  let controllers: HookControllers | null = null;

  const currentCounters = (): RendererCounters =>
    controllers ? controllers.rendererInfoSupplier() : EMPTY_COUNTERS;

  const percentile95 = (count: number): number => {
    if (count === 0) return 0;
    // Copy the recorded samples into scratch, then sort that view in place.
    // probeScratch and probeFrames are distinct buffers; sorting without the
    // copy reads stale data (the p95 bug caught in final review).
    for (let i = 0; i < count; i += 1) probeScratch[i] = probeFrames[i] ?? 0;
    probeScratch.subarray(0, count).sort();
    const index = Math.min(count - 1, Math.max(0, Math.ceil(0.95 * count) - 1));
    return probeScratch[index] ?? 0;
  };

  const finishProbe = (): FpsProbeResult => {
    const active = probe;
    probe = null;
    if (!active) return emptyResult(true);
    const counters = currentCounters();
    if (active.frames === 0) return { ...emptyResult(true), dpr: counters.dpr };
    const durationSec =
      active.windowStartedAt !== null && active.windowClosedAt !== null
        ? (active.windowClosedAt - active.windowStartedAt) / 1000
        : 0;
    return {
      frames: active.frames,
      meanFps: durationSec > 0 ? active.frames / durationSec : 0,
      p95FrameMs: percentile95(Math.min(active.frames, PROBE_WINDOW_MAX)),
      maxFrameMs: round3(active.maxMs),
      calls: counters.calls,
      triangles: counters.triangles,
      dpr: counters.dpr,
      interrupted: disposed || failedReason !== null,
    };
  };

  /**
   * Built-in probe orchestration: pause, warm up while playing, measure,
   * pause, then restore prior time/pause/sound state even on failure.
   */
  const runProbe = async (options?: FpsProbeOptions): Promise<FpsProbeResult> => {
    const warmupMs = Math.max(0, Math.round(options?.warmupMs ?? DEFAULT_WARMUP_MS));
    const durationMs = Math.max(0, Math.round(options?.durationMs ?? DEFAULT_PROBE_DURATION_MS));
    const activeControllers = controllers;
    if (!activeControllers || disposed) return emptyResult(true);

    const before = activeControllers.snapshotSupplier();
    const priorTime = before.timeMs;
    const priorPlaying = before.playing;
    const priorSound = before.soundEnabled;

    let result: FpsProbeResult;
    try {
      activeControllers.pause();
      beginFpsProbe({ warmupMs, durationMs });
      activeControllers.play();
      await delay(warmupMs + durationMs + 250);
      activeControllers.pause();
      result = finishProbe();
    } catch {
      probe = null;
      result = emptyResult(true);
    } finally {
      if (!disposed) {
        activeControllers.seek(normalizeTime(priorTime));
        if (priorPlaying) activeControllers.play();
        try {
          await activeControllers.setSound(priorSound);
        } catch {
          // Restoring audio is best-effort; it may need a user gesture.
        }
      }
    }
    return { ...result, interrupted: result.interrupted || result.frames === 0 };
  };

  const beginFpsProbe = (options?: FpsProbeOptions): void => {
    probe = {
      warmupMs: Math.max(0, Math.round(options?.warmupMs ?? DEFAULT_WARMUP_MS)),
      durationMs: Math.max(0, Math.round(options?.durationMs ?? DEFAULT_PROBE_DURATION_MS)),
      startedAt: performance.now(),
      windowStartedAt: null,
      windowClosedAt: null,
      frames: 0,
      sumMs: 0,
      maxMs: 0,
    };
  };

  const buildHook = (hookControllers: HookControllers): DioramaHook => {
    const hook: DioramaHook = {
      version: 1,
      ready: hookControllers.readyPromise,
      durationMs: DURATION_MS,
      beatIds: BEAT_STARTS.map((beat) => beat.id as string),
      jumpToBeat(id: string, offsetMs?: number): void {
        const beat = BEAT_STARTS.find((entry) => entry.id === id);
        if (!beat) throw new RangeError(`Unknown beat id: ${id}`);
        const maxOffset = DURATION_MS - beat.startMs;
        const clamped = Math.min(maxOffset, Math.max(0, Math.round(offsetMs ?? 0)));
        hookControllers.jumpToBeat(beat.id, clamped);
      },
      seek(timeMs: number): void {
        hookControllers.seek(normalizeTime(timeMs));
      },
      step(deltaMs: number): void {
        hookControllers.step(Math.round(deltaMs));
      },
      play(): void {
        hookControllers.play();
      },
      pause(): void {
        hookControllers.pause();
      },
      setSound(enabled: boolean): Promise<boolean> {
        return hookControllers.setSound(enabled);
      },
      snapshot(): DioramaSnapshot {
        return snapshotFrom(hookControllers.snapshotSupplier);
      },
      probeFps(options?: FpsProbeOptions): Promise<FpsProbeResult> {
        if (hookControllers.probeFps) return hookControllers.probeFps(options);
        return runProbe(options);
      },
      renderStatic(beatId?: string): void {
        hookControllers.renderStatic((beatId ?? "celebration") as BeatId);
      },
      dispose(): void {
        if (disposed) return;
        disposed = true;
        lifecycle = "disposed";
        playing = false;
        hookControllers.dispose();
      },
    };
    return hook;
  };

  const snapshotFrom = (supplier: () => WorldSnapshot): DioramaSnapshot => {
    const source = supplier();
    const isDisposed = disposed || source.lifecycle === "disposed";
    return {
      ...source,
      lifecycle: isDisposed ? "disposed" : source.lifecycle,
      playing: isDisposed ? false : source.playing,
      camera: {
        ...source.camera,
        position: roundXYZ(source.camera.position),
        target: roundXYZ(source.camera.target),
      },
      actors: [...source.actors].sort(byId).map(roundActor),
      props: [...source.props].sort(byPropId).map(roundProp),
      renderer: currentCounters(),
    };
  };

  return {
    markReady(): void {
      readyMarked = true;
    },
    markFailed(reason: string): void {
      if (failedReason === null) failedReason = reason;
    },
    setLifecycle(state: LifecycleState): void {
      lifecycle = state;
    },
    setPlaying(isPlaying: boolean): void {
      playing = isPlaying;
    },
    setVisibility(isVisible: boolean, isIntersecting: boolean): void {
      visible = isVisible;
      intersecting = isIntersecting;
    },
    setSound(enabled: boolean): void {
      soundEnabled = enabled;
    },
    recordFrame(frameMs: number, info: FrameInfo): void {
      if (!Number.isFinite(frameMs) || frameMs < 0) return;
      rollingFrames[rollingHead] = frameMs;
      rollingHead = (rollingHead + 1) % ROLLING_WINDOW;
      if (rollingCount < ROLLING_WINDOW) rollingCount += 1;
      void info;

      const active = probe;
      if (!active) return;
      const now = performance.now();
      if (active.windowClosedAt !== null) return;
      if (active.windowStartedAt === null) {
        if (now - active.startedAt < active.warmupMs) return;
        active.windowStartedAt = now;
      }
      if (now - active.windowStartedAt >= active.durationMs) {
        active.windowClosedAt = now;
        return;
      }
      active.frames += 1;
      active.sumMs += frameMs;
      if (frameMs > active.maxMs) active.maxMs = frameMs;
      if (active.frames <= PROBE_WINDOW_MAX) probeFrames[active.frames - 1] = frameMs;
    },
    beginFpsProbe,
    endFpsProbe: finishProbe,
    snapshotFrom,
    installHook(hookControllers: HookControllers): void {
      if (hookInstalled) throw new Error("installHook called twice");
      hookInstalled = true;
      controllers = hookControllers;
      window.__diorama = buildHook(hookControllers);
    },
    getStatus(): InstrumentationStatus {
      return {
        lifecycle,
        playing,
        visible,
        intersecting,
        soundEnabled,
        ready: readyMarked,
        failedReason,
        hookInstalled,
        disposed,
      };
    },
  };
}
