/**
 * East section, guarded-execution cluster: approval desk at the authority
 * seam, permission control, loss-budget meter, risk scanning arches,
 * protection ring, signer vault, and the execution gateway dispatching
 * toward the docked exchange booth. Owner: east lane (risk.ts).
 *
 * Layout reads along the N-E wall matching the pipeline:
 * Decision -> Approval -> Permission -> Risk -> Sign -> Execute -> Exchange.
 * The emergency control kiosk beside Approval also lives here: it owns its
 * own lever and pause-badge visuals only; the room-wide pause side effects
 * live on the trading floor's api (story s-emergency-demo).
 *
 * Shared language (R6): every station uses the standard booth/desk family
 * (structural-blue isoTile platforms, low isoWall backs h <= 34, gold as the
 * district accent) and the common sign system. The risk station keeps its
 * scanning arches because they are functional storytelling, not decoration.
 * All statics are drawn once; motion uses pooled sprites and GSAP timelines
 * that are killed on world cleanup. The scene reads correctly unanimated.
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
import { makeSign } from "../core/signs.js";
import { registerStation } from "../core/registry.js";
import { pulseSeam } from "../world/seam.js";

export interface ApprovalApi {
  setSeal(state: "waiting" | "approved" | "denied"): void;
  /**
   * Authority binds: replays the approved-seal flourish and pulses the
   * center<->east authority seam (world/seam.ts). Story s-human-approval
   * calls this instead of the retired perimeter pulse.
   */
  grantPulse(): void;
}

/**
 * Local emergency-drill visuals on the panel: guarded cover opens, lever
 * pulls, pause badge shows, then resets. The room-wide pause side effects
 * live on TradingFloorApi.setCampusPaused("tradingFloor").
 */
export interface EmergencyPanelApi {
  demoPause(): void;
}

export interface RiskFortressApi {
  /** Packet passes arches; stops at stopAtArch index when invalid. */
  runScan(valid: boolean, stopAtArch?: number): void;
}

export interface SignerVaultApi {
  /** Signing pulse: packet in, pulse, signed packet out. Never a key. */
  signPulse(): void;
}

export interface ExecutionGatewayApi {
  setState(state: "idle" | "preparing" | "submitted" | "acknowledged" | "failed"): void;
}

export interface BudgetMeterApi {
  /** Consume a fraction (0..1) of a named reservoir. */
  consume(reservoir: "loss" | "capital" | "tools" | "authority", amount: number): void;
}

export interface ProtectionApi {
  /** Attach layered shields to a position token passing through. */
  shieldUp(): void;
}

/** Extended (non-frozen) surface for the permission sweep demo loop. */
export interface PermissionSweepApi {
  sweep(failAt?: number): void;
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

/**
 * Live bridge from the budget meter to the permission room's mini gauge, so
 * the two stations read as one control cluster on the guarded band. Cleared
 * on every district rebuild; only consume("loss") drives it.
 */
let lossMirror: ((level: number) => void) | null = null;
/** Initial loss-budget level shared by the meter and its permission mirror. */
const INITIAL_LOSS_LEVEL = 0.82;

// ---------------------------------------------------------------------------
// Shared small props
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
  });
  sign.zIndex = def.anchor.y + DEPTH.overlay;
  ctx.layers.labels.addChild(sign);
  return sign;
}

/** Billboard proposal card (pooled look, cheap Graphics). */
function makeCard(w: number, h: number, accent: number): Container {
  const c = new Container();
  const g = new Graphics();
  g.roundRect(-w / 2, -h / 2, w, h, 2);
  g.fill({ color: PALETTE.surfacePale, alpha: 0.92 });
  g.roundRect(-w / 2, -h / 2, w, h, 2);
  g.stroke({ width: 1, color: accent, alpha: 0.8 });
  g.rect(-w / 2 + 3, -h / 2 + 3, w * 0.4, 2);
  g.fill({ color: accent, alpha: 0.5 });
  g.rect(-w / 2 + 3, 0, w * 0.6, 1.5);
  g.fill({ color: PALETTE.inkDim, alpha: 0.5 });
  c.addChild(g);
  return c;
}

/** Billboard order capsule (pooled, tintable). */
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
 * structure grounds onto the platform instead of floating. Coordinates are
 * root-local (roots are positioned at their anchor).
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

/** Small crate for filling dead space around the district. */
function propCrate(x: number, y: number, s = 13): Graphics {
  return isoBox({
    x,
    y,
    w: s,
    d: s * 0.6,
    h: s * 0.55,
    color: PALETTE.structure,
    rim: PALETTE.yellow,
    rimAlpha: 0.3,
  });
}

// ---------------------------------------------------------------------------
// 1. Approval desk (at the center/east authority seam)
// ---------------------------------------------------------------------------

function buildApproval(ctx: DioramaContext): ApprovalApi {
  const { root } = stationBase(ctx, "approval");

  contactShadow(root, 8, 10, 160, 110);
  // Seam-side pad: a gold-trimmed step whose west corner meets the authority
  // seam inlay, tying the desk to the boundary it enforces. The seam itself
  // (a floor inlay, no barrier) is drawn by world/seam.ts and pulses via
  // grantPulse() below.
  root.addChild(isoTile(-64, 8, 44, 34, PALETTE.structureLight, 0.85, PALETTE.yellow));
  root.addChild(edgeStrip(-64, -11, -64, -6, PALETTE.yellow, 0.6));
  root.addChild(edgeStrip(-64, 22, -64, 27, PALETTE.yellow, 0.6));

  // Desk beside the seam, tray to the west where proposals arrive from the
  // floor section. Blue counter-inlay on the desk top edge balances the gold.
  root.addChild(
    isoBox({ x: 14, y: 8, w: 104, d: 58, h: 20, color: PALETTE.structure, rim: PALETTE.yellow }),
  );
  root.addChild(edgeStrip(-30, -4, 58, -4, PALETTE.blue, 0.6, 1.4));
  const tray = new Graphics();
  tray.roundRect(-58, -14, 34, 12, 2);
  tray.fill({ color: PALETTE.structureLight });
  tray.roundRect(-58, -14, 34, 12, 2);
  tray.stroke({ width: 1.2, color: PALETTE.cyan, alpha: 0.85 });
  root.addChild(tray);

  // Queue of dimmed waiting cards west of the tray, arriving across the seam.
  const q1 = makeCard(18, 12, PALETTE.waiting);
  q1.position.set(-84, -6);
  q1.rotation = -0.12;
  q1.alpha = 0.45;
  const q2 = makeCard(18, 12, PALETTE.waiting);
  q2.position.set(-97, -1);
  q2.rotation = 0.1;
  q2.alpha = 0.35;
  root.addChild(q1, q2);

  // The active proposal card on the tray.
  const card = makeCard(20, 13, PALETTE.cyan);
  card.position.set(-41, -12);
  root.addChild(card);

  // Stamp arm: pivot above the desk right side, slams onto the card.
  const stamp = new Container();
  stamp.position.set(30, -22);
  const armG = new Graphics();
  armG.rect(-2, 0, 4, 16);
  armG.fill({ color: PALETTE.structureLight });
  armG.roundRect(-8, 14, 16, 8, 2);
  armG.fill({ color: PALETTE.yellow });
  stamp.addChild(armG);
  root.addChild(stamp);

  // Seal disc above the desk: ring + face + X + laurel layers.
  const seal = new Container();
  seal.position.set(2, -64);
  const face = new Graphics();
  face.circle(0, 0, 14);
  face.fill({ color: PALETTE.structure, alpha: 0.95 });
  face.circle(0, 0, 14);
  face.stroke({ width: 1.5, color: PALETTE.inkDim, alpha: 0.8 });
  face.circle(0, 0, 7);
  face.stroke({ width: 1, color: PALETTE.inkDim, alpha: 0.6 });
  const ring = new Graphics(); // waiting / laurel ring
  ring.circle(0, 0, 19);
  ring.stroke({ width: 2, color: PALETTE.waiting, alpha: 0.9 });
  const laurel = new Graphics(); // approved: broken laurel arcs
  for (const s of [-1, 1]) {
    laurel.arc(s * 3, 0, 17, (s * 50 * Math.PI) / 180, (s * 50 * Math.PI) / 180 + 1.9);
    laurel.stroke({ width: 2.5, color: PALETTE.healthy, alpha: 0.95 });
  }
  laurel.alpha = 0;
  const cross = new Graphics(); // denied: red X
  cross.moveTo(-8, -8);
  cross.lineTo(8, 8);
  cross.moveTo(8, -8);
  cross.lineTo(-8, 8);
  cross.stroke({ width: 3, color: PALETTE.blocked });
  cross.alpha = 0;
  const sealGlow = glow(0, 0, 52, PALETTE.waiting, 0.3);
  seal.addChild(sealGlow, ring, face, laurel, cross);
  root.addChild(seal);

  stationSign(ctx, "approval", 100);

  let waitingLoop: Killable | null = track(
    gsap.to(ring, { alpha: 0.35, duration: 2.2, yoyo: true, repeat: -1, ease: "sine.inOut" }),
  );
  let tl: gsap.core.Timeline | null = null;

  const reset = (): void => {
    tl?.kill();
    gsap.killTweensOf([card, stamp, seal, ring, laurel, cross, sealGlow]);
    card.position.set(-41, -12);
    card.alpha = 1;
    card.rotation = 0;
    stamp.position.set(30, -22);
    seal.scale.set(1);
    laurel.alpha = 0;
    cross.alpha = 0;
    ring.tint = PALETTE.waiting;
  };

  const startWaiting = (): void => {
    ring.alpha = 0.9;
    ring.tint = PALETTE.waiting;
    sealGlow.tint = PALETTE.waiting;
    sealGlow.alpha = 0.3;
    waitingLoop = track(
      gsap.to(ring, { alpha: 0.35, duration: 2.2, yoyo: true, repeat: -1, ease: "sine.inOut" }),
    );
  };

  const api: ApprovalApi = {
    setSeal(state) {
      reset();
      waitingLoop?.kill();
      waitingLoop = null;
      if (state === "waiting") {
        startWaiting();
        return;
      }
      const t = track(gsap.timeline());
      tl = t;
      // Stamp slam shared by both outcomes.
      t.to(stamp, { y: -10, duration: d(0.14), ease: "power2.in" })
        .to(stamp, { y: -22, duration: d(0.3), ease: "power2.out" })
        .to(seal.scale, { y: 0.82, x: 1.12, duration: d(0.12), ease: "power2.in" }, "<")
        .to(seal.scale, { x: 1, y: 1, duration: d(0.28), ease: "back.out(2)" });
      if (state === "approved") {
        t.call(() => {
          ring.tint = PALETTE.healthy;
          sealGlow.tint = PALETTE.healthy;
          sealGlow.alpha = 0.55;
        })
          .to(laurel, { alpha: 1, duration: d(0.35), ease: "back.out(2)" })
          .to(card, { x: 70, duration: d(0.5), ease: "power1.inOut" }, "<")
          .to(card, { alpha: 0, duration: d(0.2) }, "-=0.1")
          .to(laurel, { alpha: 0, duration: d(0.3) }, "+=0.4")
          .call(() => {
            sealGlow.alpha = 0.3;
            startWaiting();
          });
      } else {
        t.call(() => {
          ring.tint = PALETTE.blocked;
          sealGlow.tint = PALETTE.blocked;
          sealGlow.alpha = 0.55;
        })
          .fromTo(cross, { alpha: 0 }, { alpha: 1, duration: d(0.08), repeat: 3, yoyo: true })
          // Card drops back west across the seam, toward the floor section.
          .to(card, { x: -120, y: -2, rotation: -0.4, duration: d(0.55), ease: "power1.in" }, "<")
          .to(card, { alpha: 0, duration: d(0.2) }, "-=0.15")
          .to(cross, { alpha: 0, duration: d(0.3) }, "+=0.3")
          .call(() => {
            sealGlow.alpha = 0.3;
            startWaiting();
          });
      }
    },
    grantPulse() {
      // The human's authority binds: seal flourish plus the seam sweep.
      api.setSeal("approved");
      pulseSeam();
    },
  };
  return api;
}

// ---------------------------------------------------------------------------
// 1b. Emergency control kiosk (beside Approval, at the seam)
// ---------------------------------------------------------------------------

/**
 * Small red-trimmed stop kiosk beside the approval desk: a guarded lever
 * under a hinged glass cover, a blinking status light paired with a pause
 * glyph, and a pause badge held above while the local drill runs. A human
 * control, not an agent station: one protected lever, no consoles. The
 * room-wide pause side effects (floor ring, mast, dimming) are owned by the
 * trading floor's api; the story flashes this kiosk through glowPulse on
 * its registered root and may optionally call demoPause() for the lever.
 */
function buildEmergencyPanel(ctx: DioramaContext): EmergencyPanelApi {
  const { root } = stationBase(ctx, "emergencyPanel");

  contactShadow(root, 0, 6, 100, 62, 0.25);
  // Pad + pedestal. Emergency red is semantic here, not decorative.
  root.addChild(isoTile(0, 4, 78, 46, PALETTE.structure, 1, PALETTE.emergency));
  root.addChild(isoBox({ x: 0, y: 6, w: 26, d: 16, h: 9, color: PALETTE.structure }));

  // Panel box on the pedestal with a dark inset screen carrying the pause
  // wordmark: the shape glyph paired with the status light's blink.
  const box = new Graphics();
  box.roundRect(-16, -52, 32, 50, 5);
  box.fill({ color: PALETTE.structure });
  box.roundRect(-16, -52, 32, 50, 5);
  box.stroke({ width: 2, color: PALETTE.emergency, alpha: 0.95 });
  box.roundRect(-12, -38, 24, 22, 3);
  box.fill({ color: PALETTE.space, alpha: 0.8 });
  box.rect(-4, -32, 3, 10);
  box.rect(1, -32, 3, 10);
  box.fill({ color: PALETTE.emergency, alpha: 0.9 });
  root.addChild(box);

  // Guarded lever: pivot on the panel face, red knob at the top of the arm.
  const lever = new Container();
  lever.position.set(0, -18);
  const leverG = new Graphics();
  leverG.rect(-1.2, -14, 2.4, 14);
  leverG.fill({ color: PALETTE.structureLight });
  leverG.circle(0, -14, 4);
  leverG.fill({ color: PALETTE.emergency });
  leverG.circle(0, -14, 1.6);
  leverG.fill({ color: PALETTE.surfacePale, alpha: 0.85 });
  lever.addChild(leverG);
  root.addChild(lever);

  // Hinged glass cover over the lever, closed at rest.
  const cover = new Container();
  cover.position.set(-13, -36);
  const coverG = new Graphics();
  coverG.rect(0, 0, 26, 24);
  coverG.fill({ color: PALETTE.surfacePale, alpha: 0.16 });
  coverG.rect(0, 0, 26, 24);
  coverG.stroke({ width: 1.5, color: PALETTE.surfacePale, alpha: 0.75 });
  cover.addChild(coverG);
  root.addChild(cover);

  // Status light above the box: blinking dot + halo at rest.
  const statusDot = new Graphics();
  statusDot.circle(0, -57, 2.5);
  statusDot.fill({ color: PALETTE.emergency });
  root.addChild(statusDot);
  const statusLight = glow(0, -57, 12, PALETTE.emergency, 0.8);
  root.addChild(statusLight);
  if (!ctx.reducedMotion) {
    track(
      gsap.to(statusLight, {
        alpha: 0.35,
        duration: 1.2,
        yoyo: true,
        repeat: -1,
        ease: "sine.inOut",
      }),
    );
  }

  // Drill flare: a dedicated expanding glow so the drill never fights the
  // idle blink tween over statusLight's alpha.
  const drillGlow = glow(0, -57, 0, PALETTE.emergency, 0.9);
  root.addChild(drillGlow);

  // Pause badge: the local "paused" cue while the drill runs, hidden at rest.
  const pauseBadge = new Container();
  pauseBadge.position.set(0, -86);
  pauseBadge.alpha = 0;
  pauseBadge.visible = false;
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
  root.addChild(pauseBadge);

  stationSign(ctx, "emergencyPanel", 96, PALETTE.emergency);

  let drill: gsap.core.Timeline | null = null;
  const api: EmergencyPanelApi = {
    demoPause() {
      drill?.kill();
      gsap.killTweensOf([cover, cover.scale, lever, pauseBadge, drillGlow]);
      drillGlow.width = 0;
      drillGlow.height = 0;
      drillGlow.alpha = 0.9;
      // Reduced motion: snap to the composed paused state, then restore.
      if (ctx.reducedMotion) {
        cover.rotation = -0.5;
        cover.alpha = 0.25;
        lever.angle = 26;
        pauseBadge.visible = true;
        pauseBadge.alpha = 1;
        pauseBadge.y = -86;
        drill = track(
          gsap
            .timeline()
            .to({}, { duration: 0.6 })
            .call(() => {
              cover.rotation = 0;
              cover.alpha = 1;
              lever.angle = 0;
              pauseBadge.visible = false;
              pauseBadge.alpha = 0;
            }),
        );
        return;
      }
      drill = track(
        gsap
          .timeline()
          .to(cover, { rotation: -0.5, alpha: 0.25, duration: 0.35, ease: "power2.in" })
          .to(cover.scale, { x: 0.12, duration: 0.35, ease: "power2.in" }, "<")
          .to(lever, { angle: 26, duration: 0.16, ease: "power3.out" })
          .call(() => {
            pauseBadge.visible = true;
            pauseBadge.y = -78;
          })
          .fromTo(pauseBadge, { alpha: 0 }, { alpha: 1, duration: 0.4, ease: "power2.out" })
          .to(pauseBadge, { y: -88, duration: 0.6, ease: "power2.out" }, "<")
          .fromTo(
            drillGlow,
            { width: 10, height: 10 },
            { width: 46, height: 46, alpha: 0, duration: 0.5 },
            "<",
          )
          .to({}, { duration: 2.0 })
          .to(lever, { angle: 0, duration: 0.3, ease: "power2.inOut" })
          .to(pauseBadge, {
            alpha: 0,
            y: -78,
            duration: 0.4,
            onComplete: () => {
              pauseBadge.visible = false;
            },
          })
          .to(cover, { rotation: 0, alpha: 1, duration: 0.4, ease: "power2.out" }, "<")
          .to(cover.scale, { x: 1, duration: 0.4, ease: "power2.out" }, "<"),
      );
    },
  };
  return api;
}

// ---------------------------------------------------------------------------
// 2. Permission control room (wall of capability tokens)
// ---------------------------------------------------------------------------

function buildPermission(ctx: DioramaContext): PermissionSweepApi {
  const { root } = stationBase(ctx, "permission");

  contactShadow(root, 0, 10, 196, 136);
  root.addChild(isoTile(0, 6, 176, 122, PALETTE.structure, 1, PALETTE.structureLight));
  // Low back walls, open front. h <= 34 per spec.
  root.addChild(
    isoWall({ x1: -88, y1: 6, x2: 0, y2: -55, h: 34, color: PALETTE.structure, rim: PALETTE.cyan }),
  );
  root.addChild(
    isoWall({ x1: 0, y1: -55, x2: 88, y2: 6, h: 34, color: PALETTE.structure, rim: PALETTE.cyan }),
  );

  // Back-panel screen holding the token slots.
  const panel = new Container();
  panel.position.set(0, -34);
  const panelG = new Graphics();
  panelG.roundRect(-74, -30, 148, 58, 6);
  panelG.fill({ color: 0x07111f, alpha: 0.85 });
  panelG.roundRect(-74, -30, 148, 58, 6);
  panelG.stroke({ width: 1.8, color: PALETTE.cyan, alpha: 0.95 });
  panelG.moveTo(-70, 6);
  panelG.lineTo(70, 6);
  panelG.stroke({ width: 1, color: PALETTE.cyan, alpha: 0.18 });
  panel.addChild(panelG);
  root.addChild(panel);

  interface Tok {
    lit: Graphics;
    halo: Container;
  }
  const toks: Tok[] = [];
  for (let i = 0; i < 8; i++) {
    const col = i % 4;
    const row = Math.floor(i / 4);
    const tx = -51 + col * 34;
    const ty = -14 + row * 24;
    const slot = new Graphics();
    hexPath(slot, 11);
    slot.fill({ color: PALETTE.structureLight, alpha: 0.5 });
    hexPath(slot, 11);
    slot.stroke({ width: 1, color: PALETTE.inkDim, alpha: 0.45 });
    slot.position.set(tx, ty);
    const lit = new Graphics();
    hexPath(lit, 10);
    lit.fill({ color: PALETTE.cyan, alpha: 0.55 });
    hexPath(lit, 10);
    lit.stroke({ width: 1.5, color: 0xffffff, alpha: 0.7 });
    lit.position.set(tx, ty);
    lit.tint = PALETTE.cyan;
    lit.alpha = 0;
    const halo = glow(tx, ty, 26, PALETTE.cyan, 0);
    panel.addChild(slot, halo, lit);
    toks.push({ lit, halo });
  }

  // Standard lift: the east banner now floats in the void band above the
  // wall cap, so the wall-face sign lane is free again.
  const def = STATIONS.permission;
  const sign = makeSign(def.label, {
    x: def.anchor.x,
    y: def.anchor.y - 78,
    size: def.signSize,
    accent: PALETTE.cyan,
    halo: true,
  });
  sign.zIndex = def.anchor.y + DEPTH.overlay;
  ctx.layers.labels.addChild(sign);

  // Resting capability state: a stable set of granted tokens stays lit (with
  // slow off-phase breathing when motion is allowed) so the lock answers
  // "may this run?" at a glance instead of reading as a dead wall between
  // sweeps. Sweeps reset everything, then restore this resting set.
  const RESTING_LIT = [1, 4, 6];
  let restingTweens: Killable[] = [];
  const startResting = (breathe: boolean): void => {
    for (const k of restingTweens) k.kill();
    restingTweens = [];
    for (const i of RESTING_LIT) {
      const t = toks[i];
      gsap.killTweensOf([t.lit, t.halo]);
      t.lit.alpha = 0.5;
      t.halo.alpha = 0.25;
      if (breathe) {
        restingTweens.push(
          track(
            gsap.to(t.lit, {
              alpha: 0.28,
              duration: 2.4 + i * 0.5,
              yoyo: true,
              repeat: -1,
              ease: "sine.inOut",
            }),
          ),
        );
      }
    }
  };

  let sweepTl: gsap.core.Timeline | null = null;
  const reset = (): void => {
    sweepTl?.kill();
    for (const t of toks) {
      gsap.killTweensOf([t.lit, t.halo]);
      t.lit.tint = PALETTE.cyan;
      t.lit.alpha = 0;
      t.halo.alpha = 0;
    }
  };

  const api: PermissionSweepApi = {
    sweep(failAt = -1) {
      reset();
      const st = track(gsap.timeline());
      sweepTl = st;
      toks.forEach((t, i) => {
        const at = i * 0.08;
        st.to(t.lit, { alpha: 1, duration: d(0.1) }, at).to(
          t.halo,
          { alpha: 0.6, duration: d(0.1) },
          at,
        );
        if (i === failAt) {
          st.call(
            () => {
              t.lit.tint = PALETTE.blocked;
              t.halo.tint = PALETTE.blocked;
            },
            undefined,
            at,
          ).to(t.lit, { alpha: 0.25, duration: d(0.14), yoyo: true, repeat: 5 }, at + 0.08);
        }
      });
      st.to(
        toks.map((t) => t.lit),
        { alpha: 0, duration: d(0.3), delay: d(0.8) },
      );
      st.to(
        toks.map((t) => t.halo),
        { alpha: 0, duration: d(0.3), delay: d(0.8) },
        "<",
      );
      if (failAt >= 0) {
        st.call(() => {
          for (const t of toks) {
            t.lit.tint = PALETTE.cyan;
            t.halo.tint = PALETTE.cyan;
          }
        });
      }
      st.call(() => startResting(!ctx.reducedMotion));
    },
  };

  // Ambient verification sweep when motion is allowed.
  if (!ctx.reducedMotion) {
    const ambient = gsap.timeline({ repeat: -1, repeatDelay: 8 });
    ambient.call(() => api.sweep(-1));
    track(ambient);
    api.sweep(-1);
    // District heartbeat: one idle token shimmers on a slow off-phase cycle.
    // Dedicated glow so the sweep's reset never fights the shimmer.
    const shimmer = glow(17, -14, 24, PALETTE.blue, 0);
    panel.addChild(shimmer);
    track(
      gsap.fromTo(
        shimmer,
        { alpha: 0 },
        { alpha: 0.4, duration: 2.6, yoyo: true, repeat: -1, ease: "sine.inOut", delay: 1.3 },
      ),
    );
  } else {
    startResting(false);
  }

  // Shared apron stepping east toward the Loss Budget: Permissions and the
  // loss budget stay one adjacent control cluster on the guarded band.
  root.addChild(isoTile(84, 64, 92, 56, PALETTE.structureLight, 0.8, PALETTE.blue));

  // Miniature loss-budget gauge on the apron, mirroring the real meter live:
  // the permission room keeps the budget it enforces in view.
  root.addChild(
    isoBox({
      x: 96,
      y: 44,
      w: 20,
      d: 13,
      h: 9,
      color: PALETTE.structureLight,
      rim: PALETTE.blue,
      rimAlpha: 0.55,
    }),
  );
  const miniLiquid = new Graphics();
  miniLiquid.roundRect(-4, -22, 8, 22, 3);
  miniLiquid.fill({ color: PALETTE.healthy, alpha: 0.8 });
  const miniGlass = new Graphics();
  miniGlass.roundRect(-5, -23, 10, 23, 4);
  miniGlass.stroke({ width: 1.1, color: PALETTE.surfacePale, alpha: 0.55 });
  const mini = new Container();
  mini.position.set(96, 40);
  mini.addChild(miniLiquid, miniGlass);
  root.addChild(mini);
  miniLiquid.scale.y = INITIAL_LOSS_LEVEL;
  lossMirror = (level: number): void => {
    gsap.killTweensOf(miniLiquid.scale);
    track(gsap.to(miniLiquid.scale, { y: level, duration: d(0.9), ease: "power2.inOut" }));
  };
  return api;
}

// ---------------------------------------------------------------------------
// 3. Budget meter (glass reservoirs)
// ---------------------------------------------------------------------------

function buildBudgetMeter(ctx: DioramaContext): BudgetMeterApi {
  const { root } = stationBase(ctx, "budgetMeter");

  contactShadow(root, 0, 16, 150, 100);
  root.addChild(propCrate(-62, 40));
  root.addChild(propCrate(-52, 46, 9));
  root.addChild(isoTile(0, 14, 140, 92, PALETTE.structure, 1, PALETTE.structureLight));
  root.addChild(
    isoBox({ x: 0, y: 8, w: 124, d: 54, h: 8, color: PALETTE.structureLight, rim: PALETTE.blue }),
  );

  // Honest reservoirs (TradingBudgetReader / loss accounting): the loss
  // budget, risk reservations, and capital. The legacy API keys "tools" and
  // "authority" stay accepted as aliases of the reservations reservoir.
  type ResKey = "loss" | "capital" | "tools" | "authority";
  type TankKey = "loss" | "reservations" | "capital";
  const alias: Record<ResKey, TankKey> = {
    loss: "loss",
    capital: "capital",
    tools: "reservations",
    authority: "reservations",
  };
  const specs: { key: TankKey; label: string; x: number; h: number; color: number; row: number }[] =
    [
      { key: "loss", label: "LOSS BUDGET", x: -40, h: 78, color: PALETTE.healthy, row: 0 },
      { key: "reservations", label: "RESERVATIONS", x: 0, h: 62, color: PALETTE.yellow, row: 1 },
      { key: "capital", label: "CAPITAL", x: 40, h: 70, color: PALETTE.blue, row: 0 },
    ];
  const levels: Record<TankKey, number> = {
    loss: INITIAL_LOSS_LEVEL,
    reservations: 0.5,
    capital: 0.7,
  };

  const liquids: Record<string, Container> = {};
  const bubbles: Record<string, Container> = {};
  const readouts: Record<TankKey, Text> = {} as Record<TankKey, Text>;
  // Captions carry name plus live value on two staggered rows (row 0 = outer
  // tanks, row 1 = center): the 40-unit tube pitch cannot fit three wide
  // captions side by side. Values refresh only on consume events; nothing
  // redraws per frame.
  const labelStyle = new TextStyle({
    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
    fontSize: 7.5,
    letterSpacing: 0.4,
    fill: PALETTE.inkDim,
  });
  const pct = (level: number): string => `${Math.round(level * 100)}%`;

  for (const s of specs) {
    const baseY = -10;
    // Glass tube outline (static, drawn once).
    const tube = new Graphics();
    tube.roundRect(s.x - 8, baseY - s.h - 4, 16, s.h + 8, 8);
    tube.fill({ color: PALETTE.surfacePale, alpha: 0.06 });
    tube.roundRect(s.x - 8, baseY - s.h - 4, 16, s.h + 8, 8);
    tube.stroke({ width: 1.2, color: PALETTE.surfacePale, alpha: 0.4 });
    // Gauge scale: quarter ticks so the drawdown reads without any values.
    for (let t = 1; t <= 3; t++) {
      const ty = baseY - (s.h * t) / 4;
      tube.moveTo(s.x + 9, ty);
      tube.lineTo(s.x + 13, ty);
      tube.stroke({ width: 1, color: PALETTE.inkDim, alpha: 0.5 });
    }
    root.addChild(tube);

    // Liquid: full-height graphics inside a bottom-anchored container.
    const liquid = new Container();
    liquid.position.set(s.x, baseY);
    const lg = new Graphics();
    lg.roundRect(-7, -s.h, 14, s.h, 6);
    lg.fill({ color: s.color, alpha: 0.75 });
    lg.rect(-7, -s.h, 14, 1.5); // meniscus line
    lg.fill({ color: PALETTE.surfacePale, alpha: 0.85 });
    liquid.addChild(lg);
    root.addChild(liquid);
    liquid.scale.y = levels[s.key];
    liquids[s.key] = liquid;

    // Pooled bubble sprite, hidden until a consume plays.
    const bubble = glow(s.x, 0, 10, s.color, 0);
    bubble.position.set(s.x, baseY - 6);
    root.addChild(bubble);
    bubbles[s.key] = bubble;

    // Real text caption under each tube on its staggered row; never baked.
    const label = new Text({ text: `${s.label} ${pct(levels[s.key])}`, style: labelStyle });
    label.resolution = 2;
    label.anchor.set(0.5);
    label.position.set(s.x, baseY + 13 + s.row * 11);
    root.addChild(label);
    readouts[s.key] = label;

    if (s.key === "loss") {
      // Bold minimum line where a fresh mission budget rolls over (0.15),
      // labeled so the gauge scale reads at mid zoom.
      const min = new Graphics();
      min.moveTo(s.x - 11, baseY - s.h * 0.15);
      min.lineTo(s.x + 11, baseY - s.h * 0.15);
      min.stroke({ width: 2.5, color: PALETTE.blocked, alpha: 0.9 });
      root.addChild(min);
      const minLabel = new Text({
        text: "MIN",
        style: new TextStyle({
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          fontSize: 6,
          letterSpacing: 0.5,
          fill: PALETTE.blocked,
        }),
      });
      minLabel.resolution = 2;
      minLabel.anchor.set(1, 0.5);
      minLabel.position.set(s.x - 13, baseY - s.h * 0.15);
      root.addChild(minLabel);
    }
  }

  stationSign(ctx, "budgetMeter", 104);

  const api: BudgetMeterApi = {
    consume(reservoir, amount) {
      const tank = alias[reservoir];
      // Floor the drawdown at 15%; sinking further rolls a fresh mission
      // budget so the reservoir never reads permanently spent.
      const drained = levels[tank] - Math.max(0, Math.min(1, amount));
      const next = drained < 0.15 ? INITIAL_LOSS_LEVEL : Math.max(0.15, drained);
      const from = levels[tank];
      levels[tank] = next;
      const spec = specs.find((sp) => sp.key === tank)!;
      readouts[tank].text = `${spec.label} ${pct(next)}`;
      if (tank === "loss") lossMirror?.(next);
      const liquid = liquids[tank];
      const bubble = bubbles[tank];
      gsap.killTweensOf([liquid.scale, bubble]);
      bubble.alpha = 0.9;
      const h = spec.h;
      track(
        gsap
          .timeline()
          .to(bubble, { y: -10 - h * next, duration: d(0.7), ease: "sine.out" }, 0)
          .to(bubble, { alpha: 0, duration: d(0.7) }, 0)
          .fromTo(
            liquid.scale,
            { y: from },
            { y: next, duration: d(0.9), ease: "power2.inOut" },
            0,
          ),
      );
    },
  };
  return api;
}

// ---------------------------------------------------------------------------
// 4. Risk scanning station (standard platform + corridor of four arches)
// ---------------------------------------------------------------------------

function buildRiskFortress(ctx: DioramaContext): RiskFortressApi {
  const { root } = stationBase(ctx, "riskFortress");

  contactShadow(root, 0, 12, 260, 190, 0.25);
  // Standard booth-family platform, gold-rimmed like the rest of the east
  // zone. No towers, no crenellations, no moat: the scanning arches below
  // carry the whole story.
  root.addChild(isoTile(0, 6, 240, 165, PALETTE.structure, 1, PALETTE.yellow));
  root.addChild(isoTile(0, 14, 190, 130, PALETTE.structureLight, 0.5));

  // Low back walls along the platform's north edges; the south face stays
  // open to the room. Same isoWall family as Permissions.
  root.addChild(
    isoWall({ x1: -104, y1: 8, x2: 0, y2: -54, h: 30, color: PALETTE.structure, rim: PALETTE.yellow }),
  );
  root.addChild(
    isoWall({ x1: 0, y1: -54, x2: 104, y2: 8, h: 30, color: PALETTE.structure, rim: PALETTE.yellow }),
  );

  // Two corner posts at the back-wall ends: plain boxes with emissive tips,
  // the same post family as the Execution gateway's guards.
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

  // Corridor of 4 scanning arches, west to east across the platform: loss
  // budget, position limit, leverage, exposure cap. A checked order walks
  // the corridor and stops at the arch it fails.
  const corridorY = 26;
  root.addChild(isoTile(0, corridorY, 236, 40, PALETTE.structureLight, 0.85, PALETTE.yellow));
  const archXs = [-82, -28, 26, 80];
  const glows: Container[] = [];
  const drawGlyph = (kind: number, color: number): Graphics => {
    const g = new Graphics();
    if (kind === 0) {
      // loss budget: coin
      g.circle(0, 0, 5);
      g.stroke({ width: 1.5, color });
      g.circle(0, 0, 2);
      g.stroke({ width: 1, color });
    } else if (kind === 1) {
      // position limit: stack
      for (let i = -1; i <= 1; i++) {
        g.roundRect(-5, i * 4 - 1.5, 10, 3, 1);
        g.fill({ color });
      }
    } else if (kind === 2) {
      // leverage: double chevron up
      for (const dy of [2, -3]) {
        g.moveTo(-4, dy + 2);
        g.lineTo(0, dy - 2);
        g.lineTo(4, dy + 2);
        g.stroke({ width: 1.5, color });
      }
    } else {
      // exposure cap: shield
      g.poly([0, -6, 5, -3, 5, 2, 0, 6, -5, 2, -5, -3]);
      g.fill({ color });
    }
    return g;
  };
  archXs.forEach((ax, i) => {
    const a = arch(ax, corridorY, 56, 46, PALETTE.structureLight, PALETTE.cyan);
    root.addChild(a);
    // Crisper gold rim across the arch beam so each arch reads as a gate.
    root.addChild(
      edgeStrip(ax - 28, corridorY - 46, ax + 28, corridorY - 46, PALETTE.yellow, 0.9, 1.6),
    );
    const g = glow(ax, corridorY - 4, 44, PALETTE.cyan, 0.18);
    root.addChild(g);
    glows.push(g);
    const glyph = new Container();
    glyph.position.set(ax, corridorY - 54);
    glyph.addChild(drawGlyph(i, PALETTE.yellow));
    root.addChild(glyph);
    if (!ctx.reducedMotion) {
      track(
        gsap.to(g, {
          alpha: 0.3,
          duration: 3.2 + i * 0.5,
          yoyo: true,
          repeat: -1,
          ease: "sine.inOut",
          delay: i * 0.6,
        }),
      );
    }
  });

  // Pooled order token.
  const token = new Container();
  const tokCore = glow(0, 0, 20, PALETTE.cyan, 0.8);
  const tokDot = new Sprite(dotTexture());
  tokDot.anchor.set(0.5);
  tokDot.width = 10;
  tokDot.height = 10;
  tokDot.tint = 0xffffff;
  token.addChild(tokCore, tokDot);
  token.position.set(archXs[0] - 36, corridorY - 8);
  token.visible = false;
  root.addChild(token);

  // Barrier decal shown at a failed arch.
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

  const exitBurst = glow(112, corridorY - 8, 0, PALETTE.healthy, 0.9);
  root.addChild(exitBurst);

  stationSign(ctx, "riskFortress", 100, PALETTE.yellow);

  let scanTl: gsap.core.Timeline | null = null;
  const resetScan = (): void => {
    scanTl?.kill();
    gsap.killTweensOf([...glows, token, barrier, exitBurst]);
    token.visible = false;
    barrier.visible = false;
    exitBurst.width = 0;
    exitBurst.height = 0;
    glows.forEach((g) => {
      g.tint = PALETTE.cyan;
      g.alpha = 0.18;
    });
  };

  const flashArch = (i: number, color: number): void => {
    const g = glows[i];
    g.tint = color;
    track(gsap.to(g, { alpha: 0.8, duration: d(0.12), yoyo: true, repeat: 1 }));
  };

  const api: RiskFortressApi = {
    runScan(valid, stopAtArch = 3) {
      resetScan();
      const stop = valid ? 4 : Math.max(0, Math.min(3, stopAtArch));
      token.visible = true;
      token.alpha = 1;
      token.x = archXs[0] - 36;
      const sc = track(gsap.timeline({ onComplete: resetScan }));
      scanTl = sc;
      for (let i = 0; i < stop; i++) {
        sc.to(token, { x: archXs[i], duration: d(0.26), ease: "none" }).call(flashArch, [
          i,
          PALETTE.cyan,
        ]);
      }
      if (valid) {
        sc.to(token, { x: 108, duration: d(0.28), ease: "none" })
          .call(() => {
            exitBurst.width = 60;
            exitBurst.height = 60;
            track(gsap.to(exitBurst, { width: 0, height: 0, alpha: 0, duration: d(0.5) }));
          })
          .to(token, { alpha: 0, duration: d(0.2) }, "<");
      } else {
        const i = stop;
        sc.to(token, { x: archXs[i], duration: d(0.26), ease: "none" }).call(() => {
          const g = glows[i];
          barrier.position.set(archXs[i], corridorY - 20);
          barrier.visible = true;
          barrier.alpha = 1;
          barrier.scale.set(0.6);
          track(
            gsap
              .timeline()
              .to(barrier.scale, { x: 1, y: 1, duration: d(0.2), ease: "back.out(3)" })
              .to(g, { alpha: 0.85, duration: d(0.18), yoyo: true, repeat: 1 }, 0)
              .call(() => {
                g.tint = PALETTE.warning;
              })
              .to(g, { alpha: 0.85, duration: d(0.2), yoyo: true, repeat: 2 }, ">")
              .call(() => {
                g.tint = PALETTE.blocked;
              })
              .to(g, { alpha: 0.4, duration: d(0.3) })
              .to(barrier, { alpha: 0, duration: d(0.4), delay: d(0.8) }),
          );
        });
        sc.to(token, { x: archXs[i] - 7, duration: d(0.07), yoyo: true, repeat: 3 }).to(token, {
          alpha: 0,
          duration: d(0.3),
          delay: d(1.1),
        });
      }
    },
  };
  if (!ctx.reducedMotion) {
    // Occasional demo scan so the anchor is alive between stories.
    const demo = gsap.timeline({ repeat: -1, repeatDelay: 11 });
    demo.call(() => api.runScan(true));
    track(demo);
  }
  return api;
}

// ---------------------------------------------------------------------------
// 5. Protection layer (orbiting position tokens + shield shells)
// ---------------------------------------------------------------------------

function buildProtection(ctx: DioramaContext): ProtectionApi {
  const { root } = stationBase(ctx, "protection");

  contactShadow(root, 0, 4, 132, 96);
  // Ring platform.
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
    // Persistent shield mark: the token's protection state, always readable.
    const shieldMark = new Graphics();
    hexPath(shieldMark, 10);
    shieldMark.stroke({ width: 1.5, color: PALETTE.healthy, alpha: 0.85 });
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

  let shieldTl: gsap.core.Timeline | null = null;
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
      target.shieldMark.tint = STATE_MARK.shielded.tint;
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
            },
          })
          .to(shells.scale, { x: 1, y: 1, duration: d(0.4), ease: "back.out(2.4)" })
          .to(pulse, { width: 70, height: 70, duration: d(0.3) }, 0)
          .to(pulse, { alpha: 0, duration: d(0.4) }, "<")
          // Snap on: quick scale kick after materializing.
          .to(shells.scale, { x: 1.12, y: 1.12, duration: d(0.08), yoyo: true, repeat: 1 })
          .call(() => {
            target.shieldMark.alpha = STATE_MARK.shielded.alpha;
          })
          .to(shells, { alpha: 0, duration: d(0.5), delay: d(1.6) }),
      );
      shieldTl = sh;
    },
  };

  if (!ctx.reducedMotion) {
    const demo = gsap.timeline({ repeat: -1, repeatDelay: 9 });
    demo.call(() => api.shieldUp());
    track(demo);
  }
  ctx.onCleanup(() => {
    unreg();
  });
  return api;
}

// ---------------------------------------------------------------------------
// 6. Signer vault (isolated cutaway chamber; the key never leaves)
// ---------------------------------------------------------------------------

function buildSignerVault(ctx: DioramaContext): SignerVaultApi {
  const { root } = stationBase(ctx, "signerVault");

  contactShadow(root, -6, 6, 180, 140);
  // Short bridge west toward the risk corridor's exit, so the checked order
  // walks straight to the vault.
  root.addChild(isoTile(-92, 16, 52, 22, PALETTE.structureLight, 0.6, PALETTE.yellow));

  // Raised floor.
  root.addChild(
    isoBox({ x: 0, y: 0, w: 138, d: 108, h: 12, color: PALETTE.structure, rim: PALETTE.yellow }),
  );
  root.addChild(isoTile(0, -6, 126, 96, PALETTE.structureLight, 0.9, PALETTE.yellow));

  // Thick cutaway walls: full back edges + short front stubs, open front face.
  root.addChild(
    isoWall({
      x1: -62,
      y1: -6,
      x2: 0,
      y2: -56,
      h: 44,
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
      h: 44,
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
      h: 30,
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
      h: 30,
      color: PALETTE.structure,
      rim: PALETTE.yellow,
    }),
  );

  // Sentinel mast above the north wall: a taller gold-tipped silhouette
  // element marking the vault from across the room.
  const mast = new Graphics();
  mast.rect(-63, -112, 2, 54);
  mast.fill({ color: PALETTE.structureLight });
  mast.rect(-66, -112, 8, 1.4);
  mast.fill({ color: PALETTE.yellow, alpha: 0.7 });
  mast.circle(-62, -115, 2.2);
  mast.fill({ color: PALETTE.yellow, alpha: 0.95 });
  root.addChild(mast);
  root.addChild(glow(-62, -115, 12, PALETTE.yellow, 0.3));

  // Interior pedestal with the STATIC key glyph, set into a niche on the
  // west back wall. Never animated, and never at chamber center: a parked
  // actor at the anchor must not intersect the key or the diamond frame.
  root.addChild(
    isoCylinder({
      x: -30,
      y: -28,
      r: 8,
      h: 14,
      color: PALETTE.structureLight,
      rim: PALETTE.yellow,
    }),
  );
  const niche = new Graphics();
  niche.roundRect(-44, -64, 28, 32, 4);
  niche.fill({ color: PALETTE.structure, alpha: 0.9 });
  niche.roundRect(-44, -64, 28, 32, 4);
  niche.stroke({ width: 1.2, color: PALETTE.yellow, alpha: 0.5 });
  root.addChild(niche);
  const key = new Container();
  key.position.set(-30, -48);
  const keyG = new Graphics();
  keyG.circle(-5, 0, 4.5);
  keyG.stroke({ width: 2, color: PALETTE.yellow });
  keyG.circle(-5, 0, 1.5);
  keyG.fill({ color: PALETTE.yellow });
  keyG.rect(-1, -1.2, 14, 2.4);
  keyG.fill({ color: PALETTE.yellow });
  keyG.rect(7, 0, 2, 4);
  keyG.fill({ color: PALETTE.yellow });
  keyG.rect(11, 0, 2, 5);
  keyG.fill({ color: PALETTE.yellow });
  key.addChild(keyG, glow(0, 0, 30, PALETTE.yellow, 0.45));
  root.addChild(key);
  // District heartbeat: the niche light over the key breathes slowly.
  // The key glyph itself never animates.
  const vaultPulse = glow(-30, -48, 44, PALETTE.yellow, 0.14);
  root.addChild(vaultPulse);
  if (!ctx.reducedMotion) {
    track(
      gsap.to(vaultPulse, {
        alpha: 0.34,
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

  // Signing flash: vertical beam + expanding ring over the pedestal, pooled.
  const flashBeam = lightBeam(-30, -28, 10, 22, 50, PALETTE.yellow, 0);
  const flashRing = glow(-30, -28, 0, PALETTE.yellow, 0.9);
  root.addChild(flashBeam, flashRing);

  // Order capsule (pooled).
  const capsule = makeCapsule(PALETTE.waiting);
  root.addChild(capsule);

  stationSign(ctx, "signerVault", 142, PALETTE.yellow);

  let tl: gsap.core.Timeline | null = null;
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
          .to(capsule, { x: 0, y: -12, duration: d(0.45), ease: "power1.inOut" })
          .to(capsule, { alpha: 0.25, duration: d(0.12), yoyo: true, repeat: 1 })
          // The vault signs; the key stays on its pedestal.
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
// 7. Execution gateway (guarded terminal dispatching to the exchange booth)
// ---------------------------------------------------------------------------

function buildExecutionGateway(ctx: DioramaContext): ExecutionGatewayApi {
  const { root } = stationBase(ctx, "executionGateway");

  contactShadow(root, 2, 12, 178, 138);
  root.addChild(propCrate(-58, 44));
  root.addChild(isoTile(0, 10, 138, 102, PALETTE.structure, 1, PALETTE.structureLight));

  // Two guard posts on the south rim.
  for (const gx of [-46, 34]) {
    root.addChild(
      isoBox({ x: gx, y: 32, w: 22, d: 16, h: 26, color: PALETTE.structure, rim: PALETTE.aqua }),
    );
    root.addChild(glow(gx, -2, 16, PALETTE.cyan, 0.5));
  }

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

  // 5-lamp state strip.
  type GwState = "idle" | "preparing" | "submitted" | "acknowledged" | "failed";
  const lampColors: Record<GwState, number> = {
    idle: PALETTE.waiting,
    preparing: PALETTE.warning,
    submitted: PALETTE.orange,
    acknowledged: PALETTE.healthy,
    failed: PALETTE.blocked,
  };
  const lamps: Record<GwState, { dot: Graphics; halo: Container }> = {} as Record<
    GwState,
    { dot: Graphics; halo: Container }
  >;
  (Object.keys(lampColors) as GwState[]).forEach((st, i) => {
    const lx = -44 + i * 22;
    const dot = new Graphics();
    dot.circle(lx, -56, 4.5);
    dot.fill({ color: lampColors[st], alpha: 0.25 });
    dot.circle(lx, -56, 4.5);
    dot.stroke({ width: 1, color: lampColors[st], alpha: 0.6 });
    const halo = glow(lx, -56, 22, lampColors[st], 0);
    root.addChild(halo, dot);
    lamps[st] = { dot, halo };
  });

  // Pooled order capsule + reject bin.
  const capsule = makeCapsule(PALETTE.orange);
  root.addChild(capsule);
  const bin = isoBox({
    x: 36,
    y: 48,
    w: 28,
    d: 20,
    h: 14,
    color: PALETTE.structure,
    rim: PALETTE.blocked,
    rimAlpha: 0.5,
  });
  root.addChild(bin);

  // Sign above the booth, clear of the lamp strip and the exchange port.
  stationSign(ctx, "executionGateway", 84, PALETTE.cyan);

  let tl: gsap.core.Timeline | null = null;
  const setLamps = (active: GwState | null): void => {
    (Object.keys(lamps) as GwState[]).forEach((st) => {
      const on = st === active;
      const l = lamps[st];
      gsap.killTweensOf([l.dot, l.halo]);
      l.dot.alpha = on ? 1 : 0.45;
      l.halo.alpha = on ? 0.7 : 0;
    });
  };
  setLamps("idle");

  const resetCapsule = (): void => {
    capsule.visible = false;
    capsule.alpha = 1;
    capsule.rotation = 0;
    capsule.body.tint = 0xffffff;
    capsule.position.set(conv.x1, conv.y1);
  };

  const api: ExecutionGatewayApi = {
    setState(state) {
      tl?.kill();
      gsap.killTweensOf([capsule, capsule.body]);
      resetCapsule();
      setLamps(state === "idle" ? "idle" : state);
      if (state === "idle") return;
      const gt = track(gsap.timeline());
      tl = gt;
      if (state === "preparing") {
        // Capsule assembles at the conveyor start (signer side, east).
        capsule.visible = true;
        capsule.scale.set(0);
        gt.to(capsule.scale, { x: 1, y: 1, duration: d(0.35), ease: "back.out(2)" }).to(capsule, {
          x: 0,
          y: -28,
          duration: d(0.4),
          ease: "none",
        });
      } else if (state === "submitted") {
        capsule.visible = true;
        capsule.scale.set(1);
        capsule.position.set(0, -28);
        gt.to(capsule, { x: conv.x2, y: conv.y2, duration: d(0.5), ease: "power1.in" }).to(capsule, {
          alpha: 0,
          duration: d(0.15),
        });
      } else if (state === "acknowledged") {
        // Capsule is gone; green confirmation at the launch mouth.
        const burst = glow(conv.x2, conv.y2 - 2, 0, PALETTE.healthy, 0.9);
        root.addChild(burst);
        gt.fromTo(
          burst,
          { width: 10, height: 10 },
          {
            width: 56,
            height: 56,
            alpha: 0,
            duration: d(0.6),
            onComplete: () => safeDestroy(burst),
          },
        );
      } else {
        // failed: capsule flashes red at the conveyor start, drops south
        // clear of the booth, then into the reject bin.
        capsule.visible = true;
        capsule.position.set(conv.x1, conv.y1);
        capsule.body.tint = PALETTE.blocked;
        gt.to(capsule, { alpha: 0.3, duration: d(0.12), yoyo: true, repeat: 3 })
          .to(capsule, { y: 34, duration: d(0.3), ease: "power1.in" })
          .to(capsule, { x: 36, y: 46, duration: d(0.25), ease: "power1.in" })
          .to(capsule, { alpha: 0, duration: d(0.25) });
      }
    },
  };
  return api;
}

// ---------------------------------------------------------------------------
// District assembly
// ---------------------------------------------------------------------------

/**
 * Floor guidance for the pipeline reading order:
 * Approval -> Permissions -> Loss Budget -> Risk -> Protection -> Signer ->
 * Execution. Chevrons mark only the budget-to-risk leg, the one hop with no
 * primary rail; every other leg now duplicates a re-anchored route and
 * stamped chevrons would read as marks wandering beside their rails. One
 * runner light walks the whole sequence. Semantic colors are never used
 * here; this is wayfinding, not state.
 */
function buildPipelineFlow(ctx: DioramaContext): void {
  const seq: { x: number; y: number }[] = [
    STATIONS.approval.anchor,
    STATIONS.permission.anchor,
    STATIONS.budgetMeter.anchor,
    STATIONS.riskFortress.anchor,
    STATIONS.protection.anchor,
    STATIONS.signerVault.anchor,
    STATIONS.executionGateway.anchor,
  ];
  /** Leg indices (seq[i] -> seq[i+1]) that keep floor chevrons. */
  const legsWithFloorChevrons = new Set([2]);

  const chevrons = new Container();
  for (let g = 0; g < seq.length - 1; g++) {
    if (!legsWithFloorChevrons.has(g)) continue;
    const a = seq[g];
    const b = seq[g + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const angle = Math.atan2(dy, dx);
    // Start and end inset so chevrons sit between footprints, not under them.
    const start = 0.34;
    const end = 0.66;
    const count = 3;
    for (let k = 0; k < count; k++) {
      const t = start + ((end - start) * (k + 0.5)) / count;
      const mark = new Graphics();
      mark.poly([5, 0, -2, -4, 0, 0, -2, 4, 5, 0]);
      mark.fill({ color: PALETTE.cyan, alpha: 0.45 });
      mark.position.set(a.x + dx * t, a.y + dy * t);
      mark.rotation = angle;
      mark.zIndex = Math.max(a.y, b.y) + DEPTH.base - 3;
      chevrons.addChild(mark);
    }
  }
  ctx.layers.sortable.addChild(chevrons);

  if (ctx.reducedMotion) return;
  // Runner light: one pooled dot hops the sequence every ~9.5 s. Its depth
  // follows its position so it never paints behind a station it has passed.
  const runner = new Sprite(dotTexture());
  runner.anchor.set(0.5);
  runner.width = 9;
  runner.height = 9;
  runner.tint = PALETTE.cyan;
  runner.alpha = 0.9;
  runner.zIndex = seq[0].y + DEPTH.base + 2;
  ctx.layers.sortable.addChild(runner);
  const rt = gsap.timeline({
    repeat: -1,
    repeatDelay: 4.2,
    onUpdate: () => {
      runner.zIndex = runner.y + DEPTH.base + 2;
    },
  });
  for (let g = 0; g < seq.length - 1; g++) {
    rt.to(runner, { x: seq[g + 1].x, y: seq[g + 1].y, duration: 0.62, ease: "none" }, g * 0.7);
  }
  rt.to(runner, { alpha: 0, duration: 0.3 }, (seq.length - 1) * 0.7).set(runner, {
    x: seq[0].x,
    y: seq[0].y,
    alpha: 0.9,
  });
  track(rt);
}

export function buildRiskDistrict(ctx: DioramaContext): void {
  reduced = ctx.reducedMotion;
  killables.length = 0;
  lossMirror = null;
  for (const key of Object.keys(stationParts)) delete stationParts[key as StationId];
  ctx.onCleanup(() => {
    for (const k of killables) k.kill();
    killables.length = 0;
  });

  buildPipelineFlow(ctx);

  const apis = {
    approval: buildApproval(ctx),
    emergencyPanel: buildEmergencyPanel(ctx),
    permission: buildPermission(ctx),
    budgetMeter: buildBudgetMeter(ctx),
    riskFortress: buildRiskFortress(ctx),
    protection: buildProtection(ctx),
    signerVault: buildSignerVault(ctx),
    executionGateway: buildExecutionGateway(ctx),
  } as const;

  for (const id of Object.keys(apis) as StationId[]) {
    const parts = stationParts[id];
    if (!parts) continue;
    registerStation({ id, root: parts.root, hit: parts.hit, api: apis[id as keyof typeof apis] });
  }
}
