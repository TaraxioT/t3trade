/**
 * THE GAUNTLET zone shell (diorama v2 R2, layout spec zone 4).
 *
 * The centerpiece of the bazaar deck: one long cyan conveyor running along the
 * street (z = +7) from activation (x -4) to the mint hand-off (x +5), flanked
 * by 14 check-station stamp pylons in two rows of 7. Station 7 is the primary
 * stamper (the reused stamp desk). A reject diverter arm and red-X bin sit at
 * the output end. The RISK ANNEX (budget-ruler wall gauge + protection tag
 * dispenser, risk-red accents) shares this block's back edge.
 *
 * Anchors: gauntletIn, gauntletOut, gauntletReject, checkLight1..14,
 * budgetRuler, tagDispenser, stampDesk, beltZone. Animatable named parts:
 * checkLight1..14 (per-station status dots), rulerMarker (budget gauge).
 * No self-animation; story drives everything through the names.
 */

import * as THREE from "three";
import { PALETTE, PALETTE_V2 } from "../../../config";
import {
  bevelSlab,
  capsule,
  cone,
  mergeParts,
  paint,
  pipeAlong,
  roundedBox,
} from "../../../geometry";
import { buildConveyor, buildStampDesk } from "../../../props/trading";
import type { MaterialLibrary } from "../../../render/materials";

export const GAUNTLET_ZONE_VERSION = 1;

// Zone bay x [-3, +5]; belt runs x [-4, +5] at street z = +7.
const PLATE_X0 = -3;
const PLATE_X1 = 5;
const PLATE_Z0 = -9;
const PLATE_Z1 = 6;
const BELT_Z = 7;
const BELT_LEN = 9; // x -4 .. +5, one continuous belt
const BELT_Y = 0; // legs stand on the deck

// Two rows of 7 stamp pylons flanking the belt (row z offsets from BELT_Z).
const ROW_BACK = BELT_Z - 1.7;
const ROW_FRONT = BELT_Z + 1.7;
const STATION_X0 = -3.3;
const STATION_DX = 1.3;

const CYAN = PALETTE_V2.zones.gauntlet;
const CYAN_TINT = PALETTE_V2.zoneFloorTint.gauntlet;
const RISK = PALETTE_V2.zones.risk;
const FRAME = PALETTE_V2.slateFrame;

function anchor(name: string, x: number, y: number, z: number): THREE.Object3D {
  const o = new THREE.Object3D();
  o.name = name;
  o.position.set(x, y, z);
  return o;
}

/** One check-station stamp pylon facing the belt (dir = -1 back row, +1 front). */
function pylonParts(x: number, z: number, dir: number): THREE.BufferGeometry[] {
  return [
    // Weighted base.
    paint(bevelSlab(0.6, 0.6, 0.14, 0.04).translate(x, 0.07, z), FRAME),
    // Column, 1.2 tall.
    paint(roundedBox(0.26, 1.1, 0.26, 0.05).translate(x, 0.66, z), PALETTE_V2.boneWall),
    // Cyan collar ring near the top (zone coding on machines).
    paint(roundedBox(0.3, 0.1, 0.3, 0.03).translate(x, 1.02, z), CYAN),
    // Arm reaching over the belt with the stamp head.
    paint(roundedBox(0.7, 0.1, 0.16, 0.03).translate(x - dir * 0.35, 1.28, z), FRAME),
    paint(roundedBox(0.18, 0.24, 0.3, 0.04).translate(x - dir * 0.68, 1.14, z), FRAME),
  ];
}

export function buildGauntletZone(mats: MaterialLibrary): THREE.Group {
  const root = new THREE.Group();
  root.name = "gauntletZone";

  // --- Static 1: glossy tinted zone floor plate. ---
  const plate = new THREE.Mesh(
    mergeParts([
      paint(
        bevelSlab(PLATE_X1 - PLATE_X0, PLATE_Z1 - PLATE_Z0, 0.12, 0.04).translate(
          (PLATE_X0 + PLATE_X1) / 2,
          0.06,
          (PLATE_Z0 + PLATE_Z1) / 2,
        ),
        CYAN_TINT,
      ),
    ]),
    mats.zonePlate,
  );
  plate.name = "gauntletPlate";
  plate.receiveShadow = true;
  root.add(plate);

  // --- The conveyor: the visual spine of the whole scene. ---
  // Belt width ~1.6 (scaled from the kit's 1.0), one continuous run.
  const conveyor = buildConveyor(mats, BELT_LEN);
  conveyor.name = "gauntletBelt";
  conveyor.position.set((PLATE_X0 - 1 + PLATE_X1) / 2, BELT_Y, BELT_Z);
  conveyor.scale.z = 1.6;
  root.add(conveyor);

  // --- Static 2: the 14 check-station pylons, merged. ---
  const pylons: THREE.BufferGeometry[] = [];
  const lightPositions: { x: number; y: number; z: number }[] = [];
  for (let i = 0; i < 14; i++) {
    const backRow = i < 7;
    const station = backRow ? i : i - 7; // 0..6 along the belt
    const x = STATION_X0 + station * STATION_DX;
    const z = backRow ? ROW_BACK : ROW_FRONT;
    const dir = backRow ? 1 : -1; // arms reach toward the belt
    pylons.push(...pylonParts(x, z, dir));
    lightPositions.push({ x, y: 1.42, z });
  }
  const pylonMesh = new THREE.Mesh(mergeParts(pylons), mats.matteVertex);
  pylonMesh.name = "gauntletPylons";
  pylonMesh.castShadow = true;
  root.add(pylonMesh);

  // --- Per-station status lights: named emissive dots (checkLight1..14). ---
  lightPositions.forEach((p, i) => {
    const light = new THREE.Mesh(
      mergeParts([paint(capsule(0.07, 0.001, 8).translate(p.x, p.y, p.z), CYAN)]),
      mats.screenCyan,
    );
    light.name = `checkLight${i + 1}`;
    root.add(light);
  });

  // --- Station 7 primary stamper: the reused stamp desk beside the belt. ---
  const stampDesk = buildStampDesk(mats);
  stampDesk.position.set(STATION_X0 + 6 * STATION_DX + 0.1, 0, ROW_BACK - 0.9);
  stampDesk.rotation.y = Math.PI; // desk faces the belt
  root.add(stampDesk);
  root.add(anchor("stampDesk", stampDesk.position.x, 1.2, stampDesk.position.z));

  // --- Static 3: reject diverter arm, red-X bin, and the RISK ANNEX. ---
  const annexParts: THREE.BufferGeometry[] = [
    // Reject diverter arm: a paddle angled across the belt at the output end.
    paint(roundedBox(0.14, 0.14, 1.3, 0.04).translate(4.3, 1.35, BELT_Z + 0.45), FRAME),
    paint(capsule(0.09, 0.7, 8).translate(4.3, 0.85, BELT_Z + 1.0), CYAN),
    // Red-X reject bin at the front of the output end.
    paint(bevelSlab(1.2, 1.0, 0.14, 0.04).translate(4.3, 0.07, BELT_Z + 2.0), FRAME),
    paint(bevelSlab(1.2, 0.14, 1.0, 0.04).translate(4.3, 0.75, BELT_Z + 2.0), FRAME),
    paint(roundedBox(0.14, 0.7, 0.14, 0.04).translate(3.8, 0.42, BELT_Z + 1.6), FRAME),
    paint(roundedBox(0.14, 0.7, 0.14, 0.04).translate(4.8, 0.42, BELT_Z + 1.6), FRAME),
    paint(roundedBox(0.14, 0.7, 0.14, 0.04).translate(3.8, 0.42, BELT_Z + 2.4), FRAME),
    paint(roundedBox(0.14, 0.7, 0.14, 0.04).translate(4.8, 0.42, BELT_Z + 2.4), FRAME),
    // RISK ANNEX at the back edge: budget-ruler wall gauge board.
    paint(bevelSlab(2.4, 0.16, 2.4, 0.05).translate(2.6, 1.3, -7.8), PALETTE_V2.boneWall),
    // Ruler tick marks: tall majors, short minors (risk red).
    ...rulerTicks(2.6, -7.68),
    // Protection tag dispenser: a wall strip with four tag clips.
    paint(bevelSlab(0.9, 0.12, 1.6, 0.04).translate(4.4, 1.5, -7.8), FRAME),
    paint(roundedBox(0.34, 0.1, 0.2, 0.03).translate(4.15, 1.35, -7.8), RISK),
    paint(roundedBox(0.34, 0.1, 0.2, 0.03).translate(4.15, 1.05, -7.8), RISK),
    paint(roundedBox(0.34, 0.1, 0.2, 0.03).translate(4.65, 1.35, -7.8), RISK),
    paint(roundedBox(0.34, 0.1, 0.2, 0.03).translate(4.65, 1.05, -7.8), RISK),
    paint(roundedBox(0.14, 1.0, 0.14, 0.04).translate(2.6, 0.5, -7.8), FRAME),
    paint(roundedBox(0.14, 1.0, 0.14, 0.04).translate(4.4, 0.5, -7.8), FRAME),
  ];
  const annexMesh = new THREE.Mesh(mergeParts(annexParts), mats.matteVertex);
  annexMesh.name = "gauntletAnnex";
  annexMesh.castShadow = true;
  root.add(annexMesh);

  // Red X mark on the reject bin (data red, story-visible at distance).
  const rejectX = new THREE.Mesh(
    mergeParts([
      paint(
        roundedBox(0.7, 0.14, 0.04, 0.03)
          .rotateZ(0.785)
          .translate(4.3, 0.5, BELT_Z + 1.52),
        RISK,
      ),
      paint(
        roundedBox(0.7, 0.14, 0.04, 0.03)
          .rotateZ(-0.785)
          .translate(4.3, 0.5, BELT_Z + 1.52),
        RISK,
      ),
    ]),
    mats.dataRed,
  );
  rejectX.name = "rejectX";
  root.add(rejectX);

  // Budget-ruler sliding marker (R3 slides this along the gauge).
  const rulerMarker = new THREE.Mesh(
    mergeParts([paint(bevelSlab(0.5, 0.12, 0.16, 0.03).translate(2.6, 1.9, -7.6), RISK)]),
    mats.dataRed,
  );
  rulerMarker.name = "rulerMarker";
  root.add(rulerMarker);

  // --- R3 density: Static 4: cargo crates riding the belt as dressing. ---
  // Static dressing only; the STORY crate prop is placed separately.
  const BELT_TOP = 1.2;
  const crateParts: THREE.BufferGeometry[] = [];
  for (const cx of [-2.0, 0.6, 3.0]) {
    crateParts.push(
      paint(
        bevelSlab(0.85, 0.85, 0.85, 0.06).translate(cx, BELT_TOP + 0.43, BELT_Z),
        PALETTE.caramel,
      ),
      paint(
        bevelSlab(0.85, 0.85, 0.12, 0.05).translate(cx, BELT_TOP + 0.43, BELT_Z + 0.37),
        PALETTE.caramelLight,
      ),
      paint(
        bevelSlab(0.85, 0.85, 0.12, 0.05).translate(cx, BELT_TOP + 0.43, BELT_Z - 0.37),
        PALETTE.caramelLight,
      ),
      // Cyan check tally band (already-stamped count).
      paint(roundedBox(0.6, 0.12, 0.02, 0.02).translate(cx, BELT_TOP + 0.6, BELT_Z + 0.45), CYAN),
    );
  }
  const beltCargo = new THREE.Mesh(mergeParts(crateParts), mats.matteVertex);
  beltCargo.name = "gauntletBeltCargo";
  beltCargo.castShadow = true;
  root.add(beltCargo);

  // --- R3 density: Static 5: hopper funnel, station-7 ink/stamp rack. ---
  const detailParts: THREE.BufferGeometry[] = [
    // Coin hopper funnel at the belt output end (feeds the mint hand-off).
    paint(cone(0.6, 0.8, 10).translate(5.4, 1.0, BELT_Z), FRAME),
    paint(roundedBox(0.16, 0.9, 0.16, 0.04).translate(5.0, 0.45, BELT_Z + 0.4), FRAME),
    paint(roundedBox(0.16, 0.9, 0.16, 0.04).translate(5.8, 0.45, BELT_Z + 0.4), FRAME),
    paint(capsule(0.12, 0.5, 8).translate(5.4, 0.45, BELT_Z - 0.4), CYAN),
    // Ink pad + stamp rack beside station 7's desk.
    paint(bevelSlab(0.7, 0.45, 0.1, 0.03).translate(5.0, 1.24, 4.1), PALETTE_V2.boneWall),
    paint(roundedBox(0.34, 0.06, 0.28, 0.02).translate(4.88, 1.31, 4.1), PALETTE.slate),
    paint(roundedBox(0.34, 0.06, 0.28, 0.02).translate(5.2, 1.31, 4.1), CYAN),
    paint(roundedBox(0.08, 0.8, 0.08, 0.03).translate(4.8, 1.6, 3.6), FRAME),
    paint(roundedBox(0.08, 0.8, 0.08, 0.03).translate(5.2, 1.6, 3.6), FRAME),
    paint(bevelSlab(0.5, 0.3, 0.34, 0.03).translate(5.0, 1.9, 3.6), FRAME),
    paint(capsule(0.06, 0.18, 8).translate(4.88, 2.12, 3.6), PALETTE.brass),
    paint(capsule(0.06, 0.18, 8).translate(5.0, 2.12, 3.6), PALETTE.brass),
    paint(capsule(0.06, 0.18, 8).translate(5.12, 2.12, 3.6), PALETTE.brass),
  ];
  const detailMesh = new THREE.Mesh(mergeParts(detailParts), mats.matteVertex);
  detailMesh.name = "gauntletDetails";
  detailMesh.castShadow = true;
  root.add(detailMesh);

  // --- R3 density: the zone's emissive mesh (signGlow, vertex-colored). ---
  // Color-coded cable bundles linking stations 1->14 along both pylon rows,
  // plus the big flow arrow decal under the belt.
  const glowParts: THREE.BufferGeometry[] = [
    // Cable bundles: thin tubes along each pylon row, station 1 -> 7.
    paint(
      pipeAlong(
        [
          { x: STATION_X0, y: 0.95, z: ROW_BACK },
          { x: STATION_X0 + 3.9, y: 0.95, z: ROW_BACK },
          { x: STATION_X0 + 6 * STATION_DX, y: 0.95, z: ROW_BACK },
        ],
        0.035,
        4,
      ),
      CYAN,
    ),
    paint(
      pipeAlong(
        [
          { x: STATION_X0, y: 0.95, z: ROW_FRONT },
          { x: STATION_X0 + 3.9, y: 0.95, z: ROW_FRONT },
          { x: STATION_X0 + 6 * STATION_DX, y: 0.95, z: ROW_FRONT },
        ],
        0.035,
        4,
      ),
      CYAN,
    ),
    // Flow arrow decal: three emissive chevrons on the deck under the belt.
    ...[-2.2, 0.4, 3.0].flatMap((ax) => [
      paint(
        roundedBox(0.7, 0.04, 0.16, 0.02)
          .rotateY(0.7)
          .translate(ax, 0.03, BELT_Z - 0.4),
        CYAN,
      ),
      paint(
        roundedBox(0.7, 0.04, 0.16, 0.02)
          .rotateY(-0.7)
          .translate(ax, 0.03, BELT_Z + 0.4),
        CYAN,
      ),
    ]),
  ];
  const glowMesh = new THREE.Mesh(mergeParts(glowParts), mats.signGlow);
  glowMesh.name = "gauntletGlow";
  root.add(glowMesh);

  // --- Anchors. ---
  root.add(anchor("gauntletIn", PLATE_X0 - 1, 1.3, BELT_Z)); // belt entry (activation side)
  root.add(anchor("gauntletOut", PLATE_X1, 1.3, BELT_Z)); // belt exit (mint hand-off)
  root.add(anchor("gauntletReject", 4.3, 0.8, BELT_Z + 2.0)); // red-X bin
  root.add(anchor("budgetRuler", 2.6, 1.3, -7.4));
  root.add(anchor("tagDispenser", 4.4, 1.3, -7.4));
  root.add(anchor("beltZone", (PLATE_X0 + PLATE_X1) / 2, 1.2, BELT_Z));

  return root;
}

/** Tick marks for the budget-ruler gauge board at (x, z), spanning y 0.35..2.3. */
function rulerTicks(x: number, z: number): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i <= 8; i++) {
    const y = 0.35 + (i / 8) * 1.9;
    const major = i % 2 === 0;
    parts.push(
      paint(
        roundedBox(major ? 0.34 : 0.2, 0.05, 0.03, 0.01).translate(x - (major ? 0.7 : 0.82), y, z),
        PALETTE_V2.zones.risk,
      ),
    );
  }
  return parts;
}
