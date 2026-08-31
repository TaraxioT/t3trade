/**
 * Furniture prop kit: desks, seating, storage, and floor props for the
 * three-floor bureau. Every prop is chunky beveled clay: bulk color comes
 * from paint() + mergeParts() into one matte mesh; special-material parts
 * (screens, data marks) are separate named meshes using the shared library.
 *
 * Props never animate themselves, never create materials, and never import
 * from story/. Animatable parts are named children so the story can find them.
 */

import * as THREE from "three";
import { PALETTE } from "../config";
import { bevelSlab, capsule, cone, mergeParts, paint, roundedBox } from "../geometry";
import type { MaterialLibrary } from "../render/materials";

export const PROPS_FURNITURE_VERSION = 1;

const hex = (c: string): string => c;

/** One merged matte mesh from painted parts. */
function matte(mats: MaterialLibrary, parts: THREE.BufferGeometry[]): THREE.Mesh {
  return new THREE.Mesh(mergeParts(parts), mats.matteVertex);
}

/** Named empty anchor at a local position. */
function anchor(name: string, x: number, y: number, z: number): THREE.Object3D {
  const o = new THREE.Object3D();
  o.name = name;
  o.position.set(x, y, z);
  return o;
}

// ---------------------------------------------------------------------------
// Desk: 2.4 x 1.2 footprint, 1.3 tall, small screen block + 2 data marks.
// ---------------------------------------------------------------------------

export function buildDesk(mats: MaterialLibrary): THREE.Object3D {
  const root = new THREE.Group();
  root.name = "desk";

  const wood = hex(PALETTE.caramel);
  const woodLight = hex(PALETTE.caramelLight);

  const parts = [
    // Top slab and apron.
    bevelSlab(2.4, 1.2, 0.14, 0.05).translate(0, 1.23, 0),
    roundedBox(2.1, 0.1, 1.0, 0.04).translate(0, 1.08, 0),
    // Four chunky legs.
    roundedBox(0.16, 1.05, 0.16, 0.05).translate(-1.02, 0.52, -0.42),
    roundedBox(0.16, 1.05, 0.16, 0.05).translate(1.02, 0.52, -0.42),
    roundedBox(0.16, 1.05, 0.16, 0.05).translate(-1.02, 0.52, 0.42),
    roundedBox(0.16, 1.05, 0.16, 0.05).translate(1.02, 0.52, 0.42),
    // Modesty panel at the back.
    roundedBox(2.0, 0.5, 0.08, 0.04).translate(0, 0.8, -0.5),
  ].map((g, i) => paint(g, i === 0 ? woodLight : wood));

  root.add(matte(mats, parts));

  // Screen block: dark slab on a small stand, angled slightly.
  const screen = new THREE.Group();
  screen.name = "screen";
  screen.position.set(-0.55, 1.3, -0.2);
  screen.rotation.y = 0.25;
  screen.add(
    matte(mats, [
      paint(roundedBox(0.1, 0.28, 0.1, 0.04).translate(0, 0.14, 0), hex(PALETTE.slate)),
    ]),
  );
  const face = new THREE.Mesh(
    mergeParts([
      paint(bevelSlab(0.8, 0.5, 0.06, 0.03).translate(0, 0.55, 0.04), hex(PALETTE.slateDark)),
    ]),
    mats.screenDark,
  );
  screen.add(face);
  const markG = new THREE.Mesh(
    mergeParts([
      paint(roundedBox(0.22, 0.05, 0.02, 0.02).translate(-0.18, 0.62, 0.08), PALETTE.dataGreen),
    ]),
    mats.dataGreen,
  );
  const markR = new THREE.Mesh(
    mergeParts([
      paint(roundedBox(0.12, 0.05, 0.02, 0.02).translate(0.12, 0.52, 0.08), PALETTE.dataRed),
    ]),
    mats.dataRed,
  );
  screen.add(markG, markR);
  root.add(screen);

  return root;
}

// ---------------------------------------------------------------------------
// Chair: office chair with backrest.
// ---------------------------------------------------------------------------

export function buildChair(mats: MaterialLibrary): THREE.Object3D {
  const root = new THREE.Group();
  root.name = "chair";

  const seat = hex(PALETTE.slate);
  const parts = [
    roundedBox(0.62, 0.12, 0.58, 0.05).translate(0, 0.55, 0),
    roundedBox(0.58, 0.62, 0.12, 0.05).translate(0, 0.95, -0.28),
    roundedBox(0.1, 0.42, 0.1, 0.04).translate(0, 0.28, 0),
    roundedBox(0.5, 0.08, 0.08, 0.03).translate(0, 0.12, 0),
    roundedBox(0.08, 0.08, 0.5, 0.03).translate(-0.22, 0.08, 0),
    roundedBox(0.08, 0.08, 0.5, 0.03).translate(0.22, 0.08, 0),
    // Casters as tiny nubs.
    roundedBox(0.12, 0.1, 0.12, 0.04).translate(-0.24, 0.05, 0.22),
    roundedBox(0.12, 0.1, 0.12, 0.04).translate(0.24, 0.05, 0.22),
    roundedBox(0.12, 0.1, 0.12, 0.04).translate(-0.24, 0.05, -0.22),
    roundedBox(0.12, 0.1, 0.12, 0.04).translate(0.24, 0.05, -0.22),
  ].map((g) => paint(g, seat));

  root.add(matte(mats, parts));
  return root;
}

// ---------------------------------------------------------------------------
// Stool: simple three-leg shop stool.
// ---------------------------------------------------------------------------

export function buildStool(mats: MaterialLibrary): THREE.Object3D {
  const root = new THREE.Group();
  root.name = "stool";

  const wood = hex(PALETTE.caramel);
  const parts = [
    paint(capsule(0.3, 0.12).translate(0, 0.62, 0), wood),
    paint(roundedBox(0.07, 0.6, 0.07, 0.03).translate(0, 0.3, -0.2), wood),
    paint(roundedBox(0.07, 0.6, 0.07, 0.03).translate(0.18, 0.3, 0.1), wood),
    paint(roundedBox(0.07, 0.6, 0.07, 0.03).translate(-0.18, 0.3, 0.1), wood),
  ];

  root.add(matte(mats, parts));
  return root;
}

// ---------------------------------------------------------------------------
// Shelf: open bookcase of the given width.
// ---------------------------------------------------------------------------

export function buildShelf(mats: MaterialLibrary, width: number): THREE.Object3D {
  const root = new THREE.Group();
  root.name = "shelf";

  const w = Math.max(1.2, width);
  const wood = hex(PALETTE.caramel);
  const woodLight = hex(PALETTE.caramelLight);
  const parts: THREE.BufferGeometry[] = [
    paint(roundedBox(0.1, 2.4, 0.7, 0.04).translate(-w / 2 + 0.05, 1.2, 0), wood),
    paint(roundedBox(0.1, 2.4, 0.7, 0.04).translate(w / 2 - 0.05, 1.2, 0), wood),
  ];
  for (let i = 0; i < 4; i++) {
    parts.push(
      paint(bevelSlab(w - 0.1, 0.62, 0.09, 0.03).translate(0, 0.35 + i * 0.68, 0), woodLight),
    );
  }

  root.add(matte(mats, parts));
  return root;
}

// ---------------------------------------------------------------------------
// Briefing table: large table with a blueprint anchor at tabletop center.
// ---------------------------------------------------------------------------

export function buildBriefingTable(mats: MaterialLibrary): THREE.Object3D {
  const root = new THREE.Group();
  root.name = "briefingTable";

  const wood = hex(PALETTE.mahoganyRim);
  const woodDark = hex(PALETTE.mahoganyPlinth);
  const parts = [
    paint(bevelSlab(3.6, 1.8, 0.16, 0.06).translate(0, 1.12, 0), wood),
    paint(roundedBox(0.22, 1.0, 0.22, 0.07).translate(-1.5, 0.52, -0.6), woodDark),
    paint(roundedBox(0.22, 1.0, 0.22, 0.07).translate(1.5, 0.52, -0.6), woodDark),
    paint(roundedBox(0.22, 1.0, 0.22, 0.07).translate(-1.5, 0.52, 0.6), woodDark),
    paint(roundedBox(0.22, 1.0, 0.22, 0.07).translate(1.5, 0.52, 0.6), woodDark),
    paint(bevelSlab(3.0, 1.2, 0.1, 0.04).translate(0, 0.35, 0), woodDark),
  ];

  root.add(matte(mats, parts));
  root.add(anchor("blueprintAnchor", 0, 1.22, 0));
  return root;
}

// ---------------------------------------------------------------------------
// Locker: tall steel cabinet with a door seam and vents.
// ---------------------------------------------------------------------------

export function buildLocker(mats: MaterialLibrary): THREE.Object3D {
  const root = new THREE.Group();
  root.name = "locker";

  const body = hex(PALETTE.slate);
  const dark = hex(PALETTE.slateDark);
  const parts = [
    paint(roundedBox(0.9, 2.2, 0.7, 0.06).translate(0, 1.1, 0), body),
    // Door seam as a proud thin strip.
    paint(roundedBox(0.04, 1.9, 0.04, 0.02).translate(0.18, 1.1, 0.36), dark),
    // Vent slats.
    paint(roundedBox(0.4, 0.05, 0.04, 0.02).translate(-0.1, 1.75, 0.36), dark),
    paint(roundedBox(0.4, 0.05, 0.04, 0.02).translate(-0.1, 1.6, 0.36), dark),
    paint(roundedBox(0.4, 0.05, 0.04, 0.02).translate(-0.1, 1.45, 0.36), dark),
    // Handle nub.
    paint(roundedBox(0.06, 0.18, 0.06, 0.03).translate(0.05, 1.1, 0.38), dark),
  ];

  root.add(matte(mats, parts));
  return root;
}

// ---------------------------------------------------------------------------
// Lamp stand: floor lamp with a warm unlit "bulb" mesh (no real light).
// The shade interior reads dark (screenDark) while the bulb glows paper-warm.
// ---------------------------------------------------------------------------

export function buildLampStand(mats: MaterialLibrary): THREE.Object3D {
  const root = new THREE.Group();
  root.name = "lampStand";

  const slate = hex(PALETTE.slate);
  const parts = [
    paint(capsule(0.34, 0.12).translate(0, 0.08, 0), slate),
    paint(capsule(0.05, 1.7).translate(0, 0.95, 0), slate),
    paint(cone(0.42, 0.5, 10).translate(0, 1.95, 0), hex(PALETTE.cream)),
  ];

  root.add(matte(mats, parts));

  // Warm glow: unlit cream basic material sphere tucked inside the shade,
  // with a dark cap (screenDark) so it reads as a shaded bulb.
  const bulb = new THREE.Group();
  bulb.name = "bulb";
  bulb.position.set(0, 1.82, 0);
  const glow = new THREE.Mesh(
    mergeParts([paint(roundedBox(0.22, 0.26, 0.22, 0.09), PALETTE.cream)]),
    mats.paper,
  );
  const cap = new THREE.Mesh(
    mergeParts([
      paint(roundedBox(0.26, 0.08, 0.26, 0.03).translate(0, 0.16, 0), PALETTE.slateDark),
    ]),
    mats.screenDark,
  );
  bulb.add(glow, cap);
  root.add(bulb);

  return root;
}

// ---------------------------------------------------------------------------
// Coffee station: counter + machine with "spout" and "steamAnchor" anchors.
// ---------------------------------------------------------------------------

export function buildCoffeeStation(mats: MaterialLibrary): THREE.Object3D {
  const root = new THREE.Group();
  root.name = "coffeeStation";

  const wood = hex(PALETTE.caramel);
  const machine = hex(PALETTE.slate);
  const dark = hex(PALETTE.slateDark);
  const parts = [
    paint(bevelSlab(1.8, 0.9, 0.9, 0.06).translate(0, 0.55, 0), wood),
    paint(roundedBox(0.14, 0.5, 0.14, 0.05).translate(-0.7, 0.25, -0.3), wood),
    paint(roundedBox(0.14, 0.5, 0.14, 0.05).translate(0.7, 0.25, -0.3), wood),
    paint(roundedBox(0.14, 0.5, 0.14, 0.05).translate(-0.7, 0.25, 0.3), wood),
    paint(roundedBox(0.14, 0.5, 0.14, 0.05).translate(0.7, 0.25, 0.3), wood),
    // Machine body, proud of the counter back.
    paint(roundedBox(0.7, 0.85, 0.6, 0.07).translate(0.25, 1.5, -0.1), machine),
    paint(roundedBox(0.5, 0.12, 0.4, 0.04).translate(0.25, 1.12, -0.02), dark),
    // Group-head block the spout hangs from.
    paint(roundedBox(0.24, 0.16, 0.24, 0.05).translate(0.25, 1.06, 0.08), dark),
    // Drip tray.
    paint(bevelSlab(0.5, 0.4, 0.08, 0.03).translate(0.25, 1.02, 0.18), machine),
    // Tiny mug on the tray.
    paint(capsule(0.09, 0.12).translate(0.25, 1.1, 0.18), hex(PALETTE.cream)),
  ];

  root.add(matte(mats, parts));

  root.add(anchor("spout", 0.25, 1.06, 0.08));
  root.add(anchor("steamAnchor", 0.25, 1.35, 0.08));
  return root;
}
