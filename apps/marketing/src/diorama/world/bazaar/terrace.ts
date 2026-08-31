/**
 * Bureau Bazaar back terrace (R2 architecture chunk, 09-layout-spec.md).
 *
 * The raised slab at y=3.2 (z -15..-9, full width) whose front face merges
 * into the deck's back wall, carrying the WATCH TOWER lattice, the SEALED
 * SIGNER VAULT glass cube, the MANUAL CONTROL podium with 7 oversized
 * buttons, and the OVERSEER PERCH - each with its back-wall sign mount.
 *
 * UNWIRED: new in R2, intentionally not imported by the composed world yet
 * (atomic cutover wires it in). Geometry and named empties only.
 */

import * as THREE from "three";
import { PALETTE, PALETTE_V2 } from "../../config";
import { bevelSlab, capsule, cone, mergeParts, paint, roundedBox } from "../../geometry";
import type { MaterialLibrary } from "../../render/materials";
import type { ResourceRegistry } from "../../render/resources";
import { signMountParts, type BazaarPart } from "./deck";

export const TERRACE_VERSION = 1;

/** Terrace slab: top surface y=3.2, z in [-14.7,-9.15], full deck width. */
const TERRACE_Y = 3.2;
const TERRACE_Z_CENTER = -11.925;
const TERRACE_DEPTH = 5.55;
const HX = 23;
/** Back wall plane built by deck.ts; mounts sit just in front of it. */
const WALL_Z = -9;
const SIGN_Y = 5.6;

/** Terrace sign mounts: name, x center, emissive bar color. */
const TERRACE_SIGNS: readonly { id: string; cx: number; color: string }[] = [
  { id: "watch", cx: 0, color: PALETTE_V2.zoneEmissive.watch },
  { id: "vault", cx: 7, color: PALETTE_V2.zoneEmissive.mint },
  { id: "control", cx: -5, color: PALETTE.mint },
  { id: "overseer", cx: 14, color: PALETTE.brass },
];

export function buildTerrace(mats: MaterialLibrary, registry: ResourceRegistry): BazaarPart {
  const group = new THREE.Group();
  group.name = "bazaarTerrace";

  // ----- Static shell: slab + top plate --------------------------------------
  const shellParts: THREE.BufferGeometry[] = [
    // Terrace body (boneWall sides); front face hides behind the deck's back
    // wall, so the two read as one continuous surface.
    paint(
      bevelSlab(HX * 2, TERRACE_DEPTH, TERRACE_Y - 0.12, 0.1).translate(
        0,
        (TERRACE_Y - 0.12) / 2,
        TERRACE_Z_CENTER,
      ),
      PALETTE_V2.boneWall,
    ),
    // boneDeck walking surface.
    paint(
      bevelSlab(HX * 2, TERRACE_DEPTH, 0.24, 0.06).translate(0, TERRACE_Y - 0.12, TERRACE_Z_CENTER),
      PALETTE_V2.boneDeck,
    ),
  ];
  const shellMesh = new THREE.Mesh(registry.track(mergeParts(shellParts)), mats.matteVertex);
  shellMesh.name = "terraceShell";
  shellMesh.castShadow = true;
  shellMesh.receiveShadow = true;
  group.add(shellMesh);

  // ----- Terrace furniture (one matte vertex mesh) ----------------------------
  const parts: THREE.BufferGeometry[] = [];

  // WATCH TOWER x [-2,+2]: open lattice to y 10, top platform, bell, beacon.
  const towerZ = -12;
  const postTop = 9.4;
  for (const [px, pz] of [
    [-1.6, towerZ - 1.2],
    [1.6, towerZ - 1.2],
    [-1.6, towerZ + 1.2],
    [1.6, towerZ + 1.2],
  ]) {
    parts.push(
      paint(
        capsule(0.1, postTop - TERRACE_Y, 8).translate(px, (postTop + TERRACE_Y) / 2, pz),
        PALETTE_V2.slateFrame,
      ),
    );
  }
  // Two horizontal cross rings so the frame reads as a lattice.
  for (const ry of [5.4, 7.4]) {
    parts.push(
      paint(roundedBox(3.5, 0.1, 0.1, 0.03).translate(0, ry, towerZ - 1.2), PALETTE_V2.slateFrame),
      paint(roundedBox(3.5, 0.1, 0.1, 0.03).translate(0, ry, towerZ + 1.2), PALETTE_V2.slateFrame),
      paint(roundedBox(0.1, 0.1, 2.6, 0.03).translate(-1.6, ry, towerZ), PALETTE_V2.slateFrame),
      paint(roundedBox(0.1, 0.1, 2.6, 0.03).translate(1.6, ry, towerZ), PALETTE_V2.slateFrame),
    );
  }
  // Top platform (watcher bot + telescope land here in R3).
  parts.push(
    paint(bevelSlab(4.2, 3.0, 0.3, 0.08).translate(0, postTop + 0.15, towerZ), PALETTE_V2.boneDeck),
    // Bell (brass-toned; animated in R3+) hanging just above the platform.
    paint(cone(0.35, 0.5, 10).translate(0, postTop + 0.75, towerZ + 0.9), PALETTE.brass),
    // Beacon socket: slate pedestal; the magenta lamp itself is emissive below.
    paint(capsule(0.3, 0.34, 10).translate(0, postTop + 0.5, towerZ - 0.9), PALETTE_V2.slateFrame),
  );

  // SEALED SIGNER VAULT x [+5,+9]: slate base + thin light frame cube; the
  // glass itself is suggested by the pale frame plus the mint emissive corner
  // edges baked into the sign mesh (no true transparency in the merged path).
  const vX = 7;
  const vZ = -12;
  const vSize = 3.4;
  const vY0 = TERRACE_Y + 0.2;
  parts.push(
    paint(bevelSlab(4, 4, 0.2, 0.06).translate(vX, TERRACE_Y + 0.1, vZ), PALETTE_V2.slateFrame),
  );
  const vY1 = vY0 + vSize;
  const beam = 0.16;
  // Four vertical corner beams.
  for (const [bx, bz] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ]) {
    parts.push(
      paint(
        roundedBox(beam, vSize, beam, 0.04).translate(
          vX + (bx * vSize) / 2,
          vY0 + vSize / 2,
          vZ + (bz * vSize) / 2,
        ),
        PALETTE_V2.boneDeckLight,
      ),
    );
  }
  // Top and bottom frame squares.
  for (const fy of [vY0, vY1]) {
    parts.push(
      paint(
        roundedBox(vSize + beam, beam, beam, 0.04).translate(vX, fy, vZ - vSize / 2),
        PALETTE_V2.boneDeckLight,
      ),
      paint(
        roundedBox(vSize + beam, beam, beam, 0.04).translate(vX, fy, vZ + vSize / 2),
        PALETTE_V2.boneDeckLight,
      ),
      paint(
        roundedBox(beam, beam, vSize + beam, 0.04).translate(vX - vSize / 2, fy, vZ),
        PALETTE_V2.boneDeckLight,
      ),
      paint(
        roundedBox(beam, beam, vSize + beam, 0.04).translate(vX + vSize / 2, fy, vZ),
        PALETTE_V2.boneDeckLight,
      ),
    );
  }
  // Glowing key pedestal inside (slate column; the key glow lands in R3).
  parts.push(
    paint(capsule(0.24, 0.8, 10).translate(vX, TERRACE_Y + 0.55, vZ), PALETTE_V2.slateFrame),
    paint(capsule(0.34, 0.12, 10).translate(vX, TERRACE_Y + 1.05, vZ), PALETTE.brass),
  );

  // MANUAL CONTROL podium x [-7,-3] at the terrace front edge: buttons are
  // deliberately mounted above bot reach at y ~4.6.
  const cX = -5;
  const cZ = -9.9;
  parts.push(
    paint(bevelSlab(3.4, 1.3, 1.2, 0.08).translate(cX, TERRACE_Y + 0.6, cZ), PALETTE_V2.slateFrame),
    paint(
      bevelSlab(3.6, 1.5, 0.16, 0.05).translate(cX, TERRACE_Y + 1.28, cZ),
      PALETTE_V2.boneDeckLight,
    ),
  );

  // OVERSEER PERCH x [+12,+16]: small platform + throne + crown hook.
  const oX = 14;
  const oZ = -12.5;
  const oTop = 4.35;
  parts.push(
    paint(bevelSlab(4, 3, 0.3, 0.08).translate(oX, oTop - 0.15, oZ), PALETTE_V2.boneDeck),
    // Support posts down to the terrace.
    paint(
      capsule(0.1, oTop - TERRACE_Y - 0.3, 8).translate(oX - 1.6, (oTop + TERRACE_Y) / 2, oZ - 1.1),
      PALETTE_V2.slateFrame,
    ),
    paint(
      capsule(0.1, oTop - TERRACE_Y - 0.3, 8).translate(oX + 1.6, (oTop + TERRACE_Y) / 2, oZ + 1.1),
      PALETTE_V2.slateFrame,
    ),
    // Throne: seat, tall back, armrests (slate with a bone seat pad).
    paint(
      bevelSlab(0.9, 0.85, 0.22, 0.05).translate(oX, oTop + 0.22, oZ),
      PALETTE_V2.boneDeckLight,
    ),
    paint(
      roundedBox(0.9, 1.5, 0.18, 0.05).translate(oX, oTop + 1.0, oZ - 0.38),
      PALETTE_V2.slateFrame,
    ),
    paint(
      roundedBox(0.18, 0.35, 0.7, 0.04).translate(oX - 0.5, oTop + 0.5, oZ),
      PALETTE_V2.slateFrame,
    ),
    paint(
      roundedBox(0.18, 0.35, 0.7, 0.04).translate(oX + 0.5, oTop + 0.5, oZ),
      PALETTE_V2.slateFrame,
    ),
    // Crown hook: small brass bracket beside the throne.
    paint(capsule(0.06, 0.5, 8).translate(oX + 1.0, oTop + 0.25, oZ - 0.3), PALETTE.brass),
  );

  const furnitureMesh = new THREE.Mesh(registry.track(mergeParts(parts)), mats.matteVertex);
  furnitureMesh.name = "terraceFurniture";
  furnitureMesh.castShadow = true;
  furnitureMesh.receiveShadow = true;
  group.add(furnitureMesh);

  // ----- Emissive mesh: signs, vault glass edges, buttons, beacon lamp -------
  const glowParts: THREE.BufferGeometry[] = [];
  for (const sign of TERRACE_SIGNS) {
    glowParts.push(...signMountParts(sign.cx, WALL_Z, SIGN_Y, 4.4, 0.9, sign.color));
  }
  // Vault glass suggestion: four thin mint emissive vertical edge strips just
  // inside the frame corners.
  for (const [bx, bz] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ]) {
    glowParts.push(
      paint(
        roundedBox(0.06, vSize - 0.2, 0.06, 0.02).translate(
          vX + (bx * (vSize - 0.3)) / 2,
          vY0 + vSize / 2,
          vZ + (bz * (vSize - 0.3)) / 2,
        ),
        PALETTE.mintBright,
      ),
    );
  }
  // Seven oversized button sockets: one red, one mint, the rest slate.
  for (let i = 0; i < 7; i++) {
    const bx = cX - 1.5 + i * 0.5;
    const color = i === 0 ? PALETTE.dataRed : i === 6 ? PALETTE.mintBright : PALETTE_V2.slateFrame;
    glowParts.push(
      paint(roundedBox(0.3, 0.16, 0.3, 0.06).translate(bx, TERRACE_Y + 1.44, cZ + 0.15), color),
    );
  }
  // Magenta beacon lamp on the socket built above (animation in R3+).
  glowParts.push(
    paint(
      capsule(0.22, 0.1, 8).translate(0, postTop + 0.75, towerZ - 0.9),
      PALETTE_V2.zoneEmissive.watch,
    ),
  );
  const glowMesh = new THREE.Mesh(registry.track(mergeParts(glowParts)), mats.signGlow);
  glowMesh.name = "terraceGlow";
  group.add(glowMesh);

  // ----- Anchors + machine pads ----------------------------------------------
  const points: readonly { name: string; x: number; y: number; z: number }[] = [
    { name: "watchBell", x: 0, y: postTop + 0.75, z: towerZ + 0.9 },
    { name: "vaultKey", x: vX, y: TERRACE_Y + 1.1, z: vZ },
    { name: "controlButtons", x: cX, y: TERRACE_Y + 1.44, z: cZ + 0.15 },
    { name: "overseerSeat", x: oX, y: oTop + 0.3, z: oZ },
  ];
  const anchors: Record<string, THREE.Object3D> = {};
  const machinePads: Record<string, THREE.Object3D> = {};
  for (const point of points) {
    const empty = new THREE.Object3D();
    empty.name = point.name;
    empty.position.set(point.x, point.y, point.z);
    group.add(empty);
    anchors[point.name] = empty;
    machinePads[point.name] = empty;
  }

  return { group, anchors, machinePads };
}
