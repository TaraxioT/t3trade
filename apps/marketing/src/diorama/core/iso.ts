/**
 * Shared 2:1 isometric drawing kit. Every structure in every district is
 * assembled from these primitives so the world reads as one coherent place:
 *
 * Style rules (binding for all station builders):
 * - Classic 2:1 iso: floor diamonds are twice as wide as tall; box walls are
 *   vertical screens (no convergence). Never draw perspective vanishing points.
 * - Three-tone shading via palette.ts helpers: top face lightest, left face
 *   base tone, right face darkest.
 * - Emissive accents only as thin trims, screens, and glows against the dark
 *   structural blues. The world must stay readable when paused.
 * - Signs/labels are NEVER baked into graphics; use core/signs.ts.
 * - Build static structure once into Graphics; do not redraw per frame.
 *   Animate by toggling child visibility/alpha or moving sprites.
 */
import { Container, Graphics, Sprite, Texture, type DestroyOptions } from "pixi.js";
import { leftFace, rightFace, topFace } from "../config/palette.js";

/**
 * Destroy a display object from an animation callback without corrupting the
 * renderer's cached render groups. Detach immediately (structure change is
 * picked up on the next instruction rebuild) and defer the actual destroy
 * past the frame's remaining rAF work: destroying while the object is still
 * in a render group's pending update list throws
 * "reading 'updateRenderable'".
 */
export function safeDestroy(target: Container, options?: DestroyOptions): void {
  target.removeFromParent();
  window.setTimeout(() => {
    target.destroy(options);
  }, 0);
}

export interface IsoBoxOptions {
  /** Base center X (world units). */
  x: number;
  /** Base center Y; the box footprint is centered here and extrudes upward. */
  y: number;
  /** Footprint screen width. */
  w: number;
  /** Footprint screen depth (the diamond's full height). */
  d: number;
  /** Wall height. */
  h: number;
  /** Base structural color (palette integer). */
  color: number;
  /** Optional emissive trim color drawn on the top rim. */
  rim?: number;
  /** Trim alpha. */
  rimAlpha?: number;
  /** Face alpha. */
  alpha?: number;
}

/** Extruded iso box: top diamond lifted by h, left and right wall faces. */
export function isoBox(opts: IsoBoxOptions): Graphics {
  const { x, y, w, d, h, color, rim, rimAlpha = 0.9, alpha = 1 } = opts;
  const hw = w / 2;
  const hd = d / 2;
  const g = new Graphics();

  // Left face: from west corner down to south corner, up by h.
  g.poly([x - hw, y, x, y + hd, x, y + hd - h, x - hw, y - h]);
  g.fill({ color: leftFace(color), alpha });
  // Right face: from south corner to east corner.
  g.poly([x + hw, y, x, y + hd, x, y + hd - h, x + hw, y - h]);
  g.fill({ color: rightFace(color), alpha });
  // Top diamond.
  g.poly([x - hw, y - h, x, y + hd - h, x + hw, y - h, x, y - hd - h]);
  g.fill({ color: topFace(color), alpha });
  if (rim !== undefined) {
    g.poly([x - hw, y - h, x, y + hd - h, x + hw, y - h, x, y - hd - h]);
    g.stroke({ width: 1.5, color: rim, alpha: rimAlpha });
  }
  return g;
}

/** Flat 2:1 diamond floor tile/platform centered at (x, y). */
export function isoTile(
  x: number,
  y: number,
  w: number,
  d: number,
  color: number,
  alpha = 1,
  rim?: number,
): Graphics {
  const hw = w / 2;
  const hd = d / 2;
  const g = new Graphics();
  g.poly([x - hw, y, x, y + hd, x + hw, y, x, y - hd]);
  g.fill({ color, alpha });
  if (rim !== undefined) {
    g.poly([x - hw, y, x, y + hd, x + hw, y, x, y - hd]);
    g.stroke({ width: 1, color: rim, alpha: 0.5 });
  }
  return g;
}

export interface CylinderOptions {
  x: number;
  /** Base center Y of the bottom ellipse. */
  y: number;
  /** Screen radius (ellipse half-width; half-height is radius * 0.5). */
  r: number;
  h: number;
  color: number;
  alpha?: number;
  rim?: number;
}

/** Iso cylinder (tank, tower core, pillar). */
export function isoCylinder(opts: CylinderOptions): Graphics {
  const { x, y, r, h, color, alpha = 1, rim } = opts;
  const rh = r * 0.5;
  const g = new Graphics();
  // Body: rectangle between the two ellipse centers, then cap.
  g.rect(x - r, y - h, r * 2, h);
  g.fill({ color: leftFace(color), alpha });
  // Right-side shading half for roundness.
  g.poly([x, y - h, x + r, y - h, x + r, y, x, y]);
  g.fill({ color: rightFace(color), alpha });
  // Bottom ellipse arc (visible lower half).
  g.ellipse(x, y, r, rh);
  g.fill({ color: rightFace(color), alpha });
  // Top cap.
  g.ellipse(x, y - h, r, rh);
  g.fill({ color: topFace(color), alpha });
  if (rim !== undefined) {
    g.ellipse(x, y - h, r, rh);
    g.stroke({ width: 1.5, color: rim, alpha: 0.85 });
  }
  return g;
}

export interface WallOptions {
  /** Segment start. */
  x1: number;
  y1: number;
  /** Segment end. */
  x2: number;
  y2: number;
  /** Wall height. */
  h: number;
  color: number;
  alpha?: number;
  /** Emissive top edge color. */
  rim?: number;
}

/** Low wall extruded along an arbitrary segment (perimeter glass, railsides). */
export function isoWall(opts: WallOptions): Graphics {
  const { x1, y1, x2, y2, h, color, alpha = 1, rim } = opts;
  const g = new Graphics();
  // Screen-facing quad: segment extruded upward.
  g.poly([x1, y1, x2, y2, x2, y2 - h, x1, y1 - h]);
  g.fill({ color, alpha });
  // Top face strip (narrow band suggesting thickness).
  const nx = -(y2 - y1) * 0.06;
  const ny = (x2 - x1) * 0.06;
  g.poly([x1, y1 - h, x2, y2 - h, x2 + nx, y2 - h + ny, x1 + nx, y1 - h + ny]);
  g.fill({ color: topFace(color), alpha });
  if (rim !== undefined) {
    g.moveTo(x1, y1 - h);
    g.lineTo(x2, y2 - h);
    g.stroke({ width: 1.5, color: rim, alpha: 0.8 });
  }
  return g;
}

/**
 * Open archway: two pillars plus a beam. Used for risk scanning arches,
 * gates, and entrances. Faces camera (billboard) for maximum readability.
 */
export function arch(
  x: number,
  y: number,
  span: number,
  height: number,
  color: number,
  rim?: number,
): Container {
  const c = new Container();
  const pillarW = Math.max(8, span * 0.12);
  for (const px of [x - span / 2, x + span / 2 - pillarW]) {
    const pillar = new Graphics();
    pillar.roundRect(px, y - height, pillarW, height, 3);
    pillar.fill({ color: leftFace(color) });
    pillar.roundRect(px + pillarW * 0.45, y - height, pillarW * 0.55, height, 3);
    pillar.fill({ color: rightFace(color), alpha: 0.7 });
    c.addChild(pillar);
  }
  const beam = new Graphics();
  beam.roundRect(x - span / 2 - 4, y - height, span + 8, Math.max(7, height * 0.09), 3);
  beam.fill({ color: topFace(color) });
  if (rim !== undefined) {
    beam.roundRect(x - span / 2 - 4, y - height, span + 8, Math.max(7, height * 0.09), 3);
    beam.stroke({ width: 1.5, color: rim, alpha: 0.9 });
  }
  c.addChild(beam);
  return c;
}

export interface ScreenOptions {
  x: number;
  /** Top-left Y of the panel (billboard facing camera). */
  y: number;
  w: number;
  h: number;
  /** Emissive frame/trim color. */
  accent: number;
  /** Panel body alpha. */
  alpha?: number;
  frameOnly?: boolean;
}

/**
 * Billboard console screen: dark inset panel with an emissive frame.
 * Content (bars, charts, glyphs) is added by the caller as children of the
 * returned container so it can animate independently.
 */
export function screenPanel(opts: ScreenOptions): Container {
  const { x, y, w, h, accent, alpha = 1, frameOnly = false } = opts;
  const c = new Container();
  const frame = new Graphics();
  frame.roundRect(x, y, w, h, 5);
  frame.fill({ color: 0x07111f, alpha: Math.min(alpha + 0.15, 1) });
  frame.roundRect(x, y, w, h, 5);
  frame.stroke({ width: 1.5, color: accent, alpha: 0.85 });
  if (!frameOnly) {
    // Scanline hint: two faint horizontal lines for texture at rest.
    frame.moveTo(x + 3, y + h * 0.62);
    frame.lineTo(x + w - 3, y + h * 0.62);
    frame.stroke({ width: 1, color: accent, alpha: 0.18 });
  }
  c.addChild(frame);
  return c;
}

/** Vertical light beam (trapezoid widening toward the ground), additive. */
export function lightBeam(
  x: number,
  y: number,
  topW: number,
  bottomW: number,
  h: number,
  color: number,
  alpha = 0.22,
): Graphics {
  const g = new Graphics();
  g.poly([x - topW / 2, y - h, x + topW / 2, y - h, x + bottomW / 2, y, x - bottomW / 2, y]);
  g.fill({ color, alpha });
  g.blendMode = "add";
  return g;
}

/** Raised walkway/plinth edge: thin bright strip along a floor diamond edge. */
export function edgeStrip(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color: number,
  alpha = 0.8,
  width = 2,
): Graphics {
  const g = new Graphics();
  g.moveTo(x1, y1);
  g.lineTo(x2, y2);
  g.stroke({ width, color, alpha });
  g.blendMode = "add";
  return g;
}

let glowTex: Texture | null = null;

/** Soft radial gradient texture (shared, cached). */
export function radialGlowTexture(): Texture {
  if (glowTex) return glowTex;
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(0.35, "rgba(255,255,255,0.45)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
  }
  glowTex = Texture.from(canvas);
  return glowTex;
}

/** Additive tinted glow sprite centered at (x, y). */
export function glow(x: number, y: number, size: number, color: number, alpha = 0.5): Sprite {
  const s = new Sprite(radialGlowTexture());
  s.anchor.set(0.5);
  s.position.set(x, y);
  s.width = size;
  s.height = size;
  s.tint = color;
  s.alpha = alpha;
  s.blendMode = "add";
  return s;
}

let dotTex: Texture | null = null;

/** Crisp soft dot texture for packet cores and particles. */
export function dotTexture(): Texture {
  if (dotTex) return dotTex;
  const size = 32;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(0.5, "rgba(255,255,255,0.9)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
  }
  dotTex = Texture.from(canvas);
  return dotTex;
}

/**
 * Small stepped stairs along an iso edge. steps of stepH pixels each.
 * dir: "ne" | "se" | "sw" | "nw" is the direction of ascent on screen.
 */
export function stairs(
  x: number,
  y: number,
  steps: number,
  stepW: number,
  stepH: number,
  rise: number,
  color: number,
): Graphics {
  const g = new Graphics();
  const dirX = stepW;
  for (let i = 0; i < steps; i++) {
    const t = i / steps;
    const yy = y - i * (rise / steps);
    const xx = x + i * dirX;
    const step = isoTile(xx + dirX / 2, yy + stepH / 2 - stepH / 4, stepW * 1.6, stepH, color, 1);
    step.alpha = 1 - t * 0.05;
    g.addChild(step);
  }
  return g;
}
