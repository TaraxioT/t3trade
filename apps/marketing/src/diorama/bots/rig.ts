/**
 * Procedural bot rig v2 (08-design-direction-v2.md Decision 3).
 *
 * Per bot: one merged vertex-colored hull mesh (body capsule painted with
 * the caller's zone-blend color, boots/brim in slateFrame, hat dome in the
 * role tint, optional role accessory merged in), one eye GROUP holding six
 * prebuilt eye-pair shapes sharing eyeMint (exactly one visible at a time —
 * setExpression toggles visibility, no allocation), two articulated arm
 * meshes, a blob-shadow disc, a non-rendering headFx anchor above the hat,
 * and the carry/leftHand/rightHand sockets.
 *
 * Convention: the rig root sits at the bot's GROUND point. The director
 * sets root.position to the floor position and root.rotation.y to facing.
 * The `body` group (child at y = height/2) is the pose target motion.ts
 * writes bob/lean/squash into. The blob shadow stays at local y ~ 0.
 *
 * Target: < 700 triangles per bot, 5 draw calls per bot
 * (hull, one visible eye shape, armL, armR, blob).
 */

import * as THREE from "three";
import { DIMENSIONS, PALETTE, roleHatColor } from "../config";
import { capsule, disc, mergeParts, paint, pipeAlong, roundedBox } from "../geometry";
import type { MaterialLibrary } from "../render/materials";
import type { Expression, Role } from "../types";

const BOT = DIMENSIONS.bot;

/** Shared, role-independent proportions (unscaled units, bot height 2). */
const RIG = {
  bodyRadius: BOT.bodyRadius,
  bodyLength: 0.75,
  bodyCenterY: BOT.height / 2 - 0.05, // 0.95
  bootW: 0.42,
  bootH: 0.28,
  bootD: 0.6,
  bootX: 0.28,
  hatRadius: BOT.hatRadius,
  hatY: 1.86,
  brimRadius: 0.64,
  goggleW: 0.72,
  goggleH: 0.22,
  goggleD: 0.18,
  goggleY: 1.45,
  armRadius: 0.14,
  armLength: BOT.armLength,
  shoulderX: 0.62,
  shoulderY: 1.42,
  blobRadius: 0.75,
  carryY: 0.35,
  carryZ: 0.55,
  // v2 eyes: 1.7x the v1 marks (Decision 3.1).
  eyeScale: 1.7,
  eyeRadius: 0.075,
  eyeX: 0.16,
  eyeY: 1.45,
  eyeZ: 0.62,
  headFxY: 2.35,
} as const;

const EYE_R = RIG.eyeRadius * RIG.eyeScale; // ~0.13
const EYE_X = RIG.eyeX * RIG.eyeScale; // ~0.27

/** Static role accessories merged into the hull (zero extra draw calls). */
export type AccessoryId =
  | "clipboard"
  | "wrench"
  | "tablet"
  | "pencil"
  | "crown"
  | "ledgerPlate"
  | "tagClip";

export interface BotRigOptions {
  /** Hull body color (fleet passes the zone blend); defaults to cream. */
  readonly bodyColor?: string;
  /** Static accessory merged into the hull. */
  readonly accessory?: AccessoryId;
}

export interface BotRig {
  /** Ground-point root; the director owns world position and yaw. */
  readonly root: THREE.Group;
  /** Pose target (bob, lean, squash pivot); child of root at bodyBaseY. */
  readonly body: THREE.Group;
  /** Articulated arm meshes; geometry pivots at the shoulder. */
  readonly armL: THREE.Mesh;
  readonly armR: THREE.Mesh;
  /** Eye group: six prebuilt shapes, exactly one visible at a time. */
  readonly eyes: THREE.Group;
  /** Non-rendering anchor above the hat for glyph riding. */
  readonly headFx: THREE.Object3D;
  readonly sockets: {
    readonly carry: THREE.Object3D;
    readonly leftHand: THREE.Object3D;
    readonly rightHand: THREE.Object3D;
  };
  readonly blob: THREE.Mesh;
  /** Uniform scale the fleet built the rig at (squash multiplies it). */
  readonly baseScale: number;
  readonly bodyBaseY: number;
  /** Toggle the visible eye shape; visibility-only, no allocation. */
  setExpression(expr: Expression): void;
}

/**
 * Geometry shared across every rig. Hulls are keyed by
 * role|bodyColor|accessory because tints are baked into vertex colors at
 * merge time; eye shapes and arms are shared by all bots. The hull map is
 * lazily populated through hullFor() so the cache only builds combinations
 * the roster actually uses.
 */
export interface BotGeometryCache {
  readonly hulls: ReadonlyMap<string, THREE.BufferGeometry>;
  readonly eyeShapes: Readonly<Record<Expression, THREE.BufferGeometry>>;
  readonly arm: THREE.BufferGeometry;
  readonly blob: THREE.BufferGeometry;
}

// ---------------------------------------------------------------------------
// Eye-shape geometry (mint marks on the face plane; all share eyeMint)
// ---------------------------------------------------------------------------

/** One paint color for every eye shape; only the mint reads through eyeMint. */
const EYE_PAINT = PALETTE.mintBright;

function buildEyeShapes(): Record<Expression, THREE.BufferGeometry> {
  const r = EYE_R;
  const x = EYE_X;

  // Neutral: the v1 dot pair, scaled up.
  const neutral = mergeParts([
    paint(capsule(r * 0.58, 0.02, 6, 2).translate(x, RIG.eyeY, RIG.eyeZ), EYE_PAINT),
    paint(capsule(r * 0.58, 0.02, 6, 2).translate(-x, RIG.eyeY, RIG.eyeZ), EYE_PAINT),
  ]);

  // Happy arcs ^ ^: inverted-V pipes per eye.
  const arc = (cx: number): THREE.BufferGeometry =>
    pipeAlong(
      [
        { x: cx - r, y: RIG.eyeY - r * 0.45, z: RIG.eyeZ },
        { x: cx, y: RIG.eyeY + r * 0.55, z: RIG.eyeZ },
        { x: cx + r, y: RIG.eyeY - r * 0.45, z: RIG.eyeZ },
      ],
      r * 0.28,
      6,
    );
  const happy = mergeParts([paint(arc(x), EYE_PAINT), paint(arc(-x), EYE_PAINT)]);

  // Bored dashes - -: short horizontal capsules.
  const dash = (cx: number): THREE.BufferGeometry =>
    capsule(r * 0.28, r * 1.15, 6, 2)
      .rotateZ(Math.PI / 2)
      .translate(cx, RIG.eyeY, RIG.eyeZ);
  const bored = mergeParts([paint(dash(x), EYE_PAINT), paint(dash(-x), EYE_PAINT)]);

  // Angry slants \ /: mirrored tilts (inner ends down).
  const slant = (cx: number, dir: number): THREE.BufferGeometry =>
    capsule(r * 0.3, r * 1.7, 6, 2)
      .rotateZ(dir * (Math.PI / 2 - 0.55))
      .translate(cx, RIG.eyeY + r * 0.15, RIG.eyeZ);
  const angry = mergeParts([paint(slant(-x, 1), EYE_PAINT), paint(slant(x, -1), EYE_PAINT)]);

  // Panic X X: crossed capsule pairs per eye.
  const stroke = (cx: number, rot: number): THREE.BufferGeometry =>
    capsule(r * 0.26, r * 1.9, 6, 2)
      .rotateZ(rot)
      .translate(cx, RIG.eyeY, RIG.eyeZ);
  const panic = mergeParts([
    paint(stroke(x, Math.PI / 4), EYE_PAINT),
    paint(stroke(x, -Math.PI / 4), EYE_PAINT),
    paint(stroke(-x, Math.PI / 4), EYE_PAINT),
    paint(stroke(-x, -Math.PI / 4), EYE_PAINT),
  ]);

  // Surprised O O: small pipe rings.
  const ring = (cx: number): THREE.BufferGeometry => {
    const pts: { x: number; y: number; z: number }[] = [];
    for (let i = 0; i < 8; i += 1) {
      const a = (i / 8) * Math.PI * 2;
      pts.push({ x: cx + Math.cos(a) * r * 0.7, y: RIG.eyeY + Math.sin(a) * r * 0.7, z: RIG.eyeZ });
    }
    pts.push(pts[0] as { x: number; y: number; z: number });
    return pipeAlong(pts, r * 0.24, 6);
  };
  const surprised = mergeParts([paint(ring(x), EYE_PAINT), paint(ring(-x), EYE_PAINT)]);

  return { neutral, happy, bored, angry, panic, surprised };
}

// ---------------------------------------------------------------------------
// Hull (body + boots + hat + brim + goggle frame + optional accessory)
// ---------------------------------------------------------------------------

function accessoryPart(id: AccessoryId): THREE.BufferGeometry {
  switch (id) {
    // Clipboard plate held at the chest front (foreman).
    case "clipboard":
      return paint(
        roundedBox(0.34, 0.46, 0.05, 0.02).translate(0, 1.0, RIG.bodyRadius + 0.05),
        PALETTE.cream,
      );
    // Wrench laid diagonally across the chest (gunner).
    case "wrench":
      return paint(
        capsule(0.055, 0.5, 6, 2)
          .rotateZ(0.7)
          .translate(0.12, 1.05, RIG.bodyRadius + 0.05),
        PALETTE.slate,
      );
    // Tablet flat against the chest (researchers).
    case "tablet":
      return paint(
        roundedBox(0.4, 0.3, 0.06, 0.02).translate(0, 1.05, RIG.bodyRadius + 0.06),
        PALETTE.slate,
      );
    // Giant pencil tucked by the hat (intern).
    case "pencil":
      return paint(
        capsule(0.05, 0.55, 6, 2).rotateZ(-0.35).translate(-0.42, 1.75, -0.1),
        PALETTE.caramelLight,
      );
    // Crown: three small studs on the hat dome (overseer).
    case "crown":
      return mergeParts([
        paint(capsule(0.07, 0.02, 5, 1).translate(-0.18, RIG.hatY + 0.5, 0), PALETTE.brass),
        paint(capsule(0.07, 0.02, 5, 1).translate(0, RIG.hatY + 0.58, 0), PALETTE.brass),
        paint(capsule(0.07, 0.02, 5, 1).translate(0.18, RIG.hatY + 0.5, 0), PALETTE.brass),
      ]);
    // Ledger plate (accountants): slim open-book slab in front.
    case "ledgerPlate":
      return paint(
        roundedBox(0.5, 0.08, 0.34, 0.02).translate(0, 0.95, RIG.bodyRadius + 0.2),
        PALETTE.cream,
      );
    // Tag clip (guards): small plate on the chest side.
    case "tagClip":
      return paint(
        roundedBox(0.16, 0.22, 0.04, 0.015).translate(0.24, 1.15, RIG.bodyRadius + 0.04),
        PALETTE.brass,
      );
  }
}

function buildHull(role: Role, options: BotRigOptions): THREE.BufferGeometry {
  const bodyColor = options.bodyColor ?? PALETTE.cream;
  const parts: THREE.BufferGeometry[] = [
    paint(
      capsule(RIG.bodyRadius, RIG.bodyLength, 10, 4).translate(0, RIG.bodyCenterY, 0),
      bodyColor,
    ),
    // Boots + brim stay slateFrame (v2 framing; Decision 3.3/3.4).
    paint(
      roundedBox(RIG.bootW, RIG.bootH, RIG.bootD, 0.08).translate(RIG.bootX, RIG.bootH / 2, 0.1),
      PALETTE.slateFrame,
    ),
    paint(
      roundedBox(RIG.bootW, RIG.bootH, RIG.bootD, 0.08).translate(-RIG.bootX, RIG.bootH / 2, 0.1),
      PALETTE.slateFrame,
    ),
    // Hat dome keeps the role tint.
    paint(capsule(RIG.hatRadius, 0.06, 10, 3).translate(0, RIG.hatY, 0), roleHatColor(role)),
    // disc() already faces +Y; no extra rotation needed.
    paint(disc(RIG.brimRadius, 20).translate(0, RIG.hatY - 0.08, 0.1), PALETTE.slateFrame),
    paint(
      roundedBox(RIG.goggleW, RIG.goggleH, RIG.goggleD, 0.06).translate(
        0,
        RIG.goggleY,
        RIG.bodyRadius - RIG.goggleD / 2 + 0.04,
      ),
      PALETTE.slate,
    ),
  ];
  if (options.accessory) parts.push(accessoryPart(options.accessory));
  return mergeParts(parts);
}

/** Arm capsule pre-translated so the mesh origin is the shoulder pivot. */
function buildArm(): THREE.BufferGeometry {
  return paint(
    capsule(RIG.armRadius, RIG.armLength - 2 * RIG.armRadius, 8, 3).translate(
      0,
      -RIG.armLength / 2,
      0,
    ),
    PALETTE.cream,
  );
}

function buildBlob(): THREE.BufferGeometry {
  // disc() already faces +Y; the blob shader only reads its UVs.
  return disc(RIG.blobRadius, 22);
}

const EXPRESSIONS: readonly Expression[] = [
  "neutral",
  "happy",
  "bored",
  "angry",
  "panic",
  "surprised",
];

export function createBotGeometryCache(): BotGeometryCache {
  return {
    hulls: new Map<string, THREE.BufferGeometry>(),
    eyeShapes: buildEyeShapes(),
    arm: buildArm(),
    blob: buildBlob(),
  };
}

function hullFor(
  cache: BotGeometryCache,
  role: Role,
  options: BotRigOptions,
): THREE.BufferGeometry {
  const key = `${role}|${options.bodyColor ?? "-"}|${options.accessory ?? "-"}`;
  let hull = cache.hulls.get(key);
  if (!hull) {
    hull = buildHull(role, options);
    (cache.hulls as Map<string, THREE.BufferGeometry>).set(key, hull);
  }
  return hull;
}

/**
 * Build one bot rig. Pass a shared cache from the fleet so geometry is
 * created once per role/color/accessory combination, not once per bot.
 * Tints are baked into vertex colors; materials are shared library ones.
 */
export function buildBotRig(
  mats: MaterialLibrary,
  role: Role,
  scale = 1,
  cache: BotGeometryCache = createBotGeometryCache(),
  options: BotRigOptions = {},
): BotRig {
  const root = new THREE.Group();
  root.name = "bot";
  root.scale.setScalar(scale);

  const body = new THREE.Group();
  body.name = "botBody";
  body.position.y = BOT.height / 2;
  root.add(body);

  const hull = new THREE.Mesh(hullFor(cache, role, options), mats.matteVertex);
  hull.name = "hull";
  body.add(hull);

  // Eye group: every prebuilt shape added, exactly one visible.
  const eyes = new THREE.Group();
  eyes.name = "eyes";
  const eyeMeshes = new Map<Expression, THREE.Mesh>();
  for (const expr of EXPRESSIONS) {
    const mesh = new THREE.Mesh(cache.eyeShapes[expr], mats.eyeMint);
    mesh.name = `eyes-${expr}`;
    mesh.visible = expr === "neutral";
    eyes.add(mesh);
    eyeMeshes.set(expr, mesh);
  }
  body.add(eyes);

  // Head FX anchor above the hat for glyph riding (non-rendering).
  const headFx = new THREE.Object3D();
  headFx.name = "headFx";
  headFx.position.set(0, RIG.headFxY - BOT.height / 2, 0);
  body.add(headFx);

  const armL = new THREE.Mesh(cache.arm, mats.matteVertex);
  armL.name = "armL";
  armL.position.set(RIG.shoulderX, RIG.shoulderY - BOT.height / 2, 0);
  body.add(armL);

  const armR = new THREE.Mesh(cache.arm, mats.matteVertex);
  armR.name = "armR";
  armR.position.set(-RIG.shoulderX, RIG.shoulderY - BOT.height / 2, 0);
  body.add(armR);

  // Sockets: carry at chest-front, hands at arm ends (arm posing moves them).
  const carry = new THREE.Object3D();
  carry.name = "carry";
  carry.position.set(0, RIG.carryY - BOT.height / 2, RIG.carryZ);
  body.add(carry);

  const leftHand = new THREE.Object3D();
  leftHand.name = "leftHand";
  leftHand.position.set(0, -RIG.armLength, 0);
  armL.add(leftHand);

  const rightHand = new THREE.Object3D();
  rightHand.name = "rightHand";
  rightHand.position.set(0, -RIG.armLength, 0);
  armR.add(rightHand);

  // Blob shadow: stays at ground level (local y ~ 0) under the root.
  const blob = new THREE.Mesh(cache.blob, mats.blobShadow);
  blob.name = "blob";
  blob.position.y = 0.04;
  root.add(blob);

  let current: Expression = "neutral";

  return {
    root,
    body,
    armL,
    armR,
    eyes,
    headFx,
    sockets: { carry, leftHand, rightHand },
    blob,
    baseScale: scale,
    bodyBaseY: BOT.height / 2,
    setExpression(expr: Expression): void {
      if (expr === current) return;
      const next = eyeMeshes.get(expr);
      if (!next) return;
      (eyeMeshes.get(current) as THREE.Mesh).visible = false;
      next.visible = true;
      current = expr;
    },
  };
}
