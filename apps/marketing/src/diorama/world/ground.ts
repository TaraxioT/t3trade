/**
 * Room ground (dio-3 R1): stepped diamond plinth with layered south
 * cross-section bands and a soft drop shadow into the void, per-section
 * floor inlay washes clipped to the room, the 2:1 tile lattice, deterministic
 * interior scatter (vents/hatches), and the in-room garden planters.
 * Everything is static and drawn once into the unsorted ground layer.
 * Owner: room-world lane.
 */
import { Container, Graphics } from "pixi.js";
import type { DioramaContext } from "../core/context.js";
import { leftFace, PALETTE, rightFace, shade } from "../config/palette.js";
import { insideRoom, ROOM_DIAMOND, SECTION_POLYS, type SectionId } from "../config/geometry.js";
import { seededRandom } from "../config/world.js";

/** Room metrics derived from the frozen ROOM_DIAMOND corners. */
const CENTER = { x: 1408, y: 768 } as const;
const HALF_W = 1260;
const HALF_H = 630;
/** Plinth tread widths in axial units (half-diagonal growth per step). */
const STEP_AXIAL = [52, 26] as const;

/** Section accent washes (research cyan / floor blue / risk gold). */
const SECTION_WASH: Record<SectionId, number> = {
  research: 0x34e5e5,
  floor: 0x5a7cff,
  risk: 0xffd35a,
};

/** Flat diamond polygon (number pairs) around the room center. */
function diamondPts(hh: number, dy = 0): number[] {
  const hw = hh * 2;
  return [
    CENTER.x - hw,
    CENTER.y + dy,
    CENTER.x,
    CENTER.y + hh + dy,
    CENTER.x + hw,
    CENTER.y + dy,
    CENTER.x,
    CENTER.y - hh + dy,
  ];
}

function polyPath(g: Graphics, pts: ReadonlyArray<{ x: number; y: number }>): void {
  g.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);
  g.closePath();
}

/**
 * The stepped plinth: floor diamond plus two outward treads. Each step draws
 * downward-offset copies first so the south/front edges show layered dark
 * cross-section bands (the old slab's thickness vocabulary, now on diamond
 * edges with square corners). The north overhang is covered later by the
 * back walls (world/walls.ts) and the next-smaller layer.
 */
function buildPlinth(root: Container): void {
  // Soft drop shadow into the void so the room reads as mass, not a decal.
  const shadow = new Graphics();
  shadow.ellipse(CENTER.x, CENTER.y + 140, 1420, 520);
  shadow.fill({ color: 0x000000, alpha: 0.42 });
  root.addChild(shadow);

  const g = new Graphics();
  for (const [i, axial] of STEP_AXIAL.entries()) {
    const hh = HALF_H + axial;
    // Cross-section bands below the tread, south edges only in practice.
    g.poly(diamondPts(hh, 16 - i * 5));
    g.fill({ color: shade(PALETTE.structure, -0.45) });
    g.poly(diamondPts(hh, 8 - i * 3));
    g.fill({ color: rightFace(PALETTE.structure) });
    // Tread top; inner step reads slightly lighter than the outer ring.
    g.poly(diamondPts(hh));
    g.fill({ color: i === 0 ? leftFace(PALETTE.structure) : shade(PALETTE.structure, 0.18) });
    g.poly(diamondPts(hh));
    g.stroke({ width: 1.5, color: PALETTE.surfacePale, alpha: i === 0 ? 0.16 : 0.22 });
  }

  // Floor diamond: the room's top face.
  g.poly(diamondPts(HALF_H));
  g.fill({ color: PALETTE.structureLight });
  g.poly(diamondPts(HALF_H));
  g.stroke({ width: 2.5, color: PALETTE.surfacePale, alpha: 0.5 });

  root.addChild(g);
}

/**
 * Per-section floor inlays using the frozen polygons. The polygons lie
 * inside the room diamond by construction (their outer vertices sit exactly
 * on the diamond edges), so no additional clip is required. The fill sits
 * darker than the plinth top so section floors separate by value; borders
 * stay very faint so sections blend into one room, not UI cards.
 */
function buildSectionInlays(root: Container): void {
  const fills = new Graphics();
  for (const id of Object.keys(SECTION_POLYS) as SectionId[]) {
    const pts = SECTION_POLYS[id];
    polyPath(fills, pts);
    fills.fill({ color: PALETTE.structure, alpha: 0.45 });
    polyPath(fills, pts);
    fills.fill({ color: SECTION_WASH[id], alpha: 0.1 });
    polyPath(fills, pts);
    // No accent stroke on the section polys: interior boundaries would read
    // as compositing seams at zoom. The wash fill alone differentiates zones;
    // the one intentional interior line is the gold authority seam (seam.ts).
    fills.stroke({ width: 1, color: SECTION_WASH[id], alpha: 0.04 });
  }
  root.addChild(fills);
}

/** Floor-diamond edges as segment pairs for lattice clipping. */
const DIAMOND_EDGES: ReadonlyArray<readonly [{ x: number; y: number }, { x: number; y: number }]> = [
  [ROOM_DIAMOND.N, ROOM_DIAMOND.E],
  [ROOM_DIAMOND.E, ROOM_DIAMOND.S],
  [ROOM_DIAMOND.S, ROOM_DIAMOND.W],
  [ROOM_DIAMOND.W, ROOM_DIAMOND.N],
];

/** Intersect the line y = m*x + c with the floor diamond; null if no chord. */
function clipToDiamond(
  m: number,
  c: number,
): [number, number, number, number] | null {
  const hits: Array<{ x: number; y: number }> = [];
  for (const [p, q] of DIAMOND_EDGES) {
    const denom = q.y - p.y - m * (q.x - p.x);
    if (Math.abs(denom) < 1e-9) continue;
    const t = (c + m * p.x - p.y) / denom;
    if (t < -1e-6 || t > 1 + 1e-6) continue;
    hits.push({ x: p.x + t * (q.x - p.x), y: p.y + t * (q.y - p.y) });
  }
  if (hits.length < 2) return null;
  const first = hits[0];
  const last = hits[hits.length - 1];
  return [first.x, first.y, last.x, last.y];
}

/**
 * The 2:1 diamond tile lattice across the whole room floor: diagonal lines
 * at slopes +0.5 and -0.5, clipped analytically to the floor diamond (the
 * lattice must never spill onto the plinth treads).
 */
function buildLattice(root: Container): void {
  const grid = new Graphics();
  const corners = [ROOM_DIAMOND.N, ROOM_DIAMOND.E, ROOM_DIAMOND.S, ROOM_DIAMOND.W];
  for (const m of [0.5, -0.5]) {
    const cs = corners.map((p) => p.y - m * p.x);
    const lo = Math.min(...cs);
    const hi = Math.max(...cs);
    // Step 48 in intercept = 96 x-intercept spacing, the old lattice density.
    for (let c = lo; c <= hi; c += 48) {
      const seg = clipToDiamond(m, c);
      if (!seg) continue;
      grid.moveTo(seg[0], seg[1]);
      grid.lineTo(seg[2], seg[3]);
      grid.stroke({ width: 0.5, color: PALETTE.surfacePale, alpha: 0.06 });
    }
  }
  root.addChild(grid);
}

/** Deterministic scatter: vents and hatches seeded strictly inside the room
 * (>= 90 units clear of every wall base and plinth edge). */
function buildScatter(root: Container): void {
  const rnd = seededRandom(23);
  const g = new Graphics();
  const sampleInside = (): { x: number; y: number } => {
    for (let i = 0; i < 60; i++) {
      const x = CENTER.x - HALF_W + 60 + rnd() * (HALF_W * 2 - 120);
      const y = CENTER.y - HALF_H + 60 + rnd() * (HALF_H * 2 - 120);
      if (insideRoom(x, y, 90)) return { x, y };
    }
    return { x: CENTER.x, y: CENTER.y };
  };

  for (let i = 0; i < 12; i++) {
    const { x, y } = sampleInside();
    const s = 7 + rnd() * 5;
    g.roundRect(x - s, y - s * 0.6, s * 2, s * 1.2, 2);
    g.fill({ color: PALETTE.structure, alpha: 0.8 });
    g.moveTo(x - s * 0.6, y);
    g.lineTo(x + s * 0.6, y);
    g.stroke({ width: 1, color: PALETTE.inkDim, alpha: 0.25 });
  }

  for (let i = 0; i < 10; i++) {
    const { x, y } = sampleInside();
    const s = 9 + rnd() * 5;
    g.roundRect(x - s, y - s, s * 2, s * 2, 3);
    g.stroke({ width: 1.2, color: PALETTE.inkDim, alpha: 0.22 });
    g.moveTo(x - s * 0.4, y);
    g.lineTo(x + s * 0.4, y);
    g.stroke({ width: 1.2, color: PALETTE.inkDim, alpha: 0.3 });
  }

  root.addChild(g);
}

/**
 * Mid-room garden planters, re-homed to the south band of the central floor
 * section (reference rooms keep plants by the open front). Soil mounds with
 * curved glow reeds ground the space without blocking paths.
 */
function buildGarden(root: Container): void {
  const garden = new Container();
  for (const [gx, gy, hue] of [
    [1250, 1225, PALETTE.healthy],
    [1310, 1252, PALETTE.aqua],
    [1195, 1272, PALETTE.cyan],
  ] as Array<[number, number, number]>) {
    const planter = new Graphics();
    planter.ellipse(gx, gy + 6, 22, 10);
    planter.fill({ color: shade(PALETTE.structure, -0.25), alpha: 0.92 });
    planter.ellipse(gx, gy + 6, 15, 6.5);
    planter.fill({ color: PALETTE.structure, alpha: 0.5 });
    planter.ellipse(gx, gy + 6, 22, 10);
    planter.stroke({ width: 1, color: PALETTE.structureLight, alpha: 0.7 });
    for (let r = 0; r < 3; r++) {
      const rx = gx - 10 + r * 10;
      const lean = (r - 1) * 4;
      planter.moveTo(rx, gy + 2);
      planter.quadraticCurveTo(rx + lean * 0.4, gy - 9, rx + lean, gy - 17);
      planter.stroke({ width: 1.5, color: hue, alpha: 0.7 });
      planter.circle(rx + lean, gy - 18, 2);
      planter.fill({ color: hue, alpha: 0.85 });
    }
    garden.addChild(planter);
  }
  root.addChild(garden);
}

export function buildGround(ctx: DioramaContext): void {
  const root = new Container();
  buildPlinth(root);
  buildSectionInlays(root);
  buildLattice(root);
  buildScatter(root);
  buildGarden(root);
  ctx.layers.ground.addChild(root);
}
