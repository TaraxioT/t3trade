/**
 * Howler audio: starts muted, subtle cues only. Owner: UI worker.
 *
 * Semantic cue names are stable so the director can call play(CUES.approve)
 * without knowing file names. Master volume 0.5. Playback is throttled three
 * ways: per file (150 ms), per category (foley/tool/authority/comic/ui), and
 * a global simultaneous-voice cap so stories cannot stack into noise. When
 * the voice cap would overflow, the lowest-priority live voice is dropped
 * instead of the new cue (authority/execution outrank tool, which outranks
 * foley/comic; ui is its own user-intent track).
 *
 * Spatial playback: stories call cueAt(cue, worldPoint); a spatial resolver
 * registered by main.ts derives pan/volume from the live camera, and the
 * registered source hook is fired only when playback was actually accepted,
 * so visual pulses never appear for muted or dropped cues. Pan support
 * (-1..1), per-instance volume attenuation, and deterministic rate variation
 * keep repeated cues organic without randomness. Lazily preloads on first
 * enable.
 */
import { Howl, Howler } from "howler";

/** Semantic cue names (stable contract for systems/director.ts and stories). */
export const CUES = {
  packet: "packet",
  tool: "tool",
  approve: "approve",
  reject: "reject",
  execute: "execute",
  ack: "ack",
  warn: "warn",
  vault: "vault",
  stamp: "stamp",
  lever: "lever",
  print: "print",
  recover: "recover",
  select: "select",
  bump: "bump",
  skid: "skid",
  cart: "cart",
  celebrate2: "celebrate2",
  door: "door",
} as const;

export type Cue = (typeof CUES)[keyof typeof CUES];

/** Sound families used for per-category cooldowns and visual coupling. */
export type CueCategory = "foley" | "tool" | "authority" | "comic" | "ui";

const CATEGORY_COOLDOWN_MS: Record<CueCategory, number> = {
  authority: 400,
  tool: 300,
  foley: 250,
  comic: 500,
  ui: 150,
};

const CATEGORY_OF: Record<Cue, CueCategory> = {
  packet: "foley",
  skid: "foley",
  door: "foley",
  tool: "tool",
  lever: "tool",
  print: "tool",
  recover: "tool",
  approve: "authority",
  reject: "authority",
  execute: "authority",
  ack: "authority",
  vault: "authority",
  stamp: "authority",
  warn: "authority",
  bump: "comic",
  cart: "comic",
  celebrate2: "comic",
  select: "ui",
};

/**
 * Voice priority under overlap. Bands: ui 60 (user intent, never evicted by
 * world noise) > authority/execution 32..42 > tool 20..24 > foley/comic
 * 8..12. Inside a band, execution outranks settlement (execute > ack) and
 * warn sits lowest of authority so the long bell yields first.
 */
const PRIORITY_OF: Record<Cue, number> = {
  select: 60,
  execute: 42,
  reject: 40,
  approve: 38,
  vault: 36,
  ack: 34,
  stamp: 34,
  warn: 32,
  lever: 24,
  recover: 24,
  tool: 22,
  print: 20,
  skid: 12,
  celebrate2: 12,
  door: 12,
  bump: 10,
  packet: 10,
  cart: 8,
};

const BASE = "/diorama/audio";

/** cue -> { file, volume, durMs (afinfo), rateBase? }. */
interface CueMapEntry {
  file: string;
  volume: number;
  /** Approximate sample duration in ms (afinfo); drives visual pulse life. */
  durMs: number;
  /**
   * Deterministic pitch offset for cues that must share a sample with a
   * different semantic action. `recover` reuses lever-1 at 0.82 so the two
   * rate ranges never overlap (lever 0.92..1.08, recover 0.75..0.89) and the
   * shared sample is unmistakable in pitch.
   */
  rateBase?: number;
}

const CUE_MAP: Record<Cue, CueMapEntry> = {
  packet: { file: "chirp-1", volume: 0.2, durMs: 120 },
  tool: { file: "scan-1", volume: 0.25, durMs: 400 },
  approve: { file: "celebrate-1", volume: 0.4, durMs: 350 },
  reject: { file: "reject-buzz-1", volume: 0.35, durMs: 350 },
  execute: { file: "tube-whoosh-1", volume: 0.4, durMs: 500 },
  ack: { file: "ping-1", volume: 0.25, durMs: 280 },
  warn: { file: "bell-1", volume: 0.22, durMs: 1800 },
  vault: { file: "vault-clunk-1", volume: 0.4, durMs: 500 },
  stamp: { file: "stamp-1", volume: 0.35, durMs: 180 },
  lever: { file: "lever-1", volume: 0.3, durMs: 450 },
  print: { file: "squeak-2", volume: 0.25, durMs: 150 },
  recover: { file: "lever-1", volume: 0.3, durMs: 450, rateBase: 0.82 },
  select: { file: "ping-2", volume: 0.3, durMs: 280 },
  bump: { file: "squeak-1", volume: 0.3, durMs: 120 },
  skid: { file: "chirp-2", volume: 0.25, durMs: 140 },
  cart: { file: "squeak-3", volume: 0.3, durMs: 180 },
  celebrate2: { file: "celebrate-2", volume: 0.4, durMs: 450 },
  door: { file: "chirp-3", volume: 0.25, durMs: 160 },
};

const MASTER_VOLUME = 0.5;
const REPLAY_GAP_MS = 150;
/**
 * Practical simultaneous-voice cap. Four keeps overlapping cues readable at
 * this library's short durations; overflow evicts instead of refusing.
 */
const MAX_VOICES = 4;

/** Deterministic rate variation range: +/- 8 percent. */
const RATE_SPREAD = 0.08;

export interface PlayOptions {
  /** Stereo pan, -1 (left) to 1 (right). Clamped; 0 is centered. */
  pan?: number;
  /** Per-instance volume multiplier (0..1) on top of the cue volume. Default 1. */
  volume?: number;
  /** Fires once when this instance actually starts sounding (Howler "play"
   * event for its id), never on play error or stop-before-play. The visual
   * source cue binds to this so it cannot pulse for a sound that never
   * starts despite play() returning an id. */
  onSounded?: () => void;
}

/** World-space point a cue originates from (station or agent anchor). */
export type WorldPoint = { x: number; y: number };

/**
 * Derives spatial playback parameters from the live camera. Returning null
 * (or throwing) falls back to centered playback at the cue's own volume.
 */
export type SpatialResolver = (world: WorldPoint) => { pan: number; volume: number } | null;

/** Notified when a cue is actually accepted, so a visual pulse can follow. */
export type SourceHook = (world: WorldPoint, cue: string) => void;

/** Playback metadata shared with the visual source-cue layer. */
export interface CueInfo {
  category: CueCategory;
  priority: number;
  /** Approximate sample duration in ms (afinfo). */
  approxMs: number;
}

/** Cue metadata for visual coupling; null for unknown cue names. */
export function cueInfo(cue: string): CueInfo | null {
  const key = cue as Cue;
  const entry = CUE_MAP[key];
  if (!entry) return null;
  return { category: CATEGORY_OF[key], priority: PRIORITY_OF[key], approxMs: entry.durMs };
}

export interface AudioController {
  /** Play a cue; returns true only when playback was accepted. */
  play(cue: string, opts?: PlayOptions): boolean;
  setEnabled(enabled: boolean): void;
  /** Unload every Howl and drop the module reference. Safe to call twice. */
  destroy(): void;
}

/** Module-level reference so stories can fire cues without main.ts plumbing. */
let current: AudioController | null = null;

/** Spatial resolution and accepted-playback hooks; registered by main.ts. */
let spatialResolver: SpatialResolver | null = null;
let sourceHook: SourceHook | null = null;

/** Register (or clear) the camera-backed spatial resolver used by cueAt. */
export function registerSpatialResolver(fn: SpatialResolver | null): void {
  spatialResolver = fn;
}

/** Register (or clear) the accepted-playback hook used by cueAt. */
export function registerSourceHook(fn: SourceHook | null): void {
  sourceHook = fn;
}

/** Toggle the live controller from the HUD (idempotent when none exists). */
export function setDioramaAudioEnabled(enabled: boolean): void {
  current?.setEnabled(enabled);
}

/** Play a cue on the live controller (no-op while muted or missing). */
export function playDioramaCue(cue: string, opts?: PlayOptions): boolean {
  return current?.play(cue, opts) ?? false;
}

/**
 * Play a cue from a world point: resolve pan/volume through the registered
 * spatial resolver, play with the cue's priority, and on accepted playback
 * fire the registered source hook with the same point. Without a resolver
 * (or when it yields nothing) playback is centered. The hook never fires
 * for muted, throttled, unknown, or cap-refused cues, so visual source
 * cues cannot appear without sound.
 */
export function cueAt(cue: string, world: WorldPoint): void {
  let spatial: { pan: number; volume: number } | null = null;
  if (spatialResolver) {
    try {
      spatial = spatialResolver(world);
    } catch {
      spatial = null; // Camera not ready; centered fallback, never a throw.
    }
  }
  // The source hook fires from the play() callback only when the sound
  // actually starts, so a late load or play error cannot produce a phantom
  // pulse for an accepted-but-silent cue.
  current?.play(cue, {
    pan: spatial?.pan,
    volume: spatial?.volume,
    onSounded: () => sourceHook?.(world, cue),
  });
}

export function createAudio(): AudioController {
  let enabled = false;
  let loaded = false;
  let destroyed = false;
  /** Deterministic playback counter driving per-call rate variation. */
  let callCounter = 0;
  /** Global Howler volume before preload changed it; restored on destroy so
   * the diorama never leaves its fingerprint on unrelated route audio. */
  let priorHowlerVolume: number | null = null;
  const sounds = new Map<string, Howl>();
  /** Files whose audio failed to load; playing them would never settle. */
  const brokenFiles = new Set<string>();
  const lastPlayed = new Map<string, number>();
  const lastCategoryPlay = new Map<CueCategory, number>();
  /** Live playback ids with their cue priority. Size is the voice count. */
  const activeIds = new Map<number, { howl: Howl; priority: number }>();

  /** Settle one voice on any terminal path: natural end, stop, or error. */
  const releaseVoice = (howl: Howl, id: number): void => {
    // Only release ids we are still tracking; Howler ids can be reused after
    // a sound ends, so a stale event for a reused id must not free a slot.
    const voice = activeIds.get(id);
    if (!voice || voice.howl !== howl) return;
    activeIds.delete(id);
  };

  const preload = (): void => {
    if (loaded) return;
    loaded = true;
    for (const { file } of Object.values(CUE_MAP)) {
      if (sounds.has(file)) continue;
      const howl = new Howl({
        src: [`${BASE}/${file}.wav`],
        volume: 0,
        // Web Audio unlocks on the first user gesture via Howler.ctx.
        html5: false,
      });
      // Keep the simultaneous-voice count honest on every settle path.
      howl.on("end", (id: number) => releaseVoice(howl, id));
      howl.on("stop", (id: number) => releaseVoice(howl, id));
      howl.on("playerror", (id: number) => releaseVoice(howl, id));
      howl.on("loaderror", () => {
        brokenFiles.add(file);
        // Any ids still tracked against this howl will never sound.
        for (const [id, voice] of activeIds) {
          if (voice.howl === howl) activeIds.delete(id);
        }
      });
      sounds.set(file, howl);
    }
    if (priorHowlerVolume === null) priorHowlerVolume = Howler.volume();
    Howler.volume(MASTER_VOLUME);
  };

  /**
   * Deterministic rate in [1 - RATE_SPREAD, 1 + RATE_SPREAD]: a fixed
   * pseudo-random walk over the call counter, no Math.random.
   */
  const nextRate = (): number => {
    callCounter += 1;
    const step = (callCounter * 7) % 5; // 0..4, cycles without repeating pairs
    return 1 + (step / 4) * (2 * RATE_SPREAD) - RATE_SPREAD;
  };

  /**
   * Free a voice slot for an incoming cue by stopping the lowest-priority
   * live voice. Returns false when every live voice outranks the newcomer,
   * in which case the new cue is refused instead.
   */
  const evictLowest = (priority: number): boolean => {
    let evictId: number | null = null;
    let evictPriority = Infinity;
    for (const [id, voice] of activeIds) {
      if (voice.priority < evictPriority) {
        evictPriority = voice.priority;
        evictId = id;
      }
    }
    if (evictId === null || evictPriority >= priority) return false;
    const voice = activeIds.get(evictId);
    if (!voice) return false;
    activeIds.delete(evictId);
    // releaseVoice re-fires via the stop event but is guarded by identity.
    voice.howl.stop(evictId);
    return true;
  };

  const controller: AudioController = {
    setEnabled(on): void {
      enabled = on;
      if (!on) {
        // Immediate silence: stop every live voice now, not just future ones.
        for (const [id, voice] of activeIds) {
          voice.howl.stop(id);
        }
        activeIds.clear();
        return;
      }
      preload();
      // Resume a suspended AudioContext; the HUD click is a valid gesture.
      const ctx = Howler.ctx;
      if (ctx && ctx.state !== "running") void ctx.resume();
    },
    play(cue, opts): boolean {
      if (!enabled || destroyed) return false;
      const entry = CUE_MAP[cue as Cue];
      if (!entry) return false;
      if (brokenFiles.has(entry.file)) return false;
      const now = performance.now();
      const last = lastPlayed.get(entry.file) ?? -Infinity;
      if (now - last < REPLAY_GAP_MS) return false;
      const category = CATEGORY_OF[cue as Cue];
      const lastCat = lastCategoryPlay.get(category) ?? -Infinity;
      if (now - lastCat < CATEGORY_COOLDOWN_MS[category]) return false;
      const priority = PRIORITY_OF[cue as Cue];
      while (activeIds.size >= MAX_VOICES) {
        if (!evictLowest(priority)) return false;
      }
      preload();
      const howl = sounds.get(entry.file);
      if (!howl) return false;
      const id = howl.play();
      // Cooldowns are committed only once a playback id exists: a failed play
      // must not buy silence for later attempts.
      lastPlayed.set(entry.file, now);
      lastCategoryPlay.set(category, now);
      const volumeMult =
        typeof opts?.volume === "number" && Number.isFinite(opts.volume)
          ? Math.max(0, Math.min(1, opts.volume))
          : 1;
      howl.volume(Math.max(0, Math.min(1, entry.volume * volumeMult)), id);
      howl.rate(entry.rateBase === undefined ? nextRate() : entry.rateBase * nextRate(), id);
      if (typeof opts?.pan === "number" && Number.isFinite(opts.pan)) {
        howl.stereo(Math.max(-1, Math.min(1, opts.pan)), id);
      }
      activeIds.set(id, { howl, priority });
      if (opts?.onSounded) {
        const sounded = opts.onSounded;
        const onPlay = (pid: number): void => {
          if (pid !== id) return;
          detach();
          sounded();
        };
        const onNever = (pid: number): void => {
          if (pid !== id) return;
          detach();
        };
        const detach = (): void => {
          howl.off("play", onPlay);
          howl.off("playerror", onNever);
          howl.off("stop", onNever);
        };
        howl.on("play", onPlay);
        howl.on("playerror", onNever);
        howl.on("stop", onNever);
      }
      return true;
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      for (const howl of sounds.values()) {
        howl.stop();
        howl.unload();
      }
      sounds.clear();
      brokenFiles.clear();
      activeIds.clear();
      lastPlayed.clear();
      lastCategoryPlay.clear();
      // Restore the global volume preload changed so teardown leaves no
      // fingerprint on unrelated route audio. Leave Howler.ctx to Howler's
      // own global lifecycle; unloading every Howl is enough for the
      // diorama to stop producing sound.
      if (priorHowlerVolume !== null) {
        Howler.volume(priorHowlerVolume);
        priorHowlerVolume = null;
      }
      if (current === controller) current = null;
    },
  };

  current = controller;
  return controller;
}
