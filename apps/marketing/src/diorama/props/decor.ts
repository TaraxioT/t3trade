/**
 * Decor prop kit: nameplate, railings, antenna, vents, crate stacks, and
 * decorative pipe runs. Same construction rules as the other prop files:
 * merged matte clay for bulk, shared specialty materials for status/data
 * parts, named animatable children, no self-animation.
 */

import * as THREE from "three";
import { PALETTE } from "../config";
import { bevelSlab, capsule, mergeParts, paint, pipeAlong, roundedBox } from "../geometry";
import type { MaterialLibrary } from "../render/materials";
import { buildCrate } from "./trading";

export const PROPS_DECOR_VERSION = 1;

const hex = (c: string): string => c;

function matte(mats: MaterialLibrary, parts: THREE.BufferGeometry[]): THREE.Mesh {
  return new THREE.Mesh(mergeParts(parts), mats.matteVertex);
}

// ---------------------------------------------------------------------------
// Nameplate: brass plate with a geometric "T3" monogram built from painted
// boxes. No text, no textures, no canvas.
// ---------------------------------------------------------------------------

export function buildNameplate(mats: MaterialLibrary): THREE.Object3D {
  const root = new THREE.Group();
  root.name = "nameplate";

  const plate = new THREE.Mesh(
    mergeParts([paint(bevelSlab(2.2, 1.2, 0.14, 0.06).translate(0, 0, 0), PALETTE.brass)]),
    mats.brass,
  );
  root.add(plate);

  // Monogram: "T" from a top bar + stem; "3" from three bars with two
  // right-side connectors. Slate-dark clay on the brass face.
  const ink = hex(PALETTE.slateDark);
  const bar = 0.14;
  const parts = [
    // T (left glyph)
    roundedBox(0.62, bar, 0.06, 0.02).translate(-0.55, 0.34, 0.1),
    roundedBox(bar, 0.62, 0.06, 0.02).translate(-0.55, 0.05, 0.1),
    // 3 (right glyph): three horizontal bars.
    roundedBox(0.5, bar, 0.06, 0.02).translate(0.5, 0.34, 0.1),
    roundedBox(0.4, bar, 0.06, 0.02).translate(0.45, 0.05, 0.1),
    roundedBox(0.5, bar, 0.06, 0.02).translate(0.5, -0.24, 0.1),
    // Right connectors joining the bars into a 3 shape.
    roundedBox(bar, 0.24, 0.06, 0.02).translate(0.68, 0.19, 0.1),
    roundedBox(bar, 0.24, 0.06, 0.02).translate(0.68, -0.09, 0.1),
  ].map((g) => paint(g, ink));

  root.add(matte(mats, parts));
  return root;
}

// ---------------------------------------------------------------------------
// Railing: top rail, mid rail, and posts along the given length (X axis).
// ---------------------------------------------------------------------------

export function buildRailing(mats: MaterialLibrary, length: number): THREE.Object3D {
  const root = new THREE.Group();
  root.name = "railing";

  const len = Math.max(1.2, length);
  const rim = hex(PALETTE.mahoganyRim);
  const slate = hex(PALETTE.slate);

  const parts: THREE.BufferGeometry[] = [
    paint(roundedBox(len, 0.12, 0.12, 0.05).translate(0, 1.1, 0), rim),
    paint(roundedBox(len, 0.07, 0.07, 0.03).translate(0, 0.6, 0), rim),
  ];
  const posts = Math.max(2, Math.round(len / 1.2) + 1);
  for (let i = 0; i < posts; i++) {
    const x = -len / 2 + (len / (posts - 1)) * i;
    parts.push(paint(roundedBox(0.1, 1.12, 0.1, 0.04).translate(x, 0.56, 0), slate));
  }

  root.add(matte(mats, parts));
  return root;
}

// ---------------------------------------------------------------------------
// Antenna: mast plus a "rings" group of two pipe-circle status rings in mint.
// ---------------------------------------------------------------------------

export function buildAntenna(mats: MaterialLibrary): THREE.Object3D {
  const root = new THREE.Group();
  root.name = "antenna";

  const slate = hex(PALETTE.slate);
  const ringPts: { x: number; y: number; z: number }[] = [];
  for (let i = 0; i <= 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    ringPts.push({ x: Math.cos(a) * 0.55, y: 0, z: Math.sin(a) * 0.55 });
  }

  root.add(
    matte(mats, [
      paint(bevelSlab(0.9, 0.9, 0.16, 0.05).translate(0, 0.08, 0), slate),
      paint(capsule(0.08, 3.4).translate(0, 1.9, 0), slate),
      paint(capsule(0.16, 0.5).translate(0, 3.85, 0), hex(PALETTE.slateDark)),
    ]),
  );

  const rings = new THREE.Group();
  rings.name = "rings";
  const ring0 = new THREE.Mesh(
    mergeParts([paint(pipeAlong(ringPts, 0.05, 4), PALETTE.mintBright)]),
    mats.eyeMint,
  );
  ring0.position.y = 3.2;
  const ring1 = new THREE.Mesh(
    mergeParts([paint(pipeAlong(ringPts, 0.05, 4), PALETTE.mintBright)]),
    mats.eyeMint,
  );
  ring1.position.y = 2.6;
  ring1.scale.setScalar(0.8);
  rings.add(ring0, ring1);
  root.add(rings);

  return root;
}

// ---------------------------------------------------------------------------
// Vent: wall vent slab with proud darker slat strips.
// ---------------------------------------------------------------------------

export function buildVent(mats: MaterialLibrary): THREE.Object3D {
  const root = new THREE.Group();
  root.name = "vent";

  const slate = hex(PALETTE.slate);
  const dark = hex(PALETTE.slateDark);
  const parts: THREE.BufferGeometry[] = [
    paint(bevelSlab(0.9, 0.9, 0.12, 0.05).translate(0, 0, 0), slate),
  ];
  for (let i = 0; i < 4; i++) {
    parts.push(paint(roundedBox(0.62, 0.1, 0.05, 0.02).translate(0, 0.28 - i * 0.19, 0.08), dark));
  }

  root.add(matte(mats, parts));
  return root;
}

// ---------------------------------------------------------------------------
// Crate stack: static clutter of stacked crates with deterministic offsets.
// ---------------------------------------------------------------------------

export function buildCrateStack(mats: MaterialLibrary, count: number): THREE.Object3D {
  const root = new THREE.Group();
  root.name = "crateStack";

  const n = Math.max(1, Math.min(6, Math.round(count)));
  for (let i = 0; i < n; i++) {
    const layer = Math.floor(i / 2);
    const inLayer = i % 2;
    const crate = buildCrate(mats, 0.8 - layer * 0.08);
    crate.position.set(
      inLayer * 0.9 - (layer % 2 === 0 ? 0 : 0.45),
      layer * 0.9,
      (((i * 37) % 11) - 5) * 0.03,
    );
    crate.rotation.y = (((i * 53) % 10) - 5) * 0.03;
    root.add(crate);
  }

  return root;
}

// ---------------------------------------------------------------------------
// Decorative pipe run: thin pipe following the given polyline.
// ---------------------------------------------------------------------------

export function buildPipeRun(
  mats: MaterialLibrary,
  points: readonly { x: number; y: number; z: number }[],
  radius: number,
): THREE.Object3D {
  const root = new THREE.Group();
  root.name = "pipeRun";
  const pipe = new THREE.Mesh(
    mergeParts([paint(pipeAlong(points, radius, 8), hex(PALETTE.slateDark))]),
    mats.matteVertex,
  );
  root.add(pipe);
  return root;
}
