/**
 * East section, state & reconciliation cluster: state store, event bus rail
 * yard, reconciliation dock, receipt printer, audit archive, replay chamber,
 * recovery workshop, observability, activity gallery, portfolio vault,
 * identity gate, refusal display. Owner: east lane (ops.ts).
 *
 * Durability story: every action becomes a receipt, receipts land in the
 * archive and the state store, state is reconciled against the exchange, and
 * drift is repaired rather than hidden. All idle loops hang off one shared
 * ticker with per-station phase offsets; nothing redraws Graphics per frame.
 *
 * Shared language (R6): the cluster uses the same structural-blue booth
 * family, gold district accent, and sign system as the guarded-execution
 * band; aqua is the counter-accent. Semantic colors stay semantic. The old
 * research-only gate moved to the west section and is now built from
 * stations/research.ts, not here.
 */
import { safeDestroy } from "../core/iso.js";
import { Container, Graphics, Sprite, Text, TextStyle } from "pixi.js";
import { gsap } from "gsap";
import { STATIONS, type StationId } from "../config/stations.js";
import { PALETTE } from "../config/palette.js";
import { DEPTH, seededRandom } from "../config/world.js";
import {
  arch,
  dotTexture,
  edgeStrip,
  glow,
  isoBox,
  isoCylinder,
  isoTile,
  isoWall,
  lightBeam,
  screenPanel,
} from "../core/iso.js";
import { makeSign } from "../core/signs.js";
import { registerStation } from "../core/registry.js";
import type { DioramaContext } from "../core/context.js";

export interface ReconciliationApi {
  /** Compare streams: aligned flashes green, drift goes amber and dispatches. */
  compare(aligned: boolean): void;
}

export interface ReceiptPrinterApi {
  print(kind: string): void;
}

export interface ReplayChamberApi {
  playReceipt(): void;
}

export interface RecoveryApi {
  /** A recovery agent fixes an interrupted flow at a station. */
  dispatchRepair(): void;
}

export interface IdentityGateApi {
  /** A packet passes or is physically refused at the gate. */
  attempt(passes: boolean, reason?: string): void;
}

/** Ops-local extension: the refusal board consumes gate refusals. */
export interface RefusalBoardApi {
  push(reason: string): void;
}

/** Ops-local extension: a vault block pulses after a fill. */
export interface PortfolioVaultApi {
  pulse(block: "capital" | "realized" | "unrealized" | "balance"): void;
}

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

const rand = seededRandom(31);

interface IdleLoop {
  period: number;
  phase: number;
  last: number;
  fire: () => void;
}

const idleLoops: IdleLoop[] = [];
/** Register a deterministic idle loop: fires once per period, phase-offset. */
function every(period: number, phase: number, fire: () => void): void {
  idleLoops.push({ period, phase, last: -1, fire });
}

const animatedTargets: object[] = [];

interface StationParts {
  root: Container;
  hit: Graphics;
}

/** Root container at the anchor with a transparent local iso-diamond hit. */
function stationBase(ctx: DioramaContext, id: StationId): StationParts {
  const def = STATIONS[id];
  const root = new Container();
  root.position.set(def.anchor.x, def.anchor.y);
  root.zIndex = def.anchor.y + DEPTH.base;
  ctx.layers.sortable.addChild(root);

  const hit = new Graphics();
  const hw = def.size.w / 2;
  const hd = def.size.d / 2;
  hit.poly([0, -hd, hw, 0, 0, hd, -hw, 0]);
  hit.fill({ color: 0xffffff, alpha: 0.004 });
  hit.eventMode = "static";
  hit.cursor = "pointer";
  root.addChild(hit);
  return { root, hit };
}

/** Signboard above the tallest point of the structure, in the labels layer. */
function stationSign(
  ctx: DioramaContext,
  id: StationId,
  rise: number,
  dx = 0,
  accent: number = PALETTE.aqua,
): void {
  const def = STATIONS[id];
  const sign = makeSign(def.label, {
    x: def.anchor.x + dx,
    y: def.anchor.y - rise,
    size: def.signSize,
    accent,
  });
  sign.zIndex = def.anchor.y + DEPTH.overlay;
  ctx.layers.labels.addChild(sign);
}

/** Small billboard agent silhouette (capsule body + head), one Graphics. */
function agentFigure(x: number, y: number, h: number, color: number, alpha = 1): Graphics {
  const g = new Graphics();
  g.circle(x, y - h, h * 0.22);
  g.fill({ color, alpha });
  g.roundRect(x - h * 0.16, y - h * 0.78, h * 0.32, h * 0.6, h * 0.14);
  g.fill({ color, alpha });
  return g;
}

/** Pooled receipt slip: pale card, two dark lines, one accent stripe. */
function makeSlip(accent: number): Container {
  const c = new Container();
  const g = new Graphics();
  g.roundRect(-5, -7, 10, 14, 1.5);
  g.fill({ color: PALETTE.surfacePale, alpha: 0.95 });
  g.rect(-3, -4, 6, 1.2);
  g.fill({ color: PALETTE.structure, alpha: 0.85 });
  g.rect(-3, -1.5, 6, 1.2);
  g.fill({ color: PALETTE.structure, alpha: 0.85 });
  g.rect(-5, 3.5, 10, 1.8);
  g.fill({ color: accent, alpha: 0.95 });
  c.addChild(g);
  return c;
}

/** Simple two-state glyph chip used by railYard lanes and gallery plaques. */
function glyphMark(kind: "chevron" | "dot" | "card" | "capsule" | "slip", color: number): Graphics {
  const g = new Graphics();
  if (kind === "chevron") {
    g.poly([4, 0, -3, -4, -1, 0, -3, 4]);
    g.fill({ color });
  } else if (kind === "dot") {
    g.circle(0, 0, 2.4);
    g.fill({ color });
  } else if (kind === "card") {
    g.roundRect(-3, -4, 6, 8, 1);
    g.fill({ color });
  } else if (kind === "capsule") {
    g.roundRect(-4, -2, 8, 4, 2);
    g.fill({ color });
  } else {
    g.roundRect(-3, -4.5, 6, 9, 1);
    g.fill({ color });
  }
  return g;
}

/**
 * Soft dark ground ellipse rendered right after the hit surface so every
 * substantial structure visibly sits on the platform instead of floating.
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

/** Small static crate for filling dead space near structures. Aqua rim is
 * the east section's counter-accent, replacing the retired ops magenta. */
function crate(x: number, y: number, s = 11): Graphics {
  return isoBox({
    x,
    y,
    w: s,
    d: s * 0.6,
    h: s * 0.55,
    color: PALETTE.structureLight,
    rim: PALETTE.aqua,
    rimAlpha: 0.3,
  });
}

/** Thin signal pylon with a soft emissive tip light; adds skyline variation. */
function signalPylon(root: Container, x: number, y: number, h: number, tint: number): void {
  const post = new Graphics();
  post.rect(x - 1, y - h, 2, h);
  post.fill({ color: PALETTE.structureLight });
  post.rect(x - 3, y - h * 0.45, 6, 1.2);
  post.fill({ color: tint, alpha: 0.6 });
  post.circle(x, y - h - 2, 2.2);
  post.fill({ color: tint, alpha: 0.95 });
  root.addChild(post);
  root.addChild(glow(x, y - h - 2, 12, tint, 0.32));
}

const tinyStyle = (size: number, color: number): TextStyle =>
  new TextStyle({
    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
    fontSize: size,
    letterSpacing: size * 0.1,
    fill: color,
  });

// ===========================================================================
// 1. STATE STORE: rack of five glowing state cartridges (open-front room)
// ===========================================================================

const CARTRIDGES: {
  label: string;
  tint: number;
  glyph: "dot" | "card" | "capsule" | "chevron" | "slip";
}[] = [
  { label: "missions", tint: PALETTE.cyan, glyph: "card" },
  { label: "decisions", tint: PALETTE.violet, glyph: "chevron" },
  { label: "account", tint: PALETTE.yellow, glyph: "capsule" },
  { label: "read models", tint: PALETTE.blue, glyph: "dot" },
  { label: "active state", tint: PALETTE.aqua, glyph: "slip" },
];

function buildStateStore(ctx: DioramaContext): void {
  const { root, hit } = stationBase(ctx, "stateStore");

  contactShadow(root, 4, 10, 158, 92);
  // Room: floor plate, low back wall (V, open front), same family as the
  // permission room up the wall.
  root.addChild(isoTile(0, 4, 150, 96, PALETTE.structure, 1, PALETTE.structureLight));
  root.addChild(
    isoWall({ x1: -60, y1: 6, x2: 0, y2: -38, h: 26, color: PALETTE.structure, rim: PALETTE.aqua }),
  );
  root.addChild(
    isoWall({ x1: 0, y1: -38, x2: 60, y2: 6, h: 26, color: PALETTE.structure, rim: PALETTE.aqua }),
  );

  // Cartridge rack: a bench plus five vertical glass slots.
  const rackX = -40;
  const rackY = 6;
  root.addChild(isoBox({ x: rackX + 40, y: rackY + 18, w: 104, d: 26, h: 8, color: PALETTE.structureLight }));

  const bandGlows: Sprite[] = [];
  CARTRIDGES.forEach((c, i) => {
    const sx = rackX + i * 20;
    const sy = rackY - 4;
    // Glass cartridge: translucent body with emissive data bands.
    const body = new Graphics();
    body.roundRect(sx - 6, sy - 44, 12, 44, 2);
    body.fill({ color: c.tint, alpha: 0.14 });
    body.roundRect(sx - 6, sy - 44, 12, 44, 2);
    body.stroke({ width: 1.2, color: c.tint, alpha: 0.95 });
    body.rect(sx - 4, sy - 38, 8, 2);
    body.fill({ color: c.tint, alpha: 0.75 });
    body.rect(sx - 4, sy - 30, 8, 2);
    body.fill({ color: c.tint, alpha: 0.45 });
    root.addChild(body);
    const mark = glyphMark(c.glyph, c.tint);
    mark.position.set(sx, sy - 47);
    root.addChild(mark);
    const band = glow(sx, sy - 22, 22, c.tint, 0.35);
    root.addChild(band);
    bandGlows.push(band);
  });

  // Intake slot on the east side: the store's intake fixture, brightening
  // when the persist beat writes a cartridge.
  const slot = new Graphics();
  slot.roundRect(46, -2, 18, 10, 2);
  slot.fill({ color: PALETTE.structureLight });
  slot.rect(49, -8, 12, 3);
  slot.fill({ color: PALETTE.aqua, alpha: 0.8 });
  root.addChild(slot);
  const trayGlow = glow(55, -8, 24, PALETTE.aqua, 0.16);
  root.addChild(trayGlow);

  // Dead-space fill: a crate stack west of the room and a corner signal pylon.
  root.addChild(crate(-72, 26));
  root.addChild(crate(-62, 32, 8));
  signalPylon(root, 62, 32, 58, PALETTE.cyan);

  // Sequential soft pulse: exactly one cartridge is hot at a time, so the
  // rack beats like a heart over a ~7 s cycle. The persist beat below flares
  // one cartridge brighter; this tick stays the single alpha writer.
  let flared = -1;
  let flareTimer: gsap.core.Tween | null = null;
  if (!ctx.reducedMotion) {
    ctx.onTick(() => {
      const hot = Math.floor(performance.now() / 1400) % bandGlows.length;
      bandGlows.forEach((b, i) => {
        b.alpha = i === flared ? 0.85 : i === hot ? 0.62 : 0.2;
      });
    });
  }

  // Persist beat: every ~13 s one cartridge takes a durable write (its band
  // flares) and the intake slot blips. This is the store's own write cycle;
  // no phantom packets fade in midair.
  let cartridgeIdx = 1;
  every(13, 1.2, () => {
    flared = cartridgeIdx % bandGlows.length;
    cartridgeIdx += 1;
    flareTimer?.kill();
    flareTimer = gsap.delayedCall(1.9, () => {
      flared = -1;
    });
    animatedTargets.push(trayGlow);
    gsap.to(trayGlow, {
      alpha: 0.5,
      duration: 0.35,
      onComplete: () => gsap.to(trayGlow, { alpha: 0.16, duration: 0.9, delay: 0.4 }),
    });
  });
  ctx.onCleanup(() => {
    flareTimer?.kill();
  });

  stationSign(ctx, "stateStore", 66);
  registerStation({ id: "stateStore", root, hit });
}

// ===========================================================================
// 2. RAIL YARD: Event Bus junction with sorting arm
// ===========================================================================

const YARD_LANES: {
  kind: "chevron" | "dot" | "card" | "capsule" | "slip";
  color: number;
  dx: number;
  dy: number;
}[] = [
  { kind: "chevron", color: 0x34e5e5, dx: -62, dy: -22 },
  { kind: "dot", color: 0x5a7cff, dx: -20, dy: -36 },
  { kind: "card", color: 0x9a70ff, dx: 26, dy: -30 },
  { kind: "capsule", color: 0xff9f45, dx: 58, dy: 4 },
  // Pale receipt slip; matches the corrected PACKET_STYLE.receipt tint.
  { kind: "slip", color: 0xddefe3, dx: 24, dy: 26 },
];

function buildRailYard(ctx: DioramaContext): void {
  const { root, hit } = stationBase(ctx, "railYard");

  contactShadow(root, 4, 8, 162, 92);
  // Raised sorting table.
  root.addChild(
    isoBox({
      x: 0,
      y: 0,
      w: 150,
      d: 80,
      h: 16,
      color: PALETTE.structure,
      rim: PALETTE.structureLight,
    }),
  );
  root.addChild(isoTile(0, -16, 150, 80, PALETTE.structureLight, 1, PALETTE.aqua));

  // Physical junction hub at the table center: the sorting lanes terminate
  // on a node instead of crossed lines floating on the tabletop.
  root.addChild(
    isoCylinder({
      x: 0,
      y: -16,
      r: 11,
      h: 9,
      color: PALETTE.structure,
      rim: PALETTE.aqua,
    }),
  );

  // Five short rail stubs converging on the hub, with lane glyphs. Stubs sit
  // dim at rest and brighten only while the sorting arm flicks to their lane.
  const laneMarks: Graphics[] = [];
  const laneStubs: Graphics[] = [];
  for (const lane of YARD_LANES) {
    const stub = edgeStrip(0, -16, lane.dx, -16 + lane.dy, 0x2a4a66, 0.55, 3);
    root.addChild(stub);
    laneStubs.push(stub);
    const mark = glyphMark(lane.kind, lane.color);
    mark.position.set(lane.dx, -20 + lane.dy);
    mark.alpha = 0.55;
    root.addChild(mark);
    laneMarks.push(mark);
  }

  // Waiting tray on the west approach: queued packets drain one per sort
  // cycle and refill when empty, so the junction shows real queue depth.
  const tray = new Graphics();
  tray.roundRect(-128, -22, 56, 14, 2);
  tray.fill({ color: PALETTE.structure, alpha: 0.85 });
  tray.roundRect(-128, -22, 56, 14, 2);
  tray.stroke({ width: 1, color: PALETTE.structureLight, alpha: 0.8 });
  root.addChild(tray);
  const queue: Graphics[] = [];
  for (let i = 0; i < 3; i++) {
    const chip = glyphMark("card", PALETTE.aqua);
    chip.position.set(-118 + i * 16, -15);
    root.addChild(chip);
    queue.push(chip);
  }

  // Sign mast standing on the table's north corner: a short, visibly
  // mounted post that grounds the EVENT BUS sign above.
  const mast = new Graphics();
  mast.rect(-1.2, -96, 2.4, 46);
  mast.fill({ color: PALETTE.structureLight });
  mast.rect(-4, -96, 8, 1.4);
  mast.fill({ color: PALETTE.aqua, alpha: 0.7 });
  root.addChild(mast);
  root.addChild(crate(74, -44));

  // Mechanical sorting arm: pivot post + boom, flicks toward a lane.
  const arm = new Container();
  arm.position.set(0, -22);
  const armG = new Graphics();
  armG.rect(-2, -2, 26, 3.5);
  armG.fill({ color: PALETTE.structureLight });
  armG.circle(0, 0, 4);
  armG.fill({ color: PALETTE.orange });
  armG.circle(24, -0.5, 2.5);
  armG.fill({ color: PALETTE.cyan });
  arm.addChild(armG);
  arm.angle = -0.5;
  root.addChild(arm);

  // Visual loop (~6 s): a dot arrives, the arm flicks, the dot departs, and
  // the chosen lane plus its stub brighten while the queue drains.
  const dot = new Sprite(dotTexture());
  dot.anchor.set(0.5);
  dot.width = 12;
  dot.height = 12;
  dot.tint = PALETTE.blue;
  dot.alpha = 0;
  dot.zIndex = DEPTH.packet;
  root.addChild(dot);
  const lanes = YARD_LANES;
  let laneIdx = 0;
  let queued = 3;

  const runSort = (): void => {
    if (ctx.reducedMotion) return;
    // Queue depth: drain one chip per cycle; refill all when empty.
    if (queued === 0) {
      queued = queue.length;
      queue.forEach((chip, i) => {
        animatedTargets.push(chip);
        gsap.fromTo(chip, { alpha: 0 }, { alpha: 0.9, duration: 0.3, delay: i * 0.15 });
      });
    }
    queued -= 1;
    const drainedChip = queue[queued];
    if (drainedChip) {
      animatedTargets.push(drainedChip);
      gsap.to(drainedChip, { alpha: 0.12, duration: 0.4, delay: 1.5 });
    }
    const laneIdxMod = laneIdx % lanes.length;
    const lane = lanes[laneIdxMod];
    laneIdx += 1;
    // Active lane reads hot; the rest settle back to their resting dim.
    laneStubs.forEach((stub, i) => {
      animatedTargets.push(stub);
      gsap.to(stub, { alpha: i === laneIdxMod ? 1 : 0.55, duration: 0.3, delay: 1.3 });
    });
    laneMarks.forEach((mark, i) => {
      animatedTargets.push(mark);
      gsap.to(mark, { alpha: i === laneIdxMod ? 1 : 0.55, duration: 0.3, delay: 1.3 });
    });
    dot.tint = lane.color;
    dot.position.set(-78, -30);
    animatedTargets.push(dot);
    gsap.to(dot, { alpha: 1, x: 0, y: -22, duration: 1.4, ease: "none" });
    animatedTargets.push(arm);
    gsap.to(arm, {
      angle: Math.atan2(lane.dy, lane.dx) * 57.3,
      duration: 0.3,
      delay: 1.4,
      ease: "power2.out",
    });
    gsap.to(dot, {
      alpha: 0,
      x: lane.dx * 1.2,
      y: -22 + lane.dy * 1.2,
      duration: 1.2,
      delay: 1.75,
      ease: "none",
    });
  };
  every(6, 0, runSort);
  runSort();

  stationSign(ctx, "railYard", 60);
  registerStation({ id: "railYard", root, hit });
}

// ===========================================================================
// 3. RECONCILIATION DOCK: two physical streams, comparison bench, dispatch
// ===========================================================================

function buildReconciliationDock(ctx: DioramaContext): void {
  const { root, hit } = stationBase(ctx, "reconciliationDock");

  contactShadow(root, 6, 12, 220, 128);
  // Dock platform.
  root.addChild(
    isoBox({
      x: 0,
      y: 0,
      w: 180,
      d: 110,
      h: 10,
      color: PALETTE.structure,
      rim: PALETTE.structureLight,
    }),
  );
  root.addChild(isoTile(0, -10, 180, 110, PALETTE.structureLight, 1, PALETTE.healthy));

  // East belt carrying local expected state (pale slips) from portfolio vault.
  const belt = new Graphics();
  belt.rect(52, -16, 74, 8);
  belt.fill({ color: PALETTE.structure });
  for (let i = 0; i < 5; i++) {
    belt.rect(56 + i * 15, -14, 7, 4);
    belt.fill({ color: 0x2a4a66 });
  }
  root.addChild(belt);
  const localSlip = makeSlip(PALETTE.waiting);
  localSlip.scale.set(0.8);
  localSlip.position.set(118, -12);
  localSlip.alpha = 0.9;
  root.addChild(localSlip);

  // Curved aqueduct carrying the exchange's authoritative state in from the
  // north-east, where the docked exchange booth sits.
  const aqueduct = new Graphics();
  aqueduct.moveTo(66, 2);
  aqueduct.quadraticCurveTo(34, 10, 6, 16);
  aqueduct.stroke({ width: 9, color: PALETTE.structure, alpha: 1 });
  aqueduct.moveTo(66, 2);
  aqueduct.quadraticCurveTo(34, 10, 6, 16);
  aqueduct.stroke({ width: 5, color: PALETTE.aqua, alpha: 0.5 });
  root.addChild(aqueduct);

  // Glowing pipeline segment along the south dock edge: emissive run of pipe
  // joints plus a soft spill glow, so the dock edge reads at fit zoom.
  const pipeline = new Graphics();
  for (let i = 0; i < 5; i++) {
    const px = -60 + i * 26;
    pipeline.rect(px, 52, 18, 5);
    pipeline.fill({ color: PALETTE.structureLight });
    pipeline.rect(px + 18, 52, 6, 5);
    pipeline.fill({ color: PALETTE.structure });
  }
  pipeline.rect(-62, 53.5, 160, 1.4);
  pipeline.fill({ color: PALETTE.healthy, alpha: 0.8 });
  root.addChild(pipeline);
  root.addChild(glow(-20, 55, 40, PALETTE.healthy, 0.3));

  // Dead-space fill: crates west of the platform, one upright, one tipped.
  root.addChild(crate(-108, 18));
  root.addChild(crate(-98, 28, 8));
  const exDot = new Sprite(dotTexture());
  exDot.anchor.set(0.5);
  exDot.width = 14;
  exDot.height = 14;
  exDot.tint = PALETTE.aqua;
  exDot.position.set(10, 20);
  root.addChild(exDot);

  // Comparison bench with a balance-scale motif, agents flanking.
  root.addChild(isoBox({ x: 0, y: -8, w: 44, d: 26, h: 14, color: PALETTE.structureLight }));
  const scaleG = new Graphics();
  scaleG.rect(-1, -38, 2, 16);
  scaleG.fill({ color: PALETTE.surfacePale });
  const beam = new Container();
  beam.position.set(0, -38);
  const beamG = new Graphics();
  beamG.rect(-16, -1, 32, 2);
  beamG.fill({ color: PALETTE.surfacePale });
  beamG.rect(-18, 1, 5, 2);
  beamG.fill({ color: PALETTE.surfacePale, alpha: 0.8 });
  beamG.rect(13, 1, 5, 2);
  beamG.fill({ color: PALETTE.surfacePale, alpha: 0.8 });
  beam.addChild(beamG);
  root.addChild(scaleG, beam);
  root.addChild(agentFigure(-44, -8, 22, PALETTE.healthy));
  root.addChild(agentFigure(44, -8, 22, PALETTE.aqua));

  // Amber drift wash (hidden until drift), receipt pop, beacon, dispatch arm.
  const driftWash = isoTile(0, -10, 180, 110, PALETTE.warning, 0);
  root.addChild(driftWash);
  const popReceipt = makeSlip(PALETTE.healthy);
  popReceipt.position.set(0, -26);
  popReceipt.alpha = 0;
  root.addChild(popReceipt);
  const beacon = glow(-70, -60, 26, PALETTE.warning, 0);
  const beaconPost = new Graphics();
  beaconPost.rect(-71, -48, 2, 30);
  beaconPost.fill({ color: PALETTE.structureLight });
  beaconPost.circle(-70, -52, 3);
  beaconPost.fill({ color: PALETTE.warning, alpha: 0.9 });
  root.addChild(beaconPost, beacon);
  const dispatchArm = new Container();
  dispatchArm.position.set(-78, 14);
  const dArm = new Graphics();
  dArm.rect(0, -1.5, 30, 3);
  dArm.fill({ color: PALETTE.structureLight });
  dArm.circle(0, 0, 3.5);
  dArm.fill({ color: PALETTE.orange });
  dArm.circle(29, 0, 2.5);
  dArm.fill({ color: PALETTE.orange });
  dispatchArm.addChild(dArm);
  dispatchArm.angle = -20;
  root.addChild(dispatchArm);

  let cycle = 0;
  const api: ReconciliationApi = {
    compare(aligned: boolean): void {
      const flash = aligned ? PALETTE.healthy : PALETTE.warning;
      if (aligned) {
        // Both streams flash green, streams align, a receipt pops out.
        animatedTargets.push(localSlip, exDot, popReceipt, beam);
        gsap.to(beam, { angle: 0, duration: 0.4 });
        localSlip.tint = flash;
        exDot.tint = flash;
        gsap.to(popReceipt, {
          alpha: 1,
          y: -14,
          duration: 0.4,
          onComplete: () =>
            gsap.to(popReceipt, { alpha: 0, y: -26, duration: 0.6, delay: 1.2 }),
        });
        gsap.to(exDot, { width: 18, height: 18, duration: 0.25, yoyo: true, repeat: 1 });
        gsap.to([localSlip], { alpha: 1, duration: 0.3 });
      } else {
        // Amber wash, both representations stay side by side, beacon + arm.
        animatedTargets.push(driftWash, beacon, beam, dispatchArm, localSlip, exDot);
        driftWash.tint = 0xffffff;
        gsap.to(driftWash, {
          alpha: 0.55,
          duration: 0.4,
          onComplete: () => gsap.to(driftWash, { alpha: 0, duration: 1.6, delay: 1.6 }),
        });
        gsap.to(beam, { angle: 9, duration: 0.4 });
        gsap.to(localSlip, { x: 96, duration: 0.4 });
        gsap.to(exDot, { x: 18, duration: 0.4 });
        gsap.to(beacon, {
          alpha: 0.9,
          duration: 0.5,
          repeat: 5,
          yoyo: true,
          onComplete: () => gsap.set(beacon, { alpha: 0 }),
        });
        gsap.to(dispatchArm, {
          angle: 42,
          duration: 0.5,
          onComplete: () => gsap.to(dispatchArm, { angle: -20, duration: 0.8, delay: 2.2 }),
        });
      }
    },
  };

  // Slow idle: one comparison cycle every ~9 s, alternating deterministically.
  every(9, 2.5, () => {
    const aligned = cycle % 2 === 0;
    cycle += 1;
    // Drift resets stream offsets so the alternation stays legible.
    if (!aligned) {
      gsap.to(localSlip, { x: 118, duration: 0.8, delay: 3.4 });
      gsap.to(exDot, { x: 10, duration: 0.8, delay: 3.4 });
    }
    api.compare(aligned);
  });

  stationSign(ctx, "reconciliationDock", 74, 0, PALETTE.yellow);
  registerStation({ id: "reconciliationDock", root, hit, api });
}

// ===========================================================================
// 4. RECEIPT PRINTER: whimsical machine + miniature conveyor east
// ===========================================================================

const RECEIPT_KINDS: Record<string, number> = {
  tool: PALETTE.cyan,
  decision: PALETTE.violet,
  approval: PALETTE.healthy,
  order: PALETTE.orange,
  result: PALETTE.aqua,
  refusal: PALETTE.blocked,
  failure: PALETTE.blocked,
};
const RECEIPT_CYCLE = ["tool", "decision", "approval", "order", "result", "refusal", "failure"];

function buildReceiptPrinter(ctx: DioramaContext): void {
  const { root, hit } = stationBase(ctx, "receiptPrinter");

  contactShadow(root, -6, 6, 190, 68);
  // Machine body on a raised plinth, paper stack, status dot. The receipts
  // printer is half of the cluster's active foreground pair (with the
  // reconciliation dock), so it gets a heavier base and a brighter conveyor
  // than the downstream storage fixtures.
  root.addChild(
    isoBox({
      x: -20,
      y: 4,
      w: 88,
      d: 62,
      h: 7,
      color: PALETTE.structure,
      rim: PALETTE.structureLight,
    }),
  );
  root.addChild(
    isoBox({
      x: -20,
      y: 0,
      w: 76,
      d: 56,
      h: 34,
      color: PALETTE.structure,
      rim: PALETTE.structureLight,
    }),
  );
  root.addChild(isoBox({ x: -44, y: 8, w: 26, d: 30, h: 12, color: PALETTE.structureLight }));
  const paper = new Graphics();
  paper.roundRect(-50, -8, 14, 5, 1);
  paper.fill({ color: PALETTE.surfacePale, alpha: 0.9 });
  paper.roundRect(-48, -12, 10, 4, 1);
  paper.fill({ color: PALETTE.surfacePale, alpha: 0.7 });
  root.addChild(paper);

  // Printing head slides along the top of the body.
  const head = new Graphics();
  head.roundRect(-34, -44, 14, 8, 2);
  head.fill({ color: PALETTE.structureLight });
  head.circle(-27, -46, 2);
  head.fill({ color: PALETTE.aqua });
  root.addChild(head);

  // Miniature conveyor east toward the archive.
  const conveyor = new Graphics();
  conveyor.rect(8, 6, 96, 9);
  conveyor.fill({ color: PALETTE.structure });
  for (let i = 0; i < 7; i++) {
    conveyor.rect(12 + i * 13, 8, 7, 5);
    conveyor.fill({ color: 0x2a4a66 });
  }
  conveyor.rect(8, 2, 96, 2);
  conveyor.fill({ color: PALETTE.aqua, alpha: 0.55 });
  root.addChild(conveyor);

  // Printed pile at the conveyor's far end: output volume at a glance.
  const pile = new Graphics();
  for (let i = 0; i < 3; i++) {
    pile.roundRect(100 - i * 1.5, 16 - i * 3.5, 13, 8, 1);
    pile.fill({ color: PALETTE.surfacePale, alpha: 0.85 - i * 0.14 });
  }
  root.addChild(pile);

  let kindIdx = 0;
  const api: ReceiptPrinterApi = {
    print(kind: string): void {
      const accent = RECEIPT_KINDS[kind] ?? PALETTE.cyan;
      // Head slides, then a slip emerges and rides the conveyor east.
      animatedTargets.push(head);
      gsap.to(head, { x: 26, duration: 0.35, yoyo: true, repeat: 1, ease: "power1.inOut" });
      const slip = makeSlip(accent);
      slip.position.set(6, -6);
      slip.alpha = 0;
      slip.zIndex = DEPTH.packet;
      root.addChild(slip);
      animatedTargets.push(slip);
      gsap.to(slip, {
        alpha: 1,
        x: 104,
        y: 10,
        duration: ctx.reducedMotion ? 0.3 : 2.4,
        ease: "none",
        onComplete: () => safeDestroy(slip),
      });
    },
  };
  every(7, 3.1, () => {
    api.print(RECEIPT_CYCLE[kindIdx % RECEIPT_CYCLE.length]);
    kindIdx += 1;
  });

  // District heartbeat: an idle paper glint sweeps the stack every ~13 s,
  // off-phase with the print cycle.
  const glint = new Graphics();
  glint.poly([-50, -3, -44, -3, -40, -13, -46, -13]);
  glint.fill({ color: 0xffffff, alpha: 0.7 });
  glint.blendMode = "add";
  glint.alpha = 0;
  root.addChild(glint);
  every(13, 6.5, () => {
    if (ctx.reducedMotion) return;
    animatedTargets.push(glint);
    gsap.fromTo(
      glint,
      { alpha: 0, x: -3 },
      {
        alpha: 0.9,
        x: 3,
        duration: 0.5,
        ease: "sine.inOut",
        onComplete: () => gsap.to(glint, { alpha: 0, duration: 0.4 }),
      },
    );
  });

  stationSign(ctx, "receiptPrinter", 60);
  registerStation({ id: "receiptPrinter", root, hit, api });
}

// ===========================================================================
// 5. AUDIT ARCHIVE: wall of drawers, one opens on the conveyor cadence
// ===========================================================================

function buildAuditArchive(ctx: DioramaContext): void {
  const { root, hit } = stationBase(ctx, "auditArchive");

  contactShadow(root, 0, -2, 196, 56);
  // Billboard wall with ladder rail. The wall is biased east on the footprint
  // so its west corner clears the pocket seam; the archive is downstream
  // storage, so its rim is a step calmer than the foreground pair.
  const wall = new Graphics();
  wall.roundRect(-78, -86, 184, 78, 4);
  wall.fill({ color: PALETTE.structure });
  wall.roundRect(-78, -86, 184, 78, 4);
  wall.stroke({ width: 1.5, color: PALETTE.structureLight, alpha: 0.7 });
  wall.rect(84, -82, 3, 70);
  wall.rect(92, -82, 3, 70);
  wall.fill({ color: 0x2a4a66 });
  for (let r = 0; r < 3; r++) {
    for (let i = 0; i < 5; i++) {
      wall.rect(-72 + i * 30, -80 + r * 24, 4, 2);
      wall.rect(-72 + i * 30 + 22, -80 + r * 24, 4, 2);
    }
  }
  wall.fill({ color: 0x2a4a66, alpha: 0.8 });
  root.addChild(wall);

  // 3 rows x 6 pale drawers, each with a tiny kind glyph.
  const drawerGlyphs: ("dot" | "card" | "capsule" | "slip" | "chevron")[] = [
    "card",
    "slip",
    "capsule",
    "dot",
    "chevron",
  ];
  const drawers: Container[] = [];
  for (let r = 0; r < 3; r++) {
    for (let cIdx = 0; cIdx < 6; cIdx++) {
      const d = new Container();
      const dx = -72 + cIdx * 29;
      const dy = -80 + r * 24;
      const front = new Graphics();
      front.roundRect(0, 0, 25, 19, 2);
      front.fill({ color: PALETTE.structureLight });
      front.roundRect(0, 0, 25, 19, 2);
      front.stroke({ width: 1.2, color: PALETTE.aqua, alpha: 0.45 });
      front.rect(9, 15, 7, 2);
      front.fill({ color: 0x2a4a66 });
      d.addChild(front);
      const mark = glyphMark(drawerGlyphs[(r * 6 + cIdx) % drawerGlyphs.length], PALETTE.inkDim);
      mark.position.set(12.5, 8);
      d.addChild(mark);
      d.position.set(dx, dy);
      root.addChild(d);
      drawers.push(d);
    }
  }

  // District heartbeat: a soft shimmer walks the drawer rows in sequence
  // every ~12 s, like the archive breathing through its index.
  const shimmer = glow(0, 0, 30, PALETTE.aqua, 0);
  root.addChild(shimmer);
  every(12, 1.8, () => {
    if (ctx.reducedMotion) return;
    animatedTargets.push(shimmer);
    const seq = [drawers[2], drawers[8], drawers[14]];
    seq.forEach((d, i) => {
      gsap.fromTo(
        shimmer,
        { alpha: 0 },
        {
          alpha: 0.4,
          duration: 0.4,
          delay: i * 0.9,
          onStart: () => shimmer.position.set(d.x + 12, d.y + 10),
          onComplete: () => gsap.to(shimmer, { alpha: 0, duration: 0.5 }),
        },
      );
    });
  });

  // Idle: a receipt slides in from the west conveyor, drawer opens and closes.
  let drawerIdx = Math.floor(rand() * drawers.length);
  every(8, 4.4, () => {
    const d = drawers[drawerIdx % drawers.length];
    drawerIdx += 3; // step through drawers deterministically
    const slip = makeSlip(PALETTE.aqua);
    slip.scale.set(0.7);
    slip.position.set(-110, -6);
    slip.alpha = 0;
    root.addChild(slip);
    animatedTargets.push(d, slip);
    gsap.to(d, { y: d.y + 7, duration: 0.4 });
    gsap.to(slip, {
      alpha: 1,
      x: d.x + 12,
      y: d.y + 10,
      duration: ctx.reducedMotion ? 0.2 : 1.3,
      ease: "none",
      onComplete: () => {
        gsap.to(d, { y: d.y, duration: 0.4, delay: 0.5 });
        gsap.to(slip, { alpha: 0, duration: 0.3, delay: 0.4, onComplete: () => safeDestroy(slip) });
      },
    });
  });

  stationSign(ctx, "auditArchive", 104);
  registerStation({ id: "auditArchive", root, hit });
}

// ===========================================================================
// 6. REPLAY CHAMBER: sunken ring, cone of light, ghost reconstruction
// ===========================================================================

function buildReplayChamber(ctx: DioramaContext): void {
  const { root, hit } = stationBase(ctx, "replayChamber");

  contactShadow(root, 0, 2, 118, 60, 0.25);
  // Sunken circular ring room.
  const ring = new Graphics();
  ring.ellipse(0, 0, 52, 26);
  ring.fill({ color: PALETTE.structure });
  ring.ellipse(0, 0, 52, 26);
  ring.stroke({ width: 2, color: PALETTE.structureLight, alpha: 0.9 });
  ring.ellipse(0, 0, 40, 20);
  ring.fill({ color: 0x0a1828 });
  ring.ellipse(0, 0, 40, 20);
  ring.stroke({ width: 1.5, color: PALETTE.violet, alpha: 0.5 });
  root.addChild(ring);

  // Translucent light cone (hidden until playback) + the archived slip.
  const cone = new Graphics();
  cone.poly([-4, -4, 4, -4, 26, -52, -26, -52]);
  cone.fill({ color: PALETTE.violet, alpha: 0.22 });
  cone.blendMode = "add";
  cone.alpha = 0;
  root.addChild(cone);
  const slip = makeSlip(PALETTE.violet);
  slip.scale.set(0.8);
  slip.position.set(0, -4);
  slip.alpha = 0;
  root.addChild(slip);

  // Standby projection: a breathing violet pool keeps the chamber reading
  // "ready" between replays instead of a dead black pit. Suppressed while a
  // receipt plays, restored afterwards.
  const standbyPool = new Graphics();
  standbyPool.ellipse(0, 0, 30, 15);
  standbyPool.fill({ color: PALETTE.violet, alpha: 0.12 });
  standbyPool.ellipse(0, 0, 30, 15);
  standbyPool.stroke({ width: 1, color: PALETTE.violet, alpha: 0.35 });
  standbyPool.blendMode = "add";
  root.addChild(standbyPool);
  const standbyGlow = glow(0, -16, 64, PALETTE.violet, 0.12);
  root.addChild(standbyGlow);
  animatedTargets.push(standbyPool, standbyGlow);
  const startStandby = (): void => {
    standbyPool.alpha = 1;
    standbyGlow.alpha = 0.12;
    if (ctx.reducedMotion) return;
    gsap.to(standbyGlow, {
      alpha: 0.24,
      duration: 2.6,
      yoyo: true,
      repeat: -1,
      ease: "sine.inOut",
    });
    gsap.to(standbyPool, {
      alpha: 0.55,
      duration: 2.6,
      yoyo: true,
      repeat: -1,
      ease: "sine.inOut",
      delay: 1.3,
    });
  };
  startStandby();

  // Three pooled ghost sprites re-enacting proposal -> arch -> capsule.
  const ghosts: Container[] = [];
  for (let i = 0; i < 3; i++) {
    const gh = agentFigure(0, -6, 16, PALETTE.ink, 0.35);
    gh.alpha = 0;
    gh.tint = 0xbfdbff;
    root.addChild(gh);
    ghosts.push(gh);
  }
  // Tiny props: proposal card, arch, order capsule appear during playback.
  const propCard = glyphMark("card", PALETTE.violet);
  const propCapsule = glyphMark("capsule", PALETTE.orange);
  propCard.position.set(-20, -10);
  propCapsule.position.set(20, -10);
  propCard.alpha = 0;
  propCapsule.alpha = 0;
  root.addChild(propCard, propCapsule);

  const api: ReplayChamberApi = {
    playReceipt(): void {
      // Take over from standby and any in-flight playback; every element
      // resets so overlapping calls never stack tweens.
      gsap.killTweensOf([standbyPool, standbyGlow, cone, slip, propCard, propCapsule, ...ghosts]);
      standbyPool.alpha = 0;
      standbyGlow.alpha = 0;
      cone.alpha = 0;
      slip.alpha = 0;
      ghosts.forEach((g) => (g.alpha = 0));
      propCard.alpha = 0;
      propCapsule.alpha = 0;
      animatedTargets.push(cone, slip, ...ghosts, propCard, propCapsule);
      gsap.to(cone, { alpha: 1, duration: 0.4 });
      gsap.to(slip, { alpha: 1, duration: 0.3 });
      // Ghost 0 proposes (card lights), ghost 1 is the arch, ghost 2 receives.
      gsap.set(ghosts[0], { x: -22, y: -4 });
      gsap.set(ghosts[1], { x: 0, y: -2 });
      gsap.set(ghosts[2], { x: 22, y: -4 });
      gsap.to(ghosts[0], { alpha: 0.4, duration: 0.3, delay: 0.3 });
      gsap.to(propCard, { alpha: 0.9, duration: 0.3, delay: 0.4 });
      gsap.to(ghosts[1], { alpha: 0.4, duration: 0.3, delay: 0.9 });
      gsap.to(propCard, { x: 0, duration: 0.6, delay: 1.0 });
      gsap.to(propCard, { alpha: 0, duration: 0.3, delay: 1.7 });
      gsap.to(ghosts[2], { alpha: 0.4, duration: 0.3, delay: 1.6 });
      gsap.to(propCapsule, { alpha: 0.9, duration: 0.3, delay: 1.9 });
      const fade = { alpha: 0, duration: 0.6, delay: 2.6 };
      gsap.to(ghosts, { ...fade });
      gsap.to(propCapsule, { ...fade });
      gsap.to(cone, { alpha: 0, duration: 0.6, delay: 2.8 });
      gsap.to(slip, {
        alpha: 0,
        duration: 0.5,
        delay: 2.8,
        onComplete: () => startStandby(),
      });
    },
  };

  stationSign(ctx, "replayChamber", 56);
  registerStation({ id: "replayChamber", root, hit, api });
}

// ===========================================================================
// 7. RECOVERY WORKSHOP: tool wall, bench, spare capsules, repair bot
// ===========================================================================

function buildRecoveryWorkshop(ctx: DioramaContext): void {
  const { root, hit } = stationBase(ctx, "recoveryWorkshop");

  contactShadow(root, 4, 8, 190, 100);
  // Floor + tool wall (billboard) with a few hanging tool glyphs.
  root.addChild(isoTile(0, 0, 165, 88, PALETTE.structure, 1, PALETTE.structureLight));
  const toolWall = new Graphics();
  toolWall.roundRect(-88, -64, 78, 46, 3);
  toolWall.fill({ color: PALETTE.structureLight });
  toolWall.roundRect(-88, -64, 78, 46, 3);
  toolWall.stroke({ width: 1, color: PALETTE.orange, alpha: 0.5 });
  toolWall.rect(-80, -56, 4, 14);
  toolWall.rect(-66, -58, 3, 12);
  toolWall.rect(-52, -55, 5, 10);
  toolWall.rect(-80, -34, 10, 3);
  toolWall.rect(-62, -36, 14, 3);
  toolWall.fill({ color: 0x2a4a66 });
  root.addChild(toolWall);

  // Workbench with a disassembled capsule (halves + parts).
  root.addChild(
    isoBox({
      x: 18,
      y: 6,
      w: 88,
      d: 44,
      h: 16,
      color: PALETTE.structureLight,
      rim: PALETTE.orange,
    }),
  );
  const parts = new Graphics();
  parts.roundRect(-4, -16, 14, 6, 3);
  parts.fill({ color: PALETTE.orange, alpha: 0.85 });
  parts.roundRect(14, -12, 12, 5, 2);
  parts.fill({ color: PALETTE.orange, alpha: 0.6 });
  parts.circle(32, -10, 2);
  parts.fill({ color: PALETTE.surfacePale, alpha: 0.8 });
  root.addChild(parts);

  // Spare order capsule rack (3 orange capsules) + small crane arm.
  const rack = new Graphics();
  rack.rect(52, 18, 40, 4);
  rack.fill({ color: PALETTE.structure });
  for (let i = 0; i < 3; i++) {
    rack.roundRect(55 + i * 13, 4, 10, 13, 4);
    rack.fill({ color: PALETTE.orange, alpha: 0.9 });
  }
  root.addChild(rack);
  const crane = new Container();
  crane.position.set(70, -12);
  const craneG = new Graphics();
  craneG.rect(0, -26, 3, 26);
  craneG.fill({ color: PALETTE.structureLight });
  craneG.rect(0, -26, 24, 3);
  craneG.fill({ color: PALETTE.structureLight });
  craneG.rect(22, -24, 1.5, 10);
  craneG.fill({ color: 0x2a4a66 });
  crane.addChild(craneG);
  root.addChild(crane);

  // Emissive charge rack + a vent stack: extra orange pop and a taller
  // silhouette element on the workshop's east side.
  const stack = new Graphics();
  stack.rect(88, -6, 10, 4);
  stack.fill({ color: PALETTE.structure });
  stack.rect(90, -44, 6, 38);
  stack.fill({ color: PALETTE.structureLight });
  stack.rect(89, -44, 8, 2);
  stack.fill({ color: PALETTE.orange, alpha: 0.8 });
  root.addChild(stack);
  root.addChild(glow(93, -46, 16, PALETTE.orange, 0.3));
  root.addChild(crate(-78, 30));
  root.addChild(crate(-68, 36, 8));

  // Repair bot silhouette at the bench + pooled spark flashes.
  const bot = agentFigure(10, -6, 20, PALETTE.aqua, 0.9);
  bot.alpha = 0;
  root.addChild(bot);
  const sparks: Sprite[] = [];
  for (let i = 0; i < 3; i++) {
    const s = glow(8 + rand() * 20, -18 - rand() * 8, 12, 0xffffff, 0);
    root.addChild(s);
    sparks.push(s);
  }

  // Standby lamp on the bench's left end: the workshop reads "on call",
  // not abandoned. Blinks slowly; static under reduced motion.
  const standbyLamp = glow(-20, -12, 14, PALETTE.warning, 0.2);
  root.addChild(standbyLamp);
  animatedTargets.push(standbyLamp);
  if (!ctx.reducedMotion) {
    gsap.to(standbyLamp, {
      alpha: 0.45,
      duration: 2.8,
      yoyo: true,
      repeat: -1,
      ease: "sine.inOut",
    });
  }

  // Tool-wall worklight: dark until a repair is dispatched, then the wall
  // visibly lights up while the bot works (and dims after).
  const workLight = glow(-49, -40, 64, PALETTE.orange, 0);
  root.addChild(workLight);
  animatedTargets.push(workLight);

  const api: RecoveryApi = {
    dispatchRepair(): void {
      animatedTargets.push(bot, crane, workLight, ...sparks);
      gsap.to(bot, { alpha: 0.95, duration: 0.3 });
      gsap.to(workLight, { alpha: 0.5, duration: 0.4 });
      gsap.to(crane, { angle: -8, duration: 0.6, yoyo: true, repeat: 1 });
      sparks.forEach((s, i) => {
        gsap.to(s, {
          alpha: 0.9,
          duration: 0.12,
          delay: 0.5 + i * 0.45,
          onComplete: () => gsap.to(s, { alpha: 0, duration: 0.25 }),
        });
      });
      // A mended capsule leaves the bench and re-racks.
      const mended = glyphMark("capsule", PALETTE.orange);
      mended.position.set(6, -16);
      mended.alpha = 0;
      root.addChild(mended);
      animatedTargets.push(mended);
      gsap.to(mended, { alpha: 1, duration: 0.3, delay: 1.6 });
      gsap.to(mended, {
        x: 66,
        y: 10,
        duration: 0.9,
        delay: 2.0,
        ease: "power1.inOut",
        onComplete: () =>
          gsap.to(mended, {
            alpha: 0,
            duration: 0.4,
            delay: 0.8,
            onComplete: () => safeDestroy(mended),
          }),
      });
      gsap.to(bot, { alpha: 0, duration: 0.5, delay: 3.2 });
      gsap.to(workLight, { alpha: 0, duration: 0.8, delay: 3.0 });
    },
  };

  stationSign(ctx, "recoveryWorkshop", 82);
  registerStation({ id: "recoveryWorkshop", root, hit, api });
}

// ===========================================================================
// 8. OBSERVABILITY: trace waterfall, latency histogram, worker health
// ===========================================================================

function buildObservability(ctx: DioramaContext): void {
  const { root, hit } = stationBase(ctx, "observability");

  // Shallow console desk: the anchor sits ~20 units off the room's south-east
  // edge, so the footprint stays narrow and the screens stand above it as
  // billboards. Same desk + screen family as the west consoles.
  contactShadow(root, -6, 6, 108, 48);
  root.addChild(isoBox({ x: -8, y: 2, w: 92, d: 34, h: 12, color: PALETTE.structure, rim: PALETTE.structureLight }));

  // Screen 1: trace waterfall (3 colored traces stepping down). The traces
  // container is anchored at the panel's top-left corner; screenPanel draws
  // its frame at local coordinates while the container stays at (0,0), so
  // children must be offset explicitly.
  const s1 = screenPanel({ x: -58, y: -52, w: 48, h: 40, accent: PALETTE.cyan });
  const traces = new Container();
  traces.position.set(-58, -52);
  const traceColors = [PALETTE.cyan, PALETTE.violet, PALETTE.aqua];
  traceColors.forEach((tc, i) => {
    const t = new Graphics();
    let ox = 0;
    for (let s = 0; s < 6; s++) {
      const w = 6 + rand() * 10;
      t.rect(ox, 0, w, 3);
      t.fill({ color: tc, alpha: 1 });
      ox += w + 5;
    }
    t.position.set(0, 6 + i * 11);
    traces.addChild(t);
  });
  s1.addChild(traces);
  root.addChild(s1);

  // Screen 2: latency histogram.
  const s2 = screenPanel({ x: -2, y: -56, w: 48, h: 44, accent: PALETTE.blue });
  const hist = new Graphics();
  for (let i = 0; i < 6; i++) {
    const bh = 8 + rand() * 22;
    hist.rect(2 + i * 7.5, 40 - bh, 5, bh);
    hist.fill({ color: i === 4 ? PALETTE.warning : PALETTE.blue, alpha: 0.85 });
  }
  s2.addChild(hist);
  root.addChild(s2);

  // Screen 3: worker health row (5 dots, one occasionally amber).
  const s3 = screenPanel({ x: 50, y: -52, w: 48, h: 40, accent: PALETTE.healthy });
  const healthDots: Graphics[] = [];
  for (let i = 0; i < 5; i++) {
    const d = new Graphics();
    d.circle(0, 0, 3);
    d.fill({ color: PALETTE.healthy });
    d.position.set(5 + i * 9, 20);
    s3.addChild(d);
    healthDots.push(d);
  }
  root.addChild(s3);

  // Shared cheap ticker: traces step down/right, one worker goes amber.
  ctx.onTick(() => {
    if (ctx.reducedMotion) return;
    const t = performance.now() / 1000;
    traces.children.forEach((tr, i) => {
      const span = 60;
      tr.x = ((t * (10 + i * 3)) % span) - 12;
    });
    const amberWorker = Math.floor(t / 12) % healthDots.length;
    healthDots.forEach((d, i) => {
      const amber = i === (amberWorker + 2) % healthDots.length && t % 12 > 8;
      d.tint = amber ? 0xffbe4a : 0xffffff;
    });
  });

  stationSign(ctx, "observability", 72);
  registerStation({ id: "observability", root, hit });
}

// ===========================================================================
// 9. ACTIVITY GALLERY: chronological plaques for human actions
// ===========================================================================

const GALLERY_ACTIONS: { glyph: (g: Graphics) => void; tint: number }[] = [
  {
    glyph: (g) => {
      g.poly([0, -6, 6, 0, 0, 6, -6, 0]);
      g.poly([-2, 0, 0.5, 2, 3, -2]);
    },
    tint: PALETTE.healthy,
  }, // approve check
  {
    glyph: (g) => {
      g.rect(-5, -6, 4, 12);
      g.rect(1, -6, 4, 12);
    },
    tint: PALETTE.waiting,
  }, // pause bars
  {
    glyph: (g) => {
      g.poly([0, -6, 6, 3, -6, 3]);
      g.rect(-1.5, 3, 3, 4);
    },
    tint: PALETTE.warning,
  }, // reduce down-arrow
  {
    glyph: (g) => {
      g.moveTo(-4, -4);
      g.lineTo(4, 4);
      g.moveTo(4, -4);
      g.lineTo(-4, 4);
      g.stroke({ width: 2.4, color: 0xffffff });
    },
    tint: PALETTE.blocked,
  }, // close x
];

function buildActivityGallery(ctx: DioramaContext): void {
  const { root, hit } = stationBase(ctx, "activityGallery");

  contactShadow(root, 2, 4, 170, 48);
  // Plaque wall. Four large plaques instead of five cramped ones: the human
  // actions stay readable at fit zoom.
  const wallG = new Graphics();
  wallG.roundRect(-75, -54, 150, 48, 4);
  wallG.fill({ color: PALETTE.structure });
  wallG.roundRect(-75, -54, 150, 48, 4);
  wallG.stroke({ width: 1.5, color: PALETTE.structureLight, alpha: 0.9 });
  root.addChild(wallG);

  // Four plaques left (oldest) to right (newest); newest glows softly.
  const newestGlow = glow(58, -35, 42, PALETTE.aqua, 0.35);
  root.addChild(newestGlow);
  GALLERY_ACTIONS.forEach((a, i) => {
    const px = -68 + i * 37;
    const py = -46;
    const plaque = new Graphics();
    plaque.roundRect(px, py, 32, 30, 2);
    plaque.fill({ color: PALETTE.structureLight });
    plaque.roundRect(px, py, 32, 30, 2);
    plaque.stroke({ width: 1, color: a.tint, alpha: 0.7 });
    // Time glyph: small clock circle top-left.
    plaque.circle(px + 8, py + 8, 3.5);
    plaque.stroke({ width: 1, color: PALETTE.inkDim, alpha: 0.9 });
    root.addChild(plaque);
    const act = new Graphics();
    a.glyph(act);
    if (a.tint !== PALETTE.blocked) act.tint = a.tint;
    act.position.set(px + 21, py + 17);
    root.addChild(act);
  });

  if (!ctx.reducedMotion) {
    ctx.onTick(() => {
      newestGlow.alpha = 0.28 + 0.14 * Math.sin(performance.now() / 900);
    });
  }

  stationSign(ctx, "activityGallery", 66);
  registerStation({ id: "activityGallery", root, hit });
}

// ===========================================================================
// 10. PORTFOLIO VAULT: transparent case of account-state blocks
// ===========================================================================

function buildPortfolioVault(ctx: DioramaContext): void {
  const { root, hit } = stationBase(ctx, "portfolioVault");

  contactShadow(root, 4, 8, 160, 104);
  // Vault plinth + glass case (low-alpha walls, gold frame edges).
  root.addChild(
    isoBox({ x: 0, y: 0, w: 138, d: 96, h: 8, color: PALETTE.structure, rim: PALETTE.yellow }),
  );
  root.addChild(
    isoWall({
      x1: -56,
      y1: -36,
      x2: -56,
      y2: 34,
      h: 36,
      color: 0x8fd8e8,
      alpha: 0.12,
      rim: PALETTE.yellow,
    }),
    isoWall({
      x1: 56,
      y1: -36,
      x2: 56,
      y2: 34,
      h: 36,
      color: 0x8fd8e8,
      alpha: 0.12,
      rim: PALETTE.yellow,
    }),
    isoWall({
      x1: -56,
      y1: -36,
      x2: 56,
      y2: -36,
      h: 36,
      color: 0x8fd8e8,
      alpha: 0.1,
      rim: PALETTE.yellow,
    }),
  );

  // Pedestals + account-state blocks. Deliberately no coins.
  const mkBlock = (
    bx: number,
    bz: number,
    w: number,
    h: number,
    d2: number,
    color: number,
  ): void => {
    root.addChild(isoBox({ x: bx, y: 2, w: 10, d: 10, h: bz, color: PALETTE.structureLight }));
    root.addChild(isoBox({ x: bx, y: 2 - bz, w, h, d: d2, color, rim: color }));
  };
  mkBlock(-36, 10, 26, 12, 14, PALETTE.yellow); // capital slab
  mkBlock(-6, 10, 16, 16, 12, PALETTE.healthy); // realized block
  mkBlock(20, 10, 16, 16, 12, PALETTE.violet); // unrealized block
  // Balance: two pale small blocks.
  mkBlock(44, 10, 12, 10, 9, PALETTE.surfacePale);
  mkBlock(44, 20, 10, 8, 8, PALETTE.surfacePale);

  const pulses: Record<string, Sprite> = {
    capital: glow(-36, -20, 30, PALETTE.yellow, 0),
    realized: glow(-6, -24, 26, PALETTE.healthy, 0),
    unrealized: glow(20, -24, 26, PALETTE.violet, 0),
    balance: glow(44, -26, 22, PALETTE.surfacePale, 0),
  };
  for (const s of Object.values(pulses)) root.addChild(s);

  const api: PortfolioVaultApi = {
    pulse(block): void {
      const s = pulses[block];
      if (!s) return;
      animatedTargets.push(s);
      gsap.to(s, {
        alpha: 0.6,
        duration: 0.3,
        onComplete: () => gsap.to(s, { alpha: 0, duration: 1.0, delay: 0.4 }),
      });
    },
  };

  stationSign(ctx, "portfolioVault", 68);
  registerStation({ id: "portfolioVault", root, hit, api });
}

// ===========================================================================
// 11. IDENTITY GATE: kiosks + scanner arch across the east walkway
// ===========================================================================

function buildIdentityGate(ctx: DioramaContext): void {
  const { root, hit } = stationBase(ctx, "identityGate");

  contactShadow(root, 0, 4, 118, 56);
  // Two kiosks flanking the walkway line. The gate is deliberately narrow:
  // the observability console sits just north-east, and the two structures
  // must not touch.
  root.addChild(
    isoBox({ x: -38, y: 0, w: 30, d: 26, h: 20, color: PALETTE.structure, rim: PALETTE.aqua }),
  );
  root.addChild(
    isoBox({ x: 38, y: 0, w: 30, d: 26, h: 20, color: PALETTE.structure, rim: PALETTE.aqua }),
  );
  // Overhead scanner arch with a soft beam down onto the walkway.
  root.addChild(arch(0, -4, 64, 42, PALETTE.structureLight, PALETTE.aqua));
  const scan = lightBeam(0, -2, 8, 26, 42, PALETTE.aqua, 0.14);
  root.addChild(scan);

  // Gate ring light around the arch opening.
  const ring = new Graphics();
  ring.ellipse(0, -16, 22, 9);
  ring.stroke({ width: 2, color: PALETTE.waiting, alpha: 0.8 });
  root.addChild(ring);

  // Physical barrier (flicks up on refusal) + pooled badge diamonds.
  const barrier = new Container();
  barrier.position.set(0, 2);
  const barG = new Graphics();
  barG.rect(-22, -2, 44, 4);
  barG.fill({ color: PALETTE.structureLight });
  barG.rect(-22, -2, 44, 1.2);
  barG.fill({ color: PALETTE.blocked, alpha: 0.8 });
  barrier.addChild(barG);
  barrier.angle = 84; // lying flat/open against the kiosk
  root.addChild(barrier);

  const badge = new Graphics();
  badge.poly([0, -6, 4.5, 0, 0, 6, -4.5, 0]);
  badge.fill({ color: PALETTE.cyan, alpha: 0.95 });
  badge.position.set(0, 60);
  badge.zIndex = DEPTH.packet;
  root.addChild(badge);

  let refusalPush: ((reason: string) => void) | undefined;

  const api: IdentityGateApi = {
    attempt(passes: boolean, reason?: string): void {
      animatedTargets.push(badge, ring, barrier, scan);
      badge.position.set(0, 60);
      badge.tint = 0xffffff;
      if (passes) {
        gsap.to(ring, {
          alpha: 0.3,
          duration: 0.2,
          onComplete: () => gsap.to(ring, { alpha: 1, duration: 0.5 }),
        });
        ring.tint = PALETTE.healthy;
        gsap.to(badge, {
          y: -64,
          duration: ctx.reducedMotion ? 0.4 : 1.6,
          ease: "none",
          onComplete: () =>
            gsap.to(badge, { alpha: 0, duration: 0.4, onComplete: () => (badge.alpha = 1) }),
        });
      } else {
        ring.tint = PALETTE.blocked;
        badge.tint = 0xff6b75;
        gsap.to(barrier, { angle: 0, duration: 0.18, ease: "power3.out" });
        gsap.to(badge, {
          y: 44,
          duration: 0.5,
          ease: "power2.out",
          onComplete: () => {
            gsap.to(badge, {
              alpha: 0,
              duration: 0.4,
              delay: 0.6,
              onComplete: () => (badge.alpha = 1),
            });
            gsap.to(barrier, { angle: 84, duration: 0.6, delay: 0.8 });
          },
        });
        if (refusalPush) refusalPush(reason ?? "PERMISSION DENIED");
      }
    },
  };

  // Idle: a badge sails through every ~10 s.
  every(10, 6.0, () => api.attempt(true));

  stationSign(ctx, "identityGate", 68, -30);
  registerStation({ id: "identityGate", root, hit, api });

  buildRefusalDisplay(ctx, (push) => {
    refusalPush = push;
  });
}

// ===========================================================================
// 12. REFUSAL DISPLAY: last two refusals as icon + reason chips
// ===========================================================================

/** Real mission failure reasons (mission.ts failure causes + trading docs). */
const REFUSAL_REASONS = [
  "LOSS BUDGET SPENT",
  "PROTECTION FAILURE",
  "WAKE BUDGET EXHAUSTED",
  "NEEDS TRADING ACCOUNT",
  "PLAN DOCUMENT DRIFTED",
];

function buildRefusalDisplay(
  ctx: DioramaContext,
  link: (push: (reason: string) => void) => void,
): void {
  const { root, hit } = stationBase(ctx, "refusalDisplay");

  contactShadow(root, 2, 3, 130, 30, 0.25);
  // Board with a calm red trim (normal state, not catastrophe). Backing is
  // lifted bright so the red reason text stays readable at fit zoom.
  const board = new Graphics();
  board.roundRect(-60, -36, 120, 44, 4);
  board.fill({ color: PALETTE.structureLight });
  board.roundRect(-60, -36, 120, 44, 4);
  board.stroke({ width: 1.8, color: PALETTE.blocked, alpha: 0.85 });
  board.rect(-60, 5, 120, 1.5);
  board.fill({ color: PALETTE.blocked, alpha: 0.45 });
  root.addChild(board);

  // Two chip slots, each an icon diamond + real Text (never baked).
  const chips: Container[] = [];
  for (let i = 0; i < 2; i++) {
    const chip = new Container();
    const icon = new Graphics();
    icon.poly([0, -4.5, 3.5, 0, 0, 4.5, -3.5, 0]);
    icon.fill({ color: PALETTE.blocked, alpha: 0.9 });
    icon.position.set(-44, 0);
    chip.addChild(icon);
    const label = new Text({ text: "", style: tinyStyle(8.5, PALETTE.ink) });
    label.resolution = 2;
    label.anchor.set(0, 0.5);
    label.position.set(-38, 0);
    chip.addChild(label);
    chip.position.set(0, -24 + i * 17);
    root.addChild(chip);
    chips.push(chip);
  }

  const queue: string[] = ["LOSS BUDGET SPENT", "PROTECTION FAILURE"];
  const render = (): void => {
    chips.forEach((chip, i) => {
      const text = queue[i];
      const label = chip.children[1] as Text;
      label.text = text ?? "";
      chip.visible = Boolean(text);
    });
  };
  render();

  const push = (reason: string): void => {
    const norm = REFUSAL_REASONS.includes(reason) ? reason : reason.toUpperCase().slice(0, 24);
    queue.pop();
    queue.unshift(norm);
    render();
    animatedTargets.push(chips[0]);
    gsap.fromTo(chips[0], { alpha: 0.2 }, { alpha: 1, duration: 0.4 });
  };
  link(push);

  const api: RefusalBoardApi = { push };
  stationSign(ctx, "refusalDisplay", 52);
  registerStation({ id: "refusalDisplay", root, hit, api });
}

// ===========================================================================
// District entry
// ===========================================================================

export function buildOpsDistrict(ctx: DioramaContext): void {
  // Module state must not survive a route teardown: under Astro client-side
  // routing this module persists, and stale loops/targets would keep firing
  // closures over destroyed Pixi objects in the next visit's ticker.
  idleLoops.length = 0;
  animatedTargets.length = 0;

  buildStateStore(ctx);
  buildRailYard(ctx);
  buildReconciliationDock(ctx);
  buildReceiptPrinter(ctx);
  buildAuditArchive(ctx);
  buildReplayChamber(ctx);
  buildRecoveryWorkshop(ctx);
  buildObservability(ctx);
  buildActivityGallery(ctx);
  buildPortfolioVault(ctx);
  buildIdentityGate(ctx); // also builds + links the refusal display

  // One shared ticker drives every idle loop with its own phase offset.
  let t = 0;
  ctx.onTick((ticker) => {
    t += ticker.deltaMS / 1000;
    for (const loop of idleLoops) {
      const idx = Math.floor((t + loop.phase) / loop.period);
      if (idx > loop.last) {
        loop.last = idx;
        loop.fire();
      }
    }
  });

  ctx.onCleanup(() => {
    for (const target of animatedTargets) gsap.killTweensOf(target);
    idleLoops.length = 0;
    animatedTargets.length = 0;
  });
}
