/**
 * Agent character: expressive miniature utility robot with a digital face.
 * Owner: agent system worker.
 *
 * Anatomy (world units after the display scale; drawn at 2x internally for
 * crispness): two short articulated legs, compact torso, oversized rounded
 * head/display (~60% of the 40-unit height), small utility arms, role-colored
 * backpack with antenna. Role color appears ONLY on backpack, antenna tip and
 * the screen trim; the body stays structural blue.
 *
 * Individuality: every per-agent difference (height, head width, antenna and
 * backpack style, walk cadence, resting posture, reaction intensity) derives
 * deterministically from the single `variant` seed in [0,1) so the cast stays
 * one coherent species while individuals read apart at fit zoom.
 *
 * Venue themes (`theme`): a themed bot is a regular cast member wearing team
 * colors, never a new species. The theme adds ONE silhouette signature plus
 * small accents (antenna beacon, pack trim, chest emblem) in the venue's
 * brand color; proportions, the expression system, walk poses and per-variant
 * traits all stay untouched. Logos are never rasterized onto characters;
 * theming is silhouette + color language only.
 *
 * Anchor convention: root.position is the foot center at ground level; the
 * depth sort uses root.y directly (zIndex = root.y + DEPTH.base). Everything
 * above ground is drawn at negative y inside an inner "flip" container, so
 * faceLeft can flip scale.x without touching root math. A "figure" container
 * between flip and the parts carries squash-and-stretch anchored at the foot.
 */
import { Container, Graphics } from "pixi.js";
import { gsap } from "gsap";
import { PALETTE, ROLE_COLORS, shade, type AgentRole } from "../config/palette.js";
import { glow } from "../core/iso.js";
import { agentFx, type MarkKind } from "./fx.js";

/** Venue brand identity for themed cast members (silhouette + accents only). */
export type AgentTheme = "uniswap" | "hyperliquid";

/**
 * Brand colors for venue theming, shared with mascot.ts so both files draw
 * from one source. These are venue identities, not palette state colors.
 */
export const THEME_COLORS = {
  uniswap: 0xff007a, // Uniswap pink
  hyperliquid: 0x97fce4, // Hyperliquid mint
} as const;

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

export type ReactionKind =
  | "hop"
  | "droop"
  | "lean"
  | "tilt"
  | "wobble"
  | "squash"
  | "startle"
  | "headrub"
  | "apologize"
  | "doubleTake";

export interface Agent {
  readonly id: string;
  readonly role: AgentRole;
  readonly root: Container;
  setExpression(expr: Expression): void;
  faceLeft(left: boolean): void;
  /** Face sign from a world-space dx (negative = left). */
  faceToward(dx: number): void;
  /** Emotional body motion; see ReactionKind semantics in the reaction table. */
  react(kind: ReactionKind): void;
  /** Pooled comic mark above the head; see fx.ts for the glyph set. */
  popMark(kind: MarkKind): void;
  /** True while a walk is driving this agent (set by setWalkPose). */
  isMoving(): boolean;
  /** Carry a small glowing data card (or null to drop it). */
  carry(cardColor: number | null): void;
  /** Satisfied head-bob laugh; the relief beat stories end on. */
  laugh(): void;
  /** Quick impatient foot tap; self-reverting. */
  tap(): void;
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
  /** True for ~1.3 s after any react() call (activity metric). */
  isReacting(): boolean;
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
  neutral: {
    eyes: "round",
    pupil: { dx: 0, dy: 0 },
    pupilScale: 1,
    brow: null,
    mouth: 0.4,
    mouthOpen: false,
  },
  focused: {
    eyes: "narrow",
    pupil: { dx: 0, dy: 0.8 },
    pupilScale: 1,
    brow: 0.35,
    mouth: -0.8,
    mouthOpen: false,
  },
  curious: {
    eyes: "mismatched",
    pupil: { dx: 1.4, dy: 0 },
    pupilScale: 1,
    brow: -0.2,
    mouth: 0,
    mouthOpen: false,
  },
  excited: {
    eyes: "wide",
    pupil: { dx: 0, dy: -0.5 },
    pupilScale: 1,
    brow: null,
    mouth: 3,
    mouthOpen: false,
  },
  satisfied: {
    eyes: "round",
    pupil: { dx: 0, dy: -0.4 },
    pupilScale: 1,
    brow: null,
    mouth: 2.2,
    mouthOpen: false,
  },
  worried: {
    eyes: "wide",
    pupil: { dx: 0, dy: 1.2 },
    pupilScale: 1,
    brow: -0.4,
    mouth: -1.8,
    mouthOpen: false,
  },
  confused: {
    eyes: "mismatched",
    pupil: { dx: -1.4, dy: 0.6 },
    pupilScale: 1,
    brow: -0.25,
    mouth: -0.6,
    mouthOpen: false,
  },
  frustrated: {
    eyes: "narrow",
    pupil: { dx: 0, dy: 0 },
    pupilScale: 1,
    brow: 0.55,
    mouth: -2.6,
    mouthOpen: false,
  },
  alarmed: {
    eyes: "wide",
    pupil: { dx: 0, dy: 0 },
    pupilScale: 0.55,
    brow: -0.5,
    mouth: 0,
    mouthOpen: true,
  },
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
 * scaled down here. 0.88 with the per-agent variant scale (0.94..1.12) gives
 * a ~58..70 world-unit-tall read so faces and props survive fit zoom.
 */
const DISPLAY_SCALE = 0.88;

/** Deterministic variant traits from the single [0,1) seed. */
interface VariantTraits {
  /** Overall figure scale, 0.94..1.12. */
  scale: number;
  /** Head width multiplier, 0.92..1.08. */
  headWidth: number;
  antenna: "short" | "standard" | "coiled";
  backpack: "slim" | "standard" | "tank";
  /** Stride frequency multiplier, 0.85..1.2. */
  cadence: number;
  /** Resting arm splay offset added to the base angle. */
  armRest: number;
  /** Resting head tilt, about +-2 deg. */
  headTilt: number;
  /** Reaction amplitude multiplier, 0.8..1.2. */
  intensity: number;
}

function variantTraits(variant: number): VariantTraits {
  const v = Math.min(0.999, Math.max(0, variant));
  return {
    scale: 0.94 + v * 0.18,
    headWidth: 1 + (v - 0.5) * 0.16,
    antenna: v < 0.3 ? "short" : v < 0.75 ? "standard" : "coiled",
    backpack: (["slim", "standard", "tank"] as const)[Math.floor(v * 3 + 1) % 3],
    cadence: 0.85 + v * 0.35,
    armRest: (v - 0.5) * 0.1,
    headTilt: (v - 0.5) * 0.07,
    intensity: 0.8 + v * 0.4,
  };
}

/**
 * Uniswap unicorn kit: a small forward-tilted horn rising from the head's
 * top-back plus a short mane strip hugging the back rim. Pure silhouette
 * language in brand pink; drawn in head-local 2x units, above the casing
 * graphic but clear of the face screen (horn tops out at y -58.5, the screen
 * inset starts at y -40 and never reaches the back rim).
 */
function drawUnicornKit(head: Container, pink: number): void {
  const g = new Graphics();
  const edge = shade(pink, 0.45);
  // Horn cone: base seated 1 unit inside the casing top so no gap shows;
  // tip leans ~2 units forward (+x is the facing direction before mirroring).
  const baseY = -47;
  const tip = { x: -9.8, y: -58.5 };
  g.moveTo(-15.5, baseY);
  g.lineTo(-8.5, baseY);
  g.lineTo(tip.x, tip.y);
  g.closePath();
  g.fill({ color: shade(pink, 0.18) });
  g.moveTo(-15.5, baseY);
  g.lineTo(-8.5, baseY);
  g.lineTo(tip.x, tip.y);
  g.closePath();
  g.stroke({ width: 1.2, color: edge });
  // Ridge hints at 1/3 and 2/3 height so the cone reads as a horn, not a spike.
  for (const t of [0.38, 0.68] as const) {
    const lx = -15.5 + (tip.x + 15.5) * t;
    const rx = -8.5 + (tip.x + 8.5) * t;
    const yy = baseY + (tip.y - baseY) * t;
    g.moveTo(lx, yy);
    g.lineTo(rx, yy);
    g.stroke({ width: 1, color: edge, alpha: 0.75 });
  }
  // Mane: short rounded strip crossing the back rim (pokes ~1.5 units past
  // the casing edge so it reads as hair, not paint) with two lighter strands.
  // Top sits at y -42: higher would clear the casing's rounded corner and
  // float detached, since the top-left arc pulls the rim inward above that.
  g.roundRect(-24.5, -42, 5.5, 20, 3);
  g.fill({ color: shade(pink, 0.08) });
  for (const dx of [-1.4, 0.6] as const) {
    g.moveTo(-22.5 + dx, -42);
    g.quadraticCurveTo(-23.5 + dx, -33, -22.5 + dx, -24);
    g.stroke({ width: 1, color: edge, alpha: 0.8 });
  }
  head.addChild(g);
}

/**
 * Hyperliquid chest emblem: the venue blob as two small joined circles (the
 * overlapping fill reads as one body; the stroked loops plus a center seam
 * pinch the bridge). Replaces the structural chest dot for themed bots.
 */
function drawBlobEmblem(g: Graphics, cx: number, cy: number, mint: number): void {
  const r = 3.2;
  const dx = 2.7;
  const edge = shade(mint, -0.35);
  for (const side of [-1, 1] as const) {
    g.circle(cx + dx * side, cy, r);
    g.fill({ color: mint });
    g.circle(cx + dx * side, cy, r);
    g.stroke({ width: 1, color: edge, alpha: 0.85 });
  }
  // Pinch seam at the waist where the two loops join.
  g.moveTo(cx, cy - r * 0.5);
  g.lineTo(cx, cy + r * 0.5);
  g.stroke({ width: 1.2, color: edge, alpha: 0.9 });
}

/** Full agent with body controls; createAgent is the frozen public wrapper. */
export function createAgentImpl(
  id: string,
  role: AgentRole,
  variant = 0.5,
  reducedMotion = false,
  theme?: AgentTheme,
): AgentImpl & AgentMicroLife {
  const roleColor = ROLE_COLORS[role];
  // Theme accent color: recolors the antenna beacon and adds one pack accent;
  // null for unthemed bots so role color stays the only accent.
  const themeColor =
    theme === "uniswap"
      ? THEME_COLORS.uniswap
      : theme === "hyperliquid"
        ? THEME_COLORS.hyperliquid
        : null;
  const tr = variantTraits(variant);
  const flipScale = DISPLAY_SCALE * tr.scale;
  const it = tr.intensity;
  // World-unit height of the head top (2x units ~ -112 including antenna).
  const markOffsetY = 116 * flipScale;

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
  flip.scale.set(flipScale);
  root.addChild(flip);

  // figure: squash-and-stretch wrapper anchored at the foot (children are all
  // at negative y, so scaling about y=0 keeps the feet planted).
  const figure = new Container();
  flip.addChild(figure);

  // body: everything that bobs/reacts as one rigid figure above the legs.
  const body = new Container();
  figure.addChild(body);

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
  figure.addChild(legL, legR);

  // --- backpack + antenna (behind the torso, role colored) -----------------
  const pack = new Graphics();
  const packX = tr.backpack === "slim" ? -27 : tr.backpack === "tank" ? -30 : -28;
  const packW = tr.backpack === "slim" ? 7 : tr.backpack === "tank" ? 14 : 11;
  const packY = tr.backpack === "tank" ? -52 : -50;
  const packH = tr.backpack === "tank" ? 24 : 20;
  pack.roundRect(packX, packY, packW, packH, tr.backpack === "tank" ? 6 : 3);
  pack.fill({ color: shade(roleColor, 0.15) }); // bright role read
  pack.roundRect(packX, packY, packW, packH, tr.backpack === "tank" ? 6 : 3);
  pack.stroke({ width: 1.4, color: shade(roleColor, 0.45), alpha: 0.9 });
  if (tr.backpack === "tank") {
    // tank band so the chunky variant still reads as one species
    pack.moveTo(packX + 3, packY + 8);
    pack.lineTo(packX + packW - 3, packY + 8);
    pack.stroke({ width: 1, color: shade(roleColor, 0.45), alpha: 0.7 });
  }
  if (theme === "uniswap") {
    // Team stripe across the pack; the role color keeps the body so the bot
    // still reads as its role first, venue second.
    pack.roundRect(packX + 1.5, packY + 3.5, packW - 3, 4, 2);
    pack.fill({ color: shade(THEME_COLORS.uniswap, 0.05) });
  }
  if (theme === "hyperliquid") {
    // Subtle teal tint along the pack's back edge (edge trim, not a repaint).
    pack.moveTo(packX, packY + 2);
    pack.lineTo(packX, packY + packH - 2);
    pack.stroke({ width: 2, color: shade(THEME_COLORS.hyperliquid, -0.12), alpha: 0.65 });
  }
  // antenna rising from the backpack; style varies per variant
  const tip = { x: 0, y: 0 };
  if (tr.antenna === "short") {
    pack.moveTo(packX + 5, packY);
    pack.lineTo(packX + 3, packY - 6);
    pack.stroke({ width: 1.6, color: PALETTE.structureLight });
    tip.x = packX + 3;
    tip.y = packY - 7;
  } else if (tr.antenna === "coiled") {
    pack.moveTo(packX + 5, packY);
    // small zigzag reads as a coiled whip antenna
    for (const [zx, zy] of [
      [packX - 1, packY - 3],
      [packX + 4, packY - 6],
      [packX - 1, packY - 9],
      [packX + 3, packY - 12],
    ] as const) {
      pack.lineTo(zx, zy);
    }
    pack.stroke({ width: 1.4, color: PALETTE.structureLight });
    tip.x = packX + 3;
    tip.y = packY - 13;
  } else {
    pack.moveTo(packX + 6, packY);
    pack.lineTo(packX + 2, packY - 12);
    pack.stroke({ width: 1.6, color: PALETTE.structureLight });
    tip.x = packX + 2;
    tip.y = packY - 13;
  }
  pack.circle(tip.x, tip.y, tr.antenna === "short" ? 2.5 : 3);
  pack.fill({ color: themeColor ? shade(themeColor, 0.25) : shade(roleColor, 0.3) });
  // additive beacon on the antenna tip so the accent pops at fit zoom
  // (theme color for venue bots, role color otherwise)
  const antennaGlow = glow(tip.x, tip.y, 16, themeColor ?? roleColor, 0.5);
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
  if (theme === "hyperliquid") {
    // venue chest emblem replaces the structural dot for themed bots
    drawBlobEmblem(torso, 0, -34, THEME_COLORS.hyperliquid);
  } else {
    torso.circle(0, -34, 2.2); // chest status dot (structural, not role colored)
    torso.fill({ color: PALETTE.blue });
  }
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
    arm.rotation = (0.12 + tr.armRest) * -side;
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
  head.scale.x = tr.headWidth; // variant head width, persistent
  head.rotation = tr.headTilt; // variant resting tilt, persistent
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
  if (theme === "uniswap") drawUnicornKit(head, THEME_COLORS.uniswap);

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
    if (!alive()) return;
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
  // Body state
  // -------------------------------------------------------------------------
  let movingFlag = false;
  let reacting = false;
  let reactTimer: gsap.core.Tween | null = null;
  let rmTimer: gsap.core.Tween | null = null;

  const markReacting = (): void => {
    reacting = true;
    reactTimer?.kill();
    reactTimer = gsap.delayedCall(1.3, () => {
      reacting = false;
    });
  };

  const setWalkPose = (phase: number, moving: boolean): void => {
    movingFlag = moving;
    if (!moving) {
      legL.rotation = 0;
      legR.rotation = 0;
      body.y = 0;
      return;
    }
    // Exaggerated swing + bob so the walk reads at world zoom; the variant
    // cadence multiplier makes strides individually paced.
    const p = phase * tr.cadence;
    const swing = Math.sin(p * 0.35);
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

  // -------------------------------------------------------------------------
  // Reactions
  // -------------------------------------------------------------------------
  // Reduced motion: every reaction collapses to a brief static pose that
  // restPose() clears after <=0.4 s; no oscillation, no marks in motion.
  const rmPose = (apply: () => void): void => {
    apply();
    rmTimer?.kill();
    rmTimer = gsap.delayedCall(0.35, () => restPose());
  };

  const react = (kind: ReactionKind): void => {
    if (!alive()) return;
    markReacting();
    if (reducedMotion) {
      switch (kind) {
        case "hop":
        case "startle":
          rmPose(() => {
            body.y = -4;
            flashExpression("alarmed", 350);
          });
          break;
        case "droop":
        case "apologize":
          rmPose(() => {
            head.y = -52;
            flashExpression("worried", 350);
          });
          break;
        case "lean":
        case "wobble":
        case "squash":
          rmPose(() => {
            figure.scale.y = 0.92;
          });
          break;
        case "tilt":
        case "doubleTake":
          rmPose(() => {
            head.rotation = tr.headTilt + 0.14;
            flashExpression("curious", 350);
          });
          break;
        case "headrub":
          rmPose(() => {
            armR.rotation = -2.4;
            flashExpression("worried", 350);
          });
          break;
      }
      if (kind === "startle") popMarkImpl("!");
      return;
    }

    switch (kind) {
      case "hop": {
        // anticipation dip, jump, land squash with elastic recovery
        const tl = gsap.timeline();
        tl.to(body, { y: 2, duration: 0.06, ease: "sine.in" });
        tl.to(body, { y: -16 * it, duration: 0.16, ease: "power2.out" });
        tl.to(body, { y: 0, duration: 0.18, ease: "power2.in" });
        tl.to(figure.scale, { y: 0.86, x: 1.12, duration: 0.09, ease: "power2.out" }, "<");
        tl.to(figure.scale, { y: 1, x: 1, duration: 0.45, ease: "elastic.out(1.6, 0.45)" });
        flashExpression("alarmed", 450);
        break;
      }
      case "droop": {
        gsap.to([armL, armR], {
          rotation: (i: number) => (i === 0 ? 0.5 : -0.5) * it,
          duration: 0.3,
          ease: "power2.in",
          overwrite: "auto",
        });
        gsap.to(head, { y: -51, duration: 0.3, ease: "power2.in", overwrite: "auto" });
        gsap.to(head, {
          y: -56,
          duration: 0.7,
          delay: 0.55,
          ease: "elastic.out(1, 0.5)",
          overwrite: false,
        });
        flashExpression("worried", 650);
        break;
      }
      case "lean": {
        gsap.to(flip, {
          rotation: 0.11 * it,
          duration: 0.18,
          ease: "power2.out",
          overwrite: "auto",
        });
        gsap.to(flip, {
          rotation: 0,
          duration: 0.5,
          delay: 0.3,
          ease: "elastic.out(1, 0.45)",
          overwrite: false,
        });
        flashExpression("alarmed", 400);
        break;
      }
      case "tilt": {
        gsap.to(head, {
          rotation: tr.headTilt + 0.14 * it,
          duration: 0.2,
          ease: "back.out(2.5)",
          overwrite: "auto",
        });
        gsap.to(head, {
          rotation: tr.headTilt,
          duration: 0.4,
          delay: 0.55,
          ease: "sine.inOut",
          overwrite: false,
        });
        flashExpression("curious", 600);
        break;
      }
      case "wobble": {
        // body vibration: fast lateral oscillation for ~0.5 s
        gsap.fromTo(
          body,
          { x: 0 },
          {
            x: 2.2 * it,
            duration: 0.08,
            ease: "sine.inOut",
            yoyo: true,
            repeat: 6,
            overwrite: "auto",
          },
        );
        flashExpression("confused", 550);
        break;
      }
      case "squash": {
        // squash-and-stretch landing: scaleY dip + scaleX rise, elastic recover
        gsap.to(figure.scale, {
          y: 0.8,
          x: 1.16,
          duration: 0.09,
          ease: "power2.out",
          overwrite: "auto",
        });
        gsap.to(figure.scale, {
          y: 1.06,
          x: 0.96,
          duration: 0.16,
          delay: 0.09,
          ease: "sine.out",
          overwrite: false,
        });
        gsap.to(figure.scale, {
          y: 1,
          x: 1,
          duration: 0.5,
          delay: 0.25,
          ease: "elastic.out(2.2, 0.4)",
          overwrite: false,
        });
        break;
      }
      case "startle": {
        // alarm jump-back with an alarmed face and a brief "!" flash
        const back = facingLeft ? 7 : -7;
        gsap.to(flip, { x: back * it, duration: 0.14, ease: "power3.out", overwrite: "auto" });
        gsap.to(flip, {
          x: 0,
          duration: 0.5,
          delay: 0.3,
          ease: "elastic.out(1, 0.5)",
          overwrite: false,
        });
        gsap.to(body, { y: -7 * it, duration: 0.12, ease: "power2.out", overwrite: "auto" });
        gsap.to(body, { y: 0, duration: 0.3, delay: 0.14, ease: "power2.in", overwrite: false });
        flashExpression("alarmed", 550);
        popMarkImpl("!");
        break;
      }
      case "headrub": {
        // arm rises to the head casing, small circular rub, embarrassed glance
        const tl = gsap.timeline();
        tl.to(armR, { rotation: -2.45, duration: 0.2, ease: "back.out(2)" });
        tl.to(armR, { rotation: -2.32, duration: 0.11, ease: "sine.inOut", yoyo: true, repeat: 3 });
        tl.to(armR, { rotation: -0.12 - tr.armRest, duration: 0.35, ease: "sine.inOut" });
        tl.to(head, { rotation: tr.headTilt + 0.08, duration: 0.2, ease: "sine.inOut" }, 0);
        tl.to(head, { rotation: tr.headTilt, duration: 0.3 }, ">-0.1");
        flashExpression("worried", 1100);
        break;
      }
      case "apologize": {
        // bow forward, one arm out, guilty eyes
        const tl = gsap.timeline();
        tl.to(body, { rotation: 0.3 * it, y: 3, duration: 0.22, ease: "power2.inOut" });
        tl.to(armL, { rotation: 0.95, duration: 0.2, ease: "power2.out" }, "<");
        tl.to(body, { rotation: 0, y: 0, duration: 0.5, delay: 0.45, ease: "elastic.out(1, 0.5)" });
        tl.to(
          armL,
          { rotation: 0.12 + tr.armRest, duration: 0.4, delay: 0.35, ease: "sine.inOut" },
          "<",
        );
        flashExpression("worried", 1000);
        break;
      }
      case "doubleTake": {
        // head snap-turn, pause, snap back
        const dir = facingLeft ? -1 : 1;
        const tl = gsap.timeline();
        tl.to(head, { rotation: tr.headTilt + dir * 0.5, duration: 0.07, ease: "power3.in" });
        tl.to(head, { rotation: tr.headTilt + dir * 0.34, duration: 0.06, ease: "power2.out" });
        tl.to(head, { rotation: tr.headTilt + dir * 0.34, duration: 0.32, ease: "none" });
        tl.to(head, { rotation: tr.headTilt, duration: 0.09, ease: "back.out(2.5)" });
        flashExpression("curious", 600);
        break;
      }
    }
  };

  const popMarkImpl = (kind: MarkKind): void => {
    agentFx.current?.popMarkAt(root.x, root.y - markOffsetY, kind);
  };

  const restPose = (): void => {
    gsap.killTweensOf([body, head, flip, figure.scale, armL, armR]);
    body.x = 0;
    body.y = 0;
    body.rotation = 0;
    head.rotation = tr.headTilt;
    head.y = -56;
    flip.rotation = 0;
    flip.x = 0;
    figure.scale.set(1);
    leanDir = 0;
    armL.rotation = 0.12 + tr.armRest;
    armR.rotation = -0.12 - tr.armRest;
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
    if (!alive()) return;
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
    if (!alive()) return;
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
    if (!alive()) return;
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

  // Set by dispose(): story continuations can resume a beat after teardown
  // (pending walk promises resolve during cleanup), and every public method
  // they might still call must no-op instead of tweening destroyed objects.
  let agentDisposed = false;

  const alive = (): boolean => !agentDisposed && !root.destroyed;

  const dispose = (): void => {
    agentDisposed = true;
    exprRevert?.kill();
    reactTimer?.kill();
    rmTimer?.kill();
    gsap.killTweensOf([
      body,
      head,
      flip,
      figure.scale,
      armL,
      armR,
      legL,
      legR,
      face.scale,
      cardHolder,
    ]);
  };

  setExpression("neutral");

  return {
    id,
    role,
    root,
    setExpression,
    faceLeft: (left: boolean) => {
      facingLeft = left;
      flip.scale.x = left ? -flipScale : flipScale;
      // Reapply any live lean so it keeps pointing into the travel direction.
      if (leanDir !== 0) {
        flip.rotation = leanDir * 0.052 * (left ? -1 : 1);
      }
    },
    faceToward: (dx: number) => {
      if (dx !== 0) flip.scale.x = dx < 0 ? -flipScale : flipScale;
      facingLeft = dx < 0;
    },
    react,
    popMark: popMarkImpl,
    isMoving: () => movingFlag,
    carry,
    setWalkPose,
    blink,
    shift,
    restPose,
    isReacting: () => reacting,
    dispose,
    laugh,
    tap,
    setLean,
  };
}

/** Frozen public factory: a story-facing agent handle. */
export function createAgent(id: string, role: AgentRole, variant = 0.5): Agent {
  return createAgentImpl(id, role, variant);
}
