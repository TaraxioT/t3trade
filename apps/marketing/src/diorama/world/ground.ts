/**
 * Campus ground: the floating island slab, per-district floor inlays, tile
 * grids, entrance walkways, small bridges, and deterministic scatter detail.
 * Everything is static and drawn once into the unsorted ground layer.
 * Owner: ground worker.
 */
import { Container, Graphics } from "pixi.js";
import type { DioramaContext } from "../core/context.js";
import { edgeStrip, glow, isoBox } from "../core/iso.js";
import { leftFace, PALETTE, rightFace, shade } from "../config/palette.js";
import { DISTRICTS } from "../config/stations.js";
import { WALKWAY_RESEARCH, WALKWAY_SOUTH } from "../config/geometry.js";
import { seededRandom } from "../config/world.js";

/** Campus slab extent (the floating island cross-section). */
const SLAB = { x1: 180, y1: 140, x2: 2620, y2: 1430 } as const;
const SLAB_R = 70;
/** Visible slab thickness below the top surface. */
const SLAB_T = 34;

function polyPath(g: Graphics, pts: Array<{ x: number; y: number }>): void {
  g.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);
}

/** The floating island: pale-rimmed slab with a layered thickness cross-section
 * and a soft drop shadow into space so the campus reads as mass, not a decal. */
function buildSlab(root: Container): void {
  const g = new Graphics();
  const w = SLAB.x2 - SLAB.x1;
  const h = SLAB.y2 - SLAB.y1;

  // Drop shadow: large soft dark ellipse below the whole slab, offset south.
  const shadow = new Graphics();
  shadow.ellipse(
    (SLAB.x1 + SLAB.x2) / 2,
    (SLAB.y1 + SLAB.y2) / 2 + 30,
    w * 0.55,
    h * 0.24,
  );
  shadow.fill({ color: 0x000000, alpha: 0.5 });
  root.addChild(shadow);

  // Cross-section: dark under-crust, mid band, lighter upper band, top face.
  g.roundRect(SLAB.x1, SLAB.y1 + SLAB_T * 0.4, w, h + SLAB_T, SLAB_R);
  g.fill({ color: shade(PALETTE.structure, -0.45) });
  g.roundRect(SLAB.x1, SLAB.y1 + SLAB_T * 0.25, w, h + SLAB_T, SLAB_R);
  g.fill({ color: rightFace(PALETTE.structure) });
  g.roundRect(SLAB.x1, SLAB.y1, w, h + SLAB_T * 0.5, SLAB_R);
  g.fill({ color: leftFace(PALETTE.structure) });
  g.roundRect(SLAB.x1, SLAB.y1, w, h, SLAB_R);
  g.fill({ color: shade(PALETTE.structureLight, -0.18) });

  // Pale rim edge so the island outline reads clearly against the void.
  g.roundRect(SLAB.x1, SLAB.y1, w, h, SLAB_R);
  g.stroke({ width: 2.5, color: PALETTE.surfacePale, alpha: 0.5 });
  // A faint underline shadow on the cross-section for depth.
  g.roundRect(SLAB.x1 + 6, SLAB.y1 + SLAB_T, w - 12, h, SLAB_R);
  g.stroke({ width: 1, color: PALETTE.space, alpha: 0.4 });

  root.addChild(g);
}

/** Per-district floor inlays with a subtle 2:1 diamond tile grid. Each
 * district gets a distinct accent wash so zones read as different materials
 * at fit zoom instead of one monochrome field. */
const DISTRICT_WASH: Record<string, number> = {
  research: 0x34e5e5, // cyan
  floor: 0x5a7cff, // blue
  mcp: 0x9a70ff, // violet
  risk: 0xffd35a, // warm gold
  ops: 0x56f2c2, // aqua green
  supervisor: 0xff9f45, // orange
};

function buildDistrictInlays(root: Container): void {
  const fills = new Graphics();
  const grid = new Graphics();

  for (const def of Object.values(DISTRICTS)) {
    if (def.id === "external") continue; // Hyperliquid owns its own platform.
    const { x1, y1, x2, y2 } = def.bounds;
    const pad = 10;
    const b = { x: x1 + pad, y: y1 + pad, w: x2 - x1 - pad * 2, h: y2 - y1 - pad * 2 };

    // Structural tint plus the district-specific accent wash.
    fills.roundRect(b.x, b.y, b.w, b.h, 26);
    fills.fill({ color: PALETTE.structureLight, alpha: 0.5 });
    fills.roundRect(b.x, b.y, b.w, b.h, 26);
    fills.fill({ color: DISTRICT_WASH[def.id] ?? def.accent, alpha: 0.12 });
    fills.roundRect(b.x, b.y, b.w, b.h, 26);
    fills.stroke({ width: 1.2, color: def.accent, alpha: 0.22 });

    // 2:1 diamond lattice: diagonal lines at slopes +0.5 and -0.5.
    const step = 96;
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    for (let o = -Math.max(b.w, b.h); o < Math.max(b.w, b.h); o += step) {
      grid.moveTo(cx + o, cy - b.h);
      grid.lineTo(cx + o + b.h * 2, cy + b.h);
      grid.stroke({ width: 0.5, color: PALETTE.surfacePale, alpha: 0.08 });
      grid.moveTo(cx + o, cy - b.h);
      grid.lineTo(cx + o - b.h * 2, cy + b.h);
      grid.stroke({ width: 0.5, color: PALETTE.surfacePale, alpha: 0.08 });
    }
  }

  root.addChild(fills);
  root.addChild(grid);
}

/** Pale-edged walkway along a config polyline with low emissive side strips
 * and additive center guide dots every ~40 units (drawn once, static). */
function buildWalkway(root: Container, pts: Array<{ x: number; y: number }>): void {
  const body = new Graphics();
  polyPath(body, pts);
  body.stroke({ width: 20, color: PALETTE.surfacePale, alpha: 0.16, cap: "round", join: "round" });
  polyPath(body, pts);
  body.stroke({ width: 1.5, color: PALETTE.surfacePale, alpha: 0.3, cap: "round" });
  root.addChild(body);

  const guides = new Graphics();
  guides.blendMode = "add";

  // Emissive edge strips offset to each side of the path.
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * 9;
    const ny = (dx / len) * 9;
    for (const s of [1, -1]) {
      root.addChild(
        edgeStrip(a.x + nx * s, a.y + ny * s, b.x + nx * s, b.y + ny * s, PALETTE.aqua, 0.22, 1),
      );
    }
    // Center dashed guide lights along the segment.
    const count = Math.max(1, Math.floor(len / 40));
    for (let k = 0; k <= count; k++) {
      const t = k / count;
      guides.circle(a.x + dx * t, a.y + dy * t, 1.6);
      guides.fill({ color: PALETTE.aqua, alpha: 0.5 });
    }
  }
  root.addChild(guides);
}

/** A small raised bridge slab with deck planks, rail posts, and an ambient
 * occlusion shadow on the floor beneath it. */
function buildBridge(root: Container, cx: number, cy: number, horizontal: boolean): void {
  const w = horizontal ? 96 : 40;
  const d = horizontal ? 34 : 84;

  // AO shadow on the deck approach before the slab draws over it.
  const ao = new Graphics();
  ao.ellipse(cx, cy + 4, horizontal ? w * 0.55 : d * 0.5, horizontal ? d * 0.5 : w * 0.55);
  ao.fill({ color: 0x000000, alpha: 0.22 });
  root.addChild(ao);

  root.addChild(
    isoBox({
      x: cx,
      y: cy,
      w,
      d,
      h: 10,
      color: PALETTE.structureLight,
      rim: PALETTE.surfacePale,
      rimAlpha: 0.4,
    }),
  );

  // Deck planks: transverse darker seams across the walk surface.
  const planks = new Graphics();
  const span = horizontal ? w : d;
  const ox = horizontal ? 0 : d / 2.6;
  const oy = horizontal ? d / 2.6 : 0;
  for (let i = 0; i <= 6; i++) {
    const t = -span / 2 + (span / 6) * i;
    planks.moveTo(cx + (horizontal ? t : -ox), cy + (horizontal ? -oy : t));
    planks.lineTo(cx + (horizontal ? t : ox), cy + (horizontal ? oy : t));
    planks.stroke({ width: 1, color: PALETTE.structure, alpha: 0.55 });
  }
  root.addChild(planks);

  // Rail posts: thin vertical pins, height well under the 18-unit cap.
  const posts = new Graphics();
  for (let i = 0; i <= 4; i++) {
    const t = -span / 2 + (span / 4) * i;
    for (const s of [1, -1]) {
      const px = horizontal ? cx + t : cx + (s * d) / 2.6;
      const py = horizontal ? cy + (s * d) / 2.6 : cy + t;
      posts.moveTo(px, py - 10);
      posts.lineTo(px, py - 24);
      posts.stroke({ width: 1.5, color: PALETTE.surfacePale, alpha: 0.5 });
    }
  }
  root.addChild(posts);
}

/** Angled causeway platform tying the sandbox overhang back to the research
 * slab edge: structure + rim only, no rails (rails live in config/rails.ts). */
function buildSandboxCauseway(root: Container): void {
  const g = new Graphics();
  // Deck: an angled quad from the west slab edge toward the sandbox zone.
  const deck = [
    { x: 186, y: 566 },
    { x: 300, y: 598 },
    { x: 300, y: 648 },
    { x: 186, y: 618 },
  ];
  // Side thickness below the deck outline.
  g.poly([deck[3].x, deck[3].y, deck[2].x, deck[2].y, deck[2].x, deck[2].y + 12, deck[3].x, deck[3].y + 12]);
  g.fill({ color: rightFace(PALETTE.structure) });
  g.poly(deck.flatMap((p) => [p.x, p.y]));
  g.fill({ color: leftFace(PALETTE.structureLight) });
  g.poly(deck.flatMap((p) => [p.x, p.y]));
  g.stroke({ width: 1.5, color: PALETTE.surfacePale, alpha: 0.35 });
  root.addChild(g);
}

/** Deterministic scatter: vents and hatches (<= 40 props). Cable conduits were
 * removed: they doubled up the rail network's line language on the floor. */
function buildScatter(root: Container): void {
  const rnd = seededRandom(23);
  const g = new Graphics();
  const vents = 12;
  const hatches = 10;

  for (let i = 0; i < vents; i++) {
    const x = SLAB.x1 + 60 + rnd() * (SLAB.x2 - SLAB.x1 - 120);
    const y = SLAB.y1 + 60 + rnd() * (SLAB.y2 - SLAB.y1 - 120);
    const s = 7 + rnd() * 5;
    g.roundRect(x - s, y - s * 0.6, s * 2, s * 1.2, 2);
    g.fill({ color: PALETTE.structure, alpha: 0.8 });
    g.moveTo(x - s * 0.6, y);
    g.lineTo(x + s * 0.6, y);
    g.stroke({ width: 1, color: PALETTE.inkDim, alpha: 0.25 });
  }

  for (let i = 0; i < hatches; i++) {
    const x = SLAB.x1 + 80 + rnd() * (SLAB.x2 - SLAB.x1 - 160);
    const y = SLAB.y1 + 80 + rnd() * (SLAB.y2 - SLAB.y1 - 160);
    const s = 9 + rnd() * 5;
    g.roundRect(x - s, y - s, s * 2, s * 2, 3);
    g.stroke({ width: 1.2, color: PALETTE.inkDim, alpha: 0.22 });
    g.moveTo(x - s * 0.4, y);
    g.lineTo(x + s * 0.4, y);
    g.stroke({ width: 1.2, color: PALETTE.inkDim, alpha: 0.3 });
  }

  root.addChild(g);

  // Mid-campus garden cluster: the slab band between sandbox, event bus, and
  // the decision table reads as a void otherwise. A small planter row with
  // glow reeds and a relay pylon grounds the space without blocking paths.
  const garden = new Container();
  for (const [gx, gy, hue] of [
    [640, 815, PALETTE.aqua],
    [700, 845, PALETTE.cyan],
    [590, 870, PALETTE.violet],
  ] as Array<[number, number, number]>) {
    const planter = new Graphics();
    planter.ellipse(gx, gy + 6, 22, 10);
    planter.fill({ color: PALETTE.structure, alpha: 0.9 });
    planter.ellipse(gx, gy + 6, 22, 10);
    planter.stroke({ width: 1, color: PALETTE.structureLight, alpha: 0.8 });
    for (let r = 0; r < 3; r++) {
      const rx = gx - 10 + r * 10;
      planter.moveTo(rx, gy + 2);
      planter.lineTo(rx + (r - 1) * 3, gy - 16);
      planter.stroke({ width: 1.5, color: hue, alpha: 0.75 });
      planter.circle(rx + (r - 1) * 3, gy - 17, 2.2);
      planter.fill({ color: hue, alpha: 0.85 });
    }
    garden.addChild(planter);
  }
  const pylon = new Graphics();
  pylon.rect(806, 858, 5, 26);
  pylon.fill({ color: PALETTE.structureLight });
  pylon.circle(808.5, 854, 3.4);
  pylon.fill({ color: PALETTE.cyan, alpha: 0.95 });
  garden.addChild(pylon);
  garden.addChild(glow(808.5, 854, 26, PALETTE.cyan, 0.4));
  root.addChild(garden);
}

export function buildGround(ctx: DioramaContext): void {
  const root = new Container();
  buildSlab(root);
  buildDistrictInlays(root);
  buildSandboxCauseway(root);
  buildWalkway(root, [...WALKWAY_SOUTH]);
  buildWalkway(root, [...WALKWAY_RESEARCH]);
  // Bridges: research district to the central floor, and ops to the floor.
  buildBridge(root, 1075, 545, true);
  buildBridge(root, 1495, 1030, false);
  buildScatter(root);
  ctx.layers.ground.addChild(root);
}
