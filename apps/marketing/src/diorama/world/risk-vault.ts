/**
 * Risk vault (M04b): sunken basement floor inside the plinth well (y = -2.2).
 *
 * The shell uses lower walls (2.2 high, up to the plinth rim) so the vault
 * reads as an excavated level. Contains the risk-gate queue floor marks
 * (queueTail -> queueHead -> stampDesk), the stamp desk, the vault door on
 * the -X wall, the order cannon aimed at the bridge anchor, the receipt tray,
 * and the reject chute that slides out through the plinth's -X aperture into
 * a closed bin shell.
 */

import * as THREE from "three";
import { DIMENSIONS, PALETTE } from "../config";
import { bevelSlab, mergeParts, paint, roundedBox } from "../geometry";
import { buildCannon, buildReceiptTray, buildStampDesk, buildVaultDoor } from "../props/trading";
import { buildLocker } from "../props/furniture";
import { buildRailing } from "../props/decor";
import type { MaterialLibrary } from "../render/materials";
import type { ResourceRegistry } from "../render/resources";
import { STATIONS } from "../story/waypoints";
import type { WorldPart } from "./plinth";

export const RISK_VAULT_VERSION = 1;

const F = DIMENSIONS.floors;
const FY = F.basementY;
const B = DIMENSIONS.building;
const X0 = B.centerX - B.footprintWidth / 2;
const X1 = B.centerX + B.footprintWidth / 2;
const Z0 = B.centerZ - B.footprintDepth / 2;
const Z1 = B.centerZ + B.footprintDepth / 2;
const CX = B.centerX;
const CZ = B.centerZ;
const WT = B.wallThickness;
const CUT_X = 1.4;
const CUT_Z = 3.5;

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
    mesh.name = "vaultStatic";
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    out.push(mesh);
  }
  return out;
}

function slabParts(): THREE.BufferGeometry[] {
  return [
    paint(
      bevelSlab(CUT_X - X0, B.footprintDepth, F.floorSlabThickness, 0.1).translate(
        (X0 + CUT_X) / 2,
        FY - F.floorSlabThickness / 2,
        CZ,
      ),
      PALETTE.creamWallLight,
    ),
    paint(
      bevelSlab(X1 - CUT_X, CUT_Z - Z0, F.floorSlabThickness, 0.1).translate(
        (CUT_X + X1) / 2,
        FY - F.floorSlabThickness / 2,
        (Z0 + CUT_Z) / 2,
      ),
      PALETTE.creamWallLight,
    ),
  ];
}

function shellWallParts(wallHeight: number): THREE.BufferGeometry[] {
  const cream = PALETTE.creamWallLight;
  const trim = PALETTE.caramel;
  const wy = FY + wallHeight / 2;
  return [
    paint(
      roundedBox(WT, wallHeight, B.footprintDepth + WT, 0.08).translate(X0 - WT / 2, wy, CZ),
      cream,
    ),
    paint(
      roundedBox(WT + 0.08, 0.3, B.footprintDepth + WT + 0.1, 0.06).translate(
        X0 - WT / 2,
        FY + wallHeight - 0.15,
        CZ,
      ),
      trim,
    ),
    paint(
      roundedBox(WT + 0.08, 0.3, B.footprintDepth + WT + 0.1, 0.06).translate(
        X0 - WT / 2,
        FY + 0.15,
        CZ,
      ),
      trim,
    ),
    paint(
      roundedBox(B.footprintWidth + WT, wallHeight, WT, 0.08).translate(CX, wy, Z0 - WT / 2),
      cream,
    ),
    paint(
      roundedBox(B.footprintWidth + WT + 0.1, 0.3, WT + 0.08, 0.06).translate(
        CX,
        FY + wallHeight - 0.15,
        Z0 - WT / 2,
      ),
      trim,
    ),
    paint(
      roundedBox(B.footprintWidth + WT + 0.1, 0.3, WT + 0.08, 0.06).translate(
        CX,
        FY + 0.15,
        Z0 - WT / 2,
      ),
      trim,
    ),
  ];
}

/** Thin painted queue strips along the gate queue polyline. */
function queueMarkParts(): THREE.BufferGeometry[] {
  const mk = (ax: number, az: number, bx: number, bz: number): THREE.BufferGeometry => {
    const len = Math.hypot(bx - ax, bz - az);
    const g = bevelSlab(len, 0.22, 0.03, 0.01);
    g.rotateY(-Math.atan2(bz - az, bx - ax));
    g.translate((ax + bx) / 2, FY + 0.02, (az + bz) / 2);
    return paint(g, PALETTE.caramelLight);
  };
  const t = STATIONS.queueTail;
  const h = STATIONS.queueHead;
  const d = STATIONS.stampDesk;
  return [mk(t.x, t.z, h.x, h.z), mk(h.x, h.z, d.x, d.z)];
}

/** Reject chute: tray from chuteTop through the plinth aperture, plus the bin. */
function chuteParts(): THREE.BufferGeometry[] {
  const top = STATIONS.chuteTop;
  const exit = STATIONS.chuteExit;
  // Mouth sits 1.3 above the vault floor; the bed runs -X and slightly down,
  // passing through the plinth aperture (z in [0.9, 2.1], y in [-2.0, -0.7]).
  const ax = top.x;
  const ay = top.y + 1.3;
  const slope = (exit.y - ay) / (exit.x - ax);
  const bx = -14.45; // just past the plinth's -X border wall inner face
  const by = ay + (bx - ax) * slope;
  const len = Math.hypot(bx - ax, by - ay);
  const angle = Math.atan2(by - ay, bx - ax);
  const midX = (ax + bx) / 2;
  const midY = (ay + by) / 2;
  const bed = bevelSlab(len, 0.9, 0.1, 0.03);
  bed.rotateZ(angle);
  bed.translate(midX, midY, top.z);
  const railA = roundedBox(len, 0.3, 0.1, 0.04);
  railA.rotateZ(angle);
  railA.translate(midX, midY + 0.35, top.z + 0.5);
  const railB = roundedBox(len, 0.3, 0.1, 0.04);
  railB.rotateZ(angle);
  railB.translate(midX, midY + 0.35, top.z - 0.5);
  return [
    paint(bed, PALETTE.slateDark),
    paint(railA, PALETTE.slate),
    paint(railB, PALETTE.slate),
    // Support post inside the vault.
    paint(
      roundedBox(0.16, 1.4, 0.16, 0.05).translate(top.x + 0.3, top.y + 0.7, top.z + 0.4),
      PALETTE.slate,
    ),
    // Closed reject bin mounted on the outer plinth face below the aperture.
    paint(roundedBox(0.9, 0.7, 0.9, 0.08).translate(-15.3, -2.55, exit.z), PALETTE.slateDark),
    paint(bevelSlab(0.95, 0.95, 0.1, 0.03).translate(-15.3, -2.16, exit.z), PALETTE.slate),
  ];
}

export function buildRiskVault(mats: MaterialLibrary, registry: ResourceRegistry): WorldPart {
  const group = new THREE.Group();
  group.name = "riskVault";
  const S = STATIONS;

  // ----- Static shell, queue marks, chute, tray, clutter --------------------
  const tray = STATIONS.receiptTray;
  const trayParts = new THREE.Group();
  // Receipt tray: static kit, baked into the floor mesh; its coinSlot anchor
  // is re-registered as a world anchor below.
  const receiptTrayObj = buildReceiptTray(mats);
  receiptTrayObj.position.set(tray.x, FY, tray.z);
  trayParts.add(receiptTrayObj);

  const locker = buildLocker(mats);
  locker.position.set(X0 + WT + 0.5, FY, 5.4);
  locker.rotation.y = Math.PI / 2;

  const shellParts: THREE.BufferGeometry[] = [
    ...slabParts(),
    ...shellWallParts(-FY), // walls rise from the vault floor to the plinth top
    ...queueMarkParts(),
    ...chuteParts(),
    paint(
      bevelSlab(1.2, 1.2, 0.06, 0.02).translate(S.hatchVault.x, FY + 0.03, S.hatchVault.z),
      PALETTE.slate,
    ),
  ];

  const railOpenZ = buildRailing(mats, B.footprintWidth);
  railOpenZ.position.set(CX - WT / 2, FY, Z1 - WT - 0.1);
  const railOpenX = buildRailing(mats, B.footprintDepth);
  railOpenX.rotation.y = Math.PI / 2;
  railOpenX.position.set(X1 - WT - 0.1, FY, CZ);

  const statics = bakeKit(mats, registry, shellParts, [trayParts, locker, railOpenZ, railOpenX]);
  statics.forEach((m) => group.add(m));

  // ----- Machines ------------------------------------------------------------
  const stampDesk = buildStampDesk(mats);
  stampDesk.position.set(S.stampDesk.x, FY, S.stampDesk.z);
  stampDesk.rotation.y = Math.PI; // guard faces the queue arriving from +X
  group.add(stampDesk);

  const vaultDoor = buildVaultDoor(mats);
  vaultDoor.position.set(X0 + WT + 0.5, FY, S.vaultDoor.z);
  vaultDoor.rotation.y = Math.PI / 2; // set into the -X wall, faces +X
  group.add(vaultDoor);

  // Cannon aimed from its station at the roof bridge anchor.
  const cannon = buildCannon(mats);
  cannon.position.set(S.cannon.x, FY, S.cannon.z);
  const dx = S.bridgeAnchor.x - S.cannon.x;
  const dy = S.bridgeAnchor.y - S.cannon.y;
  const dz = S.bridgeAnchor.z - S.cannon.z;
  // Barrel points along local +X: yaw about Y, then pitch about local Z.
  cannon.rotation.order = "YZX";
  cannon.rotation.y = -Math.atan2(dz, dx);
  cannon.rotation.z = Math.atan2(dy, Math.hypot(dx, dz));
  group.add(cannon);

  // ----- Anchors -------------------------------------------------------------
  const chuteExitAnchor = new THREE.Object3D();
  chuteExitAnchor.name = "chuteExit";
  chuteExitAnchor.position.set(S.chuteExit.x, S.chuteExit.y, S.chuteExit.z);

  const coinSlot = new THREE.Object3D();
  coinSlot.name = "coinSlot";
  coinSlot.position.set(tray.x, FY + 0.62, tray.z + 0.05);

  const anchors: Record<string, THREE.Object3D> = {
    stampPivot: stampDesk.getObjectByName("stamp") ?? stampDesk,
    vaultPivot: vaultDoor.getObjectByName("pivot") ?? vaultDoor,
    breech: cannon.getObjectByName("breech") ?? cannon,
    cannonCrank: cannon.getObjectByName("crank") ?? cannon,
    cannonGauge: cannon.getObjectByName("gauge") ?? cannon,
    coinSlot,
    chuteExit: chuteExitAnchor,
  };
  group.add(chuteExitAnchor, coinSlot);

  return { group, statics, anchors };
}
