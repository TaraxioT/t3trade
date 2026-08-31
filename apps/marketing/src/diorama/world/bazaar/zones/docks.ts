/**
 * HARNESS DOCKS zone shell (R2, 09-layout-spec.md bay 1).
 *
 * Static shell only: tinted floor plate, five provider dock pads in a row
 * against the back wall (each with its own sub-accent color and a mint
 * beam-arrival ring inlay), and a task-tablet dispenser pillar. Machines are
 * simple placeholder silhouettes; R3 replaces detail on the same anchors.
 *
 * Zone x range [-21, -15] (world), built in local coordinates with the group
 * positioned at x = -21. Bay depth z in [-9, +6].
 */

import * as THREE from "three";
import { PALETTE } from "../../../config";
import { bevelSlab, capsule, mergeParts, paint, pipeAlong, roundedBox } from "../../../geometry";
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

/** World x of the zone's left edge (layout spec: docks spans x [-21, -15]). */
export const DOCKS_X0 = -21;
/** Zone bay width in x. */
export const DOCKS_WIDTH = 6;
/** Bay depth in z: back wall face at -9, machine fronts may reach +6. */
const Z_BACK = -9;
const Z_FRONT = 6;

/** Five provider sub-accent colors (pad edge tint per dock pad). */
const PAD_ACCENTS: readonly string[] = [
  PALETTE.zones.oilBar, // Codex - mint (brand thread)
  PALETTE.zones.plan, // Claude - amber
  PALETTE.zones.gauntlet, // Cursor - cyan
  PALETTE.zones.launch, // Grok - orange
  PALETTE.zones.mint, // OpenCode - brass
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

/** Flat mint ring looped around (cx, cz) at height y, for the beam-arrival pad. */
function arrivalRing(cx: number, y: number, cz: number): THREE.BufferGeometry {
  const points: { x: number; y: number; z: number }[] = [];
  const SEGMENTS = 16;
  for (let i = 0; i <= SEGMENTS; i += 1) {
    const a = (i / SEGMENTS) * Math.PI * 2;
    points.push({ x: cx + Math.cos(a) * 0.26, y, z: cz + Math.sin(a) * 0.26 });
  }
  return pipeAlong(points, 0.035, 6);
}

export function buildDocks(mats: MaterialLibrary, registry: ResourceRegistry): ZoneBuild {
  const group = new THREE.Group();
  group.name = "zoneDocks";
  group.position.set(DOCKS_X0, 0, 0);

  // --- Zone floor plate (glossy tinted, one shared zonePlate material) ---
  const plateGeo = registry.track(
    paint(
      bevelSlab(DOCKS_WIDTH, Z_FRONT - Z_BACK, 0.16, 0.05).translate(
        DOCKS_WIDTH / 2,
        0.08,
        (Z_BACK + Z_FRONT) / 2,
      ),
      PALETTE.zoneFloorTint.docks,
    ),
  );
  const plate = new THREE.Mesh(plateGeo, mats.zonePlate);
  plate.name = "docksPlate";
  plate.receiveShadow = true;
  group.add(plate);

  // --- Static silhouette parts (matte vertex-color bake) ---
  const staticParts: THREE.BufferGeometry[] = [];

  // Five dock pads in a row against the back wall, each: accent base slab +
  // bone inset top where bots land.
  const padCenters: number[] = [];
  for (let i = 0; i < 5; i += 1) {
    const cx = 0.6 + i * 1.2;
    const cz = -6.2;
    padCenters.push(cx);
    staticParts.push(
      paint(bevelSlab(1.15, 1.15, 0.28, 0.06).translate(cx, 0.14, cz), PAD_ACCENTS[i] as string),
      paint(bevelSlab(0.85, 0.85, 0.1, 0.03).translate(cx, 0.31, cz), PALETTE.boneDeckLight),
    );
  }

  // Task-tablet dispenser pillar at the bay center, against the back wall.
  staticParts.push(
    paint(roundedBox(0.9, 2.6, 0.7, 0.12).translate(3.0, 1.3, -8.0), PALETTE.slateFrame),
    paint(bevelSlab(1.0, 0.8, 0.3, 0.08).translate(3.0, 2.72, -8.0), PALETTE.zones.docks),
    paint(bevelSlab(0.5, 0.08, 0.3, 0.02).translate(3.0, 1.7, -7.62), PALETTE.slateDark),
  );

  // R3 density: gantry arm spanning pads A..E. Slate mast + jib with a
  // periwinkle trim strip, a trolley block over pad A and a hanging hook
  // (pipe + hook capsule) over pad E, for crate/tablet swings off the beam.
  staticParts.push(
    paint(bevelSlab(0.18, 0.18, 3.6, 0.04).translate(0.0, 1.8, -6.2), PALETTE.slateFrame),
    paint(bevelSlab(6.0, 0.14, 0.14, 0.04).translate(3.0, 3.5, -6.2), PALETTE.slateFrame),
    paint(bevelSlab(6.0, 0.16, 0.05, 0.02).translate(3.0, 3.41, -6.2), PALETTE.zones.docks),
    paint(bevelSlab(0.3, 0.24, 0.22, 0.05).translate(0.6, 3.3, -6.2), PALETTE.slateDark),
    paint(capsule(0.04, 0.5, 5, 2).translate(0.6, 2.95, -6.2), PALETTE.slateFrame),
    paint(capsule(0.04, 0.7, 5, 2).translate(5.4, 2.85, -6.2), PALETTE.slateFrame),
    paint(capsule(0.09, 0.08, 6, 3).translate(5.4, 2.45, -6.2), PALETTE.brass),
  );

  // R3 density: status pylon against the back wall; its five provider-colored
  // lights live in the emissive bake below.
  staticParts.push(
    paint(bevelSlab(0.26, 0.26, 1.9, 0.05).translate(0.35, 0.95, -8.35), PALETTE.slateFrame),
    paint(bevelSlab(0.5, 0.3, 0.4, 0.06).translate(0.35, 2.05, -8.35), PALETTE.slateDark),
  );

  const staticGeo = registry.track(mergeParts(staticParts));
  const staticMesh = new THREE.Mesh(staticGeo, mats.matteVertex);
  staticMesh.name = "docksStatic";
  staticMesh.castShadow = true;
  staticMesh.receiveShadow = true;
  group.add(staticMesh);

  // --- Emissive bits (one merged mesh, signGlow) ---
  const emissiveParts: THREE.BufferGeometry[] = [];
  // Beam-arrival ring inlay on every pad, mint (the brand thread).
  for (const cx of padCenters) {
    emissiveParts.push(paint(arrivalRing(cx, 0.37, -6.2), PALETTE.zones.oilBar));
  }
  // Small periwinkle ready-strip on the dispenser's tablet slot.
  emissiveParts.push(
    paint(bevelSlab(0.54, 0.04, 0.06, 0.01).translate(3.0, 1.55, -7.6), PALETTE.zones.docks),
  );
  // Five provider status lights on the pylon head (accent per dock pad).
  for (let i = 0; i < 5; i += 1) {
    emissiveParts.push(
      paint(
        bevelSlab(0.07, 0.05, 0.07, 0.01).translate(0.16 + i * 0.1, 2.06, -8.18),
        PAD_ACCENTS[i] as string,
      ),
    );
  }
  // Floor chevrons pointing +z (arrival direction): three V pairs of thin
  // mint strips walking toward the street between the pads and the front.
  for (const cz of [-3.4, -2.4, -1.4]) {
    emissiveParts.push(
      paint(
        bevelSlab(0.62, 0.09, 0.04, 0.01)
          .rotateY(Math.PI / 4)
          .translate(2.68, 0.17, cz - 0.14),
        PALETTE.zones.oilBar,
      ),
      paint(
        bevelSlab(0.62, 0.09, 0.04, 0.01)
          .rotateY(-Math.PI / 4)
          .translate(3.32, 0.17, cz - 0.14),
        PALETTE.zones.oilBar,
      ),
    );
  }

  const emissiveGeo = registry.track(mergeParts(emissiveParts));
  const emissiveMesh = new THREE.Mesh(emissiveGeo, mats.signGlow);
  emissiveMesh.name = "docksEmissive";
  group.add(emissiveMesh);

  // --- Anchors for R3 machines and R5 bots ---
  const anchors: THREE.Object3D[] = [
    anchorAt(group, "docksPadA", padCenters[0] as number, 0.36, -6.2),
    anchorAt(group, "docksPadB", padCenters[1] as number, 0.36, -6.2),
    anchorAt(group, "docksPadC", padCenters[2] as number, 0.36, -6.2),
    anchorAt(group, "docksPadD", padCenters[3] as number, 0.36, -6.2),
    anchorAt(group, "docksPadE", padCenters[4] as number, 0.36, -6.2),
    anchorAt(group, "tabletDispenser", 3.0, 0, -7.3),
  ];

  return { group, anchors, animated: [] };
}
