/**
 * Transparent safety perimeter with its three controlled crossings:
 * west approval gate, east exchange tunnel, and the one-way south exit port.
 * One slow ambient shimmer travels the top edge (disabled in reduced motion).
 * Owner: ground worker.
 */
import { Container, Graphics, Sprite } from "pixi.js";
import gsap from "gsap";
import type { DioramaContext } from "../core/context.js";
import { arch, edgeStrip, glow, isoBox, isoWall } from "../core/iso.js";
import { PALETTE, shade } from "../config/palette.js";
import {
  EXIT_SOUTH,
  GATE_WEST,
  PERIMETER,
  TUNNEL_EAST,
} from "../config/geometry.js";
import { DEPTH } from "../config/world.js";

export interface PerimeterApi {
  /** Play the authority-granted sweep along a crossing. */
  grantPulse(crossing: "west" | "east" | "south"): void;
  /** Flash refusal at the west gate. */
  refusePulse(): void;
}

/** Populated by buildPerimeter; consumed by the director/stories. */
export const perimeter = { api: null as PerimeterApi | null };

const { x1, x2, y1, y2, wallH, color } = PERIMETER;

/** Corner post height; taller than the wall so the rect corners read first. */
const POST_H = 90;

/** One glass wall segment: two stacked bands (denser base, airier top) plus a
 * bright emissive top edge with a soft additive halo. Visibility first: the
 * perimeter must survive a 1920px fit-view screenshot. */
function wallSegment(root: Container, a: { x: number; y: number }, b: { x: number; y: number }): void {
  const lowerH = Math.round(wallH * 0.55);
  root.addChild(
    isoWall({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, h: lowerH, color, alpha: 0.26 }),
  );
  root.addChild(
    isoWall({
      x1: a.x,
      y1: a.y - lowerH,
      x2: b.x,
      y2: b.y - lowerH,
      h: wallH - lowerH,
      color,
      alpha: 0.14,
      rim: PALETTE.cyan,
    }),
  );
  root.addChild(edgeStrip(a.x, a.y - wallH, b.x, b.y - wallH, PALETTE.cyan, 0.95, 2.5));
  const halo = glow(
    (a.x + b.x) / 2,
    (a.y + b.y) / 2 - wallH,
    Math.max(70, Math.hypot(b.x - a.x, b.y - a.y)),
    PALETTE.cyan,
    0.2,
  );
  halo.height = 14;
  root.addChild(halo);
}

/** Pale-cyan glowing threshold strip on the floor at a controlled crossing. */
function thresholdStrip(
  root: Container,
  a: { x: number; y: number },
  b: { x: number; y: number },
): void {
  root.addChild(edgeStrip(a.x, a.y, b.x, b.y, shade(PALETTE.cyan, 0.45), 0.5, 2));
}

function buildWalls(root: Container): Sprite[] {
  // West wall split around the approval gate opening.
  wallSegment(root, { x: x1, y: y1 }, { x: x1, y: GATE_WEST.y1 });
  wallSegment(root, { x: x1, y: GATE_WEST.y2 }, { x: x1, y: y2 });
  // East wall split around the exchange tunnel opening.
  wallSegment(root, { x: x2, y: y1 }, { x: x2, y: TUNNEL_EAST.y1 });
  wallSegment(root, { x: x2, y: TUNNEL_EAST.y2 }, { x: x2, y: y2 });
  // North wall, uninterrupted.
  wallSegment(root, { x: x1, y: y1 }, { x: x2, y: y1 });
  // South wall split around the exit port.
  wallSegment(root, { x: x1, y: y2 }, { x: EXIT_SOUTH.x1, y: y2 });
  wallSegment(root, { x: EXIT_SOUTH.x2, y: y2 }, { x: x2, y: y2 });

  // Glowing floor thresholds at every controlled crossing.
  thresholdStrip(root, { x: x1, y: GATE_WEST.y1 + 8 }, { x: x1, y: GATE_WEST.y2 - 8 });
  thresholdStrip(root, { x: x2, y: TUNNEL_EAST.y1 + 8 }, { x: x2, y: TUNNEL_EAST.y2 - 8 });
  thresholdStrip(root, { x: EXIT_SOUTH.x1 + 8, y: y2 }, { x: EXIT_SOUTH.x2 - 8, y: y2 });

  // Corner posts with beacon dots that chase along the rect.
  const beacons: Sprite[] = [];
  for (const [px, py] of [
    [x1, y1],
    [x2, y1],
    [x2, y2],
    [x1, y2],
  ]) {
    root.addChild(
      isoBox({
        x: px,
        y: py,
        w: 18,
        d: 18,
        h: POST_H,
        color: PALETTE.structure,
        rim: PALETTE.cyan,
        rimAlpha: 0.95,
      }),
    );
    const beacon = glow(px, py - POST_H - 4, 16, PALETTE.cyan, 0.8);
    beacons.push(beacon);
    root.addChild(beacon);
  }
  return beacons;
}

/** West approval gate: frame, green authority glow strip, APPROVAL sign. */
function buildWestGate(root: Container, ctx: DioramaContext): void {
  const frame = new Container();
  for (const gy of [GATE_WEST.y1, GATE_WEST.y2]) {
    frame.addChild(
      isoBox({
        x: x1,
        y: gy,
        w: 14,
        d: 14,
        h: wallH,
        color: PALETTE.structureLight,
        rim: PALETTE.cyan,
        rimAlpha: 0.8,
      }),
    );
  }
  // Lintel beam across the top of the opening.
  const beam = new Graphics();
  beam.moveTo(x1 - 8, GATE_WEST.y1 - wallH);
  beam.lineTo(x1 + 8, GATE_WEST.y1 - wallH);
  beam.lineTo(x1 + 8, GATE_WEST.y2 - wallH);
  beam.lineTo(x1 - 8, GATE_WEST.y2 - wallH);
  beam.closePath();
  beam.fill({ color: PALETTE.structureLight, alpha: 0.9 });
  beam.stroke({ width: 1.5, color: PALETTE.cyan, alpha: 0.7 });
  frame.addChild(beam);
  root.addChild(frame);

  // Authority glow strip in the opening; the floor stays clear for the
  // approval station built by another worker.
  const strip = edgeStrip(
    x1,
    GATE_WEST.y1 + 10,
    x1,
    GATE_WEST.y2 - 10,
    PALETTE.healthy,
    0.4,
    2,
  );
  root.addChild(strip);
  // No APPROVAL sign here: the approval station itself signs the gate, and a
  // second board at the same opening would double the label.
}

/** East exchange tunnel: low casing walls plus arched ribs heading east. */
function buildEastTunnel(root: Container): void {
  const { y1: ty1, y2: ty2 } = TUNNEL_EAST;
  root.addChild(
    isoWall({ x1: x2, y1: ty1, x2: x2 + 52, y2: ty1 - 8, h: 34, color: PALETTE.structureLight, alpha: 0.9, rim: PALETTE.cyan }),
  );
  root.addChild(
    isoWall({ x1: x2, y1: ty2, x2: x2 + 52, y2: ty2 + 8, h: 34, color: PALETTE.structureLight, alpha: 0.9, rim: PALETTE.cyan }),
  );
  for (const rx of [x2 + 14, x2 + 34, x2 + 54]) {
    root.addChild(arch(rx, ty2, ty2 - ty1 + 24, 62, PALETTE.structureLight, PALETTE.cyan));
  }
}

/** South exit port: one-way frame with an outward chevron decal. */
function buildSouthExit(root: Container): void {
  const { x1: ex1, x2: ex2, cx } = EXIT_SOUTH;
  for (const px of [ex1, ex2]) {
    root.addChild(
      isoBox({
        x: px,
        y: y2,
        w: 12,
        d: 12,
        h: 40,
        color: PALETTE.structureLight,
        rim: PALETTE.cyan,
        rimAlpha: 0.8,
      }),
    );
  }
  const lintel = new Graphics();
  lintel.moveTo(ex1, y2 - 44);
  lintel.lineTo(ex2, y2 - 44);
  lintel.stroke({ width: 3, color: PALETTE.structureLight, alpha: 0.95 });
  lintel.moveTo(ex1, y2 - 44);
  lintel.lineTo(ex2, y2 - 44);
  lintel.stroke({ width: 1, color: PALETTE.cyan, alpha: 0.7 });
  root.addChild(lintel);

  // Outward (southward) chevron decal, additive, pointing out of the campus.
  const chevron = new Graphics();
  chevron.moveTo(cx - 14, y2 + 6);
  chevron.lineTo(cx, y2 + 18);
  chevron.lineTo(cx + 14, y2 + 6);
  chevron.stroke({ width: 2.5, color: PALETTE.cyan, alpha: 0.6 });
  chevron.moveTo(cx - 14, y2 + 16);
  chevron.lineTo(cx, y2 + 28);
  chevron.lineTo(cx + 14, y2 + 16);
  chevron.stroke({ width: 2, color: PALETTE.cyan, alpha: 0.35 });
  chevron.blendMode = "add";
  root.addChild(chevron);
}

/**
 * Slow shimmer: one shared gradient sprite traveling the top edge of the
 * perimeter rect over 8 s. Disabled entirely under reduced motion.
 */
function startShimmer(root: Container, ctx: DioramaContext): void {
  if (ctx.reducedMotion) return;
  const shimmer = glow(0, 0, 130, PALETTE.cyan, 0.45);
  shimmer.height = 12;
  shimmer.alpha = 0;
  root.addChild(shimmer);

  // Top edge path length parameterized 0..1, moving west -> east -> fade out.
  const total = (x2 - x1) + 2 * 120;
  const un = ctx.onTick((ticker) => {
    const t = ((ticker.elapsedMS % 8000) / 8000) * total;
    if (t < x2 - x1) {
      shimmer.position.set(x1 + t, y1 - wallH);
      shimmer.alpha = 0.45 * Math.sin((t / (x2 - x1)) * Math.PI);
    } else {
      shimmer.alpha = 0;
    }
  });
  ctx.onCleanup(un);
}

export function buildPerimeter(ctx: DioramaContext): void {
  const root = new Container();
  // Behind all district content inside the perimeter band.
  root.zIndex = y1 + DEPTH.ground / 2; // just above ground, below structures
  const beacons = buildWalls(root);
  buildWestGate(root, ctx);
  buildEastTunnel(root);
  buildSouthExit(root);

  // Beacon chase: one shared tick drives all four corner dots; each corner
  // peaks in turn so the safety rect keeps a slow living pulse. Static lit
  // dots under reduced motion.
  if (ctx.reducedMotion) {
    for (const b of beacons) b.alpha = 0.7;
  } else {
    const unBeacon = ctx.onTick((ticker) => {
      const t = (ticker.elapsedMS % 3200) / 3200;
      beacons.forEach((b, i) => {
        const phase = t * Math.PI * 2 - (i * Math.PI) / 2;
        b.alpha = 0.3 + 0.6 * Math.max(0, Math.sin(phase));
      });
    });
    ctx.onCleanup(unBeacon);
  }

  // --- Crossing pulse effects (pooled, reused across calls) -----------------
  const pulse = glow(0, 0, 160, PALETTE.healthy, 0);
  root.addChild(pulse);
  let pulseTween: gsap.core.Tween | null = null;

  const CROSSING_POS: Record<"west" | "east" | "south", { x: number; y: number }> = {
    west: { x: x1, y: GATE_WEST.cy },
    east: { x: x2, y: TUNNEL_EAST.cy },
    south: { x: EXIT_SOUTH.cx, y: y2 },
  };

  const refuse = new Graphics();
  refuse.moveTo(x1 - 7, GATE_WEST.y1 - 8);
  refuse.lineTo(x1 + 7, GATE_WEST.y1 - 8);
  refuse.lineTo(x1 + 7, GATE_WEST.y2 + 8);
  refuse.lineTo(x1 - 7, GATE_WEST.y2 + 8);
  refuse.closePath();
  refuse.fill({ color: PALETTE.blocked, alpha: 0 });
  refuse.blendMode = "add";
  root.addChild(refuse);
  let refuseTween: gsap.core.Tween | gsap.core.Timeline | null = null;

  perimeter.api = {
    grantPulse(crossing) {
      const pos = CROSSING_POS[crossing];
      pulse.position.set(pos.x, pos.y - wallH / 2);
      pulse.tint = PALETTE.healthy;
      pulseTween?.kill();
      pulseTween = gsap.fromTo(
        pulse,
        { alpha: 0.8, width: 200, height: 200 },
        {
          alpha: 0,
          width: 340,
          height: 340,
          duration: 0.7,
          ease: "power2.out",
        },
      );
    },
    refusePulse() {
      refuseTween?.kill();
      refuseTween = gsap
        .timeline()
        .fromTo(refuse, { alpha: 0.6 }, { alpha: 0.25, duration: 0.25, ease: "power1.out" })
        .to(refuse, { alpha: 0, duration: 0.45, ease: "power1.in" });
    },
  };
  ctx.onCleanup(() => {
    pulseTween?.kill();
    refuseTween?.kill();
    perimeter.api = null;
  });

  startShimmer(root, ctx);
  ctx.layers.sortable.addChild(root);
}
