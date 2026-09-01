/**
 * T3 Trade diorama palette (plan section 3).
 * Every module draws exclusively through these tokens so districts built by
 * different builders read as one world. Semantic state colors are reserved:
 * green = healthy/protected, cyan = waiting/working, amber = degraded,
 * red = blocked/refused, pulsing red = emergency. Never reuse them decoratively.
 */

export const PALETTE = {
  // World background
  space: 0x07111f,
  spaceAlt: 0x0a1828,

  // Structural surfaces
  structure: 0x142a40,
  structureLight: 0x1d3b56,
  surfacePale: 0xddef3,

  // Primary energy / system state
  cyan: 0x34e5e5,
  aqua: 0x56f2c2,
  blue: 0x5a7cff,

  // Character / activity accents
  magenta: 0xff5fc8,
  violet: 0x9a70ff,
  orange: 0xff9f45,
  yellow: 0xffd35a,

  // State colors (semantic; see header comment)
  healthy: 0x63f58b,
  waiting: 0x53c8ff,
  warning: 0xffbe4a,
  blocked: 0xff6b75,
  emergency: 0xff394f,

  // Typography
  ink: 0xf5fbff,
  inkDim: 0xa8c0cf,
} as const;

export type PaletteColor = keyof typeof PALETTE;

/** Role accents for agents and their home districts (plan section 38). */
export const ROLE_COLORS = {
  research: PALETTE.cyan,
  analysis: PALETTE.blue,
  strategy: PALETTE.violet,
  execution: PALETTE.orange,
  risk: PALETTE.yellow,
  reconciliation: PALETTE.healthy,
  operations: PALETTE.magenta,
} as const;

export type AgentRole = keyof typeof ROLE_COLORS;

export const css = (color: number): string => `#${color.toString(16).padStart(6, "0")}`;

/** Darken/lighten a palette integer. amt in [-1, 1]. */
export function shade(color: number, amt: number): number {
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  const mix = (c: number): number =>
    Math.max(0, Math.min(255, Math.round(amt >= 0 ? c + (255 - c) * amt : c * (1 + amt))));
  return (mix(r) << 16) | (mix(g) << 8) | mix(b);
}

/** Lighten toward pale surface; used for iso top faces. Strong lift keeps
 * structures readable against the deep-space backdrop at fit zoom. */
export const topFace = (color: number): number => shade(color, 0.34);
/** Base tone; used for the iso left face. */
export const leftFace = (color: number): number => shade(color, 0.04);
/** Dark tone; used for the iso right face. */
export const rightFace = (color: number): number => shade(color, -0.24);
