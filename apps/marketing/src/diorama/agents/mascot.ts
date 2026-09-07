/**
 * West threshold mascot: a dignified unicorn-bot herald parked beside the
 * former research-only door as an easter egg (freeze cycle-4 §6). The
 * character keeps the cast anatomy (structural blue body, CRT face, cyan
 * shoulder light) but reads as the room's emblem, not entertainment: a
 * slender silver-blue horn with one soft mint glow at the tip, a short swept
 * crest in deep structural blue, and a single tailored deep-teal mantle with
 * a thin restrained pink hem trim (the only pink on the figure). Accents are
 * strokes and deep tones; nothing glows neon.
 * Owner: agent-system (life) worker.
 *
 * The herald is NOT a flow actor: it never moves on its own and there is no
 * fill celebration. Its whole social repertoire is one quiet `wave()`, which
 * main.ts triggers through `setFocused(true)` when the mascot's area gains
 * focus (once per focus; focus-out re-arms it). Between waves it holds a
 * statue pose with slow bob + mantle sway + rare blink ambience, all
 * disabled under reduced motion (one static composed pose).
 *
 * Anchor: MASCOT_ANCHOR is exported for main.ts (Bootstrap lane) so the
 * build call and the collision reasoning stay in one file. It sits on the
 * research floor beside the removed researchOnlyGate threshold — outside
 * every station footprint diamond (see the comment on the constant).
 *
 * Anchor convention matches agent.ts: root.position is the foot center at
 * ground level; the contact shadow sits at the feet. Motion is fully
 * tween-driven (GSAP timelines, no per-frame redraw loops) and deliberately
 * slow. Every public path guards the destroyed state and restarts cleanly.
 */
import { Container, FillGradient, Graphics } from "pixi.js";
import { gsap } from "gsap";
import type { DioramaContext } from "../core/context.js";
import { PALETTE, shade } from "../config/palette.js";
import { glow } from "../core/iso.js";
import { DEPTH } from "../config/world.js";

export interface MascotApi {
  /** One slow regal raise-and-tilt greeting; restarts cleanly. */
  wave(): void;
  /** Wave once on focus-in (rising edge); focus-out re-arms the greeting. */
  setFocused(focused: boolean): void;
}

/** Live mascot instance holder (set by main.ts, read by stories); null
 * before build and after teardown, the same pattern as the world holders. */
export const mascot: { api: MascotApi | null } = { api: null };

/**
 * West threshold anchor for buildMascot: beside the former researchOnlyGate
 * door (old anchor (540,635), w130×d110), 62 u to its south-east so the
 * point is outside even the removed gate's footprint diamond (sum 1.21) and
 * clear of every other west footprint in the current stations layout
 * (marketData 3.59, missionBoard 4.15, decisionTable 2.30 in
 * |dx|/(w/2)+|dy|/(d/2) units). It passes insideRoom(595,655) with ~99 u of
 * wall margin and lies in the research section polygon; the floor polygon's
 * minimum x is 1120, so it can never be a center-section point. At 55 %
 * scale the figure's contact shadow is ~25 u wide, inside every margin.
 */
export const MASCOT_ANCHOR: { x: number; y: number } = { x: 595, y: 655 };

/** Herald scale: 55% of the cycle-3 floor-herald size (0.88 * 1.6 * 0.55),
 * drawn in the same 2x idiom as agent.ts. */
const MASCOT_SCALE = 0.88 * 1.6 * 0.55;
/** Pale silver-blue from the world's pale-surface family (horn material). */
const SILVER_BLUE = 0xcfe7f2;

/**
 * Self-contained herald palette, frozen as literals (retained duo
 * character; declared exception to the cycle's de-branding)
 * colors were retired. Values are exactly the former derived ones:
 * mint 0x97fce4 shaded -0.42 / -0.55 / -0.60 for the mantle, and the former
 * brand pink 0xff007a shaded -0.28 for the single hem trim.
 */
const MINT = 0x97fce4;
/** Deep teal mantle tones: formal wear, not a cape. */
const MANTLE_SHOULDER = 0x589284;
const MANTLE_HEM = 0x3c655b;
const MANTLE_STROKE = 0x447167;
/** The single restrained pink accent on the whole figure. */
const HEM_TRIM = 0xb80058;

/** Point on a quadratic bezier at t; used for the horn's ridge hints. */
function quadPoint(
  p0: { x: number; y: number },
  c: { x: number; y: number },
  p1: { x: number; y: number },
  t: number,
): { x: number; y: number } {
  const u = 1 - t;
  return {
    x: u * u * p0.x + 2 * u * t * c.x + t * t * p1.x,
    y: u * u * p0.y + 2 * u * t * c.y + t * t * p1.y,
  };
}

type MascotExpression = "happy" | "excited";

export function buildMascot(ctx: DioramaContext, at: { x: number; y: number }): MascotApi {
  const root = new Container();
  root.label = "mascot";
  root.position.set(at.x, at.y);
  root.zIndex = at.y + DEPTH.base;

  // Contact shadow at the feet, in world units outside the flip so nothing
  // that mirrors or scales inside can move it.
  const shadow = new Graphics();
  shadow.ellipse(0, -1, 32 * MASCOT_SCALE, 9 * MASCOT_SCALE);
  shadow.fill({ color: 0x000000, alpha: 0.3 });
  root.addChild(shadow);

  // flip carries the display scale; the figure inside holds squash-and-
  // stretch anchored at the feet (children at negative y).
  const flip = new Container();
  flip.scale.set(MASCOT_SCALE);
  root.addChild(flip);

  const figure = new Container();
  flip.addChild(figure);

  const body = new Container();
  figure.addChild(body);

  // --- legs (agent idiom: pivot at the hip, pose purely by rotation) --------
  const makeLeg = (side: -1 | 1): Container => {
    const leg = new Container();
    leg.position.set(7 * side, -26);
    const g = new Graphics();
    g.roundRect(-4.5, 0, 9, 22, 4);
    g.fill({ color: PALETTE.structureLight });
    g.roundRect(-6.5, 18, 13, 8, 3);
    g.fill({ color: PALETTE.structure });
    leg.addChild(g);
    return leg;
  };
  const legL = makeLeg(-1);
  const legR = makeLeg(1);
  figure.addChild(legL, legR);

  // --- mantle (behind everything): deep teal, rounded shoulders, gentle arc
  // hem. Tailored formal drape that sways once slowly; never a flapping cape.
  const capePivot = new Container();
  capePivot.position.set(0, -52);
  const mantle = new Graphics();
  const mantleGradient = new FillGradient({
    type: "linear",
    start: { x: 0.5, y: 0 },
    end: { x: 0.5, y: 1 },
    colorStops: [
      { offset: 0, color: MANTLE_SHOULDER },
      { offset: 1, color: MANTLE_HEM },
    ],
    textureSpace: "local",
  });
  const drawMantlePath = (): void => {
    mantle.moveTo(-15, 0);
    mantle.quadraticCurveTo(-20, 2, -20.5, 10);
    mantle.quadraticCurveTo(-21, 22, -16, 30);
    mantle.quadraticCurveTo(0, 34.5, 16, 30);
    mantle.quadraticCurveTo(21, 22, 20.5, 10);
    mantle.quadraticCurveTo(20, 2, 15, 0);
    mantle.closePath();
  };
  drawMantlePath();
  mantle.fill(mantleGradient);
  drawMantlePath();
  mantle.stroke({ width: 1, color: MANTLE_STROKE, alpha: 0.6 });
  // Hem trim: the single restrained pink accent on the whole figure.
  mantle.moveTo(-16, 30);
  mantle.quadraticCurveTo(0, 34.5, 16, 30);
  mantle.stroke({ width: 1.1, color: HEM_TRIM, alpha: 0.8 });
  capePivot.addChild(mantle);
  body.addChild(capePivot);

  // --- torso (agent idiom) ---------------------------------------------------
  const torso = new Graphics();
  torso.roundRect(-17, -54, 34, 28, 8);
  torso.fill({ color: PALETTE.structure });
  torso.roundRect(-17, -54, 34, 28, 8);
  torso.stroke({ width: 1.2, color: PALETTE.structureLight, alpha: 0.6 });
  torso.moveTo(-10, -42);
  torso.lineTo(10, -42);
  torso.stroke({ width: 1, color: PALETTE.structureLight, alpha: 0.9 });
  body.addChild(torso);

  // Duo chest emblem, restrained: the herald's joined loops as two thin mint
  // outlines with a pinch seam. No fills, no glow.
  for (const side of [-1, 1] as const) {
    torso.circle(2.9 * side, -34, 3.6);
    torso.stroke({ width: 1, color: MINT, alpha: 0.8 });
  }
  torso.moveTo(0, -35.6);
  torso.lineTo(0, -32.4);
  torso.stroke({ width: 1, color: MINT, alpha: 0.55 });
  // Mantle clasp on the collar: the mantle itself drapes behind the torso,
  // so its closure point is drawn in front, at the neck, in silver-blue.
  torso.circle(0, -51.5, 1.8);
  torso.fill({ color: SILVER_BLUE });
  torso.circle(0, -51.5, 1.8);
  torso.stroke({ width: 0.8, color: shade(SILVER_BLUE, -0.4), alpha: 0.8 });

  // --- arms (agent idiom; the right arm is the greeting arm) -----------------
  const makeArm = (side: -1 | 1): Container => {
    const arm = new Container();
    arm.position.set(19 * side, -50);
    const g = new Graphics();
    g.roundRect(-3.5, 0, 7, 18, 3);
    g.fill({ color: PALETTE.structureLight });
    g.circle(0, 19, 3.2);
    g.fill({ color: PALETTE.surfacePale });
    arm.addChild(g);
    arm.rotation = 0.12 * -side;
    return arm;
  };
  const armL = makeArm(-1);
  const armR = makeArm(1);
  body.addChild(armL, armR);

  // shoulder light: species trait kept from the agent cast (structural cyan)
  const shoulderLight = new Graphics();
  shoulderLight.circle(19, -52, 2);
  shoulderLight.fill({ color: PALETTE.cyan });
  const shoulderGlow = glow(19, -52, 14, PALETTE.cyan, 0.4);
  body.addChild(shoulderGlow, shoulderLight);

  // --- head / display (agent idiom; screen trim in mint) ---------------------
  const head = new Container();
  head.position.set(0, -56);
  const headG = new Graphics();
  headG.roundRect(-23, -48, 46, 48, 14);
  headG.fill({ color: shade(PALETTE.structureLight, 0.3) });
  headG.roundRect(-23, -48, 46, 48, 14);
  headG.stroke({ width: 1.6, color: PALETTE.surfacePale, alpha: 0.7 });
  headG.roundRect(-17, -40, 34, 32, 6);
  headG.fill({ color: PALETTE.space });
  headG.roundRect(-17, -40, 34, 32, 6);
  headG.stroke({ width: 1.2, color: MINT, alpha: 0.75 });
  head.addChild(headG);

  // Herald horn: slender, gently curved, sweeping slightly back. Pale
  // silver-blue like the world's pale surfaces, one soft mint glow at the
  // tip. Deliberately not a party-hat cone: longer than wide, no brights.
  const horn = new Graphics();
  const hornEdge = shade(SILVER_BLUE, -0.38);
  const hornBaseFront = { x: 9, y: -46.5 };
  const hornBaseBack = { x: 1, y: -46.5 };
  const hornTip = { x: -2.5, y: -66 };
  const hornFrontCtrl = { x: 8.2, y: -57.5 };
  const hornBackCtrl = { x: -1.8, y: -56 };
  const drawHornPath = (): void => {
    horn.moveTo(hornBaseFront.x, hornBaseFront.y);
    horn.quadraticCurveTo(hornFrontCtrl.x, hornFrontCtrl.y, hornTip.x, hornTip.y);
    horn.quadraticCurveTo(hornBackCtrl.x, hornBackCtrl.y, hornBaseBack.x, hornBaseBack.y);
    horn.closePath();
  };
  drawHornPath();
  horn.fill({ color: SILVER_BLUE });
  drawHornPath();
  horn.stroke({ width: 1.1, color: hornEdge });
  // Two subtle ridge hints so the curve reads as a polished horn, not a spike.
  for (const t of [0.35, 0.65] as const) {
    const f = quadPoint(hornBaseFront, hornFrontCtrl, hornTip, t);
    const b = quadPoint(hornBaseBack, hornBackCtrl, hornTip, t);
    horn.moveTo(f.x, f.y);
    horn.lineTo(b.x, b.y);
    horn.stroke({ width: 0.9, color: hornEdge, alpha: 0.5 });
  }
  head.addChild(horn);
  head.addChild(glow(hornTip.x, hornTip.y, 9, MINT, 0.3));

  // Crest: a short swept crest along the head's top-back in deep structural
  // blue with a single mint streak. Reads as sculpted headgear, not hair.
  // The base hugs the rim (~1.5 units inside the casing top, past the point
  // where the rounded corner starts pulling the rim inward).
  const crest = new Graphics();
  const drawCrestPath = (): void => {
    crest.moveTo(-3, -46.5);
    crest.quadraticCurveTo(-9, -56.5, -20, -58.5);
    crest.quadraticCurveTo(-15, -53, -16.5, -46);
    crest.closePath();
  };
  drawCrestPath();
  crest.fill({ color: PALETTE.structureLight });
  drawCrestPath();
  crest.stroke({ width: 1, color: shade(PALETTE.structureLight, 0.3), alpha: 0.7 });
  crest.moveTo(-5, -47.5);
  crest.quadraticCurveTo(-9, -55, -17.5, -57);
  crest.stroke({ width: 1.2, color: MINT, alpha: 0.75 });
  crest.moveTo(-4.2, -47);
  crest.quadraticCurveTo(-7.5, -53.5, -14.5, -55);
  crest.stroke({ width: 1, color: shade(PALETTE.structureLight, 0.25), alpha: 0.6 });
  head.addChild(crest);

  // face layer: redrawn only by drawFace; blink scales it (agent idiom).
  const face = new Container();
  head.addChild(face);
  const faceG = new Graphics();
  face.addChild(faceG);
  body.addChild(head);

  const drawFace = (expr: MascotExpression): void => {
    faceG.clear();
    const excited = expr === "excited";
    const { rx, ry } = excited ? { rx: 6, ry: 7 } : { rx: 5.2, ry: 6.1 };
    for (const side of [-1, 1] as const) {
      const cx = 8 * side;
      faceG.ellipse(cx, -27, rx, ry);
      faceG.fill({ color: PALETTE.ink });
      faceG.circle(cx, -27 - 0.4, 2.1);
      faceG.fill({ color: PALETTE.space });
    }
    // Calm, slightly smiling by default; a touch more curve when excited.
    faceG.moveTo(-8, -13);
    faceG.quadraticCurveTo(0, excited ? -9.4 : -10.4, 8, -13);
    faceG.stroke({ width: 2, color: PALETTE.ink, alpha: 0.95 });
  };

  // -------------------------------------------------------------------------
  // Motion
  // -------------------------------------------------------------------------
  let disposed = false;
  const alive = (): boolean => !disposed && !root.destroyed;

  /** Resting greeting-arm angle; reduced motion holds a composed half-raise. */
  const restArmR = ctx.reducedMotion ? -0.6 : -0.12;

  let bobTween: gsap.core.Tween | null = null;
  let capeTween: gsap.core.Tween | null = null;
  let blinkLoop: gsap.core.Timeline | null = null;
  // The active wave animation; a re-trigger kills and restarts it.
  let waveAnim: gsap.core.Timeline | gsap.core.Tween | null = null;

  /** Revert every animated offset to the neutral herald pose. */
  const basePose = (): void => {
    body.x = 0;
    body.y = 0;
    body.rotation = 0;
    figure.scale.set(1);
    head.rotation = 0;
    armL.rotation = 0.12;
    armR.rotation = restArmR;
    capePivot.rotation = 0;
    face.scale.y = 1;
  };

  const killAmbience = (): void => {
    bobTween?.kill();
    capeTween?.kill();
    bobTween = null;
    capeTween = null;
  };

  /** Statue ambience between greetings: slow bob + mantle sway. Never a wave. */
  const startAmbience = (): void => {
    if (!alive() || ctx.reducedMotion) return;
    killAmbience();
    bobTween = gsap.to(body, {
      y: -2.2,
      duration: 2.8,
      ease: "sine.inOut",
      yoyo: true,
      repeat: -1,
    });
    capeTween = gsap.to(capePivot, {
      rotation: 0.035,
      duration: 3.6,
      ease: "sine.inOut",
      yoyo: true,
      repeat: -1,
    });
  };

  const wave = (): void => {
    if (!alive()) return;
    waveAnim?.kill();
    waveAnim = null;
    killAmbience();
    basePose();
    if (ctx.reducedMotion) {
      // Static raised-arm pose with a brief hold; self-reverting.
      armR.rotation = -1.6;
      waveAnim = gsap.delayedCall(0.9, () => {
        waveAnim = null;
        if (alive()) armR.rotation = restArmR;
      });
      return;
    }
    const tl = gsap.timeline({
      onComplete: () => {
        waveAnim = null;
        startAmbience();
      },
    });
    // One regal greeting: slow raise with a slight head tilt, one gentle
    // sway, slow lower.
    tl.to(armR, { rotation: -1.9, duration: 0.85, ease: "sine.inOut" });
    tl.to(head, { rotation: 0.07, duration: 0.85, ease: "sine.inOut" }, 0);
    tl.to(armR, { rotation: -1.66, duration: 1.2, ease: "sine.inOut" });
    tl.to(armR, { rotation: -1.9, duration: 1.2, ease: "sine.inOut" });
    tl.to(armR, { rotation: restArmR, duration: 1, ease: "sine.inOut" });
    tl.to(head, { rotation: 0, duration: 1, ease: "sine.inOut" }, "<");
    waveAnim = tl;
  };

  // Focus edge tracking: at most one wave per focus, re-armed on focus-out.
  let focused = false;
  const setFocused = (next: boolean): void => {
    const wasFocused = focused;
    focused = next;
    if (next && !wasFocused) wave();
  };

  // --- assemble and start ---------------------------------------------------
  drawFace("happy");
  ctx.layers.sortable.addChild(root);

  if (ctx.reducedMotion) {
    // Static composed pose: arm in a calm half-raise, no loops at all.
    armR.rotation = restArmR;
  } else {
    startAmbience();
    // Blink cadence independent of waves so the face never freezes; rare
    // enough to preserve the statue read.
    blinkLoop = gsap.timeline({ repeat: -1, repeatDelay: 4.6 });
    blinkLoop.to(face.scale, {
      y: 0.08,
      duration: 0.07,
      yoyo: true,
      repeat: 1,
      ease: "power1.inOut",
    });
  }

  ctx.onCleanup(() => {
    disposed = true;
    waveAnim?.kill();
    killAmbience();
    blinkLoop?.kill();
    gsap.killTweensOf([body, figure.scale, head, armL, armR, capePivot, face.scale, legL, legR]);
    root.destroy({ children: true });
  });

  return { wave, setFocused };
}
