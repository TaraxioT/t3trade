/**
 * Research loft (M04b): top interior floor of the cutaway bureau (y = 4.6).
 *
 * Cutaway rule: full-height cream walls on the far -X and -Z faces with
 * caramel trim, low 0.8 base walls on the open +X / +Z faces, railings on the
 * open edges, and a slab aperture over the circulation core (brass pole +
 * stair column) so the stacked floors read as one dollhouse.
 *
 * Machines sit exactly at their STATIONS coordinates from story/waypoints.
 * All non-animatable kit (shell, stairs, desks, chairs, stools, shelves,
 * railings, telescope body) bakes into one merged mesh per material.
 */

import * as THREE from "three";
import { DIMENSIONS, PALETTE } from "../config";
import { bevelSlab, capsule, cone, mergeParts, paint, roundedBox } from "../geometry";
import {
  buildChair,
  buildCoffeeStation,
  buildDesk,
  buildShelf,
  buildStool,
} from "../props/furniture";
import { buildChartWall } from "../props/trading";
import { buildRailing } from "../props/decor";
import type { MaterialLibrary } from "../render/materials";
import type { ResourceRegistry } from "../render/resources";
import { STATIONS } from "../story/waypoints";
import type { WorldPart } from "./plinth";

export const RESEARCH_LOFT_VERSION = 1;

const F = DIMENSIONS.floors;
const FY = F.researchY;
const B = DIMENSIONS.building;
/** Footprint extents: x in [-11, 7], z in [-5.5, 7.5]. */
const X0 = B.centerX - B.footprintWidth / 2;
const X1 = B.centerX + B.footprintWidth / 2;
const Z0 = B.centerZ - B.footprintDepth / 2;
const Z1 = B.centerZ + B.footprintDepth / 2;
const CX = B.centerX;
const CZ = B.centerZ;
const WT = B.wallThickness;

/**
 * Merge the floor's painted shell parts plus every visible mesh of a kit
 * subtree (already positioned in world coordinates) into one mesh per
 * material. The single draw-call workhorse for static world composition.
 */
function bakeKit(
  mats: MaterialLibrary,
  registry: ResourceRegistry,
  parts: THREE.BufferGeometry[],
  kits: readonly THREE.Object3D[],
): THREE.Mesh[] {
  const byMaterial = new Map<THREE.Material, THREE.BufferGeometry[]>();
  for (const kit of kits) {
    kit.updateMatrixWorld(true);
    kit.traverse((o) => {
      if (!(o instanceof THREE.Mesh) || !o.visible) return;
      const geo = o.geometry.clone().applyMatrix4(o.matrixWorld);
      const list = byMaterial.get(o.material as THREE.Material);
      if (list) list.push(geo);
      else byMaterial.set(o.material as THREE.Material, [geo]);
    });
  }
  byMaterial.set(mats.matteVertex, [...(byMaterial.get(mats.matteVertex) ?? []), ...parts]);

  const out: THREE.Mesh[] = [];
  for (const [material, geos] of byMaterial) {
    if (geos.length === 0) continue;
    const merged = mergeParts(geos);
    registry.track(merged);
    const mesh = new THREE.Mesh(merged, material);
    mesh.name = "loftStatic";
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    out.push(mesh);
  }
  return out;
}

/** Floor slab with the circulation aperture cut out (two rectangles). */
/**
 * Retained back half of the floor: the pentagon where x + z <= 2, extruded
 * as the slab. The camera-facing diagonal half is removed so the floor below
 * reads from the retuned 35-degree pitch; bridges keep the circulation core
 * landings floored (see bridgeParts).
 */
function diagonalSlabPart(color: string): THREE.BufferGeometry {
  const shape = new THREE.Shape([
    new THREE.Vector2(X0, -Z0),
    new THREE.Vector2(X1, -Z0),
    new THREE.Vector2(X1, -(2 - X1)), // diagonal meets x = X1 at z = -5
    new THREE.Vector2(2 - Z1, -Z1), // diagonal meets z = Z1 at x = -5.5
    new THREE.Vector2(X0, -Z1),
  ]);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: F.floorSlabThickness,
    bevelEnabled: false,
    curveSegments: 1,
  });
  geo.rotateX(-Math.PI / 2); // shape y -> world -z, extrusion -> +y
  geo.translate(0, FY - F.floorSlabThickness, 0);
  geo.computeVertexNormals();
  return paint(geo, color);
}

/** Diagonal cut edge midpoint / length / yaw (edge from (7,-5) to (-5.5,7.5)). */
const DIAG = {
  len: Math.hypot(X1 - (2 - Z1), Z1 - (2 - X1)),
  midX: (X1 + (2 - Z1)) / 2,
  midZ: (2 - X1 + Z1) / 2,
  yaw: (-Math.PI * 3) / 4,
} as const;

/**
 * Mezzanine bridges over the removed half: stair column, pole landing, and
 * 1.2-wide connecting strips back to the retained half, plus the cream fascia
 * finishing the diagonal cut edge.
 */
function bridgeParts(): THREE.BufferGeometry[] {
  const t = F.floorSlabThickness;
  return [
    paint(bevelSlab(1.2, 3.6, t, 0.1).translate(5.5, FY - t / 2, 5.0), PALETTE.creamWallLight), // stair bridge x 4.9..6.1, z 3.2..6.8
    paint(bevelSlab(1.0, 1.0, t, 0.1).translate(3.0, FY - t / 2, 5.5), PALETTE.creamWallLight), // pole bridge x 2.5..3.5, z 5.0..6.0
    paint(bevelSlab(1.2, 6.1, t, 0.1).translate(5.5, FY - t / 2, 0.15), PALETTE.creamWallLight), // stair connector z -2.9..3.2
    paint(bevelSlab(1.0, 6.4, t, 0.1).translate(3.0, FY - t / 2, 1.8), PALETTE.creamWallLight), // pole connector z -1.4..5.0
    // Cream fascia along the diagonal cut edge.
    paint(
      bevelSlab(DIAG.len + 0.2, 0.24, t, 0.05)
        .rotateY(DIAG.yaw)
        .translate(DIAG.midX, FY - t / 2, DIAG.midZ),
      PALETTE.cream,
    ),
    // Fascia strips under the bridge edges facing the open half.
    paint(
      bevelSlab(3.6, 0.24, t, 0.05)
        .rotateY(Math.PI / 2)
        .translate(6.16, FY - t / 2, 5.0),
      PALETTE.cream,
    ),
    paint(
      bevelSlab(6.4, 0.24, t, 0.05)
        .rotateY(Math.PI / 2)
        .translate(3.56, FY - t / 2, 1.8),
      PALETTE.cream,
    ),
  ];
}

/**
 * Cutaway shell walls: full height on -X / -Z, 0.8 base walls on +X / +Z,
 * caramel trim bands, one structural corner column on the closed corner.
 */
function shellWallParts(wallHeight: number): THREE.BufferGeometry[] {
  const cream = PALETTE.creamWallLight;
  const trim = PALETTE.caramel;
  const wy = FY + wallHeight / 2;
  return [
    // -X full wall + trim.
    paint(
      roundedBox(WT, wallHeight, B.footprintDepth + WT, 0.08).translate(X0 - WT / 2, wy, CZ),
      cream,
    ),
    paint(
      roundedBox(WT + 0.08, 0.35, B.footprintDepth + WT + 0.1, 0.06).translate(
        X0 - WT / 2,
        FY + wallHeight - 0.2,
        CZ,
      ),
      trim,
    ),
    paint(
      roundedBox(WT + 0.08, 0.3, B.footprintDepth + WT + 0.1, 0.06).translate(
        X0 - WT / 2,
        FY + 0.2,
        CZ,
      ),
      trim,
    ),
    // -Z full wall + trim.
    paint(
      roundedBox(B.footprintWidth + WT, wallHeight, WT, 0.08).translate(CX, wy, Z0 - WT / 2),
      cream,
    ),
    paint(
      roundedBox(B.footprintWidth + WT + 0.1, 0.35, WT + 0.08, 0.06).translate(
        CX,
        FY + wallHeight - 0.2,
        Z0 - WT / 2,
      ),
      trim,
    ),
    paint(
      roundedBox(B.footprintWidth + WT + 0.1, 0.3, WT + 0.08, 0.06).translate(
        CX,
        FY + 0.2,
        Z0 - WT / 2,
      ),
      trim,
    ),
    // Structural corner column on the closed -X/-Z corner.
    paint(roundedBox(0.7, wallHeight, 0.7, 0.1).translate(X0 + 0.1, wy, Z0 + 0.1), cream),
  ];
}

/** Straight stair flight onto this floor (x = 5.5, z 3.5 -> 6.5), merged. */
function stairParts(fromY: number): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = [];
  const steps = 10;
  const rise = (FY - fromY) / steps;
  for (let i = 0; i < steps; i++) {
    const z = 3.5 + (i + 0.5) * (3.0 / steps);
    parts.push(
      paint(
        bevelSlab(1.7, 3.0 / steps, 0.2, 0.04).translate(5.5, fromY + rise * (i + 1) - 0.1, z),
        PALETTE.caramelLight,
      ),
    );
  }
  // Mid landing and a slim stringer post.
  parts.push(
    paint(bevelSlab(1.8, 1.0, 0.24, 0.05).translate(5.5, (FY + fromY) / 2, 5.0), PALETTE.caramel),
  );
  return parts;
}

export function buildResearchLoft(mats: MaterialLibrary, registry: ResourceRegistry): WorldPart {
  const group = new THREE.Group();
  group.name = "researchLoft";
  const S = STATIONS;

  // ----- Static shell + mezzanine cut + stairs + hatch mark -----------------
  const shellParts: THREE.BufferGeometry[] = [
    diagonalSlabPart(PALETTE.creamWallLight),
    ...bridgeParts(),
    ...shellWallParts(F.ceilingClearance),
    ...stairParts(F.tradingY),
    // Service hatch floor mark at hatchLoft.
    paint(
      bevelSlab(1.2, 1.2, 0.06, 0.02).translate(S.hatchLoft.x, FY + 0.03, S.hatchLoft.z),
      PALETTE.slate,
    ),
  ];

  // Railings: the diagonal mezzanine edge (caramel read via mahoganyRim
  // rails), the retained +Z edge, and both bridge walkways. All baked.
  const railingAt = (length: number, x: number, z: number, yaw: number): THREE.Object3D => {
    const rail = buildRailing(mats, length);
    rail.rotation.y = yaw;
    rail.position.set(x, FY, z);
    return rail;
  };
  const railings = [
    railingAt(DIAG.len - 0.3, DIAG.midX - 0.18, DIAG.midZ - 0.18, DIAG.yaw),
    railingAt(5.5, -8.25, Z1 - 0.3, 0), // retained +Z slab edge (x -11..-5.5)
    railingAt(6.1, 4.75, 0.15, Math.PI / 2), // stair connector sides
    railingAt(6.1, 6.25, 0.15, Math.PI / 2),
    railingAt(1.2, 5.5, 6.65, 0), // stair bridge far edge
    railingAt(7.4, 2.35, 2.3, Math.PI / 2), // pole walkway sides
    railingAt(7.4, 3.65, 2.3, Math.PI / 2),
    railingAt(1.0, 3.0, 5.85, 0), // pole bridge far edge
  ];

  // Desk row: 3 desks + chairs + 2 stools spread along +X from the anchor.
  const deskRow = new THREE.Group();
  for (let i = 0; i < 3; i++) {
    const x = S.deskRow.x + i * 2.7;
    const desk = buildDesk(mats);
    desk.position.set(x, FY, S.deskRow.z);
    deskRow.add(desk);
    const chair = buildChair(mats);
    chair.position.set(x, FY, S.deskRow.z + 1.15);
    chair.rotation.y = Math.PI;
    deskRow.add(chair);
  }
  for (let i = 0; i < 2; i++) {
    const stool = buildStool(mats);
    stool.position.set(S.deskRow.x - 1.6 + i * 8.0, FY, S.deskRow.z - 1.4);
    stool.rotation.y = i * 1.3;
    deskRow.add(stool);
  }

  // Clutter shelves along the -Z wall.
  const shelfA = buildShelf(mats, 3.0);
  shelfA.position.set(-7.5, FY, Z0 + 0.55);
  const shelfB = buildShelf(mats, 2.4);
  shelfB.position.set(5.4, FY, Z0 + 0.55);

  // Telescope tripod bakes into the shell; the tube is a separate named
  // pivot mesh so the story can swivel it toward the satellite.
  shellParts.push(
    paint(cone(0.55, 1.3, 8).translate(S.telescope.x, FY + 0.65, S.telescope.z), PALETTE.slate),
    paint(capsule(0.18, 0.3).translate(S.telescope.x, FY + 1.35, S.telescope.z), PALETTE.slateDark),
  );

  const tubeGeo = registry.track(
    mergeParts([
      paint(
        capsule(0.16, 1.7, 10)
          .rotateZ(Math.PI / 2 - 0.45)
          .translate(0.55, 0.15, 0),
        PALETTE.slateDark,
      ),
    ]),
  );
  const tube = new THREE.Mesh(tubeGeo, mats.matteVertex);
  tube.name = "tube";
  tube.position.set(S.telescope.x, FY + 1.35, S.telescope.z);
  tube.rotation.y = -0.17; // aims roughly at the satellite pad
  tube.castShadow = true;
  tube.receiveShadow = true;
  group.add(tube);

  const statics = bakeKit(mats, registry, shellParts, [...railings, deskRow, shelfA, shelfB]);
  statics.forEach((m) => group.add(m));

  // ----- Machines (kept as builder-returned groups) -------------------------
  const coffee = buildCoffeeStation(mats);
  coffee.position.set(S.coffee.x, FY, S.coffee.z);
  coffee.rotation.y = 0.35;
  group.add(coffee);

  const chartWall = buildChartWall(mats, 4.6);
  chartWall.position.set(S.chartWall.x, FY, Z0 + WT + 0.12);
  chartWall.rotation.y = 0.12; // slight face toward the camera octant
  group.add(chartWall);

  // ----- Anchors ------------------------------------------------------------
  const anchors: Record<string, THREE.Object3D> = {
    coffeeSpout: coffee.getObjectByName("spout") ?? coffee,
    coffeeSteam: coffee.getObjectByName("steamAnchor") ?? coffee,
    tube,
  };

  return { group, statics, anchors };
}
