/**
 * Procedural bot rig (plan section 7): one merged vertex-colored hull mesh
 * (body capsule + boots + hard hat + goggle frame, hat tint baked per role),
 * one merged glowing eye pair, two articulated arm meshes, a blob-shadow
 * disc, and non-rendering attachment sockets.
 *
 * Convention: the rig root sits at the bot's GROUND point. The director sets
 * root.position to the floor position and root.rotation.y to facing. The
 * `body` group (child at y = height/2) is the pose target motion.ts writes
 * bob/lean/squash into, so director-owned translation and motion-owned pose
 * never collide. The blob shadow stays at local y ~ 0, i.e. ground level,
 * regardless of pose.
 *
 * Target: < 700 triangles per bot across hull + eyes + arms + blob, and
 * 5 draw calls per bot (hull, eyes, armL, armR, blob).
 */

import * as THREE from "three";
import { DIMENSIONS, PALETTE, roleHatColor } from "../config";
import { capsule, disc, mergeParts, paint, roundedBox } from "../geometry";
import type { MaterialLibrary } from "../render/materials";
import type { Role } from "../types";

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
  eyeRadius: 0.075,
  eyeX: 0.16,
  eyeY: 1.45,
  eyeZ: 0.62,
  armRadius: 0.14,
  armLength: BOT.armLength,
  shoulderX: 0.62,
  shoulderY: 1.42,
  blobRadius: 0.75,
  carryY: 0.35,
  carryZ: 0.55,
} as const;

export interface BotRig {
  /** Ground-point root; the director owns world position and yaw. */
  readonly root: THREE.Group;
  /** Pose target (bob, lean, squash pivot); child of root at bodyBaseY. */
  readonly body: THREE.Group;
  /** Articulated arm meshes; geometry pivots at the shoulder. */
  readonly armL: THREE.Mesh;
  readonly armR: THREE.Mesh;
  /** Merged glowing eye pair; motion may offset position.x for eye darts. */
  readonly eyes: THREE.Mesh;
  readonly sockets: {
    readonly carry: THREE.Object3D;
    readonly leftHand: THREE.Object3D;
    readonly rightHand: THREE.Object3D;
  };
  readonly blob: THREE.Mesh;
  /** Uniform scale the fleet built the rig at (squash multiplies it). */
  readonly baseScale: number;
  readonly bodyBaseY: number;
}

/**
 * Geometry shared across every rig. Hulls are keyed by role because the hat
 * tint is baked into vertex colors at merge time; everything else is shared
 * by all bots.
 */
export interface BotGeometryCache {
  readonly hulls: ReadonlyMap<Role, THREE.BufferGeometry>;
  readonly eyes: THREE.BufferGeometry;
  readonly arm: THREE.BufferGeometry;
  readonly blob: THREE.BufferGeometry;
}

function buildHull(role: Role): THREE.BufferGeometry {
  const hat = roleHatColor(role);
  const parts: THREE.BufferGeometry[] = [
    // Body capsule, cream.
    paint(
      capsule(RIG.bodyRadius, RIG.bodyLength, 10, 4).translate(0, RIG.bodyCenterY, 0),
      PALETTE.cream,
    ),
    // Boots, caramel.
    paint(
      roundedBox(RIG.bootW, RIG.bootH, RIG.bootD, 0.08).translate(RIG.bootX, RIG.bootH / 2, 0.1),
      PALETTE.caramel,
    ),
    paint(
      roundedBox(RIG.bootW, RIG.bootH, RIG.bootD, 0.08).translate(-RIG.bootX, RIG.bootH / 2, 0.1),
      PALETTE.caramel,
    ),
    // Hard hat dome + brim, role tint baked here.
    paint(capsule(RIG.hatRadius, 0.06, 10, 3).translate(0, RIG.hatY, 0), hat),
    // disc() already faces +Y; no extra rotation needed.
    paint(disc(RIG.brimRadius, 20).translate(0, RIG.hatY - 0.08, 0.1), hat),
    // Goggle frame, slate.
    paint(
      roundedBox(RIG.goggleW, RIG.goggleH, RIG.goggleD, 0.06).translate(
        0,
        RIG.goggleY,
        RIG.bodyRadius - RIG.goggleD / 2 + 0.04,
      ),
      PALETTE.slate,
    ),
  ];
  return mergeParts(parts);
}

function buildEyes(): THREE.BufferGeometry {
  // mergeParts requires a vertex color on every part; the attribute is
  // harmless under the unlit eyeMint MeshBasicMaterial.
  return mergeParts([
    paint(
      capsule(RIG.eyeRadius, 0.02, 6, 2).translate(RIG.eyeX, RIG.eyeY, RIG.eyeZ),
      PALETTE.mintBright,
    ),
    paint(
      capsule(RIG.eyeRadius, 0.02, 6, 2).translate(-RIG.eyeX, RIG.eyeY, RIG.eyeZ),
      PALETTE.mintBright,
    ),
  ]);
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

export function createBotGeometryCache(): BotGeometryCache {
  const roles: Role[] = [
    "foreman",
    "researcher",
    "analyst",
    "runner",
    "guard",
    "gunner",
    "accountant",
    "intern",
    "janitor",
    "coffee",
    "ambient",
  ];
  const hulls = new Map<Role, THREE.BufferGeometry>();
  for (const role of roles) hulls.set(role, buildHull(role));
  return { hulls, eyes: buildEyes(), arm: buildArm(), blob: buildBlob() };
}

/**
 * Build one bot rig. Pass a shared cache from the fleet so geometry is
 * created once per role, not once per bot. Hat tint is baked into the hull's
 * vertex colors; materials are shared library materials.
 */
export function buildBotRig(
  mats: MaterialLibrary,
  role: Role,
  scale = 1,
  cache: BotGeometryCache = createBotGeometryCache(),
): BotRig {
  const root = new THREE.Group();
  root.name = "bot";
  root.scale.setScalar(scale);

  const body = new THREE.Group();
  body.name = "botBody";
  body.position.y = BOT.height / 2;
  root.add(body);

  const hull = new THREE.Mesh(cache.hulls.get(role) as THREE.BufferGeometry, mats.matteVertex);
  hull.name = "hull";
  body.add(hull);

  const eyes = new THREE.Mesh(cache.eyes, mats.eyeMint);
  eyes.name = "eyes";
  body.add(eyes);

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

  return {
    root,
    body,
    armL,
    armR,
    eyes,
    sockets: { carry, leftHand, rightHand },
    blob,
    baseScale: scale,
    bodyBaseY: BOT.height / 2,
  };
}
