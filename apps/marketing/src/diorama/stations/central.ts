/**
 * Central Trading Floor: circular floor, holographic market core, six agent
 * workstations, signal tower, event clock, status mast, plus the Human
 * Supervisor elevated deck and emergency control panel. Owner: central
 * district worker.
 *
 * Depth notes: the floor platform root sits at anchor.y - 8 so anything on
 * the platform (desks, pedestal) sorts above it. Desks are registered as
 * their own sortable roots at their foot Y so population agents standing at
 * the same Y interleave correctly in front of and behind them.
 */
import { Container, Graphics, Sprite } from "pixi.js";
import gsap from "gsap";
import type { DioramaContext } from "../core/context.js";
import { PALETTE, ROLE_COLORS, rightFace, shade, topFace } from "../config/palette.js";
import type { AgentRole } from "../config/palette.js";
import { STATIONS } from "../config/stations.js";
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

export interface SignalTowerApi {
  /** Emit a differentiated pulse: market, alert, wake, warning, execution. */
  pulse(kind: "market" | "alert" | "wake" | "warning" | "execution"): void;
}

export interface SupervisorApi {
  /** Demonstrate pause / resume of the whole campus. */
  setCampusPaused(paused: boolean): void;
}

export interface EmergencyApi {
  /** Flip the protected cover, pulse the button, and run the pause demo. */
  demoPause(): void;
}

const FLOOR = { x: 1430, y: 740 };
const RNG = seededRandom(0xc3e7411);

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
  buildSupervisorDeck(ctx);
}

// ---------------------------------------------------------------------------
// Trading floor platform
// ---------------------------------------------------------------------------

function buildTradingFloor(ctx: DioramaContext): void {
  const def = STATIONS.tradingFloor;
  const root = stationRoot(ctx, def, def.anchor.y - 8);

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
  plinth.ellipse(FLOOR.x, FLOOR.y, 348, 198);
  plinth.stroke({ width: 2, color: PALETTE.surfacePale, alpha: 0.45 });
  // Inset cyan ring lights just inside the rim.
  plinth.ellipse(FLOOR.x, FLOOR.y, 330, 187);
  plinth.stroke({ width: 2, color: PALETTE.cyan, alpha: 0.5 });
  plinth.ellipse(FLOOR.x, FLOOR.y, 322, 180);
  plinth.stroke({ width: 1, color: PALETTE.cyan, alpha: 0.2 });
  root.addChild(plinth);

  // Warm-lit central medallion: concentric accent inlays + 8 radial spokes.
  const medallion = new Graphics();
  medallion.ellipse(FLOOR.x, FLOOR.y, 250, 142);
  medallion.stroke({ width: 3, color: PALETTE.violet, alpha: 0.35 });
  medallion.ellipse(FLOOR.x, FLOOR.y, 240, 136);
  medallion.stroke({ width: 1.5, color: PALETTE.blue, alpha: 0.3 });
  medallion.ellipse(FLOOR.x, FLOOR.y, 190, 108);
  medallion.stroke({ width: 3, color: PALETTE.cyan, alpha: 0.4 });
  medallion.ellipse(FLOOR.x, FLOOR.y, 120, 68);
  medallion.stroke({ width: 2, color: PALETTE.aqua, alpha: 0.35 });
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    medallion.moveTo(FLOOR.x + Math.cos(a) * 122, FLOOR.y + Math.sin(a) * 69);
    medallion.lineTo(FLOOR.x + Math.cos(a) * 246, FLOOR.y + Math.sin(a) * 140);
    medallion.stroke({ width: 1.5, color: PALETTE.surfacePale, alpha: 0.22 });
  }
  root.addChild(medallion);

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
  root.addChild(chevrons);

  // Mid-ring glyph pads: small diamond floor projections between the holo and
  // the desk ring so the arena's middle band carries data imagery instead of
  // reading as empty floor. Static, one draw.
  const midPads = new Graphics();
  const PAD_ACCENTS = [
    PALETTE.cyan,
    PALETTE.violet,
    PALETTE.aqua,
    PALETTE.blue,
    PALETTE.orange,
    PALETTE.magenta,
  ];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
    const px = FLOOR.x + Math.cos(a) * 205;
    const py = FLOOR.y + Math.sin(a) * 116;
    midPads.poly([px - 26, py, px, py + 13, px + 26, py, px, py - 13]);
    midPads.fill({ color: PALETTE.structureLight, alpha: 0.85 });
    midPads.poly([px - 26, py, px, py + 13, px + 26, py, px, py - 13]);
    midPads.stroke({ width: 1.5, color: PAD_ACCENTS[i], alpha: 0.75 });
    // Two abstract data glyphs inside each pad (bar + dot arrangements).
    const acc = PAD_ACCENTS[i];
    midPads.rect(px - 12, py - 4, 5, 8);
    midPads.fill({ color: acc, alpha: 0.8 });
    midPads.rect(px - 4, py - 7, 5, 11);
    midPads.fill({ color: acc, alpha: 0.55 });
    midPads.circle(px + 9, py + 2, 3);
    midPads.fill({ color: acc, alpha: 0.9 });
  }
  root.addChild(midPads);

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
    root.addChild(bar);
  }

  // Chase lights around the outer ring: 12 additive dots, one shared ticker.
  const chase: Sprite[] = [];
  const CHASE_COLORS = [PALETTE.cyan, PALETTE.blue, PALETTE.violet];
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const light = glow(FLOOR.x + Math.cos(a) * 286, FLOOR.y + Math.sin(a) * 163, 12, CHASE_COLORS[i % 3], 0.5);
    chase.push(light);
    root.addChild(light);
  }
  if (ctx.reducedMotion) {
    // Static arrangement, varied brightness so the ring still reads lit.
    chase.forEach((c, i) => {
      c.alpha = 0.25 + 0.35 * (((i * 5) % 12) / 12);
    });
  }

  // Slowly pulsing concentric emissive floor lines (8 s), alpha only.
  const pulseRings: Graphics[] = [];
  for (const r of [300, 230, 160]) {
    const ring = new Graphics();
    ring.ellipse(FLOOR.x, FLOOR.y, r, r * 0.57);
    ring.stroke({ width: 1.5, color: PALETTE.cyan, alpha: 0.3 });
    ring.blendMode = "add";
    ring.alpha = 0.3;
    pulseRings.push(ring);
    root.addChild(ring);
    ring.zIndex = 1;
  }

  for (const desk of DESKS) buildDesk(ctx, desk);

  if (!ctx.reducedMotion) {
    ctx.onTick(() => {
      const time = performance.now() / 1000;
      const phase = (time * Math.PI * 2) / 8;
      for (const [i, ring] of pulseRings.entries()) {
        ring.alpha = 0.22 + 0.18 * (0.5 + 0.5 * Math.sin(phase - i * 0.9));
      }
      const chasePhase = (time * Math.PI * 2) / 4;
      for (const [i, light] of chase.entries()) {
        light.alpha = 0.18 + 0.55 * Math.max(0, Math.sin(chasePhase - (i / 12) * Math.PI * 2));
      }
    });
  }

  // The district banner "CENTRAL TRADING FLOOR" above the arena carries the
  // name; a second rim sign here would stack on the supervisor zone below.
}

/** One open workstation: wide console with role trim, a chair with a tall
 * backrest, a floating role holo pane, and a soft AO ellipse at its root. */
function buildDesk(ctx: DioramaContext, desk: { x: number; y: number; role: AgentRole }): void {
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

  // Console screen with two tiny data lines in the role tint.
  root.addChild(glow(desk.x, desk.y - 34, 52, accent, 0.16));
  const screen = screenPanel({
    x: desk.x - 18,
    y: desk.y - 46,
    w: 36,
    h: 20,
    accent,
  });
  const content = new Graphics();
  content.moveTo(desk.x - 13, desk.y - 37);
  content.lineTo(desk.x - 3, desk.y - 42);
  content.lineTo(desk.x + 5, desk.y - 36);
  content.lineTo(desk.x + 13, desk.y - 40);
  content.stroke({ width: 1.5, color: accent, alpha: 0.9 });
  content.moveTo(desk.x - 13, desk.y - 32);
  content.lineTo(desk.x + 13, desk.y - 32);
  content.stroke({ width: 1, color: accent, alpha: 0.4 });
  screen.addChild(content);
  root.addChild(screen);

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
    ctx.onCleanup(() => gsap.killTweensOf(pane));
  }
}

// ---------------------------------------------------------------------------
// Holographic market core
// ---------------------------------------------------------------------------

function buildHoloCore(ctx: DioramaContext): void {
  const def = STATIONS.holoCore;
  const { x, y } = def.anchor;
  const root = stationRoot(ctx, def, y);

  // Soft AO + pedestal + breathing additive cone carrying the hologram.
  const ao = new Graphics();
  ao.ellipse(x, y + 6, 26, 11);
  ao.fill({ color: PALETTE.space, alpha: 0.3 });
  root.addChild(ao);
  root.addChild(isoCylinder({ x, y: y + 4, r: 16, h: 12, color: PALETTE.structure, rim: PALETTE.cyan }));
  root.addChild(glow(x, y - 8, 48, PALETTE.cyan, 0.45));
  const cone = lightBeam(x, y - 12, 120, 34, 118, PALETTE.cyan, 0.4);
  root.addChild(cone);

  // Floating content stack: abstract glyphs, billboard, gently bobbing (6 s).
  const stack = new Container();
  stack.scale.set(1.5);
  stack.position.set(x, y - 88);
  root.addChild(stack);

  // Price ribbon: tiny candles; one new candle every ~4 s, then scroll.
  interface Candle { o: number; c: number; h: number; l: number }
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

  // Strategy chips (violet) + health dots (green), one row.
  const chips = new Graphics();
  for (const [i, cx] of [-40, -6].entries()) {
    chips.roundRect(cx, -1, 30, 9, 3);
    chips.fill({ color: PALETTE.violet, alpha: 0.35 });
    chips.roundRect(cx, -1, 30, 9, 3);
    chips.stroke({ width: 1, color: PALETTE.violet, alpha: 0.85 });
    chips.moveTo(cx + 4, 3.5);
    chips.lineTo(cx + 18, 3.5);
    chips.stroke({ width: 1, color: PALETTE.violet, alpha: 0.6 });
    void i;
  }
  for (let i = 0; i < 4; i++) {
    chips.circle(26 + i * 9, 3.5, 2.2);
    chips.fill({ color: PALETTE.healthy, alpha: 0.9 });
  }
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
        ribbonTop + 4 + ribbonH - (lastCandle.o + lastCandle.c) / 2 * ribbonH,
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
  root.addChild(isoBox({ x, y: y + 3, w: 30, d: 16, h: 8, color: PALETTE.structure, rim: PALETTE.surfacePale }));

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
    gsap.fromTo(beacon, { alpha: 0.5 }, {
      alpha: 1,
      duration: 0.3,
      yoyo: true,
      repeat: 1,
      onComplete: () => {
        beacon.alpha = 0.6;
      },
    });
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
  root.addChild(isoBox({ x, y: y + 2, w: 26, d: 14, h: 6, color: PALETTE.structureLight, rim: PALETTE.aqua }));
  root.addChild(isoBox({ x, y: y - 2, w: 16, d: 9, h: 44, color: PALETTE.structure, rim: PALETTE.surfacePale }));
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

  // Sweeping second glint: thin needle crossing all rings.
  const glint = new Graphics();
  glint.moveTo(0, 0);
  glint.lineTo(0, -38);
  glint.stroke({ width: 1.5, color: PALETTE.surfacePale, alpha: 0.85 });
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

  root.addChild(isoBox({ x, y: y + 2, w: 12, d: 7, h: 46, color: PALETTE.structureLight, rim: PALETTE.surfacePale }));
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
  lights.forEach((l, i) => {
    const lx = x - 24 + i * 16;
    root.addChild(glow(lx, y - 56, 12, l.color, 0.55));
    const dot = new Graphics();
    dot.circle(lx, y - 56, 3);
    dot.fill({ color: l.color });
    root.addChild(dot);
    const shield = new Graphics();
    shield.setStrokeStyle({ width: 1.2, color: l.color, alpha: 0.9 });
    if (l.shape === "circle") shield.circle(lx, y - 44, 4);
    if (l.shape === "square") shield.rect(lx - 3.5, y - 47.5, 7, 7);
    if (l.shape === "triangle") shield.poly([lx, y - 49, lx + 4, y - 41, lx - 4, y - 41]);
    if (l.shape === "diamond") shield.poly([lx, y - 49, lx + 4, y - 44, lx, y - 39, lx - 4, y - 44]);
    shield.stroke();
    root.addChild(shield);
  });

  addSign(ctx, def, x, y + 34, PALETTE.healthy);
}

// ---------------------------------------------------------------------------
// Supervisor deck + emergency panel
// ---------------------------------------------------------------------------

function buildSupervisorDeck(ctx: DioramaContext): void {
  const sDef = STATIONS.supervisor;
  const eDef = STATIONS.emergencyPanel;
  const { x, y } = sDef.anchor;
  // Deck sorts at its front edge so agents standing below render behind it.
  const root = stationRoot(ctx, sDef, y + 62);

  // Elevated platform with front steps and a gold rim.
  root.addChild(isoBox({ x, y, w: 210, d: 124, h: 24, color: PALETTE.structure, rim: PALETTE.yellow }));
  root.addChild(isoTile(x, y - 24, 196, 112, topFace(PALETTE.structure), 1, PALETTE.yellow));
  // Warm gold wash across the deck floor: authority read, alpha only.
  const wash = isoTile(x, y - 24, 196, 112, PALETTE.yellow, 0.09);
  wash.blendMode = "add";
  root.addChild(wash);
  root.addChild(edgeStrip(x - 105, y + 31, x, y + 62, PALETTE.yellow, 0.9, 2));
  root.addChild(edgeStrip(x, y + 62, x + 105, y + 31, PALETTE.yellow, 0.9, 2));
  for (let i = 0; i < 2; i++) {
    root.addChild(isoTile(x, y + 68 + i * 9 - i * 4, 150 - i * 40, 18, shade(PALETTE.structure, -0.1 * (i + 1))));
  }

  // Command desk: wide, pale top, gold trim.
  root.addChild(isoBox({ x, y: y - 20, w: 96, d: 42, h: 26, color: PALETTE.structureLight, rim: PALETTE.yellow }));
  root.addChild(isoTile(x, y - 46, 86, 38, PALETTE.surfacePale, 0.95));

  // Screens: risk dial, approval queue, exposure gauge, mission controls.
  const screens = new Container();
  screens.position.set(x, y - 78);
  root.addChild(screens);
  const dial = new Graphics();
  dial.arc(-45, 0, 11, Math.PI * 0.8, Math.PI * 2.2);
  dial.stroke({ width: 2, color: PALETTE.yellow, alpha: 0.9 });
  dial.moveTo(-45, 0);
  dial.lineTo(-52, -7);
  dial.stroke({ width: 1.5, color: PALETTE.surfacePale, alpha: 0.9 });
  screens.addChild(dial);

  const approvalCard = new Graphics();
  approvalCard.roundRect(-16, -12, 32, 22, 4);
  approvalCard.fill({ color: PALETTE.waiting, alpha: 0.35 });
  approvalCard.roundRect(-16, -12, 32, 22, 4);
  approvalCard.stroke({ width: 1.5, color: PALETTE.waiting, alpha: 0.95 });
  approvalCard.moveTo(-11, -4);
  approvalCard.lineTo(11, -4);
  approvalCard.moveTo(-11, 2);
  approvalCard.lineTo(4, 2);
  approvalCard.stroke({ width: 1, color: PALETTE.waiting, alpha: 0.7 });
  screens.addChild(approvalCard);

  const gauge = new Graphics();
  gauge.arc(45, 8, 12, Math.PI, Math.PI * 1.6);
  gauge.stroke({ width: 2, color: PALETTE.orange, alpha: 0.9 });
  gauge.moveTo(45, 8);
  gauge.lineTo(45 + 10 * Math.cos(Math.PI * 1.45), 8 + 10 * Math.sin(Math.PI * 1.45));
  gauge.stroke({ width: 1.5, color: PALETTE.surfacePale, alpha: 0.9 });
  screens.addChild(gauge);

  const missions = new Graphics();
  missions.roundRect(-48, 14, 96, 12, 3);
  missions.fill({ color: PALETTE.space, alpha: 0.6 });
  missions.roundRect(-48, 14, 96, 12, 3);
  missions.stroke({ width: 1, color: PALETTE.orange, alpha: 0.7 });
  for (let i = 0; i < 4; i++) {
    missions.rect(-42 + i * 22, 18, 14, 4);
    missions.fill({ color: i < 2 ? PALETTE.orange : PALETTE.inkDim, alpha: 0.8 });
  }
  screens.addChild(missions);

  // Controls rail: 6 glyphed controls. pause, cancel, reduce, close, revoke, budget.
  const rail = new Graphics();
  const glyphs: ((gx: number) => void)[] = [
    (gx) => {
      rail.rect(gx - 3, y - 34, 2, 6);
      rail.rect(gx + 1, y - 34, 2, 6);
    },
    (gx) => {
      rail.moveTo(gx - 3, y - 34);
      rail.lineTo(gx + 3, y - 28);
      rail.moveTo(gx + 3, y - 34);
      rail.lineTo(gx - 3, y - 28);
    },
    (gx) => {
      rail.moveTo(gx - 3, y - 33);
      rail.lineTo(gx, y - 29);
      rail.lineTo(gx + 3, y - 33);
    },
    (gx) => {
      rail.rect(gx - 3, y - 34, 6, 6);
    },
    (gx) => {
      rail.circle(gx, y - 31, 3.5);
      rail.moveTo(gx - 3, y - 27);
      rail.lineTo(gx + 3, y - 35);
    },
    (gx) => {
      rail.arc(gx, y - 31, 3.5, Math.PI * 0.2, Math.PI * 1.4);
    },
  ];
  glyphs.forEach((draw, i) => {
    const gx = x - 42 + i * 17;
    rail.roundRect(gx - 6.5, y - 37, 13, 12, 2.5);
    rail.fill({ color: PALETTE.space, alpha: 0.7 });
    rail.setStrokeStyle({ color: PALETTE.surfacePale, width: 1, alpha: 0.85 });
    rail.roundRect(gx - 6.5, y - 37, 13, 12, 2.5);
    rail.stroke();
    draw(gx);
  });
  rail.fill({ color: PALETTE.surfacePale, alpha: 0.95 });
  rail.stroke({ width: 1.2, color: PALETTE.surfacePale, alpha: 0.9 });
  root.addChild(rail);

  // Owner: a human silhouette with warm rim light and a soft halo.
  const figure = new Container();
  figure.position.set(x + 2, y - 48);
  root.addChild(figure);
  figure.addChild(glow(0, -26, 88, PALETTE.orange, 0.22));
  const body = new Graphics();
  body.circle(0, -44, 6);
  body.poly([-11, 6, 11, 6, 8, -34, -8, -34]);
  body.fill({ color: 0x0b1524, alpha: 0.95 });
  body.circle(0, -44, 6);
  body.poly([-11, 6, 11, 6, 8, -34, -8, -34]);
  body.stroke({ width: 2.2, color: PALETTE.orange, alpha: 0.95 });
  figure.addChild(body);

  // The owner's seat, deliberately empty and beside the desk.
  const chair = new Graphics();
  const chX = x - 78;
  chair.roundRect(chX - 10, y - 62, 20, 5, 2);
  chair.fill({ color: PALETTE.structureLight });
  chair.roundRect(chX - 10, y - 62, 20, 5, 2);
  chair.stroke({ width: 1, color: PALETTE.surfacePale, alpha: 0.7 });
  chair.poly([chX - 10, y - 62, chX - 10, y - 80, chX + 10, y - 80, chX + 10, y - 62]);
  chair.fill({ color: PALETTE.structure, alpha: 0.9 });
  chair.poly([chX - 10, y - 62, chX - 10, y - 80, chX + 10, y - 80, chX + 10, y - 62]);
  chair.stroke({ width: 1, color: PALETTE.surfacePale, alpha: 0.55 });
  root.addChild(chair);

  // Cantilevered canopy rail: two thin posts and a slim gold bar (not a roof)
  // with three pendant lights hanging over the command desk.
  const canopy = new Graphics();
  canopy.rect(x - 62, y - 128, 3, 84);
  canopy.rect(x + 59, y - 128, 3, 84);
  canopy.fill({ color: PALETTE.structureLight });
  canopy.rect(x - 62, y - 128, 3, 84);
  canopy.rect(x + 59, y - 128, 3, 84);
  canopy.stroke({ width: 1, color: PALETTE.surfacePale, alpha: 0.6 });
  canopy.roundRect(x - 74, y - 134, 148, 6, 3);
  canopy.fill({ color: PALETTE.structureLight });
  canopy.roundRect(x - 74, y - 134, 148, 6, 3);
  canopy.stroke({ width: 1.2, color: PALETTE.yellow, alpha: 0.9 });
  for (const px of [x - 42, x, x + 42]) {
    canopy.moveTo(px, y - 128);
    canopy.lineTo(px, y - 114);
    canopy.stroke({ width: 1, color: PALETTE.surfacePale, alpha: 0.7 });
    canopy.circle(px, y - 111, 2.5);
    canopy.fill({ color: PALETTE.yellow, alpha: 0.95 });
  }
  root.addChild(canopy);
  for (const px of [x - 42, x, x + 42]) {
    root.addChild(glow(px, y - 111, 16, PALETTE.yellow, 0.55));
  }

  // Small holographic campus map floating beside the desk: tiny gold campus
  // silhouette on a translucent pane.
  const mapX = x + 96;
  const campusMap = new Container();
  campusMap.position.set(mapX, y - 58);
  const mapG = new Graphics();
  mapG.roundRect(-24, -17, 48, 32, 4);
  mapG.fill({ color: PALETTE.space, alpha: 0.55 });
  mapG.roundRect(-24, -17, 48, 32, 4);
  mapG.stroke({ width: 1, color: PALETTE.yellow, alpha: 0.75 });
  mapG.moveTo(-18, 6);
  mapG.lineTo(-4, -2);
  mapG.lineTo(8, 3);
  mapG.lineTo(18, -4);
  mapG.stroke({ width: 1, color: PALETTE.yellow, alpha: 0.5 });
  for (const [mx, my, ms] of [
    [-16, -2, 5],
    [-2, -8, 7],
    [10, -3, 5],
    [4, 9, 4],
  ] as const) {
    mapG.poly([mx, my - ms / 2, mx + ms / 2, my, mx, my + ms / 2, mx - ms / 2, my]);
    mapG.stroke({ width: 1, color: PALETTE.yellow, alpha: 0.85 });
  }
  mapG.circle(10, -3, 2);
  mapG.fill({ color: PALETTE.yellow, alpha: 0.9 });
  campusMap.addChild(mapG);
  campusMap.addChild(glow(0, 0, 40, PALETTE.yellow, 0.12));
  root.addChild(campusMap);
  if (!ctx.reducedMotion) {
    gsap.to(campusMap, {
      y: y - 62,
      duration: 4,
      yoyo: true,
      repeat: -1,
      ease: "sine.inOut",
    });
    ctx.onCleanup(() => gsap.killTweensOf(campusMap));
  }

  // Gold pause glyph shown while the campus is paused.
  const pauseGlyph = new Container();
  pauseGlyph.position.set(x, y - 118);
  pauseGlyph.alpha = 0;
  pauseGlyph.visible = false;
  root.addChild(pauseGlyph);
  const glyph = new Graphics();
  glyph.circle(0, 0, 13);
  glyph.fill({ color: PALETTE.space, alpha: 0.85 });
  glyph.circle(0, 0, 13);
  glyph.stroke({ width: 2, color: PALETTE.yellow, alpha: 0.95 });
  glyph.rect(-4, -6, 3, 12);
  glyph.rect(1, -6, 3, 12);
  glyph.fill({ color: PALETTE.yellow });
  pauseGlyph.addChild(glyph);
  pauseGlyph.addChild(glow(0, 0, 44, PALETTE.yellow, 0.3));

  let paused = false;
  const supervisorApi: SupervisorApi = {
    setCampusPaused(next) {
      if (next === paused) return;
      paused = next;
      gsap.killTweensOf([pauseGlyph, screens]);
      if (next) {
        pauseGlyph.visible = true;
        pauseGlyph.y = y - 108;
        gsap.to(pauseGlyph, { alpha: 1, y: y - 118, duration: 0.6, ease: "power2.out" });
        gsap.to(screens, { alpha: 0.3, duration: 0.4 });
      } else {
        gsap.to(pauseGlyph, {
          alpha: 0,
          y: y - 108,
          duration: 0.4,
          onComplete: () => {
            pauseGlyph.visible = false;
          },
        });
        gsap.to(screens, { alpha: 1, duration: 0.4 });
      }
    },
  };
  registerApi(ctx, sDef.id, supervisorApi);
  // Below the deck front: the TRADING FLOOR sign owns the rim space at
  // y ~1000; placing this sign above the deck would collide with it.
  addSign(ctx, sDef, x, y + 112, PALETTE.orange);

  if (!ctx.reducedMotion) {
    ctx.onTick(() => {
      const t = performance.now() / 1000;
      approvalCard.alpha = 0.75 + 0.25 * Math.sin((t * Math.PI * 2) / 2.4);
    });
  }

  ctx.onCleanup(() => {
    gsap.killTweensOf([pauseGlyph, screens]);
  });

  buildEmergencyPanel(ctx, eDef, { x: eDef.anchor.x, y: eDef.anchor.y }, supervisorApi);
}

function buildEmergencyPanel(
  ctx: DioramaContext,
  def: StationDef,
  at: { x: number; y: number },
  supervisorApi: SupervisorApi,
): void {
  const root = stationRoot(ctx, def, at.y + 40);
  const { x, y } = at;

  // Red-trimmed wall box on the deck edge.
  const box = new Graphics();
  box.roundRect(x - 18, y - 52, 36, 54, 5);
  box.fill({ color: PALETTE.structure });
  box.roundRect(x - 18, y - 52, 36, 54, 5);
  box.stroke({ width: 2, color: PALETTE.emergency, alpha: 0.95 });
  box.roundRect(x - 14, y - 34, 28, 26, 3);
  box.fill({ color: PALETTE.space, alpha: 0.8 });
  root.addChild(box);

  const statusDot = new Graphics();
  statusDot.circle(x, y - 44, 2.5);
  statusDot.fill({ color: PALETTE.emergency });
  root.addChild(statusDot);
  const statusLight = glow(x, y - 44, 12, PALETTE.emergency, 0.8);
  root.addChild(statusLight);

  // Big protected button under a glass cover hinged on its left edge.
  const button = new Container();
  button.position.set(x, y - 21);
  const btn = new Graphics();
  btn.circle(0, 0, 8);
  btn.fill({ color: PALETTE.emergency });
  btn.circle(0, 0, 8);
  btn.stroke({ width: 2, color: PALETTE.surfacePale, alpha: 0.9 });
  btn.circle(0, 0, 3);
  btn.fill({ color: PALETTE.surfacePale, alpha: 0.85 });
  button.addChild(btn);
  root.addChild(button);
  root.addChild(glow(x, y - 21, 22, PALETTE.emergency, 0.22));

  const cover = new Container();
  cover.position.set(x - 14, y - 34); // hinge pivot
  const coverG = new Graphics();
  coverG.rect(0, 0, 28, 26);
  coverG.fill({ color: PALETTE.surfacePale, alpha: 0.16 });
  coverG.rect(0, 0, 28, 26);
  coverG.stroke({ width: 1.5, color: PALETTE.surfacePale, alpha: 0.75 });
  cover.addChild(coverG);
  root.addChild(cover);

  let demoRunning = false;
  const emergencyApi: EmergencyApi = {
    demoPause() {
      if (demoRunning) return;
      demoRunning = true;
      if (ctx.reducedMotion) {
        supervisorApi.setCampusPaused(true);
        ctx.onCleanup(() => supervisorApi.setCampusPaused(false));
        demoRunning = false;
        return;
      }
      const tl = gsap.timeline({
        onComplete: () => {
          demoRunning = false;
        },
      });
      tl.to(cover, { scaleX: 0.12, rotation: -0.5, alpha: 0.25, duration: 0.35, ease: "power2.in" })
        .to(button, { scale: 0.85, duration: 0.12, yoyo: true, repeat: 1 }, ">")
        .call(() => supervisorApi.setCampusPaused(true))
        .to({}, { duration: 2.4 })
        .call(() => supervisorApi.setCampusPaused(false))
        .to(cover, { scaleX: 1, rotation: 0, alpha: 1, duration: 0.4, ease: "power2.out" });
      ctx.onCleanup(() => {
        tl.kill();
        gsap.killTweensOf([cover, button]);
      });
    },
  };
  registerApi(ctx, def.id, emergencyApi);
  addSign(ctx, def, x, y - 58, PALETTE.emergency);

  if (!ctx.reducedMotion) {
    ctx.onTick(() => {
      const t = performance.now() / 1000;
      statusLight.alpha = 0.55 + 0.3 * Math.sin(t * 2.4);
    });
  }
}

/** Attach an api post-registration (helper for split builds). */
function registerApi(_ctx: DioramaContext, id: StationId, api: object): void {
  const handle = getStation(id);
  if (handle) handle.api = api;
}
