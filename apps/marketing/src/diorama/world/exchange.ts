/**
 * Exchange satellite pad (M04b / R2 cutover): the subordinate pristine level
 * floating at (19, 6.5, -6) per 09-layout-spec.md (DIMENSIONS.composition).
 *
 * Deliberately cleaner than the bazaar: a thin slate-and-cream pad, a wall of
 * small slots with three named mint slots, a robotic arm with named yaw /
 * pitch / claw pivots, a brass mint press, a confetti cone, and the pipe from
 * the launch bay collar (13.5, 4, 2) in a shallow arc. No clutter, no bots.
 */

import * as THREE from "three";
import { DIMENSIONS, PALETTE, PALETTE_V2 } from "../config";
import { bevelSlab, capsule, cone, mergeParts, paint, pipeAlong, roundedBox } from "../geometry";
import type { MaterialLibrary } from "../render/materials";
import type { ResourceRegistry } from "../render/resources";
import { STATIONS } from "../story/waypoints";
import type { WorldPart } from "./plinth";

export const EXCHANGE_VERSION = 2;

const SAT = DIMENSIONS.composition.satellite;

/** Launch-bay pipe collar the main pipe connects from (layout spec). */
const PIPE_MOUTH = { x: 13.5, y: 4, z: 2 } as const;

export function buildExchange(mats: MaterialLibrary, registry: ResourceRegistry): WorldPart {
  const group = new THREE.Group();
  group.name = "exchange";
  const st = STATIONS;

  // Named empties the story addresses.
  const pipeArrival = new THREE.Object3D();
  pipeArrival.name = "pipeArrival";
  pipeArrival.position.set(st.pipeArrivalV2.x, st.pipeArrivalV2.y + 0.6, st.pipeArrivalV2.z);

  const pop = new THREE.Object3D();
  pop.name = "pop";
  pop.position.set(SAT.x + 1.8, SAT.y + 0.9, SAT.z + 1.4);

  // Return pipe ends above the back-office ferry dock (receipt hand-off).
  const returnEnd = new THREE.Object3D();
  returnEnd.name = "returnEnd";
  returnEnd.position.set(17.6, 4.4, 4.4);

  // ----- Static bake: pad, slot wall body, arm pedestal, mint base, pipes ---
  const slot = st.slotWallV2;
  const mint = st.mintStationV2;
  const padSize = SAT.radius * 2 - 0.6;
  const padY = SAT.y - 0.4;

  const parts: THREE.BufferGeometry[] = [
    // Floating pad: thin slate slab with a cream trim band, chamfered edge.
    paint(bevelSlab(padSize, padSize, 0.8, 0.2).translate(SAT.x, padY, SAT.z), PALETTE.slate),
    paint(
      bevelSlab(padSize - 0.5, padSize - 0.5, 0.14, 0.05).translate(SAT.x, SAT.y + 0.02, SAT.z),
      PALETTE.cream,
    ),
    // Slot wall body with a grid of dark recesses (named slots are separate).
    paint(
      bevelSlab(3.2, 2.4, 0.4, 0.08).translate(slot.x, SAT.y + 1.2, slot.z),
      PALETTE.creamWallLight,
    ),
  ];
  const wallYaw = slot.facing ?? 0;
  const cos = Math.cos(wallYaw);
  const sin = Math.sin(wallYaw);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) {
      const lx = -1.05 + c * 0.7;
      const ly = 0.55 + r * 0.62;
      const g = bevelSlab(0.44, 0.4, 0.08, 0.02);
      g.rotateY(wallYaw);
      g.translate(
        slot.x + lx * cos + 0.24 * sin,
        SAT.y + 1.2 + ly - 0.9,
        slot.z - lx * sin + 0.24 * cos,
      );
      parts.push(paint(g, PALETTE.slateDark));
    }
  }
  parts.push(
    // Mint station base block.
    paint(roundedBox(1.4, 1.0, 1.2, 0.08).translate(mint.x, SAT.y + 0.5, mint.z), PALETTE.cream),
    paint(roundedBox(1.1, 0.16, 0.9, 0.05).translate(mint.x, SAT.y + 1.02, mint.z), PALETTE.slate),
    // Robotic arm pedestal (the yaw pivot above it carries the arm).
    paint(
      capsule(0.55, 0.5, 12).translate(SAT.x + 0.6, SAT.y + 0.35, SAT.z - 0.5),
      PALETTE.slateDark,
    ),
    // Confetti cannon: small slate cone near the pad edge.
    paint(
      cone(0.35, 0.9, 8).translate(pop.position.x, SAT.y + 0.45, pop.position.z),
      PALETTE.slateDark,
    ),
    // Main pipe: launch-bay collar -> shallow arc -> pad arrival.
    paint(
      pipeAlong(
        [
          { x: PIPE_MOUTH.x, y: PIPE_MOUTH.y, z: PIPE_MOUTH.z },
          { x: (PIPE_MOUTH.x + SAT.x) / 2 - 0.4, y: SAT.y + 0.8, z: (PIPE_MOUTH.z + SAT.z) / 2 },
          { x: SAT.x - 2.4, y: SAT.y + 0.7, z: SAT.z + 0.5 },
          { x: st.pipeArrivalV2.x, y: st.pipeArrivalV2.y + 0.5, z: st.pipeArrivalV2.z },
        ],
        DIMENSIONS.bridge.pipeRadius,
        8,
      ),
      PALETTE.slateDark,
    ),
    // Thin return pipe, parallel offset, ending above the ferry dock.
    paint(
      pipeAlong(
        [
          { x: SAT.x - 1.0, y: SAT.y + 0.8, z: SAT.z + 1.0 },
          {
            x: (PIPE_MOUTH.x + SAT.x) / 2 + 1.2,
            y: SAT.y + 0.6,
            z: (PIPE_MOUTH.z + SAT.z) / 2 + 1.2,
          },
          { x: PIPE_MOUTH.x + 0.6, y: PIPE_MOUTH.y + 0.6, z: PIPE_MOUTH.z + 0.8 },
          { x: returnEnd.position.x, y: returnEnd.position.y + 0.6, z: returnEnd.position.z + 1.2 },
          { x: returnEnd.position.x, y: returnEnd.position.y, z: returnEnd.position.z },
        ],
        0.2,
        6,
      ),
      PALETTE.slate,
    ),
    // Return-pipe endpoint collar.
    paint(
      capsule(0.34, 0.2, 10).translate(
        returnEnd.position.x,
        returnEnd.position.y,
        returnEnd.position.z,
      ),
      PALETTE.brass,
    ),
    // Pad-edge sign mount (THE EXCHANGE): slate board + cool placeholder bar;
    // the atlas text plane attaches just in front from world/index.ts.
    paint(
      bevelSlab(2.6, 0.12, 0.65, 0.04)
        .rotateY(Math.PI / 4)
        .translate(SAT.x + 2.2, SAT.y + 1.9, SAT.z + 2.2),
      PALETTE_V2.slateFrame,
    ),
    paint(
      bevelSlab(2.3, 0.08, 0.1, 0.02)
        .rotateY(Math.PI / 4)
        .translate(SAT.x + 2.2, SAT.y + 1.5, SAT.z + 2.2),
      PALETTE.coolFill,
    ),
  );

  const merged = registry.track(mergeParts(parts));
  const padMesh = new THREE.Mesh(merged, mats.matteVertex);
  padMesh.name = "exchangeStatic";
  padMesh.castShadow = true;
  padMesh.receiveShadow = true;
  group.add(padMesh);
  const statics: THREE.Mesh[] = [padMesh];

  // Soft mint under-glow ring beneath the pad: emissive (unlit) so the pad
  // reads as FLOATING rather than grounded (composition-review fix).
  const ring = (radius: number, pipe: number, y: number): THREE.Mesh => {
    const pts: { x: number; y: number; z: number }[] = [];
    for (let i = 0; i <= 28; i++) {
      const a = (i / 28) * Math.PI * 2;
      pts.push({ x: SAT.x + Math.cos(a) * radius, y: SAT.y + y, z: SAT.z + Math.sin(a) * radius });
    }
    return new THREE.Mesh(registry.track(pipeAlong(pts, pipe, 6)), mats.eyeMint);
  };
  // Enlarged outer ring + brighter inner ring: double additive-feel halo so
  // the pad reads as floating, not as a table on stilts (review fix D).
  const underGlow = ring(3.2, 0.28, -0.95);
  underGlow.name = "underGlow";
  const underGlowInner = ring(2.5, 0.16, -1.15);
  underGlowInner.name = "underGlowInner";
  group.add(underGlow, underGlowInner);

  // ----- Named slot marks (the story lights these on fills) -----------------
  const slots: THREE.Mesh[] = [];
  const slotSpecs: readonly { name: string; lx: number; ly: number }[] = [
    { name: "slotA", lx: -1.05, ly: 0.55 },
    { name: "slotB", lx: -0.35, ly: 1.17 },
    { name: "slotC", lx: 0.35, ly: 1.79 },
  ];
  for (const spec of slotSpecs) {
    const g = registry.track(
      mergeParts([paint(bevelSlab(0.44, 0.4, 0.06, 0.02), PALETTE.mintBright)]),
    );
    const mesh = new THREE.Mesh(g, mats.eyeMint);
    mesh.name = spec.name;
    mesh.position.set(
      slot.x + spec.lx * cos + 0.3 * sin,
      SAT.y + 1.2 + spec.ly - 0.9,
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
  armBase.position.set(SAT.x + 0.6, SAT.y + 0.7, SAT.z - 0.5);

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
  liftMesh.name = "armLiftMesh";
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
  clawMesh.name = "clawMesh";
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
  mintPress.position.set(mint.x, SAT.y + 1.1, mint.z);
  const pressGeo = registry.track(
    mergeParts([
      paint(capsule(0.28, 0.5, 12).translate(0, 0.3, 0), PALETTE.brass),
      paint(bevelSlab(0.5, 0.5, 0.16, 0.05).translate(0, 0.62, 0), PALETTE.brass),
    ]),
  );
  const pressMesh = new THREE.Mesh(pressGeo, mats.brass);
  pressMesh.name = "mintPressMesh";
  mintPress.add(pressMesh);
  group.add(mintPress);

  group.add(pipeArrival, pop, returnEnd);

  const anchors: Record<string, THREE.Object3D> = {
    pipeArrival,
    pop,
    returnEnd,
    armBase,
    armClaw: claw,
    armLift,
    mintPress,
    slotA: slots[0] as THREE.Mesh,
    slotB: slots[1] as THREE.Mesh,
    slotC: slots[2] as THREE.Mesh,
  };

  return { group, statics, anchors };
}
