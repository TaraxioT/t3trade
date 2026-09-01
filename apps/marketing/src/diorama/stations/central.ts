/**
 * Central Trading Floor: a tiered circular dais with six dual-screen agent
 * workstations, crowned by the holographic market core, plus the signal
 * tower, event clock, and status mast. The Hyperliquid testnet exchange
 * booth (world/hyperliquid.ts) docks at the floor's east seam and is built
 * from here. Owner: central district worker.
 *
 * Depth notes: the floor platform geometry (steps, medallion, ring lights)
 * lives in the ground layer, below every sortable fixture. The trading floor
 * registers a hit-only root that sorts below the nested holo core so the
 * interaction picker resolves inner stations to their own roots. Desks are
 * registered as their own sortable roots at their foot Y so population agents
 * standing at the same Y interleave correctly in front of and behind them.
 */
import { Container, Graphics, Sprite, Text, TextStyle } from "pixi.js";
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
  lightBeam,
  screenPanel,
  safeDestroy,
} from "../core/iso.js";
import { makeSign } from "../core/signs.js";
import { getStation, registerStation } from "../core/registry.js";
import { buildExchangePort } from "../world/hyperliquid.js";

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
 * Floor-wide pause contract. The emergency control kiosk now lives in the
 * risk district (stations/risk.ts), so the floor itself exposes the pause
 * state: s-emergency-demo (and any rebuilt emergency panel api) calls this to
 * hold the dim steady state across the floor ring and the status mast.
 */
export interface TradingFloorApi {
  /** Pause or resume the floor: ring lights and status mast hold a dim
   * steady state while paused. */
  setCampusPaused(on: boolean): void;
}

const FLOOR = STATIONS.tradingFloor.anchor;
const RNG = seededRandom(0xc3e7411);

/** Uniform console rescale: the dais shrank from 700x480 to 540x390, so the
 * retained cycle-2 workstation art scales by ~540/700. */
const DESK_SCALE = 0.78;

/**
 * Floor-wide desk flash set by buildTradingFloor and read by the holo core's
 * market events, so a market tick is felt at every console in the ring.
 */
let deskPulseHook: ((color: number) => void) | null = null;

/**
 * Status-mast pause hook set by buildStatusMast and invoked by the trading
 * floor's pause api, so the paused state is readable at the room's lighting
 * master without this file owning the mast's internals. Reset by the mast
 * builder so a failed rebuild never leaves a stale hook behind.
 */
let statusPauseHook: ((on: boolean) => void) | null = null;

/** Floor desks at the population wander points; roles tint the console trim.
 * The six workstations are the cycle-2 ring rescaled onto the smaller dais
 * (ellipse units preserved): the east side stays an open walkway with a
 * sightline to the signal tower and across the seam to the exchange booth. */
const DESKS: { x: number; y: number; role: AgentRole }[] = [
  { x: 1255, y: 777, role: "research" },
  { x: 1559, y: 767, role: "analysis" },
  { x: 1276, y: 915, role: "strategy" },
  { x: 1594, y: 915, role: "execution" },
  { x: 1389, y: 996, role: "operations" },
  { x: 1481, y: 996, role: "reconciliation" },
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
  // The exchange booth docks last: it completes the floor's east seam.
  buildExchangePort(ctx);
}

// ---------------------------------------------------------------------------
// Trading floor platform
// ---------------------------------------------------------------------------

function buildTradingFloor(ctx: DioramaContext): void {
  const def = STATIONS.tradingFloor;
  // Hit-only root (registration + transparent footprint); the platform itself
  // is ground geometry (below). Sorts below the nested holo root (anchor y
  // 705): the interaction picker resolves a point to the highest root zIndex
  // whose footprint contains it, so a floor root above the holo would swallow
  // its picks.
  stationRoot(ctx, def, 640);
  // District counter-accent: warm gold inlays subordinate to the cyan ring
  // lights, which stay the floor's infrastructure language.
  const GOLD = DISTRICTS.floor.accent2;
  // Reset first so a failed rebuild never leaves holo events or pause state
  // driving objects from a destroyed world.
  deskPulseHook = null;
  let campusPaused = false;

  // Platform geometry goes to the ground layer, below every sortable fixture,
  // so desks and agents keep sorting against each other by foot Y.
  const platform = new Container();
  ctx.layers.ground.addChild(platform);

  // Raised plinth: two low steps under a circular top platform (rescaled to
  // the 540x390 footprint), with a soft ground shadow and strongly shaded
  // side faces so the step faces read.
  const plinth = new Graphics();
  plinth.ellipse(FLOOR.x, FLOOR.y + 14, 288, 163);
  plinth.fill({ color: PALETTE.space, alpha: 0.3 });
  plinth.ellipse(FLOOR.x, FLOOR.y + 11, 282, 160);
  plinth.fill({ color: rightFace(PALETTE.structure) });
  plinth.ellipse(FLOOR.x, FLOOR.y + 11, 282, 160);
  plinth.stroke({ width: 1, color: PALETTE.space, alpha: 0.5 });
  plinth.ellipse(FLOOR.x, FLOOR.y + 5, 274, 156);
  plinth.fill({ color: shade(PALETTE.structure, -0.05) });
  plinth.ellipse(FLOOR.x, FLOOR.y + 5, 274, 156);
  plinth.stroke({ width: 1, color: PALETTE.structureLight, alpha: 0.6 });
  plinth.ellipse(FLOOR.x, FLOOR.y, 268, 153);
  plinth.fill({ color: topFace(PALETTE.structure) });
  // Pale lift on the top face so the platform reads as solid floor mass.
  plinth.ellipse(FLOOR.x, FLOOR.y, 268, 153);
  plinth.fill({ color: PALETTE.surfacePale, alpha: 0.06 });
  plinth.ellipse(FLOOR.x, FLOOR.y, 268, 153);
  plinth.stroke({ width: 2, color: PALETTE.surfacePale, alpha: 0.45 });
  // Inset cyan ring lights just inside the rim.
  plinth.ellipse(FLOOR.x, FLOOR.y, 254, 144);
  plinth.stroke({ width: 2, color: PALETTE.cyan, alpha: 0.5 });
  plinth.ellipse(FLOOR.x, FLOOR.y, 248, 139);
  plinth.stroke({ width: 1, color: PALETTE.cyan, alpha: 0.2 });
  platform.addChild(plinth);

  // Central medallion, kept calm now that the holo is the visible centerpiece:
  // a gold inlay ring outside the cyan infrastructure band and four faint
  // spokes bridging them.
  const medallion = new Graphics();
  medallion.ellipse(FLOOR.x, FLOOR.y, 185, 105);
  medallion.stroke({ width: 2, color: GOLD, alpha: 0.5 });
  medallion.ellipse(FLOOR.x, FLOOR.y, 147, 83);
  medallion.stroke({ width: 2.5, color: PALETTE.cyan, alpha: 0.45 });
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 8;
    medallion.moveTo(FLOOR.x + Math.cos(a) * 151, FLOOR.y + Math.sin(a) * 85);
    medallion.lineTo(FLOOR.x + Math.cos(a) * 183, FLOOR.y + Math.sin(a) * 103);
    medallion.stroke({
      width: 1.5,
      color: i % 2 ? GOLD : PALETTE.surfacePale,
      alpha: 0.22,
    });
  }
  platform.addChild(medallion);

  // Emissive floor pool: the holo's screens cast soft additive light onto the
  // platform so the floating fixture illuminates the ground it floats over.
  // A squashed glow ellipse; it breathes with the floor's shared 8 s tick below.
  const holoPool = glow(FLOOR.x, FLOOR.y - 40, 270, PALETTE.cyan, 0.13);
  holoPool.scale.y *= 0.42;
  platform.addChild(holoPool);

  // Walkway chevrons: tiny pale arrows on three spokes pointing at the holo.
  const chevrons = new Graphics();
  for (const i of [0, 3, 5]) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    const cx = FLOOR.x + Math.cos(a) * 214;
    const cy = FLOOR.y + Math.sin(a) * 122;
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
    g.arc(0, 0, 231, a0, a0 + 0.5);
    g.stroke({ width: 8.5, color: rightFace(PALETTE.structure), alpha: 0.95 });
    g.arc(0, 0, 231, a0, a0 + 0.5);
    g.stroke({ width: 7, color: topFace(PALETTE.structure), alpha: 0.9 });
    g.arc(0, 0, 227, a0 + 0.03, a0 + 0.47);
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
      FLOOR.x + Math.cos(a) * 220,
      FLOOR.y + Math.sin(a) * 125,
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

  // Slowly pulsing concentric emissive floor lines (8 s), alpha only.
  const pulseRings: { ring: Graphics; base: number }[] = [];
  const RING_MATERIALS: { r: number; color: number; width: number }[] = [
    { r: 231, color: PALETTE.cyan, width: 1.75 },
    { r: 177, color: GOLD, width: 1.25 },
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

  // Tower feed conduit: a dotted floor trace from the east rim of the
  // platform to the signal tower base, so the tower reads as wired into the
  // floor instead of floating beyond it. Static dots carry the path; two
  // additive feed dots drift tower-to-ring (the tower broadcasts, the floor
  // receives) on a slow loop.
  const tower = STATIONS.signalTower.anchor;
  const tdx = tower.x - FLOOR.x;
  const tdy = tower.y + 8 - FLOOR.y;
  const tlen = Math.hypot(tdx, tdy) || 1;
  // Start where the ray toward the tower crosses the rim ellipse (268 x 153):
  // t solves (t*ux/268)^2 + (t*uy/153)^2 = 1, so the point is (ux*t, uy*t).
  const rimT = 1 / Math.hypot(tdx / tlen / 268, tdy / tlen / 153);
  const feedA = {
    x: FLOOR.x + (tdx / tlen) * rimT,
    y: FLOOR.y + (tdy / tlen) * rimT,
  };
  const feedB = { x: tower.x, y: tower.y + 8 };
  const conduit = new Graphics();
  const conduitLen = Math.hypot(feedB.x - feedA.x, feedB.y - feedA.y);
  const feedDots = conduitLen / 14;
  for (let i = 0; i <= feedDots; i++) {
    const t = i / feedDots;
    conduit.circle(feedA.x + (feedB.x - feedA.x) * t, feedA.y + (feedB.y - feedA.y) * t, 1.7);
    conduit.fill({ color: PALETTE.cyan, alpha: 0.42 - t * 0.14 });
  }
  conduit.blendMode = "add";
  platform.addChild(conduit);
  const feedMovers: { mover: Sprite; state: { t: number } }[] = [];
  if (!ctx.reducedMotion) {
    for (let i = 0; i < 2; i++) {
      const mover = glow(feedB.x, feedB.y, 9, PALETTE.cyan, 0.55);
      platform.addChild(mover);
      const state = { t: 0 };
      gsap.fromTo(
        state,
        { t: 0 },
        {
          t: 1,
          duration: 3.4,
          ease: "none",
          repeat: -1,
          delay: i * 1.7,
          onUpdate: () => {
            mover.position.set(
              feedB.x + (feedA.x - feedB.x) * state.t,
              feedB.y + (feedA.y - feedB.y) * state.t,
            );
          },
        },
      );
      feedMovers.push({ mover, state });
    }
    ctx.onCleanup(() => feedMovers.forEach((f) => gsap.killTweensOf(f.state)));
  }

  // Per-desk feedback flashes driven by holo market events.
  const deskFlashes: Sprite[] = [];
  for (const [deskIndex, desk] of DESKS.entries()) buildDesk(ctx, desk, deskIndex, deskFlashes);
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

  // Floor pause, seen from the ring: the lights stop sweeping and hold a dim
  // steady state so the freeze reads at fit zoom. Resume needs no state
  // repair; the ticker simply returns to its sine values.
  const dimFloor = (on: boolean): void => {
    for (const [i, light] of chase.entries()) light.alpha = on ? 0.12 : chaseBase[i];
    for (const { ring, base } of pulseRings) ring.alpha = on ? 0.08 : base;
    // Pools dim with the floor: paused fixtures stop casting light.
    holoPool.alpha = on ? 0.04 : 0.13;
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
      holoPool.alpha = 0.11 + 0.05 * (0.5 + 0.5 * Math.sin(phase * 0.75));
      const chasePhase = (time * Math.PI * 2) / 4;
      for (const [i, light] of chase.entries()) {
        light.alpha = 0.18 + 0.55 * Math.max(0, Math.sin(chasePhase - (i / 12) * Math.PI * 2));
      }
    });
  }

  // Pause api: drives this floor's lights and the status mast's warning cue.
  // The emergency control kiosk (risk district) and s-emergency-demo call it.
  const api: TradingFloorApi = {
    setCampusPaused(on: boolean): void {
      if (on === campusPaused) return;
      campusPaused = on;
      if (ctx.reducedMotion) dimFloor(on);
      statusPauseHook?.(on);
    },
  };
  registerApi(ctx, def.id, api);

  // The district banner "CENTRAL TRADING FLOOR" above the arena carries the
  // name; the open ground south of the platform stays circulation space.
}

/** Tiny chart glyph inside a workstation screen, varied per desk so the six
 * consoles read as different jobs: candles, bars, or a line trace. */
function chartGlyph(kind: "candles" | "bars" | "line", accent: number): Graphics {
  const g = new Graphics();
  if (kind === "line") {
    g.moveTo(-9, 2);
    g.lineTo(-3, -3);
    g.lineTo(2, 0);
    g.lineTo(9, -5);
    g.stroke({ width: 1.4, color: accent, alpha: 0.95 });
    g.moveTo(-9, 5);
    g.lineTo(9, 5);
    g.stroke({ width: 1, color: accent, alpha: 0.45 });
    return g;
  }
  if (kind === "bars") {
    for (const [i, h] of [5, 8, 4, 7].entries()) {
      g.rect(-8 + i * 5.4, 5 - h, 2.6, h);
      g.fill({ color: accent, alpha: 0.85 });
    }
    return g;
  }
  for (const [i, up] of [true, false, true].entries()) {
    const cx = -7 + i * 7;
    g.moveTo(cx, -6);
    g.lineTo(cx, 6);
    g.stroke({ width: 1, color: accent, alpha: 0.7 });
    g.rect(cx - 1.8, up ? -1 : -4, 3.6, 5);
    g.fill({ color: accent, alpha: 0.9 });
  }
  return g;
}

/** One open workstation: wide console with role trim, a chair with a tall
 * backrest, two angled screens with varied chart glyphs, a keyboard strip,
 * one breathing status LED, a floating role holo pane, and a soft AO ellipse
 * at its root. Pushes a flash glow so market events are felt at the console.
 * Drawn in local units around (0, 0) and scaled by DESK_SCALE at the root so
 * the retained art rescales with the smaller dais. */
function buildDesk(
  ctx: DioramaContext,
  desk: { x: number; y: number; role: AgentRole },
  deskIndex: number,
  deskFlashes: Sprite[],
): void {
  const accent = ROLE_COLORS[desk.role];
  const root = new Container();
  root.position.set(desk.x, desk.y);
  root.zIndex = desk.y;
  root.scale.set(DESK_SCALE);
  ctx.layers.sortable.addChild(root);

  // Soft contact shadow under the workstation.
  const ao = new Graphics();
  ao.ellipse(0, 5, 42, 16);
  ao.fill({ color: PALETTE.space, alpha: 0.3 });
  root.addChild(ao);

  // Direction toward the floor center; the chair sits on the center side and
  // the console screen leans the same way, so every desk faces the core.
  const dx = FLOOR.x - desk.x;
  const dy = FLOOR.y - desk.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = dx / len;
  const ny = dy / len;
  const sx = nx * 30;
  const sy = ny * 17;

  root.addChild(isoBox({ x: 0, y: 0, w: 60, d: 34, h: 18, color: PALETTE.structure }));
  // Role trim across the desk's front (south) edges.
  root.addChild(edgeStrip(-30, 8.5, 0, 17, accent, 0.85, 2));
  root.addChild(edgeStrip(0, 17, 30, 8.5, accent, 0.85, 2));

  // Chair: seat cylinder plus a tall backrest on the center side.
  root.addChild(isoCylinder({ x: sx, y: sy, r: 6, h: 9, color: PALETTE.structureLight, rim: accent }));
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

  // Keyboard strip on the console's top face, between the front edge and the
  // screens: reads as a workstation, not a wedge.
  const keys = new Graphics();
  keys.roundRect(-13, -22, 26, 5, 1.5);
  keys.fill({ color: PALETTE.structureLight, alpha: 0.95 });
  keys.roundRect(-13, -22, 26, 5, 1.5);
  keys.stroke({ width: 1, color: PALETTE.surfacePale, alpha: 0.35 });
  for (let kx = -9; kx <= 9; kx += 4.5) {
    keys.moveTo(kx, -21);
    keys.lineTo(kx, -18);
    keys.stroke({ width: 1, color: PALETTE.inkDim, alpha: 0.4 });
  }
  root.addChild(keys);

  // Dual angled screens: two small panels tilted toward the core at slightly
  // different angles, carrying varied chart glyphs per desk. Both live under
  // one container so the idle shimmer treats them as one console.
  const GLYPHS = ["candles", "bars", "line"] as const;
  const mkScreen = (
    offX: number,
    offY: number,
    rot: number,
    kind: (typeof GLYPHS)[number],
  ): Container => {
    const c = new Container();
    c.position.set(offX, offY);
    c.rotation = rot;
    c.addChild(screenPanel({ x: -12, y: -8, w: 24, h: 16, accent }));
    c.addChild(chartGlyph(kind, accent));
    return c;
  };
  const screens = new Container();
  screens.addChild(
    mkScreen(-13, -37, -0.09, GLYPHS[deskIndex % 3]),
    mkScreen(13, -40, 0.07, GLYPHS[(deskIndex + 1) % 3]),
  );
  root.addChild(screens);
  const trimGlow = glow(0, -34, 52, accent, 0.16);
  root.addChild(trimGlow);
  // One status LED per console: role-colored, slow breathing, staggered by
  // desk so the ring's heartbeats desynchronize.
  const led = glow(26, -14, 8, accent, 0.55);
  root.addChild(led);
  const ledDot = new Graphics();
  ledDot.circle(26, -14, 1.7);
  ledDot.fill({ color: accent });
  root.addChild(ledDot);
  // Dedicated market-event flash above the console: stays dormant so the idle
  // shimmer and trim breathing never fight it.
  const flash = glow(0, -38, 46, accent, 0);
  root.addChild(flash);
  deskFlashes.push(flash);

  // Floating role holo pane above the console: two abstract glyphs.
  const pane = new Container();
  pane.position.set(0, -64);
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
      y: -68,
      duration: 3,
      yoyo: true,
      repeat: -1,
      ease: "sine.inOut",
      delay: (desk.x % 7) * 0.4,
    });
    // Idle telemetry: each desk's screens shimmer, its LED and role trim
    // breathe on their own clocks so the six jobs read as separate live
    // consoles, not one texture.
    gsap.to(screens, {
      alpha: 0.6,
      duration: 2.2 + (desk.x % 5) * 0.35,
      yoyo: true,
      repeat: -1,
      ease: "sine.inOut",
      delay: (desk.y % 7) * 0.35,
    });
    gsap.to(led, {
      alpha: 0.22,
      duration: 2.6 + (deskIndex % 3) * 0.6,
      yoyo: true,
      repeat: -1,
      ease: "sine.inOut",
      delay: deskIndex * 0.45,
    });
    gsap.to(trimGlow, {
      alpha: 0.32,
      duration: 3 + (desk.x % 4) * 0.6,
      yoyo: true,
      repeat: -1,
      ease: "sine.inOut",
      delay: (desk.y % 5) * 0.5,
    });
    ctx.onCleanup(() => gsap.killTweensOf([pane, screens, trimGlow, led]));
  }
}

// ---------------------------------------------------------------------------
// Holographic market core
// ---------------------------------------------------------------------------

function buildHoloCore(ctx: DioramaContext): void {
  const def = STATIONS.holoCore;
  const { x, y } = def.anchor;
  const root = stationRoot(ctx, def, y);

  // Soft AO + projection dais + breathing additive cone carrying the
  // hologram. The dais is two low tiered steps crowned by an emitter ring, so
  // the floor's primary fixture grounds deliberately and visibly owns the
  // center of the platform.
  const ao = new Graphics();
  ao.ellipse(x, y + 8, 46, 18);
  ao.fill({ color: PALETTE.space, alpha: 0.32 });
  root.addChild(ao);
  root.addChild(
    isoCylinder({ x, y: y + 7, r: 36, h: 7, color: PALETTE.structure, rim: PALETTE.cyan }),
  );
  root.addChild(
    isoCylinder({ x, y: y + 5, r: 22, h: 8, color: PALETTE.structureLight, rim: PALETTE.cyan }),
  );
  // Emitter ring inset in the upper tier: additive stroke plus small nubs.
  const emitterY = y - 3;
  const emitter = new Graphics();
  emitter.ellipse(x, emitterY, 17, 8.5);
  emitter.stroke({ width: 1.5, color: PALETTE.cyan, alpha: 0.85 });
  emitter.blendMode = "add";
  root.addChild(emitter);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    root.addChild(glow(x + Math.cos(a) * 17, emitterY + Math.sin(a) * 8.5, 7, PALETTE.cyan, 0.5));
  }
  root.addChild(glow(x, y - 10, 56, PALETTE.cyan, 0.45));
  const cone = lightBeam(x, y - 12, 120, 34, 118, PALETTE.cyan, 0.4);
  root.addChild(cone);

  // Volumetric shafts: three soft additive beams rising from the emitter ring
  // past the content stack, so the holo crowns the floor. Low alpha, drawn
  // behind the stack so the glyphs stay crisp; they breathe on the holo's
  // existing tick (never a new ticker).
  const shafts = new Container();
  shafts.position.set(x, y - 4);
  for (const s of [
    { dx: -12, topW: 30, botW: 10, h: 128, rot: -0.055, alpha: 0.1 },
    { dx: 0, topW: 38, botW: 14, h: 150, rot: 0, alpha: 0.13 },
    { dx: 12, topW: 30, botW: 10, h: 128, rot: 0.055, alpha: 0.1 },
  ] as const) {
    const beam = lightBeam(s.dx, 0, s.topW, s.botW, s.h, PALETTE.cyan, s.alpha);
    beam.rotation = s.rot;
    shafts.addChild(beam);
  }
  root.addChild(shafts);

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

  // Ribbon front plus a dimmer depth twin offset behind it, so the price
  // ribbon reads as a volumetric slab instead of a flat card. One shared
  // draw routine refreshes both on each new candle.
  const ribbonDepth = new Graphics();
  ribbonDepth.position.set(5, 4);
  const ribbon = new Graphics();
  const ribbonH = 20;
  const ribbonTop = -34;
  const drawRibbonInto = (g: Graphics, dim: boolean): void => {
    const panelA = dim ? 0.2 : 0.55;
    const frameA = dim ? 0.15 : 0.4;
    const dataA = dim ? 0.3 : 1;
    g.clear();
    g.roundRect(-62, ribbonTop, 124, ribbonH + 8, 4);
    g.fill({ color: PALETTE.space, alpha: panelA });
    g.roundRect(-62, ribbonTop, 124, ribbonH + 8, 4);
    g.stroke({ width: 1, color: PALETTE.cyan, alpha: frameA });
    const yOf = (v: number): number => ribbonTop + 4 + ribbonH - v * ribbonH;
    candles.forEach((k, idx) => {
      const cx = -58 + idx * candleW + candleW / 2;
      const up = k.c >= k.o;
      const col = up ? PALETTE.healthy : PALETTE.blocked;
      g.moveTo(cx, yOf(Math.min(1, k.h)));
      g.lineTo(cx, yOf(Math.max(0, k.l)));
      g.stroke({ width: 1.5, color: col, alpha: 0.95 * dataA });
      const top = yOf(Math.max(k.o, k.c));
      const bot = yOf(Math.min(k.o, k.c));
      g.rect(cx - 2.5, top, 5, Math.max(2, bot - top));
      g.fill({ color: col, alpha: dataA });
    });
  };
  const drawRibbon = (): void => {
    drawRibbonInto(ribbonDepth, true);
    drawRibbonInto(ribbon, false);
  };
  drawRibbon();
  stack.addChild(ribbonDepth, ribbon);
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
      shafts.alpha = 0.8 + 0.2 * (0.5 + 0.5 * Math.sin((t * Math.PI * 2) / 7 + 1.3));
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
    shafts.alpha = 1;
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

  // Illuminated radial dial: soft aqua halo, a tick ring with cardinal
  // emphasis, a slow sweeping phase arc, a counter ring, and an epoch
  // counter, so the clock reads as a lit instrument instead of empty circles.
  face.addChild(glow(0, 0, 108, PALETTE.aqua, 0.1));
  const plate = new Graphics();
  plate.circle(0, 0, 42);
  plate.fill({ color: PALETTE.space, alpha: 0.72 });
  plate.circle(0, 0, 42);
  plate.stroke({ width: 1.5, color: PALETTE.structureLight, alpha: 0.9 });
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const cardinal = i % 3 === 0;
    plate.moveTo(Math.cos(a) * (cardinal ? 34 : 36.5), Math.sin(a) * (cardinal ? 34 : 36.5));
    plate.lineTo(Math.cos(a) * 41, Math.sin(a) * 41);
    plate.stroke({
      width: cardinal ? 2.2 : 1,
      color: cardinal ? PALETTE.ink : PALETTE.inkDim,
      alpha: cardinal ? 0.9 : 0.5,
    });
  }
  plate.circle(0, 0, 2.2);
  plate.fill({ color: PALETTE.aqua });
  face.addChild(plate);
  const epoch = microText("EPOCH 41", 5.5, PALETTE.inkDim);
  epoch.anchor.set(0.5);
  epoch.position.set(0, 10);
  face.addChild(epoch);

  // Slow sweeping phase arc (24 s per revolution) with a bright end dot.
  const phaseArc = new Container();
  const arcG = new Graphics();
  const arcSweep = Math.PI * 2 * (100 / 360);
  arcG.arc(0, 0, 30, -Math.PI / 2, -Math.PI / 2 + arcSweep);
  arcG.stroke({ width: 3, color: PALETTE.aqua, alpha: 0.85 });
  arcG.blendMode = "add";
  phaseArc.addChild(arcG);
  phaseArc.addChild(
    glow(
      Math.cos(-Math.PI / 2 + arcSweep) * 30,
      Math.sin(-Math.PI / 2 + arcSweep) * 30,
      10,
      PALETTE.aqua,
      0.7,
    ),
  );
  face.addChild(phaseArc);

  // Thin counter ring rotating against the sweep (60 s), for depth.
  const counter = new Container();
  const counterG = new Graphics();
  for (let i = 0; i < 2; i++) {
    const start = (i / 2) * Math.PI * 2 + 0.5;
    counterG.arc(0, 0, 20, start, start + Math.PI - 0.9);
    counterG.stroke({ width: 1.5, color: PALETTE.cyan, alpha: 0.55 });
  }
  counterG.blendMode = "add";
  counter.addChild(counterG);
  face.addChild(counter);

  if (!ctx.reducedMotion) {
    ctx.onTick(() => {
      const time = performance.now() / 1000;
      phaseArc.rotation = (time / 24) * Math.PI * 2;
      counter.rotation = -(time / 60) * Math.PI * 2;
    });
  } else {
    phaseArc.rotation = 0.9;
    counter.rotation = 2.1;
  }

  // Sign offset right and low: the dial's halo owns the space directly above.
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

  // Grounded contact shadow under the mast base.
  const mastAo = new Graphics();
  mastAo.ellipse(x, y + 5, 17, 7);
  mastAo.fill({ color: PALETTE.space, alpha: 0.3 });
  root.addChild(mastAo);
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

  // Floor-pause cue: the mast is the room lighting master, so its warning
  // square (amber, degraded) holds bright and grows while the trading floor
  // holds its paused state. Alpha/scale only; snaps in reduced motion.
  const warnLamp = lamps[2];
  statusPauseHook = (on: boolean): void => {
    if (!warnLamp) return;
    warnLamp.alpha = on ? 1 : 0.55;
    warnLamp.scale.set(on ? 1.35 : 1);
  };

  // Sign offset east of the mast, clear of the dais steps to the north-east.
  addSign(ctx, def, x + 34, y + 40, PALETTE.healthy);
}

/** Tiny console readout text; real Pixi text so it stays crisp at zoom. */
function microText(text: string, size: number, color: number): Text {
  const t = new Text({
    text,
    style: new TextStyle({
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      fontSize: size,
      letterSpacing: size * 0.08,
      fill: color,
    }),
  });
  t.resolution = 2;
  return t;
}

/** Attach an api post-registration (helper for split builds). */
function registerApi(_ctx: DioramaContext, id: StationId, api: object): void {
  const handle = getStation(id);
  if (handle) handle.api = api;
}
