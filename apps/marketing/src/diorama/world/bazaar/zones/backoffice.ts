/**
 * BACK OFFICE zone shell (R2): x [+15, +21], blue #5B8DEF.
 *
 * Glossy tinted floor plate; the event-capsule tube wall on the back edge (six
 * vertical tubes with parked emissive capsules + a slide into the filing
 * silo); two reused accountant desks; and the signature FERRY DOCK vignette
 * at the front edge: a glossy water strip, a dock plank, a cute boat with a
 * lantern, and the TRUTH monolith (white slab, mint lines) across the strip.
 * Not imported anywhere yet (R2 shell chunk).
 *
 * Mesh budget: 1 tinted plate + 1 water plate (both zonePlate) + 1 merged
 * matte static + 1 merged emissive (parked capsules + mint monolith lines);
 * the boat is a separate named animatable group, the desks are reused props.
 */

import * as THREE from "three";
import { PALETTE, PALETTE_V2 } from "../../../config";
import {
  bevelSlab,
  capsule,
  cone,
  disc,
  mergeParts,
  paint,
  pipeAlong,
  roundedBox,
} from "../../../geometry";
import type { MaterialLibrary } from "../../../render/materials";
import type { ResourceRegistry } from "../../../render/resources";
import { buildDesk } from "../../../props/furniture";
import type { WorldPart } from "../../plinth";

export const ZONE_BACKOFFICE_VERSION = 1;

/** Bay footprint (09-layout-spec.md zone 7). */
const X0 = 15;
const X1 = 21;
const Z0 = -9;
const Z1 = 5;
const CX = (X0 + X1) / 2;

/** Tube wall: six tubes, A..F from left to right, against the back wall. */
const TUBE_Z = -8.3;
const TUBE_X0 = 15.7;
const TUBE_SPACING = 0.58;
/** Parked capsule heights per tube (2-3 each), y = height above deck. */
const TUBE_CAPSULE_Y: readonly (readonly number[])[] = [
  [0.7, 1.5, 2.4],
  [1.0, 2.1],
  [0.6, 1.6, 2.6],
  [0.9, 1.9],
  [0.7, 1.5, 2.3],
  [1.1, 2.2],
];

/** Filing silo silhouette. */
const SILO = { x: 20.3, z: -6.6 } as const;

/** Ferry dock layout (front edge). */
const WATER = { x0: 15.8, x1: 19.4, z0: 3.4, z1: 6.6 } as const;
const BOAT = { x: 17.6, z: 4.9 } as const;
const MONOLITH = { x: 17.6, z: 6.9 } as const;

function anchor(name: string, x: number, y: number, z: number): THREE.Object3D {
  const o = new THREE.Object3D();
  o.name = name;
  o.position.set(x, y, z);
  return o;
}

export function buildBackOfficeZone(mats: MaterialLibrary, registry: ResourceRegistry): WorldPart {
  const group = new THREE.Group();
  group.name = "zoneBackOffice";

  const tint = PALETTE_V2.zoneFloorTint.backOffice;
  const zone = PALETTE_V2.zoneEmissive.backOffice;
  const frame = PALETTE_V2.slateFrame;
  const bone = PALETTE_V2.boneDeckLight;

  // ----- Floor plate ----------------------------------------------------------
  const plateGeo = registry.track(
    mergeParts([paint(bevelSlab(X1 - X0 - 0.3, Z1 - Z0 - 0.3, 0.12, 0.04), tint)]),
  );
  const plate = new THREE.Mesh(plateGeo, mats.zonePlate);
  plate.name = "backOfficePlate";
  plate.position.set(CX, 0.06, (Z0 + Z1) / 2);
  plate.receiveShadow = true;
  group.add(plate);
  const statics: THREE.Mesh[] = [plate];

  // ----- Water strip (glossy saturated zone blue on the same plate material) --
  const waterGeo = registry.track(
    mergeParts([
      paint(
        bevelSlab(WATER.x1 - WATER.x0, WATER.z1 - WATER.z0, 0.08, 0.03),
        PALETTE_V2.zones.backOffice,
      ),
    ]),
  );
  const water = new THREE.Mesh(waterGeo, mats.zonePlate);
  water.name = "ferryWater";
  water.position.set((WATER.x0 + WATER.x1) / 2, 0.05, (WATER.z0 + WATER.z1) / 2);
  group.add(water);
  statics.push(water);

  // ----- Merged matte static: tube wall, slide, silo, dock, monolith ----------
  const matteParts: THREE.BufferGeometry[] = [
    // Tube wall rack: top and bottom bars spanning all six tubes.
    paint(
      bevelSlab(TUBE_SPACING * 5 + 1.0, 0.3, 0.5, 0.08).translate(
        TUBE_X0 + TUBE_SPACING * 2.5,
        3.6,
        TUBE_Z,
      ),
      frame,
    ),
    paint(
      bevelSlab(TUBE_SPACING * 5 + 1.4, 0.5, 0.3, 0.06).translate(
        TUBE_X0 + TUBE_SPACING * 2.5,
        0.15,
        TUBE_Z,
      ),
      frame,
    ),
  ];
  for (let t = 0; t < TUBE_CAPSULE_Y.length; t++) {
    matteParts.push(
      paint(capsule(0.24, 3.3, 10).translate(TUBE_X0 + t * TUBE_SPACING, 1.85, TUBE_Z), frame),
    );
  }
  matteParts.push(
    // Catch tray + diagonal slide from the tray end up into the silo mouth.
    paint(
      bevelSlab(TUBE_SPACING * 5 + 0.8, 0.5, 0.16, 0.04).translate(
        TUBE_X0 + TUBE_SPACING * 2.5,
        0.5,
        TUBE_Z + 0.4,
      ),
      PALETTE_V2.slateFrame,
    ),
    paint(
      pipeAlong(
        [
          { x: TUBE_X0 + TUBE_SPACING * 5 + 0.3, y: 0.6, z: TUBE_Z + 0.5 },
          { x: SILO.x - 0.9, y: 1.7, z: SILO.z + 0.4 },
          { x: SILO.x, y: 2.8, z: SILO.z },
        ],
        0.14,
        6,
      ),
      frame,
    ),
    // Filing silo: round tower with a bone band and a low cap.
    paint(capsule(0.95, 2.4, 16).translate(SILO.x, 1.35, SILO.z), frame),
    paint(capsule(0.99, 0.1, 16).translate(SILO.x, 2.0, SILO.z), bone),
    paint(cone(0.7, 0.6, 12).translate(SILO.x, 3.3, SILO.z), PALETTE_V2.boneWall),
    // Dock plank at the near edge of the water, on two posts.
    paint(
      bevelSlab(2.2, 0.7, 0.14, 0.05).translate(BOAT.x, 0.32, WATER.z0 - 0.35),
      PALETTE.caramelLight,
    ),
    paint(
      roundedBox(0.12, 0.3, 0.12, 0.04).translate(BOAT.x - 0.9, 0.15, WATER.z0 - 0.35),
      PALETTE.caramel,
    ),
    paint(
      roundedBox(0.12, 0.3, 0.12, 0.04).translate(BOAT.x + 0.9, 0.15, WATER.z0 - 0.35),
      PALETTE.caramel,
    ),
    // TRUTH monolith: white slab across the water, slightly tall and thin.
    paint(
      bevelSlab(0.9, 0.4, 2.7, 0.08).translate(MONOLITH.x, 1.35, MONOLITH.z),
      PALETTE_V2.boneWall,
    ),
    paint(bevelSlab(1.05, 0.55, 0.16, 0.05).translate(MONOLITH.x, 0.08, MONOLITH.z), frame),
  );
  const matteGeo = registry.track(mergeParts(matteParts));
  const matteMesh = new THREE.Mesh(matteGeo, mats.matteVertex);
  matteMesh.name = "backOfficeStatic";
  matteMesh.castShadow = true;
  matteMesh.receiveShadow = true;
  group.add(matteMesh);
  statics.push(matteMesh);

  // ----- Merged emissive: parked capsules + monolith mint lines ---------------
  const emissiveParts: THREE.BufferGeometry[] = [
    // Monolith truth lines (site accent mint).
    paint(
      roundedBox(0.5, 0.06, 0.03, 0.01).translate(MONOLITH.x, 2.1, MONOLITH.z + 0.21),
      PALETTE_V2.eyeEmissive,
    ),
    paint(
      roundedBox(0.5, 0.06, 0.03, 0.01).translate(MONOLITH.x, 1.7, MONOLITH.z + 0.21),
      PALETTE_V2.eyeEmissive,
    ),
    paint(
      roundedBox(0.5, 0.06, 0.03, 0.01).translate(MONOLITH.x, 1.3, MONOLITH.z + 0.21),
      PALETTE_V2.eyeEmissive,
    ),
  ];
  for (let t = 0; t < TUBE_CAPSULE_Y.length; t++) {
    for (const y of TUBE_CAPSULE_Y[t]) {
      emissiveParts.push(
        paint(capsule(0.13, 0.16, 8).translate(TUBE_X0 + t * TUBE_SPACING, y, TUBE_Z), zone),
      );
    }
  }
  const emissiveGeo = registry.track(mergeParts(emissiveParts));
  const emissiveMesh = new THREE.Mesh(emissiveGeo, mats.signGlow);
  emissiveMesh.name = "backOfficeGlow";
  group.add(emissiveMesh);

  // ----- Boat: named animatable group with its own lantern glow ---------------
  const boat = new THREE.Group();
  boat.name = "boat";
  boat.position.set(BOAT.x, 0.08, BOAT.z);
  const hullGeo = registry.track(
    mergeParts([
      // Chunky hull with a pointed bow toward the monolith (+Z).
      paint(bevelSlab(0.8, 1.5, 0.42, 0.1).translate(0, 0.21, 0), PALETTE_V2.zones.backOffice),
      paint(
        cone(0.42, 0.5, 6)
          .rotateX(Math.PI / 2)
          .translate(0, 0.24, 0.95),
        PALETTE_V2.zones.backOffice,
      ),
      // Bench + tiny cabin + lantern post.
      paint(bevelSlab(0.5, 0.16, 0.1, 0.03).translate(0, 0.44, -0.1), PALETTE_V2.boneDeckLight),
      paint(bevelSlab(0.55, 0.5, 0.4, 0.06).translate(0, 0.68, -0.45), PALETTE_V2.boneWall),
      paint(roundedBox(0.05, 0.9, 0.05, 0.02).translate(0.28, 0.85, 0.35), PALETTE.caramel),
    ]),
  );
  const hull = new THREE.Mesh(hullGeo, mats.matteVertex);
  hull.castShadow = true;
  boat.add(hull);
  const lantern = new THREE.Mesh(
    registry.track(mergeParts([paint(capsule(0.07, 0.06, 8), PALETTE.warmKey)])),
    mats.signGlow,
  );
  lantern.name = "lantern";
  lantern.position.set(0.28, 1.32, 0.35);
  boat.add(lantern);
  group.add(boat);

  // ----- Accountant desks (reused furniture) -----------------------------------
  const deskA = buildDesk(mats);
  deskA.name = "deskA";
  deskA.position.set(16.2, 0.12, -3.4);
  deskA.rotation.y = 0.12;
  group.add(deskA);
  const deskB = buildDesk(mats);
  deskB.name = "deskB";
  deskB.position.set(18.9, 0.12, -3.4);
  deskB.rotation.y = -0.12;
  group.add(deskB);

  // ----- R3 density: chutes, magnifier arm, bundles, bell (merged) ------------
  // Two clear diagonal chutes dropping event capsules from the tube wall into
  // the silo; the reconciler's magnifier arm arched over the ferry dock;
  // stamped-document bundles on both desks; a small bell at the dock.
  const magBase = { x: WATER.x0 + 0.4, z: WATER.z0 - 0.1 } as const;
  const deskTopY = 0.12 + 1.31; // desk prop origin + tabletop surface
  const detailGeo = registry.track(
    mergeParts([
      // Clear chutes: thin pale tubes from tube-wall mid-height into the silo cap.
      paint(
        pipeAlong(
          [
            { x: TUBE_X0 + TUBE_SPACING, y: 1.4, z: TUBE_Z + 0.3 },
            { x: SILO.x - 1.4, y: 1.8, z: SILO.z + 0.9 },
            { x: SILO.x - 0.3, y: 2.9, z: SILO.z + 0.2 },
          ],
          0.1,
          5,
        ),
        PALETTE_V2.boneDeckLight,
      ),
      paint(
        pipeAlong(
          [
            { x: TUBE_X0 + TUBE_SPACING * 4, y: 1.2, z: TUBE_Z + 0.3 },
            { x: SILO.x - 1.0, y: 1.5, z: SILO.z + 1.1 },
            { x: SILO.x + 0.1, y: 2.8, z: SILO.z + 0.4 },
          ],
          0.1,
          5,
        ),
        PALETTE_V2.boneDeckLight,
      ),
      // Magnifier arm: post at the dock corner, arm over the water, ring + lens.
      paint(roundedBox(0.12, 2.8, 0.12, 0.04).translate(magBase.x, 1.4, magBase.z), frame),
      paint(
        capsule(0.06, 2.4, 6)
          .rotateZ(Math.PI / 2)
          .translate(magBase.x + 1.1, 2.75, magBase.z + 0.9),
        frame,
      ),
      paint(
        capsule(0.42, 0.08, 14)
          .rotateX(Math.PI / 2)
          .translate(magBase.x + 2.2, 2.55, magBase.z + 1.5),
        frame,
      ),
      paint(
        disc(0.34, 12)
          .rotateX(Math.PI / 2)
          .translate(magBase.x + 2.2, 2.55, magBase.z + 1.56),
        bone,
      ),
      // Stamped document bundles (cream paper slabs with a band each).
      paint(
        bevelSlab(0.55, 0.4, 0.1, 0.03).translate(16.2 + 0.5, deskTopY, -3.4 + 0.2),
        PALETTE.cream,
      ),
      paint(
        bevelSlab(0.58, 0.12, 0.04, 0.01).translate(16.2 + 0.5, deskTopY + 0.07, -3.4 + 0.2),
        PALETTE.caramelLight,
      ),
      paint(
        bevelSlab(0.55, 0.4, 0.14, 0.03).translate(18.9 - 0.4, deskTopY + 0.02, -3.4 - 0.1),
        PALETTE.cream,
      ),
      paint(
        bevelSlab(0.58, 0.12, 0.04, 0.01).translate(18.9 - 0.4, deskTopY + 0.11, -3.4 - 0.1),
        PALETTE.caramelLight,
      ),
      // Ferry bell: brass dome on a short post at the dock edge.
      paint(roundedBox(0.06, 0.7, 0.06, 0.02).translate(BOAT.x + 1.0, 0.7, WATER.z0 - 0.5), frame),
      paint(cone(0.16, 0.2, 8).translate(BOAT.x + 1.0, 1.15, WATER.z0 - 0.5), PALETTE.brass),
    ]),
  );
  const detailMesh = new THREE.Mesh(detailGeo, mats.matteVertex);
  detailMesh.name = "backOfficeDetail";
  detailMesh.castShadow = true;
  group.add(detailMesh);
  statics.push(detailMesh);

  // ----- R3 emissive: wake lines on the water (merged) -------------------------
  // Curved pale-blue trailing lines behind the boat, reading as rowing wakes.
  const wakeGeo = registry.track(
    mergeParts([
      paint(
        bevelSlab(0.5, 0.05, 0.02, 0.01)
          .rotateY(0.5)
          .translate(BOAT.x - 0.7, 0.1, BOAT.z + 0.9),
        zone,
      ),
      paint(
        bevelSlab(0.5, 0.05, 0.02, 0.01)
          .rotateY(-0.5)
          .translate(BOAT.x + 0.7, 0.1, BOAT.z + 0.9),
        zone,
      ),
      paint(bevelSlab(0.9, 0.04, 0.02, 0.01).translate(BOAT.x, 0.1, BOAT.z + 1.5), zone),
    ]),
  );
  const wakeMesh = new THREE.Mesh(wakeGeo, mats.signGlow);
  wakeMesh.name = "backOfficeGlowDetail";
  group.add(wakeMesh);

  // ----- Anchors ----------------------------------------------------------------
  const anchors: Record<string, THREE.Object3D> = {
    tubeWall: anchor("tubeWall", TUBE_X0 + TUBE_SPACING * 2.5, 0.2, TUBE_Z),
    silo: anchor("silo", SILO.x, 0.2, SILO.z),
    ferryDock: anchor("ferryDock", BOAT.x, 0.4, WATER.z0 - 0.35),
    boat: anchor("boat", BOAT.x, 0.4, BOAT.z),
    truthMonolith: anchor("truthMonolith", MONOLITH.x, 0.2, MONOLITH.z),
    deskA: anchor("deskA", 16.2, 0.2, -3.4),
    deskB: anchor("deskB", 18.9, 0.2, -3.4),
  };
  // Parked capsule anchors capsuleA1..F3 at each emissive pill position so the
  // story can address them (the pills themselves are merged for draw calls).
  for (let t = 0; t < TUBE_CAPSULE_Y.length; t++) {
    const tubeId = String.fromCharCode("A".charCodeAt(0) + t);
    TUBE_CAPSULE_Y[t].forEach((y, i) => {
      const name = `capsule${tubeId}${i + 1}`;
      anchors[name] = anchor(name, TUBE_X0 + t * TUBE_SPACING, y, TUBE_Z);
    });
  }
  for (const a of Object.values(anchors)) group.add(a);

  return { group, statics, anchors };
}
