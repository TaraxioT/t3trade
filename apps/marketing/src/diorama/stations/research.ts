/**
 * Research & Strategy district: mission board, market data, research tools,
 * strategy lab, sandbox, budget planning, decision table.
 * Owner: research district worker.
 *
 * Busy, creative, experimental energy: open-top structures, screens, holo
 * projections, and visible test loops. All statics are built once; ambient
 * motion runs through a single shared onTick registration with per-station
 * phase offsets, and GSAP only for the brief phase-flip and proposal
 * highlight transitions.
 */
import { Container, Graphics, Sprite } from "pixi.js";
import gsap from "gsap";
import type { DioramaContext } from "../core/context.js";
import { registerStation } from "../core/registry.js";
import { STATIONS } from "../config/stations.js";
import { PALETTE } from "../config/palette.js";
import { seededRandom, DEPTH } from "../config/world.js";
import { dotTexture, glow, isoBox, isoCylinder, isoTile, isoWall, screenPanel, lightBeam } from "../core/iso.js";
import { makeSign } from "../core/signs.js";

export interface DecisionTableApi {
  /** Show N proposal cards, highlight index, retract the rest. */
  showProposals(count: number, chosenIndex: number): void;
  clearProposals(): void;
}

export interface MissionBoardApi {
  setPhase(phase: string): void;
}

type StationRoot = Container & { hit: Container };

/** Shared scaffolding: root at anchor depth, hit area, sign above structure. */
function stationBase(
  ctx: DioramaContext,
  id: keyof typeof STATIONS,
  structureHeight: number,
  opts: { signDx?: number } = {},
): StationRoot {
  const def = STATIONS[id];
  const root = new Container() as StationRoot;
  root.position.set(def.anchor.x, def.anchor.y);
  root.zIndex = def.anchor.y + DEPTH.base;
  ctx.layers.sortable.addChild(root);

  // Hit surface: flat diamond covering the footprint, kept invisible.
  const hit = new Container();
  const hitG = new Graphics();
  const hw = def.size.w / 2;
  const hd = def.size.d / 2;
  hitG.poly([-hw, 0, 0, hd, hw, 0, 0, -hd]);
  hitG.fill({ color: 0xffffff, alpha: 0 });
  hit.addChild(hitG);
  hit.eventMode = "static";
  hit.cursor = "pointer";
  root.addChild(hit);
  root.hit = hit;

  const sign = makeSign(def.label, {
    x: def.anchor.x + (opts.signDx ?? 0),
    y: def.anchor.y - (structureHeight + 26),
    size: def.signSize,
    accent: PALETTE.cyan,
  });
  sign.zIndex = def.anchor.y + DEPTH.overlay;
  ctx.layers.labels.addChild(sign);

  return root;
}

/** Status light paired with a shape cue: pulsing ring + blinking inner dot. */
function statusLight(x: number, y: number, color: number, ctx: DioramaContext, phase: number): Container {
  const c = new Container();
  c.position.set(x, y);
  const ring = new Graphics();
  ring.circle(0, 0, 5);
  ring.stroke({ width: 1.5, color, alpha: 0.9 });
  const dot = new Sprite(dotTexture());
  dot.anchor.set(0.5);
  dot.width = 7;
  dot.height = 7;
  dot.tint = color;
  c.addChild(ring, dot);
  const off = ctx.onTick(() => {
    const s = (performance.now() / 1000 + phase) % 2;
    ring.scale.set(1 + 0.25 * Math.sin(s * Math.PI));
    ring.alpha = 0.55 + 0.35 * Math.sin(s * Math.PI);
    dot.alpha = s % 1 < 0.7 ? 1 : 0.25;
  });
  ctx.onCleanup(off);
  return c;
}

/** Slow sine breathing helper for ambient loops. */
const breathe = (t: number, period: number, phase: number): number =>
  Math.sin(((t + phase) / period) * Math.PI * 2);

/**
 * Soft dark ground ellipse added right after the hit surface so each
 * structure sits on the platform instead of floating over it. Coordinates
 * are root-local (research roots are positioned at their anchor).
 */
function contactShadow(root: Container, x: number, y: number, w: number, d: number, alpha = 0.27): void {
  const g = new Graphics();
  g.ellipse(x, y, w / 2, d / 2);
  g.fill({ color: 0x03080f, alpha });
  root.addChild(g);
}

// ---------------------------------------------------------------------------
// Mission Board: wide angled billboard on two posts.
// ---------------------------------------------------------------------------

/** Real mission statuses (packages/trading-contracts/src/mission.ts). */
const MISSION_PHASES = ["WAITING", "ANALYSING", "EXECUTING", "HOLDING"];

function buildMissionBoard(ctx: DioramaContext): void {
  const root = stationBase(ctx, "missionBoard", 78);
  const { accent } = { accent: PALETTE.cyan };

  contactShadow(root, 0, 10, 200, 66);
  // Dead-space fill: a small crate pair tucked under the board's east end.
  root.addChild(isoBox({ x: 74, y: 14, w: 14, d: 9, h: 8, color: PALETTE.structure, rim: accent, rimAlpha: 0.3 }));

  // Two posts.
  for (const px of [-70, 70]) {
    root.addChild(isoCylinder({ x: px, y: 8, r: 6, h: 46, color: PALETTE.structure, rim: accent }));
  }

  // Angled board: dark screen slab tilted toward camera, trim lit.
  const board = screenPanel({ x: -95, y: -74, w: 190, h: 52, accent });
  root.addChild(board);
  // Slight iso underside to seat the billboard on the posts.
  root.addChild(isoBox({ x: 0, y: -18, w: 196, d: 22, h: 8, color: PALETTE.structure, rim: accent, rimAlpha: 0.5 }));

  // Mission card: pale backing, goal line, market glyph, gold progress bar.
  // Backing stays bright so the machinery reads at fit zoom.
  const card = new Container();
  const cardG = new Graphics();
  cardG.roundRect(-86, -68, 130, 40, 4);
  cardG.fill({ color: PALETTE.surfacePale, alpha: 0.16 });
  cardG.roundRect(-86, -68, 130, 40, 4);
  cardG.stroke({ width: 1, color: PALETTE.inkDim, alpha: 0.55 });
  cardG.rect(-80, -42, 92, 4);
  cardG.fill({ color: PALETTE.yellow, alpha: 0.9 });
  cardG.rect(-80, -42, 58, 4);
  cardG.fill({ color: PALETTE.space, alpha: 0.9 });
  // Tiny market glyph: rising tick steps.
  cardG.moveTo(52, -62);
  cardG.lineTo(58, -68);
  cardG.lineTo(62, -64);
  cardG.lineTo(68, -72);
  cardG.stroke({ width: 2, color: PALETTE.orange });
  card.addChild(cardG);
  board.addChild(card);

  // District heartbeat: warm ticker line under the goal bar advances and
  // wraps on a ~9 s cycle (drawn once; only x is animated).
  const ticker = new Graphics();
  ticker.roundRect(-80, -46, 26, 2, 1);
  ticker.fill({ color: PALETTE.orange, alpha: 0.95 });
  board.addChild(ticker);
  const tickerOff = ctx.onTick(() => {
    if (ctx.reducedMotion) return;
    const t = (performance.now() / 1000) % 9 / 9;
    ticker.x = t * 66;
    ticker.alpha = 0.55 + 0.4 * Math.sin(t * Math.PI);
  });
  ctx.onCleanup(tickerOff);

  // Phase chips row (animated). Big chip + smaller followers.
  const chips: Container[] = [];
  const chipLayer = new Container();
  chipLayer.position.set(48, -30);
  board.addChild(chipLayer);
  MISSION_PHASES.forEach((_, i) => {
    const chip = new Container();
    const g = new Graphics();
    g.roundRect(-10, -5, 20, 10, 2);
    g.fill({ color: i === 0 ? PALETTE.cyan : PALETTE.structureLight, alpha: i === 0 ? 0.95 : 0.7 });
    chip.addChild(g);
    chip.position.set(i * 13, i === 0 ? -4 : 0);
    chip.scale.set(i === 0 ? 1.2 : 0.8);
    chipLayer.addChild(chip);
    chips.push(chip);
  });

  // Alert dot row + wake schedule strip (tiny clock faces).
  const extras = new Graphics();
  for (let i = 0; i < 3; i++) {
    extras.circle(-78 + i * 10, -14, 2.5);
    extras.fill({ color: i === 1 ? PALETTE.warning : PALETTE.waiting, alpha: 0.9 });
  }
  for (let i = 0; i < 4; i++) {
    const cx = 30 + i * 12;
    extras.circle(cx, -14, 4);
    extras.stroke({ width: 1, color: PALETTE.inkDim, alpha: 0.8 });
    extras.moveTo(cx, -14);
    extras.lineTo(cx, -17);
    extras.moveTo(cx, -14);
    extras.lineTo(cx + 2, -13);
    extras.stroke({ width: 1, color: PALETTE.inkDim, alpha: 0.8 });
  }
  board.addChild(extras);

  root.addChild(statusLight(98, -78, PALETTE.healthy, ctx, 0.3));

  // Ambient: every ~7 s a phase chip slides and the row rotates.
  let active = 0;
  const off = ctx.onTick(() => {
    if (ctx.reducedMotion) return;
    const slot = Math.floor(performance.now() / 7000) % MISSION_PHASES.length;
    if (slot === active) return;
    active = slot;
    chips.forEach((chip, i) => {
      const on = i === active;
      gsap.fromTo(
        chip,
        { x: chip.x, y: chip.y - 6, alpha: 0.2 },
        {
          x: i * 13,
          y: on ? -4 : 0,
          alpha: on ? 1 : 0.65,
          scale: on ? 1.2 : 0.8,
          duration: 0.5,
          ease: "back.out(2)",
          overwrite: true,
        },
      );
      (chip.getChildAt(0) as Graphics).alpha = on ? 0.95 : 0.7;
    });
  });
  ctx.onCleanup(off);

  const api: MissionBoardApi = {
    setPhase(phase: string): void {
      // Normalize case so stories may pass "Waiting" or "WAITING".
      const idx = Math.max(0, MISSION_PHASES.indexOf(phase.trim().toUpperCase()));
      const chip = chips[idx];
      if (!chip) return;
      gsap.timeline()
        .to(chip.scale, { x: 1.7, y: 1.7, duration: 0.22, ease: "power2.out" })
        .to(chip.scale, { x: 1.2, y: 1.2, duration: 0.3, ease: "elastic.out(1, 0.5)" });
      gsap.fromTo(chip, { alpha: 0.1 }, { alpha: 1, duration: 0.45, ease: "power1.inOut" });
    },
  };
  registerStation({ id: "missionBoard", root, hit: root.hit, api });
}

// ---------------------------------------------------------------------------
// Market Data: curved wall of 4 mini screens with a clear probe landing strip.
// ---------------------------------------------------------------------------

function buildMarketData(ctx: DioramaContext): void {
  const root = stationBase(ctx, "marketData", 64);

  contactShadow(root, 0, 26, 196, 56);
  // Curved wall base: a low arc of platform segments (billboarded curve).
  const base = isoBox({ x: 0, y: 20, w: 176, d: 40, h: 12, color: PALETTE.structure, rim: PALETTE.cyan, rimAlpha: 0.65 });
  root.addChild(base);

  // Landing strip decal on top for probes from the landscape.
  const strip = new Graphics();
  strip.moveTo(-70, 12);
  strip.lineTo(0, -4);
  strip.lineTo(70, 12);
  strip.stroke({ width: 2, color: PALETTE.waiting, alpha: 0.4 });
  root.addChild(strip);

  // 4 mini screens arranged along the curve (slight fan angles).
  const screens: Array<{ x: number; y: number; rot: number }> = [
    { x: -78, y: -40, rot: -0.12 },
    { x: -27, y: -46, rot: -0.04 },
    { x: 27, y: -46, rot: 0.04 },
    { x: 78, y: -40, rot: 0.12 },
  ];
  const candles: Graphics[] = [];
  const bookRows: Graphics[] = [];
  const funding: Graphics[] = [];
  const volBars: Graphics[] = [];

  screens.forEach((s, si) => {
    const panel = screenPanel({ x: -20, y: -22, w: 40, h: 30, accent: PALETTE.cyan });
    panel.position.set(s.x, s.y);
    panel.rotation = s.rot;
    root.addChild(panel);

    if (si === 0) {
      // Candlestick micro-chart.
      const g = new Graphics();
      drawCandles(g, [4, 7, 5]);
      panel.addChild(g);
      candles.push(g);
    } else if (si === 1) {
      // Order-book ladder rows.
      const g = new Graphics();
      for (let r = 0; r < 5; r++) {
        g.rect(-17, -17 + r * 6, 10 + ((r * 7) % 16), 3);
        g.fill({ color: r % 2 === 0 ? PALETTE.aqua : PALETTE.waiting, alpha: 0.55 });
      }
      panel.addChild(g);
      bookRows.push(g);
    } else if (si === 2) {
      // Funding dial: arc gauge that slowly drifts.
      const g = new Graphics();
      redrawFundingArc(g, 0);
      panel.addChild(g);
      funding.push(g);
    } else {
      // Volatility bars breathing.
      for (let b = 0; b < 4; b++) {
        const g = new Graphics();
        g.rect(-15 + b * 8, -4, 5, 8);
        g.fill({ color: PALETTE.magenta, alpha: 0.75 });
        panel.addChild(g);
        volBars.push(g);
      }
    }
  });

  root.addChild(statusLight(92, -52, PALETTE.healthy, ctx, 1.1));

  // Whip antenna on the curve's east end lifts the district skyline.
  const mast = new Graphics();
  mast.rect(80, -76, 2, 84);
  mast.fill({ color: PALETTE.structureLight });
  mast.rect(77, -76, 8, 1.4);
  mast.fill({ color: PALETTE.cyan, alpha: 0.7 });
  mast.circle(81, -79, 2.2);
  mast.fill({ color: PALETTE.cyan, alpha: 0.95 });
  root.addChild(mast);
  root.addChild(glow(81, -79, 12, PALETTE.cyan, 0.32));

  const candleData = [4, 7, 5];
  const off = ctx.onTick(() => {
    const t = performance.now() / 1000;
    if (!ctx.reducedMotion) {
      // Volatility bars breathe continuously.
      volBars.forEach((bar, i) => {
        const k = 0.6 + 0.5 * breathe(t, 5, i * 0.8);
        bar.scale.y = k;
        bar.pivot.set(0, 4);
      });
      // Funding dial drift redraw (tiny Graphics, ~1 Hz).
      const angle = Math.sin(t / 9) * 0.9;
      if (funding.length && Math.floor(t * 2) !== Math.floor((t - 0.016) * 2)) {
        redrawFundingArc(funding[0], angle);
      }
    }
  });
  ctx.onCleanup(off);

  // Every ~4 s nudge the last 3 candles (rare redraw, brief transition).
  const candleTimer = window.setInterval(
    () => {
      if (ctx.reducedMotion) return;
      for (let i = 0; i < 3; i++) {
        candleData[i] = 3 + Math.round(Math.random() * 6);
      }
      if (candles[0]) drawCandles(candles[0], candleData);
      bookRows.forEach((g) => {
        g.alpha = 0.3;
        gsap.to(g, { alpha: 0.85, duration: 0.6, ease: "power1.inOut" });
      });
    },
    4000,
  );
  ctx.onCleanup(() => window.clearInterval(candleTimer));

  // District heartbeat: a refresh sweep crosses the screen wall every ~13 s,
  // as if all four feeds re-synced. One static line; only x animates.
  const sweep = new Graphics();
  sweep.rect(-1, -62, 2, 34);
  sweep.fill({ color: PALETTE.aqua, alpha: 0.4 });
  sweep.blendMode = "add";
  sweep.alpha = 0;
  root.addChild(sweep);
  if (!ctx.reducedMotion) {
    const sweepTl = gsap.timeline({ repeat: -1, repeatDelay: 11.8 });
    sweepTl
      .set(sweep, { x: -88 })
      .to(sweep, { alpha: 0.85, duration: 0.15 })
      .to(sweep, { x: 88, duration: 1.1, ease: "none" })
      .to(sweep, { alpha: 0, duration: 0.15 });
    ctx.onCleanup(() => sweepTl.kill());
  }
  registerStation({ id: "marketData", root, hit: root.hit });
}

function drawCandles(g: Graphics, heights: number[]): void {
  g.clear();
  heights.forEach((h, i) => {
    const cx = -13 + i * 9;
    const up = i === heights.length - 1 ? h >= 5 : i % 2 === 0;
    const color = up ? PALETTE.healthy : PALETTE.blocked;
    g.rect(cx - 2, -2 - h, 4, h);
    g.fill({ color, alpha: 0.9 });
    g.moveTo(cx, -4 - h);
    g.lineTo(cx, -1 - h - 3);
    g.moveTo(cx, -2);
    g.lineTo(cx, 1);
    g.stroke({ width: 1, color, alpha: 0.7 });
  });
}

function redrawFundingArc(g: Graphics, angle: number): void {
  g.clear();
  g.circle(0, -7, 9);
  g.stroke({ width: 1.5, color: PALETTE.structureLight, alpha: 0.9 });
  const tipX = Math.sin(angle) * 8;
  const tipY = -7 - Math.cos(angle) * 8;
  g.moveTo(0, -7);
  g.lineTo(tipX, tipY);
  g.stroke({ width: 2, color: PALETTE.orange, alpha: 0.9 });
  g.circle(0, -7, 1.6);
  g.fill({ color: PALETTE.orange });
}

// ---------------------------------------------------------------------------
// Research Tools: 3 open consoles with glyph icons, one with a scan line.
// ---------------------------------------------------------------------------

function buildResearchTools(ctx: DioramaContext): void {
  const root = stationBase(ctx, "researchTools", 52);

  contactShadow(root, 0, 10, 176, 62);

  const glyphFns: Array<(g: Graphics) => void> = [
    // News: pulse lines.
    (g) => {
      g.moveTo(-6, 4);
      g.lineTo(-2, 4);
      g.lineTo(0, -3);
      g.lineTo(2, 6);
      g.lineTo(4, 0);
      g.lineTo(6, 0);
      g.stroke({ width: 1.5, color: PALETTE.aqua, alpha: 0.95 });
    },
    // Token: hex outline.
    (g) => {
      for (let i = 0; i <= 6; i++) {
        const a = (Math.PI / 3) * i - Math.PI / 6;
        const px = Math.cos(a) * 6;
        const py = Math.sin(a) * 6;
        if (i === 0) g.moveTo(px, py);
        else g.lineTo(px, py);
      }
      g.stroke({ width: 1.5, color: PALETTE.violet, alpha: 0.95 });
    },
    // History: stacked sheets.
    (g) => {
      for (let i = 0; i < 3; i++) {
        g.roundRect(-6, -4 + i * 4, 12, 3, 1);
        g.fill({ color: PALETTE.blue, alpha: 0.5 + i * 0.2 });
      }
    },
  ];

  // Low desks along a shallow arc, each with a tilted screen and glyph.
  const seats = [
    { x: -62, y: 6 },
    { x: 0, y: -6 },
    { x: 62, y: 6 },
  ];
  const scanLine = new Graphics();
  scanLine.moveTo(-14, -12);
  scanLine.lineTo(14, -12);
  scanLine.stroke({ width: 1.5, color: PALETTE.cyan, alpha: 0.8 });
  scanLine.blendMode = "add";
  seats.forEach((seat, i) => {
    root.addChild(isoBox({ x: seat.x, y: seat.y, w: 52, d: 30, h: 10, color: PALETTE.structure, rim: PALETTE.cyan, rimAlpha: 0.4 }));
    const panel = screenPanel({ x: -16, y: -34, w: 32, h: 24, accent: PALETTE.cyan });
    panel.position.set(seat.x, seat.y - 12);
    panel.rotation = (i - 1) * 0.05;
    root.addChild(panel);
    const glyph = new Graphics();
    glyphFns[i](glyph);
    glyph.position.set(seat.x, seat.y - 24);
    root.addChild(glyph);
    if (i === 1) {
      panel.addChild(scanLine);
    }
  });

  root.addChild(statusLight(80, -30, PALETTE.healthy, ctx, 2.2));

  const off = ctx.onTick(() => {
    if (ctx.reducedMotion) return;
    const t = (performance.now() / 1000) % 5 / 5;
    scanLine.y = -10 + t * 16;
    scanLine.alpha = 0.25 + 0.6 * Math.sin(t * Math.PI);
  });
  ctx.onCleanup(off);
  registerStation({ id: "researchTools", root, hit: root.hit });
}

// ---------------------------------------------------------------------------
// Strategy Lab: light-table with rotating dial, violet card racks, holo diamond.
// ---------------------------------------------------------------------------

function buildStrategyLab(ctx: DioramaContext): void {
  const root = stationBase(ctx, "strategyLab", 66);

  contactShadow(root, 0, 6, 108, 68);
  // Central light-table: pale top, low body, warm orange inlay strip.
  root.addChild(isoBox({ x: 0, y: 0, w: 88, d: 52, h: 16, color: PALETTE.structure, rim: PALETTE.violet, rimAlpha: 0.65 }));
  const tableTop = isoTile(0, -16, 84, 48, PALETTE.structureLight, 1);
  root.addChild(tableTop);
  const warmInlay = new Graphics();
  warmInlay.moveTo(-30, -16);
  warmInlay.lineTo(0, -33);
  warmInlay.lineTo(30, -16);
  warmInlay.lineTo(0, 1);
  warmInlay.lineTo(-30, -16);
  warmInlay.stroke({ width: 1.5, color: PALETTE.orange, alpha: 0.75 });
  root.addChild(warmInlay);
  root.addChild(glow(0, -18, 110, PALETTE.violet, 0.2));

  // Rotating strategy dial on the table: a spinning needle over a ring.
  const dial = new Graphics();
  dial.circle(0, -18, 12);
  dial.stroke({ width: 1.5, color: PALETTE.violet, alpha: 0.8 });
  dial.moveTo(0, -18);
  dial.lineTo(9, -24);
  dial.stroke({ width: 2, color: PALETTE.magenta });
  root.addChild(dial);

  // Side racks of tiny violet cards.
  const rack = new Graphics();
  for (const side of [-1, 1]) {
    rack.rect(side * 78 - 8, -34, 16, 4);
    rack.fill({ color: PALETTE.structureLight, alpha: 0.9 });
    for (let c = 0; c < 4; c++) {
      rack.roundRect(side * 78 - 7, -32 + c * 7, 14, 5, 1);
      rack.fill({ color: PALETTE.violet, alpha: 0.35 + c * 0.12 });
    }
  }
  root.addChild(rack);

  // Hologram arm + rotating diamond above the table (additive, 9 s loop).
  const arm = new Graphics();
  arm.moveTo(34, -16);
  arm.lineTo(10, -58);
  arm.stroke({ width: 3, color: PALETTE.structureLight });
  root.addChild(arm);
  const beam = lightBeam(0, -30, 6, 30, 34, PALETTE.violet, 0.16);
  root.addChild(beam);
  const diamond = new Graphics();
  diamond.poly([
    { x: 0, y: -10 },
    { x: 7, y: -2 },
    { x: 0, y: 6 },
    { x: -7, y: -2 },
  ]);
  diamond.fill({ color: PALETTE.violet, alpha: 0.45 });
  diamond.stroke({ width: 1.5, color: PALETTE.magenta, alpha: 0.9 });
  diamond.blendMode = "add";
  const holo = new Container();
  holo.position.set(0, -46);
  holo.addChild(diamond);
  root.addChild(holo);

  // Spinning gyroid above the lab: two counter-rotating wireframe triangles
  // on a taller emitter mast, so the lab reads as the district's beacon.
  const gyroidMast = new Graphics();
  gyroidMast.rect(-1, -84, 2, 52);
  gyroidMast.fill({ color: PALETTE.structureLight });
  gyroidMast.circle(0, -86, 2);
  gyroidMast.fill({ color: PALETTE.violet, alpha: 0.9 });
  root.addChild(gyroidMast);
  const gyroid = new Container();
  gyroid.position.set(0, -100);
  for (const scale of [1, 0.6]) {
    const tri = new Graphics();
    tri.poly([
      { x: 0, y: -9 * scale },
      { x: 8 * scale, y: 6 * scale },
      { x: -8 * scale, y: 6 * scale },
    ]);
    tri.stroke({ width: 1.6, color: PALETTE.violet, alpha: 0.9 });
    tri.blendMode = "add";
    gyroid.addChild(tri);
  }
  root.addChild(gyroid);
  root.addChild(glow(0, -100, 30, PALETTE.violet, 0.24));

  root.addChild(statusLight(-88, -20, PALETTE.healthy, ctx, 0.7));

  const off = ctx.onTick(() => {
    if (ctx.reducedMotion) {
      dial.rotation = 0.6;
      return;
    }
    const t = performance.now() / 1000;
    dial.rotation = (t / 6) * Math.PI * 2;
    // Gyroid: nested triangles counter-rotate on a slow 7 s loop.
    gyroid.children.forEach((tri, i) => {
      tri.rotation = ((t / 7) * Math.PI * 2) * (i === 0 ? 1 : -0.7);
    });
    // 9 s loop: diamond spins and bobs subtly.
    diamond.rotation = (t / 9) * Math.PI * 2;
    holo.y = -46 + Math.sin((t / 9) * Math.PI * 2) * 2;
    holo.alpha = 0.75 + 0.25 * Math.sin((t / 9) * Math.PI * 4);
  });
  ctx.onCleanup(off);
  registerStation({ id: "strategyLab", root, hit: root.hit });
}

// ---------------------------------------------------------------------------
// Sandbox: walled garden with a looping test market and a racetrack dot.
// ---------------------------------------------------------------------------

function buildSandbox(ctx: DioramaContext): void {
  const root = stationBase(ctx, "sandbox", 44, { signDx: 0 });

  contactShadow(root, 0, 4, 190, 116);

  // Garden floor: pale tile inside low walls (h = 32). Warm rim inlay keeps
  // the sandbox off the shared cyan.
  root.addChild(isoTile(0, 0, 170, 100, PALETTE.structureLight, 1, PALETTE.orange));
  const wallH = 32;
  root.addChild(isoWall({ x1: -85, y1: 0, x2: 0, y2: -50, h: wallH, color: PALETTE.structure, rim: PALETTE.orange }));
  root.addChild(isoWall({ x1: 0, y1: -50, x2: 85, y2: 0, h: wallH, color: PALETTE.structure, rim: PALETTE.cyan }));
  root.addChild(isoWall({ x1: 85, y1: 0, x2: 0, y2: 50, h: wallH, color: PALETTE.structure, rim: PALETTE.cyan }));

  // Sine-terrain strip: a tiny test market landscape.
  const terrain = new Graphics();
  for (let i = 0; i <= 24; i++) {
    const px = -62 + i * 3;
    const py = 14 + Math.sin(i * 0.7) * 6;
    if (i === 0) terrain.moveTo(px, py);
    else terrain.lineTo(px, py);
  }
  terrain.stroke({ width: 2, color: PALETTE.aqua, alpha: 0.8 });
  root.addChild(terrain);

  // 3 mini candle bots: tiny pedestals with colored candles.
  const bots = [PALETTE.cyan, PALETTE.magenta, PALETTE.orange];
  bots.forEach((color, i) => {
    const bx = -48 + i * 20;
    root.addChild(isoCylinder({ x: bx, y: -22, r: 5, h: 6, color: PALETTE.structure }));
    const bot = new Graphics();
    bot.rect(bx - 2, -36, 4, 8);
    bot.fill({ color, alpha: 0.9 });
    root.addChild(bot);
  });

  // Racetrack ring: ellipse lane where a micro dot loops (4 s).
  const track = new Graphics();
  track.ellipse(38, 4, 34, 17);
  track.stroke({ width: 2, color: PALETTE.structureLight, alpha: 0.9 });
  track.ellipse(38, 4, 30, 14);
  track.stroke({ width: 1, color: PALETTE.waiting, alpha: 0.35 });
  root.addChild(track);
  const racer = new Sprite(dotTexture());
  racer.anchor.set(0.5);
  racer.width = 8;
  racer.height = 8;
  racer.tint = PALETTE.yellow;
  root.addChild(racer);

  // "No perimeter crossing" floor decal: dashed line ending at a barrier.
  const decal = new Graphics();
  for (let i = 0; i < 6; i++) {
    const t = i / 6;
    decal.moveTo(-70 + t * 56, 26 - t * 18);
    decal.lineTo(-70 + t * 56 + 6, 26 - t * 18 - 2);
    decal.stroke({ width: 2, color: PALETTE.warning, alpha: 0.75 });
  }
  decal.rect(-16, 2, 5, 12);
  decal.fill({ color: PALETTE.warning, alpha: 0.9 });
  root.addChild(decal);

  root.addChild(statusLight(-80, -30, PALETTE.healthy, ctx, 1.7));

  const off = ctx.onTick(() => {
    if (ctx.reducedMotion) return;
    const t = performance.now() / 1000;
    const a = (t / 4) * Math.PI * 2;
    racer.position.set(38 + Math.cos(a) * 32, 4 + Math.sin(a) * 15.5);
  });
  ctx.onCleanup(off);

  // District heartbeat: test-market bubbles grow and pop on staggered
  // ~11 s cycles. Bubbles are drawn once; only scale and alpha animate.
  const bubbles: Container[] = [];
  for (let i = 0; i < 3; i++) {
    const b = new Graphics();
    b.circle(0, 0, 3);
    b.stroke({ width: 1.2, color: PALETTE.aqua, alpha: 0.9 });
    b.circle(-1, -1, 0.9);
    b.fill({ color: PALETTE.aqua, alpha: 0.8 });
    b.position.set(-40 + i * 16, 8 - i * 2);
    b.alpha = 0;
    root.addChild(b);
    bubbles.push(b);
  }
  const bubbleTweens: Array<gsap.core.Timeline> = [];
  bubbles.forEach((b, i) => {
    const cycle = 11 + i * 1.7;
    if (ctx.reducedMotion) return;
    const tl = gsap.timeline({ repeat: -1, delay: i * 3.6 });
    tl.fromTo(b, { alpha: 0, scale: 0.4 }, { alpha: 0.95, scale: 1.5, duration: cycle * 0.5, ease: "sine.in" })
      .to(b, { alpha: 0, scale: 2.1, duration: 0.18, ease: "back.in(2)" })
      .to(b, { scale: 0.4, duration: cycle * 0.4 });
    bubbleTweens.push(tl);
  });
  ctx.onCleanup(() => {
    for (const tl of bubbleTweens) tl.kill();
  });
  registerStation({ id: "sandbox", root, hit: root.hit });
}

// ---------------------------------------------------------------------------
// Budget Planning: gold-trimmed lectern with a stacked-bar plan and slider.
// ---------------------------------------------------------------------------

function buildBudgetPlanning(ctx: DioramaContext): void {
  const root = stationBase(ctx, "budgetPlanning", 60);

  contactShadow(root, 0, 20, 66, 44);

  // Lectern post + base.
  root.addChild(isoBox({ x: 0, y: 18, w: 46, d: 28, h: 8, color: PALETTE.structure }));
  root.addChild(isoCylinder({ x: 0, y: 12, r: 8, h: 26, color: PALETTE.structure }));

  // Gold-trimmed screen on the lectern top.
  const panel = screenPanel({ x: -32, y: -48, w: 64, h: 38, accent: PALETTE.yellow });
  panel.rotation = -0.06;
  root.addChild(panel);

  // Stacked bar: capital / loss allowance / tools.
  const stack = new Graphics();
  const segs = [
    { h: 14, c: PALETTE.cyan },
    { h: 8, c: PALETTE.yellow },
    { h: 5, c: PALETTE.violet },
  ];
  let sy = 16;
  for (const seg of segs) {
    stack.roundRect(-20, sy - 14 - 32, 12, seg.h, 1);
    stack.fill({ color: seg.c, alpha: 0.85 });
    sy -= seg.h + 1;
  }
  // Axis marks.
  stack.moveTo(-24, -30);
  stack.lineTo(22, -30);
  stack.stroke({ width: 1, color: PALETTE.inkDim, alpha: 0.4 });
  panel.addChild(stack);

  // Slider glyph that occasionally nudges: static track + movable knob.
  const track = new Graphics();
  track.moveTo(-14, 6);
  track.lineTo(14, 6);
  track.stroke({ width: 2, color: PALETTE.inkDim, alpha: 0.8 });
  const knob = new Graphics();
  knob.circle(0, 6, 3.5);
  knob.fill({ color: PALETTE.yellow });
  panel.addChild(track, knob);

  root.addChild(statusLight(30, -50, PALETTE.healthy, ctx, 2.9));

  const nudge = window.setInterval(
    () => {
      if (ctx.reducedMotion) return;
      gsap.fromTo(
        knob,
        { x: -6 },
        { x: 4, duration: 0.8, ease: "power2.inOut", yoyo: true, repeat: 1 },
      );
    },
    6000,
  );
  ctx.onCleanup(() => window.clearInterval(nudge));
  registerStation({ id: "budgetPlanning", root, hit: root.hit });
}

// ---------------------------------------------------------------------------
// Decision Table: round table, holo ring, pooled proposal cards.
// ---------------------------------------------------------------------------

const MAX_PROPOSALS = 4;

function buildDecisionTable(ctx: DioramaContext): void {
  const root = stationBase(ctx, "decisionTable", 70);

  contactShadow(root, 0, 32, 196, 100);

  // Round table: iso ellipse platform on a pedestal, pale rim.
  root.addChild(isoCylinder({ x: 0, y: 30, r: 14, h: 14, color: PALETTE.structure }));
  const tableTop = new Graphics();
  tableTop.ellipse(0, 16, 88, 44);
  tableTop.fill({ color: topFaceTable() });
  tableTop.ellipse(0, 16, 88, 44);
  tableTop.stroke({ width: 2, color: PALETTE.surfacePale, alpha: 0.8 });
  tableTop.ellipse(0, 16, 70, 34);
  tableTop.stroke({ width: 1, color: PALETTE.cyan, alpha: 0.22 });
  root.addChild(tableTop);
  root.addChild(glow(0, 14, 150, PALETTE.blue, 0.12));

  // Holo ring above the table.
  const ring = new Graphics();
  ring.ellipse(0, -34, 60, 20);
  ring.stroke({ width: 2, color: PALETTE.blue, alpha: 0.7 });
  ring.ellipse(0, -34, 46, 14);
  ring.stroke({ width: 1, color: PALETTE.cyan, alpha: 0.4 });
  ring.blendMode = "add";
  root.addChild(ring);

  root.addChild(statusLight(-84, 20, PALETTE.healthy, ctx, 0.05));

  // Pooled proposal cards.
  const cards: Container[] = [];
  for (let i = 0; i < MAX_PROPOSALS; i++) {
    const card = new Container();
    const body = new Graphics();
    body.roundRect(-19, -26, 38, 52, 3);
    body.fill({ color: PALETTE.structure, alpha: 0.95 });
    body.roundRect(-19, -26, 38, 52, 3);
    body.stroke({ width: 1.5, color: PALETTE.violet, alpha: 0.9 });
    card.addChild(body);
    // Indicator pips: evidence eye, confidence bars, return arrow, risk shield, authority badge.
    const pips = new Graphics();
    // eye
    pips.ellipse(-7, -12, 5, 3);
    pips.stroke({ width: 1, color: PALETTE.aqua, alpha: 0.9 });
    pips.circle(-7, -12, 1.2);
    pips.fill({ color: PALETTE.aqua });
    // confidence bars
    for (let b = 0; b < 3; b++) {
      pips.rect(4, -15 + b * 4, 4 + b * 2, 2);
      pips.fill({ color: PALETTE.cyan, alpha: 0.8 });
    }
    // return arrow
    pips.moveTo(-9, 2);
    pips.lineTo(-3, 2);
    pips.lineTo(-3, 2);
    pips.stroke({ width: 1.2, color: PALETTE.healthy, alpha: 0.9 });
    pips.moveTo(-3, 2);
    pips.lineTo(-5, 0.5);
    pips.moveTo(-3, 2);
    pips.lineTo(-5, 3.5);
    pips.stroke({ width: 1.2, color: PALETTE.healthy, alpha: 0.9 });
    // risk shield
    pips.poly([
      { x: 7, y: -1 },
      { x: 11, y: 0.5 },
      { x: 11, y: 5 },
      { x: 7, y: 8 },
      { x: 3, y: 5 },
      { x: 3, y: 0.5 },
    ]);
    pips.stroke({ width: 1.2, color: PALETTE.warning, alpha: 0.9 });
    // authority badge
    pips.poly([
      { x: 0, y: 14 },
      { x: 2, y: 17 },
      { x: 5, y: 17 },
      { x: 3, y: 19 },
      { x: 4, y: 22 },
      { x: 0, y: 20 },
      { x: -4, y: 22 },
      { x: -3, y: 19 },
      { x: -5, y: 17 },
      { x: -2, y: 17 },
    ]);
    pips.fill({ color: PALETTE.yellow, alpha: 0.9 });
    card.addChild(pips);
    card.visible = false;
    card.alpha = 0;
    root.addChild(card);
    cards.push(card);
  }

  const fanAngles = [-0.9, -0.3, 0.3, 0.9];
  let timeline: gsap.core.Timeline | null = null;
  ctx.onCleanup(() => {
    timeline?.kill();
  });
  const activeTimeline = (): gsap.core.Timeline => {
    timeline?.kill();
    const tl = gsap.timeline();
    timeline = tl;
    return tl;
  };

  const api: DecisionTableApi = {
    showProposals(count: number, chosenIndex: number): void {
      const n = Math.max(2, Math.min(MAX_PROPOSALS, count));
      // chosenIndex -1 is the reject variant: every proposal is passed over,
      // one flashes red and the whole fan retracts (plan story 5).
      const rejecting = chosenIndex < 0;
      const rejected = rejecting ? 0 : -1;
      const chosen = rejecting ? -1 : Math.max(0, Math.min(n - 1, chosenIndex));
      const timeline = activeTimeline();
      for (let i = 0; i < n; i++) {
        const card = cards[i];
        card.visible = true;
        const angle = fanAngles[i] ?? 0;
        const fanX = Math.sin(angle) * 92;
        const fanY = -30 - Math.cos(angle) * 16;
        // Spawn: rise from the table into the fan.
        timeline.fromTo(
          card,
          { x: 0, y: 10, alpha: 0, rotation: 0 },
          { x: fanX, y: fanY, alpha: 1, rotation: angle * 0.4, duration: 0.45, ease: "back.out(1.6)" },
          i * 0.08,
        );
        if (i === chosen) {
          // Chosen card rises + pops warm.
          timeline.to(card, { y: fanY - 16, duration: 0.4, ease: "power2.out" }, 0.6);
          timeline.to(card, { alpha: 1, duration: 0.3 }, 0.6);
          const body = card.getChildAt(0) as Graphics;
          timeline.call(() => {
            body.clear();
            body.roundRect(-19, -26, 38, 52, 3);
            body.fill({ color: PALETTE.structureLight, alpha: 0.98 });
            body.roundRect(-19, -26, 38, 52, 3);
            body.stroke({ width: 3, color: PALETTE.orange, alpha: 1 });
          }, undefined, 0.6);
        } else if (i === rejected) {
          // Rejected lead card flashes a red refusal trim, then retracts.
          const body = card.getChildAt(0) as Graphics;
          timeline.call(() => {
            body.clear();
            body.roundRect(-19, -26, 38, 52, 3);
            body.fill({ color: PALETTE.structure, alpha: 0.95 });
            body.roundRect(-19, -26, 38, 52, 3);
            body.stroke({ width: 2.5, color: PALETTE.blocked, alpha: 1 });
          }, undefined, 0.55);
          timeline.to(
            card,
            { x: fanX * 0.3, y: 6, alpha: 0, duration: 0.5, ease: "power2.in" },
            0.95,
          );
        } else {
          // Others dim to a cool tone and slide back / retract.
          const body = card.getChildAt(0) as Graphics;
          timeline.call(() => {
            body.clear();
            body.roundRect(-19, -26, 38, 52, 3);
            body.fill({ color: PALETTE.structure, alpha: 0.8 });
            body.roundRect(-19, -26, 38, 52, 3);
            body.stroke({ width: 1.2, color: PALETTE.blue, alpha: 0.55 });
          }, undefined, 0.7);
          timeline.to(
            card,
            { x: fanX * 0.45, y: fanY * 0.6 + 8, alpha: 0.35, duration: 0.5, ease: "power2.in" },
            0.7,
          );
        }
      }
      // Total ~1.6 s from fan-out to settle.
      timeline.to({}, { duration: 0.2 });
    },
    clearProposals(): void {
      const timeline = activeTimeline();
      cards.forEach((card, i) => {
        if (!card.visible) return;
        timeline.to(card, { y: 12, alpha: 0, duration: 0.3, ease: "power2.in" }, i * 0.04);
        timeline.call(
          () => {
            card.visible = false;
            const body = card.getChildAt(0) as Graphics;
            body.clear();
            body.roundRect(-19, -26, 38, 52, 3);
            body.fill({ color: PALETTE.structure, alpha: 0.95 });
            body.roundRect(-19, -26, 38, 52, 3);
            body.stroke({ width: 1.5, color: PALETTE.violet, alpha: 0.9 });
          },
          undefined,
          i * 0.04 + 0.3,
        );
      });
    },
  };
  registerStation({ id: "decisionTable", root, hit: root.hit, api });

  // Ambient: holo ring slow shimmer.
  const off = ctx.onTick(() => {
    if (ctx.reducedMotion) return;
    const t = performance.now() / 1000;
    ring.alpha = 0.55 + 0.3 * breathe(t, 6, 0);
    ring.rotation = 0;
  });
  ctx.onCleanup(off);
}

/** Table top tone (structure lightened strongly, kept local for readability). */
function topFaceTable(): number {
  // Matches palette surface tone family without exporting new tokens.
  return PALETTE.structureLight;
}

// ---------------------------------------------------------------------------
// Scatter props: crates, a rolled chart, planters with glowing reeds.
// ---------------------------------------------------------------------------

function scatterProps(ctx: DioramaContext): void {
  const rnd = seededRandom(11);
  const layer = ctx.layers.sortable;

  // District-edge positions hand-placed to avoid station footprints.
  const spots: Array<{ x: number; y: number }> = [
    { x: 215, y: 230 },
    { x: 470, y: 240 },
    { x: 700, y: 250 },
    { x: 930, y: 240 },
    { x: 1080, y: 340 },
    { x: 250, y: 640 },
    { x: 560, y: 640 },
    { x: 880, y: 600 },
    { x: 1090, y: 500 },
    { x: 430, y: 430 },
    { x: 340, y: 330 },
    { x: 820, y: 430 },
    { x: 1010, y: 560 },
    { x: 620, y: 540 },
  ];

  spots.forEach((spot, i) => {
    const root = new Container();
    root.position.set(spot.x + (rnd() - 0.5) * 14, spot.y + (rnd() - 0.5) * 10);
    root.zIndex = spot.y + DEPTH.base;
    const kind = i % 3;
    if (kind === 0) {
      // Crate.
      const s = 16 + rnd() * 8;
      root.addChild(isoBox({ x: 0, y: 0, w: s, d: s * 0.6, h: s * 0.6, color: PALETTE.structure, rim: PALETTE.structureLight, rimAlpha: 0.4 }));
    } else if (kind === 1) {
      // Rolled chart: a small cylinder on its side look via low cylinder.
      root.addChild(isoCylinder({ x: 0, y: 0, r: 8, h: 6, color: PALETTE.surfacePale, alpha: 0.85 }));
    } else {
      // Planter with glowing reeds.
      root.addChild(isoBox({ x: 0, y: 0, w: 18, d: 11, h: 8, color: PALETTE.structure }));
      const reeds = new Graphics();
      const reedColor = rnd() > 0.5 ? PALETTE.violet : PALETTE.cyan;
      for (let r = 0; r < 3; r++) {
        const rx = -5 + r * 5;
        reeds.moveTo(rx, -8);
        reeds.lineTo(rx + (rnd() - 0.5) * 4, -22 - rnd() * 6);
        reeds.stroke({ width: 1.5, color: reedColor, alpha: 0.75 });
      }
      reeds.blendMode = "add";
      root.addChild(reeds);
      root.addChild(glow(0, -14, 26, reedColor, 0.14));
    }
    layer.addChild(root);
  });
}

// ---------------------------------------------------------------------------

export function buildResearchDistrict(ctx: DioramaContext): void {
  buildMissionBoard(ctx);
  buildMarketData(ctx);
  buildResearchTools(ctx);
  buildStrategyLab(ctx);
  buildSandbox(ctx);
  buildBudgetPlanning(ctx);
  buildDecisionTable(ctx);
  scatterProps(ctx);
}
