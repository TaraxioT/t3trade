/**
 * Central Trading Floor: a bot-free product floor. A tiered circular dais
 * carries five dual-screen console banks — the user's tools (Watchlist,
 * Chart, Trade, Positions, Alerts) — around the holographic mission chart
 * (the CHART hero), with the alerts tower (the ALERTS hero) wired in at the
 * north-east rim. The Hyperliquid testnet exchange booth
 * (world/hyperliquid.ts) docks at the floor's east seam and is built from
 * here. The cycle-3 agent desks, chairs, role panes, event clock, and
 * status mast are gone: their concepts moved to MISSION and the HUD
 * (freeze §1), and nothing on the dais anchors or invites population.
 *
 * Depth notes: the platform geometry (steps, medallion, ring lights) lives
 * in the ground layer, below every sortable fixture. The trading floor
 * registers a hit-only root that sorts below the nested holo root so the
 * interaction picker resolves inner stations to their own roots. Console
 * banks are unregistered scenery owned by the floor compound; they sort by
 * their own foot Y, which keeps them layered correctly against the holo.
 */
import { Container, Graphics, Sprite } from "pixi.js";
import gsap from "gsap";
import type { DioramaContext } from "../core/context.js";
import { PALETTE, rightFace, shade, topFace } from "../config/palette.js";
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
import { makeDetailText, makeSign } from "../core/signs.js";
import { getStation, registerStation } from "../core/registry.js";
import { buildExchangePort } from "../world/hyperliquid.js";

/** Overlay line values in chart space (0..1 across the candle range). */
export interface ChartOverlays {
  entry?: number;
  stop?: number;
  liq?: number;
}

export interface HoloCoreApi {
  /** Mirror a market event on the chart: order launch, fill landing, or state refresh. */
  marketEvent(kind: "order" | "fill" | "state"): void;
  /** Launch an order marker along the chart's order lane. */
  orderLaunched(): void;
  /** Land a fill flash on the chart's mark line. */
  fillLanded(): void;
  /** Show or clear the entry/stop/liquidation overlay lines (freeze §2). */
  setOverlays(o: ChartOverlays | null): void;
  /** Shift the quiet regime shading and label (absorbs the old landscape semantics). */
  setRegime(regime: string): void;
}

export interface SignalTowerApi {
  /** Emit a differentiated pulse: market, alert, wake, warning, execution. */
  pulse(kind: "market" | "alert" | "wake" | "warning" | "execution"): void;
  /** Light the matching watch feed row: armed, fired, or cancelled (freeze §2). */
  setWatch(state: "armed" | "fired" | "cancelled"): void;
}

/**
 * Floor-wide pause contract. The CONTROLS kiosk lives in the risk district;
 * sceneBindings calls this on pause/resume so the whole floor reads the
 * paused state at fit zoom.
 */
export interface TradingFloorApi {
  /** Pause or resume the floor: lights hold a dim steady state and a PAUSED
   * board appears on the platform while paused. */
  setCampusPaused(on: boolean): void;
}

const FLOOR = STATIONS.tradingFloor.anchor;
const RNG = seededRandom(0xc3e7411);
/** Floor district trim: one architectural language across banks and rails. */
const FLOOR_TRIM = DISTRICTS.floor.accent;

/** Uniform console scale: the dais is 540x390, so the console art scales
 * from its cycle-2 drawing units. */
const BANK_SCALE = 0.78;

/** One console bank: which user tool it represents and where it stands on
 * the dais (inside the platform ellipse, east walkway kept open toward the
 * exchange seam). Positions are scenery, never population anchors. */
type BankTool = "watchlist" | "chart" | "trade" | "positions" | "alerts";
const BANKS: { x: number; y: number; tool: BankTool; label: string }[] = [
  { x: 1235, y: 800, tool: "watchlist", label: "Watchlist" },
  { x: 1555, y: 745, tool: "chart", label: "Chart" },
  { x: 1640, y: 855, tool: "positions", label: "Positions" },
  { x: 1520, y: 975, tool: "trade", label: "Trade" },
  { x: 1345, y: 965, tool: "alerts", label: "Alerts" },
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
    makeSign(def.label, {
      x,
      y,
      size: def.signSize,
      accent: accent ?? PALETTE.cyan,
      lod: def.lod,
      stationId: def.id,
    }),
  );
}

/** Attach an api post-registration (helper for split builds). */
function registerApi(_ctx: DioramaContext, id: StationId, api: object): void {
  const handle = getStation(id);
  if (handle) handle.api = api;
}

export function buildCentralDistrict(ctx: DioramaContext): void {
  buildTradingFloor(ctx);
  buildHoloCore(ctx);
  buildSignalTower(ctx);
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
  // Reset first so a failed rebuild never leaves pause state driving objects
  // from a destroyed world.
  const pausables: { obj: Container | Sprite; base: number }[] = [];
  let campusPaused = false;

  // Platform geometry goes to the ground layer, below every sortable fixture,
  // so banks keep sorting against the holo by foot Y.
  const platform = new Container();
  ctx.layers.ground.addChild(platform);

  // Raised plinth: two low steps under a circular top platform, with a soft
  // ground shadow and strongly shaded side faces so the step faces read.
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
  platform.addChild(plinth);

  // Central medallion: a gold inlay ring outside the cyan infrastructure band
  // and four faint spokes bridging them. Static ornament, kept calm.
  const GOLD = DISTRICTS.floor.accent2;
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

  // Emissive floor pool + inset ring lights in one dimmable group: the holo's
  // screens cast soft light onto the platform, and pausing dims the group.
  const lights = new Container();
  const holoPool = glow(FLOOR.x, FLOOR.y - 40, 270, PALETTE.cyan, 0.13);
  holoPool.scale.y *= 0.42;
  lights.addChild(holoPool);
  const ringLights = new Graphics();
  ringLights.ellipse(FLOOR.x, FLOOR.y, 254, 144);
  ringLights.stroke({ width: 2, color: PALETTE.cyan, alpha: 0.5 });
  ringLights.ellipse(FLOOR.x, FLOOR.y, 248, 139);
  ringLights.stroke({ width: 1, color: PALETTE.cyan, alpha: 0.2 });
  lights.addChild(ringLights);
  platform.addChild(lights);
  pausables.push({ obj: lights, base: 1 });

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

  // Tower conduit: a dotted floor trace from the platform rim to the alert
  // tower base, so the tower reads as wired into the floor. Static dots only;
  // ambient motion lives in the director's heartbeats, not here.
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

  // The five user-tool console banks. No chairs, no role colors, no panes:
  // they are tools on a platform, not workplaces.
  for (const bank of BANKS) buildBank(ctx, bank, pausables);

  // Paused overlay: a registered warning board that only exists while the
  // campus is paused. The signs policy owns its alpha ("always" tier rule);
  // this api owns its visibility, so the two never fight.
  const pausedBoard = makeSign("PAUSED", {
    x: FLOOR.x,
    y: FLOOR.y + 98,
    size: "sm",
    accent: PALETTE.warning,
    halo: false,
    lod: "always",
    stationId: def.id,
  });
  pausedBoard.visible = false;
  ctx.layers.labels.addChild(pausedBoard);

  // Floor pause, seen from the ring: lights and console glows hold a dim
  // steady state so the freeze reads at fit zoom. Resume needs no state
  // repair; the base alphas are restored verbatim.
  const dimFloor = (on: boolean): void => {
    for (const { obj, base } of pausables) obj.alpha = on ? base * 0.22 : base;
  };

  const api: TradingFloorApi = {
    setCampusPaused(on: boolean): void {
      if (on === campusPaused) return;
      campusPaused = on;
      pausedBoard.visible = on;
      dimFloor(on);
    },
  };
  registerApi(ctx, def.id, api);

  // The registry label "TRADING FLOOR" is a zoom-class board: never at tier 0,
  // visible from tier 1 and whenever the floor compound is focused.
  addSign(ctx, def, FLOOR.x, FLOOR.y + 196, FLOOR_TRIM);
}

/** Tool glyph inside a console screen, one per bank so the five tools read at
 * a glance: asset rows, candles, an order ticket, protected position rows,
 * and a bell. Glyph colors stay in the floor's blue/cyan language; the buy,
 * sell, and protection pips reuse reserved semantic colors deliberately. */
function toolGlyph(tool: BankTool): Graphics {
  const g = new Graphics();
  const accent = PALETTE.cyan;
  if (tool === "watchlist") {
    for (let i = 0; i < 3; i++) {
      const ry = -5 + i * 5;
      g.rect(-9, ry - 1.7, 3.4, 3.4);
      g.fill({ color: accent, alpha: 0.9 });
      g.moveTo(-3.5, ry);
      g.lineTo(9 - i * 2.5, ry);
      g.stroke({ width: 1, color: accent, alpha: 0.6 });
    }
    return g;
  }
  if (tool === "chart") {
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
  if (tool === "trade") {
    // Buy and sell pills over a size line, in the same up/down language as
    // the chart candles.
    g.roundRect(-9, -6.5, 7, 5, 2);
    g.fill({ color: PALETTE.healthy, alpha: 0.9 });
    g.roundRect(-9, 1.5, 7, 5, 2);
    g.fill({ color: PALETTE.blocked, alpha: 0.9 });
    g.moveTo(1, -4);
    g.lineTo(9, -4);
    g.moveTo(1, 0);
    g.lineTo(9, 0);
    g.moveTo(1, 4);
    g.lineTo(6, 4);
    g.stroke({ width: 1, color: accent, alpha: 0.6 });
    return g;
  }
  if (tool === "positions") {
    // Position rows fronted by protection shield pips.
    for (let i = 0; i < 2; i++) {
      const ry = -3 + i * 6.5;
      g.moveTo(-8, ry - 2.6);
      g.lineTo(-5.4, ry);
      g.lineTo(-8, ry + 1.2);
      g.lineTo(-10.6, ry);
      g.closePath();
      g.fill({ color: PALETTE.healthy, alpha: 0.95 });
      g.moveTo(-2.5, ry - 0.5);
      g.lineTo(9, ry - 0.5);
      g.stroke({ width: 1, color: accent, alpha: 0.6 });
    }
    return g;
  }
  // alerts: a bell.
  g.arc(0, -0.5, 5.5, Math.PI, 0);
  g.moveTo(-5.5, -0.5);
  g.lineTo(5.5, -0.5);
  g.stroke({ width: 1.4, color: accent, alpha: 0.9 });
  g.moveTo(-6.8, -0.5);
  g.lineTo(6.8, -0.5);
  g.stroke({ width: 1, color: accent, alpha: 0.5 });
  g.circle(0, 3.4, 1.4);
  g.fill({ color: accent, alpha: 0.95 });
  return g;
}

/** One console bank: wide console with floor-blue trim, a keyboard strip, two
 * angled screens carrying the tool glyph and a faint secondary trace, one
 * static status LED, and a registered detail text with the product string.
 * Drawn in local units around (0, 0) and scaled by BANK_SCALE at the root. */
function buildBank(
  ctx: DioramaContext,
  bank: { x: number; y: number; tool: BankTool; label: string },
  pausables: { obj: Container | Sprite; base: number }[],
): void {
  const root = new Container();
  root.position.set(bank.x, bank.y);
  root.zIndex = bank.y;
  root.scale.set(BANK_SCALE);
  ctx.layers.sortable.addChild(root);

  // Soft contact shadow under the console.
  const ao = new Graphics();
  ao.ellipse(0, 5, 42, 16);
  ao.fill({ color: PALETTE.space, alpha: 0.3 });
  root.addChild(ao);

  root.addChild(isoBox({ x: 0, y: 0, w: 60, d: 34, h: 18, color: PALETTE.structure }));
  // Floor trim across the console's front (south) edges.
  root.addChild(edgeStrip(-30, 8.5, 0, 17, FLOOR_TRIM, 0.8, 2));
  root.addChild(edgeStrip(0, 17, 30, 8.5, FLOOR_TRIM, 0.8, 2));

  // Keyboard strip on the console's top face, between the front edge and the
  // screens.
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

  // Dual angled screens: the tool glyph on the left panel, a faint generic
  // trace on the right, both under one container so the pause dim treats
  // them as one console.
  const mkScreen = (offX: number, offY: number, rot: number, glyph?: Graphics): Container => {
    const c = new Container();
    c.position.set(offX, offY);
    c.rotation = rot;
    c.addChild(screenPanel({ x: -12, y: -8, w: 24, h: 16, accent: PALETTE.cyan }));
    if (glyph) c.addChild(glyph);
    else {
      const trace = new Graphics();
      trace.moveTo(-9, 2);
      trace.lineTo(-3, -3);
      trace.lineTo(2, 0);
      trace.lineTo(9, -5);
      trace.stroke({ width: 1.2, color: PALETTE.cyan, alpha: 0.5 });
      c.addChild(trace);
    }
    return c;
  };
  const screens = new Container();
  screens.addChild(mkScreen(-13, -37, -0.09, toolGlyph(bank.tool)), mkScreen(13, -40, 0.07));
  root.addChild(screens);
  pausables.push({ obj: screens, base: 1 });

  // One status LED per console: static, so the floor stays calm between the
  // director's beats.
  const led = glow(26, -14, 8, FLOOR_TRIM, 0.5);
  root.addChild(led);
  const ledDot = new Graphics();
  ledDot.circle(26, -14, 1.7);
  ledDot.fill({ color: FLOOR_TRIM });
  root.addChild(ledDot);
  pausables.push({ obj: led, base: 0.5 });

  // Soft trim glow above the console.
  const trimGlow = glow(0, -34, 52, FLOOR_TRIM, 0.16);
  root.addChild(trimGlow);
  pausables.push({ obj: trimGlow, base: 0.16 });

  // Registered product string for the tool this bank represents: detail tier,
  // so it reveals at tier 2 and when the floor compound is focused.
  ctx.layers.labels.addChild(
    makeDetailText(bank.label, {
      x: bank.x,
      y: bank.y - 47,
      stationId: STATIONS.tradingFloor.id,
      size: 10,
    }),
  );
}

// ---------------------------------------------------------------------------
// Holographic mission chart
// ---------------------------------------------------------------------------

function buildHoloCore(ctx: DioramaContext): void {
  const def = STATIONS.holoCore;
  const { x, y } = def.anchor;
  const root = stationRoot(ctx, def, y);

  // Soft AO + projection dais + emitter ring carrying the hologram. The dais
  // is two low tiered steps, so the floor's primary fixture grounds
  // deliberately and visibly owns the center of the platform.
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
  const cone = lightBeam(x, y - 12, 120, 34, 118, PALETTE.cyan, 0.38);
  root.addChild(cone);

  // Volumetric shafts: three soft additive beams rising from the emitter ring
  // past the content stack. Static alphas; per-frame work stays with the
  // simulated feed tick below.
  const shafts = new Container();
  shafts.position.set(x, y - 4);
  for (const s of [
    { dx: -12, topW: 30, botW: 10, h: 128, rot: -0.055, alpha: 0.09 },
    { dx: 0, topW: 38, botW: 14, h: 150, rot: 0, alpha: 0.12 },
    { dx: 12, topW: 30, botW: 10, h: 128, rot: 0.055, alpha: 0.09 },
  ] as const) {
    const beam = lightBeam(s.dx, 0, s.topW, s.botW, s.h, PALETTE.cyan, s.alpha);
    beam.rotation = s.rot;
    shafts.addChild(beam);
  }
  root.addChild(shafts);

  // Floating chart stack: billboard, gently bobbing (6 s).
  const stack = new Container();
  stack.scale.set(1.5);
  stack.position.set(x, y - 88);
  root.addChild(stack);

  // Chart panel frame.
  const panel = new Graphics();
  panel.roundRect(-64, -46, 128, 80, 5);
  panel.fill({ color: PALETTE.space, alpha: 0.6 });
  panel.roundRect(-64, -46, 128, 80, 5);
  panel.stroke({ width: 1, color: PALETTE.cyan, alpha: 0.45 });
  stack.addChild(panel);

  // Quiet regime shading strip along the panel's top edge. This absorbs the
  // deleted market landscape: a subtle hue and label shift, nothing more.
  const REGIME_HUES = [PALETTE.blue, PALETTE.violet, PALETTE.aqua, PALETTE.cyan];
  const regimeShade = new Graphics();
  stack.addChild(regimeShade);
  const regimeText = makeDetailText("", {
    x: 0,
    y: -38.5,
    stationId: def.id,
    size: 7.5,
    color: PALETTE.inkDim,
  });
  stack.addChild(regimeText);

  // Price ribbon: tiny candles; one new candle every ~4 s, then scroll.
  interface Candle {
    o: number;
    c: number;
    h: number;
    l: number;
  }
  const candleW = 8;
  const candleCount = 14;
  const ribbonTop = -28;
  const ribbonH = 32;
  const candles: Candle[] = [];
  let price = 0.5;
  const nextCandle = (): Candle => {
    const o = price;
    price = Math.max(0.15, Math.min(0.85, price + (RNG() - 0.5) * 0.3));
    const c = price;
    return { o, c, h: Math.max(o, c) + RNG() * 0.12, l: Math.min(o, c) - RNG() * 0.12 };
  };
  for (let i = 0; i < candleCount; i++) candles.push(nextCandle());
  const yOf = (v: number): number => ribbonTop + 4 + ribbonH - v * ribbonH;
  const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

  // Ribbon front plus a dimmer depth twin offset behind it, so the price
  // ribbon reads as a volumetric slab. One draw routine refreshes both.
  const ribbonDepth = new Graphics();
  ribbonDepth.position.set(5, 4);
  const ribbon = new Graphics();
  const drawRibbonInto = (g: Graphics, dim: boolean): void => {
    const dataA = dim ? 0.35 : 1;
    g.clear();
    const yOfLocal = yOf;
    candles.forEach((k, idx) => {
      const cx = -58 + idx * candleW + candleW / 2;
      const up = k.c >= k.o;
      const col = up ? PALETTE.healthy : PALETTE.blocked;
      g.moveTo(cx, yOfLocal(Math.min(1, k.h)));
      g.lineTo(cx, yOfLocal(Math.max(0, k.l)));
      g.stroke({ width: 1.5, color: col, alpha: 0.95 * dataA });
      const top = yOfLocal(Math.max(k.o, k.c));
      const bot = yOfLocal(Math.min(k.o, k.c));
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

  // Mark line: the current price level across the chart, with a glow dot on
  // the live candle. Redrawn whenever the feed advances.
  const markLine = new Graphics();
  stack.addChild(markLine);
  const lastX = -58 + (candleCount - 1) * candleW + candleW / 2;
  const lastGlow = glow(lastX, yOf(0.5), 10, PALETTE.cyan, 0.7);
  stack.addChild(lastGlow);
  const drawMark = (): void => {
    const last = candles[candleCount - 1];
    const mid = yOf((last.o + last.c) / 2);
    markLine.clear();
    markLine.moveTo(-60, mid);
    markLine.lineTo(60, mid);
    markLine.stroke({ width: 1, color: PALETTE.cyan, alpha: 0.5 });
    lastGlow.position.set(lastX, mid);
  };
  drawMark();

  // Entry / stop / liquidation overlays: dashed horizontal lines with
  // distinct dash rhythms plus a color, so state never rides on hue alone.
  const OVERLAY_SPECS = [
    { key: "entry", color: PALETTE.blue, dash: 6, gap: 3 },
    { key: "stop", color: PALETTE.warning, dash: 3, gap: 3 },
    { key: "liq", color: PALETTE.blocked, dash: 1.5, gap: 2.5 },
  ] as const;
  type OverlayKey = (typeof OVERLAY_SPECS)[number]["key"];
  const overlayValues: Record<OverlayKey, number | undefined> = {
    entry: undefined,
    stop: undefined,
    liq: undefined,
  };
  const overlayGs: Record<OverlayKey, Graphics> = {
    entry: new Graphics(),
    stop: new Graphics(),
    liq: new Graphics(),
  };
  const overlays = new Container();
  for (const spec of OVERLAY_SPECS) overlays.addChild(overlayGs[spec.key]);
  overlays.visible = false;
  stack.addChild(overlays);
  const drawOverlay = (key: OverlayKey): void => {
    const g = overlayGs[key];
    const spec = OVERLAY_SPECS.find((s) => s.key === key);
    g.clear();
    const v = overlayValues[key];
    if (v === undefined || !spec) return;
    const yy = yOf(clamp01(v));
    for (let px = -60; px < 60; px += spec.dash + spec.gap) {
      g.moveTo(px, yy);
      g.lineTo(Math.min(60, px + spec.dash), yy);
    }
    g.stroke({ width: 1.5, color: spec.color, alpha: 0.9 });
    g.rect(61, yy - 1.5, 3, 3);
    g.fill({ color: spec.color, alpha: 0.95 });
  };

  // Order lane under the chart: the baseline the order marker travels.
  const lane = new Graphics();
  lane.moveTo(-58, 22);
  lane.lineTo(58, 22);
  lane.stroke({ width: 1, color: PALETTE.surfacePale, alpha: 0.18 });
  stack.addChild(lane);
  const orderFlash = glow(-58, 22, 18, DISTRICTS.floor.accent2, 0);
  const marker = glow(-58, 22, 12, DISTRICTS.floor.accent2, 0);
  marker.visible = false;
  stack.addChild(orderFlash, marker);

  // Fill feedback: a healthy pulse ring + flash that lands on the mark.
  const fillRing = new Graphics();
  fillRing.ellipse(0, 0, 12, 5);
  fillRing.stroke({ width: 1.5, color: PALETTE.healthy, alpha: 0.9 });
  fillRing.alpha = 0;
  stack.addChild(fillRing);
  const fillFlash = glow(lastX, yOf(0.5), 16, PALETTE.healthy, 0);
  stack.addChild(fillFlash);

  // Honesty disclosure, registered: the feed is simulated.
  stack.addChild(makeDetailText("Simulated feed", { x: 0, y: 31, stationId: def.id, size: 8 }));

  if (!ctx.reducedMotion) {
    let candleClock = 0;
    let last = performance.now();
    ctx.onTick(() => {
      const now = performance.now();
      candleClock += (now - last) / 1000;
      last = now;
      stack.y = y - 88 + Math.sin((now / 1000) * Math.PI * 2 * (1 / 6)) * 4;
      if (candleClock >= 4) {
        candleClock = 0;
        candles.shift();
        candles.push(nextCandle());
        drawRibbon();
        drawMark();
      }
    });
  } else {
    lastGlow.visible = false;
  }

  // --- Story API ---
  const launchOrder = (): void => {
    if (ctx.reducedMotion) {
      marker.visible = true;
      marker.alpha = 0.9;
      marker.position.set(lastX, 22);
      return;
    }
    gsap.killTweensOf(marker);
    marker.visible = true;
    gsap.fromTo(
      marker,
      { x: -58, y: 22, alpha: 0.95 },
      {
        x: lastX,
        duration: 0.55,
        ease: "power2.out",
        onComplete: () => {
          gsap.to(marker, { alpha: 0, duration: 1.6, delay: 0.8 });
        },
      },
    );
    gsap.killTweensOf(orderFlash);
    gsap.fromTo(orderFlash, { alpha: 0.8 }, { alpha: 0, duration: 0.5 });
  };

  const landFill = (): void => {
    const last = candles[candleCount - 1];
    const mid = yOf((last.o + last.c) / 2);
    fillRing.position.set(lastX, mid);
    fillFlash.position.set(lastX, mid);
    if (ctx.reducedMotion) {
      fillFlash.alpha = 0.7;
      fillRing.alpha = 0.6;
      return;
    }
    gsap.killTweensOf(fillFlash);
    gsap.fromTo(fillFlash, { alpha: 0.85 }, { alpha: 0, duration: 0.9, ease: "power2.out" });
    gsap.killTweensOf([fillRing, fillRing.scale]);
    fillRing.scale.set(0.6);
    gsap.to(fillRing.scale, { x: 1.6, y: 1.6, duration: 0.7, ease: "power2.out" });
    gsap.fromTo(fillRing, { alpha: 0.8 }, { alpha: 0, duration: 0.7 });
  };

  const refreshState = (): void => {
    candles.shift();
    candles.push(nextCandle());
    drawRibbon();
    drawMark();
    if (ctx.reducedMotion) return;
    gsap.killTweensOf(ribbon);
    gsap.fromTo(ribbon, { alpha: 0.4 }, { alpha: 1, duration: 0.5, ease: "power2.out" });
  };

  const api: HoloCoreApi = {
    marketEvent(kind) {
      if (kind === "order") launchOrder();
      else if (kind === "fill") landFill();
      else refreshState();
    },
    orderLaunched() {
      launchOrder();
    },
    fillLanded() {
      landFill();
    },
    setOverlays(o) {
      overlayValues.entry = o?.entry;
      overlayValues.stop = o?.stop;
      overlayValues.liq = o?.liq;
      for (const spec of OVERLAY_SPECS) drawOverlay(spec.key);
      overlays.visible = OVERLAY_SPECS.some((s) => overlayValues[s.key] !== undefined);
    },
    setRegime(regime) {
      // Quiet hue pick from the label: same label, same shade. The regime is
      // context, not a market claim, so it never animates.
      let hash = 0;
      for (let i = 0; i < regime.length; i++) hash = (hash * 31 + regime.charCodeAt(i)) >>> 0;
      regimeShade.clear();
      regimeShade.roundRect(-60, -43, 120, 9, 2.5);
      regimeShade.fill({ color: REGIME_HUES[hash % REGIME_HUES.length], alpha: 0.3 });
      regimeText.text = regime;
    },
  };
  registerApi(ctx, def.id, api);

  ctx.onCleanup(() => {
    gsap.killTweensOf([marker, orderFlash, fillRing, fillRing.scale, fillFlash, ribbon]);
  });

  addSign(ctx, def, x, y - 176);
}

// ---------------------------------------------------------------------------
// Alerts tower
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

  // Watch feed console east of the mast: the ALERTS rows with per-state
  // indicator dots. Rows are registered detail text; the console holds the
  // dots and never duplicates the words in graphics.
  const panelX = x + 40;
  const panelY = y + 6;
  root.addChild(
    isoBox({
      x: panelX,
      y: panelY,
      w: 46,
      d: 14,
      h: 10,
      color: PALETTE.structure,
      rim: FLOOR_TRIM,
    }),
  );
  root.addChild(screenPanel({ x: panelX - 25, y: panelY - 46, w: 50, h: 42, accent: FLOOR_TRIM }));
  const WATCH_ROWS = ["armed", "fired", "cancelled"] as const;
  type WatchState = (typeof WATCH_ROWS)[number];
  const WATCH_COLORS: Record<WatchState, number> = {
    armed: PALETTE.cyan,
    fired: PALETTE.warning,
    cancelled: PALETTE.inkDim,
  };
  for (const [i, row] of WATCH_ROWS.entries()) {
    const word = row.charAt(0).toUpperCase() + row.slice(1);
    root.addChild(
      makeDetailText(word, {
        x: panelX - 8,
        y: panelY - 37 + i * 10,
        stationId: def.id,
        size: 7.5,
        align: "left",
      }),
    );
  }
  const watchDots = new Graphics();
  root.addChild(watchDots);
  const drawWatchDots = (active: WatchState): void => {
    watchDots.clear();
    for (const [i, row] of WATCH_ROWS.entries()) {
      const on = row === active;
      watchDots.circle(panelX - 19, panelY - 37 + i * 10, on ? 2.4 : 1.5);
      watchDots.fill({ color: WATCH_COLORS[row], alpha: on ? 1 : 0.3 });
    }
  };
  drawWatchDots("armed");

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
    setWatch(state) {
      drawWatchDots(state);
      if (ctx.reducedMotion) {
        for (const e of emitters) e.tint = WATCH_COLORS[state];
        return;
      }
      flashMast(WATCH_COLORS[state], 1);
    },
  };

  ctx.onCleanup(() => {
    gsap.killTweensOf([...ringPool, ...emitters, beacon]);
  });

  registerApi(ctx, def.id, api);
  addSign(ctx, def, x, y + 46);
}
