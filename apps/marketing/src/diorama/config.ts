/**
 * Single source of truth for palette, dimensions, timing, camera shots,
 * quality caps, and seed namespaces.
 *
 * Only types.ts may be imported. No geometry scale may be hardcoded outside
 * DIMENSIONS; no color literal belongs outside PALETTE; no timing literal
 * belongs outside TIMING/CAMERA.
 *
 * v2 palette (08-design-direction-v2.md) coexists with the v1 keys below
 * until the R6 cleanup; v1 modules keep compiling against the old keys.
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

  // ---- v2 additions (08-design-direction-v2.md); v1 keys stay until R6 ----

  // Bone deck family: matte light interior surfaces (ISS/cafe references).
  boneDeck: "#E8ECF2",
  boneDeckLight: "#F4F7FA",
  boneWall: "#EDF0F4",
  /** Machine frames/bases; contrast accent, never dominant. */
  slateFrame: "#2A313C",

  /** Zone identity colors (design doc Decision 1 zone list). */
  zones: {
    docks: "#7C8CF8",
    greenhouse: "#2FBF71",
    plan: "#F5A623",
    gauntlet: "#22C3E6",
    mint: "#D4AF37",
    launch: "#FF6B35",
    backOffice: "#5B8DEF",
    watch: "#E85D9E",
    oilBar: "#3DDC97",
    risk: "#E5484D",
  } satisfies Record<ZoneId, string>,

  /**
   * Zone floor-plate tints: 55% blend of each zone color toward boneDeck
   * (#E8ECF2), i.e. mix(zone, boneDeck, 0.55). Hardcoded so the palette stays
   * a literal table; recompute if a zone color changes.
   */
  zoneFloorTint: {
    docks: "#B7C1F5",
    greenhouse: "#95D8B8",
    plan: "#EECD95",
    gauntlet: "#8FDAED",
    mint: "#DFD19E",
    launch: "#F2B29D",
    backOffice: "#A9C1F1",
    watch: "#E8ACCC",
    oilBar: "#9BE5C9",
    risk: "#E7A2A8",
  } satisfies Record<ZoneId, string>,

  /**
   * Zone emissive colors for signs/screens: the zone colors themselves.
   * Referenced by material owners rather than duplicated literals.
   */
  zoneEmissive: {
    docks: "#7C8CF8",
    greenhouse: "#2FBF71",
    plan: "#F5A623",
    gauntlet: "#22C3E6",
    mint: "#D4AF37",
    launch: "#FF6B35",
    backOffice: "#5B8DEF",
    watch: "#E85D9E",
    oilBar: "#3DDC97",
    risk: "#E5484D",
  } satisfies Record<ZoneId, string>,

  /**
   * Bot v2 hulls: each bot's body takes its home zone color at ~70% toward
   * boneDeck, i.e. mix(zone, boneDeck, 0.70). Hardcoded per the palette
   * literal rule; recompute if a zone color changes.
   */
  botBody: {
    docks: "#C8CFF4",
    greenhouse: "#B1DFCB",
    plan: "#ECD7B4",
    gauntlet: "#ADE0EE",
    mint: "#E2DABA",
    launch: "#EFC5B9",
    backOffice: "#BED0F1",
    watch: "#E8C1D9",
    oilBar: "#B5E7D7",
    risk: "#E7BBC1",
  } satisfies Record<ZoneId, string>,

  /** Bot v2 hats: dark slate (design doc Decision 3.4). */
  hatV2: "#2A313C",
  /** Bot eye emissive stays the site accent (design doc Decision 3.1). */
  eyeEmissive: "#7FF0BC",
} as const;

/** Role hat tint lookup (bodies are always cream). */
export const roleHatColor = (role: Role): string => PALETTE.roleHats[role];

/**
 * v2 palette view for material owners: the v2 additions of PALETTE, exposed
 * under their own name so v1 consumers keep importing PALETTE only.
 */
export const PALETTE_V2 = {
  boneDeck: PALETTE.boneDeck,
  boneDeckLight: PALETTE.boneDeckLight,
  boneWall: PALETTE.boneWall,
  slateFrame: PALETTE.slateFrame,
  zones: PALETTE.zones,
  zoneFloorTint: PALETTE.zoneFloorTint,
  zoneEmissive: PALETTE.zoneEmissive,
  botBody: PALETTE.botBody,
  hatV2: PALETTE.hatV2,
  eyeEmissive: PALETTE.eyeEmissive,
} as const;

// ---------------------------------------------------------------------------
// v2 ZONES (08-design-direction-v2.md, locked 2026-08-31)
// ---------------------------------------------------------------------------

/** Zone color id (pipeline order is ZONE_ORDER, not this type's order). */
export type ZoneId =
  | "docks"
  | "greenhouse"
  | "plan"
  | "gauntlet"
  | "mint"
  | "launch"
  | "backOffice"
  | "watch"
  | "oilBar"
  | "risk";

/** Pipeline order, left to right on the bazaar deck (design doc Decision 1). */
export const ZONE_ORDER: readonly ZoneId[] = [
  "docks",
  "greenhouse",
  "plan",
  "gauntlet",
  "mint",
  "launch",
  "backOffice",
  "watch",
  "oilBar",
  "risk",
] as const;

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

  // ---- v2 (R2): Bureau Bazaar campus fit box (09-layout-spec.md) ----
  // This, not the legacy tower keys above (kept only for still-referenced
  // old modules until R6), is the camera-fit source for the new world.
  composition: {
    /** Deck extents (the stepped bazaar platform). */
    deckMinX: -23,
    deckMaxX: 23,
    deckMinZ: -15,
    deckMaxZ: 13,
    /** Terrace structures top out here (watch tower). */
    terraceTopY: 10,
    satellite: {
      /** Exchange pad center (included in fit bounds, but capped below). */
      x: 19,
      y: 6.5,
      z: -6,
      radius: 3.6,
    },
    /**
     * Fit-purpose top of the composition: the satellite is deliberately NOT
     * allowed to inflate the box upward; terrace tower dominates anyway.
     */
    fitTopY: 7.5,
    /** Headroom above fitTopY for glyph pops and the USER-hand fx. */
    fxHeadroom: 2,
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
  readonly id: "S1" | "S2" | "S3" | "S4" | "S5" | "S6" | "S7";
  readonly startMs: number;
  readonly target: readonly [number, number, number];
  /** Multiplier applied on top of the responsive fit; >1 zooms in. */
  readonly zoom: number;
  /** Slow additive target drift over the shot, in scene units [dx, dz]. */
  readonly drift: readonly [number, number];
}

/**
 * Seven-shot editorial track over the Bureau Bazaar campus (restructuring
 * plan section 8, R5.1 dramatic retune after the live tour: the first pass's
 * 0.86-1.25 zooms read as one static wide on a 46-unit deck). Ortho zoom on
 * this composition: 1.0 ~ full campus, 1.6-1.8 ~ a 2-3 zone window.
 * S1 hero, S2 west push, S3 gauntlet closeup, S4 mint/launch, S5 terrace,
 * S6 wide for the USER-hand gag, S7 exact return to S1 framing for the seam.
 */
export const CAMERA_SHOTS: readonly CameraShot[] = [
  { id: "S1", startMs: 0, target: [0, 1.5, 2], zoom: 0.92, drift: [0.6, -0.3] },
  { id: "S2", startMs: 15000, target: [-12, 1.2, 3], zoom: 1.6, drift: [0.9, 0.2] },
  { id: "S3", startMs: 30000, target: [1, 1.6, 7], zoom: 1.85, drift: [-0.5, 0.4] },
  { id: "S4", startMs: 47000, target: [8.5, 1.6, 0.5], zoom: 1.7, drift: [-0.6, 0.2] },
  { id: "S5", startMs: 62000, target: [0, 4.2, -11], zoom: 1.7, drift: [0.3, 0.5] },
  { id: "S6", startMs: 74000, target: [0, 1.5, 3], zoom: 0.86, drift: [0, -0.4] },
  { id: "S7", startMs: 86000, target: [0, 1.5, 2], zoom: 0.92, drift: [0, 0] },
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
