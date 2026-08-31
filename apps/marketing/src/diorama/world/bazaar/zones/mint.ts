/**
 * CLOID MINT zone shell (diorama v2 R2, layout spec zone 5).
 *
 * Brass zone: the CLOID MINT press (substantial frame, anvil carousel with 6
 * coin slots, stamped-coin chute) as a merged silhouette with named moving
 * parts (pressRam, carousel), plus the armored cable running from the press
 * up to the terrace Sealed Signer Vault (x +7, y 3.2..5) and back down
 * toward the launch bay (x +11, y 2.5).
 *
 * Anchors: mintPressPad, pressRam, carousel, cableVaultEnd, cableLaunchEnd.
 * No self-animation; R3 drives pressRam (vertical slam) and carousel
 * (rotation) through the names.
 */

import * as THREE from "three";
import { PALETTE_V2 } from "../../../config";
import {
  bevelSlab,
  mergeParts,
  paint,
  pipeAlong,
  roundedBox,
  capsule,
  disc,
} from "../../../geometry";
import type { MaterialLibrary } from "../../../render/materials";

export const MINT_ZONE_VERSION = 1;

// Zone bay x [+5, +10], deck depth z [-9, +6]; press centered on its pad.
const PLATE_X0 = 5;
const PLATE_X1 = 10;
const PLATE_Z0 = -9;
const PLATE_Z1 = 6;
const PRESS_X = 7.5;
const PRESS_Z = -1.5;

const BRASS = PALETTE_V2.zones.mint;
const BRASS_TINT = PALETTE_V2.zoneFloorTint.mint;
const FRAME = PALETTE_V2.slateFrame;

/** Retaining-clip positions straddling the armored cable run. */
const CABLE_CLIPS: readonly { x: number; y: number; z: number }[] = [
  { x: 7.5, y: 4.7, z: -7.6 }, // vault rise
  { x: 9.2, y: 3.85, z: -3.9 }, // mid span
  { x: 10.95, y: 2.6, z: 1.3 }, // launch descent
];

/** Painted ring (torus) in the XY plane at constant z; clips and coin rims. */
function ringPoints(
  cx: number,
  cy: number,
  cz: number,
  radius: number,
  tube: number,
  color: string,
): THREE.BufferGeometry {
  const pts: { x: number; y: number; z: number }[] = [];
  for (let i = 0; i <= 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    pts.push({ x: cx + Math.cos(a) * radius, y: cy + Math.sin(a) * radius, z: cz });
  }
  return paint(pipeAlong(pts, tube, 4), color);
}

function anchor(name: string, x: number, y: number, z: number): THREE.Object3D {
  const o = new THREE.Object3D();
  o.name = name;
  o.position.set(x, y, z);
  return o;
}

export function buildMintZone(mats: MaterialLibrary): THREE.Group {
  const root = new THREE.Group();
  root.name = "mintZone";

  // --- Static 1: glossy tinted zone floor plate + raised press pad. ---
  const plate = new THREE.Mesh(
    mergeParts([
      paint(
        bevelSlab(PLATE_X1 - PLATE_X0, PLATE_Z1 - PLATE_Z0, 0.12, 0.04).translate(
          (PLATE_X0 + PLATE_X1) / 2,
          0.06,
          (PLATE_Z0 + PLATE_Z1) / 2,
        ),
        BRASS_TINT,
      ),
      // Press pad: a slightly raised brass-edged dais under the machine.
      paint(bevelSlab(3.4, 2.6, 0.22, 0.05).translate(PRESS_X, 0.17, PRESS_Z), BRASS_TINT),
      paint(
        roundedBox(3.4, 0.08, 2.6, 0.03).translate(PRESS_X, 0.32, PRESS_Z),
        PALETTE_V2.boneWall,
      ),
    ]),
    mats.zonePlate,
  );
  plate.name = "mintPlate";
  plate.receiveShadow = true;
  root.add(plate);

  // --- Static 2: the press silhouette (frame + anvil base + chute), merged. ---
  const frameParts: THREE.BufferGeometry[] = [
    // Base block anchored to the pad.
    paint(bevelSlab(2.6, 1.8, 0.5, 0.06).translate(PRESS_X, 0.57, PRESS_Z), FRAME),
    // Two side columns carrying the head beam.
    paint(roundedBox(0.4, 2.6, 0.5, 0.06).translate(PRESS_X - 1.0, 1.9, PRESS_Z), FRAME),
    paint(roundedBox(0.4, 2.6, 0.5, 0.06).translate(PRESS_X + 1.0, 1.9, PRESS_Z), FRAME),
    // Head beam across the columns.
    paint(bevelSlab(2.6, 0.5, 0.6, 0.06).translate(PRESS_X, 3.15, PRESS_Z), FRAME),
    // Anvil table the carousel sits on.
    paint(capsule(1.05, 0.22, 16).translate(PRESS_X, 0.95, PRESS_Z), PALETTE_V2.boneWall),
    // Stamped-coin chute sliding out toward the street.
    paint(
      bevelSlab(1.4, 0.7, 0.1, 0.04)
        .rotateX(-0.5)
        .translate(PRESS_X + 0.2, 0.75, PRESS_Z + 1.4),
      FRAME,
    ),
    paint(
      roundedBox(1.4, 0.2, 0.1, 0.04)
        .rotateX(-0.5)
        .translate(PRESS_X + 0.2, 0.95, PRESS_Z + 1.62),
      FRAME,
    ),
  ];
  const frameMesh = new THREE.Mesh(mergeParts(frameParts), mats.matteVertex);
  frameMesh.name = "mintPressFrame";
  frameMesh.castShadow = true;
  root.add(frameMesh);

  // --- Moving part: pressRam (R3 slams it down onto the carousel). ---
  const ram = new THREE.Group();
  ram.name = "pressRam";
  ram.position.set(PRESS_X, 2.75, PRESS_Z);
  ram.add(
    new THREE.Mesh(
      mergeParts([
        paint(bevelSlab(0.9, 0.9, 0.55, 0.06), FRAME),
        paint(roundedBox(0.5, 0.3, 0.5, 0.05).translate(0, -0.4, 0), PALETTE_V2.slateFrame),
        paint(roundedBox(0.2, 0.35, 0.2, 0.04).translate(0, 0.42, 0), BRASS),
      ]),
      mats.matteVertex,
    ),
  );
  root.add(ram);

  // --- Moving part: carousel with 6 coin slots (R3 rotates stepwise). ---
  const carousel = new THREE.Group();
  carousel.name = "carousel";
  carousel.position.set(PRESS_X, 1.12, PRESS_Z);
  const carouselParts: THREE.BufferGeometry[] = [
    paint(capsule(0.85, 0.14, 18), PALETTE_V2.boneWall),
  ];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const sx = Math.cos(a) * 0.55;
    const sz = Math.sin(a) * 0.55;
    carouselParts.push(
      paint(capsule(0.17, 0.001, 12).translate(sx, 0.09, sz), BRASS),
      paint(roundedBox(0.3, 0.06, 0.3, 0.02).translate(sx, 0.05, sz), PALETTE_V2.slateFrame),
    );
  }
  carousel.add(new THREE.Mesh(mergeParts(carouselParts), mats.matteVertex));
  // One freshly stamped coin glow dot riding the carousel (emissive accent).
  const coinGlow = new THREE.Mesh(
    mergeParts([paint(disc(0.16, 12).translate(0.55, 0.12, 0), BRASS)]),
    mats.signGlow,
  );
  coinGlow.name = "coinGlow";
  carousel.add(coinGlow);
  root.add(carousel);

  // --- Static 3: armored cable, brass, from the press to the vault and on. ---
  // Press head (x +7, y 3.2) -> up the terrace vault face (x +7, y 5)
  // -> over and down toward the launch bay (x +11, y 2.5).
  const cable = new THREE.Mesh(
    mergeParts([
      paint(
        pipeAlong(
          [
            { x: PRESS_X, y: 2.6, z: PRESS_Z - 0.4 },
            { x: PRESS_X - 0.5, y: 3.4, z: PRESS_Z - 1.2 },
            { x: 7.0, y: 4.6, z: -8.4 },
            { x: 7.0, y: 5.0, z: -8.6 },
          ],
          0.12,
          6,
        ),
        BRASS,
      ),
      paint(
        pipeAlong(
          [
            { x: 7.0, y: 5.0, z: -8.6 },
            { x: 8.2, y: 4.4, z: -6.5 },
            { x: 9.6, y: 3.4, z: -2.0 },
            { x: 11.0, y: 2.5, z: 0.5 },
            { x: 11.0, y: 2.5, z: 2.0 },
          ],
          0.12,
          6,
        ),
        BRASS,
      ),
    ]),
    mats.brass,
  );
  cable.name = "mintCable";
  cable.castShadow = true;
  root.add(cable);

  // --- R3 density: Static 4: coin tray with 6 identical minted coins. ---
  // The determinism gag: every coin is exactly the same; the tray sits at the
  // chute foot. Emissive edges live in mintGlow below.
  const trayX = PRESS_X + 0.2;
  const trayZ = PRESS_Z + 2.15;
  const coinParts: THREE.BufferGeometry[] = [
    paint(bevelSlab(1.9, 0.8, 0.1, 0.04).translate(trayX, 0.28, trayZ), FRAME),
    paint(roundedBox(1.9, 0.2, 0.1, 0.04).translate(trayX, 0.4, trayZ - 0.35), FRAME),
    paint(roundedBox(1.9, 0.2, 0.1, 0.04).translate(trayX, 0.4, trayZ + 0.35), FRAME),
    paint(roundedBox(0.1, 0.2, 0.8, 0.04).translate(trayX - 0.9, 0.4, trayZ), FRAME),
    paint(roundedBox(0.1, 0.2, 0.8, 0.04).translate(trayX + 0.9, 0.4, trayZ), FRAME),
    paint(roundedBox(0.14, 0.24, 0.14, 0.04).translate(trayX - 0.8, 0.12, trayZ - 0.3), FRAME),
    paint(roundedBox(0.14, 0.24, 0.14, 0.04).translate(trayX + 0.8, 0.12, trayZ - 0.3), FRAME),
  ];
  const coinSlots: { x: number; z: number }[] = [];
  for (let i = 0; i < 6; i++) {
    const cx = trayX - 0.65 + i * 0.26;
    const cz = trayZ + (i % 2 === 0 ? -0.12 : 0.12);
    coinSlots.push({ x: cx, z: cz });
    coinParts.push(paint(capsule(0.1, 0.035, 14).translate(cx, 0.38, cz), BRASS));
  }
  const coinTray = new THREE.Mesh(mergeParts(coinParts), mats.matteVertex);
  coinTray.name = "mintCoinTray";
  coinTray.castShadow = true;
  root.add(coinTray);

  // --- R3 density: Static 5: foundry chimney, calibration gauge, cable clips. ---
  const chimneyX = 9.2;
  const chimneyParts: THREE.BufferGeometry[] = [
    // Foundry chimney venting the press head, with a heat-shimmer socket.
    paint(capsule(0.28, 1.6, 12).translate(chimneyX, 3.9, PRESS_Z), FRAME),
    paint(capsule(0.36, 0.2, 12).translate(chimneyX, 4.8, PRESS_Z), PALETTE_V2.slateFrame),
    paint(roundedBox(0.4, 0.6, 0.4, 0.06).translate(chimneyX, 2.9, PRESS_Z), FRAME),
    // Calibration gauge board on the -X press column.
    paint(
      bevelSlab(0.5, 0.7, 0.08, 0.03).translate(PRESS_X - 1.0, 2.3, PRESS_Z + 0.3),
      PALETTE_V2.boneWall,
    ),
    ...[-0.2, -0.05, 0.1, 0.25].map((dy, i) =>
      paint(
        roundedBox(0.24, 0.04, 0.03, 0.01).translate(PRESS_X - 1.0, 2.3 + dy, PRESS_Z + 0.36),
        i < 3 ? PALETTE_V2.slateFrame : PALETTE_V2.zones.risk,
      ),
    ),
    paint(
      roundedBox(0.04, 0.3, 0.02, 0.01)
        .rotateZ(0.6)
        .translate(PRESS_X - 1.0, 2.3, PRESS_Z + 0.38),
      BRASS,
    ),
    // Three retaining clips straddling the armored cable.
    ...CABLE_CLIPS.map((c) => ringPoints(c.x, c.y, c.z, 0.17, 0.035, PALETTE_V2.slateFrame)),
  ];
  const chimneyMesh = new THREE.Mesh(mergeParts(chimneyParts), mats.matteVertex);
  chimneyMesh.name = "mintDetails";
  chimneyMesh.castShadow = true;
  root.add(chimneyMesh);

  // --- R3 density: the zone's emissive mesh (signGlow, vertex-colored). ---
  // Brass emissive rims on all 6 tray coins + mint status dots on the clips.
  const glowParts: THREE.BufferGeometry[] = coinSlots.map((c) =>
    ringPoints(c.x, 0.4, c.z, 0.1, 0.018, BRASS),
  );
  for (const c of CABLE_CLIPS) {
    glowParts.push(
      paint(capsule(0.045, 0.001, 8).translate(c.x, c.y + 0.24, c.z), PALETTE_V2.zones.oilBar),
    );
  }
  const glowMesh = new THREE.Mesh(mergeParts(glowParts), mats.signGlow);
  glowMesh.name = "mintGlow";
  root.add(glowMesh);

  // --- Anchors. ---
  root.add(anchor("mintPressPad", PRESS_X, 0.35, PRESS_Z + 0.8)); // bot stand point at the press
  root.add(anchor("pressRam", PRESS_X, 2.3, PRESS_Z));
  root.add(anchor("carousel", PRESS_X, 1.2, PRESS_Z));
  root.add(anchor("cableVaultEnd", 7.0, 4.6, -8.6));
  root.add(anchor("cableLaunchEnd", 11.0, 2.5, 2.0));
  root.add(anchor("heatShimmer", chimneyX, 5.05, PRESS_Z)); // future particle socket

  return root;
}
