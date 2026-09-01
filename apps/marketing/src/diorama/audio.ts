/**
 * Howler audio: starts muted, subtle cues only. Owner: UI worker.
 *
 * Semantic cue names are stable so the director can call play(CUES.approve)
 * without knowing file names. Master volume 0.5; identical cues are throttled
 * to one playback per 150 ms. Lazily preloads on first enable.
 */
import { Howl, Howler } from "howler";

/** Semantic cue names (stable contract for systems/director.ts). */
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
} as const;

export type Cue = (typeof CUES)[keyof typeof CUES];

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
};

const MASTER_VOLUME = 0.5;
const REPLAY_GAP_MS = 150;

export interface AudioController {
  play(cue: string): void;
  setEnabled(enabled: boolean): void;
}

/** Module-level reference so the HUD can toggle without main.ts plumbing. */
let current: AudioController | null = null;

/** Toggle the live controller from the HUD (idempotent when none exists). */
export function setDioramaAudioEnabled(enabled: boolean): void {
  current?.setEnabled(enabled);
}

/** Play a cue on the live controller (no-op while muted or missing). */
export function playDioramaCue(cue: string): void {
  current?.play(cue);
}

export function createAudio(): AudioController {
  let enabled = false;
  let loaded = false;
  const sounds = new Map<string, Howl>();
  const lastPlayed = new Map<string, number>();

  const preload = (): void => {
    if (loaded) return;
    loaded = true;
    for (const { file } of Object.values(CUE_MAP)) {
      if (sounds.has(file)) continue;
      sounds.set(
        file,
        new Howl({
          src: [`${BASE}/${file}.wav`],
          volume: 0,
          // Web Audio unlocks on the first user gesture via Howler.ctx.
          html5: false,
        }),
      );
    }
    Howler.volume(MASTER_VOLUME);
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
    play(cue): void {
      if (!enabled) return;
      const entry = CUE_MAP[cue as Cue];
      if (!entry) return;
      const now = performance.now();
      const last = lastPlayed.get(entry.file) ?? -Infinity;
      if (now - last < REPLAY_GAP_MS) return;
      lastPlayed.set(entry.file, now);
      preload();
      const howl = sounds.get(entry.file);
      if (!howl) return;
      const id = howl.play();
      howl.volume(entry.volume, id);
    },
  };

  current = controller;
  return controller;
}
