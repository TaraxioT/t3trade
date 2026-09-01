/**
 * Campus geometry: the safety perimeter, its three controlled crossings,
 * entrance walkways, and the external Hyperliquid platform. Coordinates are
 * world units shared by the ground, perimeter, rails, and director modules.
 */

/** The transparent cyan perimeter around the exposure-capable campus core. */
export const PERIMETER = {
  x1: 1660,
  y1: 830,
  x2: 2620,
  y2: 1370,
  /** Vertical wall segment height for the glass effect. */
  wallH: 74,
  /** Glass tint. */
  color: 0x34e5e5,
} as const;

/** Crossing 1: west approval gate (opening in the west wall). */
export const GATE_WEST = { x: 1660, y1: 895, y2: 995, cy: 945 } as const;

/** Crossing 2: east exchange tunnel pierce. */
export const TUNNEL_EAST = { x: 2620, y1: 1090, y2: 1190, cy: 1140 } as const;

/** Crossing 3: south receipts/state exit port (one-way, outward). */
export const EXIT_SOUTH = { y: 1370, x1: 2300, x2: 2400, cx: 2350 } as const;

/** Main campus walkway from the south edge to the trading floor. */
export const WALKWAY_SOUTH: { x: number; y: number }[] = [
  { x: 950, y: 1536 },
  { x: 950, y: 1330 },
  { x: 1030, y: 1180 },
  { x: 1200, y: 1060 },
];

/** Research-only walkway from the west edge into the research district. */
export const WALKWAY_RESEARCH: { x: number; y: number }[] = [
  { x: 60, y: 635 },
  { x: 180, y: 635 },
  { x: 330, y: 590 },
];

/** External Hyperliquid Testnet platform (beyond the perimeter). */
export const HYPERLIQUID = {
  cx: 2700,
  cy: 1080,
  w: 200,
  d: 300,
} as const;
