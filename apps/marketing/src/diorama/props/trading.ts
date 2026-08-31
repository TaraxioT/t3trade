/**
 * Trading prop kit: chart wall, ticker board, crates, risk-gate furniture,
 * vault door, order cannon, orbs, receipts, conveyor, chute, and tray.
 *
 * Same rules as furniture.ts: one merged matte mesh per prop via paint() +
 * mergeParts(); emissive/data parts are separate named meshes on shared
 * materials; animatable parts are named children; no self-animation.
 */

import * as THREE from "three";
import { PALETTE } from "../config";
import { bevelSlab, capsule, disc, mergeParts, paint, pipeAlong, roundedBox } from "../geometry";
import type { MaterialLibrary } from "../render/materials";

export const PROPS_TRADING_VERSION = 1;

const hex = (c: string): string => c;

function matte(mats: MaterialLibrary, parts: THREE.BufferGeometry[]): THREE.Mesh {
  return new THREE.Mesh(mergeParts(parts), mats.matteVertex);
}

/** Data-mark mesh (basic material; paint color is inert, kept uniform). */
function dataMesh(
  mats: MaterialLibrary,
  material: THREE.Material,
  color: string,
  parts: THREE.BufferGeometry[],
): THREE.Mesh {
  void mats;
  return new THREE.Mesh(mergeParts(parts.map((g) => paint(g, color))), material);
}

function anchor(name: string, x: number, y: number, z: number): THREE.Object3D {
  const o = new THREE.Object3D();
  o.name = name;
  o.position.set(x, y, z);
  return o;
}

/** Deterministic candle heights so the wall reads as one authored chart. */
const CANDLE_SHAPE: readonly { up: boolean; body: number; wickTop: number }[] = [
  { up: true, body: 0.5, wickTop: 0.7 },
  { up: true, body: 0.7, wickTop: 1.0 },
  { up: true, body: 0.45, wickTop: 0.6 },
  { up: false, body: 0.9, wickTop: 1.3 }, // the big red drop
  { up: false, body: 0.3, wickTop: 0.4 },
  { up: true, body: 0.65, wickTop: 0.85 },
  { up: true, body: 1.0, wickTop: 1.35 },
  { up: true, body: 0.55, wickTop: 0.75 },
];

// ---------------------------------------------------------------------------
// Chart wall: framed panel with 8 named candle data marks (c0..c7).
// ---------------------------------------------------------------------------

export function buildChartWall(mats: MaterialLibrary, width: number): THREE.Object3D {
  const root = new THREE.Group();
  root.name = "chartWall";

  const w = Math.max(2.4, width);
  const frame = hex(PALETTE.mahoganyRim);
  const panel = hex(PALETTE.slate);

  root.add(
    matte(mats, [
      paint(bevelSlab(w, 2.6, 0.14, 0.05).translate(0, 1.5, 0), frame),
      paint(bevelSlab(w - 0.3, 2.3, 0.08, 0.04).translate(0, 1.5, 0.09), panel),
    ]),
  );

  const candles = new THREE.Group();
  candles.name = "candles";
  const span = w - 0.8;
  CANDLE_SHAPE.forEach((c, i) => {
    const x = -span / 2 + (span / (CANDLE_SHAPE.length - 1)) * i;
    const bodyGeo = roundedBox(0.24, c.body, 0.1, 0.03).translate(x, 1.0 + c.body / 2 - 0.35, 0.16);
    const wickGeo = roundedBox(0.05, c.wickTop + 0.25, 0.05, 0.02).translate(
      x,
      1.0 + c.wickTop / 2 - 0.35,
      0.16,
    );
    const mesh = dataMesh(
      mats,
      c.up ? mats.dataGreen : mats.dataRed,
      c.up ? PALETTE.dataGreen : PALETTE.dataRed,
      [bodyGeo, wickGeo],
    );
    mesh.name = `c${i}`;
    candles.add(mesh);
  });
  root.add(candles);

  return root;
}

// ---------------------------------------------------------------------------
// Ticker board: slate board with a scrollable "tape" of green/red marks.
// The tape is a group of two merged meshes (one per data color) so a single
// position offset scrolls every mark.
// ---------------------------------------------------------------------------

const TAPE_MARKS = 14;

export function buildTickerBoard(mats: MaterialLibrary, width: number): THREE.Object3D {
  const root = new THREE.Group();
  root.name = "tickerBoard";

  const w = Math.max(2.0, width);
  const frame = hex(PALETTE.slateDark);

  root.add(
    matte(mats, [
      paint(bevelSlab(w, 0.9, 0.16, 0.05).translate(0, 2.2, 0), frame),
      paint(bevelSlab(w + 0.2, 0.18, 0.2, 0.05).translate(0, 1.7, 0), frame),
      paint(roundedBox(0.14, 1.7, 0.14, 0.05).translate(-w / 2, 0.85, 0), hex(PALETTE.slate)),
      paint(roundedBox(0.14, 1.7, 0.14, 0.05).translate(w / 2, 0.85, 0), hex(PALETTE.slate)),
    ]),
  );

  // Off-state face.
  const face = new THREE.Mesh(
    mergeParts([
      paint(bevelSlab(w - 0.25, 0.6, 0.06, 0.03).translate(0, 2.2, 0.1), PALETTE.slateDark),
    ]),
    mats.screenDark,
  );
  root.add(face);

  // Tape: alternating green/red tick marks the story scrolls along X.
  const tape = new THREE.Group();
  tape.name = "tape";
  const greens: THREE.BufferGeometry[] = [];
  const reds: THREE.BufferGeometry[] = [];
  for (let i = 0; i < TAPE_MARKS; i++) {
    const g = roundedBox(i % 2 === 0 ? 0.22 : 0.14, 0.1, 0.04, 0.02).translate(
      -((TAPE_MARKS - 1) * 0.3) / 2 + i * 0.3,
      2.28,
      0.15,
    );
    (i % 2 === 0 ? greens : reds).push(g);
  }
  tape.add(dataMesh(mats, mats.dataGreen, PALETTE.dataGreen, greens));
  tape.add(dataMesh(mats, mats.dataRed, PALETTE.dataRed, reds));
  root.add(tape);

  return root;
}

// ---------------------------------------------------------------------------
// Crate: caramel carry-crate with light trim and a paper manifest patch.
// Base footprint ~1.1 at scale 1.
// ---------------------------------------------------------------------------

export function buildCrate(mats: MaterialLibrary, scale = 1): THREE.Object3D {
  const root = new THREE.Group();
  root.name = "crate";

  const wood = hex(PALETTE.caramel);
  const trim = hex(PALETTE.caramelLight);

  const parts = [
    paint(bevelSlab(1.1, 1.1, 0.14, 0.05).translate(0, 0.55, 0.48), trim),
    paint(bevelSlab(1.1, 1.1, 0.14, 0.05).translate(0, 0.55, -0.48), trim),
    paint(bevelSlab(1.1, 0.14, 0.82, 0.05).translate(0, 1.03, 0), trim),
    paint(bevelSlab(1.1, 0.14, 0.82, 0.05).translate(0, 0.07, 0), trim),
    // Slatted core.
    paint(bevelSlab(0.9, 0.9, 0.9, 0.06).translate(0, 0.55, 0), wood),
  ];

  root.add(matte(mats, parts));

  // Paper manifest patch.
  const manifest = new THREE.Mesh(
    mergeParts([
      paint(bevelSlab(0.3, 0.22, 0.03, 0.01).translate(0.18, 0.68, 0.56), PALETTE.cream),
    ]),
    mats.paper,
  );
  root.add(manifest);

  root.scale.setScalar(scale);
  return root;
}

// ---------------------------------------------------------------------------
// Stamp desk: guard desk with a stamp pivot and hidden approve/reject marks.
// ---------------------------------------------------------------------------

export function buildStampDesk(mats: MaterialLibrary): THREE.Object3D {
  const root = new THREE.Group();
  root.name = "stampDesk";

  const wood = hex(PALETTE.caramel);
  const dark = hex(PALETTE.slate);

  root.add(
    matte(mats, [
      paint(bevelSlab(2.0, 1.0, 0.14, 0.05).translate(0, 1.08, 0), hex(PALETTE.caramelLight)),
      paint(roundedBox(0.14, 1.0, 0.14, 0.05).translate(-0.85, 0.5, -0.35), wood),
      paint(roundedBox(0.14, 1.0, 0.14, 0.05).translate(0.85, 0.5, -0.35), wood),
      paint(roundedBox(0.14, 1.0, 0.14, 0.05).translate(-0.85, 0.5, 0.35), wood),
      paint(roundedBox(0.14, 1.0, 0.14, 0.05).translate(0.85, 0.5, 0.35), wood),
      // Ink pads block.
      paint(roundedBox(0.5, 0.08, 0.3, 0.03).translate(0.55, 1.19, 0.1), dark),
    ]),
  );

  // Stamp pivot: rotate about the knob to slam the head down.
  const stamp = new THREE.Group();
  stamp.name = "stamp";
  stamp.position.set(-0.35, 1.15, 0.1);
  const head = new THREE.Mesh(
    mergeParts([paint(bevelSlab(0.34, 0.34, 0.2, 0.05).translate(0, 0.17, 0), PALETTE.slateDark)]),
    mats.darkMetal,
  );
  const knob = new THREE.Mesh(
    mergeParts([paint(capsule(0.07, 0.22).translate(0, 0.44, 0), PALETTE.brass)]),
    mats.brass,
  );
  stamp.add(head, knob);
  root.add(stamp);

  // Hidden outcome marks, revealed by the story on stamp impact.
  const approve = new THREE.Mesh(
    mergeParts([paint(bevelSlab(0.36, 0.36, 0.03, 0.01), PALETTE.dataGreen)]),
    mats.dataGreen,
  );
  approve.name = "approveMark";
  approve.position.set(-0.35, 1.165, 0.1);
  approve.rotation.x = -Math.PI / 2;
  approve.visible = false;
  const reject = new THREE.Mesh(
    mergeParts([paint(bevelSlab(0.36, 0.36, 0.03, 0.01), PALETTE.dataRed)]),
    mats.dataRed,
  );
  reject.name = "rejectMark";
  reject.position.set(-0.35, 1.165, 0.1);
  reject.rotation.x = -Math.PI / 2;
  reject.visible = false;
  root.add(approve, reject);

  return root;
}

// ---------------------------------------------------------------------------
// Vault door: frame plus a "pivot" group at the hinge edge holding the round
// door, so a Y rotation swings it open.
// ---------------------------------------------------------------------------

export function buildVaultDoor(mats: MaterialLibrary): THREE.Object3D {
  const root = new THREE.Group();
  root.name = "vaultDoor";

  const frameColor = hex(PALETTE.mahoganyPlinth);
  // Frame: two jambs and a lintel around a 2.4 wide x 2.8 tall opening.
  root.add(
    matte(mats, [
      paint(roundedBox(0.5, 3.4, 0.9, 0.08).translate(-1.45, 1.7, 0), frameColor),
      paint(roundedBox(0.5, 3.4, 0.9, 0.08).translate(1.45, 1.7, 0), frameColor),
      paint(bevelSlab(3.4, 0.9, 0.5, 0.08).translate(0, 3.15, 0), frameColor),
    ]),
  );

  // Round door inside a pivot group anchored at the hinge (-X) edge.
  const pivot = new THREE.Group();
  pivot.name = "pivot";
  pivot.position.set(-1.2, 1.4, 0);

  const doorColor = hex(PALETTE.slate);
  const doorParts = [
    paint(
      capsule(1.2, 0.3, 14)
        .rotateX(Math.PI / 2)
        .translate(1.2, 0, 0.05),
      doorColor,
    ),
  ];
  // Brass rim ring and radial spokes via pipe circles / boxes.
  const ringPts: { x: number; y: number; z: number }[] = [];
  for (let i = 0; i <= 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    ringPts.push({ x: 1.2 + Math.cos(a) * 1.05, y: Math.sin(a) * 1.05, z: 0.24 });
  }
  doorParts.push(paint(pipeAlong(ringPts, 0.06, 4), hex(PALETTE.brass)));
  doorParts.push(paint(roundedBox(1.4, 0.12, 0.12, 0.04).translate(1.2, 0, 0.26), doorColor));
  doorParts.push(paint(roundedBox(0.12, 1.4, 0.12, 0.04).translate(1.2, 0, 0.26), doorColor));
  pivot.add(matte(mats, doorParts));

  // Central hub the guard spins.
  const hub = new THREE.Mesh(
    mergeParts([
      paint(
        capsule(0.2, 0.18, 12)
          .rotateX(Math.PI / 2)
          .translate(1.2, 0, 0.3),
        PALETTE.brass,
      ),
    ]),
    mats.brass,
  );
  pivot.add(hub);

  root.add(pivot);
  return root;
}

// ---------------------------------------------------------------------------
// Cannon: pneumatic orb launcher with breech anchor, crank pivot, gauge+needle.
// ---------------------------------------------------------------------------

export function buildCannon(mats: MaterialLibrary): THREE.Object3D {
  const root = new THREE.Group();
  root.name = "cannon";

  const slate = hex(PALETTE.slate);

  root.add(
    matte(mats, [
      paint(bevelSlab(1.6, 2.6, 0.3, 0.08).translate(0, 0.15, 0), slate),
      paint(roundedBox(0.5, 0.7, 0.5, 0.1).translate(0, 0.62, 0), slate),
      paint(roundedBox(0.4, 0.4, 0.4, 0.08).translate(-0.9, 1.3, 0.5), hex(PALETTE.slateDark)),
    ]),
  );

  // Barrel: capsule lying along +X, dark metal, raised muzzle.
  const barrel = new THREE.Mesh(
    mergeParts([
      paint(
        capsule(0.34, 2.2, 16)
          .rotateZ(Math.PI / 2)
          .translate(0.7, 1.25, 0),
        PALETTE.slateDark,
      ),
    ]),
    mats.darkMetal,
  );
  root.add(barrel);
  // Muzzle ring.
  const ringPts: { x: number; y: number; z: number }[] = [];
  for (let i = 0; i <= 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    ringPts.push({ x: 1.85, y: 1.25 + Math.cos(a) * 0.4, z: Math.sin(a) * 0.4 });
  }
  root.add(
    new THREE.Mesh(
      mergeParts([paint(pipeAlong(ringPts, 0.06, 4), hex(PALETTE.brass))]),
      mats.matteVertex,
    ),
  );

  // Breech anchor where the orb loads.
  root.add(anchor("breech", -0.75, 1.25, 0));

  // Crank pivot on the side with brass crank arms.
  const crank = new THREE.Group();
  crank.name = "crank";
  crank.position.set(-0.2, 0.95, 0.55);
  const crankMesh = new THREE.Mesh(
    mergeParts([
      paint(roundedBox(0.08, 0.5, 0.08, 0.03).translate(0, 0.25, 0), PALETTE.brass),
      paint(roundedBox(0.26, 0.08, 0.08, 0.03).translate(0.13, 0.5, 0), PALETTE.brass),
    ]),
    mats.brass,
  );
  crank.add(crankMesh);
  root.add(crank);

  // Pressure gauge with a needle child that pegs under overpressure.
  const gauge = new THREE.Group();
  gauge.name = "gauge";
  gauge.position.set(0.55, 1.62, 0.3);
  gauge.add(
    new THREE.Mesh(
      mergeParts([paint(capsule(0.26, 0.1, 14).rotateX(Math.PI / 2), PALETTE.brass)]),
      mats.brass,
    ),
  );
  const face = new THREE.Mesh(
    mergeParts([
      paint(
        disc(0.2, 12)
          .rotateX(Math.PI / 2)
          .translate(0, 0, 0.07),
        PALETTE.cream,
      ),
    ]),
    mats.paper,
  );
  const needle = new THREE.Mesh(
    mergeParts([
      paint(roundedBox(0.04, 0.16, 0.02, 0.01).translate(0, 0.07, 0.09), PALETTE.slateDark),
    ]),
    mats.darkMetal,
  );
  needle.name = "needle";
  gauge.add(face, needle);
  root.add(gauge);

  return root;
}

// ---------------------------------------------------------------------------
// Order orb: the single emerald payload, with a "glow" inner sphere.
// ---------------------------------------------------------------------------

export function buildOrderOrb(mats: MaterialLibrary): THREE.Object3D {
  const root = new THREE.Group();
  root.name = "orderOrb";

  const orb = new THREE.Mesh(
    mergeParts([paint(capsule(0.55, 0.001, 20), PALETTE.mintBright)]),
    mats.orb,
  );
  root.add(orb);

  const glow = new THREE.Mesh(
    mergeParts([paint(capsule(0.38, 0.001, 14), PALETTE.mintBright)]),
    mats.eyeMint,
  );
  glow.name = "glow";
  root.add(glow);

  return root;
}

// ---------------------------------------------------------------------------
// Receipt coin: small brass coin with a mint tick.
// ---------------------------------------------------------------------------

export function buildReceiptCoin(mats: MaterialLibrary): THREE.Object3D {
  const root = new THREE.Group();
  root.name = "receiptCoin";

  const coin = new THREE.Mesh(
    mergeParts([paint(capsule(0.35, 0.07, 18).rotateX(Math.PI / 2), PALETTE.brass)]),
    mats.brass,
  );
  root.add(coin);

  const tick = new THREE.Mesh(
    mergeParts([paint(roundedBox(0.06, 0.3, 0.06, 0.02), PALETTE.mintBright)]),
    mats.eyeMint,
  );
  tick.rotation.x = Math.PI / 2;
  tick.position.set(0, 0, 0.06);
  root.add(tick);

  return root;
}

// ---------------------------------------------------------------------------
// Conveyor: belt on legs. "belt" is the dark bed mesh; "slats" is a merged
// slat strip (one extra pitch past each end) the story offsets along +X and
// wraps modulo the pitch.
// ---------------------------------------------------------------------------

export function buildConveyor(mats: MaterialLibrary, length: number): THREE.Object3D {
  const root = new THREE.Group();
  root.name = "conveyor";

  const len = Math.max(2, length);
  const slate = hex(PALETTE.slate);

  const legParts: THREE.BufferGeometry[] = [];
  const legs = Math.max(2, Math.round(len / 2.4));
  for (let i = 0; i < legs; i++) {
    const x = -len / 2 + 0.4 + ((len - 0.8) / (legs - 1)) * i;
    legParts.push(paint(roundedBox(0.16, 0.85, 0.9, 0.05).translate(x, 0.42, 0), slate));
  }

  root.add(
    matte(mats, [
      ...legParts,
      paint(roundedBox(0.12, 0.3, 1.0, 0.05).translate(-len / 2, 1.1, 0), slate),
      paint(roundedBox(0.12, 0.3, 1.0, 0.05).translate(len / 2, 1.1, 0), slate),
    ]),
  );

  // Belt bed.
  const belt = new THREE.Mesh(
    mergeParts([
      paint(bevelSlab(len, 1.0, 0.14, 0.04).translate(0, 1.06, 0), hex(PALETTE.slateDark)),
    ]),
    mats.matteVertex,
  );
  belt.name = "belt";
  root.add(belt);

  // Slat strip: caramel slats, one extra pitch each end for seamless wrap.
  const pitch = 0.5;
  const count = Math.floor(len / pitch) + 2;
  const slatParts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < count; i++) {
    slatParts.push(
      paint(
        bevelSlab(0.16, 1.0, 0.06, 0.02).translate(-len / 2 - pitch + i * pitch, 1.16, 0),
        hex(PALETTE.caramelLight),
      ),
    );
  }
  const slats = new THREE.Mesh(mergeParts(slatParts), mats.matteVertex);
  slats.name = "slats";
  root.add(slats);

  return root;
}

// ---------------------------------------------------------------------------
// Reject chute: angled slide down-and-out with an "exit" anchor at the bottom.
// ---------------------------------------------------------------------------

export function buildRejectChute(mats: MaterialLibrary): THREE.Object3D {
  const root = new THREE.Group();
  root.name = "rejectChute";

  const slate = hex(PALETTE.slate);
  const parts = [
    // Slide bed rotated to run down toward +X.
    paint(
      bevelSlab(2.6, 1.0, 0.12, 0.04).rotateZ(-0.42).translate(0.4, 1.5, 0),
      hex(PALETTE.slateDark),
    ),
    paint(roundedBox(2.6, 0.34, 0.12, 0.05).rotateZ(-0.42).translate(0.47, 1.71, 0.5), slate),
    paint(roundedBox(2.6, 0.34, 0.12, 0.05).rotateZ(-0.42).translate(0.47, 1.71, -0.5), slate),
    // Support post.
    paint(roundedBox(0.16, 2.4, 0.16, 0.05).translate(-0.7, 1.2, 0.4), slate),
  ];

  root.add(matte(mats, parts));
  root.add(anchor("exit", 1.5, 1.0, 0));
  return root;
}

// ---------------------------------------------------------------------------
// Receipt tray: catch tray with a "coinSlot" anchor.
// ---------------------------------------------------------------------------

export function buildReceiptTray(mats: MaterialLibrary): THREE.Object3D {
  const root = new THREE.Group();
  root.name = "receiptTray";

  const wood = hex(PALETTE.mahoganyPlinth);
  root.add(
    matte(mats, [
      paint(bevelSlab(1.0, 0.7, 0.1, 0.04).translate(0, 0.55, 0), wood),
      paint(roundedBox(1.0, 0.26, 0.1, 0.04).translate(0, 0.7, -0.3), wood),
      paint(roundedBox(0.1, 0.26, 0.7, 0.04).translate(-0.45, 0.7, 0), wood),
      paint(roundedBox(0.1, 0.26, 0.7, 0.04).translate(0.45, 0.7, 0), wood),
      paint(roundedBox(0.12, 0.5, 0.12, 0.04).translate(-0.35, 0.25, -0.2), wood),
      paint(roundedBox(0.12, 0.5, 0.12, 0.04).translate(0.35, 0.25, -0.2), wood),
    ]),
  );

  root.add(anchor("coinSlot", 0, 0.62, 0.05));
  return root;
}
