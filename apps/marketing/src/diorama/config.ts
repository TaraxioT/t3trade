/**
 * Single source of truth for palette, dimensions, timing, camera shots,
 * quality caps, and seed namespaces.
 *
 * Only types.ts may be imported. No geometry scale may be hardcoded outside
 * DIMENSIONS; no color literal belongs outside PALETTE; no timing literal
 * belongs outside TIMING/CAMERA.
 */

import { asBeatId, type BeatId, type Role } from "./types";

// ---------------------------------------------------------------------------
// PALETTE (locked by 03-design-direction.md)
// ---------------------------------------------------------------------------

export const PALETTE = {
  cream: "#EEDCC4",
  creamWallLight: "#F6E8D2",
  caramel: "#9E6747",
  caramelLight: "#B87B56",
  slate: "#3B3E43",
  slateDark: "#232529",
  mahoganyPlinth: "#4B2B1B",
  mahoganyRim: "#6D432D",
  brass: "#D4AF37",
  mint: "#3DDC97",
  mintDim: "#2AA874",
  mintBright: "#7FF0BC",
  // oklch(0.72 0.15 152) / oklch(0.66 0.18 27) approximations, data marks only.
  dataGreen: "#4CC38A",
  dataRed: "#E5484D",
  void: "#0A0A0C",
  warmKey: "#FFF1DB",
  warmFill: "#D9BFA0",
  coolFill: "#8FA3AD",
  // Role hat tints; bodies are cream for every role.
  roleHats: {
    foreman: "#B3553F",
    researcher: "#EEDCC4",
    analyst: "#E8D9BE",
    runner: "#B87B56",
    guard: "#D29B38",
    gunner: "#3B3E43",
    accountant: "#7A8450",
    intern: "#3DDC97",
    janitor: "#8A8A8F",
    coffee: "#7A5238",
    ambient: "#DCCDB4",
  } satisfies Record<Role, string>,
} as const;

/** Role hat tint lookup (bodies are always cream). */
export const roleHatColor = (role: Role): string => PALETTE.roleHats[role];

// ---------------------------------------------------------------------------
// DIMENSIONS
//
// Metric system: 1 unit = half a bot height, so a standing bot is ~2 units
// tall and a doorway is ~2.6. Y axis: the plinth TOP surface is y = 0; the
// risk basement floor is sunk into the plinth at y = -2.2; the trading floor
// slab sits at y = 0; each storey adds FLOOR_HEIGHT = 4.6, so the research
// loft floor is y = 4.6 and the roof slab is y = 9.2. The bureau building is
// centered near the plinth middle but offset away from the satellite corner,
// leaving the +X/-Z (screen upper-right) region free for the exchange pad,
// which floats at y = 13 and connects to the roof via the pipe bridge.
// X is the screen-horizontal ground axis, Z the ground-depth axis, with -Z
// toward the camera's upper-right framing.
// ---------------------------------------------------------------------------

export const DIMENSIONS = {
  /** Scene units; nothing outside this block may assume scale. */
  unit: 1, // 1 = half a bot height (bot ~= 2 units tall)

  plinth: {
    width: 30, // X extent
    depth: 22, // Z extent
    height: 3.5, // Y extent; top surface is the scene's y = 0 plane
    /** Plinth occupies y in [-3.5, 0]. */
    topY: 0,
    bottomY: -3.5,
    rimHeight: 0.5,
  },

  building: {
    footprintWidth: 18, // X extent of the bureau
    footprintDepth: 13, // Z extent
    /** Center on the plinth, nudged back-left to clear the satellite corner. */
    centerX: -2,
    centerZ: 1,
    wallThickness: 0.5,
  },

  floors: {
    height: 4.6, // floor-to-floor
    /** Risk vault basement, sunk below the plinth top. */
    basementY: -2.2,
    /** Trading floor slab at plinth top. */
    tradingY: 0,
    /** Research loft. */
    researchY: 4.6,
    /** Roof slab surface. */
    roofY: 9.2,
    ceilingClearance: 3.8,
    floorSlabThickness: 0.8,
    /** Floor-cut aperture (brass pole, stairwell) half-extents in X/Z. */
    cutHalfWidth: 1.6,
    cutHalfDepth: 1.6,
  },

  satellite: {
    /** Exchange pad center, upper-right of the bureau. */
    x: 16,
    y: 13,
    z: -6,
    padRadius: 4.5,
    padThickness: 1.0,
  },

  bridge: {
    /** Pipe runs from the roof-level cannon mouth to the satellite pad. */
    fromY: 9.2,
    pipeRadius: 0.45,
    /** Slight rise over the span so the orb flight reads as an arc. */
    midRise: 1.6,
  },

  bot: {
    height: 2,
    bodyRadius: 0.55,
    hatRadius: 0.5,
    armLength: 0.9,
    /** Intern is the smallest cast member. */
    internScale: 0.8,
  },
} as const;

// ---------------------------------------------------------------------------
// TIMING (plan section 6 / section 18: 90,000 ms, canonical beat skeleton)
// ---------------------------------------------------------------------------

export const DURATION_MS = 90000;

export interface BeatStart {
  readonly id: BeatId;
  readonly startMs: number;
}

/**
 * Frozen ordered 10-entry skeleton (9 story phases plus the closing
 * wind_down return). Beat boundaries are data; animation code must never
 * encode them as percentages.
 */
export const BEAT_STARTS: readonly BeatStart[] = [
  { id: asBeatId("shift_start"), startMs: 0 },
  { id: asBeatId("research_chaos"), startMs: 6000 },
  { id: asBeatId("mission_briefing"), startMs: 20000 },
  { id: asBeatId("plan_crates"), startMs: 29000 },
  { id: asBeatId("risk_gate"), startMs: 41000 },
  { id: asBeatId("order_launch"), startMs: 54000 },
  { id: asBeatId("receipt_return"), startMs: 64000 },
  { id: asBeatId("celebration"), startMs: 71000 },
  { id: asBeatId("reconciliation"), startMs: 79000 },
  { id: asBeatId("wind_down"), startMs: 86000 },
] as const;

/** Beat whose window contains `timeMs` (cyclic over DURATION_MS). */
export function beatAt(timeMs: number): BeatStart {
  const t = ((timeMs % DURATION_MS) + DURATION_MS) % DURATION_MS;
  let current = BEAT_STARTS[0];
  for (const beat of BEAT_STARTS) {
    if (beat.startMs <= t) current = beat;
    else break;
  }
  return current;
}

// ---------------------------------------------------------------------------
// CAMERA (orthographic authored shots; isometric yaw/pitch locked elsewhere)
// ---------------------------------------------------------------------------

export interface CameraShot {
  readonly id: "S1" | "S2" | "S3" | "S4" | "S5";
  readonly startMs: number;
  readonly target: readonly [number, number, number];
  /** Multiplier applied on top of the responsive fit; >1 zooms in. */
  readonly zoom: number;
  /** Slow additive target drift over the shot, in scene units [dx, dz]. */
  readonly drift: readonly [number, number];
}

/**
 * Five shots aligned to the canonical skeleton:
 * S1 hero, S2 trading/gate closer, S3 vault + bridge, S4 wide with satellite,
 * S5 easing back to the exact S1 framing for the loop seam.
 */
export const CAMERA_SHOTS: readonly CameraShot[] = [
  { id: "S1", startMs: 0, target: [2, 4, 0], zoom: 1.0, drift: [0.8, -0.4] },
  { id: "S2", startMs: 20000, target: [0, 1.5, 2], zoom: 1.35, drift: [1.2, 0.3] },
  { id: "S3", startMs: 54000, target: [7, -0.5, -2], zoom: 1.25, drift: [0.4, -0.6] },
  { id: "S4", startMs: 64000, target: [6, 6, -2], zoom: 0.85, drift: [-0.5, 0.2] },
  { id: "S5", startMs: 86000, target: [2, 4, 0], zoom: 1.0, drift: [0, 0] },
] as const;

/** Isometric yaw/pitch are locked; only target/zoom/drift are authored. */
export const CAMERA_ISO = {
  yawRadians: Math.PI / 4,
  // Classic isometric pitch (~35.26 degrees). Orchestrator retune 2026-08-31:
  // the gentle ~17.6-degree read stacked the floor slabs and hid the trading
  // floor and vault interiors entirely in the first composition review.
  pitchRadians: Math.atan(1 / Math.sqrt(2)),
} as const;

// ---------------------------------------------------------------------------
// QUALITY / PERFORMANCE BUDGETS (plan section 8)
// ---------------------------------------------------------------------------

export const QUALITY = {
  dprCapFinePointer: 2,
  dprCapCoarsePointer: 1.5,
  maxDrawCalls: 220,
  maxTriangles: 250000,
  maxParticleDrawCalls: 3,
  maxVisiblePoints: 600,
  shadowMapSize: 2048,
} as const;

/** Renderer look defaults; art-tunable, not scattered literals. */
export const RENDER = {
  exposure: 1.1,
  toneMapping: "ACESFilmic",
  outputColorSpace: "sRGB",
} as const;

// ---------------------------------------------------------------------------
// SEED NAMESPACES
//
// Independent namespaces so adding a confetti particle can never shift bot
// timing or any other subsystem's stream (plan section 6, clean loop seam).
// ---------------------------------------------------------------------------

export const SEEDS = {
  /** Master base; namespace seeds are derived deterministically from it. */
  base: 0x733ade,
  bots: 0x8001,
  particles: 0x8002,
  environment: 0x8003,
  audioNoise: 0x8004,
} as const;

export type SeedNamespace = keyof Omit<typeof SEEDS, "base">;
