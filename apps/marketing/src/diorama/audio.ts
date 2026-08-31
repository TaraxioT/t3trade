/**
 * Audio manager: Howler groups with global per-category cooldowns,
 * camera-distance volume/pan, gesture unlock and a persisted preference
 * (contract §7). Missing files degrade to silent no-op emitters — a Howl
 * that fails to load is marked missing and never retried. Every play call
 * is expected to coincide with a visible event (spec §47).
 */
import { Howl, Howler } from "howler";
import { AUDIO, WORLD } from "./config";
import type { SoundGroup } from "./config";

/** Base name -> variant file list (files carry their own -1/-2/-3 suffix). */
const VARIANTS: Readonly<Record<string, string[]>> = {
  chirp: ["chirp-1", "chirp-2", "chirp-3"],
  squeak: ["squeak-1", "squeak-2", "squeak-3"],
  yelp: ["yelp-1"],
  giggle: ["giggle-1"],
  sob: ["sob-1"],
  celebrate: ["celebrate-1", "celebrate-2"],
  stamp: ["stamp-1"],
  rejectBuzz: ["reject-buzz-1"],
  scan: ["scan-1"],
  ping: ["ping-1", "ping-2"],
  vaultClunk: ["vault-clunk-1"],
  lever: ["lever-1"],
  bell: ["bell-1"],
  tubeWhoosh: ["tube-whoosh-1"],
  ferryWater: ["ferry-water-loop"],
  conveyor: ["conveyor-loop"],
  ambient: ["ambient-loop"],
};

const LOOPS = new Set(["ferryWater", "conveyor", "ambient"]);

export class AudioManager {
  private howls = new Map<string, Howl>();
  private missing = new Set<string>();
  private lastPlayByGroup = new Map<SoundGroup, number>();
  private lastVariant = new Map<string, number>();
  enabled: boolean;
  private unlocked = false;
  /** Names played recently, for the debug overlay. */
  active: string[] = [];
  private cameraCenter = { x: WORLD.width / 2, y: WORLD.height / 2 };
  private onSound?: (name: string) => void;
  private disposers: Array<() => void> = [];

  constructor() {
    this.enabled = this.readPref();
  }

  private readPref(): boolean {
    try {
      return localStorage.getItem(AUDIO.storageKey) === "on";
    } catch {
      return false;
    }
  }

  setListener(cameraCenter: { x: number; y: number }): void {
    this.cameraCenter = cameraCenter;
  }

  setVisibleSink(fn: (name: string) => void): void {
    this.onSound = fn;
  }

  /** First user gesture unlocks the context if the preference is on. */
  attachUnlock(getTarget: () => HTMLElement): void {
    const unlock = () => {
      this.unlocked = true;
      if (this.enabled) Howler.ctx?.resume();
    };
    const opts: AddEventListenerOptions = { capture: true, passive: true };
    for (const type of ["pointerdown", "keydown", "touchstart"] as const) {
      getTarget().addEventListener(type, unlock, opts);
      this.disposers.push(() => getTarget().removeEventListener(type, unlock, opts));
    }
  }

  setEnabled(on: boolean, target: HTMLElement | null): void {
    this.enabled = on;
    try {
      localStorage.setItem(AUDIO.storageKey, on ? "on" : "off");
    } catch {
      /* private mode: preference simply not persisted */
    }
    if (on && target) this.unlocked = true;
    if (!on) Howler.mute(true);
    else if (this.unlocked) Howler.mute(false);
  }

  private ensure(name: string): Howl | null {
    if (this.missing.has(name)) return null;
    const existing = this.howls.get(name);
    if (existing) return existing;
    const howl = new Howl({
      src: [`/diorama/audio/${name}.wav`],
      loop: LOOPS.has(baseName(name)) || name.endsWith("loop"),
      volume: 0,
      onloaderror: () => {
        // Silent no-op emitter: mark missing so we never retry or crash.
        this.missing.add(name);
        this.howls.delete(name);
      },
    });
    this.howls.set(name, howl);
    return howl;
  }

  /**
   * Play a named sound. `worldPos` drives distance volume and stereo pan
   * (pan clamped to ±maxPan). Returns false when suppressed (muted,
   * locked, cooldown, or file missing).
   */
  play(base: string, group: SoundGroup, worldPos?: { x: number; y: number }): boolean {
    this.onSound?.(base);
    if (!this.enabled || !this.unlocked) return false;
    const now = performance.now();
    const cooldown = AUDIO.cooldowns[group] ?? 0;
    const last = this.lastPlayByGroup.get(group) ?? -Infinity;
    if (now - last < cooldown) return false;
    const variants = VARIANTS[base];
    if (!variants) return false;
    const name = this.pickVariant(base, variants);
    const howl = this.ensure(name);
    if (!howl || this.missing.has(name)) return false;

    const groupVolume = AUDIO.groups[group === "rare" ? "character" : group] ?? 0.3;
    let volume = groupVolume;
    let pan = 0;
    if (worldPos && group !== "ambient") {
      const dx = worldPos.x - this.cameraCenter.x;
      const dy = worldPos.y - this.cameraCenter.y;
      const dist = Math.hypot(dx, dy);
      const t = Math.min(
        1,
        Math.max(0, (dist - AUDIO.falloffNear) / (AUDIO.falloffFar - AUDIO.falloffNear)),
      );
      volume = groupVolume * (1 - 0.75 * t);
      pan = Math.max(-AUDIO.maxPan, Math.min(AUDIO.maxPan, (dx / WORLD.width) * 1.4));
    }
    const id = howl.play();
    if (id === null) return false;
    howl.volume(volume, id);
    const stereo = howl.stereo as (value: number, id?: number) => number;
    stereo(pan, id);
    this.lastPlayByGroup.set(group, now);
    this.active.push(base);
    if (this.active.length > 8) this.active.shift();
    return true;
  }

  private pickVariant(base: string, variants: string[]): string {
    if (variants.length === 1) return variants[0];
    // Avoid immediate repetition so ears do not latch onto a loop.
    let index = Math.floor(Math.random() * variants.length);
    if (index === (this.lastVariant.get(base) ?? -1)) {
      index = (index + 1) % variants.length;
    }
    this.lastVariant.set(base, index);
    return variants[index];
  }

  dispose(): void {
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
    Howler.unload();
    this.howls.clear();
  }
}

function baseName(name: string): string {
  return name.replace(/-\d+$/, "");
}
