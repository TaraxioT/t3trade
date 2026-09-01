/**
 * Room geometry (dio-3 R1, frozen by artifacts/diorama/dio3/layout-decision.md):
 * ONE square cutaway room replaces the old floating campus. The floor is the
 * 2:1 iso projection of one ground square (world diamond 2520 x 1260)
 * centered on the world canvas. Two back walls rise along the N-W and N-E
 * edges and meet at the N corner; the S corner stays open toward the camera.
 *
 * Contract:
 * - The plinth steps and the back walls are the ONLY geometry allowed beyond
 *   the floor diamond; past them is clean void.
 * - The three section inlay polygons are frozen; only the coordinator may
 *   move them. They lie inside the room diamond by construction (their outer
 *   vertices sit exactly on the diamond edges).
 * - insideRoom()/insideSectionPoly() back the programmatic containment sweep:
 *   every station anchor, rail waypoint, agent home/wander point, story
 *   waypoint, and cue origin must pass them (wall fixtures and plinth bands
 *   are exempt via explicit list).
 */

export interface RoomPoint {
  x: number;
  y: number;
}

/** The floor diamond: corners of the 2520 x 1260 room projection. */
export const ROOM_DIAMOND = {
  N: { x: 1408, y: 138 },
  E: { x: 2668, y: 768 },
  S: { x: 1408, y: 1398 },
  W: { x: 148, y: 768 },
} as const satisfies Record<string, RoomPoint>;

/** Room section ids; must stay in sync with DistrictId in config/stations.ts. */
export type SectionId = "research" | "floor" | "risk";

/**
 * Frozen section inlay polygons (world units; closed by convention).
 * research: west wedge; floor: center band including N and S corners;
 * risk: east wedge. The polyline (1750,309)-(1750,950)-(1520,1340) is the
 * shared floor/risk boundary (the authority seam, see world/seam.ts).
 */
export const SECTION_POLYS: Record<SectionId, readonly RoomPoint[]> = {
  research: [ROOM_DIAMOND.W, { x: 1120, y: 282 }, { x: 1120, y: 1204 }],
  floor: [
    { x: 1120, y: 282 },
    ROOM_DIAMOND.N,
    { x: 1750, y: 309 },
    { x: 1750, y: 950 },
    { x: 1520, y: 1340 },
    ROOM_DIAMOND.S,
    { x: 1120, y: 1204 },
  ],
  risk: [
    { x: 1750, y: 309 },
    ROOM_DIAMOND.E,
    { x: 1520, y: 1340 },
    { x: 1750, y: 950 },
  ],
};

/** Back-wall base segments: west (N-W edge) and east (N-E edge). */
export const WALL_EDGES = {
  west: { a: ROOM_DIAMOND.N, b: ROOM_DIAMOND.W },
  east: { a: ROOM_DIAMOND.N, b: ROOM_DIAMOND.E },
} as const;

/** Back-wall height in screen units (~2.7x an agent's drawn height). */
export const WALL_H = 120;

/** Room center and half-diagonals derived from the frozen corners. */
const CENTER = { x: 1408, y: 768 } as const;
const HALF_W = 1260;
const HALF_H = 630;
/** Perpendicular distance from the center to each diamond edge. */
const APOTHEM = (HALF_H * 2) / Math.sqrt(5);

/**
 * Point-in-room test. `inset` shrinks the diamond by a perpendicular
 * distance in world units, so insideRoom(x, y, 90) means "at least 90 units
 * clear of every wall base and plinth edge".
 */
export function insideRoom(x: number, y: number, inset = 0): boolean {
  if (inset >= APOTHEM) return false;
  const k = Math.max(Number.EPSILON, (APOTHEM - inset) / APOTHEM);
  const u = Math.abs(x - CENTER.x) / (HALF_W * k);
  const v = Math.abs(y - CENTER.y) / (HALF_H * k);
  return u + v <= 1;
}

/**
 * Point-in-polygon test (even-odd ray cast) against a frozen section inlay.
 * Points exactly on a section edge are treated as outside; containment QA
 * should use unambiguous interior anchors.
 */
export function insideSectionPoly(section: SectionId, x: number, y: number): boolean {
  const pts = SECTION_POLYS[section];
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const pi = pts[i];
    const pj = pts[j];
    const crosses = pi.y > y !== pj.y > y;
    if (!crosses) continue;
    const xAtY = ((pj.x - pi.x) * (y - pi.y)) / (pj.y - pi.y) + pi.x;
    if (x < xAtY) inside = !inside;
  }
  return inside;
}
