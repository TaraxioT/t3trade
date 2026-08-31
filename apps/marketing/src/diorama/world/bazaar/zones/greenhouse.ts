/**
 * RESEARCH GREENHOUSE zone shell (R2, 09-layout-spec.md bay 2).
 *
 * Static shell only: tinted floor plate, two grow-light racks with emissive
 * strips, six candle-stem chart-plant silhouettes (green with red data-bud
 * accents), a hypothesis whiteboard slab, and a backtest wind-tunnel box with
 * a fan disc (the one animated child placeholder). Machines are simple
 * silhouettes; R3 replaces detail on the same anchors.
 *
 * Zone x range [-15, -8] (world), built in local coordinates with the group
 * positioned at x = -15. Bay depth z in [-9, +6].
 */

import * as THREE from "three";
import { PALETTE } from "../../../config";
import { bevelSlab, capsule, disc, mergeParts, paint, pipeAlong } from "../../../geometry";
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

/** World x of the zone's left edge (layout spec: greenhouse spans x [-15, -8]). */
export const GREENHOUSE_X0 = -15;
/** Zone bay width in x. */
export const GREENHOUSE_WIDTH = 7;
/** Bay depth in z: back wall face at -9, machine fronts may reach +6. */
const Z_BACK = -9;
const Z_FRONT = 6;

/** Candle-stem plant footprints (local x, z); the first four sit under racks. */
const PLANTS: readonly { x: number; z: number; bud: boolean }[] = [
  { x: 0.6, z: -6.6, bud: false },
  { x: 1.4, z: -6.0, bud: true },
  { x: 2.2, z: -6.7, bud: false },
  { x: 3.6, z: -6.4, bud: true },
  { x: 4.6, z: -6.9, bud: false },
  { x: 5.4, z: -6.1, bud: true },
];

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

export function buildGreenhouse(mats: MaterialLibrary, registry: ResourceRegistry): ZoneBuild {
  const group = new THREE.Group();
  group.name = "zoneGreenhouse";
  group.position.set(GREENHOUSE_X0, 0, 0);

  // --- Zone floor plate (glossy tinted, one shared zonePlate material) ---
  const plateGeo = registry.track(
    paint(
      bevelSlab(GREENHOUSE_WIDTH, Z_FRONT - Z_BACK, 0.16, 0.05).translate(
        GREENHOUSE_WIDTH / 2,
        0.08,
        (Z_BACK + Z_FRONT) / 2,
      ),
      PALETTE.zoneFloorTint.greenhouse,
    ),
  );
  const plate = new THREE.Mesh(plateGeo, mats.zonePlate);
  plate.name = "greenhousePlate";
  plate.receiveShadow = true;
  group.add(plate);

  // --- Static silhouette parts (matte vertex-color bake) ---
  const staticParts: THREE.BufferGeometry[] = [];

  // Two grow-light racks: slate uprights, bone top bar and mid shelf. The
  // emissive strip under the top bar is baked into the emissive mesh below.
  for (const rackX of [1.2, 4.2]) {
    staticParts.push(
      paint(bevelSlab(0.16, 0.16, 2.4, 0.04).translate(rackX - 1.0, 1.2, -7.5), PALETTE.slateFrame),
      paint(bevelSlab(0.16, 0.16, 2.4, 0.04).translate(rackX + 1.0, 1.2, -7.5), PALETTE.slateFrame),
      paint(bevelSlab(2.4, 0.2, 0.16, 0.04).translate(rackX, 2.34, -7.5), PALETTE.slateFrame),
      paint(bevelSlab(2.2, 0.8, 0.1, 0.03).translate(rackX, 1.0, -7.5), PALETTE.boneDeckLight),
    );
  }

  // Chart-plant silhouettes: capsule stem + bulb head; a few get red data
  // buds so the chart read (green with loss marks) survives at iso distance.
  for (const plant of PLANTS) {
    staticParts.push(
      paint(capsule(0.07, 0.7, 6, 2).translate(plant.x, 0.5, plant.z), PALETTE.zones.greenhouse),
      paint(capsule(0.16, 0.06, 8, 3).translate(plant.x, 1.0, plant.z), PALETTE.dataGreen),
    );
    if (plant.bud) {
      staticParts.push(
        paint(capsule(0.06, 0.04, 6, 2).translate(plant.x + 0.12, 0.78, plant.z), PALETTE.dataRed),
      );
    }
  }

  // Hypothesis whiteboard: thin standing slab on two legs, paper note chips.
  staticParts.push(
    paint(bevelSlab(1.9, 0.14, 1.15, 0.05).translate(6.3, 1.5, -2.0), PALETTE.boneDeckLight),
    paint(bevelSlab(1.98, 0.18, 0.14, 0.04).translate(6.3, 2.02, -2.0), PALETTE.slateFrame),
    paint(capsule(0.05, 0.9, 6, 2).translate(5.55, 0.45, -2.0), PALETTE.slateFrame),
    paint(capsule(0.05, 0.9, 6, 2).translate(7.05, 0.45, -2.0), PALETTE.slateFrame),
    paint(bevelSlab(0.3, 0.04, 0.24, 0.01).translate(5.95, 1.6, -1.9), PALETTE.cream),
    paint(bevelSlab(0.3, 0.04, 0.24, 0.01).translate(6.45, 1.35, -1.9), PALETTE.cream),
    paint(bevelSlab(0.3, 0.04, 0.24, 0.01).translate(6.7, 1.7, -1.9), PALETTE.cream),
  );

  // Backtest wind-tunnel box: bone body on a slate base; the fan lives on the
  // camera-facing face as its own animated child mesh.
  staticParts.push(
    paint(bevelSlab(2.3, 1.2, 1.2, 0.1).translate(1.6, 0.85, -1.2), PALETTE.boneDeckLight),
    paint(bevelSlab(2.5, 1.3, 0.18, 0.05).translate(1.6, 0.09, -1.2), PALETTE.slateFrame),
  );

  // R3 density: glass-dome suggestions over the two racks. Pale flattened
  // capsules sunk into the rack tops (opaque bone, reads as glass at iso
  // distance); each dome's base ring glows in the emissive bake below.
  for (const domeX of [1.2, 4.2]) {
    staticParts.push(
      paint(
        capsule(1.05, 0.05, 12, 4).scale(1.0, 0.55, 0.85).translate(domeX, 2.3, -7.5),
        PALETTE.boneDeckLight,
      ),
    );
  }

  // R3 density: seedling tray row on a small ledge off the whiteboard leg.
  staticParts.push(
    paint(bevelSlab(1.5, 0.4, 0.08, 0.02).translate(6.1, 0.95, -1.6), PALETTE.slateFrame),
    paint(bevelSlab(1.2, 0.3, 0.08, 0.02).translate(6.1, 1.02, -1.6), PALETTE.boneDeckLight),
  );
  for (let i = 0; i < 4; i += 1) {
    const tx = 5.65 + i * 0.3;
    staticParts.push(
      paint(bevelSlab(0.22, 0.18, 0.08, 0.02).translate(tx, 1.08, -1.6), PALETTE.slateDark),
      paint(capsule(0.035, 0.1, 4, 2).translate(tx, 1.18, -1.6), PALETTE.zones.greenhouse),
    );
  }

  // R3 density: watering can silhouette parked by the plant row.
  staticParts.push(
    paint(capsule(0.22, 0.28, 8, 3).translate(3.0, 0.5, -5.4), PALETTE.zones.greenhouse),
    paint(
      pipeAlong(
        [
          { x: 3.18, y: 0.62, z: -5.4 },
          { x: 3.45, y: 0.78, z: -5.4 },
          { x: 3.62, y: 0.66, z: -5.4 },
        ],
        0.035,
        5,
      ),
      PALETTE.slateFrame,
    ),
    paint(
      pipeAlong(
        [
          { x: 2.82, y: 0.68, z: -5.4 },
          { x: 2.78, y: 0.86, z: -5.4 },
          { x: 2.9, y: 0.92, z: -5.4 },
        ],
        0.03,
        5,
      ),
      PALETTE.slateFrame,
    ),
  );

  const staticGeo = registry.track(mergeParts(staticParts));
  const staticMesh = new THREE.Mesh(staticGeo, mats.matteVertex);
  staticMesh.name = "greenhouseStatic";
  staticMesh.castShadow = true;
  staticMesh.receiveShadow = true;
  group.add(staticMesh);

  // --- Emissive bits (one merged mesh, signGlow with zone emissive color) ---
  const emissiveParts: THREE.BufferGeometry[] = [];
  for (const rackX of [1.2, 4.2]) {
    emissiveParts.push(
      paint(
        bevelSlab(2.0, 0.14, 0.07, 0.02).translate(rackX, 2.22, -7.5),
        PALETTE.zoneEmissive.greenhouse,
      ),
    );
    // Pale emissive base ring under each glass-dome suggestion (ellipse loop).
    const ring: { x: number; y: number; z: number }[] = [];
    const SEGMENTS = 16;
    for (let i = 0; i <= SEGMENTS; i += 1) {
      const a = (i / SEGMENTS) * Math.PI * 2;
      ring.push({
        x: rackX + Math.cos(a) * 1.0,
        y: 2.34,
        z: -7.5 + Math.sin(a) * 0.85,
      });
    }
    emissiveParts.push(paint(pipeAlong(ring, 0.03, 6), PALETTE.zoneEmissive.greenhouse));
  }
  const emissiveGeo = registry.track(mergeParts(emissiveParts));
  const emissiveMesh = new THREE.Mesh(emissiveGeo, mats.signGlow);
  emissiveMesh.name = "greenhouseEmissive";
  group.add(emissiveMesh);

  // --- Animated placeholders: wind-tunnel fan disc + data butterflies ---
  const fanGeo = registry.track(
    mergeParts([
      paint(disc(0.42, 14), PALETTE.slateFrame),
      paint(bevelSlab(0.66, 0.1, 0.16, 0.02), PALETTE.slateFrame),
      paint(bevelSlab(0.66, 0.1, 0.16, 0.02).rotateY(Math.PI / 2), PALETTE.slateFrame),
      paint(capsule(0.09, 0.06, 6, 3), PALETTE.slateDark),
    ]),
  );
  const fan = new THREE.Mesh(fanGeo, mats.matteVertex);
  fan.name = "greenhouseFanDisc";
  fan.position.set(1.6, 0.85, -0.58);
  fan.rotation.x = -Math.PI / 2; // face the camera: spin about world Y
  fan.castShadow = true;
  group.add(fan);

  // Data butterflies: tiny emissive double-triangle wings, ambient hover
  // candidates for the director. Named butterflyA..C, flagged animated.
  const BUTTERFLIES: readonly { x: number; y: number; z: number }[] = [
    { x: 1.6, y: 1.7, z: -5.6 },
    { x: 4.4, y: 1.9, z: -5.9 },
    { x: 2.9, y: 1.5, z: -6.3 },
  ];
  const butterflies: THREE.Mesh[] = [];
  BUTTERFLIES.forEach((spot, i) => {
    const geo = registry.track(
      mergeParts([
        paint(disc(0.09, 3).rotateZ(0.35).translate(-0.07, 0, 0), PALETTE.mintBright),
        paint(disc(0.09, 3).rotateZ(-0.35).translate(0.07, 0, 0), PALETTE.mintBright),
      ]),
    );
    const mesh = new THREE.Mesh(geo, mats.signGlow);
    mesh.name = `butterfly${"ABC"[i]}`;
    mesh.position.set(spot.x, spot.y, spot.z);
    mesh.rotation.x = -Math.PI / 2;
    group.add(mesh);
    butterflies.push(mesh);
  });

  // --- Anchors for R3 machines and R5 bots ---
  const anchors: THREE.Object3D[] = [
    anchorAt(group, "greenhouseRack1", 1.2, 0, -7.5),
    anchorAt(group, "greenhouseRack2", 4.2, 0, -7.5),
    anchorAt(group, "plantA", PLANTS[0].x, 0, PLANTS[0].z),
    anchorAt(group, "plantB", PLANTS[1].x, 0, PLANTS[1].z),
    anchorAt(group, "plantC", PLANTS[2].x, 0, PLANTS[2].z),
    anchorAt(group, "plantD", PLANTS[3].x, 0, PLANTS[3].z),
    anchorAt(group, "plantE", PLANTS[4].x, 0, PLANTS[4].z),
    anchorAt(group, "plantF", PLANTS[5].x, 0, PLANTS[5].z),
    anchorAt(group, "whiteboard", 6.3, 0, -2.0),
    anchorAt(group, "windTunnel", 1.6, 0, -1.2),
  ];

  return { group, anchors, animated: [fan, ...butterflies] };
}
