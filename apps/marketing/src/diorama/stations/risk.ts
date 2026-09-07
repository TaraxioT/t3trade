/**
 * East section, guarded-execution band. Six survivors (freeze §1):
 * CONTROLS (operator control kiosk), LOSS BUDGET (single maximum-cumulative-
 * loss reservoir), RISK GUARDS (four check lamps + one scanning arch),
 * PROTECTION (orbiting positions with shield states), LOCAL SIGNING (demoted
 * sealed module), EXECUTION (execution-state progression strip). Owner: east
 * lane (risk.ts). Approval and permission are cut per freeze §1; the approval
 * pad's floor space simply empties.
 *
 * Product truth mirrored here: there is no human approval gate in the order
 * path. Human authority is the CONTROLS kiosk; deterministic guards either
 * pass a scan or refuse with a stated reason. Capability checks survive as
 * quiet hex badges on the RISK GUARDS apron.
 *
 * Shared language (R6): standard booth/desk family (structural-blue isoTile
 * platforms, low isoWall backs, gold district accent) and the common sign
 * system. Station screen copy renders only through the local detailText
 * helper (registered detail, tier >= 1.8). All statics draw once; motion uses
 * pooled sprites and tracked GSAP timelines killed on cleanup. There are no
 * internal demo loops: the flow director and the event bindings own when this
 * district moves.
 */
import { Container, Graphics, Sprite, Text, TextStyle } from "pixi.js";
import { gsap } from "gsap";
import type { DioramaContext } from "../core/context.js";
import { STATIONS, type StationId } from "../config/stations.js";
import { DEPTH } from "../config/world.js";
import { PALETTE } from "../config/palette.js";
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
  safeDestroy,
} from "../core/iso.js";
import { adoptDetailText, makeSign } from "../core/signs.js";
import { registerStation } from "../core/registry.js";

export type ControlKind =
  | "pause"
  | "resume"
  | "revoke"
  | "cancel_entries"
  | "reduce"
  | "close"
  | "close_and_revoke";

export interface EmergencyPanelApi {
  /**
   * Operator control fires: visual confirmation flash + status lamp. No agent
   * actor is required; controls outrank the agent provider.
   */
  runControl(control: ControlKind, reductionPercent?: 25 | 50 | 75 | 100): void;
}

export interface BudgetMeterApi {
  /**
   * Consume loss-budget percentage POINTS on the 0..100 scale (4 = 4% of the
   * maximum cumulative loss). The visual is the single loss reservoir, so
   * every call draws the same bar.
   */
  consume(points: number): void;
  /** Set the remaining allowance as a fraction 0..1 (used becomes 1 - fraction). */
  setRemaining(fraction: number): void;
}

export interface RiskFortressApi {
  /**
   * A checked order walks the scanning arch and the guard lamps. On fail the
   * reason is shown verbatim ("cumulative loss limit" | "protection failure" |
   * "wake budget exhausted") as registered detail.
   */
  runScan(pass: boolean, reason?: string): void;
}

export type ProtectionState = "stop_on_exchange" | "server_executed" | "unprotected";

export interface ProtectionApi {
  /** Attach layered shields to a position token passing through. */
  shieldUp(): void;
  /** Exchange-native protection state; the label is registered detail text. */
  setState(state: ProtectionState): void;
}

export interface SignerVaultApi {
  /** Signing pulse: packet in, pulse, signed packet out. Never key imagery. */
  signPulse(): void;
}

export type ExecutionState =
  | "idle"
  | "previewed"
  | "reserved"
  | "signed"
  | "submitted"
  | "accepted"
  | "filled"
  | "rejected"
  | "cancelled"
  | "failed";

export interface ExecutionGatewayApi {
  /** Execution-state progression strip; terminal alternatives are refused. */
  setState(state: ExecutionState): void;
}

type Killable = gsap.core.Timeline | gsap.core.Tween;

const killables: Killable[] = [];
const track = <T extends Killable>(k: T): T => {
  killables.push(k);
  return k;
};
/** Duration helper: near-instant when reduced motion is requested. */
let reduced = false;
const d = (seconds: number): number => (reduced ? 0.04 : seconds);

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

interface StationBase {
  root: Container;
}

/** Roots and hit surfaces created by stationBase, for registration. */
const stationParts: Partial<Record<StationId, { root: Container; hit: Container }>> = {};

function stationBase(ctx: DioramaContext, id: StationId): StationBase {
  const def = STATIONS[id];
  const root = new Container();
  root.position.set(def.anchor.x, def.anchor.y);
  root.zIndex = def.anchor.y + DEPTH.base;
  ctx.layers.sortable.addChild(root);

  const hit = new Graphics();
  const hw = def.size.w / 2;
  const hd = def.size.d / 2;
  hit.poly([0, -hd, hw, 0, 0, hd, -hw, 0]);
  hit.fill({ color: 0xffffff, alpha: 0.008 });
  hit.eventMode = "static";
  hit.cursor = "pointer";
  root.addChild(hit);
  stationParts[id] = { root, hit };
  return { root };
}

/** Station sign into the shared labels layer, above the structure. */
function stationSign(
  ctx: DioramaContext,
  id: StationId,
  lift: number,
  accent?: number,
): Container & { signText: Text } {
  const def = STATIONS[id];
  const sign = makeSign(def.label, {
    x: def.anchor.x,
    y: def.anchor.y - lift,
    size: def.signSize,
    accent: accent ?? PALETTE.cyan,
    halo: true,
    lod: def.lod,
    stationId: id,
  });
  sign.zIndex = def.anchor.y + DEPTH.overlay;
  ctx.layers.labels.addChild(sign);
  return sign;
}

/**
 * Registered detail text (freeze §5): station screen copy, adopted into the
 * sign registry under the building station's id, so tier gating, focus
 * forcing, and focus dimming all flow through the shared policy. The owner is
 * set around each builder call in buildRiskDistrict; every piece of screen
 * copy is produced through this helper.
 */
let detailOwner = "";

function detailText(text: string, size: number, fill: number): Text {
  const t = new Text({
    text,
    style: new TextStyle({
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      fontSize: size,
      letterSpacing: size * 0.08,
      fill,
    }),
  });
  t.resolution = 2;
  adoptDetailText(t, detailOwner);
  return t;
}

/** Run a builder with detailText strings attributed to one station. */
function buildWithOwner<T>(id: StationId, build: () => T): T {
  const previous = detailOwner;
  detailOwner = id;
  try {
    return build();
  } finally {
    detailOwner = previous;
  }
}

/** Pooled order capsule (pooled look, tintable). */
function makeCapsule(color: number): Container & { body: Graphics } {
  const c = new Container() as Container & { body: Graphics };
  const body = new Graphics();
  body.roundRect(-11, -7, 22, 14, 7);
  body.fill({ color });
  body.roundRect(-11, -7, 22, 14, 7);
  body.stroke({ width: 1.2, color: PALETTE.surfacePale, alpha: 0.7 });
  body.rect(-4, -2, 8, 4);
  body.fill({ color: PALETTE.surfacePale, alpha: 0.35 });
  const halo = glow(0, 0, 30, color, 0.4);
  c.addChild(halo, body);
  c.body = body;
  c.visible = false;
  return c;
}

/** Flat hexagon path centered at 0,0. */
function hexPath(g: Graphics, r: number): void {
  const pts: number[] = [];
  for (let i = 0; i < 6; i++) {
    const a = ((60 * i - 30) * Math.PI) / 180;
    pts.push(Math.cos(a) * r, Math.sin(a) * r);
  }
  g.poly(pts);
}

/**
 * Soft dark ground ellipse added right after the hit surface so each
 * structure grounds onto the platform. Coordinates are root-local.
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

// ---------------------------------------------------------------------------
// 1. CONTROLS: operator control kiosk (hero, overview board)
// ---------------------------------------------------------------------------

/** Product-true control list shown as registered detail on the kiosk screen. */
const CONTROL_ROWS: string[] = [
  "Pause",
  "Cancel entries",
  "Reduce 25% 50% 75% 100%",
  "Close",
  "Revoke",
  "Close and revoke",
];

/** Which screen row / button a control kind drives (resume re-arms Pause). */
const CONTROL_INDEX: Record<ControlKind, number> = {
  pause: 0,
  resume: 0,
  cancel_entries: 1,
  reduce: 2,
  close: 3,
  revoke: 4,
  close_and_revoke: 5,
};

/** Semantic lamp color per control; the kiosk rests calm and armed. */
const CONTROL_LAMP: Record<ControlKind, number> = {
  pause: PALETTE.waiting,
  resume: PALETTE.healthy,
  revoke: PALETTE.emergency,
  cancel_entries: PALETTE.warning,
  reduce: PALETTE.warning,
  close: PALETTE.warning,
  close_and_revoke: PALETTE.emergency,
};

function buildEmergencyPanel(ctx: DioramaContext): EmergencyPanelApi {
  const { root } = stationBase(ctx, "emergencyPanel");

  contactShadow(root, 0, 6, 100, 62, 0.25);
  // Pad + pedestal + red-trimmed panel box. Emergency red is semantic here.
  root.addChild(isoTile(0, 4, 78, 46, PALETTE.structure, 1, PALETTE.emergency));
  root.addChild(isoBox({ x: 0, y: 6, w: 26, d: 16, h: 9, color: PALETTE.structure }));

  const box = new Graphics();
  box.roundRect(-16, -52, 32, 50, 5);
  box.fill({ color: PALETTE.structure });
  box.roundRect(-16, -52, 32, 50, 5);
  box.stroke({ width: 2, color: PALETTE.emergency, alpha: 0.95 });
  root.addChild(box);

  // 2x3 control button grid on the panel face; each control kind flashes its
  // button. Buttons are position-coded; names live on the screen above.
  const buttons: Graphics[] = [];
  for (let i = 0; i < CONTROL_ROWS.length; i++) {
    const bx = i % 2 === 0 ? -7 : 7;
    const by = -44 + Math.floor(i / 2) * 12;
    const b = new Graphics();
    b.roundRect(bx - 4.5, by - 3.5, 9, 7, 2);
    b.fill({ color: PALETTE.structureLight });
    b.roundRect(bx - 4.5, by - 3.5, 9, 7, 2);
    b.stroke({ width: 1, color: PALETTE.emergency, alpha: 0.7 });
    root.addChild(b);
    buttons.push(b);
  }

  // Status lamp above the box: calm healthy at rest, semantic flash per
  // control, then back to the armed breathing.
  const lampDot = new Graphics();
  lampDot.circle(0, -57, 2.5);
  lampDot.fill({ color: 0xffffff });
  lampDot.tint = PALETTE.healthy;
  root.addChild(lampDot);
  const lampGlow = glow(0, -57, 12, PALETTE.healthy, 0.6);
  root.addChild(lampGlow);
  const REST_ALPHA = 0.55;
  const startBreathing = (): void => {
    gsap.killTweensOf(lampGlow);
    lampGlow.alpha = REST_ALPHA;
    if (ctx.reducedMotion) return;
    track(
      gsap.to(lampGlow, {
        alpha: 0.3,
        duration: 1.2,
        yoyo: true,
        repeat: -1,
        ease: "sine.inOut",
      }),
    );
  };
  startBreathing();

  // Confirmation flare: dedicated expanding ring so a control flash never
  // fights the lamp's idle breathing tween.
  const confirmRing = glow(0, -30, 12, PALETTE.healthy, 0.9);
  root.addChild(confirmRing);

  // Control screen carrying the product-true control list (registered
  // detail). One row per control, mirroring the button grid order.
  const screen = new Graphics();
  screen.roundRect(-59, -150, 118, 78, 5);
  screen.fill({ color: 0x07111f, alpha: 0.88 });
  screen.roundRect(-59, -150, 118, 78, 5);
  screen.stroke({ width: 1.5, color: PALETTE.emergency, alpha: 0.8 });
  root.addChild(screen);
  const controlRows: Container[] = [];
  CONTROL_ROWS.forEach((label, i) => {
    const row = new Container();
    row.position.set(-53, -140 + i * 11.5);
    const tick = new Graphics();
    tick.poly([0, -2.5, 2.5, 0, 0, 2.5, -2.5, 0]);
    tick.fill({ color: PALETTE.inkDim, alpha: 0.9 });
    row.addChild(tick);
    row.addChild(detailText(label, 7, PALETTE.ink));
    root.addChild(row);
    controlRows.push(row);
  });

  stationSign(ctx, "emergencyPanel", 168, PALETTE.emergency);

  let tl: Killable | null = null;
  const api: EmergencyPanelApi = {
    runControl(control, _reductionPercent) {
      tl?.kill();
      gsap.killTweensOf([lampGlow, confirmRing]);
      gsap.killTweensOf(controlRows[CONTROL_INDEX[control]]);
      const color = CONTROL_LAMP[control];
      const idx = CONTROL_INDEX[control];
      lampDot.tint = color;
      lampGlow.tint = color;
      lampGlow.alpha = 0.95;
      confirmRing.tint = color;
      confirmRing.width = 12;
      confirmRing.height = 12;
      confirmRing.alpha = 0.9;
      const row = controlRows[idx];
      const t = track(gsap.timeline());
      tl = t;
      t.to(
        confirmRing,
        { width: 56, height: 56, alpha: 0, duration: d(0.5), ease: "power1.out" },
        0,
      )
        .fromTo(row, { alpha: 0.25 }, { alpha: 1, duration: d(0.14), repeat: 3, yoyo: true }, 0)
        .fromTo(
          buttons[idx],
          { alpha: 0.2 },
          { alpha: 1, duration: d(0.14), repeat: 3, yoyo: true },
          0,
        )
        .to(lampGlow, { alpha: 0.7, duration: d(0.7) })
        .call(() => {
          lampDot.tint = PALETTE.healthy;
          lampGlow.tint = PALETTE.healthy;
          startBreathing();
        });
    },
  };
  return api;
}

// ---------------------------------------------------------------------------
// 2. LOSS BUDGET: single maximum-cumulative-loss reservoir
// ---------------------------------------------------------------------------

/** Remaining allowance at a fresh mission budget (matches the card status). */
const INITIAL_REMAINING = 0.82;
/** Budget a pending entry holds before its fill consumes it. */
const RESERVE = 0.06;

function buildBudgetMeter(ctx: DioramaContext): BudgetMeterApi {
  const { root } = stationBase(ctx, "budgetMeter");

  contactShadow(root, 0, 16, 150, 100);
  root.addChild(isoTile(0, 14, 140, 92, PALETTE.structure, 1, PALETTE.structureLight));
  root.addChild(
    isoBox({ x: 0, y: 8, w: 124, d: 54, h: 8, color: PALETTE.structureLight, rim: PALETTE.blue }),
  );

  // One honest reservoir: fill rising from the bottom is budget already used
  // against the maximum cumulative loss; the headroom above is what remains.
  const TUBE_H = 84;
  const baseY = -10;
  let remaining = INITIAL_REMAINING;

  const tube = new Graphics();
  tube.roundRect(-8, baseY - TUBE_H - 4, 16, TUBE_H + 8, 8);
  tube.fill({ color: PALETTE.surfacePale, alpha: 0.06 });
  tube.roundRect(-8, baseY - TUBE_H - 4, 16, TUBE_H + 8, 8);
  tube.stroke({ width: 1.2, color: PALETTE.surfacePale, alpha: 0.4 });
  for (let q = 1; q <= 3; q++) {
    const ty = baseY - (TUBE_H * q) / 4;
    tube.moveTo(9, ty);
    tube.lineTo(13, ty);
    tube.stroke({ width: 1, color: PALETTE.inkDim, alpha: 0.5 });
  }
  root.addChild(tube);

  const liquid = new Container();
  liquid.position.set(0, baseY);
  const lg = new Graphics();
  lg.roundRect(-7, -TUBE_H, 14, TUBE_H, 6);
  lg.fill({ color: 0xffffff, alpha: 0.78 });
  lg.rect(-7, -TUBE_H, 14, 1.5);
  lg.fill({ color: PALETTE.surfacePale, alpha: 0.85 });
  lg.tint = PALETTE.warning;
  liquid.addChild(lg);
  root.addChild(liquid);

  // Pending-entry reservation notch: a cyan bracket marking the slice a
  // pending entry holds above the used level, before its fill consumes it.
  const notch = new Container();
  const notchG = new Graphics();
  notchG.moveTo(8, 0);
  notchG.lineTo(15, 0);
  notchG.stroke({ width: 1.4, color: PALETTE.cyan, alpha: 0.95 });
  notchG.poly([5, 0, 8, -2.5, 11, 0, 8, 2.5]);
  notchG.fill({ color: PALETTE.cyan, alpha: 0.95 });
  notch.addChild(notchG);
  root.addChild(notch);

  const bubble = glow(0, baseY - 6, 10, PALETTE.warning, 0);
  root.addChild(bubble);

  const title = detailText("MAXIMUM CUMULATIVE LOSS", 7, PALETTE.inkDim);
  title.anchor.set(0.5);
  title.position.set(0, -106);
  root.addChild(title);
  const readout = detailText("", 7, PALETTE.ink);
  readout.anchor.set(0.5);
  readout.position.set(0, 32);
  root.addChild(readout);

  const usedOf = (): number => 1 - remaining;
  // Readouts and the notch track the animated fill level, so the caption and
  // reservation stay coherent with the bar while it moves. Red is reserved
  // for a genuinely exhausted budget and holds until an external call resets.
  const syncFromScale = (): void => {
    const used = liquid.scale.y;
    notch.y = -Math.min(0.97, used + RESERVE) * TUBE_H;
    lg.tint = used >= 0.999 ? PALETTE.blocked : PALETTE.warning;
    readout.text = `Used ${Math.round(used * 100)}% · Remaining ${Math.round((1 - used) * 100)}%`;
  };
  liquid.scale.y = usedOf();
  syncFromScale();

  stationSign(ctx, "budgetMeter", 124);

  const animateTo = (nextRemaining: number): void => {
    // Full 0..1 range on purpose: the meter must be able to show an exhausted
    // (empty) budget instead of silently clamping away the loss.
    remaining = Math.max(0, Math.min(1, nextRemaining));
    gsap.killTweensOf([liquid.scale, bubble, notch]);
    bubble.alpha = 0.9;
    bubble.y = baseY - 6;
    track(
      gsap
        .timeline()
        .to(
          liquid.scale,
          { y: usedOf(), duration: d(0.9), ease: "power2.inOut", onUpdate: syncFromScale },
          0,
        )
        .to(bubble, { y: baseY - 6 - TUBE_H * usedOf(), duration: d(0.7), ease: "sine.out" }, 0)
        .to(bubble, { alpha: 0, duration: d(0.7) }, 0)
        .call(syncFromScale, undefined, d(0.92)),
    );
  };

  const api: BudgetMeterApi = {
    consume(points) {
      // Units are percentage points of the 0..100 maximum. No rollover or
      // replenish: an exhausted budget stays empty/red until an external
      // setRemaining/consume moves it back.
      animateTo(remaining - Math.max(0, points) / 100);
    },
    setRemaining(fraction) {
      animateTo(fraction);
    },
  };
  return api;
}

// ---------------------------------------------------------------------------
// 3. RISK GUARDS: four check lamps + one scanning arch
// ---------------------------------------------------------------------------

/** Guard lamp rows; reason strings map onto the lamp they refuse. */
const GUARD_LABELS = [
  "Stop required",
  "Within loss budget",
  "Direction allowed",
  "Exposure allowed",
];
const REASON_LAMP: Record<string, number> = {
  "protection failure": 0,
  "cumulative loss limit": 1,
};

function buildRiskFortress(ctx: DioramaContext): RiskFortressApi {
  const { root } = stationBase(ctx, "riskFortress");

  contactShadow(root, 0, 12, 260, 190, 0.25);
  root.addChild(isoTile(0, 6, 240, 165, PALETTE.structure, 1, PALETTE.yellow));
  root.addChild(isoTile(0, 14, 190, 130, PALETTE.structureLight, 0.5));
  root.addChild(
    isoWall({
      x1: -104,
      y1: 8,
      x2: 0,
      y2: -54,
      h: 30,
      color: PALETTE.structure,
      rim: PALETTE.yellow,
    }),
  );
  root.addChild(
    isoWall({
      x1: 0,
      y1: -54,
      x2: 104,
      y2: 8,
      h: 30,
      color: PALETTE.structure,
      rim: PALETTE.yellow,
    }),
  );
  for (const px of [-104, 104]) {
    root.addChild(
      isoBox({
        x: px,
        y: 8,
        w: 18,
        d: 12,
        h: 24,
        color: PALETTE.structure,
        rim: PALETTE.yellow,
        rimAlpha: 0.55,
      }),
    );
    root.addChild(glow(px, -22, 12, PALETTE.yellow, 0.4));
  }

  // Guard panel on the back wall: four check lamps with their product labels
  // as registered detail. Resting state is all-pass, dim.
  const panel = new Graphics();
  panel.roundRect(-78, -62, 156, 68, 6);
  panel.fill({ color: 0x07111f, alpha: 0.88 });
  panel.roundRect(-78, -62, 156, 68, 6);
  panel.stroke({ width: 1.5, color: PALETTE.cyan, alpha: 0.85 });
  root.addChild(panel);
  type LampMode = "dim" | "lit" | "blocked" | "warn";
  const lamps: Graphics[] = [];
  GUARD_LABELS.forEach((label, i) => {
    const ly = -50 + i * 15;
    const lamp = new Graphics();
    lamp.circle(-64, ly, 4);
    lamp.fill({ color: 0xffffff, alpha: 0.9 });
    lamp.tint = PALETTE.healthy;
    lamp.alpha = 0.4;
    root.addChild(lamp);
    lamps.push(lamp);
    root.addChild(detailText(label, 7.5, PALETTE.ink)).position.set(-54, ly);
  });
  const setLamp = (i: number, mode: LampMode): void => {
    const lamp = lamps[i];
    gsap.killTweensOf(lamp);
    lamp.tint =
      mode === "blocked" ? PALETTE.blocked : mode === "warn" ? PALETTE.warning : PALETTE.healthy;
    lamp.alpha = mode === "dim" ? 0.4 : 1;
  };
  const setAllLamps = (mode: LampMode): void => {
    for (let i = 0; i < lamps.length; i++) setLamp(i, mode);
  };

  // One scanning arch mid-corridor (shared language); the checked order walks
  // the corridor through it. Gold rim keeps it a gate, not decoration.
  const corridorY = 26;
  root.addChild(isoTile(0, corridorY, 236, 40, PALETTE.structureLight, 0.85, PALETTE.yellow));
  root.addChild(arch(0, corridorY, 56, 46, PALETTE.structureLight, PALETTE.cyan));
  root.addChild(edgeStrip(-28, corridorY - 46, 28, corridorY - 46, PALETTE.yellow, 0.9, 1.6));
  const archGlow = glow(0, corridorY - 4, 44, PALETTE.cyan, 0.2);
  root.addChild(archGlow);

  // Capability badges (absorbs permission): quiet hex tokens on the apron.
  for (const [hx, hy] of [
    [-56, 70],
    [-36, 76],
    [-16, 70],
    [4, 76],
  ]) {
    const hex = new Graphics();
    hexPath(hex, 5.5);
    hex.fill({ color: PALETTE.cyan, alpha: 0.3 });
    hexPath(hex, 5.5);
    hex.stroke({ width: 1, color: PALETTE.cyan, alpha: 0.7 });
    hex.position.set(hx, hy);
    hex.alpha = 0.7;
    root.addChild(hex);
  }

  // Verbatim refusal chip (registered detail), hidden until a scan fails.
  const reasonChip = new Container();
  reasonChip.position.set(0, 64);
  const chipBg = new Graphics();
  chipBg.roundRect(-56, -10, 112, 20, 4);
  chipBg.fill({ color: PALETTE.space, alpha: 0.88 });
  chipBg.roundRect(-56, -10, 112, 20, 4);
  chipBg.stroke({ width: 1.2, color: PALETTE.blocked, alpha: 0.9 });
  reasonChip.addChild(chipBg);
  const chipText = detailText("", 7.5, 0xffffff);
  chipText.anchor.set(0.5);
  reasonChip.addChild(chipText);
  reasonChip.alpha = 0;
  root.addChild(reasonChip);

  // Pooled order token + exit burst + barrier.
  const token = new Container();
  const tokCore = glow(0, 0, 20, PALETTE.cyan, 0.8);
  const tokDot = new Sprite(dotTexture());
  tokDot.anchor.set(0.5);
  tokDot.width = 10;
  tokDot.height = 10;
  tokDot.tint = 0xffffff;
  token.addChild(tokCore, tokDot);
  token.position.set(-108, corridorY - 8);
  token.visible = false;
  root.addChild(token);
  const exitBurst = glow(112, corridorY - 8, 0, PALETTE.healthy, 0.9);
  root.addChild(exitBurst);
  const barrier = new Graphics();
  barrier.moveTo(-10, -12);
  barrier.lineTo(10, 12);
  barrier.moveTo(10, -12);
  barrier.lineTo(-10, 12);
  barrier.stroke({ width: 3.5, color: PALETTE.blocked });
  barrier.roundRect(-13, -15, 26, 30, 4);
  barrier.stroke({ width: 1.2, color: PALETTE.blocked, alpha: 0.7 });
  barrier.visible = false;
  root.addChild(barrier);

  stationSign(ctx, "riskFortress", 100, PALETTE.yellow);

  let scanTl: Killable | null = null;
  const restore = (): void => {
    scanTl?.kill();
    gsap.killTweensOf([token, barrier, exitBurst, reasonChip, archGlow]);
    token.visible = false;
    barrier.visible = false;
    exitBurst.width = 0;
    exitBurst.height = 0;
    archGlow.tint = PALETTE.cyan;
    archGlow.alpha = 0.2;
    reasonChip.alpha = 0;
    setAllLamps("dim");
  };

  const api: RiskFortressApi = {
    runScan(pass, reason) {
      restore();
      const sc = track(gsap.timeline({ onComplete: restore }));
      scanTl = sc;
      token.visible = true;
      token.alpha = 1;
      token.position.set(-108, corridorY - 8);
      sc.to(token, { x: 0, duration: d(0.34), ease: "none" }).call(() => {
        archGlow.tint = PALETTE.cyan;
        sc.to(archGlow, { alpha: 0.7, duration: d(0.12), yoyo: true, repeat: 1 });
      });
      if (pass) {
        for (let i = 0; i < GUARD_LABELS.length; i++) {
          sc.call(setLamp, [i, "lit"], `+=${d(0.07)}`);
        }
        sc.to(token, { x: 108, duration: d(0.3), ease: "none" })
          .call(() => {
            exitBurst.width = 60;
            exitBurst.height = 60;
            track(gsap.to(exitBurst, { width: 0, height: 0, alpha: 0, duration: d(0.5) }));
          })
          .to(token, { alpha: 0, duration: d(0.2) }, "<")
          .to({}, { duration: d(1.2) });
        return;
      }
      // Fail: stop just past the arch, refuse at the matching guard, and show
      // the reason verbatim. Unmapped mission-level reasons warn every lamp.
      const mapped = reason ? REASON_LAMP[reason] : undefined;
      const failAt = mapped ?? GUARD_LABELS.length;
      for (let i = 0; i < failAt; i++) {
        sc.call(setLamp, [i, "lit"], `+=${d(0.07)}`);
      }
      sc.call(() => {
        if (mapped !== undefined) {
          setLamp(mapped, "blocked");
        } else {
          setAllLamps("warn");
        }
        archGlow.tint = PALETTE.blocked;
        archGlow.alpha = 0.7;
        barrier.position.set(12, corridorY - 20);
        barrier.visible = true;
        barrier.alpha = 1;
        barrier.scale.set(0.6);
        track(gsap.to(barrier.scale, { x: 1, y: 1, duration: d(0.2), ease: "back.out(3)" }));
        chipText.text = (reason ?? "guard refused").slice(0, 26);
        chipText.tint = mapped !== undefined ? PALETTE.blocked : PALETTE.warning;
        gsap.fromTo(reasonChip, { alpha: 0.2 }, { alpha: 1, duration: d(0.25) });
      });
      sc.to(token, { x: 6, duration: d(0.06), yoyo: true, repeat: 3 })
        .to(token, { alpha: 0, duration: d(0.3), delay: d(1.0) })
        .to({}, { duration: d(1.0) });
    },
  };
  return api;
}

// ---------------------------------------------------------------------------
// 4. PROTECTION: orbiting position tokens + shield shells + state label
// ---------------------------------------------------------------------------

const PROTECTION_META: Record<ProtectionState, { label: string; color: number }> = {
  stop_on_exchange: { label: "Stop on exchange", color: PALETTE.healthy },
  server_executed: { label: "Server-executed", color: PALETTE.waiting },
  unprotected: { label: "Unprotected", color: PALETTE.blocked },
};

function buildProtection(ctx: DioramaContext): ProtectionApi {
  const { root } = stationBase(ctx, "protection");

  contactShadow(root, 0, 4, 132, 96);
  root.addChild(isoTile(0, 0, 132, 96, PALETTE.structure, 1, PALETTE.structureLight));
  const ring = new Graphics();
  ring.ellipse(0, 0, 50, 25);
  ring.stroke({ width: 1.8, color: PALETTE.cyan, alpha: 0.7 });
  root.addChild(ring);

  /** Persistent per-token protection state so the ring is legible at rest:
   * shielded (bright green hex), aging (dim blue hex), bare (no mark). */
  type ShieldState = "shielded" | "aging" | "bare";
  interface Orbiter {
    angle: number;
    dot: Container;
    shieldMark: Graphics;
    frozen: boolean;
    state: ShieldState;
  }
  const orbiters: Orbiter[] = [];
  const INITIAL_STATES: ShieldState[] = ["shielded", "aging", "bare"];
  const STATE_MARK: Record<ShieldState, { alpha: number; tint: number }> = {
    shielded: { alpha: 0.95, tint: PALETTE.healthy },
    aging: { alpha: 0.4, tint: PALETTE.blue },
    bare: { alpha: 0, tint: PALETTE.healthy },
  };
  for (let i = 0; i < 3; i++) {
    const dot = new Container();
    const core = glow(0, 0, 16, PALETTE.orange, 0.7);
    const pip = new Sprite(dotTexture());
    pip.anchor.set(0.5);
    pip.width = 7;
    pip.height = 7;
    pip.tint = PALETTE.orange;
    const shieldMark = new Graphics();
    hexPath(shieldMark, 10);
    shieldMark.stroke({ width: 1.5, color: 0xffffff, alpha: 0.85 });
    hexPath(shieldMark, 13);
    shieldMark.stroke({ width: 1, color: PALETTE.cyan, alpha: 0.5 });
    const mark = STATE_MARK[INITIAL_STATES[i]];
    shieldMark.alpha = mark.alpha;
    shieldMark.tint = mark.tint;
    dot.addChild(core, pip, shieldMark);
    root.addChild(dot);
    orbiters.push({
      angle: (Math.PI * 2 * i) / 3,
      dot,
      shieldMark,
      frozen: false,
      state: INITIAL_STATES[i],
    });
  }

  const place = (): void => {
    for (const o of orbiters) {
      o.dot.position.set(Math.cos(o.angle) * 50, Math.sin(o.angle) * 25 - 4);
    }
  };
  place();
  const unreg = ctx.onTick((ticker) => {
    const step = ticker.deltaTime * 0.0035;
    for (const o of orbiters) {
      if (!o.frozen) o.angle += step;
    }
    place();
  });

  // Protection-state label: the registered detail ("Stop on exchange" is the
  // default success; unprotected is never presented as success).
  const stateChip = new Container();
  stateChip.position.set(46, -58);
  const chipBorder = new Graphics();
  chipBorder.roundRect(-34, -10, 68, 20, 3);
  chipBorder.fill({ color: PALETTE.space, alpha: 0.88 });
  chipBorder.roundRect(-34, -10, 68, 20, 3);
  chipBorder.stroke({ width: 1.2, color: 0xffffff, alpha: 0.9 });
  stateChip.addChild(chipBorder);
  const chipLabel = detailText(PROTECTION_META.stop_on_exchange.label, 6.5, 0xffffff);
  chipLabel.anchor.set(0.5);
  stateChip.addChild(chipLabel);
  root.addChild(stateChip);
  const statePost = new Graphics();
  statePost.rect(45, -48, 2, 16);
  statePost.fill({ color: PALETTE.structureLight });
  root.addChild(statePost);
  const applyChip = (state: ProtectionState): void => {
    const meta = PROTECTION_META[state];
    chipLabel.text = meta.label;
    chipLabel.tint = meta.color;
    chipBorder.tint = meta.color;
    gsap.killTweensOf(stateChip.scale);
    stateChip.scale.set(0.82);
    track(gsap.to(stateChip.scale, { x: 1, y: 1, duration: d(0.3), ease: "back.out(2.4)" }));
  };
  applyChip("stop_on_exchange");

  // Triple shield shells (pooled container, hidden between pulses).
  const shells = new Container();
  const shellColors = [PALETTE.healthy, PALETTE.waiting, PALETTE.violet];
  shellColors.forEach((c, i) => {
    const s = new Graphics();
    hexPath(s, 14 + i * 5);
    s.fill({ color: c, alpha: 0.1 });
    hexPath(s, 14 + i * 5);
    s.stroke({ width: 1.6, color: c, alpha: 0.85 });
    shells.addChild(s);
  });
  shells.visible = false;
  root.addChild(shells);

  const pulse = glow(0, 0, 0, PALETTE.healthy, 0.8);
  root.addChild(pulse);

  stationSign(ctx, "protection", 78);

  let shieldTl: Killable | null = null;
  const api: ProtectionApi = {
    shieldUp() {
      shieldTl?.kill();
      const marks = orbiters.map((o) => o.shieldMark);
      gsap.killTweensOf([shells, pulse, ...shells.children, ...marks]);
      // Promote the first bare token to shielded; the previous shield ages
      // and the oldest mark expires, so all three states stay on display.
      const target = orbiters.find((o) => o.state === "bare") ?? orbiters[0];
      for (const o of orbiters) {
        if (o === target) continue;
        if (o.state === "shielded") {
          o.state = "aging";
          o.shieldMark.tint = STATE_MARK.aging.tint;
          track(gsap.to(o.shieldMark, { alpha: STATE_MARK.aging.alpha, duration: d(0.6) }));
        } else if (o.state === "aging") {
          o.state = "bare";
          track(gsap.to(o.shieldMark, { alpha: 0, duration: d(0.6) }));
        }
      }
      target.state = "shielded";
      target.shieldMark.tint = 0xffffff;
      target.frozen = true;
      shells.visible = true;
      shells.alpha = 1;
      shells.scale.set(0);
      shells.position.copyFrom(target.dot.position);
      pulse.width = 0;
      pulse.height = 0;
      pulse.alpha = 0.8;
      pulse.position.copyFrom(target.dot.position);
      const sh = track(
        gsap
          .timeline({
            onComplete: () => {
              shells.visible = false;
              target.frozen = false;
              target.shieldMark.tint = STATE_MARK.shielded.tint;
            },
          })
          .to(shells.scale, { x: 1, y: 1, duration: d(0.4), ease: "back.out(2.4)" })
          .to(pulse, { width: 70, height: 70, duration: d(0.3) }, 0)
          .to(pulse, { alpha: 0, duration: d(0.4) }, "<")
          .to(shells.scale, { x: 1.12, y: 1.12, duration: d(0.08), yoyo: true, repeat: 1 })
          .call(() => {
            target.shieldMark.alpha = STATE_MARK.shielded.alpha;
          })
          .to(shells, { alpha: 0, duration: d(0.5), delay: d(1.6) }),
      );
      shieldTl = sh;
    },
    setState(state) {
      applyChip(state);
    },
  };

  ctx.onCleanup(() => {
    unreg();
  });
  return api;
}

// ---------------------------------------------------------------------------
// 5. LOCAL SIGNING: demoted sealed module + signing pulse (never key imagery)
// ---------------------------------------------------------------------------

function buildSignerVault(ctx: DioramaContext): SignerVaultApi {
  const { root } = stationBase(ctx, "signerVault");

  contactShadow(root, -6, 6, 180, 140);
  // Short bridge west toward the risk corridor's exit, so the checked order
  // walks straight into the module.
  root.addChild(isoTile(-92, 16, 52, 22, PALETTE.structureLight, 0.6, PALETTE.yellow));

  root.addChild(
    isoBox({ x: 0, y: 0, w: 138, d: 108, h: 12, color: PALETTE.structure, rim: PALETTE.yellow }),
  );
  root.addChild(isoTile(0, -6, 126, 96, PALETTE.structureLight, 0.9, PALETTE.yellow));

  // Cutaway walls: full back edges + short front stubs, open front face. The
  // demoted module keeps the sealed-chamber language but no sentinel mast.
  root.addChild(
    isoWall({
      x1: -62,
      y1: -6,
      x2: 0,
      y2: -56,
      h: 36,
      color: PALETTE.structure,
      rim: PALETTE.yellow,
    }),
  );
  root.addChild(
    isoWall({
      x1: 0,
      y1: -56,
      x2: 62,
      y2: -6,
      h: 36,
      color: PALETTE.structure,
      rim: PALETTE.yellow,
    }),
  );
  root.addChild(
    isoWall({
      x1: -62,
      y1: -6,
      x2: -46,
      y2: 2,
      h: 26,
      color: PALETTE.structure,
      rim: PALETTE.yellow,
    }),
  );
  root.addChild(
    isoWall({
      x1: 46,
      y1: 2,
      x2: 62,
      y2: -6,
      h: 26,
      color: PALETTE.structure,
      rim: PALETTE.yellow,
    }),
  );

  // Sealed core: pedestal + hexagonal seal cap, with a quiet cyan seam ring
  // marking the sealed boundary. No key, seed, or address imagery, ever.
  root.addChild(
    isoCylinder({
      x: 0,
      y: -20,
      r: 10,
      h: 16,
      color: PALETTE.structureLight,
      rim: PALETTE.yellow,
    }),
  );
  const sealCap = new Graphics();
  hexPath(sealCap, 8);
  sealCap.fill({ color: PALETTE.yellow, alpha: 0.9 });
  hexPath(sealCap, 8);
  sealCap.stroke({ width: 1.2, color: PALETTE.surfacePale, alpha: 0.8 });
  hexPath(sealCap, 4.5);
  sealCap.stroke({ width: 1, color: PALETTE.structure, alpha: 0.9 });
  sealCap.position.set(0, -42);
  root.addChild(sealCap);
  const seamRing = new Graphics();
  seamRing.ellipse(0, -20, 16, 8);
  seamRing.stroke({ width: 1.2, color: PALETTE.cyan, alpha: 0.55 });
  root.addChild(seamRing);
  const corePulse = glow(0, -30, 40, PALETTE.yellow, 0.14);
  root.addChild(corePulse);
  if (!ctx.reducedMotion) {
    track(
      gsap.to(corePulse, {
        alpha: 0.32,
        duration: 3.4,
        yoyo: true,
        repeat: -1,
        ease: "sine.inOut",
      }),
    );
  }

  // Scanning light bar across the open doorway.
  const scanBar = lightBeam(0, 30, 6, 10, 40, PALETTE.cyan, 0.16);
  root.addChild(scanBar);
  if (!ctx.reducedMotion) {
    track(gsap.to(scanBar, { x: -40, duration: 3.4, yoyo: true, repeat: -1, ease: "sine.inOut" }));
  }

  // Signing flash: vertical beam + expanding ring over the core, pooled.
  const flashBeam = lightBeam(0, -20, 10, 22, 50, PALETTE.yellow, 0);
  const flashRing = glow(0, -30, 0, PALETTE.yellow, 0.9);
  root.addChild(flashBeam, flashRing);

  const capsule = makeCapsule(PALETTE.waiting);
  root.addChild(capsule);

  stationSign(ctx, "signerVault", 116, PALETTE.yellow);

  let tl: Killable | null = null;
  const reset = (): void => {
    tl?.kill();
    gsap.killTweensOf([capsule, capsule.body, flashBeam, flashRing]);
    capsule.visible = false;
    capsule.rotation = 0;
    capsule.body.tint = 0xffffff;
    capsule.alpha = 1;
    flashBeam.alpha = 0;
    flashRing.width = 0;
    flashRing.height = 0;
    flashRing.alpha = 0;
  };

  const api: SignerVaultApi = {
    signPulse() {
      reset();
      capsule.visible = true;
      capsule.position.set(-92, 14);
      const vt = track(
        gsap
          .timeline({ onComplete: reset })
          .to(capsule, { x: 0, y: -26, duration: d(0.45), ease: "power1.inOut" })
          .to(capsule, { alpha: 0.25, duration: d(0.12), yoyo: true, repeat: 1 })
          // The module signs; the seal never opens and nothing leaves it.
          .call(() => {
            track(
              gsap
                .timeline()
                .to(flashBeam, { alpha: 0.75, duration: d(0.1), yoyo: true, repeat: 1 })
                .fromTo(
                  flashRing,
                  { width: 10, height: 10, alpha: 0.9 },
                  { width: 74, height: 74, alpha: 0, duration: d(0.5) },
                  0,
                ),
            );
            capsule.body.tint = PALETTE.yellow;
          })
          .to(capsule, { x: 92, y: 12, duration: d(0.45), ease: "power1.inOut", delay: d(0.25) })
          .to(capsule, { alpha: 0, duration: d(0.2) }, "-=0.1"),
      );
      tl = vt;
    },
  };
  return api;
}

// ---------------------------------------------------------------------------
// 6. EXECUTION: execution-state progression strip dispatching to the venue
// ---------------------------------------------------------------------------

const EXECUTION_STEPS = [
  "previewed",
  "reserved",
  "signed",
  "submitted",
  "accepted",
  "filled",
] as const;

function buildExecutionGateway(ctx: DioramaContext): ExecutionGatewayApi {
  const { root } = stationBase(ctx, "executionGateway");

  contactShadow(root, 2, 12, 178, 138);
  root.addChild(isoTile(0, 10, 138, 102, PALETTE.structure, 1, PALETTE.structureLight));

  // Dispatch conveyor toward the docked exchange booth, north-west: the
  // signer hands over from the east, the capsule leaves toward the port.
  const conv = { x1: 8, y1: -16, x2: -56, y2: -58 };
  root.addChild(edgeStrip(conv.x1, conv.y1 - 8, conv.x2, conv.y2 - 8, PALETTE.aqua, 0.65));
  root.addChild(edgeStrip(conv.x1, conv.y1 + 2, conv.x2, conv.y2 + 2, PALETTE.aqua, 0.45));
  const rollers = new Graphics();
  for (let i = 0; i < 4; i++) {
    const t = (i + 0.5) / 4;
    const rx = conv.x1 + (conv.x2 - conv.x1) * t;
    const ry = conv.y1 + (conv.y2 - conv.y1) * t - 3;
    rollers.ellipse(rx, ry, 4, 2);
    rollers.fill({ color: PALETTE.structureLight });
  }
  root.addChild(rollers);

  // Launch mouth arch facing the exchange port (north-west).
  const mouth = arch(-62, -48, 52, 40, PALETTE.structure, PALETTE.aqua);
  root.addChild(mouth);

  // Six-segment progression strip: previewed -> filled. Segments up to the
  // current state are lit; the current one carries a halo. Terminal
  // alternatives (rejected/cancelled/failed) flash the whole strip blocked.
  const stripY = -52;
  const segXs = [-50, -30, -10, 10, 30, 50];
  const stripLine = new Graphics();
  stripLine.moveTo(segXs[0], stripY);
  stripLine.lineTo(segXs[segXs.length - 1], stripY);
  stripLine.stroke({ width: 1, color: PALETTE.inkDim, alpha: 0.3 });
  root.addChild(stripLine);
  const segments: Graphics[] = [];
  const halos: Sprite[] = [];
  segXs.forEach((sx) => {
    const seg = new Graphics();
    seg.roundRect(sx - 5, stripY - 3, 10, 6, 2);
    seg.fill({ color: 0xffffff, alpha: 0.9 });
    seg.tint = PALETTE.inkDim;
    seg.alpha = 0.35;
    root.addChild(seg);
    segments.push(seg);
    const halo = glow(sx, stripY, 18, PALETTE.cyan, 0);
    root.addChild(halo);
    halos.push(halo);
  });
  const stepIdx = (state: ExecutionState): number =>
    EXECUTION_STEPS.indexOf(state as (typeof EXECUTION_STEPS)[number]);

  // Current-state chip (registered detail) + terminal alternatives line.
  const stateChip = new Container();
  stateChip.position.set(4, -28);
  const chipBg = new Graphics();
  chipBg.roundRect(-32, -8, 64, 16, 3);
  chipBg.fill({ color: PALETTE.space, alpha: 0.85 });
  chipBg.roundRect(-32, -8, 64, 16, 3);
  chipBg.stroke({ width: 1, color: PALETTE.cyan, alpha: 0.7 });
  stateChip.addChild(chipBg);
  const chipLabel = detailText("", 6.5, 0xffffff);
  chipLabel.anchor.set(0.5);
  stateChip.addChild(chipLabel);
  stateChip.alpha = 0;
  root.addChild(stateChip);
  const terminalLine = detailText("rejected · cancelled · failed", 5.5, PALETTE.inkDim);
  terminalLine.anchor.set(0.5);
  terminalLine.position.set(-30, 38);
  root.addChild(terminalLine);

  // Reject bin for terminal outcomes.
  root.addChild(
    isoBox({
      x: 36,
      y: 48,
      w: 28,
      d: 20,
      h: 14,
      color: PALETTE.structure,
      rim: PALETTE.blocked,
      rimAlpha: 0.5,
    }),
  );

  const capsule = makeCapsule(PALETTE.orange);
  root.addChild(capsule);

  stationSign(ctx, "executionGateway", 84, PALETTE.cyan);

  let tl: Killable | null = null;
  const resetStrip = (): void => {
    segments.forEach((seg) => {
      gsap.killTweensOf(seg);
      seg.tint = PALETTE.inkDim;
      seg.alpha = 0.35;
    });
    halos.forEach((h) => {
      gsap.killTweensOf(h);
      h.alpha = 0;
    });
  };

  const resetCapsule = (): void => {
    capsule.visible = false;
    capsule.alpha = 1;
    capsule.rotation = 0;
    capsule.body.tint = 0xffffff;
    capsule.position.set(conv.x1, conv.y1);
  };

  const dropToBin = (gt: gsap.core.Timeline): void => {
    gt.to(capsule, { alpha: 0.3, duration: d(0.12), yoyo: true, repeat: 3 })
      .to(capsule, { y: 34, duration: d(0.3), ease: "power1.in" })
      .to(capsule, { x: 36, y: 46, duration: d(0.25), ease: "power1.in" })
      .to(capsule, { alpha: 0, duration: d(0.25) });
  };

  const api: ExecutionGatewayApi = {
    setState(state) {
      tl?.kill();
      gsap.killTweensOf([capsule, capsule.body, stateChip, stateChip.scale]);
      resetCapsule();
      resetStrip();
      const terminal = state === "rejected" || state === "cancelled" || state === "failed";
      if (state === "idle") return;
      const gt = track(gsap.timeline());
      tl = gt;
      if (terminal) {
        segments.forEach((seg) => {
          seg.tint = PALETTE.blocked;
          seg.alpha = 1;
        });
        chipLabel.text = state;
        chipLabel.tint = PALETTE.blocked;
        chipBg.tint = PALETTE.blocked;
        stateChip.alpha = 1;
        gt.fromTo(stateChip, { alpha: 0.2 }, { alpha: 1, duration: d(0.25) })
          .to(stateChip, { alpha: 0, duration: d(0.4), delay: d(1.6) })
          .call(() => {
            chipBg.tint = 0xffffff;
          });
        capsule.visible = true;
        capsule.position.set(conv.x1, conv.y1);
        capsule.body.tint = PALETTE.blocked;
        dropToBin(gt);
        return;
      }
      const idx = stepIdx(state);
      for (let i = 0; i <= idx; i++) {
        segments[i].tint = PALETTE.cyan;
        segments[i].alpha = 1;
      }
      halos[idx].alpha = 0.7;
      chipLabel.text = state;
      chipLabel.tint = PALETTE.ink;
      chipBg.tint = 0xffffff;
      stateChip.alpha = 1;
      if (state === "submitted") {
        capsule.visible = true;
        capsule.scale.set(1);
        capsule.position.set(0, -28);
        gt.to(capsule, { x: conv.x2, y: conv.y2, duration: d(0.5), ease: "power1.in" }).to(
          capsule,
          { alpha: 0, duration: d(0.15) },
        );
      } else if (state === "accepted" || state === "filled") {
        const burst = glow(conv.x2, conv.y2 - 2, 0, PALETTE.healthy, 0.9);
        root.addChild(burst);
        gt.fromTo(
          burst,
          { width: 10, height: 10 },
          {
            width: state === "filled" ? 72 : 56,
            height: state === "filled" ? 72 : 56,
            alpha: 0,
            duration: d(0.6),
            onComplete: () => safeDestroy(burst),
          },
        );
      } else {
        gt.to({}, { duration: d(0.2) });
      }
      gt.to(stateChip, { alpha: 0, duration: d(0.4), delay: d(1.4) });
    },
  };
  return api;
}

// ---------------------------------------------------------------------------
// District assembly
// ---------------------------------------------------------------------------

export function buildRiskDistrict(ctx: DioramaContext): void {
  reduced = ctx.reducedMotion;
  killables.length = 0;
  for (const key of Object.keys(stationParts)) delete stationParts[key as StationId];
  ctx.onCleanup(() => {
    for (const k of killables) k.kill();
    killables.length = 0;
  });

  // Each builder's screen copy adopts into the sign registry under its own
  // station id (see detailText), so the shared tier/focus policy governs it.
  const apis = {
    emergencyPanel: buildWithOwner("emergencyPanel", () => buildEmergencyPanel(ctx)),
    budgetMeter: buildWithOwner("budgetMeter", () => buildBudgetMeter(ctx)),
    riskFortress: buildWithOwner("riskFortress", () => buildRiskFortress(ctx)),
    protection: buildWithOwner("protection", () => buildProtection(ctx)),
    signerVault: buildWithOwner("signerVault", () => buildSignerVault(ctx)),
    executionGateway: buildWithOwner("executionGateway", () => buildExecutionGateway(ctx)),
  } as const;

  for (const id of Object.keys(apis) as StationId[]) {
    const parts = stationParts[id];
    if (!parts) continue;
    registerStation({ id, root: parts.root, hit: parts.hit, api: apis[id as keyof typeof apis] });
  }
}
