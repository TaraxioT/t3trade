/** Shared types for the diorama runtime. Strict: no `any` crosses a boundary. */
import type { Application, Container } from "pixi.js";
import type { Viewport } from "pixi-viewport";
import type { Agent } from "./actors/Agent";
import type { AgentRole } from "./config/positions";
import type { AssetBundle } from "./assets";
import type { AudioManager } from "./audio";
import type { DioramaDirector } from "./director";
import type { BubbleManager } from "./ui/bubbles";
import type { ZoneId } from "./config/positions";
import type { SoundGroup } from "./config";

/** zIndex plan from the master contract §4. */
export const Z = {
  backdrop: -100,
  plate: 0,
  waterFX: 10,
  bridgeFX: 12,
  actors: 20,
  machineFX: 22,
  dome: 30,
  exteriorFX: 40,
  hotspots: 60,
  labels: 70,
  debug: 100,
} as const;

export interface Layers {
  root: Container; // inside the viewport
  backdrop: Container;
  plate: Container;
  waterFX: Container;
  bridgeFX: Container;
  actors: Container;
  machineFX: Container;
  dome: Container;
  exteriorFX: Container;
  hotspots: Container;
  labels: Container;
}

export type AgentState =
  | "idle"
  | "walking"
  | "working"
  | "carrying"
  | "reacting"
  | "sleeping"
  | "crying";

export interface DirectorEvent {
  id: string;
  /** Zone the event occupies; null for free-roaming character beats. */
  zone: ZoneId | null;
  /** How many locked agents the event needs. */
  actors: number;
  /** Which pool the agents come from. */
  actorKind: "wanderer" | "occasional" | "any" | "stationary" | AgentRole;
  priority: number; // higher wins contention
  cooldownSec: number;
  minIntervalSec: number;
  maxIntervalSec: number;
  weight: number; // relative selection weight
  /** Whether the event may run under prefers-reduced-motion. */
  reducedMotionOk: boolean;
  soundCategory?: SoundGroup;
  /** Runs the beat; returns its duration in seconds. */
  run: (ctx: DioramaContext, agents: Agent[]) => number;
}

export interface DioramaContext {
  app: Application;
  viewport: Viewport;
  layers: Layers;
  assets: AssetBundle;
  audio: AudioManager;
  director: DioramaDirector;
  bubbles: BubbleManager;
  agents: Agent[];
  reducedMotion: boolean;
  isPhone: boolean;
  /** Progressively appended; debug overlay + asset fallback log. */
  log: (line: string) => void;
  rand: (min: number, max: number) => number;
  pick: <T>(items: readonly T[]) => T;
  /** Machinery freeze for the Operator demo gag (ms epoch deadline). */
  frozenUntil: number;
}
