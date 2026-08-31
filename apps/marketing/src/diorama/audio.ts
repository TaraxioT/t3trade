/**
 * Lazy single-sprite SFX (plan section 10).
 *
 * Nothing is synthesized, decoded, or created until the first successful
 * setEnabled(true) from a user gesture. One mono 16-bit 22050 Hz PCM WAV is
 * synthesized deterministically (SEEDS.audioNoise + oscillators, never
 * Math.random), base64-encoded into a data URI, and loaded into ONE Howl
 * with sprite windows per cue. Failures degrade to a silent no-op and never
 * throw into the story. No background score, no spatial audio, no loops.
 */

import { Howl, Howler } from "howler";
import { SEEDS } from "./config";
import { clamp, createRng, type Rng } from "./math";
import type { CueId } from "./types";

// ---------------------------------------------------------------------------
// Cue vocabulary (<= 9 cues). types.ts defines CueId as an opaque branded
// string, so the concrete union lives here and the director maps onto it.
// ---------------------------------------------------------------------------

export type AudioCue =
  | "stamp" // low thunk: stamp approve
  | "reject" // buzzer: stamp reject / reject chute
  | "ping" // mint chime: approve tick, exchange pulse
  | "whoosh" // cannon / order pipe
  | "tick" // receipt / keyboard
  | "clack" // crate collision / pole pile-up
  | "pop" // confetti
  | "bongo"; // conga double hit

export const AUDIO_CUES: readonly AudioCue[] = [
  "stamp",
  "reject",
  "ping",
  "whoosh",
  "tick",
  "clack",
  "pop",
  "bongo",
];

export const isAudioCue = (value: string): value is AudioCue =>
  (AUDIO_CUES as readonly string[]).includes(value);

/** Sprite window per cue: [offsetMs, durationMs]. */
const SAMPLE_RATE = 22050;
const SPRITE: Readonly<Record<AudioCue, readonly [number, number]>> = {
  stamp: [0, 200],
  reject: [300, 320],
  ping: [700, 420],
  whoosh: [1200, 480],
  tick: [1800, 120],
  clack: [2000, 140],
  pop: [2200, 180],
  bongo: [2500, 420],
};
const TOTAL_MS = 3050;
const TOTAL_SAMPLES = Math.ceil((TOTAL_MS / 1000) * SAMPLE_RATE);

// ---------------------------------------------------------------------------
// Audio system contract
// ---------------------------------------------------------------------------

export interface AudioPlayOptions {
  /** Multiplier on the cue volume (default 1); clamped to [0, 1] overall. */
  readonly volumeScale?: number;
}

export interface AudioSystem {
  /**
   * Enable/disable sound. The first enable synthesizes the sprite, creates
   * and unlocks the Howl inside the user-gesture task, and persists the
   * choice. Resolves false on any synthesis/decode/autoplay failure; the
   * system degrades to a no-op rather than throwing.
   */
  setEnabled(enabled: boolean): Promise<boolean>;
  /** Last persisted state; true only after a successful enable. */
  isEnabled(): boolean;
  /** Play a cue; silent no-op when disabled, locked, or unknown. */
  play(cue: CueId | AudioCue, opts?: AudioPlayOptions): void;
  /** Stop every playing sprite immediately. */
  stopAll(): void;
  /** Unload the Howl and drop all state; idempotent. */
  dispose(): void;
}

const STORAGE_KEY = "t3diorama-sound";

const readStored = (): boolean => {
  try {
    return globalThis.sessionStorage?.getItem(STORAGE_KEY) === "1";
  } catch {
    return false; // privacy mode: treat as unset
  }
};

const writeStored = (value: boolean): void => {
  try {
    globalThis.sessionStorage?.setItem(STORAGE_KEY, value ? "1" : "0");
  } catch {
    // Persistence is best-effort; never fail the toggle over storage.
  }
};

// ---------------------------------------------------------------------------
// Deterministic synthesis
// ---------------------------------------------------------------------------

const synthStamp = (out: Float32Array, start: number, rng: Rng): void => {
  const n = Math.floor(0.2 * SAMPLE_RATE);
  for (let i = 0; i < n; i += 1) {
    const t = i / SAMPLE_RATE;
    const env = Math.exp(-t * 28);
    const thud = Math.sin(2 * Math.PI * 118 * t) * 0.9 + Math.sin(2 * Math.PI * 62 * t) * 0.5;
    const click = (rng.next() * 2 - 1) * Math.exp(-t * 140) * 0.5;
    out[start + i] += (thud * env + click) * 0.8;
  }
};

const synthReject = (out: Float32Array, start: number): void => {
  const n = Math.floor(0.32 * SAMPLE_RATE);
  for (let i = 0; i < n; i += 1) {
    const t = i / SAMPLE_RATE;
    const env = Math.min(1, t * 80) * Math.exp(-t * 9);
    // Square-ish buzz: odd harmonics of 96 Hz.
    const buzz =
      Math.sin(2 * Math.PI * 96 * t) * 0.6 +
      Math.sin(2 * Math.PI * 288 * t) * 0.3 +
      Math.sin(2 * Math.PI * 480 * t) * 0.15;
    out[start + i] += buzz * env * 0.55;
  }
};

const synthPing = (out: Float32Array, start: number): void => {
  const n = Math.floor(0.42 * SAMPLE_RATE);
  for (let i = 0; i < n; i += 1) {
    const t = i / SAMPLE_RATE;
    const env = Math.exp(-t * 7);
    out[start + i] +=
      (Math.sin(2 * Math.PI * 1318 * t) * 0.55 +
        Math.sin(2 * Math.PI * 1976 * t) * 0.25 * Math.exp(-t * 11) +
        Math.sin(2 * Math.PI * 2637 * t) * 0.1 * Math.exp(-t * 16)) *
      env *
      0.7;
  }
};

const synthWhoosh = (out: Float32Array, start: number, rng: Rng): void => {
  const n = Math.floor(0.48 * SAMPLE_RATE);
  // Seeded noise swept through a one-pole low-pass whose cutoff rises then falls.
  let lp = 0;
  for (let i = 0; i < n; i += 1) {
    const t = i / SAMPLE_RATE;
    const u = t / 0.48;
    const env = Math.sin(Math.PI * Math.min(1, u)) ** 2;
    const cutoff = 0.04 + 0.3 * Math.sin(Math.PI * Math.min(1, u));
    lp += cutoff * (rng.next() * 2 - 1 - lp);
    out[start + i] += lp * env * 1.1;
  }
};

const synthTick = (out: Float32Array, start: number, rng: Rng): void => {
  const n = Math.floor(0.12 * SAMPLE_RATE);
  for (let i = 0; i < n; i += 1) {
    const t = i / SAMPLE_RATE;
    const env = Math.exp(-t * 90);
    out[start + i] +=
      (Math.sin(2 * Math.PI * 3900 * t) * 0.5 + (rng.next() * 2 - 1) * 0.4) * env * 0.5;
  }
};

const synthClack = (out: Float32Array, start: number, rng: Rng): void => {
  const n = Math.floor(0.14 * SAMPLE_RATE);
  for (let i = 0; i < n; i += 1) {
    const t = i / SAMPLE_RATE;
    const env = Math.exp(-t * 55);
    out[start + i] +=
      (Math.sin(2 * Math.PI * 860 * t) * 0.6 +
        Math.sin(2 * Math.PI * 1720 * t) * 0.2 +
        (rng.next() * 2 - 1) * 0.35) *
      env *
      0.7;
  }
};

const synthPop = (out: Float32Array, start: number): void => {
  const n = Math.floor(0.18 * SAMPLE_RATE);
  for (let i = 0; i < n; i += 1) {
    const t = i / SAMPLE_RATE;
    const env = Math.exp(-t * 40);
    const freq = 340 - 200 * Math.min(1, t / 0.05); // quick pitch drop
    out[start + i] += Math.sin(2 * Math.PI * freq * t) * env * 0.8;
  }
};

const synthBongo = (out: Float32Array, start: number): void => {
  const n = Math.floor(0.42 * SAMPLE_RATE);
  const hit = (from: number, freq: number, when: number): void => {
    const len = Math.min(n - from, Math.floor(0.16 * SAMPLE_RATE));
    for (let i = 0; i < len; i += 1) {
      const t = i / SAMPLE_RATE;
      const env = Math.exp(-t * 22);
      out[start + from + i] += Math.sin(2 * Math.PI * freq * t) * env * 0.8;
    }
    void when;
  };
  hit(0, 205, 0);
  hit(Math.floor(0.16 * SAMPLE_RATE), 155, 160);
};

/** Render the full sprite buffer once. Deterministic: fixed order, seeded noise. */
const synthesizeSprite = (): Float32Array => {
  const buf = new Float32Array(TOTAL_SAMPLES);
  const rng = createRng(SEEDS.audioNoise);
  synthStamp(buf, sampleOffset(SPRITE.stamp[0]), rng);
  synthReject(buf, sampleOffset(SPRITE.reject[0]));
  synthPing(buf, sampleOffset(SPRITE.ping[0]));
  synthWhoosh(buf, sampleOffset(SPRITE.whoosh[0]), rng);
  synthTick(buf, sampleOffset(SPRITE.tick[0]), rng);
  synthClack(buf, sampleOffset(SPRITE.clack[0]), rng);
  synthPop(buf, sampleOffset(SPRITE.pop[0]));
  synthBongo(buf, sampleOffset(SPRITE.bongo[0]));
  // Guard against inter-cue bleed into following windows.
  for (let i = 0; i < TOTAL_SAMPLES; i += 1) {
    buf[i] = clamp(buf[i], -1, 1);
  }
  return buf;
};

const sampleOffset = (ms: number): number => Math.floor((ms / 1000) * SAMPLE_RATE);

/** Encode mono 16-bit PCM WAV, returned as a base64 data URI. */
const encodeWavDataUri = (samples: Float32Array): string => {
  const dataBytes = samples.length * 2;
  const wav = new Uint8Array(44 + dataBytes);
  const writeAscii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) wav[offset + i] = text.charCodeAt(i);
  };
  const writeU32 = (offset: number, value: number): void => {
    wav[offset] = value & 0xff;
    wav[offset + 1] = (value >>> 8) & 0xff;
    wav[offset + 2] = (value >>> 16) & 0xff;
    wav[offset + 3] = (value >>> 24) & 0xff;
  };
  const writeU16 = (offset: number, value: number): void => {
    wav[offset] = value & 0xff;
    wav[offset + 1] = (value >>> 8) & 0xff;
  };
  writeAscii(0, "RIFF");
  writeU32(4, 36 + dataBytes);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  writeU32(16, 16);
  writeU16(20, 1); // PCM
  writeU16(22, 1); // mono
  writeU32(24, SAMPLE_RATE);
  writeU32(28, SAMPLE_RATE * 2); // byte rate
  writeU16(32, 2); // block align
  writeU16(34, 16); // bits per sample
  writeAscii(36, "data");
  writeU32(40, dataBytes);
  for (let i = 0; i < samples.length; i += 1) {
    const s = clamp(samples[i], -1, 1);
    const v = s < 0 ? s * 0x8000 : s * 0x7fff;
    const j = 44 + i * 2;
    wav[j] = v & 0xff;
    wav[j + 1] = (v >> 8) & 0xff;
  }
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < wav.length; i += chunkSize) {
    binary += String.fromCharCode(...wav.subarray(i, i + chunkSize));
  }
  return `data:audio/wav;base64,${btoa(binary)}`;
};

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

export function createAudio(): AudioSystem {
  let enabled = false;
  let failed = false;
  let howl: Howl | null = null;
  let disposed = false;
  let pendingEnable: Promise<boolean> | null = null;

  const loadHowl = async (): Promise<Howl | null> => {
    const dataUri = encodeWavDataUri(synthesizeSprite());
    const sprite: Record<string, [number, number]> = {};
    for (const cue of AUDIO_CUES) {
      const [offset, duration] = SPRITE[cue];
      sprite[cue] = [offset, duration];
    }
    return new Promise<Howl | null>((resolve) => {
      const h = new Howl({ src: [dataUri], format: ["wav"], sprite, volume: 0.9 });
      let settled = false;
      const finish = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        h.off("load");
        h.off("loaderror");
        resolve(ok ? h : null);
      };
      h.once("load", () => finish(true));
      h.once("loaderror", () => finish(false));
      if (h.state() === "loaded") finish(true);
      // Howler unlocks on the first user gesture; this call chain runs inside one.
      const ctx = Howler.ctx;
      if (ctx && ctx.state !== "running") {
        void ctx.resume().catch(() => {
          /* autoplay refusal surfaces as a silent no-op, never a throw */
        });
      }
      // Decode safety net: a stalled data-URI load must not hang the toggle.
      globalThis.setTimeout(() => finish(h.state() === "loaded"), 4000);
    });
  };

  return {
    setEnabled(value) {
      if (disposed || value === enabled) return Promise.resolve(enabled && !failed);
      if (!value) {
        enabled = false;
        writeStored(false);
        howl?.stop();
        return Promise.resolve(true);
      }
      if (failed) return Promise.resolve(false);
      if (pendingEnable) return pendingEnable;
      pendingEnable = (async () => {
        try {
          if (!howl) {
            const loaded = await loadHowl();
            // dispose() may have run while the data-URI load was in flight;
            // a late Howl must never leak back into live state.
            if (disposed || !loaded) {
              loaded?.unload();
              failed = failed || !loaded;
              return false;
            }
            howl = loaded;
          }
          enabled = true;
          writeStored(true);
          return true;
        } catch {
          failed = true;
          enabled = false;
          return false;
        } finally {
          pendingEnable = null;
        }
      })();
      return pendingEnable;
    },

    isEnabled() {
      return enabled;
    },

    play(cue, opts) {
      if (!enabled || !howl || disposed) return;
      const name = cue as string;
      if (!isAudioCue(name)) return;
      const id = howl.play(name);
      if (opts?.volumeScale !== undefined) {
        howl.volume(clamp(0.9 * opts.volumeScale, 0, 1), id);
      }
    },

    stopAll() {
      howl?.stop();
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      enabled = false;
      howl?.unload();
      howl = null;
    },
  };

  // sessionStorage hint read is intentionally NOT auto-applied: the plan
  // requires a user gesture before anything is synthesized, so M09 calls
  // setEnabled(readStored()) from the sound button's click handler.
}

/** Exposed for M09: read the persisted session preference (no synthesis). */
export const readSoundPreference = readStored;
