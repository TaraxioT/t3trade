/**
 * Central Trading Floor: circular floor, holographic market core, six agent
 * workstations, signal tower, event clock, status mast, plus the emergency
 * control kiosk at the safety-perimeter seam. Owner: central district worker.
 *
 * Depth notes: the floor platform geometry (steps, medallion, ring lights)
 * lives in the ground layer, below every sortable fixture. A single sortable
 * plinth root used to sort above the holo core and the north desks and paint
 * them under its opaque top face. Desks are registered as their own sortable
 * roots at their foot Y so population agents standing at the same Y interleave
 * correctly in front of and behind them.
 */
import { Container, Graphics, Sprite } from "pixi.js";
import gsap from "gsap";
import type { DioramaContext } from "../core/context.js";
import { PALETTE, ROLE_COLORS, rightFace, shade, topFace } from "../config/palette.js";
import type { AgentRole } from "../config/palette.js";
import { DISTRICTS, STATIONS } from "../config/stations.js";
import type { StationDef, StationId } from "../config/stations.js";
import { seededRandom } from "../config/world.js";
import {
  dotTexture,
  edgeStrip,
  glow,
  isoBox,
  isoCylinder,
  isoTile,
  lightBeam,
  screenPanel,
  safeDestroy,
} from "../core/iso.js";
import { makeSign } from "../core/signs.js";
import { getStation, registerStation } from "../core/registry.js";

export interface HoloCoreApi {
  /** Mirror a market event on the holo: order launch, fill landing, or state refresh. */
  marketEvent(kind: "order" | "fill" | "state"): void;
  /** Cycle the strategy chip row. */
  rotateStrategies(): void;
  /** Launch an order marker along the holo's orders row. */
  orderLaunched(): void;
  /** Land a fill on the positions strip. */
  fillLanded(): void;
}

export interface SignalTowerApi {
  /** Emit a differentiated pulse: market, alert, wake, warning, execution. */
  pulse(kind: "market" | "alert" | "wake" | "warning" | "execution"): void;
}

/**
 * Emergency control contract (frozen; stories.ts depends on the shape).
 * Registered once, under station id "emergencyPanel".
 */
export interface EmergencyControlApi {
  /** Pause or resume the whole campus: badge at the kiosk, floor ring and
   * status mast hold a dim steady state while paused. */
  setCampusPaused(on: boolean): void;
  /** Flip the protected cover, press the button, hold a 2.4 s pause, resume. */
  demoPause(): void;
}

const FLOOR = { x: 1430, y: 740 };
const RNG = seededRandom(0xc3e7411);

/**
 * Floor-wide desk flash set by buildTradingFloor and read by the holo core's
 * market events, so a market tick is felt at every console in the ring.
 */
let deskPulseHook: ((color: number) => void) | null = null;

/**
 * Campus-pause hooks set by the floor and status mast builders and invoked by
 * the emergency control api, so the paused state is readable across the floor
 * without the panel owning those builders' internals. Reset by their owning
 * builders so a failed rebuild never leaves a stale hook behind.
 */
let floorPauseHook: ((on: boolean) => void) | null = null;
let statusPauseHook: ((on: boolean) => void) | null = null;

/** Floor desks at the population wander points; roles tint the console trim. */
const DESKS: { x: number; y: number; role: AgentRole }[] = [
  { x: 1268, y: 640, role: "research" },
  { x: 1590, y: 640, role: "analysis" },
  { x: 1225, y: 830, role: "strategy" },
  { x: 1635, y: 830, role: "execution" },
  { x: 1370, y: 935, role: "operations" },
  { x: 1490, y: 935, role: "reconciliation" },
];

/** Register a station root in the sortable layer with its transparent hit box. */
function stationRoot(
  ctx: DioramaContext,
  def: StationDef,
  zIndex: number,
  api?: object,
): Container {
  const root = new Container();
  root.zIndex = zIndex;
  ctx.layers.sortable.addChild(root);
  const hit = new Container();
  const box = new Graphics();
  box.rect(def.anchor.x - def.size.w / 2, def.anchor.y - def.size.d / 2, def.size.w, def.size.d);
  box.fill({ color: 0xffffff, alpha: 0.001 });
  hit.addChild(box);
  hit.eventMode = "static";
  hit.cursor = "pointer";
  root.addChild(hit);
  registerStation({ id: def.id, root, hit, api });
  return root;
}

function addSign(
  ctx: DioramaContext,
  def: StationDef,
  x: number,
  y: number,
  accent?: number,
): void {
  ctx.layers.labels.addChild(
    makeSign(def.label, { x, y, size: def.signSize, accent: accent ?? PALETTE.cyan }),
  );
}

export function buildCentralDistrict(ctx: DioramaContext): void {
  buildTradingFloor(ctx);
  buildHoloCore(ctx);
  buildSignalTower(ctx);
  buildEventClock(ctx);
  buildStatusMast(ctx);
  buildEmergencyPanel(ctx);
}

// ---------------------------------------------------------------------------
// Trading floor platform
// ---------------------------------------------------------------------------

function buildTradingFloor(ctx: DioramaContext): void {
  const def = STATIONS.tradingFloor;
  // Hit-only root (registration + transparent footprint); the platform itself
  // is ground geometry (below).
  stationRoot(ctx, def, def.anchor.y - 8);
  // District counter-accent: warm gold inlays subordinate to the cyan ring
  // lights, which stay the floor's infrastructure language.
  const GOLD = DISTRICTS.floor.accent2;
  // Reset first so a failed rebuild never leaves holo events or pause state
  // driving objects from a destroyed world.
  deskPulseHook = null;
  floorPauseHook = null;
  let campusPaused = false;

  // Platform geometry goes to the ground layer, below every sortable fixture.
  // One sortable plinth root (zIndex 732) used to paint the opaque platform
  // face over the holo core root (665), the two north desks (640), and agents
  // wandering the north ring; ground placement exposes all of them while
  // desks and agents keep sorting against each other by foot Y.
  const platform = new Container();
  ctx.layers.ground.addChild(platform);

  // Raised plinth: two low steps under a circular top platform, with a soft
  // ground shadow and strongly shaded side faces so the step faces read.
  const plinth = new Graphics();
  plinth.ellipse(FLOOR.x, FLOOR.y + 18, 374, 212);
  plinth.fill({ color: PALETTE.space, alpha: 0.3 });
  plinth.ellipse(FLOOR.x, FLOOR.y + 14, 366, 208);
  plinth.fill({ color: rightFace(PALETTE.structure) });
  plinth.ellipse(FLOOR.x, FLOOR.y + 14, 366, 208);
  plinth.stroke({ width: 1, color: PALETTE.space, alpha: 0.5 });
  plinth.ellipse(FLOOR.x, FLOOR.y + 7, 356, 202);
  plinth.fill({ color: shade(PALETTE.structure, -0.05) });
  plinth.ellipse(FLOOR.x, FLOOR.y + 7, 356, 202);
  plinth.stroke({ width: 1, color: PALETTE.structureLight, alpha: 0.6 });
  plinth.ellipse(FLOOR.x, FLOOR.y, 348, 198);
  plinth.fill({ color: topFace(PALETTE.structure) });
  // Pale lift on the top face so the platform reads as solid floor mass.
  plinth.ellipse(FLOOR.x, FLOOR.y, 348, 198);
  plinth.fill({ color: PALETTE.surfacePale, alpha: 0.06 });
  plinth.ellipse(FLOOR.x, FLOOR.y, 348, 198);
  plinth.stroke({ width: 2, color: PALETTE.surfacePale, alpha: 0.45 });
  // Inset cyan ring lights just inside the rim.
  plinth.ellipse(FLOOR.x, FLOOR.y, 330, 187);
  plinth.stroke({ width: 2, color: PALETTE.cyan, alpha: 0.5 });
  plinth.ellipse(FLOOR.x, FLOOR.y, 322, 180);
  plinth.stroke({ width: 1, color: PALETTE.cyan, alpha: 0.2 });
  platform.addChild(plinth);

  // Central medallion, kept calm now that the holo is the visible centerpiece:
  // a gold inlay ring outside the cyan infrastructure band and four faint
  // spokes bridging them. The denser ring/spoke stack existed to make the
  // empty (buried) center read; it only competed once the holo appeared.
  const medallion = new Graphics();
  medallion.ellipse(FLOOR.x, FLOOR.y, 240, 136);
  medallion.stroke({ width: 2, color: GOLD, alpha: 0.5 });
  medallion.ellipse(FLOOR.x, FLOOR.y, 190, 108);
  medallion.stroke({ width: 2.5, color: PALETTE.cyan, alpha: 0.45 });
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 8;
    medallion.moveTo(FLOOR.x + Math.cos(a) * 196, FLOOR.y + Math.sin(a) * 111);
    medallion.lineTo(FLOOR.x + Math.cos(a) * 238, FLOOR.y + Math.sin(a) * 134);
    medallion.stroke({
      width: 1.5,
      color: i % 2 ? GOLD : PALETTE.surfacePale,
      alpha: 0.22,
    });
  }
  platform.addChild(medallion);

  // Walkway chevrons: tiny pale arrows on three spokes pointing at the holo.
  const chevrons = new Graphics();
  for (const i of [0, 3, 5]) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    const cx = FLOOR.x + Math.cos(a) * 278;
    const cy = FLOOR.y + Math.sin(a) * 158;
    const inward = Math.atan2(FLOOR.y - cy, FLOOR.x - cx);
    const p = (d: number): { x: number; y: number } => ({
      x: cx + Math.cos(inward) * d,
      y: cy + Math.sin(inward) * d,
    });
    for (const gap of [0, 14]) {
      const tip = p(gap + 8);
      chevrons.moveTo(tip.x + Math.cos(inward - 2.5) * 8, tip.y + Math.sin(inward - 2.5) * 8);
      chevrons.lineTo(tip.x, tip.y);
      chevrons.lineTo(tip.x + Math.cos(inward + 2.5) * 8, tip.y + Math.sin(inward + 2.5) * 8);
      chevrons.stroke({ width: 1.5, color: PALETTE.surfacePale, alpha: 0.4 });
    }
  }
  platform.addChild(chevrons);

  // Low curved console bars between desks so the ring feels furnished. Drawn
  // in a Y-squashed container so circular arcs read as iso ellipse arcs.
  for (const a0 of [0.55, 2.65, 4.75]) {
    const bar = new Container();
    bar.position.set(FLOOR.x, FLOOR.y);
    bar.scale.y = 0.57;
    const g = new Graphics();
    g.arc(0, 0, 300, a0, a0 + 0.5);
    g.stroke({ width: 11, color: rightFace(PALETTE.structure), alpha: 0.95 });
    g.arc(0, 0, 300, a0, a0 + 0.5);
    g.stroke({ width: 9, color: topFace(PALETTE.structure), alpha: 0.9 });
    g.arc(0, 0, 295, a0 + 0.03, a0 + 0.47);
    g.stroke({ width: 2, color: PALETTE.cyan, alpha: 0.7 });
    bar.addChild(g);
    platform.addChild(bar);
  }

  // Chase lights around the outer ring: 12 additive dots, one shared ticker.
  const chase: Sprite[] = [];
  const CHASE_COLORS = [PALETTE.cyan, PALETTE.blue, PALETTE.violet];
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const light = glow(
      FLOOR.x + Math.cos(a) * 286,
      FLOOR.y + Math.sin(a) * 163,
      12,
      CHASE_COLORS[i % 3],
      0.5,
    );
    chase.push(light);
    platform.addChild(light);
  }
  // Resting brightness per light (reduced motion uses a static arrangement;
  // the pause cue restores these values when the campus resumes).
  const chaseBase = chase.map((_, i) => 0.25 + 0.35 * (((i * 5) % 12) / 12));
  if (ctx.reducedMotion) {
    chase.forEach((c, i) => {
      c.alpha = chaseBase[i];
    });
  }

  // Slowly pulsing concentric emissive floor lines (8 s), alpha only. Two
  // rings carry the floor's layered-state read; the third (inner, blue) sat
  // directly under the holo's floating content and competed with it.
  const pulseRings: { ring: Graphics; base: number }[] = [];
  const RING_MATERIALS: { r: number; color: number; width: number }[] = [
    { r: 300, color: PALETTE.cyan, width: 1.75 },
    { r: 230, color: GOLD, width: 1.25 },
  ];
  for (const m of RING_MATERIALS) {
    const ring = new Graphics();
    ring.ellipse(FLOOR.x, FLOOR.y, m.r, m.r * 0.57);
    ring.stroke({ width: m.width, color: m.color, alpha: 0.3 });
    ring.blendMode = "add";
    ring.alpha = 0.3;
    pulseRings.push({ ring, base: 0.22 + pulseRings.length * 0.02 });
    platform.addChild(ring);
  }

  // Per-desk feedback flashes driven by holo market events.
  const deskFlashes: Sprite[] = [];
  for (const desk of DESKS) buildDesk(ctx, desk, deskFlashes);
  const pulseDesks = (color: number): void => {
    if (ctx.reducedMotion || deskFlashes.length === 0) return;
    for (const flash of deskFlashes) {
      flash.tint = color;
      gsap.killTweensOf(flash);
      gsap.fromTo(flash, { alpha: 0.5 }, { alpha: 0, duration: 0.7, ease: "power2.out" });
    }
  };
  ctx.onCleanup(() => deskFlashes.forEach((f) => gsap.killTweensOf(f)));
  deskPulseHook = pulseDesks;

  // Campus pause, seen from the floor: the ring stops sweeping and holds a
  // dim steady state so the freeze reads at fit zoom. Resume needs no state
  // repair; the ticker simply returns to its sine values.
  const dimFloor = (on: boolean): void => {
    for (const [i, light] of chase.entries()) light.alpha = on ? 0.12 : chaseBase[i];
    for (const { ring, base } of pulseRings) ring.alpha = on ? 0.08 : base;
  };
  floorPauseHook = (on: boolean): void => {
    campusPaused = on;
    if (ctx.reducedMotion) dimFloor(on);
  };

  if (!ctx.reducedMotion) {
    ctx.onTick(() => {
      if (campusPaused) {
        dimFloor(true);
        return;
      }
      const time = performance.now() / 1000;
      const phase = (time * Math.PI * 2) / 8;
      for (const [i, { ring, base }] of pulseRings.entries()) {
        ring.alpha = base + 0.18 * (0.5 + 0.5 * Math.sin(phase - i * 0.9));
      }
      const chasePhase = (time * Math.PI * 2) / 4;
      for (const [i, light] of chase.entries()) {
        light.alpha = 0.18 + 0.55 * Math.max(0, Math.sin(chasePhase - (i / 12) * Math.PI * 2));
      }
    });
  }

  // The district banner "CENTRAL TRADING FLOOR" above the arena carries the
  // name; the open ground south of the platform stays circulation space.
}

/** One open workstation: wide console with role trim, a chair with a tall
 * backrest, a floating role holo pane, and a soft AO ellipse at its root.
 * Pushes a flash glow so market events are felt at the console. */
function buildDesk(
  ctx: DioramaContext,
  desk: { x: number; y: number; role: AgentRole },
  deskFlashes: Sprite[],
): void {
  const accent = ROLE_COLORS[desk.role];
  const root = new Container();
  root.zIndex = desk.y;
  ctx.layers.sortable.addChild(root);

  // Soft contact shadow under the workstation.
  const ao = new Graphics();
  ao.ellipse(desk.x, desk.y + 5, 42, 16);
  ao.fill({ color: PALETTE.space, alpha: 0.3 });
  root.addChild(ao);

  // Direction toward the floor center; the chair sits on the center side and
  // the console screen leans the same way, so every desk faces the core.
  const dx = FLOOR.x - desk.x;
  const dy = FLOOR.y - desk.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = dx / len;
  const ny = dy / len;
  const sx = desk.x + nx * 30;
  const sy = desk.y + ny * 17;

  root.addChild(isoBox({ x: desk.x, y: desk.y, w: 60, d: 34, h: 18, color: PALETTE.structure }));
  // Role trim across the desk's front (south) edges.
  root.addChild(edgeStrip(desk.x - 30, desk.y + 8.5, desk.x, desk.y + 17, accent, 0.85, 2));
  root.addChild(edgeStrip(desk.x, desk.y + 17, desk.x + 30, desk.y + 8.5, accent, 0.85, 2));

  // Chair: seat cylinder plus a tall backrest on the center side.
  root.addChild(
    isoCylinder({ x: sx, y: sy, r: 6, h: 9, color: PALETTE.structureLight, rim: accent }),
  );
  const backrest = new Graphics();
  const bx = sx + nx * 6;
  const by = sy + ny * 3.4 - 24;
  backrest.roundRect(bx - 8, by, 16, 22, 4);
  backrest.fill({ color: PALETTE.structure, alpha: 0.95 });
  backrest.roundRect(bx - 8, by, 16, 22, 4);
  backrest.stroke({ width: 1.2, color: PALETTE.structureLight, alpha: 0.9 });
  backrest.moveTo(bx - 5, by + 5);
  backrest.lineTo(bx + 5, by + 5);
  backrest.stroke({ width: 1, color: accent, alpha: 0.6 });
  root.addChild(backrest);

  // Console screen with two data lines in the role tint: sized and weighted
  // to stay readable at fit zoom.
  const trimGlow = glow(desk.x, desk.y - 34, 52, accent, 0.16);
  root.addChild(trimGlow);
  const screen = screenPanel({
    x: desk.x - 21,
    y: desk.y - 48,
    w: 42,
    h: 22,
    accent,
  });
  const content = new Graphics();
  content.moveTo(desk.x - 16, desk.y - 38);
  content.lineTo(desk.x - 4, desk.y - 44);
  content.lineTo(desk.x + 5, desk.y - 37);
  content.lineTo(desk.x + 16, desk.y - 42);
  content.stroke({ width: 2, color: accent, alpha: 0.95 });
  content.moveTo(desk.x - 16, desk.y - 32);
  content.lineTo(desk.x + 16, desk.y - 32);
  content.stroke({ width: 1.4, color: accent, alpha: 0.5 });
  screen.addChild(content);
  root.addChild(screen);
  // Dedicated market-event flash above the console: stays dormant so the idle
  // shimmer and trim breathing never fight it.
  const flash = glow(desk.x, desk.y - 38, 46, accent, 0);
  root.addChild(flash);
  deskFlashes.push(flash);

  // Floating role holo pane above the console: two abstract glyphs.
  const pane = new Container();
  pane.position.set(desk.x, desk.y - 64);
  const paneG = new Graphics();
  paneG.roundRect(-9, -7, 18, 13, 3);
  paneG.stroke({ width: 1.2, color: accent, alpha: 0.85 });
  paneG.circle(-3, -1, 2.4);
  paneG.stroke({ width: 1, color: accent, alpha: 0.9 });
  paneG.moveTo(2, -4);
  paneG.lineTo(7, -4);
  paneG.moveTo(2, 0);
  paneG.lineTo(6, 0);
  paneG.stroke({ width: 1, color: accent, alpha: 0.9 });
  paneG.blendMode = "add";
  pane.addChild(paneG);
  root.addChild(pane);
  if (!ctx.reducedMotion) {
    gsap.to(pane, {
      y: desk.y - 68,
      duration: 3,
      yoyo: true,
      repeat: -1,
      ease: "sine.inOut",
      delay: (desk.x % 7) * 0.4,
    });
    // Idle telemetry: each desk shimmers and its role trim breathes on its own
    // clock so the six jobs read as separate live consoles, not one texture.
    gsap.to(content, {
      alpha: 0.55,
      duration: 2.2 + (desk.x % 5) * 0.35,
      yoyo: true,
      repeat: -1,
      ease: "sine.inOut",
      delay: (desk.y % 7) * 0.35,
    });
    gsap.to(trimGlow, {
      alpha: 0.32,
      duration: 3 + (desk.x % 4) * 0.6,
      yoyo: true,
      repeat: -1,
      ease: "sine.inOut",
      delay: (desk.y % 5) * 0.5,
    });
    ctx.onCleanup(() => gsap.killTweensOf([pane, content, trimGlow]));
  }
}

// ---------------------------------------------------------------------------
// Holographic market core
// ---------------------------------------------------------------------------

function buildHoloCore(ctx: DioramaContext): void {
  const def = STATIONS.holoCore;
  const { x, y } = def.anchor;
  const root = stationRoot(ctx, def, y);

  // Soft AO + pedestal + breathing additive cone carrying the hologram. The
  // pedestal is two-tier (emitter disc under a short column) so the floor's
  // primary fixture grounds deliberately now that the platform no longer
  // buries it.
  const ao = new Graphics();
  ao.ellipse(x, y + 8, 34, 14);
  ao.fill({ color: PALETTE.space, alpha: 0.3 });
  root.addChild(ao);
  root.addChild(
    isoCylinder({ x, y: y + 7, r: 24, h: 8, color: PALETTE.structure, rim: PALETTE.cyan }),
  );
  root.addChild(
    isoCylinder({ x, y: y + 6, r: 14, h: 18, color: PALETTE.structureLight, rim: PALETTE.cyan }),
  );
  root.addChild(glow(x, y - 10, 56, PALETTE.cyan, 0.45));
  const cone = lightBeam(x, y - 12, 120, 34, 118, PALETTE.cyan, 0.4);
  root.addChild(cone);

  // Floating content stack: abstract glyphs, billboard, gently bobbing (6 s).
  const stack = new Container();
  stack.scale.set(1.5);
  stack.position.set(x, y - 88);
  root.addChild(stack);

  // Price ribbon: tiny candles; one new candle every ~4 s, then scroll.
  interface Candle {
    o: number;
    c: number;
    h: number;
    l: number;
  }
  const candleW = 8;
  const candleCount = 14;
  const candles: Candle[] = [];
  let price = 0.5;
  const nextCandle = (): Candle => {
    const o = price;
    price = Math.max(0.15, Math.min(0.85, price + (RNG() - 0.5) * 0.3));
    const c = price;
    return { o, c, h: Math.max(o, c) + RNG() * 0.12, l: Math.min(o, c) - RNG() * 0.12 };
  };
  for (let i = 0; i < candleCount; i++) candles.push(nextCandle());

  const ribbon = new Graphics();
  const ribbonH = 20;
  const ribbonTop = -34;
  const drawRibbon = (): void => {
    ribbon.clear();
    ribbon.roundRect(-62, ribbonTop, 124, ribbonH + 8, 4);
    ribbon.fill({ color: PALETTE.space, alpha: 0.55 });
    ribbon.roundRect(-62, ribbonTop, 124, ribbonH + 8, 4);
    ribbon.stroke({ width: 1, color: PALETTE.cyan, alpha: 0.4 });
    const yOf = (v: number): number => ribbonTop + 4 + ribbonH - v * ribbonH;
    candles.forEach((k, idx) => {
      const cx = -58 + idx * candleW + candleW / 2;
      const up = k.c >= k.o;
      const col = up ? PALETTE.healthy : PALETTE.blocked;
      ribbon.moveTo(cx, yOf(Math.min(1, k.h)));
      ribbon.lineTo(cx, yOf(Math.max(0, k.l)));
      ribbon.stroke({ width: 1.5, color: col, alpha: 0.95 });
      const top = yOf(Math.max(k.o, k.c));
      const bot = yOf(Math.min(k.o, k.c));
      ribbon.rect(cx - 2.5, top, 5, Math.max(2, bot - top));
      ribbon.fill({ color: col, alpha: 1 });
    });
  };
  drawRibbon();
  stack.addChild(ribbon);
  const lastGlow = glow(0, 0, 10, PALETTE.cyan, 0.7);
  stack.addChild(lastGlow);

  // Strategy chips + health dots, one row. The chip tint cycles through
  // variants when strategies rotate; the dots stay semantic green.
  const CHIP_TINTS = [PALETTE.violet, PALETTE.blue, PALETTE.magenta];
  let chipVariant = 0;
  const chips = new Container();
  const chipsG = new Graphics();
  chips.addChild(chipsG);
  const drawChips = (): void => {
    const tint = CHIP_TINTS[chipVariant % CHIP_TINTS.length];
    chipsG.clear();
    for (const cx of [-40, -6]) {
      chipsG.roundRect(cx, -1, 30, 9, 3);
      chipsG.fill({ color: tint, alpha: 0.35 });
      chipsG.roundRect(cx, -1, 30, 9, 3);
      chipsG.stroke({ width: 1, color: tint, alpha: 0.85 });
      chipsG.moveTo(cx + 4, 3.5);
      chipsG.lineTo(cx + 18, 3.5);
      chipsG.stroke({ width: 1, color: tint, alpha: 0.6 });
    }
    for (let i = 0; i < 4; i++) {
      chipsG.circle(26 + i * 9, 3.5, 2.2);
      chipsG.fill({ color: PALETTE.healthy, alpha: 0.9 });
    }
  };
  drawChips();
  stack.addChild(chips);

  // Positions strip: 3 tokens each with a green shield pip.
  const positions = new Graphics();
  for (let i = 0; i < 3; i++) {
    const px = -34 + i * 26;
    positions.roundRect(px, 14, 18, 12, 3);
    positions.fill({ color: PALETTE.surfacePale, alpha: 0.18 });
    positions.roundRect(px, 14, 18, 12, 3);
    positions.stroke({ width: 1, color: PALETTE.surfacePale, alpha: 0.5 });
    // Shield pip: small protective chevron above the token.
    positions.moveTo(px + 9, 8);
    positions.lineTo(px + 13, 12);
    positions.lineTo(px + 9, 11);
    positions.lineTo(px + 5, 12);
    positions.closePath();
    positions.fill({ color: PALETTE.healthy, alpha: 0.95 });
    positions.moveTo(px + 4, 20);
    positions.lineTo(px + 14, 20);
    positions.stroke({ width: 1, color: PALETTE.cyan, alpha: 0.6 });
  }
  stack.addChild(positions);
  // Fill feedback: one dormant flash per token plus a shield pulse overlay.
  const tokenFlashes: Sprite[] = [];
  for (let i = 0; i < 3; i++) {
    const flash = glow(-34 + i * 26 + 9, 20, 16, PALETTE.healthy, 0);
    tokenFlashes.push(flash);
    stack.addChild(flash);
  }
  const shieldPulse = glow(0, 18, 40, PALETTE.healthy, 0);
  stack.addChild(shieldPulse);

  // Orders row: 2 orange capsules, plus the P&L arc (gold) to the right.
  const orders = new Graphics();
  for (const ox of [-46, -24]) {
    orders.roundRect(ox, 32, 17, 7, 3.5);
    orders.fill({ color: PALETTE.orange, alpha: 0.5 });
    orders.roundRect(ox, 32, 17, 7, 3.5);
    orders.stroke({ width: 1, color: PALETTE.orange, alpha: 0.9 });
  }
  // P&L arc: gold sweep from 120 to 60 degrees with an end dot.
  orders.arc(28, 37, 13, Math.PI * 0.75, Math.PI * 1.9);
  orders.stroke({ width: 2, color: PALETTE.yellow, alpha: 0.9 });
  orders.circle(28 + Math.cos(Math.PI * 1.9) * 13, 37 + Math.sin(Math.PI * 1.9) * 13, 2.4);
  orders.fill({ color: PALETTE.yellow });
  stack.addChild(orders);
  // Order feedback: warm launch flash at the row's start and a marker that
  // travels to the live order slot.
  const GOLD = DISTRICTS.floor.accent2;
  const orderFlash = glow(-58, 35.5, 22, GOLD, 0);
  stack.addChild(orderFlash);
  const marker = glow(-58, 35.5, 14, GOLD, 0);
  marker.visible = false;
  stack.addChild(marker);

  // Two orbiting mini-panes: translucent additive-edge screens circling the
  // holo at different radii (14 s and 22 s).
  const orbiters: { c: Container; r: number; ry: number; period: number }[] = [];
  for (const [r, period, color] of [
    [58, 14, PALETTE.cyan],
    [86, 22, PALETTE.blue],
  ] as const) {
    const c = new Container();
    const g = new Graphics();
    g.roundRect(-14, -9, 28, 17, 3);
    g.stroke({ width: 1.2, color, alpha: 0.8 });
    g.moveTo(-9, 1);
    g.lineTo(0, -4);
    g.lineTo(6, 2);
    g.stroke({ width: 1, color, alpha: 0.7 });
    g.blendMode = "add";
    c.addChild(g);
    root.addChild(c);
    orbiters.push({ c, r, ry: r * 0.45, period });
  }

  if (!ctx.reducedMotion) {
    let candleClock = 0;
    let last = performance.now();
    const lastX = -58 + (candleCount - 1) * candleW + candleW / 2;
    ctx.onTick(() => {
      const now = performance.now();
      const dt = (now - last) / 1000;
      last = now;
      const t = now / 1000;
      stack.y = y - 88 + Math.sin(t * Math.PI * 2 * (1 / 6)) * 4;
      cone.alpha = 0.35 + 0.15 * (0.5 + 0.5 * Math.sin((t * Math.PI * 2) / 4));
      for (const [i, o] of orbiters.entries()) {
        const a = (t * Math.PI * 2) / o.period + i * 2.1;
        o.c.position.set(x + Math.cos(a) * o.r, y - 78 + Math.sin(a) * o.ry);
        o.c.scale.y = Math.sin(a) < 0 ? 0.75 : 1;
      }
      candleClock += dt;
      if (candleClock >= 4) {
        candleClock = 0;
        candles.shift();
        candles.push(nextCandle());
        drawRibbon();
      }
      const lastCandle = candles[candleCount - 1];
      lastGlow.position.set(
        lastX,
        ribbonTop + 4 + ribbonH - ((lastCandle.o + lastCandle.c) / 2) * ribbonH,
      );
    });
  } else {
    lastGlow.visible = false;
    cone.alpha = 0.4;
    orbiters.forEach((o, i) => {
      const a = 1.2 + i * 2.4;
      o.c.position.set(x + Math.cos(a) * o.r, y - 78 + Math.sin(a) * o.ry);
    });
  }

  // --- Story API: market events mirrored on the holo and felt at the desks ---
  const launchOrder = (): void => {
    if (ctx.reducedMotion) {
      marker.visible = true;
      marker.alpha = 0.9;
      marker.position.set(-22, 35.5);
      return;
    }
    gsap.killTweensOf(marker);
    marker.visible = true;
    gsap.fromTo(
      marker,
      { x: -58, y: 35.5, alpha: 0.95 },
      {
        x: -22,
        duration: 0.55,
        ease: "power2.out",
        onComplete: () => {
          gsap.to(marker, { alpha: 0, duration: 1.6, delay: 0.8 });
        },
      },
    );
    gsap.killTweensOf(orderFlash);
    gsap.fromTo(orderFlash, { alpha: 0.8 }, { alpha: 0, duration: 0.5 });
    deskPulseHook?.(GOLD);
  };

  let fillToken = 0;
  const landFill = (): void => {
    const flash = tokenFlashes[fillToken++ % tokenFlashes.length];
    if (ctx.reducedMotion) {
      flash.alpha = 0.8;
      shieldPulse.alpha = 0.4;
      return;
    }
    gsap.killTweensOf(flash);
    gsap.fromTo(flash, { alpha: 0.9 }, { alpha: 0, duration: 0.9, ease: "power2.out" });
    gsap.killTweensOf([shieldPulse, shieldPulse.scale]);
    shieldPulse.scale.set(0.7);
    gsap.to(shieldPulse.scale, { x: 1.5, y: 1.5, duration: 0.7, ease: "power2.out" });
    gsap.fromTo(shieldPulse, { alpha: 0.7 }, { alpha: 0, duration: 0.7 });
  };

  const refreshState = (): void => {
    candles.shift();
    candles.push(nextCandle());
    drawRibbon();
    if (ctx.reducedMotion) return;
    gsap.killTweensOf(ribbon);
    gsap.fromTo(ribbon, { alpha: 0.4 }, { alpha: 1, duration: 0.5, ease: "power2.out" });
  };

  const rotateChips = (): void => {
    if (ctx.reducedMotion) {
      chipVariant++;
      drawChips();
      return;
    }
    gsap.killTweensOf(chips);
    gsap.to(chips, {
      alpha: 0,
      y: 10,
      duration: 0.28,
      ease: "power2.in",
      onComplete: () => {
        chipVariant++;
        drawChips();
        gsap.to(chips, { alpha: 1, y: 0, duration: 0.35, ease: "back.out(2)" });
      },
    });
  };

  const api: HoloCoreApi = {
    marketEvent(kind) {
      if (kind === "order") launchOrder();
      else if (kind === "fill") landFill();
      else refreshState();
    },
    rotateStrategies() {
      rotateChips();
    },
    orderLaunched() {
      launchOrder();
    },
    fillLanded() {
      landFill();
    },
  };
  registerApi(ctx, def.id, api);

  // Mild self-animation so the floor lives between stories: an order launches
  // and the strategy row cycles on staggered, non-synchronized clocks.
  if (!ctx.reducedMotion) {
    type DelayedCall = ReturnType<typeof gsap.delayedCall>;
    let orderTimer: DelayedCall | null = null;
    let chipTimer: DelayedCall | null = null;
    const scheduleOrder = (): void => {
      orderTimer = gsap.delayedCall(12 + RNG() * 6, () => {
        launchOrder();
        scheduleOrder();
      });
    };
    const scheduleChips = (): void => {
      chipTimer = gsap.delayedCall(14 + RNG() * 5, () => {
        rotateChips();
        scheduleChips();
      });
    };
    scheduleOrder();
    scheduleChips();
    ctx.onCleanup(() => {
      orderTimer?.kill();
      chipTimer?.kill();
      gsap.killTweensOf([marker, orderFlash, ...tokenFlashes, shieldPulse, ribbon, chips]);
    });
  }

  addSign(ctx, def, x, y - 172);
}

// ---------------------------------------------------------------------------
// Signal tower
// ---------------------------------------------------------------------------

function buildSignalTower(ctx: DioramaContext): void {
  const def = STATIONS.signalTower;
  const { x, y } = def.anchor;
  const root = stationRoot(ctx, def, y);

  // Soft AO at the tower root.
  const towerAo = new Graphics();
  towerAo.ellipse(x, y + 7, 22, 9);
  towerAo.fill({ color: PALETTE.space, alpha: 0.3 });
  root.addChild(towerAo);
  root.addChild(
    isoBox({ x, y: y + 3, w: 30, d: 16, h: 8, color: PALETTE.structure, rim: PALETTE.surfacePale }),
  );

  // Segmented mast with 5 stacked pulse emitters (tall, bright).
  const emitters: Sprite[] = [];
  const mast = new Graphics();
  for (let i = 0; i < 5; i++) {
    const segY = y - 8 - i * 33;
    mast.roundRect(x - 4, segY - 24, 8, 22, 2);
    mast.fill({ color: i % 2 ? PALETTE.structureLight : PALETTE.structure });
    const e = glow(x, segY - 26, 17, PALETTE.cyan, 0.68);
    emitters.push(e);
    root.addChild(e);
  }
  mast.roundRect(x - 7, y - 168, 14, 10, 2);
  mast.fill({ color: topFace(PALETTE.structureLight) });
  root.addChildAt(mast, 0);
  const beacon = glow(x, y - 178, 26, PALETTE.cyan, 0.7);
  root.addChild(beacon);

  // Pooled expanding ring waves (ellipse strokes scaled and faded via GSAP).
  const ringPool: Container[] = [];
  for (let i = 0; i < 8; i++) {
    const c = new Container();
    c.position.set(x, y + 4);
    c.visible = false;
    const g = new Graphics();
    g.ellipse(0, 0, 12, 6);
    g.stroke({ width: 2, color: PALETTE.cyan, alpha: 0.9 });
    c.addChild(g);
    ringPool.push(c);
    root.addChild(c);
  }
  let ringCursor = 0;
  const emitRing = (color: number, scaleTo: number, dur: number, delay = 0): void => {
    const c = ringPool[ringCursor++ % ringPool.length];
    const g = c.children[0] as Graphics;
    // Retint by redrawing the single pooled stroke (cheap, rare).
    g.clear();
    g.ellipse(0, 0, 12, 6);
    g.stroke({ width: 2, color, alpha: 0.9 });
    gsap.killTweensOf(c);
    c.visible = true;
    c.scale.set(1);
    gsap.fromTo(
      c,
      { alpha: 0.9 },
      {
        alpha: 0,
        duration: dur,
        delay,
        ease: "power1.out",
        overwrite: true,
        onUpdate: () => {
          const p = 1 - c.alpha / 0.9;
          c.scale.set(1 + (scaleTo - 1) * p);
        },
        onComplete: () => {
          c.visible = false;
        },
      },
    );
  };
  const flashMast = (color: number, blinks: number): void => {
    for (const e of emitters) {
      e.tint = color;
      gsap.killTweensOf(e);
      gsap.fromTo(
        e,
        { alpha: 0.2 },
        {
          alpha: 0.95,
          duration: 0.16,
          repeat: Math.max(0, blinks - 1),
          yoyo: true,
          repeatDelay: 0.12,
          onComplete: () => {
            e.alpha = 0.5;
          },
        },
      );
    }
    beacon.tint = color;
    gsap.killTweensOf(beacon);
    gsap.fromTo(
      beacon,
      { alpha: 0.5 },
      {
        alpha: 1,
        duration: 0.3,
        yoyo: true,
        repeat: 1,
        onComplete: () => {
          beacon.alpha = 0.6;
        },
      },
    );
  };
  const riseSpark = (color: number): void => {
    const spark = new Sprite(dotTexture());
    spark.anchor.set(0.5);
    spark.width = 10;
    spark.height = 10;
    spark.tint = color;
    spark.blendMode = "add";
    spark.position.set(x, y - 6);
    root.addChild(spark);
    gsap.to(spark, {
      y: y - 182,
      alpha: 0,
      duration: 1.1,
      ease: "power2.in",
      onComplete: () => safeDestroy(spark),
    });
  };

  const api: SignalTowerApi = {
    pulse(kind) {
      if (ctx.reducedMotion) {
        // One static mast tint so the event still reads without motion.
        for (const e of emitters) e.tint = kind === "execution" ? PALETTE.orange : PALETTE.cyan;
        return;
      }
      if (kind === "market") {
        emitRing(PALETTE.cyan, 8, 1.1);
        emitRing(PALETTE.cyan, 8, 1.1, 0.25);
        flashMast(PALETTE.cyan, 1);
      } else if (kind === "alert") {
        flashMast(PALETTE.warning, 3);
        emitRing(PALETTE.warning, 7, 1.2);
      } else if (kind === "wake") {
        riseSpark(PALETTE.blue);
        flashMast(PALETTE.blue, 1);
        emitRing(PALETTE.blue, 5, 0.9);
      } else if (kind === "warning") {
        flashMast(PALETTE.blocked, 2);
        emitRing(PALETTE.warning, 9, 1.3);
        emitRing(PALETTE.blocked, 9, 1.3, 0.3);
      } else {
        emitRing(PALETTE.orange, 12, 1.0);
        flashMast(PALETTE.orange, 1);
      }
    },
  };

  if (!ctx.reducedMotion) {
    let idle = 0;
    let last = performance.now();
    ctx.onTick(() => {
      const now = performance.now();
      idle += (now - last) / 1000;
      last = now;
      if (idle >= 10) {
        idle = 0;
        api.pulse("market");
      }
    });
  }

  ctx.onCleanup(() => {
    gsap.killTweensOf([...ringPool, ...emitters, beacon]);
  });

  // The registry api lives on the handle; expose via closure variable.
  registerApi(ctx, def.id, api);
  addSign(ctx, def, x, y + 42);
}

// ---------------------------------------------------------------------------
// Event clock
// ---------------------------------------------------------------------------

function buildEventClock(ctx: DioramaContext): void {
  const def = STATIONS.eventClock;
  const { x, y } = def.anchor;
  const root = stationRoot(ctx, def, y);

  // Substantial mount: AO, wide base pillar with an aqua accent rim ring.
  const clockAo = new Graphics();
  clockAo.ellipse(x, y + 6, 18, 8);
  clockAo.fill({ color: PALETTE.space, alpha: 0.3 });
  root.addChild(clockAo);
  root.addChild(
    isoBox({ x, y: y + 2, w: 26, d: 14, h: 6, color: PALETTE.structureLight, rim: PALETTE.aqua }),
  );
  root.addChild(
    isoBox({ x, y: y - 2, w: 16, d: 9, h: 44, color: PALETTE.structure, rim: PALETTE.surfacePale }),
  );
  const face = new Container();
  face.position.set(x, y - 84);
  root.addChild(face);

  // Dial plate and static tick marks.
  const plate = new Graphics();
  plate.circle(0, 0, 42);
  plate.fill({ color: PALETTE.space, alpha: 0.6 });
  plate.circle(0, 0, 42);
  plate.stroke({ width: 1.5, color: PALETTE.structureLight, alpha: 0.9 });
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    plate.moveTo(Math.cos(a) * 37, Math.sin(a) * 37);
    plate.lineTo(Math.cos(a) * 41, Math.sin(a) * 41);
    plate.stroke({ width: i % 3 === 0 ? 2 : 1, color: PALETTE.inkDim, alpha: 0.7 });
  }
  face.addChild(plate);

  // Three rotating arc rings: activity 8 s (inner), lifecycle 24 s, wakes 60 s.
  const rings: { c: Container; period: number; dir: 1 | -1 }[] = [];
  const addRing = (r: number, arcs: number, color: number, period: number, dir: 1 | -1): void => {
    const c = new Container();
    const g = new Graphics();
    for (let i = 0; i < arcs; i++) {
      const start = (i / arcs) * Math.PI * 2 + 0.2;
      g.arc(0, 0, r, start, start + (Math.PI * 2) / arcs - 0.4);
      g.stroke({ width: 2, color, alpha: 0.85 });
    }
    c.addChild(g);
    face.addChild(c);
    rings.push({ c, period, dir });
  };
  addRing(16, 3, PALETTE.cyan, 8, 1);
  addRing(26, 4, PALETTE.blue, 24, -1);
  addRing(35, 2, PALETTE.aqua, 60, 1);

  // Sweeping second glint: thin needle crossing all rings. Container, not
  // Graphics: Pixi v8 marks Graphics allowChildren false and warns on addChild.
  const glint = new Container();
  const needle = new Graphics();
  needle.moveTo(0, 0);
  needle.lineTo(0, -38);
  needle.stroke({ width: 1.5, color: PALETTE.surfacePale, alpha: 0.85 });
  glint.addChild(needle);
  glint.addChild(glow(0, -38, 10, PALETTE.surfacePale, 0.7));
  face.addChild(glint);

  if (!ctx.reducedMotion) {
    ctx.onTick(() => {
      const time = performance.now() / 1000;
      glint.rotation = (time / 60) * Math.PI * 2;
      for (const r of rings) r.c.rotation = r.dir * ((time / r.period) * Math.PI * 2);
    });
  } else {
    glint.rotation = 0.7;
    rings[0].c.rotation = 0.4;
    rings[1].c.rotation = -1.1;
    rings[2].c.rotation = 2.2;
  }

  // Offset right and low: the observability booth sits just west-southwest
  // and its screens must stay uncovered.
  addSign(ctx, def, x + 48, y + 52, PALETTE.aqua);
}

// ---------------------------------------------------------------------------
// Status mast
// ---------------------------------------------------------------------------

function buildStatusMast(ctx: DioramaContext): void {
  const def = STATIONS.statusMast;
  const { x, y } = def.anchor;
  const root = stationRoot(ctx, def, y);
  statusPauseHook = null;

  root.addChild(
    isoBox({
      x,
      y: y + 2,
      w: 12,
      d: 7,
      h: 46,
      color: PALETTE.structureLight,
      rim: PALETTE.surfacePale,
    }),
  );
  const bar = new Graphics();
  bar.roundRect(x - 32, y - 50, 64, 6, 3);
  bar.fill({ color: PALETTE.structureLight });
  bar.roundRect(x - 32, y - 50, 64, 6, 3);
  bar.stroke({ width: 1, color: PALETTE.surfacePale, alpha: 0.6 });
  root.addChild(bar);

  // Color + shape pairs so state never relies on hue alone.
  const lights: { color: number; shape: "circle" | "triangle" | "square" | "diamond" }[] = [
    { color: PALETTE.healthy, shape: "circle" },
    { color: PALETTE.waiting, shape: "triangle" },
    { color: PALETTE.warning, shape: "square" },
    { color: PALETTE.blocked, shape: "diamond" },
  ];
  const lamps: Sprite[] = [];
  lights.forEach((l, i) => {
    const lx = x - 24 + i * 16;
    const lamp = glow(lx, y - 56, 12, l.color, 0.55);
    lamps.push(lamp);
    root.addChild(lamp);
    const dot = new Graphics();
    dot.circle(lx, y - 56, 3);
    dot.fill({ color: l.color });
    root.addChild(dot);
    const shield = new Graphics();
    shield.setStrokeStyle({ width: 1.2, color: l.color, alpha: 0.9 });
    if (l.shape === "circle") shield.circle(lx, y - 44, 4);
    if (l.shape === "square") shield.rect(lx - 3.5, y - 47.5, 7, 7);
    if (l.shape === "triangle") shield.poly([lx, y - 49, lx + 4, y - 41, lx - 4, y - 41]);
    if (l.shape === "diamond")
      shield.poly([lx, y - 49, lx + 4, y - 44, lx, y - 39, lx - 4, y - 44]);
    shield.stroke();
    root.addChild(shield);
  });

  // Campus-pause cue: the mast is the campus lighting master, so its warning
  // square (amber, degraded) holds bright and grows while the emergency
  // control has everything paused. Alpha/scale only; snaps in reduced motion.
  const warnLamp = lamps[2];
  statusPauseHook = (on: boolean): void => {
    if (!warnLamp) return;
    warnLamp.alpha = on ? 1 : 0.55;
    warnLamp.scale.set(on ? 1.35 : 1);
  };

  // Sign offset east of the mast: at the anchor the sign tangents the
  // observability console's north-east corner (console spans x to 1245).
  addSign(ctx, def, x + 34, y + 40, PALETTE.healthy);
}

// ---------------------------------------------------------------------------
// Emergency control kiosk (safety-perimeter seam)
// ---------------------------------------------------------------------------

/**
 * Free-standing red-trimmed control kiosk on the safety-perimeter seam: just
 * inside the west wall, south of the approval gate. A human control, not an
 * agent station: one protected button, no consoles. Owns the campus-pause
 * visuals (badge here, floor ring and status mast through their hooks).
 */
function buildEmergencyPanel(ctx: DioramaContext): void {
  const def = STATIONS.emergencyPanel;
  const { x, y } = def.anchor;
  const root = stationRoot(ctx, def, y);

  // Grounding: contact shadow, a small red-rimmed pad, and a low pedestal.
  const ao = new Graphics();
  ao.ellipse(x, y + 6, 27, 12);
  ao.fill({ color: PALETTE.space, alpha: 0.32 });
  root.addChild(ao);
  root.addChild(
    isoTile(x, y + 2, 58, 32, topFace(PALETTE.structure), 1, shade(PALETTE.emergency, -0.45)),
  );
  root.addChild(isoBox({ x, y: y + 6, w: 34, d: 20, h: 10, color: PALETTE.structure }));

  // Red-trimmed panel box on the pedestal.
  const box = new Graphics();
  box.roundRect(x - 18, y - 58, 36, 54, 5);
  box.fill({ color: PALETTE.structure });
  box.roundRect(x - 18, y - 58, 36, 54, 5);
  box.stroke({ width: 2, color: PALETTE.emergency, alpha: 0.95 });
  box.roundRect(x - 14, y - 40, 28, 26, 3);
  box.fill({ color: PALETTE.space, alpha: 0.8 });
  root.addChild(box);

  const statusDot = new Graphics();
  statusDot.circle(x, y - 50, 2.5);
  statusDot.fill({ color: PALETTE.emergency });
  root.addChild(statusDot);
  const statusLight = glow(x, y - 50, 12, PALETTE.emergency, 0.8);
  root.addChild(statusLight);

  // Big protected button under a glass cover hinged on its left edge.
  const button = new Container();
  button.position.set(x, y - 27);
  const btn = new Graphics();
  btn.circle(0, 0, 8);
  btn.fill({ color: PALETTE.emergency });
  btn.circle(0, 0, 8);
  btn.stroke({ width: 2, color: PALETTE.surfacePale, alpha: 0.9 });
  btn.circle(0, 0, 3);
  btn.fill({ color: PALETTE.surfacePale, alpha: 0.85 });
  button.addChild(btn);
  root.addChild(button);
  root.addChild(glow(x, y - 27, 22, PALETTE.emergency, 0.22));

  const cover = new Container();
  cover.position.set(x - 14, y - 40); // hinge pivot
  const coverG = new Graphics();
  coverG.rect(0, 0, 28, 26);
  coverG.fill({ color: PALETTE.surfacePale, alpha: 0.16 });
  coverG.rect(0, 0, 28, 26);
  coverG.stroke({ width: 1.5, color: PALETTE.surfacePale, alpha: 0.75 });
  cover.addChild(coverG);
  root.addChild(cover);

  // Pause badge: the fit-zoom cue while the campus is paused. Red ring and
  // bars held above the kiosk; hidden at rest.
  const pauseBadge = new Container();
  pauseBadge.position.set(x, y - 86);
  pauseBadge.alpha = 0;
  pauseBadge.visible = false;
  root.addChild(pauseBadge);
  const badge = new Graphics();
  badge.circle(0, 0, 13);
  badge.fill({ color: PALETTE.space, alpha: 0.85 });
  badge.circle(0, 0, 13);
  badge.stroke({ width: 2.2, color: PALETTE.emergency, alpha: 0.95 });
  badge.rect(-4.5, -6.5, 3.2, 13);
  badge.rect(1.3, -6.5, 3.2, 13);
  badge.fill({ color: PALETTE.emergency });
  pauseBadge.addChild(badge);
  pauseBadge.addChild(glow(0, 0, 46, PALETTE.emergency, 0.3));

  let paused = false;
  const setCampusPaused = (on: boolean): void => {
    if (on === paused) return;
    paused = on;
    floorPauseHook?.(on);
    statusPauseHook?.(on);
    // Reduced motion: snap to composed states, no gestures.
    if (ctx.reducedMotion) {
      pauseBadge.visible = on;
      pauseBadge.alpha = on ? 1 : 0;
      pauseBadge.y = y - 86;
      return;
    }
    gsap.killTweensOf(pauseBadge);
    if (on) {
      pauseBadge.visible = true;
      pauseBadge.y = y - 78;
      gsap.to(pauseBadge, { alpha: 1, y: y - 88, duration: 0.6, ease: "power2.out" });
    } else {
      gsap.to(pauseBadge, {
        alpha: 0,
        y: y - 78,
        duration: 0.4,
        onComplete: () => {
          pauseBadge.visible = false;
        },
      });
    }
  };

  let demoRunning = false;
  const api: EmergencyControlApi = {
    setCampusPaused,
    demoPause() {
      if (demoRunning) return;
      demoRunning = true;
      if (ctx.reducedMotion) {
        setCampusPaused(true);
        ctx.onCleanup(() => setCampusPaused(false));
        demoRunning = false;
        return;
      }
      const tl = gsap.timeline({
        onComplete: () => {
          demoRunning = false;
        },
      });
      tl.to(cover, { rotation: -0.5, alpha: 0.25, duration: 0.35, ease: "power2.in" })
        .to(cover.scale, { x: 0.12, duration: 0.35, ease: "power2.in" }, "<")
        .to(button.scale, { x: 0.85, y: 0.85, duration: 0.12, yoyo: true, repeat: 1 }, ">")
        .call(() => setCampusPaused(true))
        .to({}, { duration: 2.4 })
        .call(() => setCampusPaused(false))
        .to(cover, { rotation: 0, alpha: 1, duration: 0.4, ease: "power2.out" })
        .to(cover.scale, { x: 1, duration: 0.4, ease: "power2.out" }, "<");
      ctx.onCleanup(() => {
        tl.kill();
        gsap.killTweensOf([cover, button]);
        // A teardown mid-demo must not leave the pause applied.
        setCampusPaused(false);
      });
    },
  };
  registerApi(ctx, def.id, api);
  // South of the kiosk: the badge and panel top own the space above.
  addSign(ctx, def, x, y + 40, PALETTE.emergency);

  if (!ctx.reducedMotion) {
    ctx.onTick(() => {
      const t = performance.now() / 1000;
      statusLight.alpha = 0.55 + 0.3 * Math.sin(t * 2.4);
    });
    ctx.onCleanup(() => gsap.killTweensOf(pauseBadge));
  }
}

/** Attach an api post-registration (helper for split builds). */
function registerApi(_ctx: DioramaContext, id: StationId, api: object): void {
  const handle = getStation(id);
  if (handle) handle.api = api;
}
