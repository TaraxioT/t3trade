/**
 * Research & Strategy district: mission board, market data, research tools,
 * strategy lab, sandbox, budget planning, decision table.
 * Owner: research district worker.
 *
 * Hierarchy by function, one left-to-right decision story:
 * - MISSION BOARD is the initiating landmark: widest structure, side pylons
 *   with beacons, and a live phase readout driven by MissionBoardApi.
 * - MARKET DATA + RESEARCH TOOLS form the paired evidence tier: twin console
 *   walls on one shared ground apron; quantitative feeds on one side,
 *   qualitative documents on the other.
 * - STRATEGY LAB is the synthesis tier: a light table with a west gathering
 *   apron whose footplates match the s-research-synthesis landing points.
 * - DECISION TABLE is the single decision endpoint (DecisionTableApi).
 * - SANDBOX and BUDGET PLAN are subordinate side branches: warm trim, smaller
 *   mass, quieter motion.
 *
 * All statics are built once; ambient motion runs through ctx.onTick with
 * per-station phase offsets, GSAP only for brief state transitions. Station
 * signs sit at or below the market-landscape contour band (band ends at
 * world y 250) so labels never ride the terrain.
 */
import { Container, Graphics, Sprite, Text, TextStyle } from "pixi.js";
import gsap from "gsap";
import type { DioramaContext } from "../core/context.js";
import { registerStation } from "../core/registry.js";
import { STATIONS } from "../config/stations.js";
import { PALETTE } from "../config/palette.js";
import { seededRandom, DEPTH } from "../config/world.js";
import {
  dotTexture,
  glow,
  isoBox,
  isoCylinder,
  isoTile,
  isoWall,
  screenPanel,
} from "../core/iso.js";
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
  opts: { signDx?: number; signY?: number; signHalo?: boolean } = {},
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

  // signY lets a station pin its sign to a collision-checked world height
  // (the top-row stations must clear the market-landscape band); signHalo
  // false drops the wide soft halo where it would wash a neighbor's screens.
  const sign = makeSign(def.label, {
    x: def.anchor.x + (opts.signDx ?? 0),
    y: opts.signY ?? def.anchor.y - (structureHeight + 26),
    size: def.signSize,
    accent: PALETTE.cyan,
    halo: opts.signHalo ?? true,
  });
  sign.zIndex = def.anchor.y + DEPTH.overlay;
  ctx.layers.labels.addChild(sign);

  return root;
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

/** Status light paired with a shape cue: pulsing ring + blinking inner dot. */
function statusLight(
  x: number,
  y: number,
  color: number,
  ctx: DioramaContext,
  phase: number,
): Container {
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

/** Landmark beacon: soft dot + tight glow with a slow sine pulse. */
function beacon(
  x: number,
  y: number,
  color: number,
  ctx: DioramaContext,
  phase: number,
): Container {
  const c = new Container();
  c.position.set(x, y);
  c.addChild(glow(0, 0, 16, color, 0.45));
  const dot = new Sprite(dotTexture());
  dot.anchor.set(0.5);
  dot.width = 6;
  dot.height = 6;
  dot.tint = color;
  c.addChild(dot);
  const off = ctx.onTick(() => {
    if (ctx.reducedMotion) return;
    const s = (performance.now() / 1000 + phase) % 3;
    dot.alpha = 0.6 + 0.4 * Math.sin(s * Math.PI * 2);
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
function contactShadow(
  root: Container,
  x: number,
  y: number,
  w: number,
  d: number,
  alpha = 0.27,
): void {
  const g = new Graphics();
  g.ellipse(x, y, w / 2, d / 2);
  g.fill({ color: 0x03080f, alpha });
  root.addChild(g);
}

/**
 * Shared-tier and gathering floor pads, drawn once on the unsorted ground
 * layer so every sortable object (agents included) passes above them. Used
 * for the evidence-tier apron under marketData + researchTools and the
 * convene apron west of the strategy lab.
 */
function groundPad(
  ctx: DioramaContext,
  x: number,
  y: number,
  w: number,
  d: number,
  rim: number,
  rimAlpha: number,
): void {
  const g = new Graphics();
  g.roundRect(x - w / 2, y - d / 2, w, d, Math.min(w, d) * 0.28);
  g.fill({ color: PALETTE.structure, alpha: 0.5 });
  g.roundRect(x - w / 2, y - d / 2, w, d, Math.min(w, d) * 0.28);
  g.stroke({ width: 1.5, color: rim, alpha: rimAlpha });
  ctx.layers.ground.addChild(g);
}

/** Small marked standing plate: rounded pad + tick, bots convene on these. */
function footPlate(x: number, y: number, accent: number): Graphics {
  const g = new Graphics();
  g.roundRect(x - 13, y - 7, 26, 14, 3);
  g.fill({ color: PALETTE.structureLight, alpha: 0.85 });
  g.roundRect(x - 13, y - 7, 26, 14, 3);
  g.stroke({ width: 1, color: accent, alpha: 0.7 });
  g.moveTo(x - 4, y);
  g.lineTo(x + 4, y);
  g.stroke({ width: 1.5, color: accent, alpha: 0.9 });
  return g;
}

// ---------------------------------------------------------------------------
// Mission Board: the district's initiating landmark. A wide angled billboard
// on a plinth, flanked by beacon pylons, with a live phase readout.
// ---------------------------------------------------------------------------

/** Real mission statuses (packages/trading-contracts/src/mission.ts). */
const MISSION_PHASES = ["WAITING", "ANALYSING", "EXECUTING", "HOLDING"];

function buildMissionBoard(ctx: DioramaContext): void {
  const root = stationBase(ctx, "missionBoard", 58, { signY: 262 });
  const accent = PALETTE.cyan;

  contactShadow(root, 0, 12, 208, 84);
  // Wide plinth grounds the landmark and gives it the district's largest
  // footprint mass without rising into the landscape band above.
  root.addChild(
    isoBox({
      x: 0,
      y: 22,
      w: 206,
      d: 84,
      h: 8,
      color: PALETTE.structure,
      rim: accent,
      rimAlpha: 0.35,
    }),
  );

  // Side pylons outside the board span: posts rise past the board top and
  // carry the beacons, so the board reads as a gate-style landmark.
  for (const px of [-106, 106]) {
    root.addChild(
      isoCylinder({ x: px, y: 12, r: 5, h: 70, color: PALETTE.structure, rim: accent }),
    );
  }

  // Briefing ledge on the plinth's top face: the synthesis story walks
  // strategy-1 to near("missionBoard", 60, 20) = world (390, 350), so that
  // point gets a marked stand, a carried-brief card pair, and a queue strip
  // along the front edge. The wedge now reads as the board's work apron.
  root.addChild(footPlate(60, 20, accent));
  const brief = new Graphics();
  brief.roundRect(34, 22, 14, 9, 1.5);
  brief.fill({ color: PALETTE.surfacePale, alpha: 0.5 });
  brief.roundRect(41, 27, 14, 9, 1.5);
  brief.fill({ color: PALETTE.surfacePale, alpha: 0.35 });
  brief.rotation = -0.15;
  root.addChild(brief);
  const queue = new Graphics();
  for (let q = 0; q < 3; q++) {
    queue.roundRect(-32 + q * 12, 36, 8, 3, 1.5);
    queue.fill({ color: PALETTE.structureLight, alpha: 0.9 });
    queue.roundRect(-32 + q * 12, 36, 8, 3, 1.5);
    queue.stroke({ width: 0.75, color: accent, alpha: 0.5 });
  }
  root.addChild(queue);
  const queueLabel = microText("QUEUE", 7, PALETTE.inkDim);
  queueLabel.anchor.set(0.5);
  queueLabel.position.set(-16, 45);
  root.addChild(queueLabel);

  // Angled board: dark screen slab tilted toward camera, trim lit.
  const board = screenPanel({ x: -102, y: -56, w: 204, h: 50, accent });
  root.addChild(board);

  // Live phase block (left): the mid-zoom legible phase state.
  const phaseChip = new Graphics();
  phaseChip.roundRect(-98, -50, 92, 22, 3);
  phaseChip.fill({ color: accent, alpha: 0.18 });
  phaseChip.roundRect(-98, -50, 92, 22, 3);
  phaseChip.stroke({ width: 1, color: accent, alpha: 0.8 });
  board.addChild(phaseChip);
  const phaseLabel = microText("PHASE", 7.5, PALETTE.inkDim);
  phaseLabel.anchor.set(0, 0.5);
  phaseLabel.position.set(-94, -44);
  board.addChild(phaseLabel);
  const phaseValue = microText("WAITING", 13, PALETTE.ink);
  phaseValue.anchor.set(0, 0.5);
  phaseValue.position.set(-94, -33);
  board.addChild(phaseValue);

  // Phase chip row (right): four state slots; setPhase moves the highlight.
  const chips: Container[] = [];
  MISSION_PHASES.forEach((_, i) => {
    const chip = new Container();
    const g = new Graphics();
    g.roundRect(-6, -4, 12, 8, 2);
    g.fill({ color: i === 0 ? accent : PALETTE.structureLight, alpha: i === 0 ? 0.95 : 0.7 });
    chip.addChild(g);
    chip.position.set(14 + i * 18, -39);
    chip.scale.set(i === 0 ? 1.2 : 0.8);
    board.addChild(chip);
    chips.push(chip);
  });

  // Goal strip: one honest simulated mission line, warm progress bar, and
  // the district-heartbeat ticker sweeping the bar (~9 s).
  const goal = microText("SIM MISSION 07", 7.5, PALETTE.inkDim);
  goal.anchor.set(0, 0.5);
  goal.position.set(-94, -14);
  board.addChild(goal);
  const bar = new Graphics();
  bar.roundRect(28, -17, 68, 5, 2);
  bar.fill({ color: PALETTE.structureLight, alpha: 0.9 });
  bar.roundRect(28, -17, 46, 5, 2);
  bar.fill({ color: PALETTE.orange, alpha: 0.9 });
  board.addChild(bar);
  const ticker = new Graphics();
  ticker.roundRect(28, -18, 10, 7, 2);
  ticker.fill({ color: PALETTE.orange, alpha: 0.95 });
  board.addChild(ticker);
  const tickerOff = ctx.onTick(() => {
    if (ctx.reducedMotion) return;
    const t = ((performance.now() / 1000) % 9) / 9;
    ticker.x = t * 58;
    ticker.alpha = 0.55 + 0.4 * Math.sin(t * Math.PI);
  });
  ctx.onCleanup(tickerOff);

  // Pylon beacons: two pulses mark the landmark from fit zoom.
  root.addChild(beacon(-106, -60, PALETTE.cyan, ctx, 0.0));
  root.addChild(beacon(106, -60, PALETTE.cyan, ctx, 0.5));

  const api: MissionBoardApi = {
    setPhase(phase: string): void {
      // Normalize case so stories may pass "Waiting" or "WAITING".
      const idx = Math.max(0, MISSION_PHASES.indexOf(phase.trim().toUpperCase()));
      const chip = chips[idx];
      if (!chip) return;
      phaseValue.text = MISSION_PHASES[idx];
      chips.forEach((c, i) => {
        const on = i === idx;
        (c.getChildAt(0) as Graphics).alpha = on ? 0.95 : 0.7;
        c.scale.set(on ? 1.2 : 0.8);
      });
      gsap.fromTo(phaseChip, { alpha: 0.35 }, { alpha: 1, duration: 0.5, ease: "power1.inOut" });
      gsap
        .timeline()
        .to(chip.scale, { x: 1.7, y: 1.7, duration: 0.22, ease: "power2.out" })
        .to(chip.scale, { x: 1.2, y: 1.2, duration: 0.3, ease: "elastic.out(1, 0.5)" });
      gsap.fromTo(chip, { alpha: 0.1 }, { alpha: 1, duration: 0.45, ease: "power1.inOut" });
    },
  };
  registerStation({ id: "missionBoard", root, hit: root.hit, api });
}

// ---------------------------------------------------------------------------
// Market Data: quantitative feed wall. Twin of Research Tools (same slab +
// backdrop construction); content family = numbers, ticks, gauges.
// ---------------------------------------------------------------------------

function buildMarketData(ctx: DioramaContext): void {
  const root = stationBase(ctx, "marketData", 50, { signY: 264 });

  contactShadow(root, 0, 26, 196, 60);
  const base = isoBox({
    x: 0,
    y: 14,
    w: 184,
    d: 44,
    h: 12,
    color: PALETTE.structure,
    rim: PALETTE.cyan,
    rimAlpha: 0.55,
  });
  root.addChild(base);

  // Dark backdrop wall the screens mount on; top edge stays below the
  // landscape contour band (world y 270 here, band ends at 250) and the
  // sign band (world 250-278) rides the wall's blank top rim.
  const wall = new Graphics();
  wall.roundRect(-92, -50, 184, 58, 6);
  wall.fill({ color: PALETTE.space, alpha: 0.8 });
  wall.roundRect(-92, -50, 184, 58, 6);
  wall.stroke({ width: 1.5, color: PALETTE.cyan, alpha: 0.3 });
  root.addChild(wall);

  // 4 feed screens along the wall (slight fan angles), all below the sign
  // band so the twin-tier signs never cover feed content.
  const screens: Array<{ x: number; y: number; rot: number }> = [
    { x: -69, y: -27, rot: -0.1 },
    { x: -23, y: -27, rot: -0.03 },
    { x: 23, y: -27, rot: 0.03 },
    { x: 69, y: -27, rot: 0.1 },
  ];
  const captions = ["PX", "BOOK", "FUND", "VOL"];
  const candles: Graphics[] = [];
  const bookRows: Graphics[] = [];
  const funding: Graphics[] = [];
  const volBars: Graphics[] = [];

  screens.forEach((s, si) => {
    const panel = screenPanel({ x: -20, y: -15, w: 40, h: 30, accent: PALETTE.cyan });
    panel.position.set(s.x, s.y);
    panel.rotation = s.rot;
    root.addChild(panel);
    const caption = microText(captions[si], 8, PALETTE.inkDim);
    caption.anchor.set(0.5);
    caption.position.set(s.x, -4);
    root.addChild(caption);

    if (si === 0) {
      // Candlestick micro-chart plus a live price readout.
      const g = new Graphics();
      drawCandles(g, [4, 7, 5]);
      panel.addChild(g);
      candles.push(g);
    } else if (si === 1) {
      // Order-book ladder rows.
      const g = new Graphics();
      for (let r = 0; r < 5; r++) {
        g.rect(-17, -13 + r * 6, 10 + ((r * 7) % 16), 3);
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

  // Price readout inside the candle screen's lower half, refreshed with the
  // feed timer.
  const candleData = [4, 7, 5];
  const price = microText("1.0260", 8.5, PALETTE.healthy);
  price.anchor.set(0.5);
  price.position.set(-69, -18);
  root.addChild(price);

  root.addChild(statusLight(76, 22, PALETTE.healthy, ctx, 1.1));

  // Feed mast on the slab's east corner; tip kept below the sign band.
  const mast = new Graphics();
  mast.rect(94, -30, 2, 40);
  mast.fill({ color: PALETTE.structureLight });
  mast.rect(91, -30, 8, 1.4);
  mast.fill({ color: PALETTE.cyan, alpha: 0.7 });
  mast.circle(95, -32, 2.2);
  mast.fill({ color: PALETTE.cyan, alpha: 0.95 });
  root.addChild(mast);

  const off = ctx.onTick(() => {
    const t = performance.now() / 1000;
    if (ctx.reducedMotion) return;
    // Volatility bars breathe continuously (transform only).
    volBars.forEach((bar, i) => {
      const k = 0.6 + 0.5 * breathe(t, 5, i * 0.8);
      bar.scale.y = k;
      bar.pivot.set(0, 4);
    });
    // Funding dial drift redraw (tiny Graphics, ~1 Hz).
    const angle = Math.sin(t / 9) * 0.9;
    if (funding.length && Math.floor(t) !== Math.floor(t - 0.016)) {
      redrawFundingArc(funding[0], angle);
    }
  });
  ctx.onCleanup(off);

  // Every ~4 s the feed refreshes: candles roll, the price ticks, and the
  // book rows flash. Rare redraw plus one text swap; clearly simulated.
  const feedTimer = window.setInterval(() => {
    for (let i = 0; i < 3; i++) {
      candleData[i] = 3 + Math.round(Math.random() * 6);
    }
    if (candles[0]) drawCandles(candles[0], candleData);
    price.text = (1.02 + (candleData[0] + candleData[1] + candleData[2]) / 300).toFixed(4);
    if (!ctx.reducedMotion) {
      bookRows.forEach((g) => {
        g.alpha = 0.3;
        gsap.to(g, { alpha: 0.85, duration: 0.6, ease: "power1.inOut" });
      });
    }
  }, 4000);
  ctx.onCleanup(() => window.clearInterval(feedTimer));

  // District heartbeat: a refresh sweep crosses the feed screens every
  // ~13 s, as if all four feeds re-synced. One static line; only x animates.
  const sweep = new Graphics();
  sweep.rect(-1, -44, 2, 36);
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
    g.rect(cx - 2, -4 - h, 4, h);
    g.fill({ color, alpha: 0.9 });
    g.moveTo(cx, -6 - h);
    g.lineTo(cx, -1 - h);
    g.moveTo(cx, -2);
    g.lineTo(cx, 1);
    g.stroke({ width: 1, color, alpha: 0.7 });
  });
}

function redrawFundingArc(g: Graphics, angle: number): void {
  g.clear();
  g.circle(0, -3, 8);
  g.stroke({ width: 1.5, color: PALETTE.structureLight, alpha: 0.9 });
  const tipX = Math.sin(angle) * 7;
  const tipY = -3 - Math.cos(angle) * 7;
  g.moveTo(0, -3);
  g.lineTo(tipX, tipY);
  g.stroke({ width: 2, color: PALETTE.orange, alpha: 0.9 });
  g.circle(0, -3, 1.6);
  g.fill({ color: PALETTE.orange });
}

// ---------------------------------------------------------------------------
// Research Tools: qualitative document wall. Twin of Market Data; content
// family = headlines, sheets, history rows.
// ---------------------------------------------------------------------------

const NEWS_LINES = ["LIQ UP", "FUND +", "RANGE"];

function buildResearchTools(ctx: DioramaContext): void {
  const root = stationBase(ctx, "researchTools", 46, { signY: 264 });

  contactShadow(root, 0, 40, 196, 60);
  const base = isoBox({
    x: 0,
    y: 34,
    w: 184,
    d: 44,
    h: 12,
    color: PALETTE.structure,
    rim: PALETTE.cyan,
    rimAlpha: 0.55,
  });
  root.addChild(base);

  // Backdrop wall mirroring marketData's construction (twin tier language):
  // wall top at world y 250, sign band 250-278 on the blank rim, screens
  // aligned with marketData's screen row at world 278-304.
  const wall = new Graphics();
  wall.roundRect(-92, -50, 184, 72, 6);
  wall.fill({ color: PALETTE.space, alpha: 0.8 });
  wall.roundRect(-92, -50, 184, 72, 6);
  wall.stroke({ width: 1.5, color: PALETTE.cyan, alpha: 0.3 });
  root.addChild(wall);

  const captions = ["NEWS", "TOKENS", "HISTORY"];
  const seats = [
    { x: -60, y: -9 },
    { x: 0, y: -9 },
    { x: 60, y: -9 },
  ];
  const scanLine = new Graphics();
  scanLine.moveTo(-14, -12);
  scanLine.lineTo(14, -12);
  scanLine.stroke({ width: 1.5, color: PALETTE.cyan, alpha: 0.8 });
  scanLine.blendMode = "add";
  const headlines: Text[] = [];

  seats.forEach((seat, i) => {
    const panel = screenPanel({ x: -20, y: -13, w: 40, h: 26, accent: PALETTE.cyan });
    panel.position.set(seat.x, seat.y);
    panel.rotation = (i - 1) * 0.03;
    root.addChild(panel);
    const caption = microText(captions[i], 8, PALETTE.inkDim);
    caption.anchor.set(0.5);
    caption.position.set(seat.x, 12);
    root.addChild(caption);

    if (i === 0) {
      // News screen: three real text tickers, one rotating highlight.
      NEWS_LINES.forEach((line, h) => {
        const t = microText(line, 7, h === 0 ? PALETTE.ink : PALETTE.inkDim);
        t.anchor.set(0, 0.5);
        t.position.set(-16, -6 + h * 7);
        panel.addChild(t);
        headlines.push(t);
      });
    } else if (i === 1) {
      // Token screen: hex registry glyph over stacked sheets.
      const glyph = new Graphics();
      for (let k = 0; k <= 6; k++) {
        const a = (Math.PI / 3) * k - Math.PI / 6;
        const px = Math.cos(a) * 6;
        const py = Math.sin(a) * 6 - 4;
        if (k === 0) glyph.moveTo(px, py);
        else glyph.lineTo(px, py);
      }
      glyph.stroke({ width: 1.5, color: PALETTE.violet, alpha: 0.95 });
      for (let s2 = 0; s2 < 2; s2++) {
        glyph.roundRect(-7, 4 + s2 * 4, 14, 3, 1);
        glyph.fill({ color: PALETTE.blue, alpha: 0.5 + s2 * 0.25 });
      }
      panel.addChild(glyph);
    } else {
      // History screen: backtest rows with a passing scan line.
      const bars = new Graphics();
      for (let b = 0; b < 5; b++) {
        const h = 4 + ((b * 5) % 9);
        bars.rect(-16 + b * 7, 8 - h, 4, h);
        bars.fill({ color: PALETTE.blue, alpha: 0.55 + b * 0.08 });
      }
      panel.addChild(bars);
      panel.addChild(scanLine);
    }
  });

  // Rotating headline highlight: one line brightens every ~6 s.
  let hot = 0;
  const newsTimer = window.setInterval(() => {
    if (ctx.reducedMotion) return;
    hot = (hot + 1) % headlines.length;
    headlines.forEach((t, h) => {
      const on = h === hot;
      gsap.to(t, { alpha: on ? 1 : 0.45, duration: 0.4, ease: "power1.inOut" });
      t.style.fill = on ? PALETTE.ink : PALETTE.inkDim;
    });
  }, 6000);
  ctx.onCleanup(() => window.clearInterval(newsTimer));

  const off = ctx.onTick(() => {
    if (ctx.reducedMotion) return;
    const t = ((performance.now() / 1000) % 5) / 5;
    scanLine.y = -10 + t * 14;
    scanLine.alpha = 0.25 + 0.6 * Math.sin(t * Math.PI);
  });
  ctx.onCleanup(off);
  registerStation({ id: "researchTools", root, hit: root.hit });
}

// ---------------------------------------------------------------------------
// Strategy Lab: synthesis workspace. Light table + candidate racks; bots
// convene on the west apron footplates (s-research-synthesis landing points).
// ---------------------------------------------------------------------------

function buildStrategyLab(ctx: DioramaContext): void {
  // Sign nudged east with its halo off: at (980,308) the board and its wide
  // soft halo crowded the RESEARCH TOOLS history screen 35 px to the west.
  const root = stationBase(ctx, "strategyLab", 66, { signDx: 40, signHalo: false });

  contactShadow(root, 0, 6, 120, 76);
  // Central light-table: pale top, low body, warm orange inlay strip.
  root.addChild(
    isoBox({
      x: 0,
      y: 0,
      w: 88,
      d: 52,
      h: 16,
      color: PALETTE.structure,
      rim: PALETTE.violet,
      rimAlpha: 0.5,
    }),
  );
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
  // Table-local glow only: the lab reads by its workspace, not a district wash.
  root.addChild(glow(0, -18, 60, PALETTE.violet, 0.14));

  // Candidate fan on the table: three card outlines, one bright. Echoes the
  // decision-table card language and stays honest at rest (no spin).
  const fan = new Graphics();
  [-14, 0, 14].forEach((cx, i) => {
    fan.roundRect(cx - 6, -26, 12, 9, 1.5);
    fan.stroke({
      width: 1.2,
      color: i === 1 ? PALETTE.violet : PALETTE.structureLight,
      alpha: i === 1 ? 0.95 : 0.7,
    });
  });
  root.addChild(fan);

  // Side racks of tiny violet cards: the candidate library the stories
  // scatter and sort during the conflict beat.
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

  // Gathering apron (ground layer): a convene pad west of the table with
  // footplates at the exact story landing points near("strategyLab",-75,35)
  // and (-75,65), so the convergence beat lands on marked spots. The tiny
  // caption names the pad's role so the plates never read as stray pucks.
  groundPad(ctx, 905, 450, 110, 72, PALETTE.violet, 0.35);
  ctx.layers.ground.addChild(footPlate(905, 435, PALETTE.cyan));
  ctx.layers.ground.addChild(footPlate(905, 465, PALETTE.blue));
  const apronLabel = microText("EVIDENCE", 7, PALETTE.inkDim);
  apronLabel.anchor.set(0.5);
  apronLabel.position.set(905, 480);
  ctx.layers.ground.addChild(apronLabel);

  registerStation({ id: "strategyLab", root, hit: root.hit });
}

// ---------------------------------------------------------------------------
// Sandbox: contained test area. Tall back walls, low see-through front lips,
// and an explicit south gate where the research walkway arrives. A warm rim
// keeps this side branch off the shared cyan.
// ---------------------------------------------------------------------------

function buildSandbox(ctx: DioramaContext): void {
  const root = stationBase(ctx, "sandbox", 44, { signDx: 68, signY: 600 });

  contactShadow(root, 0, 6, 190, 112);

  // Garden floor: pale tile inside the walls.
  root.addChild(isoTile(0, 0, 170, 100, PALETTE.structureLight, 1, PALETTE.orange));
  // Back walls (north edges) contain the test area...
  root.addChild(
    isoWall({
      x1: -85,
      y1: 0,
      x2: 0,
      y2: -50,
      h: 26,
      color: PALETTE.structure,
      rim: PALETTE.orange,
    }),
  );
  root.addChild(
    isoWall({
      x1: 0,
      y1: -50,
      x2: 85,
      y2: 0,
      h: 26,
      color: PALETTE.structure,
      rim: PALETTE.orange,
    }),
  );
  // ...front edges are low lips so the interior stays visible (cutaway) and
  // reads as an open test bay, not a sealed box.
  root.addChild(
    isoWall({ x1: 85, y1: 0, x2: 0, y2: 50, h: 8, color: PALETTE.structure, rim: PALETTE.orange }),
  );
  root.addChild(
    isoWall({ x1: 0, y1: 50, x2: -85, y2: 0, h: 8, color: PALETTE.structure, rim: PALETTE.orange }),
  );

  // Explicit entrance on the south corner: gate posts + header where the
  // research walkway (WALKWAY_RESEARCH) terminates at world (330,590).
  const gate = new Graphics();
  for (const gx of [-14, 14]) {
    gate.roundRect(gx - 2.5, 43 - 22, 5, 22, 2);
    gate.fill({ color: PALETTE.structureLight });
    gate.roundRect(gx - 2.5, 43 - 22, 5, 22, 2);
    gate.stroke({ width: 1, color: PALETTE.orange, alpha: 0.9 });
  }
  gate.roundRect(-19, 43 - 22 - 5, 38, 5, 2);
  gate.fill({ color: PALETTE.structure });
  gate.roundRect(-19, 43 - 22 - 5, 38, 5, 2);
  gate.stroke({ width: 1.2, color: PALETTE.orange, alpha: 0.9 });
  // Threshold chevrons pointing inward (north).
  for (let c = 0; c < 3; c++) {
    const cy = 38 - c * 7;
    gate.moveTo(-6, cy + 3);
    gate.lineTo(0, cy - 2);
    gate.lineTo(6, cy + 3);
    gate.stroke({ width: 1.5, color: PALETTE.orange, alpha: 0.6 });
  }
  root.addChild(gate);

  // Sine-terrain strip: a tiny test market landscape.
  const terrain = new Graphics();
  for (let i = 0; i <= 24; i++) {
    const px = -62 + i * 3;
    const py = 12 + Math.sin(i * 0.7) * 6;
    if (i === 0) terrain.moveTo(px, py);
    else terrain.lineTo(px, py);
  }
  terrain.stroke({ width: 2, color: PALETTE.aqua, alpha: 0.8 });
  root.addChild(terrain);

  // Two test candles on pedestals.
  [PALETTE.cyan, PALETTE.magenta].forEach((color, i) => {
    const bx = -44 + i * 24;
    root.addChild(isoCylinder({ x: bx, y: -18, r: 5, h: 6, color: PALETTE.structure }));
    const candle = new Graphics();
    candle.rect(bx - 2, -32, 4, 8);
    candle.fill({ color, alpha: 0.9 });
    root.addChild(candle);
  });

  // Test loop: one lane where a micro runner dot circles (~4 s).
  const track = new Graphics();
  track.ellipse(38, 6, 32, 15);
  track.stroke({ width: 2, color: PALETTE.structureLight, alpha: 0.9 });
  root.addChild(track);
  const racer = new Sprite(dotTexture());
  racer.anchor.set(0.5);
  racer.width = 8;
  racer.height = 8;
  racer.tint = PALETTE.yellow;
  root.addChild(racer);

  const off = ctx.onTick(() => {
    if (ctx.reducedMotion) return;
    const t = performance.now() / 1000;
    const a = (t / 4) * Math.PI * 2;
    racer.position.set(38 + Math.cos(a) * 30, 6 + Math.sin(a) * 13.5);
  });
  ctx.onCleanup(off);

  // Test-market bubbles grow and pop on staggered ~11 s cycles. Bubbles are
  // drawn once; only scale and alpha animate.
  const bubbles: Container[] = [];
  for (let i = 0; i < 2; i++) {
    const b = new Graphics();
    b.circle(0, 0, 3);
    b.stroke({ width: 1.2, color: PALETTE.aqua, alpha: 0.9 });
    b.circle(-1, -1, 0.9);
    b.fill({ color: PALETTE.aqua, alpha: 0.8 });
    b.position.set(-38 + i * 18, 10 - i * 3);
    b.alpha = 0;
    root.addChild(b);
    bubbles.push(b);
  }
  const bubbleTweens: Array<gsap.core.Timeline> = [];
  bubbles.forEach((b, i) => {
    if (ctx.reducedMotion) return;
    const cycle = 11 + i * 2.4;
    const tl = gsap.timeline({ repeat: -1, delay: i * 4.5 });
    tl.fromTo(
      b,
      { alpha: 0, scale: 0.4 },
      { alpha: 0.95, scale: 1.5, duration: cycle * 0.5, ease: "sine.in" },
    )
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
// Budget Planning: gold-trimmed lectern. Subordinate side branch: small,
// quiet, one stacked plan and one slider.
// ---------------------------------------------------------------------------

function buildBudgetPlanning(ctx: DioramaContext): void {
  const root = stationBase(ctx, "budgetPlanning", 60, { signY: 428 });

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

  const nudge = window.setInterval(() => {
    if (ctx.reducedMotion) return;
    gsap.fromTo(
      knob,
      { x: -6 },
      { x: 4, duration: 0.8, ease: "power2.inOut", yoyo: true, repeat: 1 },
    );
  }, 6000);
  ctx.onCleanup(() => window.clearInterval(nudge));
  registerStation({ id: "budgetPlanning", root, hit: root.hit });
}

// ---------------------------------------------------------------------------
// Decision Table: the district's single decision endpoint. Round table,
// holo ring, pooled proposal cards (DecisionTableApi).
// ---------------------------------------------------------------------------

const MAX_PROPOSALS = 4;

function buildDecisionTable(ctx: DioramaContext): void {
  const root = stationBase(ctx, "decisionTable", 70, { signY: 500 });

  contactShadow(root, 0, 28, 186, 80);

  // Round table: iso ellipse platform on a pedestal, pale rim.
  root.addChild(isoCylinder({ x: 0, y: 30, r: 14, h: 14, color: PALETTE.structure }));
  const tableTop = new Graphics();
  tableTop.ellipse(0, 16, 88, 44);
  tableTop.fill({ color: PALETTE.structureLight });
  tableTop.ellipse(0, 16, 88, 44);
  tableTop.stroke({ width: 2, color: PALETTE.surfacePale, alpha: 0.8 });
  tableTop.ellipse(0, 16, 70, 34);
  tableTop.stroke({ width: 1, color: PALETTE.cyan, alpha: 0.22 });
  root.addChild(tableTop);
  root.addChild(glow(0, 14, 120, PALETTE.blue, 0.1));

  // Decision surface: one card outline laid on the table marking where the
  // chosen proposal is read. Static, quiet; the cards carry the event.
  const slot = new Graphics();
  slot.roundRect(-14, -4, 28, 20, 2);
  slot.stroke({ width: 1.2, color: PALETTE.orange, alpha: 0.55 });
  slot.rotation = -0.08;
  root.addChild(slot);

  // Holo ring above the table; idle shimmer kept, contrast lowered so the
  // endpoint stays crisp without competing with the landmark tiers.
  const ring = new Graphics();
  ring.ellipse(0, -34, 60, 20);
  ring.stroke({ width: 2, color: PALETTE.blue, alpha: 0.5 });
  ring.ellipse(0, -34, 46, 14);
  ring.stroke({ width: 1, color: PALETTE.cyan, alpha: 0.35 });
  ring.blendMode = "add";
  root.addChild(ring);

  root.addChild(statusLight(-84, 20, PALETTE.healthy, ctx, 0.05));

  // Witness plate where the reviewing strategist stands
  // (s-proposals-appear lands strategy-2 at near("decisionTable",-40,25));
  // captioned so the lone plate reads as a stand, not a stray puck.
  ctx.layers.ground.addChild(footPlate(970, 650, PALETTE.violet));
  const reviewLabel = microText("REVIEW", 7, PALETTE.inkDim);
  reviewLabel.anchor.set(0.5);
  reviewLabel.position.set(970, 667);
  ctx.layers.ground.addChild(reviewLabel);

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
          {
            x: fanX,
            y: fanY,
            alpha: 1,
            rotation: angle * 0.4,
            duration: 0.45,
            ease: "back.out(1.6)",
          },
          i * 0.08,
        );
        if (i === chosen) {
          // Chosen card rises + pops warm.
          timeline.to(card, { y: fanY - 16, duration: 0.4, ease: "power2.out" }, 0.6);
          timeline.to(card, { alpha: 1, duration: 0.3 }, 0.6);
          const body = card.getChildAt(0) as Graphics;
          timeline.call(
            () => {
              body.clear();
              body.roundRect(-19, -26, 38, 52, 3);
              body.fill({ color: PALETTE.structureLight, alpha: 0.98 });
              body.roundRect(-19, -26, 38, 52, 3);
              body.stroke({ width: 3, color: PALETTE.orange, alpha: 1 });
            },
            undefined,
            0.6,
          );
        } else if (i === rejected) {
          // Rejected lead card flashes a red refusal trim, then retracts.
          const body = card.getChildAt(0) as Graphics;
          timeline.call(
            () => {
              body.clear();
              body.roundRect(-19, -26, 38, 52, 3);
              body.fill({ color: PALETTE.structure, alpha: 0.95 });
              body.roundRect(-19, -26, 38, 52, 3);
              body.stroke({ width: 2.5, color: PALETTE.blocked, alpha: 1 });
            },
            undefined,
            0.55,
          );
          timeline.to(
            card,
            { x: fanX * 0.3, y: 6, alpha: 0, duration: 0.5, ease: "power2.in" },
            0.95,
          );
        } else {
          // Others dim to a cool tone and slide back / retract.
          const body = card.getChildAt(0) as Graphics;
          timeline.call(
            () => {
              body.clear();
              body.roundRect(-19, -26, 38, 52, 3);
              body.fill({ color: PALETTE.structure, alpha: 0.8 });
              body.roundRect(-19, -26, 38, 52, 3);
              body.stroke({ width: 1.2, color: PALETTE.blue, alpha: 0.55 });
            },
            undefined,
            0.7,
          );
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
    ring.alpha = 0.4 + 0.25 * breathe(t, 6, 0);
  });
  ctx.onCleanup(off);
}

// ---------------------------------------------------------------------------
// Scatter props: crates, a rolled chart, planters with glowing reeds.
// Spots verified against station footprints, rails, the research walkway,
// and the market-landscape band (x 220-1100 above y ~267 stays clear).
// ---------------------------------------------------------------------------

function scatterProps(ctx: DioramaContext): void {
  const rnd = seededRandom(11);
  const layer = ctx.layers.sortable;

  const spots: Array<{ x: number; y: number }> = [
    { x: 465, y: 322 },
    { x: 465, y: 432 },
    { x: 706, y: 300 },
    { x: 706, y: 420 },
    { x: 620, y: 545 },
    { x: 872, y: 540 },
    { x: 1120, y: 470 },
    { x: 1125, y: 335 },
    { x: 250, y: 440 },
    // Kept east of x ~330: the RESEARCH ONLY gate's leads text extends to
    // roughly x 305 at y ~665, and the walkway terminus sits at (330,590).
    { x: 335, y: 668 },
    { x: 560, y: 640 },
    { x: 850, y: 655 },
    { x: 950, y: 502 },
    { x: 455, y: 270 },
  ];

  spots.forEach((spot, i) => {
    const root = new Container();
    root.position.set(spot.x + (rnd() - 0.5) * 14, spot.y + (rnd() - 0.5) * 10);
    root.zIndex = spot.y + DEPTH.base;
    const kind = i % 3;
    if (kind === 0) {
      // Crate.
      const s = 16 + rnd() * 8;
      root.addChild(
        isoBox({
          x: 0,
          y: 0,
          w: s,
          d: s * 0.6,
          h: s * 0.6,
          color: PALETTE.structure,
          rim: PALETTE.structureLight,
          rimAlpha: 0.4,
        }),
      );
    } else if (kind === 1) {
      // Rolled chart: a small cylinder on its side look via low cylinder.
      root.addChild(
        isoCylinder({ x: 0, y: 0, r: 8, h: 6, color: PALETTE.surfacePale, alpha: 0.85 }),
      );
    } else {
      // Planter with quiet reeds: no additive glow. Glowing freestanding
      // props read as ambiguous status pucks; planters are garden texture.
      root.addChild(isoBox({ x: 0, y: 0, w: 18, d: 11, h: 8, color: PALETTE.structure }));
      const reeds = new Graphics();
      const reedColor = rnd() > 0.5 ? PALETTE.violet : PALETTE.cyan;
      for (let r = 0; r < 3; r++) {
        const rx = -5 + r * 5;
        reeds.moveTo(rx, -8);
        reeds.lineTo(rx + (rnd() - 0.5) * 4, -22 - rnd() * 6);
        reeds.stroke({ width: 1.5, color: reedColor, alpha: 0.5 });
      }
      root.addChild(reeds);
    }
    layer.addChild(root);
  });
}

// ---------------------------------------------------------------------------
// Evidence tier apron: one shared ground pad tying the twin consoles
// (marketData west, researchTools east) into a single evidence tier.
// ---------------------------------------------------------------------------

function buildEvidenceApron(ctx: DioramaContext): void {
  groundPad(ctx, 705, 330, 420, 82, PALETTE.cyan, 0.22);
}

// ---------------------------------------------------------------------------

export function buildResearchDistrict(ctx: DioramaContext): void {
  buildEvidenceApron(ctx);
  buildMissionBoard(ctx);
  buildMarketData(ctx);
  buildResearchTools(ctx);
  buildStrategyLab(ctx);
  buildSandbox(ctx);
  buildBudgetPlanning(ctx);
  buildDecisionTable(ctx);
  scatterProps(ctx);
}
