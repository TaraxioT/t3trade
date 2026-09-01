/**
 * Canonical world space for the diorama: 2816 x 1536 world units, origin at
 * the top-left of the scene graphic. Every station coordinate, rail waypoint,
 * and agent path is expressed in these units regardless of viewport size.
 *
 * Depth sorting (plan section 0): a single sortable layer assigns
 *   zIndex = screenY + elevationBias + foregroundBias
 * so agents correctly pass behind and in front of structures. Structures sit
 * at their base anchor Y; agents at their foot Y; rails slightly below the
 * actors that walk over them; labels and glow effects above everything local.
 */

export const WORLD_WIDTH = 2816;
export const WORLD_HEIGHT = 1536;

/** zIndex offsets for the single sortable layer. */
export const DEPTH = {
  /** Ground plates and floor decals rendered below everything sortable. */
  ground: -2000,
  /** Rails sit just under actors walking along them. */
  rail: -6,
  /** Base offset for structures and agents (add to anchor Y). */
  base: 0,
  /** Packets ride slightly above rails but under agents. */
  packet: -3,
  /** Local glow/sign floats above their structure. */
  overlay: 900,
  /** District-level floating labels. */
  districtLabel: 1200,
} as const;

/** Classic 2:1 isometric tile proportions used by the iso drawing kit. */
export const ISO_RATIO = 0.5;

export interface Point {
  x: number;
  y: number;
}

export const pt = (x: number, y: number): Point => ({ x, y });

/** Deterministic seeded RNG (mulberry32) so the director is reproducible. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** zIndex for a sortable object anchored at world y. */
export const zIndexAt = (y: number, bias = 0): number => y + bias;
