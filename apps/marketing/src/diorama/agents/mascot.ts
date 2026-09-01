/**
 * Duo mascot: a cheerful unicorn-bot herald for the venue pad on the central
 * floor. Uniswap side = pink horn + mane; Hyperliquid side = mint-to-teal
 * gradient cape + scarf. One character carries both venue languages while the
 * body stays structural blue, so it reads as the same species as the agent
 * cast, just a ~1.6x herald standing on the pad pedestal.
 * Owner: mascot/theming worker.
 *
 * Anchor convention matches agent.ts: root.position is the pad anchor on the
 * floor; the pedestal top sits ~6 world units above it, so the contact shadow
 * and the whole figure are lifted to y = -6 inside root. zIndex carries a
 * small forward bias (+3) so the mascot sorts above the pedestal it stands
 * on while ring bots south of it still pass in front.
 *
 * Motion is fully tween-driven (GSAP timelines, no per-frame redraw loops).
 * Idle life = wave loop + bob + cape sway + blink; under reduced motion the
 * mascot holds one static friendly pose. celebrate()/wave() are
 * interrupt-safe: each kills any live animation, resets to the base pose and
 * restarts cleanly, and every public path guards the destroyed state.
 */
import { Container, FillGradient, Graphics } from "pixi.js";
import { gsap } from "gsap";
import type { DioramaContext } from "../core/context.js";
import { PALETTE, shade } from "../config/palette.js";
import { glow } from "../core/iso.js";
import { DEPTH } from "../config/world.js";
import { THEME_COLORS } from "./agent.js";
import { agentFx } from "./fx.js";

export interface MascotApi {
  /** Bounded ~2.7 s hop-and-wave burst with sparkle marks; restarts cleanly. */
  celebrate(): void;
  /** One full friendly wave cycle. */
  wave(): void;
}

/** Live mascot instance holder (set by main.ts, read by stories); null
 * before build and after teardown, the same pattern as the world holders. */
export const mascot: { api: MascotApi | null } = { api: null };

/** Herald scale: 1.6x a standard bot, drawn in the same 2x idiom as agent.ts. */
const MASCOT_SCALE = 0.88 * 1.6;
/** Pedestal top height above the pad anchor (world units). */
const PEDESTAL_TOP = 6;
/** Forward depth bias so the mascot sorts above its own pedestal. */
const DEPTH_BIAS = 3;
/** Comic-mark origin above the root: clears the horn tip at 2x y -119. */
const MARK_OFFSET = 128 * MASCOT_SCALE;

type MascotExpression = "happy" | "excited";

export function buildMascot(ctx: DioramaContext, at: { x: number; y: number }): MascotApi {
  const pink = THEME_COLORS.uniswap;
  const mint = THEME_COLORS.hyperliquid;
  const teal = shade(mint, -0.4);

  const root = new Container();
  root.label = "mascot";
  root.position.set(at.x, at.y);
  root.zIndex = at.y + DEPTH.base + DEPTH_BIAS;

  // Contact shadow on the pedestal top, in world units outside the flip so
  // nothing that mirrors or scales inside can move it.
  const shadow = new Graphics();
  shadow.ellipse(0, -PEDESTAL_TOP, 32, 9);
  shadow.fill({ color: 0x000000, alpha: 0.3 });
  root.addChild(shadow);

  // flip carries the 1.6x display scale; the figure inside holds
  // squash-and-stretch anchored at the feet (children at negative y).
  const flip = new Container();
  flip.scale.set(MASCOT_SCALE);
  flip.position.set(0, -PEDESTAL_TOP);
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

  // --- cape (behind everything): mint -> teal gradient, sways from the neck -
  const capePivot = new Container();
  capePivot.position.set(0, -52);
  const cape = new Graphics();
  const capeGradient = new FillGradient({
    type: "linear",
    start: { x: 0.5, y: 0 },
    end: { x: 0.5, y: 1 },
    colorStops: [
      { offset: 0, color: mint },
      { offset: 1, color: teal },
    ],
    textureSpace: "local",
  });
  // Herald cape: narrow at the shoulders, flaring to a swallowtail hem.
  cape.poly([-14, 0, 14, 0, 19, 34, 7, 28, 0, 36, -7, 28, -19, 34]);
  cape.fill(capeGradient);
  cape.poly([-14, 0, 14, 0, 19, 34, 7, 28, 0, 36, -7, 28, -19, 34]);
  cape.stroke({ width: 1.2, color: mint, alpha: 0.55 });
  capePivot.addChild(cape);
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

  // Duo chest emblem: the unicorn loop in pink joined to the blob loop in
  // mint, pinched at the waist. One mark, both venues.
  for (const [side, color] of [
    [-1, pink],
    [1, mint],
  ] as const) {
    torso.circle(2.8 * side, -34, 3.4);
    torso.fill({ color });
  }
  torso.circle(-2.8, -34, 3.4);
  torso.stroke({ width: 1, color: shade(pink, 0.45), alpha: 0.85 });
  torso.circle(2.8, -34, 3.4);
  torso.stroke({ width: 1, color: shade(mint, -0.35), alpha: 0.85 });
  torso.moveTo(0, -35.6);
  torso.lineTo(0, -32.4);
  torso.stroke({ width: 1.2, color: shade(mint, -0.35), alpha: 0.9 });

  // --- scarf: mint neck band with a short tail over the chest ---------------
  const scarf = new Graphics();
  scarf.roundRect(-13, -59, 26, 7, 3.5);
  scarf.fill({ color: mint });
  scarf.roundRect(7, -53, 6, 13, 3);
  scarf.fill({ color: shade(mint, -0.12) });
  body.addChild(scarf);

  // --- arms (agent idiom; the right arm is the waving arm) -------------------
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

  // --- head / display (agent idiom; screen trim in scarf mint) --------------
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
  headG.stroke({ width: 1.4, color: mint, alpha: 0.9 });
  head.addChild(headG);

  // Herald horn: taller than the agent-theme horn, seated on the forehead
  // top, leaning forward. Pink silhouette language, one soft glow at the tip.
  const horn = new Graphics();
  const hornEdge = shade(pink, 0.45);
  const hornTip = { x: 7.5, y: -63 };
  horn.moveTo(-2, -47);
  horn.lineTo(12, -47);
  horn.lineTo(hornTip.x, hornTip.y);
  horn.closePath();
  horn.fill({ color: shade(pink, 0.18) });
  horn.moveTo(-2, -47);
  horn.lineTo(12, -47);
  horn.lineTo(hornTip.x, hornTip.y);
  horn.closePath();
  horn.stroke({ width: 1.4, color: hornEdge });
  for (const t of [0.35, 0.6, 0.8] as const) {
    const lx = -2 + (hornTip.x + 2) * t;
    const rx = 12 + (hornTip.x - 12) * t;
    const yy = -47 + (hornTip.y + 47) * t;
    horn.moveTo(lx, yy);
    horn.lineTo(rx, yy);
    horn.stroke({ width: 1, color: hornEdge, alpha: 0.75 });
  }
  head.addChild(horn);
  head.addChild(glow(hornTip.x, hornTip.y, 26, pink, 0.42));

  // Mane: a longer herald strip along the back rim, three strands. Kept
  // between y -40 and -10 where the casing rim is straight/nearly so the
  // strip stays attached (the rounded corners pull the rim inward past that).
  const mane = new Graphics();
  mane.roundRect(-25.5, -40, 6, 30, 3);
  mane.fill({ color: shade(pink, 0.08) });
  for (const dx of [-2, 0, 2] as const) {
    mane.moveTo(-23.5 + dx, -38);
    mane.quadraticCurveTo(-24.5 + dx, -26, -23.5 + dx, -12);
    mane.stroke({ width: 1, color: hornEdge, alpha: 0.8 });
  }
  head.addChild(mane);

  // face layer: redrawn only by drawFace; blink scales it (agent idiom).
  const face = new Container();
  head.addChild(face);
  const faceG = new Graphics();
  face.addChild(faceG);
  body.addChild(head);

  const drawFace = (expr: MascotExpression): void => {
    faceG.clear();
    const excited = expr === "excited";
    const { rx, ry } = excited ? { rx: 6.4, ry: 7.6 } : { rx: 5.4, ry: 6.4 };
    for (const side of [-1, 1] as const) {
      const cx = 8 * side;
      faceG.ellipse(cx, -27, rx, ry);
      faceG.fill({ color: PALETTE.ink });
      faceG.circle(cx, -27 - 0.4, 2.1);
      faceG.fill({ color: PALETTE.space });
    }
    if (excited) {
      faceG.ellipse(0, -14, 3.4, 4);
      faceG.fill({ color: PALETTE.ink });
    } else {
      faceG.moveTo(-8, -13);
      faceG.quadraticCurveTo(0, -8.8, 8, -13);
      faceG.stroke({ width: 2.2, color: PALETTE.ink, alpha: 0.95 });
    }
  };

  // -------------------------------------------------------------------------
  // Motion
  // -------------------------------------------------------------------------
  let disposed = false;
  const alive = (): boolean => !disposed && !root.destroyed;

  /** Resting wave-arm angle; reduced motion holds a friendlier half-raise. */
  const restArmR = ctx.reducedMotion ? -1.05 : -0.12;

  let waveLoop: gsap.core.Timeline | null = null;
  let bobTween: gsap.core.Tween | null = null;
  let capeTween: gsap.core.Tween | null = null;
  let blinkLoop: gsap.core.Timeline | null = null;
  // The active celebrate/wave animation; a re-trigger kills and restarts it.
  let burstAnim: gsap.core.Timeline | gsap.core.Tween | null = null;

  const sparkle = (): void => {
    agentFx.current?.popMarkAt(root.x, root.y - MARK_OFFSET, "stars");
  };

  /** Revert every animated offset to the neutral herald pose. */
  const basePose = (): void => {
    body.x = 0;
    body.y = 0;
    body.rotation = 0;
    figure.scale.set(1);
    armL.rotation = 0.12;
    armR.rotation = restArmR;
    capePivot.rotation = 0;
    face.scale.y = 1;
  };

  const killIdle = (): void => {
    waveLoop?.kill();
    bobTween?.kill();
    capeTween?.kill();
    waveLoop = null;
    bobTween = null;
    capeTween = null;
  };

  const startIdle = (): void => {
    if (!alive() || ctx.reducedMotion) return;
    killIdle();
    // Friendly wave loop: raise, three oscillations, lower, rest (~6 s cycle).
    waveLoop = gsap.timeline({ repeat: -1, repeatDelay: 3.2 });
    waveLoop.to(armR, { rotation: -2.1, duration: 0.45, ease: "back.out(1.6)" });
    waveLoop.to(armR, {
      rotation: -1.72,
      duration: 0.42,
      ease: "sine.inOut",
      yoyo: true,
      repeat: 3,
    });
    waveLoop.to(armR, { rotation: restArmR, duration: 0.5, ease: "sine.inOut" });
    bobTween = gsap.to(body, {
      y: -3.5,
      duration: 1.8,
      ease: "sine.inOut",
      yoyo: true,
      repeat: -1,
    });
    capeTween = gsap.to(capePivot, {
      rotation: 0.055,
      duration: 2.6,
      ease: "sine.inOut",
      yoyo: true,
      repeat: -1,
    });
  };

  /** Interrupt-safe preamble shared by celebrate() and wave(). */
  const beginAct = (): boolean => {
    if (!alive()) return false;
    burstAnim?.kill();
    burstAnim = null;
    killIdle();
    basePose();
    return true;
  };

  const celebrate = (): void => {
    if (!beginAct()) return;
    if (ctx.reducedMotion) {
      // Single expression brighten + one static mark; no hops, no oscillation.
      drawFace("excited");
      sparkle();
      burstAnim = gsap.delayedCall(0.9, () => {
        burstAnim = null;
        if (alive()) drawFace("happy");
      });
      return;
    }
    const tl = gsap.timeline({
      onComplete: () => {
        burstAnim = null;
        if (alive()) drawFace("happy");
        startIdle();
      },
    });
    tl.call(() => drawFace("excited"));
    // Hop 1: anticipation dip, jump, land squash with elastic recovery.
    tl.to(body, { y: 3, duration: 0.08, ease: "sine.in" });
    tl.to(body, { y: -22, duration: 0.2, ease: "power2.out" });
    tl.call(sparkle, undefined, "<0.1");
    tl.to(body, { y: 0, duration: 0.2, ease: "power2.in" });
    tl.to(figure.scale, { y: 0.87, x: 1.1, duration: 0.08, ease: "power2.out" }, "<");
    tl.to(figure.scale, { y: 1, x: 1, duration: 0.4, ease: "elastic.out(1.6, 0.45)" });
    // Fast wave through the recovery beat.
    tl.to(armR, { rotation: -2.2, duration: 0.22, ease: "back.out(2)" }, "<-0.05");
    tl.to(armR, { rotation: -1.8, duration: 0.3, ease: "sine.inOut", yoyo: true, repeat: 2 }, "<");
    tl.to(armR, { rotation: restArmR, duration: 0.3, ease: "sine.inOut" });
    // Hop 2: smaller echo hop so the burst reads as a double beat.
    tl.to(body, { y: 2, duration: 0.07, ease: "sine.in" });
    tl.to(body, { y: -16, duration: 0.18, ease: "power2.out" });
    tl.call(sparkle);
    tl.to(body, { y: 0, duration: 0.18, ease: "power2.in" });
    tl.to(figure.scale, { y: 0.9, x: 1.07, duration: 0.07, ease: "power2.out" }, "<");
    tl.to(figure.scale, { y: 1, x: 1, duration: 0.4, ease: "elastic.out(1.8, 0.4)" });
    tl.to(armR, { rotation: restArmR, duration: 0.3, ease: "sine.inOut" }, "<");
    burstAnim = tl;
  };

  const wave = (): void => {
    if (!beginAct()) return;
    if (ctx.reducedMotion) {
      // Static raised-arm pose with a brief hold; self-reverting.
      armR.rotation = -1.9;
      burstAnim = gsap.delayedCall(0.9, () => {
        burstAnim = null;
        if (alive()) armR.rotation = restArmR;
      });
      return;
    }
    const tl = gsap.timeline({
      onComplete: () => {
        burstAnim = null;
        startIdle();
      },
    });
    tl.to(armR, { rotation: -2.15, duration: 0.4, ease: "back.out(1.7)" });
    tl.to(armR, { rotation: -1.75, duration: 0.38, ease: "sine.inOut", yoyo: true, repeat: 3 });
    tl.to(armR, { rotation: restArmR, duration: 0.45, ease: "sine.inOut" });
    burstAnim = tl;
  };

  // --- assemble and start ---------------------------------------------------
  drawFace("happy");
  ctx.layers.sortable.addChild(root);

  if (ctx.reducedMotion) {
    // Static friendly pose: arm half-raised in greeting, no loops at all.
    armR.rotation = restArmR;
  } else {
    startIdle();
    // Blink cadence independent of bursts so the face never freezes.
    blinkLoop = gsap.timeline({ repeat: -1, repeatDelay: 3.6 });
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
    burstAnim?.kill();
    killIdle();
    blinkLoop?.kill();
    gsap.killTweensOf([body, figure.scale, armL, armR, capePivot, face.scale, legL, legR]);
    root.destroy({ children: true });
  });

  return { celebrate, wave };
}
