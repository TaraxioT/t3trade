/**
 * Roof (M04b): roof slab at y = 9.2 with stair housing, antenna, coffee-break
 * vignette, perimeter parapet/railing, and the pipe-bridge anchor pylon.
 */

import * as THREE from "three";
import { DIMENSIONS, PALETTE } from "../config";
import { bevelSlab, capsule, mergeParts, paint, roundedBox } from "../geometry";
import { buildAntenna, buildRailing } from "../props/decor";
import { buildStool } from "../props/furniture";
import type { MaterialLibrary } from "../render/materials";
import type { ResourceRegistry } from "../render/resources";
import { STATIONS } from "../story/waypoints";
import type { WorldPart } from "./plinth";

export const ROOF_VERSION = 1;

const F = DIMENSIONS.floors;
const FY = F.roofY;
const B = DIMENSIONS.building;
const X0 = B.centerX - B.footprintWidth / 2;
const X1 = B.centerX + B.footprintWidth / 2;
const Z0 = B.centerZ - B.footprintDepth / 2;
const Z1 = B.centerZ + B.footprintDepth / 2;
const CX = B.centerX;
const CZ = B.centerZ;
const WT = B.wallThickness;

/**
 * Roof slab tone: PALETTE.cream nudged a few percent darker and slightly
 * cooler so the roof recedes under the key light instead of competing with
 * the glowing interiors. Trims (mahogany parapet, slate pylon) keep their
 * palette colors.
 */
const ROOF_SLAB_TONE = "#E0D3C0";

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
    mesh.name = "roofStatic";
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    out.push(mesh);
  }
  return out;
}

/** Diagonal cut edge midpoint / length / yaw (edge from (7,-5) to (-5.5,7.5)). */
const DIAG = {
  len: Math.hypot(X1 - (2 - Z1), Z1 - (2 - X1)),
  midX: (X1 + (2 - Z1)) / 2,
  midZ: (2 - X1 + Z1) / 2,
  yaw: (-Math.PI * 3) / 4,
} as const;

/** Retained back half of the roof slab: pentagon where x + z <= 2. */
function diagonalSlabPart(color: string): THREE.BufferGeometry {
  const shape = new THREE.Shape([
    new THREE.Vector2(X0, -Z0),
    new THREE.Vector2(X1, -Z0),
    new THREE.Vector2(X1, -(2 - X1)),
    new THREE.Vector2(2 - Z1, -Z1),
    new THREE.Vector2(X0, -Z1),
  ]);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: F.floorSlabThickness,
    bevelEnabled: false,
    curveSegments: 1,
  });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, FY - F.floorSlabThickness, 0);
  geo.computeVertexNormals();
  return paint(geo, color);
}

export function buildRoof(mats: MaterialLibrary, registry: ResourceRegistry): WorldPart {
  const group = new THREE.Group();
  group.name = "roof";
  const S = STATIONS;
  const t = F.floorSlabThickness;

  // Coffee-corner decor keeps its floor on the retained back half; the
  // coffeeCorner STATION point itself is unchanged (see waypoints).
  const decorX = -1.5;
  const decorZ = 2.0;

  // ----- Roof slab (diagonal cut + stair-housing bridge), parapet ----------
  const shellParts: THREE.BufferGeometry[] = [
    diagonalSlabPart(ROOF_SLAB_TONE),
    // Stair-housing bridge (x 4.1..7.0, z 3.2..6.8) + connector walkway.
    paint(bevelSlab(2.9, 3.6, t, 0.1).translate(5.55, FY - t / 2, 5.0), ROOF_SLAB_TONE),
    paint(bevelSlab(1.2, 6.1, t, 0.1).translate(5.5, FY - t / 2, 0.15), ROOF_SLAB_TONE),
    // Cream fascia on the diagonal and bridge edges.
    paint(
      bevelSlab(DIAG.len + 0.2, 0.24, t, 0.05)
        .rotateY(DIAG.yaw)
        .translate(DIAG.midX, FY - t / 2, DIAG.midZ),
      ROOF_SLAB_TONE,
    ),
    paint(
      bevelSlab(3.6, 0.24, t, 0.05)
        .rotateY(Math.PI / 2)
        .translate(4.06, FY - t / 2, 5.0),
      ROOF_SLAB_TONE,
    ),
    // Low parapet on the closed -X / -Z edges with caramel cap.
    paint(
      roundedBox(WT, 0.9, B.footprintDepth + WT, 0.06).translate(X0 - WT / 2, FY + 0.45, CZ),
      PALETTE.creamWallLight,
    ),
    paint(
      roundedBox(WT + 0.1, 0.18, B.footprintDepth + WT + 0.1, 0.05).translate(
        X0 - WT / 2,
        FY + 0.95,
        CZ,
      ),
      PALETTE.caramel,
    ),
    paint(
      roundedBox(B.footprintWidth + WT, 0.9, WT, 0.06).translate(CX, FY + 0.45, Z0 - WT / 2),
      PALETTE.creamWallLight,
    ),
    paint(
      roundedBox(B.footprintWidth + WT + 0.1, 0.18, WT + 0.1, 0.05).translate(
        CX,
        FY + 0.95,
        Z0 - WT / 2,
      ),
      PALETTE.caramel,
    ),
    // Stair housing over the bridge, opening toward -Z.
    paint(
      roundedBox(0.3, 2.4, 3.2, 0.08).translate(X1 - 0.4, FY + 1.2, 5.0),
      PALETTE.creamWallLight,
    ),
    paint(bevelSlab(3.0, 3.6, 0.24, 0.06).translate(5.5, FY + 2.5, 5.0), PALETTE.caramel),
    // Bridge anchor pylon: short mast with a pipe collar at bridgeAnchor.
    paint(
      capsule(0.16, 1.5, 8).translate(S.bridgeAnchor.x, FY + 0.75, S.bridgeAnchor.z),
      PALETTE.slate,
    ),
    paint(
      capsule(0.3, 0.16, 10).translate(S.bridgeAnchor.x, FY + 1.45, S.bridgeAnchor.z),
      PALETTE.brass,
    ),
    // Tiny coffee-corner table (on the retained half).
    paint(capsule(0.45, 0.1, 12).translate(decorX, FY + 0.95, decorZ), PALETTE.caramel),
    paint(capsule(0.06, 0.9).translate(decorX, FY + 0.45, decorZ), PALETTE.slate),
  ];

  // Railings: diagonal edge, retained +Z edge, connector and bridge sides.
  const railingAt = (length: number, x: number, z: number, yaw: number): THREE.Object3D => {
    const rail = buildRailing(mats, length);
    rail.rotation.y = yaw;
    rail.position.set(x, FY, z);
    return rail;
  };
  const railings = [
    railingAt(DIAG.len - 0.3, DIAG.midX - 0.18, DIAG.midZ - 0.18, DIAG.yaw),
    railingAt(5.5, -8.25, Z1 - 0.3, 0), // retained +Z slab edge (x -11..-5.5)
    railingAt(6.1, 4.75, 0.15, Math.PI / 2), // connector sides
    railingAt(6.1, 6.25, 0.15, Math.PI / 2),
    railingAt(2.9, 5.55, 6.65, 0), // housing bridge far edge
    railingAt(3.6, 3.95, 5.0, Math.PI / 2), // housing bridge -X side
  ];

  // Coffee corner seating (two stools, retained half).
  const stools = new THREE.Group();
  for (let i = 0; i < 2; i++) {
    const stool = buildStool(mats);
    stool.position.set(decorX - 1.0 + i * 2.0, FY, decorZ + 0.4);
    stool.rotation.y = i * 1.7;
    stools.add(stool);
  }

  const statics = bakeKit(mats, registry, shellParts, [...railings, stools]);
  statics.forEach((m) => group.add(m));

  // Antenna: kept whole as a machine (matte mast + two named pulse rings).
  const antennaMachine = buildAntenna(mats);
  antennaMachine.position.set(S.antenna.x, FY, S.antenna.z);
  group.add(antennaMachine);

  // ----- Anchors -------------------------------------------------------------
  const pipeMouth = new THREE.Object3D();
  pipeMouth.name = "pipeMouth";
  pipeMouth.position.set(S.bridgeAnchor.x, FY + 1.6, S.bridgeAnchor.z);
  group.add(pipeMouth);

  const anchors: Record<string, THREE.Object3D> = {
    antennaRings: antennaMachine.getObjectByName("rings") ?? antennaMachine,
    pipeMouth,
  };

  return { group, statics, anchors };
}
