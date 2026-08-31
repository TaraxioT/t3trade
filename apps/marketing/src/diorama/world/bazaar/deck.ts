/**
 * Bureau Bazaar deck (R2 architecture chunk, 09-layout-spec.md).
 *
 * The 46x28 stepped platform: boneDeck top at y=0, light stone steps down at
 * the front (+Z) and right (+X) edges, boneWall fascia on the closed -X/-Z
 * back faces, the brass nameplate fascia at the +Z center, the continuous
 * back wall along z=-9 carrying every zone sign mount, ghost brass rails, the
 * deck-to-terrace pole, and the two pneumatic tubes with parked capsules.
 *
 * UNWIRED: this module is new in R2 and intentionally not imported by the
 * composed world yet; the atomic cutover wires it in. No story imports, no
 * DOM, no renderer side effects - geometry and empties only.
 */

import * as THREE from "three";
import { PALETTE, PALETTE_V2 } from "../../config";
import { bevelSlab, capsule, mergeParts, paint, pipeAlong, roundedBox } from "../../geometry";
import { buildNameplate } from "../../props/decor";
import type { MaterialLibrary } from "../../render/materials";
import type { ResourceRegistry } from "../../render/resources";

export const DECK_VERSION = 1;

/** Per-builder result: scene subtree plus anchor/pad registries. */
export interface BazaarPart {
  readonly group: THREE.Group;
  /** Named empty points the story/R3 machinery will address. */
  readonly anchors: Readonly<Record<string, THREE.Object3D>>;
  /** Empty parents where R3 machinery meshes will attach. */
  readonly machinePads: Readonly<Record<string, THREE.Object3D>>;
}

// ---------------------------------------------------------------------------
// Layout constants (09-layout-spec.md)
// ---------------------------------------------------------------------------

/** Deck footprint half extents: x [-23,+23], z [-15,+13]. */
const HX = 23;
const Z_FRONT = 13;
const Z_BACK = -15;
/** Deck slab thickness below the y=0 walking surface. */
const DECK_THICK = 2.4;
/** Back wall plane (terrace front face) and its top. */
const WALL_Z = -9;
const WALL_TOP_Y = 6.5;
/** Sign mount geometry: slate board + zone emissive bar under it. */
const SIGN_Y = 5.6;
const SIGN_W = 4.4;
const SIGN_H = 0.9;
const SIGN_TILT = -Math.PI / 6; // ~30 degrees toward the +x/+z camera octant
const SUB_SIGN_W = 1.6;
const SUB_SIGN_H = 0.55;
/** Pneumatic tubes: pale clear-look pipes along the back wall. */
const TUBE_Y = 4.6;
const TUBE_Z = WALL_Z + 0.4;
const TUBE_R = 0.28;
/** Ghost rail height above the surfaces they guard. */
const RAIL_H = 0.55;
const RAIL_R = 0.06;
/** Brass pole at the gauntlet front, deck (y=0) to terrace height (y=3.2). */
const POLE = { x: 1, z: 5, topY: 3.2, r: 0.12 } as const;

/** Zone sign mounts on the back wall: zone id, x center, emissive bar color. */
const DECK_SIGNS: readonly { id: string; cx: number; color: string }[] = [
  { id: "docks", cx: -18, color: PALETTE_V2.zoneEmissive.docks },
  { id: "greenhouse", cx: -11.5, color: PALETTE_V2.zoneEmissive.greenhouse },
  { id: "plan", cx: -5.5, color: PALETTE_V2.zoneEmissive.plan },
  { id: "gauntlet", cx: 1, color: PALETTE_V2.zoneEmissive.gauntlet },
  { id: "mint", cx: 7.5, color: PALETTE_V2.zoneEmissive.mint },
  { id: "launch", cx: 12.5, color: PALETTE_V2.zoneEmissive.launch },
  { id: "backOffice", cx: 18, color: PALETTE_V2.zoneEmissive.backOffice },
];

/** Machine positions on the deck (anchors + R3 machine pads). */
const DECK_POINTS: readonly { name: string; x: number; y: number; z: number }[] = [
  // Five provider dock pads in a row against the back wall (x -21..-15).
  { name: "docksPadA", x: -20.2, y: 0, z: -7.6 },
  { name: "docksPadB", x: -19.1, y: 0, z: -7.6 },
  { name: "docksPadC", x: -18, y: 0, z: -7.6 },
  { name: "docksPadD", x: -16.9, y: 0, z: -7.6 },
  { name: "docksPadE", x: -15.8, y: 0, z: -7.6 },
  { name: "greenhouseRack", x: -11.5, y: 0, z: -5 },
  { name: "planDeskPad", x: -5.5, y: 0, z: -4 },
  // Gauntlet conveyor run enters from activation and exits toward the mint.
  { name: "gauntletIn", x: -2.2, y: 0, z: 3 },
  { name: "gauntletOut", x: 4.2, y: 0, z: 3 },
  { name: "mintPressPad", x: 7.5, y: 0, z: -4 },
  { name: "launchPad", x: 12.5, y: 0, z: -3 },
  // Reconciler ferry dock at the back-office front edge.
  { name: "ferryDock", x: 18, y: 0, z: 4 },
  // Oil bar pocket x [+16,+21], z [+8,+12].
  { name: "oilBarPad", x: 18.5, y: 0, z: 10 },
  // Order-pipe mouth above the launch bay (exchange satellite arc start).
  { name: "pipeMouth", x: 13.5, y: 4, z: 2 },
  // Top of the brass pole (stairTop-family alias lands here).
  { name: "poleBaseTop", x: POLE.x, y: POLE.topY, z: POLE.z },
];

/** One sign mount: slateFrame board + zone-colored emissive bar under it. */
export function signMountParts(
  cx: number,
  wallZ: number,
  y: number,
  w: number,
  h: number,
  color: string,
): THREE.BufferGeometry[] {
  // Board drawn facing +Z, tilted toward the +x/+z camera octant.
  const board = bevelSlab(w, 0.12, h, 0.04);
  board.rotateY(SIGN_TILT);
  board.translate(cx, y, wallZ + 0.35);
  const bar = bevelSlab(w - 0.3, 0.1, 0.1, 0.02);
  bar.rotateY(SIGN_TILT);
  bar.translate(cx, y - h / 2 - 0.22, wallZ + 0.35);
  return [paint(board, PALETTE_V2.slateFrame), paint(bar, color)];
}

export function buildDeck(mats: MaterialLibrary, registry: ResourceRegistry): BazaarPart {
  const group = new THREE.Group();
  group.name = "bazaarDeck";

  // ----- Static shell: slab, steps, fascia, back wall, street inlay --------
  const staticParts: THREE.BufferGeometry[] = [
    // Main deck slab, top surface at y = 0.
    paint(
      bevelSlab(HX * 2, 28, DECK_THICK, 0.15).translate(0, -DECK_THICK / 2, -1),
      PALETTE_V2.boneDeck,
    ),
    // Light stone steps down at the front (+Z) edge.
    paint(
      bevelSlab(HX * 2, 1.4, 1.9, 0.1).translate(0, -0.55 - 0.95, Z_FRONT + 0.7),
      PALETTE_V2.boneDeckLight,
    ),
    paint(
      bevelSlab(HX * 2, 1.4, 1.35, 0.1).translate(0, -1.1 - 0.675, Z_FRONT + 2.1),
      PALETTE_V2.boneDeckLight,
    ),
    // Light stone steps down at the right (+X) edge.
    paint(
      bevelSlab(1.4, 28, 1.9, 0.1).translate(HX + 0.7, -0.55 - 0.95, -1),
      PALETTE_V2.boneDeckLight,
    ),
    paint(
      bevelSlab(1.4, 28, 1.35, 0.1).translate(HX + 2.1, -1.1 - 0.675, -1),
      PALETTE_V2.boneDeckLight,
    ),
    // boneWall fascia on the closed -X back face.
    paint(roundedBox(0.5, 2.9, 28, 0.06).translate(-HX + 0.25, -1.25, -1), PALETTE_V2.boneWall),
    // boneWall fascia on the closed -Z back face.
    paint(
      roundedBox(HX * 2, 2.9, 0.5, 0.06).translate(0, -1.25, Z_BACK + 0.25),
      PALETTE_V2.boneWall,
    ),
    // Front (+Z) fascia in three segments framing the nameplate band.
    paint(
      roundedBox(17, 2.9, 0.5, 0.06).translate(-HX + 8.5, -1.25, Z_FRONT - 0.25),
      PALETTE_V2.boneWall,
    ),
    paint(
      roundedBox(17, 2.9, 0.5, 0.06).translate(HX - 8.5, -1.25, Z_FRONT - 0.25),
      PALETTE_V2.boneWall,
    ),
    paint(roundedBox(12, 2.9, 0.5, 0.08).translate(0, -1.25, Z_FRONT - 0.25), PALETTE_V2.boneWall),
    // Continuous back wall along z=-9 up to y 6.5 (terrace front merges in).
    paint(
      roundedBox(HX * 2, WALL_TOP_Y, 0.6, 0.08).translate(0, WALL_TOP_Y / 2, WALL_Z - 0.3),
      PALETTE_V2.boneWall,
    ),
    paint(
      roundedBox(HX * 2 + 0.3, 0.24, 0.8, 0.05).translate(0, WALL_TOP_Y + 0.12, WALL_Z - 0.3),
      PALETTE_V2.boneDeckLight,
    ),
    // Street conveyor inlay: subtle boneDeckLight strip along z +7.
    paint(roundedBox(38, 0.06, 0.7, 0.02).translate(0, 0.03, 7), PALETTE_V2.boneDeckLight),
    // Pneumatic tubes: pale clear-look pipes (boneDeckLight reads as glassy
    // against the boneWall behind them).
    paint(
      pipeAlong(
        [
          { x: -18, y: TUBE_Y, z: TUBE_Z },
          { x: -11.5, y: TUBE_Y, z: TUBE_Z },
          { x: -5.5, y: TUBE_Y, z: TUBE_Z },
        ],
        TUBE_R,
        8,
      ),
      PALETTE_V2.boneDeckLight,
    ),
    paint(
      pipeAlong(
        [
          { x: 1, y: TUBE_Y, z: TUBE_Z },
          { x: 9.5, y: TUBE_Y, z: TUBE_Z },
          { x: 18, y: TUBE_Y, z: TUBE_Z },
        ],
        TUBE_R,
        8,
      ),
      PALETTE_V2.boneDeckLight,
    ),
  ];

  const shellMesh = new THREE.Mesh(registry.track(mergeParts(staticParts)), mats.matteVertex);
  shellMesh.name = "deckShell";
  shellMesh.castShadow = true;
  shellMesh.receiveShadow = true;
  group.add(shellMesh);

  // ----- Sign mounts + parked tube capsules (one emissive-look mesh) --------
  const signParts: THREE.BufferGeometry[] = [];
  for (const sign of DECK_SIGNS) {
    signParts.push(...signMountParts(sign.cx, WALL_Z, SIGN_Y, SIGN_W, SIGN_H, sign.color));
  }
  // Small RISK sub-sign on the gauntlet block's back edge.
  signParts.push(
    ...signMountParts(
      3.4,
      WALL_Z,
      SIGN_Y - 1.0,
      SUB_SIGN_W,
      SUB_SIGN_H,
      PALETTE_V2.zoneEmissive.risk,
    ),
  );
  // Three emissive capsules parked in the tubes (story whoosh placeholders).
  for (const cx of [-12, 3, 12]) {
    signParts.push(
      paint(capsule(0.17, 0.32, 8).translate(cx, TUBE_Y, TUBE_Z), PALETTE.eyeEmissive),
    );
  }
  const signMesh = new THREE.Mesh(registry.track(mergeParts(signParts)), mats.signGlow);
  signMesh.name = "deckSigns";
  group.add(signMesh);

  // ----- Brass: ghost rails, pole, tube end collars --------------------------
  const brassParts: THREE.BufferGeometry[] = [
    // Terrace edge rail (front edge of the y=3.2 terrace slab).
    paint(
      pipeAlong(
        [
          { x: -22.6, y: 3.2 + RAIL_H, z: WALL_Z - 0.35 },
          { x: 22.6, y: 3.2 + RAIL_H, z: WALL_Z - 0.35 },
        ],
        RAIL_R,
        6,
      ),
      PALETTE.brass,
    ),
    // Terrace rail posts every ~4.6 units.
    ...[-21, -16, -11, -6, -1, 4, 9, 14, 19].map((x) =>
      paint(
        capsule(RAIL_R, RAIL_H, 6).translate(x, 3.2 + RAIL_H / 2, WALL_Z - 0.35),
        PALETTE.brass,
      ),
    ),
    // Two deck front-corner L rails (short, ghost-thin).
    paint(
      pipeAlong(
        [
          { x: -HX + 0.3, y: RAIL_H, z: 10 },
          { x: -HX + 0.3, y: RAIL_H, z: Z_FRONT - 0.3 },
          { x: -HX + 3, y: RAIL_H, z: Z_FRONT - 0.3 },
        ],
        RAIL_R,
        6,
      ),
      PALETTE.brass,
    ),
    paint(
      pipeAlong(
        [
          { x: HX - 0.3, y: RAIL_H, z: 10 },
          { x: HX - 0.3, y: RAIL_H, z: Z_FRONT - 0.3 },
          { x: HX - 3, y: RAIL_H, z: Z_FRONT - 0.3 },
        ],
        RAIL_R,
        6,
      ),
      PALETTE.brass,
    ),
    // Corner rail posts.
    ...[
      { x: -HX + 0.3, z: 10 },
      { x: -HX + 3, z: Z_FRONT - 0.3 },
      { x: HX - 0.3, z: 10 },
      { x: HX - 3, z: Z_FRONT - 0.3 },
    ].map((p) => paint(capsule(RAIL_R, RAIL_H, 6).translate(p.x, RAIL_H / 2, p.z), PALETTE.brass)),
    // Deck-to-terrace brass pole.
    paint(
      capsule(POLE.r, POLE.topY - 0.24, 10).translate(POLE.x, POLE.topY / 2, POLE.z),
      PALETTE.brass,
    ),
    paint(capsule(POLE.r + 0.04, 0.16, 10).translate(POLE.x, 0.1, POLE.z), PALETTE.brass),
    // Pneumatic tube end collars (brass rings capping each tube run).
    ...[-18, -5.5, 1, 18].map((x) =>
      paint(capsule(TUBE_R + 0.06, 0.18, 10).translate(x, TUBE_Y, TUBE_Z), PALETTE.brass),
    ),
  ];
  const brassMesh = new THREE.Mesh(registry.track(mergeParts(brassParts)), mats.brass);
  brassMesh.name = "deckBrass";
  brassMesh.castShadow = true;
  group.add(brassMesh);

  // ----- Nameplate fascia (reused, enlarged) on the +Z face center ----------
  const nameplate = buildNameplate(mats);
  nameplate.scale.setScalar(2.6);
  nameplate.position.set(0, -1.25, Z_FRONT + 0.02);
  nameplate.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  group.add(nameplate);

  // ----- Anchors + machine pads ----------------------------------------------
  const anchors: Record<string, THREE.Object3D> = {};
  const machinePads: Record<string, THREE.Object3D> = {};
  for (const point of DECK_POINTS) {
    const empty = new THREE.Object3D();
    empty.name = point.name;
    empty.position.set(point.x, point.y, point.z);
    group.add(empty);
    anchors[point.name] = empty;
    machinePads[point.name] = empty;
  }

  return { group, anchors, machinePads };
}
