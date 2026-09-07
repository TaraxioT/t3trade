/**
 * Room back walls (dio-3 R1): two screen-facing extruded walls along the N-W
 * and N-E diamond edges, meeting at the N corner (1408,138); the S corner
 * stays open toward the camera. Walls are tall architecture, so they get a
 * chunkier presence than station glass: outer face, top band, end caps,
 * inner face, wainscot trim, a pilaster rhythm, a corner rib at the miter,
 * and a cyan emissive top rim.
 *
 * They are built into the unsorted ground layer (below the sortable layer),
 * so every room structure, rail, and agent always renders in front of them.
 * Guidance for station lanes: keep tall fixtures away from the N corner so
 * both wall faces stay readable.
 * Owner: room-world lane.
 */
import { Container, Graphics } from "pixi.js";
import type { DioramaContext } from "../core/context.js";
import { PALETTE, rightFace, shade, topFace } from "../config/palette.js";
import { WALL_EDGES, WALL_H } from "../config/geometry.js";

/** Screen-space wall thickness perpendicular to the base edge. */
const WALL_T = 16;
/** Wainscot (base trim band) height on the inner face. */
const WAINSCOT_H = 26;
/** Pilaster spacing along each wall, in screen units along the edge. */
const PILASTER_STEP = 200;
/** First pilaster offset from the N corner; keeps the miter clean. */
const PILASTER_START = 140;

interface WallFrame {
  /** N-corner end (shared miter point). */
  a: { x: number; y: number };
  /** W/E corner end. */
  b: { x: number; y: number };
  /** Unit vector a -> b. */
  ux: number;
  uy: number;
  /** Unit outward normal (away from the room center). */
  nx: number;
  ny: number;
  /** Edge length in screen units. */
  len: number;
}

const ROOM_CENTER = { x: 1408, y: 768 } as const;

function wallFrame(edge: { a: { x: number; y: number }; b: { x: number; y: number } }): WallFrame {
  const dx = edge.b.x - edge.a.x;
  const dy = edge.b.y - edge.a.y;
  const len = Math.hypot(dx, dy);
  const ux = dx / len;
  const uy = dy / len;
  // Perpendicular candidates; pick the one pointing away from the room center.
  let nx = -uy;
  let ny = ux;
  if (nx * (ROOM_CENTER.x - edge.a.x) + ny * (ROOM_CENTER.y - edge.a.y) > 0) {
    nx = -nx;
    ny = -ny;
  }
  return { a: { x: edge.a.x, y: edge.a.y }, b: { x: edge.b.x, y: edge.b.y }, ux, uy, nx, ny, len };
}

const quad = (
  g: Graphics,
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  p3: { x: number; y: number },
  p4: { x: number; y: number },
  fill: number,
  alpha = 1,
): void => {
  g.poly([p1.x, p1.y, p2.x, p2.y, p3.x, p3.y, p4.x, p4.y]);
  g.fill({ color: fill, alpha });
};

export function buildWalls(ctx: DioramaContext): void {
  const root = new Container();
  const g = new Graphics();
  const walls = [wallFrame(WALL_EDGES.west), wallFrame(WALL_EDGES.east)];

  for (const w of walls) {
    const ix = -w.nx;
    const iy = -w.ny;
    const up = (p: { x: number; y: number }, h: number): { x: number; y: number } => ({
      x: p.x,
      y: p.y - h,
    });
    const off = (p: { x: number; y: number }, dx: number, dy: number): { x: number; y: number } => ({
      x: p.x + dx,
      y: p.y + dy,
    });
    const oa = off(w.a, w.nx * WALL_T, w.ny * WALL_T);
    const ob = off(w.b, w.nx * WALL_T, w.ny * WALL_T);
    // West wall catches more light than the back-right wall; a small value
    // step keeps the two planes readable without leaving palette blues.
    const innerTone =
      w.b.x < w.a.x ? shade(PALETTE.structureLight, 0.03) : shade(PALETTE.structureLight, -0.12);

    // Contact occlusion on the floor just inside the wall base.
    quad(g, w.a, w.b, off(w.b, ix * 16, iy * 16), off(w.a, ix * 16, iy * 16), 0x000000, 0.2);

    // Outer face (darkest; reads as a sliver beyond the top band).
    quad(g, oa, ob, up(ob, WALL_H), up(oa, WALL_H), rightFace(PALETTE.structureLight));
    // Top band between the two top edges (the walkable rim of the wall).
    quad(g, up(w.a, WALL_H), up(w.b, WALL_H), up(ob, WALL_H), up(oa, WALL_H), topFace(PALETTE.structureLight));
    // End cap at the W/E corner so the wall never reads paper-thin.
    quad(g, w.b, ob, up(ob, WALL_H), up(w.b, WALL_H), rightFace(PALETTE.structure));
    // Inner face: the plane the camera actually reads.
    quad(g, w.a, w.b, up(w.b, WALL_H), up(w.a, WALL_H), innerTone);

    // Wainscot: darker base band with a pale trim line at its top edge.
    quad(g, w.a, w.b, up(w.b, WAINSCOT_H), up(w.a, WAINSCOT_H), rightFace(PALETTE.structureLight));
    g.moveTo(w.a.x, w.a.y - WAINSCOT_H);
    g.lineTo(w.b.x, w.b.y - WAINSCOT_H);
    g.stroke({ width: 1, color: PALETTE.surfacePale, alpha: 0.22 });

    // Pilaster rhythm: proud vertical ribs every ~200 units along the face.
    for (let s = PILASTER_START; s < w.len - 50; s += PILASTER_STEP) {
      const px = w.a.x + w.ux * s;
      const py = w.a.y + w.uy * s;
      const ribA = off({ x: px - w.ux * 7, y: py - w.uy * 7 }, ix * 3, iy * 3);
      const ribB = off({ x: px + w.ux * 7, y: py + w.uy * 7 }, ix * 3, iy * 3);
      quad(g, ribA, ribB, up(ribB, WALL_H - 4), up(ribA, WALL_H - 4), shade(PALETTE.structureLight, 0.16));
      // Shade edge on the N-facing side of each rib for a cast read.
      g.moveTo(ribA.x, ribA.y);
      g.lineTo(ribA.x, ribA.y - (WALL_H - 4));
      g.stroke({ width: 1, color: PALETTE.space, alpha: 0.45 });
    }

    // Wall/floor junction line.
    g.moveTo(w.a.x, w.a.y);
    g.lineTo(w.b.x, w.b.y);
    g.stroke({ width: 1, color: PALETTE.surfacePale, alpha: 0.15 });

    // Emissive cyan rims: bright on the inner (readable) top edge, faint outside.
    g.moveTo(w.a.x, w.a.y - WALL_H);
    g.lineTo(w.b.x, w.b.y - WALL_H);
    g.stroke({ width: 1.6, color: PALETTE.cyan, alpha: 0.75 });
    g.moveTo(oa.x, oa.y - WALL_H);
    g.lineTo(ob.x, ob.y - WALL_H);
    g.stroke({ width: 1.2, color: PALETTE.cyan, alpha: 0.3 });
  }

  // Corner rib at the N miter: covers the seam where the two walls meet and
  // gives the room's back corner a deliberate architectural endpoint.
  const cx = WALL_EDGES.west.a.x;
  const cy = WALL_EDGES.west.a.y;
  g.poly([cx - 8, cy, cx + 8, cy, cx + 8, cy - WALL_H, cx - 8, cy - WALL_H]);
  g.fill({ color: shade(PALETTE.structureLight, 0.1) });
  g.moveTo(cx - 8, cy - WALL_H);
  g.lineTo(cx + 8, cy - WALL_H);
  g.stroke({ width: 2, color: PALETTE.cyan, alpha: 0.8 });

  root.addChild(g);
  ctx.layers.ground.addChild(root);
}
