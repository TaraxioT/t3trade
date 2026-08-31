/**
 * ACTIVATION DESK zone shell (R2, 09-layout-spec.md bay 3).
 *
 * Static shell only: tinted floor plate, the TRADE.md desk (wide top,
 * document tray with a paper stack), an oversized ACTIVATED stamp silhouette,
 * and the activation slot chute angled down from the desk toward the street
 * conveyor start (z +7). Machines are simple silhouettes; R3 replaces detail
 * on the same anchors.
 *
 * Zone x range [-8, -3] (world), built in local coordinates with the group
 * positioned at x = -8. Bay depth z in [-9, +6] with machine fronts allowed
 * into the street overlap.
 */

import * as THREE from "three";
import { PALETTE } from "../../../config";
import { bevelSlab, capsule, mergeParts, paint, pipeAlong } from "../../../geometry";
import type { MaterialLibrary } from "../../../render/materials";
import type { ResourceRegistry } from "../../../render/resources";

/**
 * Zone shell contract (R2): a group positioned at the zone's x-range on the
 * deck (y = 0), named anchor empties for the zone's machines, and any child
 * meshes that will animate. Duplicated per zone file so each shell stays
 * self-contained; hoist into a shared module when the bazaar index lands.
 */
export interface ZoneBuild {
  readonly group: THREE.Group;
  readonly anchors: readonly THREE.Object3D[];
  readonly animated: readonly THREE.Mesh[];
}

/** World x of the zone's left edge (layout spec: plan spans x [-8, -3]). */
export const PLAN_X0 = -8;
/** Zone bay width in x. */
export const PLAN_WIDTH = 5;
/** Bay depth in z: back wall face at -9, machine fronts may reach +6. */
const Z_BACK = -9;
const Z_FRONT = 6;

/** Chute run: top mouth at the desk edge, bottom slot toward the street. */
const CHUTE = {
  x: 2.5,
  topY: 1.35,
  topZ: -4.4,
  bottomY: 0.35,
  bottomZ: 1.6,
} as const;

function anchorAt(
  group: THREE.Group,
  name: string,
  x: number,
  y: number,
  z: number,
): THREE.Object3D {
  const empty = new THREE.Object3D();
  empty.name = name;
  empty.position.set(x, y, z);
  group.add(empty);
  return empty;
}

export function buildPlan(mats: MaterialLibrary, registry: ResourceRegistry): ZoneBuild {
  const group = new THREE.Group();
  group.name = "zonePlan";
  group.position.set(PLAN_X0, 0, 0);

  // --- Zone floor plate (glossy tinted, one shared zonePlate material) ---
  const plateGeo = registry.track(
    paint(
      bevelSlab(PLAN_WIDTH, Z_FRONT - Z_BACK, 0.16, 0.05).translate(
        PLAN_WIDTH / 2,
        0.08,
        (Z_BACK + Z_FRONT) / 2,
      ),
      PALETTE.zoneFloorTint.plan,
    ),
  );
  const plate = new THREE.Mesh(plateGeo, mats.zonePlate);
  plate.name = "planPlate";
  plate.receiveShadow = true;
  group.add(plate);

  // --- Static silhouette parts (matte vertex-color bake) ---
  const staticParts: THREE.BufferGeometry[] = [];

  // TRADE.md desk: wide bone top, slate legs, modesty panel, document tray
  // holding a paper stack waiting for the stamp.
  staticParts.push(
    paint(bevelSlab(3.2, 1.3, 0.14, 0.05).translate(1.6, 1.0, -5.4), PALETTE.boneDeckLight),
    paint(bevelSlab(0.14, 0.14, 0.95, 0.03).translate(0.25, 0.48, -5.9), PALETTE.slateFrame),
    paint(bevelSlab(0.14, 0.14, 0.95, 0.03).translate(2.95, 0.48, -5.9), PALETTE.slateFrame),
    paint(bevelSlab(0.14, 0.14, 0.95, 0.03).translate(0.25, 0.48, -4.9), PALETTE.slateFrame),
    paint(bevelSlab(0.14, 0.14, 0.95, 0.03).translate(2.95, 0.48, -4.9), PALETTE.slateFrame),
    paint(bevelSlab(2.9, 0.1, 0.7, 0.03).translate(1.6, 0.55, -5.75), PALETTE.slateFrame),
    paint(bevelSlab(0.7, 0.5, 0.08, 0.02).translate(0.5, 1.11, -5.6), PALETTE.slateFrame),
    paint(bevelSlab(0.58, 0.38, 0.14, 0.02).translate(0.5, 1.22, -5.6), PALETTE.cream),
  );

  // R3 density: document stack fan on the desk - several cream sheets splayed
  // at increasing angles beside the tray.
  for (let i = 0; i < 5; i += 1) {
    staticParts.push(
      paint(
        bevelSlab(0.5, 0.36, 0.02, 0.005)
          .rotateY(-0.5 + i * 0.25)
          .translate(1.7 + i * 0.06, 1.09 + i * 0.022, -5.5),
        PALETTE.cream,
      ),
    );
  }

  // R3 density: inbox/outbox tray pair on the desk's right end; inbox holds a
  // fresh stack, outbox waits empty.
  staticParts.push(
    paint(bevelSlab(0.6, 0.42, 0.07, 0.02).translate(2.75, 1.11, -5.55), PALETTE.slateFrame),
    paint(bevelSlab(0.48, 0.3, 0.12, 0.02).translate(2.75, 1.2, -5.55), PALETTE.cream),
    paint(bevelSlab(0.6, 0.42, 0.07, 0.02).translate(2.75, 1.11, -4.95), PALETTE.slateFrame),
  );

  // R3 density: wall slot on the back wall with the TRADE.md half-inserted -
  // a cream slab jutting out of a dark slot plate.
  staticParts.push(
    paint(bevelSlab(0.8, 0.12, 0.5, 0.03).translate(0.6, 2.7, -8.9), PALETTE.slateFrame),
    paint(bevelSlab(0.5, 0.06, 0.3, 0.02).translate(0.6, 2.72, -8.82), PALETTE.slateDark),
    paint(bevelSlab(0.42, 0.06, 0.55, 0.02).translate(0.6, 2.72, -8.5), PALETTE.cream),
  );

  // R3 density: queue-rail in front of the desk - two posts with a rail, each
  // post carrying a vertical waiting-paper slot.
  for (const qx of [1.0, 2.4]) {
    staticParts.push(
      paint(capsule(0.05, 0.85, 6, 2).translate(qx, 0.5, -3.6), PALETTE.slateFrame),
      paint(bevelSlab(0.34, 0.08, 0.3, 0.02).translate(qx, 1.0, -3.6), PALETTE.slateDark),
      paint(bevelSlab(0.26, 0.05, 0.4, 0.01).translate(qx, 0.85, -3.6), PALETTE.cream),
    );
  }
  staticParts.push(
    paint(
      pipeAlong(
        [
          { x: 1.0, y: 0.72, z: -3.6 },
          { x: 1.7, y: 0.78, z: -3.6 },
          { x: 2.4, y: 0.72, z: -3.6 },
        ],
        0.03,
        5,
      ),
      PALETTE.zones.plan,
    ),
  );

  // Oversized ACTIVATED stamp silhouette: amber head + slate handle knob,
  // freestanding beside the desk so it reads at iso distance.
  staticParts.push(
    paint(bevelSlab(1.0, 0.8, 0.5, 0.1).translate(3.9, 1.7, -5.3), PALETTE.zones.plan),
    paint(capsule(0.11, 0.5, 8, 3).translate(3.9, 2.25, -5.3), PALETTE.slateFrame),
    paint(capsule(0.19, 0.12, 8, 3).translate(3.9, 2.62, -5.3), PALETTE.slateFrame),
    paint(bevelSlab(1.2, 1.0, 0.14, 0.04).translate(3.9, 0.07, -5.3), PALETTE.slateFrame),
  );

  // Activation slot chute: angled slab + two side rails running from the desk
  // edge down toward the street conveyor start at world z +7.
  const runZ = CHUTE.bottomZ - CHUTE.topZ;
  const runY = CHUTE.topY - CHUTE.bottomY;
  const length = Math.hypot(runZ, runY);
  const tilt = Math.atan2(runY, runZ);
  const midX = CHUTE.x;
  const midY = (CHUTE.topY + CHUTE.bottomY) / 2;
  const midZ = (CHUTE.topZ + CHUTE.bottomZ) / 2;
  staticParts.push(
    paint(
      bevelSlab(0.9, length, 0.12, 0.04).rotateX(tilt).translate(midX, midY, midZ),
      PALETTE.boneDeckLight,
    ),
    paint(
      bevelSlab(0.1, length, 0.3, 0.03)
        .rotateX(tilt)
        .translate(midX - 0.48, midY + 0.1, midZ),
      PALETTE.slateFrame,
    ),
    paint(
      bevelSlab(0.1, length, 0.3, 0.03)
        .rotateX(tilt)
        .translate(midX + 0.48, midY + 0.1, midZ),
      PALETTE.slateFrame,
    ),
    // Dark slot mouth at the top of the chute.
    paint(
      bevelSlab(0.5, 0.3, 0.2, 0.03).translate(CHUTE.x, CHUTE.topY + 0.08, CHUTE.topZ - 0.1),
      PALETTE.slateDark,
    ),
  );

  const staticGeo = registry.track(mergeParts(staticParts));
  const staticMesh = new THREE.Mesh(staticGeo, mats.matteVertex);
  staticMesh.name = "planStatic";
  staticMesh.castShadow = true;
  staticMesh.receiveShadow = true;
  group.add(staticMesh);

  // --- Emissive bits (one merged mesh, screenAmber data screens) ---
  // Amber strip along the desk's front edge + the glow inside the slot mouth.
  // Paint is required by mergeParts; screenAmber ignores vertex colors.
  const emissiveParts: THREE.BufferGeometry[] = [
    paint(bevelSlab(3.0, 0.06, 0.06, 0.01).translate(1.6, 0.97, -4.78), PALETTE.zones.plan),
    paint(
      bevelSlab(0.44, 0.06, 0.12, 0.01).translate(CHUTE.x, CHUTE.topY + 0.02, CHUTE.topZ - 0.1),
      PALETTE.zones.plan,
    ),
  ];
  const emissiveGeo = registry.track(mergeParts(emissiveParts));
  const emissiveMesh = new THREE.Mesh(emissiveGeo, mats.screenAmber);
  emissiveMesh.name = "planEmissive";
  group.add(emissiveMesh);

  // --- Anchors for R3 machines and R5 bots ---
  const anchors: THREE.Object3D[] = [
    anchorAt(group, "planDeskPad", 1.6, 0, -4.6),
    anchorAt(group, "stampSilhouette", 3.9, 0, -5.3),
    anchorAt(group, "activationSlot", CHUTE.x, CHUTE.bottomY, CHUTE.bottomZ + 0.3),
  ];

  return { group, anchors, animated: [] };
}
