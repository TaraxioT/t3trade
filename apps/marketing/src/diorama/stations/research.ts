/**
 * West section, research row: the RESEARCH & AGENTS row along the N-W wall
 * and the south-west wedge. Owner: west lane.
 *
 * Reading order, one door-to-decision story:
 * - RESEARCH ONLY GATE is the room's entrance: a door frame mounted proud of
 *   the N-W wall inner face (the s-spring-gate bonk lives at its threshold).
 * - MARKET DATA and RESEARCH TOOLS are the paired evidence tier: twin console
 *   walls on one shared apron, fed by typed data-source ports (the merged-in
 *   MCP tool-console language). Market Data absorbs the old market-data
 *   tool consoles; Research Tools absorbs the research API consoles.
 * - STRATEGY LAB is the synthesis tier: a light table with a convene apron on
 *   its room side. MARKET STRUCTURE is the unbranded constant-product concept
 *   model (never a venue or execution route).
 * - MISSION BOARD is the initiating landmark of the wedge; SANDBOX is the
 *   signer-free test bay. DECISION TABLE is the decision endpoint.
 * - BUDGET PLAN is a subordinate lectern branch.
 *
 * All statics are built once; ambient motion runs through ctx.onTick with
 * per-station phase offsets, GSAP only for brief state transitions. Station
 * signs sit in the labels layer above each structure, clear of the
 * market-landscape relief band that occupies the wall face between world
 * (620,530) and (1060,310).
 */
import { Container, Graphics, Sprite, Text, TextStyle } from "pixi.js";
import gsap from "gsap";
import type { DioramaContext } from "../core/context.js";
import { registerStation } from "../core/registry.js";
import { STATIONS } from "../config/stations.js";
import { PALETTE } from "../config/palette.js";
import { seededRandom, DEPTH } from "../config/world.js";
import { dotTexture, glow, isoBox, isoCylinder, isoTile, isoWall, screenPanel } from "../core/iso.js";
import { makeSign } from "../core/signs.js";

export interface DecisionTableApi {
  /** Show N proposal cards, highlight index, retract the rest. */
  showProposals(count: number, chosenIndex: number): void;
  clearProposals(): void;
}

export interface MissionBoardApi {
  setPhase(phase: string): void;
}

/** Market Structure concept-model pulses: pool depth or quote comparison. */
export interface LiquidityResearchApi {
  pulse(kind: "pool" | "quote"): void;
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
  // (top-row stations must clear the wall relief band); signHalo false drops
  // the wide soft halo where it would wash a neighbor's screens.
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
 * structure sits on the floor instead of floating over it. Coordinates are
 * root-local (research roots are positioned at their anchor).
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
 * convene apron on the room side of the strategy lab.
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

/**
 * Typed data-source port stand (the merged-in MCP tool-console language): a
 * small pedestal with a socket that hops a data dot up to the console wall on
 * a slow local loop. Ports are data sources only; nothing here routes toward
 * execution.
 */
function dataPort(
  root: Container,
  ctx: DioramaContext,
  lx: number,
  ly: number,
  accent: number,
  caption: string,
  hopIndex: number,
): void {
  root.addChild(isoCylinder({ x: lx, y: ly, r: 5.5, h: 11, color: PALETTE.structureLight, rim: accent }));
  const socket = new Graphics();
  socket.circle(lx, ly - 15, 4.5);
  socket.fill({ color: accent, alpha: 0.3 });
  socket.circle(lx, ly - 15, 4.5);
  socket.stroke({ width: 1.5, color: accent, alpha: 0.95 });
  socket.circle(lx, ly - 15, 1.8);
  socket.fill({ color: accent });
  root.addChild(socket);
  const cap = microText(caption, 6, PALETTE.inkDim);
  cap.anchor.set(0.5);
  cap.position.set(lx, ly + 14);
  root.addChild(cap);

  if (ctx.reducedMotion) return;
  const dot = new Sprite(dotTexture());
  dot.anchor.set(0.5);
  dot.width = 7;
  dot.height = 7;
  dot.tint = accent;
  dot.alpha = 0;
  root.addChild(dot);
  // Local hop: a data dot leaps from the port toward the wall consoles and
  // fades. Staggered per port so the apron never syncs up.
  const targetX = lx < 0 ? lx + 16 : lx - 16;
  const hop = gsap.timeline({ repeat: -1, delay: 3 + hopIndex * 5.5 });
  hop.call(() => {
    dot.position.set(lx, ly - 16);
    dot.alpha = 0.9;
  });
  hop.to(dot.position, { x: targetX, y: ly - 46, duration: 0.9, ease: "power1.inOut" });
  hop.to(dot, { alpha: 0, duration: 0.25 });
  hop.to({}, { duration: 7 + hopIndex * 3.5 });
  ctx.onCleanup(() => hop.kill());
}

// ---------------------------------------------------------------------------
// Research Only Gate: the room's ENTRANCE DOOR on the N-W wall. The frame is
// mounted proud of the wall inner face (same mounting depth as the market
// landscape relief), the opening faces the room, and the spring flap at the
// top of the opening is the leaf that bonks in s-spring-gate. No key glyph
// anywhere: research never needs a signer.
// ---------------------------------------------------------------------------

function buildResearchOnlyGate(ctx: DioramaContext): void {
  const def = STATIONS.researchOnlyGate;
  const root = stationBase(ctx, "researchOnlyGate", 84, {
    signDx: -20,
    signY: def.anchor.y - 135,
  });

  // Wall-plane local frame: the anchor sits ~56 units into the room from the
  // N-W wall base (x + 2y = 1684); the door plane rides the face, proud 10.
  const door = { x: -20.5, y: -41 };
  // Unit vector along the wall toward the N corner (2:1 iso edge).
  const ux = 0.894;
  const uy = -0.447;
  const jambA = { x: door.x - 32 * ux, y: door.y - 32 * uy };
  const jambB = { x: door.x + 32 * ux, y: door.y - 32 * uy };

  contactShadow(root, door.x, door.y + 6, 124, 44, 0.22);

  // Doorway void: dark inset panel in the wall plane between the jambs.
  const doorVoid = new Graphics();
  doorVoid.poly([
    jambA.x, jambA.y,
    jambB.x, jambB.y,
    jambB.x, jambB.y - 72,
    jambA.x, jambA.y - 72,
  ]);
  doorVoid.fill({ color: PALETTE.space, alpha: 0.6 });
  doorVoid.poly([
    jambA.x + 4, jambA.y - 4,
    jambB.x - 4, jambB.y - 4,
    jambB.x - 4, jambB.y - 68,
    jambA.x + 4, jambA.y - 68,
  ]);
  doorVoid.stroke({ width: 1, color: PALETTE.cyan, alpha: 0.22 });
  root.addChild(doorVoid);

  // Threshold strip on the floor at the wall base plus a soft open glow.
  const threshold = new Graphics();
  threshold.moveTo(jambA.x - 4, jambA.y);
  threshold.lineTo(jambB.x + 4, jambB.y);
  threshold.stroke({ width: 2.5, color: PALETTE.cyan, alpha: 0.8 });
  root.addChild(threshold);
  root.addChild(glow(door.x, door.y + 2, 42, PALETTE.cyan, 0.16));

  // Jambs: vertical posts rising from the wall base, cyan trimmed.
  for (const j of [jambA, jambB]) {
    const post = new Graphics();
    post.roundRect(j.x - 3, j.y - 78, 6, 78, 2);
    post.fill({ color: PALETTE.structureLight });
    post.roundRect(j.x - 3, j.y - 78, 6, 78, 2);
    post.stroke({ width: 1, color: PALETTE.cyan, alpha: 0.85 });
    post.ellipse(j.x, j.y + 1, 7, 3.5);
    post.fill({ color: PALETTE.structure });
    root.addChild(post);
  }

  // Header: diagonal beam in the wall plane spanning the jamb tops, with a
  // keystone tick at its center.
  const header = new Graphics();
  header.poly([
    jambA.x - 4, jambA.y - 78,
    jambB.x + 4, jambB.y - 78,
    jambB.x + 4, jambB.y - 89,
    jambA.x - 4, jambA.y - 89,
  ]);
  header.fill({ color: PALETTE.structure });
  header.poly([
    jambA.x - 4, jambA.y - 78,
    jambB.x + 4, jambB.y - 78,
    jambB.x + 4, jambB.y - 89,
    jambA.x - 4, jambA.y - 89,
  ]);
  header.stroke({ width: 1.2, color: PALETTE.cyan, alpha: 0.9 });
  header.roundRect(door.x - 5, door.y - 93, 10, 7, 2);
  header.fill({ color: PALETTE.structureLight });
  header.roundRect(door.x - 5, door.y - 93, 10, 7, 2);
  header.stroke({ width: 1, color: PALETTE.cyan, alpha: 0.8 });
  root.addChild(header);

  // Spring flap: the leaf hanging ajar from the header. This is the gate the
  // sandbox bot bonks in s-spring-gate; it rests ajar so the comedy beat
  // reads even with zero animation.
  const flap = new Container();
  flap.position.set(door.x + 6, door.y - 68);
  const leaf = new Graphics();
  leaf.roundRect(-9, 0, 18, 26, 2);
  leaf.fill({ color: PALETTE.structureLight, alpha: 0.92 });
  leaf.roundRect(-9, 0, 18, 26, 2);
  leaf.stroke({ width: 1, color: PALETTE.cyan, alpha: 0.7 });
  leaf.moveTo(-4, 18);
  leaf.lineTo(4, 12);
  leaf.moveTo(-4, 12);
  leaf.lineTo(4, 6);
  leaf.stroke({ width: 1, color: PALETTE.cyan, alpha: 0.45 });
  flap.addChild(leaf);
  flap.rotation = 0.28;
  root.addChild(flap);

  // Signpost booth beside the door: small pedestal with a flask glyph (the
  // signer-free promise). Stands on the floor just inside the west jamb.
  root.addChild(
    isoBox({ x: -58, y: 2, w: 26, d: 20, h: 16, color: PALETTE.structure, rim: PALETTE.cyan }),
  );
  const flask = new Graphics();
  flask.poly([-2, -8, 2, -8, 2, -3, 6, 5, -6, 5, -2, -3]);
  flask.fill({ color: PALETTE.cyan, alpha: 0.9 });
  flask.rect(-1.2, -10, 2.4, 2);
  flask.fill({ color: PALETTE.cyan });
  flask.position.set(-58, -14);
  root.addChild(flask);

  // Dashed welcome path leading from the threshold into the room (toward the
  // mission board), fading with distance.
  const path = new Graphics();
  for (let k = 0; k < 5; k++) {
    const px = door.x + 8 + k * 7.2;
    const py = door.y + 14 + k * 14.3;
    path.moveTo(px - 3.2, py - 6.4);
    path.lineTo(px + 3.2, py + 6.4);
    path.stroke({ width: 2.5, color: PALETTE.cyan, alpha: 0.7 - k * 0.13 });
  }
  root.addChild(path);

  // One-line destination row beneath the door: real Text, not baked.
  const leads = microText("CHARTS \u00b7 ALERTS \u00b7 BACKTESTS \u00b7 SIMS", 6, PALETTE.ink);
  leads.anchor.set(0.5);
  leads.position.set(-6, 12);
  root.addChild(leads);

  // Keystone beacon marks the entrance from fit zoom.
  root.addChild(beacon(door.x, door.y - 90, PALETTE.cyan, ctx, 0.25));

  registerStation({ id: "researchOnlyGate", root, hit: root.hit });
}

// ---------------------------------------------------------------------------
// Market Data: quantitative feed wall (absorbs the tool consoles). Twin of
// Research Tools; content family = numbers, ticks, gauges. The merged-in MCP
// console language lives on the front apron: typed CANDLES and BOOK ports hop
// data dots up to the wall, and a live ticker strip runs along the wall base.
// ---------------------------------------------------------------------------

function buildMarketData(ctx: DioramaContext): void {
  const root = stationBase(ctx, "marketData", 50);

  contactShadow(root, 0, 26, 200, 64);
  const base = isoBox({
    x: 0,
    y: 14,
    w: 186,
    d: 46,
    h: 12,
    color: PALETTE.structure,
    rim: PALETTE.cyan,
    rimAlpha: 0.55,
  });
  root.addChild(base);

  // Dark backdrop wall the screens mount on; the wall relief band above ends
  // at world y ~427 at this longitude, so the sign band at 494 sits between
  // the relief and the console wall top (520).
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
        g.fill({ color: PALETTE.violet, alpha: 0.75 });
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

  // Absorbed from the old tool consoles: a live price ticker strip along the wall
  // base under the screens. Drawn once; only the fill width animates.
  const tickerTrack = new Graphics();
  tickerTrack.rect(-84, 8, 168, 5);
  tickerTrack.fill({ color: PALETTE.blue, alpha: 0.3 });
  root.addChild(tickerTrack);
  const tickerFill = new Graphics();
  tickerFill.rect(-84, 8, 112, 5);
  tickerFill.fill({ color: PALETTE.blue, alpha: 0.75 });
  root.addChild(tickerFill);

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

  // Typed data-source ports on the front apron (merged-in tool-console
  // language): candles and book feeds hop local dots up to the wall.
  dataPort(root, ctx, -62, 36, PALETTE.cyan, "CANDLES", 0);
  dataPort(root, ctx, 62, 36, PALETTE.blue, "BOOK", 1);

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

  // Every ~4 s the feed refreshes: candles roll, the price ticks, the ticker
  // strip advances, and the book rows flash. Rare redraw plus text/width
  // swaps; clearly simulated.
  const feedTimer = window.setInterval(() => {
    for (let i = 0; i < 3; i++) {
      candleData[i] = 3 + Math.round(Math.random() * 6);
    }
    if (candles[0]) drawCandles(candles[0], candleData);
    price.text = (1.02 + (candleData[0] + candleData[1] + candleData[2]) / 300).toFixed(4);
    if (!ctx.reducedMotion) {
      const w = 84 + Math.random() * 70;
      tickerFill.scale.x = w / 112;
      gsap.fromTo(
        tickerFill,
        { alpha: 1 },
        { alpha: 0.75, duration: 0.6, ease: "power1.inOut" },
      );
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
// Research Tools: qualitative document wall (absorbs the API consoles). Twin
// of Market Data; content family = headlines, tokens, protocol layers,
// history rows. The merged-in tool ports (NEWS, TOKENS) feed the wall.
// ---------------------------------------------------------------------------

const NEWS_LINES = ["LIQ UP", "FUND +", "RANGE"];

function buildResearchTools(ctx: DioramaContext): void {
  const root = stationBase(ctx, "researchTools", 46);

  contactShadow(root, 0, 40, 200, 64);
  const base = isoBox({
    x: 0,
    y: 34,
    w: 180,
    d: 44,
    h: 12,
    color: PALETTE.structure,
    rim: PALETTE.cyan,
    rimAlpha: 0.55,
  });
  root.addChild(base);

  // Backdrop wall mirroring marketData's construction (twin tier language):
  // screens aligned with marketData's screen row; the sign band above clears
  // the wall relief band (relief bottom at world y ~347 at this longitude).
  const wall = new Graphics();
  wall.roundRect(-90, -52, 180, 76, 6);
  wall.fill({ color: PALETTE.space, alpha: 0.8 });
  wall.roundRect(-90, -52, 180, 76, 6);
  wall.stroke({ width: 1.5, color: PALETTE.cyan, alpha: 0.3 });
  root.addChild(wall);

  const captions = ["NEWS", "TOKENS", "PROTO", "HISTORY"];
  const seats = [
    { x: -64, y: -20 },
    { x: -21, y: -20 },
    { x: 21, y: -20 },
    { x: 64, y: -20 },
  ];
  const scanLine = new Graphics();
  scanLine.moveTo(-11, -12);
  scanLine.lineTo(11, -12);
  scanLine.stroke({ width: 1.5, color: PALETTE.cyan, alpha: 0.8 });
  scanLine.blendMode = "add";
  const headlines: Text[] = [];

  seats.forEach((seat, i) => {
    const panel = screenPanel({ x: -15, y: -13, w: 30, h: 26, accent: PALETTE.cyan });
    panel.position.set(seat.x, seat.y);
    panel.rotation = (i - 1.5) * 0.024;
    root.addChild(panel);
    const caption = microText(captions[i], 6.5, PALETTE.inkDim);
    caption.anchor.set(0.5);
    caption.position.set(seat.x, 6);
    root.addChild(caption);

    if (i === 0) {
      // News screen: three real text tickers, one rotating highlight.
      NEWS_LINES.forEach((line, h) => {
        const t = microText(line, 6.5, h === 0 ? PALETTE.ink : PALETTE.inkDim);
        t.anchor.set(0, 0.5);
        t.position.set(-12, -6 + h * 7);
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
    } else if (i === 2) {
      // Protocol screen: layered stack, the merged-in protocol-research
      // content (blurb: "protocol research").
      const stack = new Graphics();
      for (let l = 0; l < 4; l++) {
        stack.roundRect(-11 + l * 1.5, 6 - l * 5, 22 - l * 3, 3.4, 1);
        stack.fill({ color: PALETTE.blue, alpha: 0.45 + l * 0.15 });
      }
      panel.addChild(stack);
    } else {
      // History screen: backtest rows with a passing scan line.
      const bars = new Graphics();
      for (let b = 0; b < 5; b++) {
        const h = 4 + ((b * 5) % 9);
        bars.rect(-12 + b * 5.5, 8 - h, 3.5, h);
        bars.fill({ color: PALETTE.blue, alpha: 0.55 + b * 0.08 });
      }
      panel.addChild(bars);
      panel.addChild(scanLine);
    }
  });

  // Typed research-source ports on the front apron (merged-in tool-console
  // language): news and token feeds hop local dots up to the wall.
  dataPort(root, ctx, -52, 42, PALETTE.cyan, "NEWS", 0);
  dataPort(root, ctx, 52, 42, PALETTE.violet, "TOKENS", 1);

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
// Strategy Lab: synthesis workspace. Light table + candidate racks; the
// convene apron with footplates sits on the room side (south) of the table
// where the synthesis story lands its researchers.
// ---------------------------------------------------------------------------

function buildStrategyLab(ctx: DioramaContext): void {
  const def = STATIONS.strategyLab;
  // Sign nudged east and low: it must clear the wall relief's east backing
  // slab (world ~(1074,302)) while staying above the table.
  const root = stationBase(ctx, "strategyLab", 66, {
    signDx: 16,
    signY: def.anchor.y - 85,
    signHalo: false,
  });

  contactShadow(root, 0, 6, 120, 76);
  // Central light-table: pale top, low body, violet inlay strip.
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
  warmInlay.stroke({ width: 1.5, color: PALETTE.violet, alpha: 0.75 });
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

  // Gathering apron (ground layer) on the room side of the table, with
  // footplates at the synthesis convene points; anchor-relative so anchor
  // deltas move it with the table.
  const ax = def.anchor.x;
  const ay = def.anchor.y;
  groundPad(ctx, ax, ay + 90, 90, 62, PALETTE.violet, 0.35);
  ctx.layers.ground.addChild(footPlate(ax - 18, ay + 80, PALETTE.cyan));
  ctx.layers.ground.addChild(footPlate(ax + 18, ay + 98, PALETTE.blue));
  const apronLabel = microText("EVIDENCE", 7, PALETTE.inkDim);
  apronLabel.anchor.set(0.5);
  apronLabel.position.set(ax, ay + 124);
  ctx.layers.ground.addChild(apronLabel);

  registerStation({ id: "strategyLab", root, hit: root.hit });
}

// ---------------------------------------------------------------------------
// Market Structure: the unbranded constant-product concept model (re-imaged
// from the retired venue pavilion, product-neutral cyan/violet). An AMM
// x*y=k curve pane with a marker sliding along it, two pool-depth bubble
// columns that breathe slowly, and a two-line quote comparison readout. It is
// an unconnected research exhibit: nothing here routes toward execution.
// pulse() bounces the bubbles (pool) or slides the marker to the next
// comparison point and brightens the readout (quote).
// ---------------------------------------------------------------------------

/** One-shot glow flash: peak alpha fading back to rest. */
function blip(target: Sprite, ctx: DioramaContext, peak: number, delay: number, fade: number): void {
  if (ctx.reducedMotion) {
    target.alpha = peak * 0.6;
    gsap.to(target, { alpha: 0, duration: 0.3, ease: "none", delay });
    return;
  }
  gsap.fromTo(target, { alpha: peak }, { alpha: 0, duration: fade, ease: "power2.out", delay });
}

function buildMarketStructure(ctx: DioramaContext): void {
  const root = stationBase(ctx, "liquidityResearch", 118);

  contactShadow(root, 0, 24, 216, 116);
  // Exhibit pad: violet trim sets the concept model off the cyan evidence
  // tier; interior inset darkens the stage.
  root.addChild(isoTile(0, 12, 208, 124, PALETTE.structure, 1, PALETTE.violet));
  root.addChild(isoTile(0, 13, 164, 92, PALETTE.space, 0.4));

  // Back wall: two low segments meeting at the north corner of the pad
  // (open top, open south face so the exhibit stays walkable and readable).
  for (const edge of [
    { x1: -104, y1: 12, x2: 0, y2: -40 },
    { x1: 0, y1: -40, x2: 104, y2: 12 },
  ]) {
    root.addChild(isoWall({ ...edge, h: 40, color: PALETTE.structure, alpha: 0.96, rim: PALETTE.violet }));
  }

  // Header board crowning the wall corner: no brand mark, only the model's
  // own curve glyph and formula, with an honesty caption underneath.
  root.addChild(glow(0, -100, 60, PALETTE.violet, 0.1));
  const board = new Graphics();
  board.roundRect(-40, -117, 80, 34, 6);
  board.fill({ color: PALETTE.space, alpha: 0.72 });
  board.roundRect(-40, -117, 80, 34, 6);
  board.stroke({ width: 1.75, color: PALETTE.violet, alpha: 0.9 });
  board.roundRect(-38, -115, 76, 30, 5);
  board.stroke({ width: 0.75, color: PALETTE.ink, alpha: 0.16 });
  // Mini curve glyph: axes plus a short hyperbola arc.
  board.moveTo(-32, -96);
  board.lineTo(-14, -96);
  board.moveTo(-32, -96);
  board.lineTo(-32, -112);
  board.stroke({ width: 1, color: PALETTE.inkDim, alpha: 0.4 });
  board.moveTo(-30, -110);
  board.quadraticCurveTo(-16, -108, -15, -98);
  board.stroke({ width: 1.5, color: PALETTE.cyan, alpha: 0.9 });
  root.addChild(board);
  const formula = microText("X\u00b7Y=K", 8, PALETTE.cyan);
  formula.anchor.set(0, 0.5);
  formula.position.set(-8, -104);
  root.addChild(formula);
  const cap = microText("CONCEPT MODEL", 6, PALETTE.inkDim);
  cap.anchor.set(0, 0.5);
  cap.position.set(-8, -94);
  root.addChild(cap);

  // Pool-depth bubble columns: two depth gauges whose fills became columns
  // of slowly breathing bubbles; flash halos rest dormant until a pulse.
  const gaugeFlashes: Sprite[] = [];
  const bubbleCols: Sprite[][] = [];
  const breatheBubble = (b: Sprite, delay: number): void => {
    gsap.killTweensOf(b);
    b.alpha = 0.42;
    gsap.to(b, { alpha: 0.68, duration: 3.4, yoyo: true, repeat: -1, ease: "sine.inOut", delay });
  };
  for (const [i, gx] of [-58, 58].entries()) {
    const level = i === 0 ? 0.62 : 0.47;
    root.addChild(
      isoCylinder({ x: gx, y: -4, r: 6.5, h: 30, color: PALETTE.structureLight, rim: PALETTE.violet }),
    );
    // Depth ticks along each column keep the gauge reading.
    const marks = new Graphics();
    for (let t = 1; t <= 3; t++) {
      const ty = -4 - 8 * t;
      marks.moveTo(gx - 7.5, ty);
      marks.lineTo(gx - 5, ty);
      marks.stroke({ width: 1, color: PALETTE.inkDim, alpha: 0.5 });
    }
    root.addChild(marks);
    const col: Sprite[] = [];
    for (let b = 0; b < 3; b++) {
      const bubble = glow(gx, -4 - 30 * level * ((b + 0.8) / 3.1), 9 - b * 1.6, PALETTE.violet, 0.55);
      col.push(bubble);
      root.addChild(bubble);
      if (!ctx.reducedMotion) breatheBubble(bubble, i * 0.9 + b * 0.55);
    }
    bubbleCols.push(col);
    const flash = glow(gx, -16, 28, PALETTE.violet, 0);
    gaugeFlashes.push(flash);
    root.addChild(flash);
  }

  // AMM constant-product pane floating between the header board and the
  // console: a soft x*y=k arc with a marker sliding along it and violet
  // comparison ticks at the quote pulse targets.
  const amm = new Container();
  amm.position.set(0, -46);
  const ammW = 72;
  const ammH = 48;
  const ammG = new Graphics();
  ammG.roundRect(-ammW / 2, -ammH / 2, ammW, ammH, 5);
  ammG.fill({ color: PALETTE.space, alpha: 0.55 });
  ammG.roundRect(-ammW / 2, -ammH / 2, ammW, ammH, 5);
  ammG.stroke({ width: 1.2, color: PALETTE.cyan, alpha: 0.7 });
  // Axis hints: price against reserve.
  ammG.moveTo(-ammW / 2 + 6, ammH / 2 - 5);
  ammG.lineTo(ammW / 2 - 5, ammH / 2 - 5);
  ammG.moveTo(-ammW / 2 + 6, ammH / 2 - 5);
  ammG.lineTo(-ammW / 2 + 6, -ammH / 2 + 5);
  ammG.stroke({ width: 1, color: PALETTE.inkDim, alpha: 0.4 });
  // The curve: parameter t in [0,1] traces x*y=k (u the reserve share, 1/u
  // the price it implies), mapped into the pane; 16 segments.
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
  ammG.stroke({ width: 1.5, color: PALETTE.cyan, alpha: 0.85 });
  // Comparison ticks at the quote-pulse targets (t = 0.3, 0.55, 0.8).
  for (const t of [0.3, 0.55, 0.8]) {
    const p = curvePt(t);
    ammG.moveTo(p.px, p.py - 4);
    ammG.lineTo(p.px, p.py + 4);
    ammG.stroke({ width: 2, color: PALETTE.violet, alpha: 0.55 });
  }
  amm.addChild(ammG);
  const marker = glow(0, 0, 9, PALETTE.cyan, 0.9);
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

  // Front console on the open south side: the stand researchers gather
  // around, carrying the quote comparison readout.
  root.addChild(isoBox({ x: 0, y: 34, w: 112, d: 30, h: 14, color: PALETTE.structure }));
  root.addChild(
    (() => {
      const g = new Graphics();
      g.moveTo(-56, 41);
      g.lineTo(0, 48);
      g.lineTo(56, 41);
      g.stroke({ width: 2, color: PALETTE.violet, alpha: 0.85 });
      g.blendMode = "add";
      return g;
    })(),
  );
  const screen = screenPanel({ x: -30, y: 4, w: 60, h: 20, accent: PALETTE.cyan });
  root.addChild(screen);

  // Quote comparison readout: two compared quotes as real text, resting
  // slightly dim so a quote pulse can brighten them.
  const lineA = microText("A 1.0264", 6.5, PALETTE.ink);
  lineA.anchor.set(0, 0.5);
  lineA.position.set(-24, 10);
  const lineB = microText("B 1.0271", 6.5, PALETTE.inkDim);
  lineB.anchor.set(0, 0.5);
  lineB.position.set(-24, 17);
  lineA.alpha = 0.85;
  lineB.alpha = 0.85;
  screen.addChild(lineA, lineB);
  const quoteFlash = glow(0, 14, 52, PALETTE.cyan, 0);
  root.addChild(quoteFlash);

  // Only the console trim breathes at idle; readouts stay static so story
  // pulses never fight an idle tween.
  const trimGlow = glow(0, 12, 80, PALETTE.violet, 0.16);
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

  let quoteSteps = 0;
  const api: LiquidityResearchApi = {
    pulse(kind) {
      if (kind === "pool") {
        gaugeFlashes.forEach((g, i) => blip(g, ctx, 0.85, i * 0.12, 0.8));
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
                breatheBubble(b, bi * 0.4);
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
  registerStation({ id: "liquidityResearch", root, hit: root.hit, api });
  ctx.onCleanup(() => {
    gsap.killTweensOf([...gaugeFlashes, quoteFlash, lineA, lineB, markerState]);
    for (const col of bubbleCols) for (const b of col) gsap.killTweensOf([b, b.scale]);
  });
}

// ---------------------------------------------------------------------------
// Mission Board: the wedge's initiating landmark. A wide angled billboard
// on a plinth, flanked by beacon pylons, with a live phase readout.
// ---------------------------------------------------------------------------

/** Real mission statuses (packages/trading-contracts/src/mission.ts). */
const MISSION_PHASES = ["WAITING", "ANALYSING", "EXECUTING", "HOLDING"];

function buildMissionBoard(ctx: DioramaContext): void {
  const root = stationBase(ctx, "missionBoard", 58);
  const accent = PALETTE.cyan;

  contactShadow(root, 0, 12, 208, 84);
  // Wide plinth grounds the landmark and gives it the row's largest
  // footprint mass.
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
  // strategy-1 to near("missionBoard", 60, 20), so that point gets a marked
  // stand, a carried-brief card pair, and a queue strip along the front edge.
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
        (c.children[0] as Graphics).alpha = on ? 0.95 : 0.7;
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
// Sandbox: contained test area. Tall back walls, low see-through front lips,
// and an explicit south gate where the test bay opens toward the wedge. A
// warm rim keeps this side branch off the shared cyan.
// ---------------------------------------------------------------------------

function buildSandbox(ctx: DioramaContext): void {
  const root = stationBase(ctx, "sandbox", 44);

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
  // wedge's traffic arrives from the mission board side.
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
  [PALETTE.cyan, PALETTE.violet].forEach((color, i) => {
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
// quiet, one stacked plan and one slider. Sign is pinned low and east so the
// MCP hub's large board to its south-west never overlaps it.
// ---------------------------------------------------------------------------

function buildBudgetPlanning(ctx: DioramaContext): void {
  const def = STATIONS.budgetPlanning;
  const root = stationBase(ctx, "budgetPlanning", 60, {
    signDx: 26,
    signY: def.anchor.y - 77,
    signHalo: false,
  });

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
// Decision Table: the wedge's single decision endpoint. Round table,
// holo ring, pooled proposal cards (DecisionTableApi).
// ---------------------------------------------------------------------------

const MAX_PROPOSALS = 4;

function buildDecisionTable(ctx: DioramaContext): void {
  const def = STATIONS.decisionTable;
  // signDx keeps the md board clear of the mcpHub lg sign's west edge.
  const root = stationBase(ctx, "decisionTable", 70, { signDx: -35 });

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

  // Witness plate where the reviewing strategist stands (east of the table;
  // the offset stays inside the SW taper for both the landed and proposed
  // decisionTable anchors). Captioned so the lone plate reads as a stand,
  // not a stray puck.
  ctx.layers.ground.addChild(footPlate(def.anchor.x + 65, def.anchor.y + 25, PALETTE.violet));
  const reviewLabel = microText("REVIEW", 7, PALETTE.inkDim);
  reviewLabel.anchor.set(0.5);
  reviewLabel.position.set(def.anchor.x + 65, def.anchor.y + 42);
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
          const body = card.children[0] as Graphics;
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
          const body = card.children[0] as Graphics;
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
          const body = card.children[0] as Graphics;
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
            const body = card.children[0] as Graphics;
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
// Scatter props: crates, a rolled chart, planters with glowing reeds. Spots
// hand-verified against the new west-section station diamonds, the N-W wall
// band, the section seam (x 1120), and the SW room taper.
// ---------------------------------------------------------------------------

function scatterProps(ctx: DioramaContext): void {
  const rnd = seededRandom(11);
  const layer = ctx.layers.sortable;

  const spots: Array<{ x: number; y: number }> = [
    { x: 420, y: 690 },
    { x: 560, y: 700 },
    { x: 760, y: 655 },
    { x: 890, y: 675 },
    { x: 1090, y: 700 },
    { x: 600, y: 760 },
    { x: 860, y: 880 },
    { x: 980, y: 878 },
    { x: 505, y: 930 },
    { x: 760, y: 940 },
    { x: 1010, y: 870 },
    { x: 880, y: 1085 },
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
// Evidence tier apron: one shared ground pad tying the twin console walls
// (marketData west, researchTools east) into a single evidence tier.
// ---------------------------------------------------------------------------

function buildEvidenceApron(ctx: DioramaContext): void {
  const a = STATIONS.marketData.anchor;
  const b = STATIONS.researchTools.anchor;
  groundPad(ctx, (a.x + b.x) / 2, (a.y + b.y) / 2, 300, 76, PALETTE.cyan, 0.22);
}

// ---------------------------------------------------------------------------

export function buildResearchDistrict(ctx: DioramaContext): void {
  buildEvidenceApron(ctx);
  buildResearchOnlyGate(ctx);
  buildMarketData(ctx);
  buildResearchTools(ctx);
  buildStrategyLab(ctx);
  buildMarketStructure(ctx);
  buildMissionBoard(ctx);
  buildSandbox(ctx);
  buildBudgetPlanning(ctx);
  buildDecisionTable(ctx);
  scatterProps(ctx);
}
