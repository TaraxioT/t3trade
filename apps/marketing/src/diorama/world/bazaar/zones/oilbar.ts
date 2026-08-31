/**
 * OIL BAR zone shell (R2): front-right pocket x [+16, +21], z [+8, +12], mint
 * #3DDC97.
 *
 * Small glossy tinted plate, a curved counter (angled slab segments), three
 * reused stools, the coffee-station builder reused as the oil-tap machine
 * (neutral caramel/slate chassis reads fine against the mint tint), and a
 * hanging mug rail with an emissive mint under-rail light strip. Not imported
 * anywhere yet (R2 shell chunk).
 *
 * Mesh budget: 1 zonePlate plate + 1 merged matte static (counter, tap
 * backbar, mug rail, mugs) + 1 merged emissive (under-rail strip); stools and
 * the oil-tap are reused props.
 */

import * as THREE from "three";
import { PALETTE, PALETTE_V2 } from "../../../config";
import { bevelSlab, capsule, mergeParts, paint, roundedBox } from "../../../geometry";
import type { MaterialLibrary } from "../../../render/materials";
import type { ResourceRegistry } from "../../../render/resources";
import { buildCoffeeStation, buildStool } from "../../../props/furniture";
import type { WorldPart } from "../../plinth";

export const ZONE_OILBAR_VERSION = 1;

/** Pocket footprint (09-layout-spec.md zone 8). */
const X0 = 16;
const X1 = 21;
const Z0 = 8;
const Z1 = 12;
const CX = (X0 + X1) / 2;
const CZ = (Z0 + Z1) / 2;

/** Counter runs along the back edge of the pocket (z ~ 10.6), bowing forward. */
const COUNTER_Z = 10.5;
const STOOL_Z = 9.3;

function anchor(name: string, x: number, y: number, z: number): THREE.Object3D {
  const o = new THREE.Object3D();
  o.name = name;
  o.position.set(x, y, z);
  return o;
}

export function buildOilBarZone(mats: MaterialLibrary, registry: ResourceRegistry): WorldPart {
  const group = new THREE.Group();
  group.name = "zoneOilBar";

  const tint = PALETTE_V2.zoneFloorTint.oilBar;
  const zone = PALETTE_V2.zoneEmissive.oilBar;
  const frame = PALETTE_V2.slateFrame;

  // ----- Floor plate -----------------------------------------------------------
  const plateGeo = registry.track(
    mergeParts([paint(bevelSlab(X1 - X0 - 0.4, Z1 - Z0 - 0.4, 0.12, 0.04), tint)]),
  );
  const plate = new THREE.Mesh(plateGeo, mats.zonePlate);
  plate.name = "oilBarPlate";
  plate.position.set(CX, 0.06, CZ);
  plate.receiveShadow = true;
  group.add(plate);
  const statics: THREE.Mesh[] = [plate];

  // ----- Merged matte static: curved counter, mug rail, mugs --------------------
  // Curve: five short segments on a shallow arc, each rotated to face front.
  const segs = 5;
  const span = X1 - X0 - 1.3;
  const matteParts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < segs; i++) {
    const t = i / (segs - 1) - 0.5; // [-0.5, +0.5]
    const x = CX + t * span;
    const z = COUNTER_Z - Math.cos(t * Math.PI) * 0.55 + 0.55; // bows toward +Z center
    const yaw = -t * 0.7;
    matteParts.push(
      paint(
        bevelSlab(span / segs + 0.34, 0.75, 0.16, 0.05)
          .rotateY(yaw)
          .translate(x, 0.95, z),
        PALETTE_V2.boneDeck,
      ),
      paint(
        roundedBox(0.14, 0.85, 0.14, 0.05)
          .rotateY(yaw)
          .translate(x - Math.cos(yaw) * 0.4, 0.45, z + Math.sin(yaw) * 0.4),
        frame,
      ),
    );
  }
  matteParts.push(
    // Hanging mug rail: two posts + a brass bar above the counter center.
    paint(roundedBox(0.1, 2.6, 0.1, 0.04).translate(CX - 1.5, 1.3, COUNTER_Z - 0.5), frame),
    paint(roundedBox(0.1, 2.6, 0.1, 0.04).translate(CX + 1.5, 1.3, COUNTER_Z - 0.5), frame),
    paint(
      capsule(0.05, 3.0, 8)
        .rotateZ(Math.PI / 2)
        .translate(CX, 2.45, COUNTER_Z - 0.45),
      PALETTE_V2.slateFrame,
    ),
    // Three little mugs hanging from the rail (capsule bodies + hook nubs).
    ...[-0.9, 0, 0.9].map((dx) =>
      paint(capsule(0.09, 0.12, 8).translate(CX + dx, 2.2, COUNTER_Z - 0.45), PALETTE_V2.boneWall),
    ),
    ...[-0.9, 0, 0.9].map((dx) =>
      paint(roundedBox(0.03, 0.1, 0.03, 0.01).translate(CX + dx, 2.34, COUNTER_Z - 0.45), frame),
    ),
  );
  const matteGeo = registry.track(mergeParts(matteParts));
  const matteMesh = new THREE.Mesh(matteGeo, mats.matteVertex);
  matteMesh.name = "oilBarStatic";
  matteMesh.castShadow = true;
  matteMesh.receiveShadow = true;
  group.add(matteMesh);
  statics.push(matteMesh);

  // ----- Merged emissive: mint under-rail light strip ----------------------------
  const emissiveGeo = registry.track(
    mergeParts([
      paint(bevelSlab(3.1, 0.05, 0.03, 0.01).translate(CX, 2.38, COUNTER_Z - 0.3), zone),
      // Pour-point glow pad on the counter under the tap spout.
      paint(roundedBox(0.4, 0.02, 0.3, 0.01).translate(CX - 0.65, 1.08, COUNTER_Z - 0.07), zone),
    ]),
  );
  const emissiveMesh = new THREE.Mesh(emissiveGeo, mats.signGlow);
  emissiveMesh.name = "oilBarGlow";
  group.add(emissiveMesh);

  // ----- Oil tap (coffee-station builder reused) + stools ------------------------
  const tap = buildCoffeeStation(mats);
  tap.name = "oilTap";
  tap.position.set(CX - 0.4, 0.12, COUNTER_Z - 0.15);
  tap.rotation.y = Math.PI; // spout faces the pocket front
  group.add(tap);

  const stoolXs = [CX - 1.4, CX, CX + 1.4];
  stoolXs.forEach((x, i) => {
    const stool = buildStool(mats);
    stool.name = `stool${i + 1}`;
    stool.position.set(x, 0.12, STOOL_Z);
    group.add(stool);
  });

  // ----- R3 density: mug pyramid, tap handle, snack bowl, wall clock ----------
  const detailGeo = registry.track(
    mergeParts([
      // Mug pyramid on the counter end: 3 + 2 + 1 stack of tiny mugs.
      ...[-0.32, 0, 0.32].map((dx) =>
        paint(
          capsule(0.09, 0.12, 8).translate(CX + 1.7 + dx, 1.12, COUNTER_Z + 0.1),
          PALETTE_V2.boneWall,
        ),
      ),
      ...[-0.16, 0.16].map((dx) =>
        paint(
          capsule(0.09, 0.12, 8).translate(CX + 1.7 + dx, 1.32, COUNTER_Z + 0.1),
          PALETTE_V2.boneDeck,
        ),
      ),
      paint(capsule(0.09, 0.12, 8).translate(CX + 1.7, 1.52, COUNTER_Z + 0.1), PALETTE_V2.boneWall),
      // Tap handle: chunky lever on the machine's top front.
      paint(
        roundedBox(0.1, 0.4, 0.1, 0.04)
          .rotateX(0.5)
          .translate(CX - 0.4, 1.95, COUNTER_Z + 0.25),
        frame,
      ),
      paint(capsule(0.05, 0.06, 8).translate(CX - 0.4, 2.12, COUNTER_Z + 0.36), PALETTE.brass),
      // Bar snack bowl: shallow bone bowl with tiny dark bolt nubs.
      paint(
        capsule(0.22, 0.06, 12).translate(CX - 1.8, 1.1, COUNTER_Z + 0.05),
        PALETTE_V2.boneWall,
      ),
      ...[-0.08, 0.06, 0.0, 0.12].map((dx, i) =>
        paint(
          roundedBox(0.06, 0.05, 0.06, 0.02).translate(
            CX - 1.8 + dx,
            1.16,
            COUNTER_Z + (i % 2 ? 0.04 : -0.03),
          ),
          frame,
        ),
      ),
      // "Shift ended" wall clock: back-posted round silhouette at the pocket edge.
      paint(roundedBox(0.1, 1.6, 0.1, 0.04).translate(CX + 2.3, 1.9, COUNTER_Z - 1.2), frame),
      paint(
        capsule(0.45, 0.1, 16)
          .rotateX(Math.PI / 2)
          .translate(CX + 2.3, 2.85, COUNTER_Z - 1.0),
        PALETTE_V2.boneWall,
      ),
      paint(roundedBox(0.04, 0.24, 0.02, 0.01).translate(CX + 2.3, 2.85, COUNTER_Z - 0.86), frame),
      paint(roundedBox(0.16, 0.04, 0.02, 0.01).translate(CX + 2.34, 2.85, COUNTER_Z - 0.86), frame),
    ]),
  );
  const detailMesh = new THREE.Mesh(detailGeo, mats.matteVertex);
  detailMesh.name = "oilBarDetail";
  detailMesh.castShadow = true;
  group.add(detailMesh);
  statics.push(detailMesh);

  // ----- R3 emissive: mint drip light under the tap handle ----------------------
  const dripGeo = registry.track(
    mergeParts([
      paint(capsule(0.04, 0.1, 6).translate(CX - 0.4, 1.86, COUNTER_Z + 0.32), zone),
      paint(capsule(0.05, 0.04, 6).translate(CX - 0.4, 1.78, COUNTER_Z + 0.32), zone),
    ]),
  );
  const dripMesh = new THREE.Mesh(dripGeo, mats.signGlow);
  dripMesh.name = "oilBarGlowDetail";
  group.add(dripMesh);

  // ----- Anchors -------------------------------------------------------------------
  const anchors: Record<string, THREE.Object3D> = {
    oilBarPad: anchor("oilBarPad", CX, 0.2, CZ),
    oilTap: anchor("oilTap", CX - 0.4, 1.2, COUNTER_Z - 0.15),
    stool1: anchor("stool1", stoolXs[0], 0.2, STOOL_Z),
    stool2: anchor("stool2", stoolXs[1], 0.2, STOOL_Z),
    stool3: anchor("stool3", stoolXs[2], 0.2, STOOL_Z),
  };
  for (const a of Object.values(anchors)) group.add(a);

  return { group, statics, anchors };
}
