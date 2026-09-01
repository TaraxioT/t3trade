/**
 * Risk & Execution district: approval desk, permission control, budget
 * meter, risk fortress arches, protection layer, signer vault, and the
 * execution gateway. Owner: risk district worker.
 *
 * Layout reads west to east matching the pipeline:
 * Decision -> Approval -> Permission -> Risk -> Sign -> Execute -> Exchange.
 * All statics are drawn once; motion uses pooled sprites and GSAP timelines
 * that are killed on world cleanup. The scene reads correctly unanimated.
 */
import { Container, Graphics, Sprite, Text, TextStyle } from "pixi.js";
import { gsap } from "gsap";
import type { DioramaContext } from "../core/context.js";
import { STATIONS, type StationId } from "../config/stations.js";
import { GATE_WEST } from "../config/geometry.js";
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

export interface ApprovalApi {
  setSeal(state: "waiting" | "approved" | "denied"): void;
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
 * the two stations read as one control cluster on the safety spine. Cleared
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
  atX?: number,
): Container & { signText: Text } {
  const def = STATIONS[id];
  const sign = makeSign(def.label, {
    x: atX ?? def.anchor.x,
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
 * root-local (risk roots are positioned at their anchor).
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

/** Gold brazier light: tiny bowl + flame + warm glow, for fortress corners. */
function brazier(root: Container, x: number, y: number): void {
  const bowl = new Graphics();
  bowl.rect(x - 4, y - 4, 8, 3);
  bowl.fill({ color: PALETTE.structureLight });
  bowl.rect(x - 1, y - 9, 2, 5);
  bowl.fill({ color: PALETTE.orange, alpha: 0.95 });
  bowl.poly([x - 2.5, y - 9, x + 2.5, y - 9, x, y - 13]);
  bowl.fill({ color: PALETTE.yellow, alpha: 0.9 });
  root.addChild(bowl);
  root.addChild(glow(x, y - 9, 18, PALETTE.orange, 0.32));
}

// ---------------------------------------------------------------------------
// 1. Approval desk (in the west gate opening)
// ---------------------------------------------------------------------------

function buildApproval(ctx: DioramaContext): ApprovalApi {
  const { root } = stationBase(ctx, "approval");

  contactShadow(root, 8, 10, 160, 110);
  // Gate furnishings: small arch frame + floor strip inside the opening.
  const gx = GATE_WEST.x - STATIONS.approval.anchor.x;
  const gy = GATE_WEST.cy - STATIONS.approval.anchor.y;
  root.addChild(isoTile(gx, gy, 46, 104, PALETTE.structureLight, 0.9, PALETTE.cyan));
  root.addChild(edgeStrip(gx, gy - 52, gx, gy - 48, PALETTE.cyan, 0.7));
  root.addChild(edgeStrip(gx, gy + 48, gx, gy + 52, PALETTE.cyan, 0.7));
  const gateArch = arch(gx, gy - 40, 84, 54, PALETTE.structure, PALETTE.cyan);
  root.addChild(gateArch);

  // Desk sitting in the opening, tray to the west. Blue counter-inlay on
  // the desk top edge balances the gold trim.
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

  // Queue of dimmed waiting cards west of the tray.
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
          // Card drops back through the gate, westward.
          .to(card, { x: -120, y: -2, rotation: -0.4, duration: d(0.55), ease: "power1.in" }, "<")
          .to(card, { alpha: 0, duration: d(0.2) }, "-=0.15")
          .to(cross, { alpha: 0, duration: d(0.3) }, "+=0.3")
          .call(() => {
            sealGlow.alpha = 0.3;
            startWaiting();
          });
      }
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
  // Low back walls, open front. h <= 36 per spec.
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

  stationSign(ctx, "permission", 92);

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

  // Shared apron from the room's front step down toward the budget platform:
  // Permissions and the Loss Budget are one adjacent control cluster on the
  // safety spine, not two unrelated stations.
  root.addChild(isoTile(0, 97, 108, 64, PALETTE.structureLight, 0.8, PALETTE.blue));
  root.addChild(isoTile(0, 141, 128, 30, PALETTE.structureLight, 0.9, PALETTE.blue));

  // Miniature loss-budget gauge in the front yard, mirroring the real meter
  // live: the permission room keeps the budget it enforces in view.
  root.addChild(
    isoBox({
      x: -62,
      y: 46,
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
  mini.position.set(-62, 42);
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

  contactShadow(root, 0, 18, 162, 108);
  root.addChild(propCrate(-72, 44));
  root.addChild(propCrate(-62, 50, 9));
  root.addChild(isoTile(0, 14, 144, 96, PALETTE.structure, 1, PALETTE.structureLight));
  root.addChild(
    isoBox({ x: 0, y: 8, w: 128, d: 56, h: 8, color: PALETTE.structureLight, rim: PALETTE.blue }),
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
  // captions side by side, and the baseline stack produced the
  // "LOSS BIOMESERVATIONSAPITAL" garble seen in four vision shots. Values
  // refresh only on consume events; nothing redraws per frame.
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
// 4. Risk fortress (visual anchor: open courtyard + scanning arches)
// ---------------------------------------------------------------------------

function buildRiskFortress(ctx: DioramaContext): RiskFortressApi {
  const { root } = stationBase(ctx, "riskFortress");

  contactShadow(root, 0, 12, 320, 230, 0.25);
  root.addChild(isoTile(0, 0, 280, 200, PALETTE.structure, 1, PALETTE.yellow));
  // Courtyard inner tint.
  root.addChild(isoTile(0, 10, 210, 140, PALETTE.structureLight, 0.55));

  // Corner towers.
  const towers: { x: number; y: number }[] = [
    { x: -140, y: 0 },
    { x: 0, y: -100 },
    { x: 140, y: 0 },
    { x: 0, y: 100 },
  ];
  towers.forEach((t, i) => {
    const th = 56 - (i % 2) * 6;
    root.addChild(
      isoCylinder({ x: t.x, y: t.y, r: 13, h: th, color: PALETTE.structure, rim: PALETTE.yellow }),
    );
    // Gold brazier light burning at each corner: warmth against the blue.
    brazier(root, t.x, t.y - th - 7);
  });

  // Low crenellated walls along the two back edges; front stays open.
  const crenel = (x1: number, y1: number, x2: number, y2: number): void => {
    root.addChild(
      isoWall({ x1, y1, x2, y2, h: 20, color: PALETTE.structure, rim: PALETTE.yellow }),
    );
    const n = 4;
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const mx = x1 + (x2 - x1) * t;
      const my = y1 + (y2 - y1) * t - 20;
      root.addChild(
        isoBox({
          x: mx,
          y: my,
          w: 18,
          d: 10,
          h: 8,
          color: PALETTE.structure,
          rim: PALETTE.yellow,
          rimAlpha: 0.4,
        }),
      );
    }
  };
  crenel(-140, 0, 0, -100);
  crenel(0, -100, 140, 0);

  // Walkway bypass around the outside (south). Blue counter-inlay keeps the
  // gold fortress off the shared cyan.
  root.addChild(isoTile(0, 116, 270, 26, PALETTE.structureLight, 0.5, PALETTE.blue));

  // Corridor of 4 scanning arches, west to east through the courtyard.
  const corridorY = 26;
  // Pale corridor floor so the pavilion reads at fit zoom.
  root.addChild(isoTile(0, corridorY, 286, 40, PALETTE.structureLight, 0.85, PALETTE.yellow));
  const archXs = [-92, -31, 30, 91];
  const glows: Container[] = [];
  const glyphs: Container[] = [];
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
    const a = arch(ax, corridorY, 58, 50, PALETTE.structureLight, PALETTE.cyan);
    root.addChild(a);
    // Crisper gold rim across the arch beam so each arch reads as a gate.
    root.addChild(
      edgeStrip(ax - 29, corridorY - 50, ax + 29, corridorY - 50, PALETTE.yellow, 0.9, 1.6),
    );
    const g = glow(ax, corridorY - 4, 46, PALETTE.cyan, 0.18);
    root.addChild(g);
    glows.push(g);
    const glyph = new Container();
    glyph.position.set(ax, corridorY - 58);
    glyph.addChild(drawGlyph(i, PALETTE.yellow));
    root.addChild(glyph);
    glyphs.push(glyph);
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
  token.position.set(archXs[0] - 40, corridorY - 8);
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

  const exitBurst = glow(128, corridorY - 8, 0, PALETTE.healthy, 0.9);
  root.addChild(exitBurst);

  stationSign(ctx, "riskFortress", 190, PALETTE.yellow);

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
      g.alpha = ctx.reducedMotion ? 0.18 : 0.18;
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
      token.x = archXs[0] - 40;
      const sc = track(gsap.timeline({ onComplete: resetScan }));
      scanTl = sc;
      for (let i = 0; i < stop; i++) {
        sc.to(token, { x: archXs[i], duration: d(0.26), ease: "none" }).call(flashArch, [
          i,
          PALETTE.cyan,
        ]);
      }
      if (valid) {
        sc.to(token, { x: 126, duration: d(0.28), ease: "none" })
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

  contactShadow(root, 0, 4, 168, 124);
  // Ring platform.
  root.addChild(isoTile(0, 0, 150, 110, PALETTE.structure, 1, PALETTE.structureLight));
  const ring = new Graphics();
  ring.ellipse(0, 0, 56, 28);
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
      o.dot.position.set(Math.cos(o.angle) * 56, Math.sin(o.angle) * 28 - 4);
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

  contactShadow(root, -8, 6, 200, 150);
  // Isolation bridge from the vault west toward the fortress side.
  root.addChild(isoTile(-108, 22, 58, 24, PALETTE.structureLight, 0.6, PALETTE.yellow));
  root.addChild(isoTile(-156, 34, 54, 24, PALETTE.structureLight, 0.5, PALETTE.yellow));

  // Raised floor.
  root.addChild(
    isoBox({ x: 0, y: 0, w: 152, d: 118, h: 12, color: PALETTE.structure, rim: PALETTE.yellow }),
  );
  root.addChild(isoTile(0, -6, 138, 104, PALETTE.structureLight, 0.9, PALETTE.yellow));

  // Thick cutaway walls: full back edges + short front stubs, open front face.
  root.addChild(
    isoWall({
      x1: -76,
      y1: -6,
      x2: 0,
      y2: -65,
      h: 50,
      color: PALETTE.structure,
      rim: PALETTE.yellow,
    }),
  );
  root.addChild(
    isoWall({
      x1: 0,
      y1: -65,
      x2: 76,
      y2: -6,
      h: 50,
      color: PALETTE.structure,
      rim: PALETTE.yellow,
    }),
  );
  root.addChild(
    isoWall({
      x1: -76,
      y1: -6,
      x2: -58,
      y2: 4,
      h: 34,
      color: PALETTE.structure,
      rim: PALETTE.yellow,
    }),
  );
  root.addChild(
    isoWall({
      x1: 58,
      y1: 4,
      x2: 76,
      y2: -6,
      h: 34,
      color: PALETTE.structure,
      rim: PALETTE.yellow,
    }),
  );

  // Sentinel mast above the north wall: a taller gold-tipped silhouette
  // element marking the vault from across the campus.
  const mast = new Graphics();
  mast.rect(-77, -122, 2, 60);
  mast.fill({ color: PALETTE.structureLight });
  mast.rect(-80, -122, 8, 1.4);
  mast.fill({ color: PALETTE.yellow, alpha: 0.7 });
  mast.circle(-76, -125, 2.2);
  mast.fill({ color: PALETTE.yellow, alpha: 0.95 });
  root.addChild(mast);
  root.addChild(glow(-76, -125, 12, PALETTE.yellow, 0.3));

  // Interior pedestal with the STATIC key glyph, set into a niche on the
  // west back wall. Never animated, and never at chamber center: a parked
  // actor at the anchor must not intersect the key or the diamond frame.
  root.addChild(
    isoCylinder({
      x: -34,
      y: -30,
      r: 8,
      h: 14,
      color: PALETTE.structureLight,
      rim: PALETTE.yellow,
    }),
  );
  const niche = new Graphics();
  niche.roundRect(-49, -70, 30, 34, 4);
  niche.fill({ color: PALETTE.structure, alpha: 0.9 });
  niche.roundRect(-49, -70, 30, 34, 4);
  niche.stroke({ width: 1.2, color: PALETTE.yellow, alpha: 0.5 });
  root.addChild(niche);
  const key = new Container();
  key.position.set(-34, -52);
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
  const vaultPulse = glow(-34, -52, 44, PALETTE.yellow, 0.14);
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
  const scanBar = lightBeam(0, 34, 6, 10, 44, PALETTE.cyan, 0.16);
  root.addChild(scanBar);
  if (!ctx.reducedMotion) {
    track(gsap.to(scanBar, { x: -46, duration: 3.4, yoyo: true, repeat: -1, ease: "sine.inOut" }));
  }

  // Signing flash: vertical beam + expanding ring over the pedestal, pooled.
  const flashBeam = lightBeam(-34, -30, 10, 22, 54, PALETTE.yellow, 0);
  const flashRing = glow(-34, -30, 0, PALETTE.yellow, 0.9);
  root.addChild(flashBeam, flashRing);

  // Order capsule (pooled).
  const capsule = makeCapsule(PALETTE.waiting);
  root.addChild(capsule);

  stationSign(ctx, "signerVault", 146, PALETTE.yellow);

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
      capsule.position.set(-104, 16);
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
          .to(capsule, { x: 104, y: 12, duration: d(0.45), ease: "power1.inOut", delay: d(0.25) })
          .to(capsule, { alpha: 0, duration: d(0.2) }, "-=0.1"),
      );
      tl = vt;
    },
  };
  return api;
}

// ---------------------------------------------------------------------------
// 7. Execution gateway (guarded terminal at the exchange tunnel)
// ---------------------------------------------------------------------------

function buildExecutionGateway(ctx: DioramaContext): ExecutionGatewayApi {
  const { root } = stationBase(ctx, "executionGateway");

  contactShadow(root, 6, 14, 210, 150);
  root.addChild(propCrate(-66, 48));
  root.addChild(isoTile(0, 10, 168, 126, PALETTE.structure, 1, PALETTE.structureLight));

  // Two guard posts.
  for (const gx of [-58, 42]) {
    root.addChild(
      isoBox({ x: gx, y: -26, w: 26, d: 20, h: 30, color: PALETTE.structure, rim: PALETTE.aqua }),
    );
    root.addChild(glow(gx, -26 - 34, 16, PALETTE.cyan, 0.5));
  }

  // Conveyor strip toward the tunnel mouth (east), hugging the platform's
  // north-east diagonal. It stays east of x=58 local so it never crosses the
  // gateway operator's wander band (local x -35..55, y 10..40); the baseline
  // had connector lines slicing through the bot's head and body.
  const convY = 26;
  root.addChild(edgeStrip(58, convY - 20, 124, convY - 44, PALETTE.aqua, 0.65));
  root.addChild(edgeStrip(58, convY - 12, 124, convY - 36, PALETTE.aqua, 0.45));
  const rollers = new Graphics();
  for (let i = 0; i < 4; i++) {
    const t = (i + 0.5) / 4;
    const rx = 58 + t * 66;
    const ry = convY - 16 - t * 26;
    rollers.ellipse(rx, ry, 4, 2);
    rollers.fill({ color: PALETTE.structureLight });
  }
  root.addChild(rollers);

  // Tunnel mouth arch (leads to Hyperliquid Testnet, east).
  const mouth = arch(132, convY - 44, 62, 46, PALETTE.structure, PALETTE.aqua);
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
    x: 46,
    y: 58,
    w: 30,
    d: 20,
    h: 14,
    color: PALETTE.structure,
    rim: PALETTE.blocked,
    rimAlpha: 0.5,
  });
  root.addChild(bin);

  // Sign at the tunnel mouth, above the arch and clear of the lamp strip.
  stationSign(ctx, "executionGateway", 82, PALETTE.cyan, 2596);

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
    capsule.position.set(64, convY - 24);
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
        // Capsule assembles at the conveyor start (east side).
        capsule.visible = true;
        capsule.scale.set(0);
        gt.to(capsule.scale, { x: 1, y: 1, duration: d(0.35), ease: "back.out(2)" }).to(capsule, {
          x: 98,
          y: convY - 36,
          duration: d(0.4),
          ease: "none",
        });
      } else if (state === "submitted") {
        capsule.visible = true;
        capsule.scale.set(1);
        capsule.position.set(98, convY - 36);
        gt.to(capsule, { x: 126, y: convY - 46, duration: d(0.5), ease: "power1.in" }).to(capsule, {
          alpha: 0,
          duration: d(0.15),
        });
      } else if (state === "acknowledged") {
        // Capsule is gone; green confirmation at the tunnel mouth.
        const burst = glow(132, convY - 48, 0, PALETTE.healthy, 0.9);
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
        // clear of the operator band, then into the reject bin.
        capsule.visible = true;
        capsule.position.set(66, convY - 26);
        capsule.body.tint = PALETTE.blocked;
        gt.to(capsule, { alpha: 0.3, duration: d(0.12), yoyo: true, repeat: 3 })
          .to(capsule, { y: 44, duration: d(0.3), ease: "power1.in" })
          .to(capsule, { x: 46, y: 56, duration: d(0.25), ease: "power1.in" })
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
 * Execution. Static infrastructure-cyan chevrons mark only the west legs
 * whose primary rails are too short to stamp their own direction marks; the
 * two long diagonal legs toward the Signer Vault duplicated the primary
 * rails and read as chevrons wandering off to the perimeter (baseline
 * vision finding). One runner light walks the whole sequence. Semantic
 * colors are never used here; this is wayfinding, not state.
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
  const legsWithFloorChevrons = new Set([0, 1, 2, 3]);

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
