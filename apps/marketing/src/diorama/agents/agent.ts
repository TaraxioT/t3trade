/**
 * Agent character: expressive miniature utility robot with a digital face.
 * Owner: agent system worker.
 *
 * Anatomy (world units after the 0.72 display scale; drawn at 2x internally for
 * crispness): two short articulated legs, compact torso, oversized rounded
 * head/display (~60% of the 40-unit height), small utility arms, role-colored
 * backpack with antenna. Role color appears ONLY on backpack, antenna tip and
 * the screen trim; the body stays structural blue.
 *
 * Anchor convention: root.position is the foot center at ground level; the
 * depth sort uses root.y directly (zIndex = root.y + DEPTH.base). Everything
 * above ground is drawn at negative y inside an inner "flip" container, so
 * faceLeft can flip scale.x without touching root math.
 */
import { Container, Graphics } from "pixi.js";
import { gsap } from "gsap";
import { PALETTE, ROLE_COLORS, shade, type AgentRole } from "../config/palette.js";
import { glow } from "../core/iso.js";

export type Expression =
  | "neutral"
  | "focused"
  | "curious"
  | "excited"
  | "satisfied"
  | "worried"
  | "confused"
  | "frustrated"
  | "alarmed";

export interface Agent {
  readonly id: string;
  readonly role: AgentRole;
  readonly root: Container;
  setExpression(expr: Expression): void;
  faceLeft(left: boolean): void;
  /** Emotional body motion: hop, droop, lean, tilt. */
  react(kind: "hop" | "droop" | "lean" | "tilt"): void;
  /** Carry a small glowing data card (or null to drop it). */
  carry(cardColor: number | null): void;
}

/**
 * Extra body controls used by the population system (walk cycle, blink,
 * idle weight shifts). Not part of the frozen story-facing Agent contract.
 */
export interface AgentBody {
  /** Walk-cycle pose from accumulated path distance; moving=false resets to idle. */
  setWalkPose(phase: number, moving: boolean): void;
  /** Quick eyelid close/open via face layer scale (no Graphics redraw). */
  blink(): void;
  /** Small lateral weight shift, auto-reverting. */
  shift(): void;
  /** Revert transient react/shift offsets to the neutral idle pose. */
  restPose(): void;
  /** Kill any live GSAP tweens owned by this agent. */
  dispose(): void;
}

export type AgentImpl = Agent & AgentBody;

/**
 * Idle micro-life primitives driven by the population system (head-bob laugh,
 * foot tap, walk lean). Not part of the frozen story-facing Agent contract.
 */
export interface AgentMicroLife {
  /** Satisfied head-bob laugh with a brief "satisfied" expression. */
  laugh(): void;
  /** Quick foot tap (impatient/waiting read); self-reverting. */
  tap(): void;
  /** Lean the whole figure into a movement direction: -1 left, 0 none, 1 right. */
  setLean(dir: -1 | 0 | 1): void;
}

// ---------------------------------------------------------------------------
// Face system
// ---------------------------------------------------------------------------

interface FaceSpec {
  /** Eye silhouette; "mismatched" = wide left, narrow right. */
  eyes: "round" | "wide" | "narrow" | "flat" | "mismatched";
  /** Pupil offset from eye center (2x units). */
  pupil: { dx: number; dy: number };
  /** Pupil radius multiplier (alarmed shrinks pupils). */
  pupilScale: number;
  /** Brow tilt in radians; positive pushes inner ends down (stern). Null = no brows. */
  brow: number | null;
  /** Mouth curve, roughly -3 (frown) .. 3 (grin). */
  mouth: number;
  /** Open "surprise" mouth instead of a line. */
  mouthOpen: boolean;
}

const FACE_SPECS: Record<Expression, FaceSpec> = {
  neutral: { eyes: "round", pupil: { dx: 0, dy: 0 }, pupilScale: 1, brow: null, mouth: 0.4, mouthOpen: false },
  focused: { eyes: "narrow", pupil: { dx: 0, dy: 0.8 }, pupilScale: 1, brow: 0.35, mouth: -0.8, mouthOpen: false },
  curious: { eyes: "mismatched", pupil: { dx: 1.4, dy: 0 }, pupilScale: 1, brow: -0.2, mouth: 0, mouthOpen: false },
  excited: { eyes: "wide", pupil: { dx: 0, dy: -0.5 }, pupilScale: 1, brow: null, mouth: 3, mouthOpen: false },
  satisfied: { eyes: "round", pupil: { dx: 0, dy: -0.4 }, pupilScale: 1, brow: null, mouth: 2.2, mouthOpen: false },
  worried: { eyes: "wide", pupil: { dx: 0, dy: 1.2 }, pupilScale: 1, brow: -0.4, mouth: -1.8, mouthOpen: false },
  confused: { eyes: "mismatched", pupil: { dx: -1.4, dy: 0.6 }, pupilScale: 1, brow: -0.25, mouth: -0.6, mouthOpen: false },
  frustrated: { eyes: "narrow", pupil: { dx: 0, dy: 0 }, pupilScale: 1, brow: 0.55, mouth: -2.6, mouthOpen: false },
  alarmed: { eyes: "wide", pupil: { dx: 0, dy: 0 }, pupilScale: 0.55, brow: -0.5, mouth: 0, mouthOpen: true },
};

/** Eye center positions and sizes inside the head screen (2x units). */
const EYE_Y = -27;
const EYE_DX = 8;
const EYE_SHAPES: Record<Exclude<FaceSpec["eyes"], "mismatched">, { rx: number; ry: number }> = {
  round: { rx: 5.4, ry: 6.4 },
  wide: { rx: 6.4, ry: 7.6 },
  narrow: { rx: 5.6, ry: 3.2 },
  flat: { rx: 5.6, ry: 2.2 },
};

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/**
 * Display scale. Agents are drawn at 2x internally for crispness, then
 * scaled down here. 0.72 gives a ~48x56 world-unit footprint so characters
 * read clearly at fit zoom instead of reading as specks.
 */
const DISPLAY_SCALE = 0.72;

/** Full agent with body controls; createAgent is the frozen public wrapper. */
export function createAgentImpl(id: string, role: AgentRole): AgentImpl & AgentMicroLife {
  const roleColor = ROLE_COLORS[role];

  // root: foot center at (0,0); zIndex assigned by the system from root.y.
  const root = new Container();
  root.label = `agent:${id}`;

  // contact shadow: soft ellipse under the feet in WORLD units (outside flip
  // so mirroring never moves it) so bots sit ON the floor instead of floating.
  const contactShadow = new Graphics();
  contactShadow.ellipse(0, -1, 26, 9);
  contactShadow.fill({ color: 0x000000, alpha: 0.28 });
  root.addChild(contactShadow);

  // flip: horizontal mirror container; DISPLAY_SCALE applies the 2x crispness.
  const flip = new Container();
  flip.scale.set(DISPLAY_SCALE);
  root.addChild(flip);

  // body: everything that bobs/reacts as one rigid figure above the legs.
  const body = new Container();
  flip.addChild(body);

  // --- legs (drawn once; animated purely by rotation) ----------------------
  const makeLeg = (side: -1 | 1): Container => {
    const leg = new Container();
    leg.position.set(7 * side, -26); // hip pivot
    const g = new Graphics();
    g.roundRect(-4.5, 0, 9, 22, 4);
    g.fill({ color: PALETTE.structureLight });
    g.roundRect(-6.5, 18, 13, 8, 3); // little boot
    g.fill({ color: PALETTE.structure });
    leg.addChild(g);
    return leg;
  };
  const legL = makeLeg(-1);
  const legR = makeLeg(1);
  flip.addChild(legL, legR);

  // --- backpack + antenna (behind the torso, role colored) -----------------
  const pack = new Graphics();
  pack.roundRect(-28, -50, 11, 20, 3);
  pack.fill({ color: shade(roleColor, 0.15) }); // bright role read
  pack.roundRect(-28, -50, 11, 20, 3);
  pack.stroke({ width: 1.4, color: shade(roleColor, 0.45), alpha: 0.9 });
  // antenna rising from the backpack
  pack.moveTo(-22, -50);
  pack.lineTo(-26, -62);
  pack.stroke({ width: 1.6, color: PALETTE.structureLight });
  pack.circle(-26, -63, 3);
  pack.fill({ color: shade(roleColor, 0.3) });
  // additive beacon on the antenna tip so the role color pops at fit zoom
  const antennaGlow = glow(-26, -63, 16, roleColor, 0.5);
  body.addChild(pack, antennaGlow);

  // --- torso: darker than the head casing for silhouette contrast ----------
  const torso = new Graphics();
  torso.roundRect(-17, -54, 34, 28, 8);
  torso.fill({ color: PALETTE.structure });
  torso.roundRect(-17, -54, 34, 28, 8);
  torso.stroke({ width: 1.2, color: PALETTE.structureLight, alpha: 0.6 });
  torso.moveTo(-10, -42);
  torso.lineTo(10, -42); // panel line
  torso.stroke({ width: 1, color: PALETTE.structureLight, alpha: 0.9 });
  torso.circle(0, -34, 2.2); // chest status dot (structural, not role colored)
  torso.fill({ color: PALETTE.blue });
  body.addChild(torso);

  // --- arms (pivot at shoulder; droop/idle rotate them) ---------------------
  const makeArm = (side: -1 | 1): Container => {
    const arm = new Container();
    arm.position.set(19 * side, -50); // shoulder pivot
    const g = new Graphics();
    g.roundRect(-3.5, 0, 7, 18, 3);
    g.fill({ color: PALETTE.structureLight });
    g.circle(0, 19, 3.2); // hand
    g.fill({ color: PALETTE.surfacePale });
    arm.addChild(g);
    // Positive rotation (clockwise) swings the hanging arm toward -x, so
    // away-from-body rest is + for the left arm, - for the right.
    arm.rotation = -0.12 * side;
    return arm;
  };
  const armL = makeArm(-1);
  const armR = makeArm(1);
  body.addChild(armL, armR);

  // tiny shoulder light on the right shoulder
  const shoulderLight = new Graphics();
  shoulderLight.circle(19, -52, 2);
  shoulderLight.fill({ color: PALETTE.cyan });
  const shoulderGlow = glow(19, -52, 14, PALETTE.cyan, 0.4);
  body.addChild(shoulderGlow, shoulderLight);

  // --- head / display -------------------------------------------------------
  const head = new Container();
  head.position.set(0, -56); // bottom of the head casing
  const headG = new Graphics();
  headG.roundRect(-23, -48, 46, 48, 14);
  headG.fill({ color: shade(PALETTE.structureLight, 0.3) }); // pale casing vs dark torso
  headG.roundRect(-23, -48, 46, 48, 14);
  headG.stroke({ width: 1.6, color: PALETTE.surfacePale, alpha: 0.7 }); // pale casing trim
  headG.roundRect(-17, -40, 34, 32, 6); // dark screen inset
  headG.fill({ color: PALETTE.space });
  headG.roundRect(-17, -40, 34, 32, 6);
  headG.stroke({ width: 1.4, color: roleColor, alpha: 0.9 }); // role screen trim
  head.addChild(headG);

  // face layer: redrawn only by setExpression; blink scales it.
  const face = new Container();
  head.addChild(face);
  const faceG = new Graphics();
  face.addChild(faceG);
  body.addChild(head);

  // --- carried data card (hidden until carry()) ----------------------------
  const cardHolder = new Container();
  cardHolder.position.set(24, -44); // right hand region (2x units)
  cardHolder.visible = false;
  cardHolder.alpha = 0;
  const cardG = new Graphics();
  cardG.roundRect(-5, -7, 10, 14, 2);
  cardG.fill({ color: PALETTE.cyan });
  cardG.roundRect(-5, -7, 10, 14, 2);
  cardG.stroke({ width: 1, color: PALETTE.surfacePale, alpha: 0.9 });
  const cardGlow = glow(0, 0, 30, PALETTE.cyan, 0.7);
  cardHolder.addChild(cardGlow, cardG);
  body.addChild(cardHolder);

  // -------------------------------------------------------------------------
  // Face drawing
  // -------------------------------------------------------------------------
  const drawFace = (expr: Expression): void => {
    const spec = FACE_SPECS[expr];
    faceG.clear();
    const shapes =
      spec.eyes === "mismatched"
        ? { left: EYE_SHAPES.wide, right: EYE_SHAPES.narrow }
        : { left: EYE_SHAPES[spec.eyes], right: EYE_SHAPES[spec.eyes] };
    for (const side of [-1, 1] as const) {
      const cx = EYE_DX * side;
      const s = side === -1 ? shapes.left : shapes.right;
      faceG.ellipse(cx, EYE_Y, s.rx, s.ry);
      faceG.fill({ color: PALETTE.ink });
      faceG.circle(cx + spec.pupil.dx * side, EYE_Y + spec.pupil.dy, 2.1 * spec.pupilScale);
      faceG.fill({ color: PALETTE.space });
    }
    // brows: spec.brow > 0 tilts inner ends down (stern), < 0 inner up (worried)
    if (spec.brow !== null) {
      for (const side of [-1, 1] as const) {
        const cx = EYE_DX * side;
        const s = side === -1 ? shapes.left : shapes.right;
        const a = spec.brow * side;
        const dy = Math.sin(a) * 5;
        const dxr = Math.cos(a) * 5;
        faceG.moveTo(cx - dxr * side, EYE_Y - s.ry - 5 + dy);
        faceG.lineTo(cx + dxr * side, EYE_Y - s.ry - 5 - dy);
        faceG.stroke({ width: 2.2, color: PALETTE.ink, alpha: 0.9 });
      }
    }
    if (spec.mouthOpen) {
      faceG.ellipse(0, -14, 3.2, 3.8);
      faceG.fill({ color: PALETTE.ink });
    } else {
      faceG.moveTo(-7.5, -13);
      faceG.quadraticCurveTo(0, -13 + spec.mouth * 1.8, 7.5, -13);
      faceG.stroke({ width: 2, color: PALETTE.ink, alpha: 0.95 });
    }
  };

  let currentExpr: Expression = "neutral";
  let exprRevert: gsap.core.Tween | null = null;

  const setExpression = (expr: Expression): void => {
    currentExpr = expr;
    drawFace(expr);
  };

  /** Temporarily show an expression, then revert to the previous one. */
  const flashExpression = (expr: Expression, holdMs: number): void => {
    const prev = currentExpr;
    setExpression(expr);
    exprRevert?.kill();
    exprRevert = gsap.delayedCall(holdMs / 1000, () => {
      setExpression(prev);
      exprRevert = null;
    });
  };

  // -------------------------------------------------------------------------
  // Body controls
  // -------------------------------------------------------------------------
  const setWalkPose = (phase: number, moving: boolean): void => {
    if (!moving) {
      legL.rotation = 0;
      legR.rotation = 0;
      body.y = 0;
      return;
    }
    // Exaggerated swing + bob so the walk reads at world zoom.
    const swing = Math.sin(phase * 0.35);
    legL.rotation = swing * 0.78;
    legR.rotation = -swing * 0.78;
    body.y = -Math.abs(swing) * 4.5; // bob (2x units)
  };

  const blink = (): void => {
    gsap.fromTo(
      face.scale,
      { y: 1 },
      { y: 0.08, duration: 0.07, yoyo: true, repeat: 1, ease: "power1.inOut", overwrite: "auto" },
    );
  };

  const shift = (): void => {
    gsap.to(body, {
      x: "+=3",
      duration: 0.5,
      ease: "sine.inOut",
      yoyo: true,
      repeat: 1,
      overwrite: "auto",
    });
  };

  const react = (kind: "hop" | "droop" | "lean" | "tilt"): void => {
    switch (kind) {
      case "hop":
        gsap.to(body, {
          y: -8,
          duration: 0.18,
          ease: "power2.out",
          yoyo: true,
          repeat: 1,
          overwrite: "auto",
        });
        flashExpression("alarmed", 450);
        break;
      case "droop":
        gsap.to([armL, armR], {
          rotation: (i: number) => (i === 0 ? 0.5 : -0.5),
          duration: 0.35,
          ease: "sine.inOut",
          yoyo: true,
          repeat: 1,
          overwrite: "auto",
        });
        gsap.to(head, { y: -52, duration: 0.35, ease: "sine.inOut", yoyo: true, repeat: 1, overwrite: "auto" });
        flashExpression("worried", 600);
        break;
      case "lean":
        gsap.to(flip, {
          rotation: 0.105,
          duration: 0.3,
          ease: "sine.inOut",
          yoyo: true,
          repeat: 1,
          overwrite: "auto",
        });
        flashExpression("alarmed", 400);
        break;
      case "tilt":
        gsap.to(head, {
          rotation: 0.12,
          duration: 0.35,
          ease: "sine.inOut",
          yoyo: true,
          repeat: 1,
          overwrite: "auto",
        });
        flashExpression("curious", 600);
        break;
    }
  };

  const restPose = (): void => {
    gsap.killTweensOf([body, head, flip, armL, armR]);
    body.x = 0;
    body.y = 0;
    head.rotation = 0;
    head.y = -56;
    flip.rotation = 0;
    leanDir = 0;
    armL.rotation = 0.12;
    armR.rotation = -0.12;
    face.scale.y = 1;
    legL.rotation = 0;
    legR.rotation = 0;
  };

  // Lean: rotate the flip container ~3 deg into the movement direction.
  // When the figure is mirrored (facing left) the rotation sign flips with it,
  // so the lean always follows the on-screen direction of travel.
  let leanDir: -1 | 0 | 1 = 0;
  let facingLeft = false;
  const setLean = (dir: -1 | 0 | 1): void => {
    leanDir = dir;
    gsap.to(flip, {
      rotation: dir * 0.052 * (facingLeft ? -1 : 1),
      duration: 0.15,
      ease: "sine.out",
      overwrite: "auto",
    });
  };

  /** Satisfied micro-laugh: quick double head-bob plus a happy flash. */
  const laugh = (): void => {
    gsap.fromTo(
      head,
      { y: -56 },
      {
        y: -59.5,
        duration: 0.14,
        ease: "sine.inOut",
        yoyo: true,
        repeat: 3,
        overwrite: "auto",
      },
    );
    flashExpression("satisfied", 900);
  };

  /** Impatient/waiting foot tap: quick boot oscillation on the rear leg. */
  const tap = (): void => {
    gsap.fromTo(
      legR,
      { rotation: 0 },
      {
        rotation: -0.4,
        duration: 0.09,
        ease: "sine.inOut",
        yoyo: true,
        repeat: 5,
        overwrite: "auto",
      },
    );
  };

  const carry = (cardColor: number | null): void => {
    if (cardColor === null) {
      gsap.to(cardHolder, {
        alpha: 0,
        duration: 0.2,
        overwrite: "auto",
        onComplete: () => {
          cardHolder.visible = false;
        },
      });
      return;
    }
    cardG.tint = cardColor;
    cardGlow.tint = cardColor;
    cardHolder.visible = true;
    gsap.fromTo(
      cardHolder,
      { alpha: 0, y: -36 },
      { alpha: 1, y: -44, duration: 0.3, ease: "back.out(2)", overwrite: "auto" },
    );
  };

  const dispose = (): void => {
    exprRevert?.kill();
    gsap.killTweensOf([body, head, flip, armL, armR, legL, legR, face.scale, cardHolder]);
  };

  setExpression("neutral");

  return {
    id,
    role,
    root,
    setExpression,
    faceLeft: (left: boolean) => {
      facingLeft = left;
      flip.scale.x = left ? -DISPLAY_SCALE : DISPLAY_SCALE;
      // Reapply any live lean so it keeps pointing into the travel direction.
      if (leanDir !== 0) {
        flip.rotation = leanDir * 0.052 * (left ? -1 : 1);
      }
    },
    react,
    carry,
    setWalkPose,
    blink,
    shift,
    restPose,
    dispose,
    laugh,
    tap,
    setLean,
  };
}

/** Frozen public factory: a story-facing agent handle. */
export function createAgent(id: string, role: AgentRole): Agent {
  return createAgentImpl(id, role);
}
