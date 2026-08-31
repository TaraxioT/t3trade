/**
 * Trading floor (M04b): middle floor of the cutaway bureau (y = 0).
 *
 * Same cutaway shell rules as the loft, plus: the brass circulation pole
 * (painted into the static bake) rising from the vault to the loft, the stair
 * flight up from the vault, the briefing table under its blueprint anchor,
 * the wall-mounted ticker board and time clock on the -Z wall, and the
 * crate conveyor running conveyorIn -> conveyorOut.
 */

import * as THREE from "three";
import { DIMENSIONS, PALETTE } from "../config";
import { bevelSlab, capsule, mergeParts, paint, roundedBox } from "../geometry";
import {
  buildBriefingTable,
  buildChair,
  buildDesk,
  buildLocker,
  buildStool,
} from "../props/furniture";
import { buildConveyor, buildTickerBoard } from "../props/trading";
import { buildRailing, buildVent } from "../props/decor";
import type { MaterialLibrary } from "../render/materials";
import type { ResourceRegistry } from "../render/resources";
import { STATIONS } from "../story/waypoints";
import type { WorldPart } from "./plinth";

export const TRADING_FLOOR_VERSION = 1;

const F = DIMENSIONS.floors;
const FY = F.tradingY;
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

/** Merge painted shell parts + positioned kit subtrees, one mesh per material. */
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
    mesh.name = "tradingStatic";
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
  parts.push(
    paint(bevelSlab(1.8, 1.0, 0.24, 0.05).translate(5.5, (FY + fromY) / 2, 5.0), PALETTE.caramel),
  );
  return parts;
}

export function buildTradingFloor(mats: MaterialLibrary, registry: ResourceRegistry): WorldPart {
  const group = new THREE.Group();
  group.name = "tradingFloor";
  const S = STATIONS;

  // ----- Static shell, stairs, pole, time-clock body, clutter ---------------
  const clockX = S.timeClock.x;
  const shellParts: THREE.BufferGeometry[] = [
    ...slabParts(),
    ...shellWallParts(F.ceilingClearance),
    ...stairParts(F.basementY),
    // Brass pole: vertical fast lane from the vault floor to the loft.
    paint(
      capsule(0.12, 6.56, 10).translate(
        S.poleTopTrading.x,
        (F.basementY + F.researchY) / 2,
        S.poleTopTrading.z,
      ),
      PALETTE.brass,
    ),
    // Service hatch floor mark.
    paint(
      bevelSlab(1.2, 1.2, 0.06, 0.02).translate(S.hatchTrading.x, FY + 0.03, S.hatchTrading.z),
      PALETTE.slate,
    ),
    // Time clock body on the -Z wall (its flip face is a named pivot below).
    paint(roundedBox(0.9, 1.1, 0.3, 0.06).translate(clockX, 2.5, Z0 + WT + 0.16), PALETTE.slate),
    paint(roundedBox(1.0, 1.2, 0.12, 0.05).translate(clockX, 2.5, Z0 + WT + 0.06), PALETTE.caramel),
  ];

  const railOpenX = buildRailing(mats, B.footprintDepth);
  railOpenX.rotation.y = Math.PI / 2;
  railOpenX.position.set(X1 - WT - 0.1, FY, CZ);
  const railOpenZ = buildRailing(mats, B.footprintWidth);
  railOpenZ.position.set(CX, FY, Z1 - WT - 0.1);

  // Analyst desk row along +X from deskRowTrading.
  const deskRow = new THREE.Group();
  for (let i = 0; i < 3; i++) {
    const x = S.deskRowTrading.x + i * 2.7;
    const desk = buildDesk(mats);
    desk.position.set(x, FY, S.deskRowTrading.z);
    deskRow.add(desk);
    const chair = buildChair(mats);
    chair.position.set(x, FY, S.deskRowTrading.z + 1.15);
    chair.rotation.y = Math.PI;
    deskRow.add(chair);
  }
  for (let i = 0; i < 2; i++) {
    const stool = buildStool(mats);
    stool.position.set(S.deskRowTrading.x - 1.6 + i * 8.0, FY, S.deskRowTrading.z - 1.4);
    stool.rotation.y = i * 1.3;
    deskRow.add(stool);
  }

  // Clutter: lockers by the stair column, vents on the -Z wall.
  const lockerA = buildLocker(mats);
  lockerA.position.set(X0 + WT + 0.5, FY, 5.4);
  lockerA.rotation.y = Math.PI / 2;
  const lockerB = buildLocker(mats);
  lockerB.position.set(X0 + WT + 0.5, FY, 6.5);
  lockerB.rotation.y = Math.PI / 2;
  const ventA = buildVent(mats);
  ventA.position.set(-7.5, FY + 2.4, Z0 + WT + 0.08);
  const ventB = buildVent(mats);
  ventB.position.set(2.5, FY + 2.4, Z0 + WT + 0.08);

  const statics = bakeKit(mats, registry, shellParts, [
    railOpenX,
    railOpenZ,
    deskRow,
    lockerA,
    lockerB,
    ventA,
    ventB,
  ]);
  statics.forEach((m) => group.add(m));

  // ----- Machines ------------------------------------------------------------
  // Time clock flip face: named pivot the story flips at the loop seam.
  const flipGeo = registry.track(
    mergeParts([paint(bevelSlab(0.72, 0.5, 0.14, 0.04).translate(0, 0, 0), PALETTE.slateDark)]),
  );
  const flip = new THREE.Mesh(flipGeo, mats.darkMetal);
  flip.name = "flip";
  flip.position.set(clockX, 2.5, Z0 + WT + 0.32);
  flip.castShadow = true;
  flip.receiveShadow = true;
  group.add(flip);

  // Briefing table with its blueprint projector anchor.
  const briefing = buildBriefingTable(mats);
  briefing.position.set(S.briefing.x, FY, S.briefing.z);
  briefing.rotation.y = Math.PI; // present toward the open +Z face
  group.add(briefing);

  // Ticker board on the -Z wall at tickerBoard station.
  const ticker = buildTickerBoard(mats, 5.0);
  ticker.position.set(S.tickerBoard.x, FY, Z0 + WT + 0.16);
  group.add(ticker);

  // Conveyor from conveyorIn to conveyorOut (both z = 4.8).
  const inPos = STATIONS.conveyorIn;
  const outPos = STATIONS.conveyorOut;
  const conveyor = buildConveyor(mats, Math.hypot(outPos.x - inPos.x, outPos.z - inPos.z));
  conveyor.position.set((inPos.x + outPos.x) / 2, FY, (inPos.z + outPos.z) / 2);
  group.add(conveyor);

  // ----- Anchors -------------------------------------------------------------
  const anchors: Record<string, THREE.Object3D> = {
    blueprint: briefing.getObjectByName("blueprintAnchor") ?? briefing,
    flip,
    tickerTape: ticker.getObjectByName("tape") ?? ticker,
    conveyorBelt: conveyor.getObjectByName("belt") ?? conveyor,
    conveyorSlats: conveyor.getObjectByName("slats") ?? conveyor,
  };

  return { group, statics, anchors };
}
