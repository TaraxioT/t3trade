/**
 * Central Trading Floor: circular floor, holographic market core crowned by
 * volumetric shafts, the Uniswap liquidity pavilion west of the holo
 * (research window, never an exchange), six dual-screen agent workstations,
 * signal tower, event clock, status mast, plus the emergency control kiosk at
 * the safety-perimeter seam. The exchange itself stays external
 * (world/hyperliquid.ts beyond the east perimeter). Owner: central district
 * worker.
 *
 * Depth notes: the floor platform geometry (steps, medallion, ring lights)
 * lives in the ground layer, below every sortable fixture. A single sortable
 * plinth root used to sort above the holo core and the north desks and paint
 * them under its opaque top face. Desks are registered as their own sortable
 * roots at their foot Y so population agents standing at the same Y interleave
 * correctly in front of and behind them.
 */
import { Assets, Container, Graphics, Sprite, Text, TextStyle, type Texture } from "pixi.js";
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
  isoWall,
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

/**
 * Uniswap venue contract (frozen; stories.ts depends on the shape).
 * Registered under station id "uniswapVenue". The pavilion is a liquidity
 * research window only: pool gauges and the quote comparison readout blip
 * when research stories reference them.
 */
export interface UniswapVenueApi {
  /** Highlight the pool-depth gauges or the quote comparison readout. */
  pulse(kind: "pool" | "quote"): void;
}

const FLOOR = { x: 1430, y: 740 };
const RNG = seededRandom(0xc3e7411);

/** Brand trim for the Uniswap pavilion; the mark itself is a real Sprite
 * asset, never approximated procedurally. */
const UNISWAP_PINK = 0xff007a;

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

/** Floor desks at the population wander points; roles tint the console trim.
 * The former north pair ceded its latitude to the venue pavilions flanking
 * the holo and moved outward along the ring. The east pavilion is gone, so
 * the analysis desk returns to its wander start (1590, 640) and the east
 * side of the ring stays an open walkway with a clear sightline to the
 * signal tower; the west desks stay clear of the Uniswap footprint
 * (x 1235..1355, y 620..710). */
const DESKS: { x: number; y: number; role: AgentRole }[] = [
  { x: 1198, y: 652, role: "research" },
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
  // The Uniswap venue builds after the holo so the equal-zIndex overlap
  // sliver between the pavilion diamond and the holo diamond resolves to the
  // holo, keeping the primary element dominant in pointer picks too.
  buildUniswapVenue(ctx);
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
  // is ground geometry (below). Sorts below the nested holo and venue roots
  // (anchor y 665): the interaction picker resolves a point to the highest
  // root zIndex whose footprint contains it, so a floor root above them would
  // swallow every inner station's picks.
  stationRoot(ctx, def, 640);
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

  // Emissive floor pools: the holo's screens and the pavilion's console cast
  // soft additive light onto the platform so floating fixtures illuminate the
  // ground they float over. Cyan under the holo (north of center), faint pink
  // under the Uniswap pavilion (west). Squashed glow ellipses; they breathe
  // with the floor's shared 8 s tick below.
  const holoPool = glow(FLOOR.x, FLOOR.y - 52, 350, PALETTE.cyan, 0.13);
  holoPool.scale.y *= 0.42;
  platform.addChild(holoPool);
  const venuePool = glow(STATIONS.uniswapVenue.anchor.x, FLOOR.y - 58, 170, UNISWAP_PINK, 0.08);
  venuePool.scale.y *= 0.45;
  platform.addChild(venuePool);

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

  // Tower feed conduit: a dotted floor trace from the east rim of the
  // platform to the signal tower base, so the tower reads as wired into the
  // floor instead of floating beyond it. Static dots carry the path; two
  // additive feed dots drift tower-to-ring (the tower broadcasts, the floor
  // receives) on a slow loop.
  const tower = STATIONS.signalTower.anchor;
  const tdx = tower.x - FLOOR.x;
  const tdy = tower.y + 8 - FLOOR.y;
  const tlen = Math.hypot(tdx, tdy) || 1;
  // Start where the ray toward the tower crosses the rim ellipse (348 x 198):
  // t solves (t*ux/348)^2 + (t*uy/198)^2 = 1, so the point is (ux*t, uy*t).
  const rimT = 1 / Math.hypot(tdx / tlen / 348, tdy / tlen / 198);
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

  // Campus pause, seen from the floor: the ring stops sweeping and holds a
  // dim steady state so the freeze reads at fit zoom. Resume needs no state
  // repair; the ticker simply returns to its sine values.
  const dimFloor = (on: boolean): void => {
    for (const [i, light] of chase.entries()) light.alpha = on ? 0.12 : chaseBase[i];
    for (const { ring, base } of pulseRings) ring.alpha = on ? 0.08 : base;
    // Pools dim with the campus: paused fixtures stop casting light.
    holoPool.alpha = on ? 0.04 : 0.13;
    venuePool.alpha = on ? 0.025 : 0.08;
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
      // Pools breathe on the same 8 s family, slightly out of phase so the
      // floor's light feels like one system, not one strobe.
      holoPool.alpha = 0.11 + 0.05 * (0.5 + 0.5 * Math.sin(phase * 0.75));
      venuePool.alpha = 0.065 + 0.03 * (0.5 + 0.5 * Math.sin(phase * 0.5 + 2.1));
      const chasePhase = (time * Math.PI * 2) / 4;
      for (const [i, light] of chase.entries()) {
        light.alpha = 0.18 + 0.55 * Math.max(0, Math.sin(chasePhase - (i / 12) * Math.PI * 2));
      }
    });
  }

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
 * at its root. Pushes a flash glow so market events are felt at the console. */
function buildDesk(
  ctx: DioramaContext,
  desk: { x: number; y: number; role: AgentRole },
  deskIndex: number,
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

  // Keyboard strip on the console's top face, between the front edge and the
  // screens: reads as a workstation, not a wedge.
  const keys = new Graphics();
  keys.roundRect(desk.x - 13, desk.y - 22, 26, 5, 1.5);
  keys.fill({ color: PALETTE.structureLight, alpha: 0.95 });
  keys.roundRect(desk.x - 13, desk.y - 22, 26, 5, 1.5);
  keys.stroke({ width: 1, color: PALETTE.surfacePale, alpha: 0.35 });
  for (let kx = -9; kx <= 9; kx += 4.5) {
    keys.moveTo(desk.x + kx, desk.y - 21);
    keys.lineTo(desk.x + kx, desk.y - 18);
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
    c.position.set(desk.x + offX, desk.y + offY);
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
  const trimGlow = glow(desk.x, desk.y - 34, 52, accent, 0.16);
  root.addChild(trimGlow);
  // One status LED per console: role-colored, slow breathing, staggered by
  // desk so the ring's heartbeats desynchronize.
  const led = glow(desk.x + 26, desk.y - 14, 8, accent, 0.55);
  root.addChild(led);
  const ledDot = new Graphics();
  ledDot.circle(desk.x + 26, desk.y - 14, 1.7);
  ledDot.fill({ color: accent });
  root.addChild(ledDot);
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
// Uniswap liquidity pavilion
// ---------------------------------------------------------------------------

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

/** Fire-and-forget highlight on a prebuilt object: pop, then fade back to its
 * resting alpha. Reduced motion snaps to the peak and fades; no gestures. */
function blip(
  target: Container,
  ctx: DioramaContext,
  peak: number,
  rest: number,
  fade: number,
  delay = 0,
): void {
  gsap.killTweensOf(target);
  if (ctx.reducedMotion) {
    target.alpha = peak;
    gsap.to(target, { alpha: rest, duration: 0.3, ease: "none", delay });
    return;
  }
  gsap.fromTo(target, { alpha: peak }, { alpha: rest, duration: fade, ease: "power2.out", delay });
}

/**
 * Load a real brand mark onto its mount: the 400 px source shown small stays
 * crisp. On failure the venue still reads through trim, sign and caption; the
 * mark is never approximated procedurally.
 */
function mountLogo(url: string, mount: Container, size: number, ctx: DioramaContext): void {
  let disposed = false;
  ctx.onCleanup(() => {
    disposed = true;
  });
  void Assets.load<Texture>(url)
    .then((tex) => {
      if (disposed || mount.destroyed) return;
      const logo = new Sprite(tex);
      logo.anchor.set(0.5);
      logo.width = size;
      logo.height = size;
      mount.addChild(logo);
    })
    .catch(() => {
      // Venue reads via trim, sign and caption; no fallback mark.
    });
}

/** Pieces of the shared venue booth the per-venue builders decorate. */
interface VenueBooth {
  root: Container;
  /** Console screen container; readout content joins as world-coord children. */
  screen: Container;
}

/**
 * Shared open-top venue booth: branded base tile, a chevron back wall along
 * the north diamond edges (open top, open south face so the ring stays
 * walkable and the sightline to the mascot pad stays clear), a billboard
 * header board carrying the real logo plus its micro caption, and a wide
 * front console on the open side. Heights stay below the holo cone so the
 * market holo remains the floor's primary vertical.
 */
function buildVenueBooth(
  ctx: DioramaContext,
  def: StationDef,
  accent: number,
  caption: string,
  logoUrl: string,
): VenueBooth {
  const { x, y } = def.anchor;
  const root = stationRoot(ctx, def, y);

  // Grounding: contact shadow, branded rim tile, darker interior inset.
  const ao = new Graphics();
  ao.ellipse(x, y + 6, 58, 25);
  ao.fill({ color: PALETTE.space, alpha: 0.3 });
  root.addChild(ao);
  root.addChild(isoTile(x, y + 2, 116, 86, PALETTE.structure, 1, accent));
  root.addChild(isoTile(x, y + 3, 90, 64, PALETTE.space, 0.4));

  // Back wall: two low segments meeting at the north corner.
  for (const edge of [
    { x1: x - 56, y1: y + 1, x2: x, y2: y - 39 },
    { x1: x, y1: y - 39, x2: x + 56, y2: y + 1 },
  ]) {
    root.addChild(isoWall({ ...edge, h: 40, color: PALETTE.structure, alpha: 0.96, rim: accent }));
  }

  // Header board crowning the wall corner: real logo plus micro caption. The
  // halo rests faint so it never competes with the holo's crown.
  root.addChild(glow(x, y - 88, 64, accent, 0.1));
  const board = new Graphics();
  board.roundRect(x - 42, y - 115, 84, 54, 6);
  board.fill({ color: PALETTE.space, alpha: 0.72 });
  board.roundRect(x - 42, y - 115, 84, 54, 6);
  board.stroke({ width: 1.75, color: accent, alpha: 0.9 });
  board.roundRect(x - 40, y - 113, 80, 50, 5);
  board.stroke({ width: 0.75, color: PALETTE.ink, alpha: 0.16 });
  root.addChild(board);
  const logoMount = new Container();
  logoMount.position.set(x, y - 100);
  root.addChild(logoMount);
  mountLogo(logoUrl, logoMount, 30, ctx);
  const cap = microText(caption, 6, PALETTE.inkDim);
  cap.anchor.set(0.5);
  cap.position.set(x, y - 78);
  root.addChild(cap);

  // Front console on the open south side: the stand the venue hosts gather
  // around, facing the ring.
  root.addChild(isoBox({ x, y: y + 20, w: 96, d: 26, h: 13, color: PALETTE.structure }));
  root.addChild(edgeStrip(x - 48, y + 26.5, x, y + 33, accent, 0.85, 2));
  root.addChild(edgeStrip(x, y + 33, x + 48, y + 26.5, accent, 0.85, 2));
  const screen = screenPanel({ x: x - 26, y: y - 10, w: 52, h: 18, accent });
  root.addChild(screen);
  // Only the console trim breathes at idle; readouts stay static so story
  // pulses never fight an idle tween.
  const trimGlow = glow(x, y + 6, 66, accent, 0.16);
  root.addChild(trimGlow);
  if (!ctx.reducedMotion) {
    gsap.to(trimGlow, {
      alpha: 0.3,
      duration: 3.2,
      yoyo: true,
      repeat: -1,
      ease: "sine.inOut",
    });
    ctx.onCleanup(() => gsap.killTweensOf(trimGlow));
  }

  return { root, screen };
}

/**
 * Uniswap pavilion: liquidity research only. An AMM constant-product curve
 * pane with a marker sliding along it, two pool-depth bubble columns that
 * breathe slowly, and a two-line quote comparison readout; nothing here
 * routes toward execution. pulse() bounces the bubbles (pool) or slides the
 * marker and brightens the readout (quote).
 */
function buildUniswapVenue(ctx: DioramaContext): void {
  const def = STATIONS.uniswapVenue;
  const { x, y } = def.anchor;
  const { root, screen } = buildVenueBooth(
    ctx,
    def,
    UNISWAP_PINK,
    "LIQUIDITY RESEARCH",
    "/diorama/logos/uniswap.png",
  );

  // Pool-depth bubble columns: the former static gauge fills became columns
  // of slowly breathing bubbles; the flash halos rest dormant until a pulse.
  const gaugeFlashes: Sprite[] = [];
  const bubbleCols: Sprite[][] = [];
  const breathe = (b: Sprite, delay: number): void => {
    gsap.killTweensOf(b);
    b.alpha = 0.42;
    gsap.to(b, { alpha: 0.68, duration: 3.4, yoyo: true, repeat: -1, ease: "sine.inOut", delay });
  };
  for (const [i, gx] of [x - 33, x + 33].entries()) {
    const level = i === 0 ? 0.62 : 0.47;
    root.addChild(
      isoCylinder({
        x: gx,
        y: y - 12,
        r: 6,
        h: 26,
        color: PALETTE.structureLight,
        rim: UNISWAP_PINK,
      }),
    );
    // Depth ticks along each column keep the gauge reading.
    const marks = new Graphics();
    for (let t = 1; t <= 3; t++) {
      const ty = y - 12 - 6 * t;
      marks.moveTo(gx - 7.5, ty);
      marks.lineTo(gx - 5, ty);
      marks.stroke({ width: 1, color: PALETTE.inkDim, alpha: 0.5 });
    }
    root.addChild(marks);
    const col: Sprite[] = [];
    for (let b = 0; b < 3; b++) {
      const bubble = glow(
        gx,
        y - 12 - 24 * level * ((b + 0.8) / 3.1),
        9 - b * 1.6,
        UNISWAP_PINK,
        0.55,
      );
      col.push(bubble);
      root.addChild(bubble);
      if (!ctx.reducedMotion) breathe(bubble, i * 0.9 + b * 0.55);
    }
    bubbleCols.push(col);
    const flash = glow(gx, y - 22, 26, UNISWAP_PINK, 0);
    gaugeFlashes.push(flash);
    root.addChild(flash);
  }

  // AMM constant-product pane floating between the logo board and the
  // console: a soft x*y=k arc with a marker sliding along it.
  const amm = new Container();
  amm.position.set(x, y - 44);
  const ammW = 46;
  const ammH = 30;
  const ammG = new Graphics();
  ammG.roundRect(-ammW / 2, -ammH / 2, ammW, ammH, 4);
  ammG.fill({ color: PALETTE.space, alpha: 0.55 });
  ammG.roundRect(-ammW / 2, -ammH / 2, ammW, ammH, 4);
  ammG.stroke({ width: 1.2, color: UNISWAP_PINK, alpha: 0.7 });
  // Axis hints: price against reserve.
  ammG.moveTo(-ammW / 2 + 6, ammH / 2 - 5);
  ammG.lineTo(ammW / 2 - 5, ammH / 2 - 5);
  ammG.moveTo(-ammW / 2 + 6, ammH / 2 - 5);
  ammG.lineTo(-ammW / 2 + 6, -ammH / 2 + 5);
  ammG.stroke({ width: 1, color: PALETTE.inkDim, alpha: 0.4 });
  // The curve: parameter u in [0.35, 1] traces x*y=k (u the reserve share,
  // 1/u the price it implies), mapped into the pane.
  const curvePt = (t: number): { px: number; py: number } => {
    const u = 0.35 + t * 0.65;
    const ny = (1 / u - 1) / (1 / 0.35 - 1);
    return {
      px: -ammW / 2 + 6 + t * (ammW - 12),
      py: ammH / 2 - 5 - ny * (ammH - 11),
    };
  };
  for (let s = 0; s <= 16; s++) {
    const p = curvePt(s / 16);
    if (s === 0) ammG.moveTo(p.px, p.py);
    else ammG.lineTo(p.px, p.py);
  }
  ammG.stroke({ width: 1.5, color: UNISWAP_PINK, alpha: 0.85 });
  amm.addChild(ammG);
  const marker = glow(0, 0, 9, UNISWAP_PINK, 0.9);
  amm.addChild(marker);
  root.addChild(amm);
  const markerState = { t: 0.5 };
  const placeMarker = (): void => {
    const p = curvePt(markerState.t);
    marker.position.set(p.px, p.py);
  };
  placeMarker();
  // Ambient drift: the marker explores the curve on a slow yoyo. A quote
  // pulse interrupts it, slides to the next comparison point, then resumes.
  const driftMarker = (): void => {
    gsap.killTweensOf(markerState);
    gsap.to(markerState, {
      t: 0.82,
      duration: 5,
      yoyo: true,
      repeat: -1,
      ease: "sine.inOut",
      onUpdate: placeMarker,
    });
  };
  if (!ctx.reducedMotion) driftMarker();

  // Quote comparison readout: two compared quotes as real text, resting
  // slightly dim so a quote pulse can brighten them.
  const lineA = microText("A 1.0264", 6.5, PALETTE.ink);
  lineA.anchor.set(0, 0.5);
  lineA.position.set(x - 20, y - 4.5);
  const lineB = microText("B 1.0271", 6.5, PALETTE.inkDim);
  lineB.anchor.set(0, 0.5);
  lineB.position.set(x - 20, y + 3.5);
  lineA.alpha = 0.85;
  lineB.alpha = 0.85;
  screen.addChild(lineA, lineB);
  const quoteFlash = glow(x, y - 1, 46, UNISWAP_PINK, 0);
  root.addChild(quoteFlash);

  let quoteSteps = 0;
  const api: UniswapVenueApi = {
    pulse(kind) {
      if (kind === "pool") {
        gaugeFlashes.forEach((g, i) => blip(g, ctx, 0.85, 0, 0.8, i * 0.12));
        for (const col of bubbleCols) {
          for (const [bi, b] of col.entries()) {
            gsap.killTweensOf([b, b.scale]);
            b.scale.set(1);
            if (ctx.reducedMotion) {
              b.alpha = 0.85;
              gsap.to(b, { alpha: 0.55, duration: 0.4, ease: "power2.out" });
              continue;
            }
            gsap.to(b.scale, {
              x: 1.6,
              y: 1.6,
              duration: 0.24,
              yoyo: true,
              repeat: 1,
              ease: "power2.out",
              delay: bi * 0.07,
              onComplete: () => {
                b.scale.set(1);
                breathe(b, bi * 0.4);
              },
            });
          }
        }
        return;
      }
      blip(quoteFlash, ctx, 0.8, 0, 0.6);
      gsap.killTweensOf([lineA, lineB]);
      lineA.alpha = 1;
      lineB.alpha = 1;
      gsap.to([lineA, lineB], { alpha: 0.85, duration: 0.5, ease: "power2.out" });
      // Slide the marker to the next comparison point along the curve.
      const targetT = 0.3 + (quoteSteps++ % 3) * 0.25;
      if (ctx.reducedMotion) {
        markerState.t = targetT;
        placeMarker();
        return;
      }
      gsap.killTweensOf(markerState);
      gsap.to(markerState, {
        t: targetT,
        duration: 0.5,
        ease: "power2.out",
        onUpdate: placeMarker,
        onComplete: driftMarker,
      });
    },
  };
  registerApi(ctx, def.id, api);
  ctx.onCleanup(() => {
    gsap.killTweensOf([...gaugeFlashes, quoteFlash, lineA, lineB, markerState]);
    for (const col of bubbleCols) for (const b of col) gsap.killTweensOf([b, b.scale]);
  });
  addSign(ctx, def, x - 13, 536, UNISWAP_PINK);
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
