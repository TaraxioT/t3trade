/**
 * Howler audio: starts muted, subtle cues only. Owner: UI worker.
 *
 * Semantic cue names are stable so the director can call play(CUES.approve)
 * without knowing file names. Master volume 0.5. Playback is throttled three
 * ways: per file (150 ms), per category (foley/tool/authority/comic/ui), and
 * a global simultaneous-voice cap so stories cannot stack into noise.
 * Pan support (-1..1) and deterministic rate variation keep repeated cues
 * organic without randomness. Lazily preloads on first enable.
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

/** Sound families used for per-category cooldowns. */
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

const BASE = "/diorama/audio";

/** cue -> { file, volume } */
const CUE_MAP: Record<Cue, { file: string; volume: number }> = {
  packet: { file: "chirp-1", volume: 0.2 },
  tool: { file: "scan-1", volume: 0.25 },
  approve: { file: "celebrate-1", volume: 0.4 },
  reject: { file: "reject-buzz-1", volume: 0.35 },
  execute: { file: "tube-whoosh-1", volume: 0.4 },
  ack: { file: "ping-1", volume: 0.25 },
  warn: { file: "bell-1", volume: 0.25 },
  vault: { file: "vault-clunk-1", volume: 0.4 },
  stamp: { file: "stamp-1", volume: 0.35 },
  lever: { file: "lever-1", volume: 0.3 },
  print: { file: "squeak-2", volume: 0.25 },
  recover: { file: "lever-1", volume: 0.3 },
  select: { file: "ping-2", volume: 0.3 },
  bump: { file: "squeak-1", volume: 0.3 },
  skid: { file: "chirp-2", volume: 0.25 },
  cart: { file: "squeak-3", volume: 0.3 },
  celebrate2: { file: "celebrate-2", volume: 0.4 },
  door: { file: "chirp-3", volume: 0.25 },
};

const MASTER_VOLUME = 0.5;
const REPLAY_GAP_MS = 150;
const MAX_VOICES = 6;

/** Deterministic rate variation range: +/- 8 percent. */
const RATE_SPREAD = 0.08;

export interface PlayOptions {
  /** Stereo pan, -1 (left) to 1 (right). Clamped; 0 is centered. */
  pan?: number;
}

export interface AudioController {
  play(cue: string, opts?: PlayOptions): void;
  setEnabled(enabled: boolean): void;
  /** Unload every Howl and drop the module reference. Safe to call twice. */
  destroy(): void;
}

/** Module-level reference so stories can fire cues without main.ts plumbing. */
let current: AudioController | null = null;

/** Toggle the live controller from the HUD (idempotent when none exists). */
export function setDioramaAudioEnabled(enabled: boolean): void {
  current?.setEnabled(enabled);
}

/** Play a cue on the live controller (no-op while muted or missing). */
export function playDioramaCue(cue: string, opts?: PlayOptions): void {
  current?.play(cue, opts);
}

export function createAudio(): AudioController {
  let enabled = false;
  let loaded = false;
  let destroyed = false;
  /** Deterministic playback counter driving per-call rate variation. */
  let callCounter = 0;
  let activeVoices = 0;
  const sounds = new Map<string, Howl>();
  const lastPlayed = new Map<string, number>();
  const lastCategoryPlay = new Map<CueCategory, number>();

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
      // Keep the simultaneous-voice count honest as sounds finish.
      howl.on("end", () => {
        activeVoices = Math.max(0, activeVoices - 1);
      });
      sounds.set(file, howl);
    }
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

  const controller: AudioController = {
    setEnabled(on): void {
      enabled = on;
      if (!on) return;
      preload();
      // Resume a suspended AudioContext; the HUD click is a valid gesture.
      const ctx = Howler.ctx;
      if (ctx && ctx.state !== "running") void ctx.resume();
    },
    play(cue, opts): void {
      if (!enabled || destroyed) return;
      const entry = CUE_MAP[cue as Cue];
      if (!entry) return;
      const now = performance.now();
      const last = lastPlayed.get(entry.file) ?? -Infinity;
      if (now - last < REPLAY_GAP_MS) return;
      const category = CATEGORY_OF[cue as Cue];
      const lastCat = lastCategoryPlay.get(category) ?? -Infinity;
      if (now - lastCat < CATEGORY_COOLDOWN_MS[category]) return;
      if (activeVoices >= MAX_VOICES) return;
      lastPlayed.set(entry.file, now);
      lastCategoryPlay.set(category, now);
      preload();
      const howl = sounds.get(entry.file);
      if (!howl) return;
      const id = howl.play();
      howl.volume(entry.volume, id);
      howl.rate(nextRate(), id);
      if (typeof opts?.pan === "number" && Number.isFinite(opts.pan)) {
        howl.stereo(Math.max(-1, Math.min(1, opts.pan)), id);
      }
      activeVoices += 1;
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      for (const howl of sounds.values()) {
        howl.stop();
        howl.unload();
      }
      sounds.clear();
      lastPlayed.clear();
      lastCategoryPlay.clear();
      activeVoices = 0;
      // Leave Howler.ctx to Howler's own global lifecycle; unloading every
      // Howl is enough for the diorama to stop producing sound.
      if (current === controller) current = null;
    },
  };

  current = controller;
  return controller;
}
