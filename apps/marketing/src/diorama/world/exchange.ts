/**
 * Exchange satellite pad (M04b): the subordinate pristine level floating at
 * (16, 13, -6).
 *
 * Deliberately cleaner than the bureau: a thin slate-and-cream slab, a wall
 * of small slots with three named mint slots, a robotic arm with named yaw /
 * pitch / claw pivots, a brass mint press, a confetti cone, and the pipe
 * bridge back to the bureau roof (main pipe plus a thin parallel return pipe
 * ending above the vault receipt tray). No clutter, no bots placed here.
 */

import * as THREE from "three";
import { DIMENSIONS, PALETTE } from "../config";
import { bevelSlab, capsule, cone, mergeParts, paint, pipeAlong, roundedBox } from "../geometry";
import type { MaterialLibrary } from "../render/materials";
import type { ResourceRegistry } from "../render/resources";
import { STATIONS } from "../story/waypoints";
import type { WorldPart } from "./plinth";

export const EXCHANGE_VERSION = 1;

const S = DIMENSIONS.satellite;

export function buildExchange(mats: MaterialLibrary, registry: ResourceRegistry): WorldPart {
  const group = new THREE.Group();
  group.name = "exchange";
  const st = STATIONS;

  // Named empties the story addresses.
  const pipeArrival = new THREE.Object3D();
  pipeArrival.name = "pipeArrival";
  pipeArrival.position.set(st.pipeArrival.x, st.pipeArrival.y + 0.6, st.pipeArrival.z);

  const pop = new THREE.Object3D();
  pop.name = "pop";
  pop.position.set(st.pipeArrival.x + 2.2, st.pipeArrival.y + 0.9, st.pipeArrival.z + 1.4);

  const returnEnd = new THREE.Object3D();
  returnEnd.name = "returnEnd";
  returnEnd.position.set(st.receiptTray.x, 1.6, st.receiptTray.z);

  // ----- Static bake: pad, slot wall body, arm base, mint base, pipes ------
  const padSize = S.padRadius * 2 - 0.6;
  const slot = st.slotWall;
  const mint = st.mintStation;

  const parts: THREE.BufferGeometry[] = [
    // Floating pad: thin slate slab with a cream trim band, chamfered edge.
    paint(
      bevelSlab(padSize, padSize, S.padThickness, 0.22).translate(
        S.x,
        S.y - S.padThickness / 2,
        S.z,
      ),
      PALETTE.slate,
    ),
    paint(
      bevelSlab(padSize - 0.5, padSize - 0.5, 0.14, 0.05).translate(S.x, S.y + 0.02, S.z),
      PALETTE.cream,
    ),
    // Slot wall body with a grid of dark recesses (named slots are separate).
    paint(
      bevelSlab(3.2, 2.4, 0.4, 0.08).translate(slot.x, S.y + 1.2, slot.z),
      PALETTE.creamWallLight,
    ),
  ];
  // Slot recess grid painted onto the wall face (face normal toward the pad).
  const wallYaw = slot.facing ?? 0;
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) {
      const lx = -1.05 + c * 0.7;
      const ly = 0.55 + r * 0.62;
      const g = bevelSlab(0.44, 0.4, 0.08, 0.02);
      g.rotateY(wallYaw);
      const cos = Math.cos(wallYaw);
      const sin = Math.sin(wallYaw);
      g.translate(
        slot.x + lx * cos + 0.24 * sin,
        S.y + 1.2 + ly - 0.9,
        slot.z - lx * sin + 0.24 * cos,
      );
      parts.push(paint(g, PALETTE.slateDark));
    }
  }
  parts.push(
    // Mint station base block.
    paint(roundedBox(1.4, 1.0, 1.2, 0.08).translate(mint.x, S.y + 0.5, mint.z), PALETTE.cream),
    paint(roundedBox(1.1, 0.16, 0.9, 0.05).translate(mint.x, S.y + 1.02, mint.z), PALETTE.slate),
    // Robotic arm pedestal (the yaw pivot above it carries the arm).
    paint(capsule(0.55, 0.5, 12).translate(S.x + 0.6, S.y + 0.35, S.z - 0.5), PALETTE.slateDark),
    // Confetti cannon: small slate cone near the pad edge.
    paint(
      cone(0.35, 0.9, 8).translate(pop.position.x, S.y + 0.45, pop.position.z),
      PALETTE.slateDark,
    ),
    // Main bridge pipe: pipeMouth on the roof pylon -> rise -> pad edge.
    paint(
      pipeAlong(
        [
          { x: st.bridgeAnchor.x, y: st.bridgeAnchor.y + 1.6, z: st.bridgeAnchor.z },
          {
            x: (st.bridgeAnchor.x + S.x) / 2,
            y: S.y + DIMENSIONS.bridge.midRise - 1.0,
            z: (st.bridgeAnchor.z + S.z) / 2,
          },
          { x: S.x - 2.6, y: S.y + 0.7, z: S.z + 0.4 },
          { x: st.pipeArrival.x, y: st.pipeArrival.y + 0.5, z: st.pipeArrival.z },
        ],
        DIMENSIONS.bridge.pipeRadius,
        8,
      ),
      PALETTE.slateDark,
    ),
    // Thin return pipe, parallel offset, ending above the vault tray.
    paint(
      pipeAlong(
        [
          { x: S.x + 1.0, y: S.y + 0.8, z: S.z + 1.0 },
          {
            x: (st.bridgeAnchor.x + S.x) / 2 + 1.2,
            y: S.y + DIMENSIONS.bridge.midRise - 1.6,
            z: (st.bridgeAnchor.z + S.z) / 2 + 1.2,
          },
          { x: st.bridgeAnchor.x + 0.8, y: st.bridgeAnchor.y + 2.4, z: st.bridgeAnchor.z + 0.8 },
          { x: 4.5, y: 6.5, z: st.receiptTray.z + 0.5 },
          { x: returnEnd.position.x, y: returnEnd.position.y, z: returnEnd.position.z },
        ],
        0.2,
        6,
      ),
      PALETTE.slate,
    ),
    // Return-pipe endpoint collar above the receipt tray arc.
    paint(
      capsule(0.34, 0.2, 10).translate(
        returnEnd.position.x,
        returnEnd.position.y,
        returnEnd.position.z,
      ),
      PALETTE.brass,
    ),
  );

  const merged = registry.track(mergeParts(parts));
  const padMesh = new THREE.Mesh(merged, mats.matteVertex);
  padMesh.name = "exchangeStatic";
  padMesh.castShadow = true;
  padMesh.receiveShadow = true;
  group.add(padMesh);
  const statics: THREE.Mesh[] = [padMesh];

  // ----- Named slot marks (the story lights these on fills) -----------------
  const slots: THREE.Mesh[] = [];
  const slotSpecs: readonly { name: string; lx: number; ly: number }[] = [
    { name: "slotA", lx: -1.05, ly: 0.55 },
    { name: "slotB", lx: -0.35, ly: 1.17 },
    { name: "slotC", lx: 0.35, ly: 1.79 },
  ];
  const cos = Math.cos(wallYaw);
  const sin = Math.sin(wallYaw);
  for (const spec of slotSpecs) {
    const g = registry.track(
      mergeParts([paint(bevelSlab(0.44, 0.4, 0.06, 0.02), PALETTE.mintBright)]),
    );
    const mesh = new THREE.Mesh(g, mats.eyeMint);
    mesh.name = spec.name;
    mesh.position.set(
      slot.x + spec.lx * cos + 0.3 * sin,
      S.y + 1.2 + spec.ly - 0.9,
      slot.z - spec.lx * sin + 0.3 * cos,
    );
    mesh.rotation.y = wallYaw;
    group.add(mesh);
    slots.push(mesh);
  }

  // ----- Robotic arm with named pivots ---------------------------------------
  // armBase: yaw pivot on the pedestal. armLift: pitch pivot. claw: gripper.
  const armBase = new THREE.Group();
  armBase.name = "armBase";
  armBase.position.set(S.x + 0.6, S.y + 0.7, S.z - 0.5);

  const armLift = new THREE.Group();
  armLift.name = "armLift";
  armLift.position.y = 0.5;

  const liftGeo = registry.track(
    mergeParts([
      paint(
        capsule(0.14, 1.4, 10)
          .rotateZ(Math.PI / 2 - 0.5)
          .translate(0.35, 0.4, 0),
        PALETTE.slateDark,
      ),
      paint(capsule(0.2, 0.3, 10).translate(0, 0.15, 0), PALETTE.slate),
    ]),
  );
  const liftMesh = new THREE.Mesh(liftGeo, mats.darkMetal);
  liftMesh.castShadow = true;
  liftMesh.receiveShadow = true;
  armLift.add(liftMesh);

  const claw = new THREE.Group();
  claw.name = "claw";
  claw.position.set(1.0, 0.75, 0);
  const clawGeo = registry.track(
    mergeParts([
      paint(roundedBox(0.3, 0.24, 0.5, 0.06).translate(0, 0, 0.14), PALETTE.slateDark),
      paint(roundedBox(0.3, 0.24, 0.5, 0.06).translate(0, 0, -0.14), PALETTE.slateDark),
      paint(capsule(0.1, 0.2, 8).translate(-0.12, 0, 0), PALETTE.brass),
    ]),
  );
  const clawMesh = new THREE.Mesh(clawGeo, mats.darkMetal);
  clawMesh.castShadow = true;
  clawMesh.receiveShadow = true;
  claw.add(clawMesh);

  armLift.add(claw);
  armBase.add(armLift);
  // Idle pose: facing the pipe arrival, arm raised toward the slot wall.
  armBase.rotation.y = -0.6;
  armLift.rotation.z = 0.35;
  group.add(armBase);

  // ----- Mint press pivot ------------------------------------------------------
  const mintPress = new THREE.Group();
  mintPress.name = "mintPress";
  mintPress.position.set(mint.x, S.y + 1.1, mint.z);
  const pressGeo = registry.track(
    mergeParts([
      paint(capsule(0.28, 0.5, 12).translate(0, 0.3, 0), PALETTE.brass),
      paint(bevelSlab(0.5, 0.5, 0.16, 0.05).translate(0, 0.62, 0), PALETTE.brass),
    ]),
  );
  const pressMesh = new THREE.Mesh(pressGeo, mats.brass);
  pressMesh.castShadow = true;
  pressMesh.receiveShadow = true;
  mintPress.add(pressMesh);
  group.add(mintPress);

  group.add(pipeArrival, pop, returnEnd);

  const anchors: Record<string, THREE.Object3D> = {
    pipeArrival,
    pop,
    returnEnd,
    armBase,
    armClaw: claw,
    mintPress,
    slotA: slots[0] as THREE.Mesh,
    slotB: slots[1] as THREE.Mesh,
    slotC: slots[2] as THREE.Mesh,
  };

  return { group, statics, anchors };
}
