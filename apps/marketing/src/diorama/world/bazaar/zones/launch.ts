/**
 * LAUNCH BAY zone shell (R2): x [+10, +15], orange #FF6B35.
 *
 * Glossy tinted floor plate, the reused order cannon on a turntable pad aimed
 * at the exchange pipe mouth (+13.5, 4, +2), a pressure-gauge pillar, thin
 * emissive safe-line floor stripes in front of the cannon, and the brass pipe
 * mouth collar. Not imported anywhere yet (R2 shell chunk).
 *
 * Mesh budget: 1 zonePlate plate + 1 merged matte static + 1 merged emissive
 * (signGlow, vertex-colored) + the reused buildCannon prop.
 */

import * as THREE from "three";
import { PALETTE, PALETTE_V2 } from "../../../config";
import {
  bevelSlab,
  capsule,
  disc,
  mergeParts,
  paint,
  pipeAlong,
  roundedBox,
} from "../../../geometry";
import type { MaterialLibrary } from "../../../render/materials";
import type { ResourceRegistry } from "../../../render/resources";
import { buildCannon } from "../../../props/trading";
import type { WorldPart } from "../../plinth";

export const ZONE_LAUNCH_VERSION = 1;

/** Bay footprint (09-layout-spec.md zone 6). */
const X0 = 10;
const X1 = 15;
const Z0 = -9;
const Z1 = 5;
const CX = (X0 + X1) / 2;

/** Exchange pipe mouth the cannon aims at (spec, exchange satellite section). */
const PIPE_MOUTH = { x: 13.5, y: 4, z: 2 } as const;

function anchor(name: string, x: number, y: number, z: number): THREE.Object3D {
  const o = new THREE.Object3D();
  o.name = name;
  o.position.set(x, y, z);
  return o;
}

export function buildLaunchZone(mats: MaterialLibrary, registry: ResourceRegistry): WorldPart {
  const group = new THREE.Group();
  group.name = "zoneLaunch";

  const tint = PALETTE_V2.zoneFloorTint.launch;
  const zone = PALETTE_V2.zoneEmissive.launch;
  const frame = PALETTE_V2.slateFrame;

  // ----- Floor plate (glossy zone tint via vertex color) ---------------------
  const plateGeo = registry.track(
    mergeParts([paint(bevelSlab(X1 - X0 - 0.3, Z1 - Z0 - 0.3, 0.12, 0.04), tint)]),
  );
  const plate = new THREE.Mesh(plateGeo, mats.zonePlate);
  plate.name = "launchPlate";
  plate.position.set(CX, 0.06, (Z0 + Z1) / 2);
  plate.receiveShadow = true;
  group.add(plate);
  const statics: THREE.Mesh[] = [plate];

  // ----- Turntable pad + cannon aimed at the pipe mouth ----------------------
  const padX = 11.9;
  const padZ = PIPE_MOUTH.z;
  const cannon = buildCannon(mats);
  cannon.name = "launchCannon";
  cannon.position.set(padX, 0.12, padZ);
  // Barrel points +X in local space; raise the muzzle toward the mouth at y=4.
  cannon.rotation.z = Math.atan2(PIPE_MOUTH.y - 1.25, PIPE_MOUTH.x - padX - 1.85);
  group.add(cannon);

  // Gauge pillar: chunky post beside the pad with a big dial.
  const gauge = { x: padX - 0.2, z: padZ + 1.9 } as const;

  // Safe-line stripes: three thin bars across the bay in front of the cannon.
  const safeZ0 = padZ + 0.9;

  // ----- Merged matte static -------------------------------------------------
  const dialRing: { x: number; y: number; z: number }[] = [];
  for (let i = 0; i <= 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    dialRing.push({
      x: gauge.x + Math.cos(a) * 0.62,
      y: 2.35 + Math.sin(a) * 0.62,
      z: gauge.z + 0.14,
    });
  }
  const collarRing: { x: number; y: number; z: number }[] = [];
  for (let i = 0; i <= 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    collarRing.push({
      x: PIPE_MOUTH.x + Math.cos(a) * 0.52,
      y: PIPE_MOUTH.y + Math.sin(a) * 0.52,
      z: PIPE_MOUTH.z + 0.3,
    });
  }
  const matteGeo = registry.track(
    mergeParts([
      // Turntable pad: shallow cylinder + rim.
      paint(capsule(1.35, 0.18, 18).translate(padX, 0.1, padZ), frame),
      paint(disc(1.5, 18).translate(padX, 0.2, padZ), PALETTE_V2.slateFrame),
      // Gauge pillar post + dial face + feet.
      paint(roundedBox(0.28, 2.0, 0.28, 0.06).translate(gauge.x, 1.0, gauge.z), frame),
      paint(disc(0.58, 16).translate(gauge.x, 2.35, gauge.z + 0.06), PALETTE_V2.boneDeckLight),
      paint(pipeAlong(dialRing, 0.05, 5), PALETTE.brass),
      // Pipe mouth collar: brass ring facing the cannon (+Z face toward pad).
      paint(pipeAlong(collarRing, 0.09, 5), PALETTE.brass),
      paint(
        capsule(0.5, 0.24, 14)
          .rotateX(Math.PI / 2)
          .translate(PIPE_MOUTH.x, PIPE_MOUTH.y, PIPE_MOUTH.z),
        frame,
      ),
      // Ammo crate tucked beside the pad (filler silhouette).
      paint(
        bevelSlab(0.9, 0.9, 0.7, 0.06).translate(X1 - 0.8, 0.35, Z0 + 1.2),
        PALETTE_V2.slateFrame,
      ),
    ]),
  );
  const matteMesh = new THREE.Mesh(matteGeo, mats.matteVertex);
  matteMesh.name = "launchStatic";
  matteMesh.castShadow = true;
  matteMesh.receiveShadow = true;
  group.add(matteMesh);
  statics.push(matteMesh);

  // ----- Merged emissive (signGlow, vertex-colored) ---------------------------
  // Safe-line stripes, gauge needle, collar mouth glow.
  const emissiveGeo = registry.track(
    mergeParts([
      ...[0, 1, 2].map((i) =>
        paint(
          bevelSlab(X1 - X0 - 1.4, 0.08, 0.02, 0.01).translate(CX, 0.02, safeZ0 + i * 0.5),
          zone,
        ),
      ),
      paint(
        roundedBox(0.06, 0.4, 0.02, 0.01)
          .rotateZ(0.6)
          .translate(gauge.x + 0.12, 2.45, gauge.z + 0.14),
        zone,
      ),
      paint(disc(0.38, 12).translate(PIPE_MOUTH.x, PIPE_MOUTH.y, PIPE_MOUTH.z + 0.18), zone),
    ]),
  );
  const emissiveMesh = new THREE.Mesh(emissiveGeo, mats.signGlow);
  emissiveMesh.name = "launchGlow";
  group.add(emissiveMesh);

  // ----- R3 density: cable bundles, flip-board, baffle ring (merged) ---------
  // Three curved cable bundles arcing from the back wall down into the cannon
  // base; flip-board on a post beside the pad; exhaust baffle vanes around the
  // pipe mouth collar.
  const cableStart = { x: X0 + 0.7, z: Z0 + 0.8 } as const;
  const detailGeo = registry.track(
    mergeParts([
      ...[0, 1, 2].map((i) =>
        paint(
          pipeAlong(
            [
              { x: cableStart.x, y: 3.2 - i * 0.35, z: cableStart.z + i * 0.3 },
              { x: padX - 2.2 + i * 0.25, y: 2.4 - i * 0.5, z: padZ - 1.2 + i * 0.5 },
              { x: padX - 0.7, y: 0.6, z: padZ - 0.6 + i * 0.35 },
            ],
            0.07,
            5,
          ),
          i === 1 ? PALETTE.brass : frame,
        ),
      ),
      // Countdown flip-board: post, frame, and three flip leaves.
      paint(roundedBox(0.1, 1.7, 0.1, 0.04).translate(padX - 1.6, 0.95, padZ + 1.3), frame),
      paint(bevelSlab(1.0, 0.6, 0.14, 0.05).translate(padX - 1.6, 2.0, padZ + 1.3), frame),
      paint(
        bevelSlab(0.8, 0.2, 0.04, 0.02).translate(padX - 1.6, 2.1, padZ + 1.38),
        PALETTE_V2.boneWall,
      ),
      paint(
        bevelSlab(0.8, 0.2, 0.04, 0.02).translate(padX - 1.6, 1.86, padZ + 1.38),
        PALETTE_V2.boneWall,
      ),
      // Exhaust baffle: ring of angled vanes around the collar mouth.
      ...Array.from({ length: 8 }, (_, i) => {
        const a = (i / 8) * Math.PI * 2;
        return paint(
          roundedBox(0.1, 0.34, 0.16, 0.03)
            .rotateZ(a)
            .translate(
              PIPE_MOUTH.x + Math.cos(a) * 0.62,
              PIPE_MOUTH.y + Math.sin(a) * 0.62,
              PIPE_MOUTH.z + 0.24,
            ),
          frame,
        );
      }),
    ]),
  );
  const detailMesh = new THREE.Mesh(detailGeo, mats.matteVertex);
  detailMesh.name = "launchDetail";
  detailMesh.castShadow = true;
  group.add(detailMesh);
  statics.push(detailMesh);

  // ----- R3 emissive: cable tips, flip digits, turntable warning stripes -------
  const stripeParts: THREE.BufferGeometry[] = [
    // Cable connector tips glowing where the bundles plug into the cannon base.
    ...[0, 1, 2].map((i) =>
      paint(capsule(0.1, 0.08, 8).translate(padX - 0.7, 0.6, padZ - 0.6 + i * 0.35), zone),
    ),
    // Flip-board digit blocks (top/bottom leaves).
    paint(bevelSlab(0.6, 0.12, 0.03, 0.01).translate(padX - 1.6, 2.1, padZ + 1.41), zone),
    paint(bevelSlab(0.6, 0.12, 0.03, 0.01).translate(padX - 1.6, 1.86, padZ + 1.41), zone),
  ];
  // Hazard stripes: alternating emissive bars around the turntable rim.
  for (let i = 0; i < 16; i++) {
    if (i % 2 === 1) continue;
    const a = (i / 16) * Math.PI * 2;
    stripeParts.push(
      paint(
        bevelSlab(0.3, 0.12, 0.02, 0.01)
          .rotateY(-a)
          .translate(padX + Math.cos(a) * 1.28, 0.21, padZ + Math.sin(a) * 1.28),
        zone,
      ),
    );
  }
  const glow2Geo = registry.track(mergeParts(stripeParts));
  const glow2 = new THREE.Mesh(glow2Geo, mats.signGlow);
  glow2.name = "launchGlowDetail";
  group.add(glow2);

  // ----- Anchors --------------------------------------------------------------
  const anchors: Record<string, THREE.Object3D> = {
    launchPad: anchor("launchPad", CX, 0.2, (Z0 + Z1) / 2),
    cannonPad: anchor("cannonPad", padX, 0.2, padZ),
    gaugePillar: anchor("gaugePillar", gauge.x, 0.2, gauge.z),
    pipeMouth: anchor("pipeMouth", PIPE_MOUTH.x, PIPE_MOUTH.y, PIPE_MOUTH.z),
    safeLine: anchor("safeLine", CX, 0.2, safeZ0 + 0.5),
    flipBoard: anchor("flipBoard", padX - 1.6, 2.0, padZ + 1.3),
  };
  for (const a of Object.values(anchors)) group.add(a);

  return { group, statics, anchors };
}
