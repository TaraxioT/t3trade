/**
 * World composition (R2 atomic cutover): createWorld assembles the Bureau
 * Bazaar campus — stepped deck, raised terrace, all eight zone bays, and the
 * recomposed exchange satellite — into one BuiltWorld with the named anchor
 * and prop registries plus the REAL static shadow-caster list.
 *
 * Dynamic/animated subtrees (belt slats, stamp pivots, press ram, carousel,
 * ferry boat, launch cannon, exchange arm/claw/mint, story props) and every
 * emissive/unlit mesh are excluded from the frozen shadow bake; blob shadows
 * cover movers at runtime. Legacy v1 floor builders (plinth/research-loft/
 * trading-floor/risk-vault/roof) remain on disk unimported pending R6.
 */

import * as THREE from "three";
import { DIMENSIONS, PALETTE, PALETTE_V2 } from "../config";
import { STATIONS } from "../story/waypoints";
import {
  asAnchorId,
  asPropId,
  type AnchorId,
  type BuiltWorld,
  type PropHandle,
  type PropId,
  type SceneObject,
  type XYZ,
} from "../types";
import { buildOrderOrb, buildCrate, buildReceiptCoin } from "../props/trading";
import { bevelSlab, capsule, mergeParts, paint } from "../geometry";
import type { MaterialLibrary } from "../render/materials";
import type { ResourceRegistry } from "../render/resources";
import { buildSignMesh, type SignAtlas } from "../render/signAtlas";
import { buildDeck, type BazaarPart } from "./bazaar/deck";
import { buildTerrace } from "./bazaar/terrace";
import { buildDocks } from "./bazaar/zones/docks";
import { buildGreenhouse } from "./bazaar/zones/greenhouse";
import { buildPlan } from "./bazaar/zones/plan";
import { buildGauntletZone } from "./bazaar/zones/gauntlet";
import { buildMintZone } from "./bazaar/zones/mint";
import { buildLaunchZone } from "./bazaar/zones/launch";
import { buildBackOfficeZone } from "./bazaar/zones/backoffice";
import { buildOilBarZone } from "./bazaar/zones/oilbar";
import { buildExchange } from "./exchange";
import type { PropLibrary } from "./propLibrary";

export const WORLD_VERSION = 1;

const scene = (o: THREE.Object3D): SceneObject => o as unknown as SceneObject;

/** Optional R3 assets main.ts loads before synchronous world construction. */
export interface WorldAssets {
  readonly props: PropLibrary;
  readonly signs: SignAtlas;
}

/**
 * Subtrees whose meshes animate (or carry story props) and therefore must
 * never bake into the frozen static shadow map.
 */
const DYNAMIC_SUBTREES = new Set<string>([
  "gauntletBelt", // belt + slats scroll
  "stampDesk", // gauntlet station-7 stamper (stamp pivot + hidden marks)
  "pressRam", // mint press ram
  "carousel", // mint carousel + coinGlow
  "greenhouseFanDisc", // wind-tunnel fan
  "launchCannon", // order cannon parts
  "boat", // reconciler ferry boat
  "armBase", // exchange arm (armLift/claw inside)
  "mintPress", // exchange mint pivot
  "butterflyA", // greenhouse data butterflies (ambient hover)
  "butterflyB",
  "butterflyC",
]);

/** Staging spots for the plan crates near gauntletIn (spec: x -5..-3, z 8..10). */
const CRATE_SPOTS: readonly { id: string; x: number; z: number; yaw: number }[] = [
  { id: "crate-a", x: -4.6, z: 8.4, yaw: 0.2 },
  { id: "crate-b", x: -3.6, z: 8.7, yaw: -0.35 },
  { id: "crate-c", x: -4.9, z: 9.3, yaw: 0.5 },
  { id: "crate-d", x: -3.1, z: 9.5, yaw: -0.15 },
];

// ---------------------------------------------------------------------------
// R3 sign text placement (atlas cells onto the existing mount boards).
// ---------------------------------------------------------------------------

/**
 * Sign tilt. The mount boards in deck.ts use -20 degrees; the text planes
 * lead by 10 more degrees toward the camera and sit 0.4 higher (density
 * review fix B). Mount geometry itself is zone-owned and stays put.
 */
const SIGN_TILT = -Math.PI / 6;
const DECK_WALL_SIGN_Z = -9 + 0.35;

interface SignPlacement {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly w: number;
  readonly h: number;
}

/** Text plane sits just in front of each mount board along its normal. */
function deckWallSign(id: string, cx: number, y: number, w: number, h: number): SignPlacement {
  const nx = Math.sin(SIGN_TILT);
  const nz = Math.cos(SIGN_TILT);
  const off = 0.11;
  return { id, x: cx + nx * off, y, z: DECK_WALL_SIGN_Z + nz * off, yaw: SIGN_TILT, w, h };
}

function freeSign(
  id: string,
  x: number,
  y: number,
  z: number,
  yaw: number,
  w: number,
  h: number,
): SignPlacement {
  return { id, x, y, z, yaw, w, h };
}

const SAT = DIMENSIONS.composition.satellite;

const SIGN_PLACEMENTS: readonly SignPlacement[] = [
  // Deck back-wall zone signs (mounts at cx, y 5.2, z -8.65).
  deckWallSign("harnessDocks", -18, 5.6, 4.2, 0.84),
  deckWallSign("greenhouse", -11.5, 5.6, 4.2, 0.84),
  deckWallSign("activation", -5.5, 5.6, 4.2, 0.84),
  deckWallSign("gauntlet", 1, 5.6, 4.2, 0.84),
  deckWallSign("cloidMint", 7.5, 5.6, 4.2, 0.84),
  deckWallSign("launchBay", 12.5, 5.6, 4.2, 0.84),
  deckWallSign("backOffice", 18, 5.6, 4.2, 0.84),
  // RISK sub-sign under the gauntlet sign.
  deckWallSign("risk", 3.4, 4.6, 1.5, 0.5),
  // Terrace signs share the same back wall at y 5.2.
  deckWallSign("watchTower", 0, 5.2, 4.2, 0.84),
  deckWallSign("signerVault", 7, 5.2, 4.2, 0.84),
  deckWallSign("manualControl", -5, 5.2, 4.2, 0.84),
  deckWallSign("overseer", 14, 5.2, 4.2, 0.84),
  // Oil bar pole sign (mount built here; the pocket has none of its own).
  freeSign("oilBar", 16.4, 2.6, 8.86, Math.PI / 4, 1.7, 0.5),
  // Exchange pad edge sign (mount added in exchange.ts).
  freeSign("exchange", SAT.x + 2.24, SAT.y + 1.96, SAT.z + 2.24, Math.PI / 4, 2.5, 0.6),
];

// ---------------------------------------------------------------------------
// R3 GLB prop placement table (world coords; y is the surface height).
// Primary defaults to the zone's PALETTE_V2.zones color, overridden per item
// for hologram/special primaries.
// ---------------------------------------------------------------------------

interface PropPlacement {
  readonly zone: string;
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly primary?: string;
}

const Z = PALETTE_V2.zones;

const PROP_PLACEMENTS: readonly PropPlacement[] = [
  // Docks: desk + chair + computer on pads B and D; containers flank; banner.
  { zone: "docks", name: "desk", x: -19.2, y: 0.36, z: -6.2, yaw: 0.2 },
  { zone: "docks", name: "chairDesk", x: -19.2, y: 0.36, z: -5.4, yaw: Math.PI },
  { zone: "docks", name: "computer", x: -19.2, y: 1.66, z: -6.2, yaw: 0.2 },
  { zone: "docks", name: "desk", x: -16.8, y: 0.36, z: -6.2, yaw: -0.15 },
  { zone: "docks", name: "chairDesk", x: -16.8, y: 0.36, z: -5.4, yaw: Math.PI },
  { zone: "docks", name: "computer", x: -16.8, y: 1.66, z: -6.2, yaw: -0.15 },
  { zone: "docks", name: "container-tall", x: -20.6, y: 0, z: -7.8, yaw: 0.1 },
  { zone: "docks", name: "container-tall", x: -15.2, y: 0, z: -7.8, yaw: -0.12 },
  // Greenhouse: plants among the racks, holographic globe, lounge corner.
  { zone: "greenhouse", name: "pottedPlant", x: -14.2, y: 0, z: -3.0, yaw: 0.2 },
  { zone: "greenhouse", name: "pottedPlant", x: -9.0, y: 0, z: -2.2, yaw: -0.4 },
  { zone: "greenhouse", name: "plantSmall1", x: -13.8, y: 0, z: -6.8, yaw: 0 },
  { zone: "greenhouse", name: "plantSmall1", x: -10.8, y: 0, z: -6.9, yaw: 0.7 },
  { zone: "greenhouse", name: "plantSmall2", x: -12.3, y: 0, z: -7.0, yaw: 0.3 },
  {
    zone: "greenhouse",
    name: "table-display-planet",
    x: -11.5,
    y: 0,
    z: -1.5,
    yaw: 0.3,
    primary: Z.gauntlet,
  },
  { zone: "greenhouse", name: "loungeChair", x: -8.8, y: 0, z: 4.8, yaw: -0.6 },
  // Plan: desk trio by the TRADE.md desk; boxes by the chute; table lamp.
  { zone: "plan", name: "desk", x: -6.0, y: 0, z: -5.2, yaw: 0.1 },
  { zone: "plan", name: "computer-wide", x: -6.0, y: 1.3, z: -5.3, yaw: 0.1 },
  { zone: "plan", name: "chairDesk", x: -6.0, y: 0, z: -4.3, yaw: Math.PI },
  { zone: "plan", name: "cardboardBoxClosed", x: -5.2, y: 0, z: 1.2, yaw: 0.25 },
  { zone: "plan", name: "cardboardBoxClosed", x: -5.8, y: 0, z: 0.6, yaw: -0.4 },
  { zone: "plan", name: "lampRoundTable", x: -6.9, y: 1.3, z: -5.5, yaw: 0 },
  // Gauntlet: boxes at the reject bin, stools at station 7, wall lamp.
  { zone: "gauntlet", name: "cardboardBoxClosed", x: 3.6, y: 0, z: 9.8, yaw: 0.3 },
  { zone: "gauntlet", name: "cardboardBoxClosed", x: 4.9, y: 0, z: 10.2, yaw: -0.2 },
  { zone: "gauntlet", name: "container-flat-open", x: 4.2, y: 0, z: 11.0, yaw: 0.3 },
  { zone: "gauntlet", name: "stoolBar", x: 4.0, y: 0, z: 3.2, yaw: 0.1 },
  { zone: "gauntlet", name: "stoolBar", x: 5.2, y: 0, z: 3.4, yaw: -0.3 },
  { zone: "gauntlet", name: "lampWall", x: 0, y: 2.2, z: -8.55, yaw: -0.35 },
  // Mint: storage container and the coin hologram.
  { zone: "mint", name: "container-wide", x: 9.3, y: 0, z: -6.5, yaw: 0.2 },
  { zone: "mint", name: "table-display-small", x: 6.2, y: 0, z: -3.5, yaw: -0.3 },
  // Launch: container, open box at the safe line, antenna on the gauge pillar.
  { zone: "launch", name: "container-tall", x: 14.2, y: 0, z: -7.5, yaw: 0.15 },
  { zone: "launch", name: "cardboardBoxOpen", x: 10.6, y: 0, z: 3.4, yaw: -0.25 },
  { zone: "launch", name: "televisionAntenna", x: 11.7, y: 2.6, z: 3.9, yaw: 0 },
  // Back office: bookcases on the back wall, desk pairs, books, event wall.
  { zone: "backOffice", name: "bookcaseOpen", x: 15.5, y: 0, z: -8.1, yaw: 0 },
  { zone: "backOffice", name: "bookcaseClosedDoors", x: 17.6, y: 0, z: -8.1, yaw: 0 },
  { zone: "backOffice", name: "desk", x: 16.2, y: 0, z: -1.8, yaw: Math.PI },
  { zone: "backOffice", name: "computer", x: 16.2, y: 1.3, z: -1.7, yaw: Math.PI },
  { zone: "backOffice", name: "desk", x: 18.9, y: 0, z: -1.8, yaw: Math.PI },
  { zone: "backOffice", name: "computer", x: 18.9, y: 1.3, z: -1.7, yaw: Math.PI },
  { zone: "backOffice", name: "books", x: 15.9, y: 0, z: -2.6, yaw: 0.2 },
  { zone: "backOffice", name: "books", x: 19.2, y: 0, z: -2.4, yaw: -0.35 },
  { zone: "backOffice", name: "display-wall-wide", x: 19.0, y: 0, z: -7.4, yaw: Math.PI },
  { zone: "backOffice", name: "sideTable", x: 20.6, y: 0, z: -1.0, yaw: 0.4 },
  // Oil bar: bar stools by the counter, plant, side table.
  { zone: "oilBar", name: "stoolBar", x: 17.0, y: 0, z: 8.6, yaw: 0.15 },
  { zone: "oilBar", name: "stoolBar", x: 18.2, y: 0, z: 8.5, yaw: -0.2 },
  { zone: "oilBar", name: "stoolBar", x: 19.4, y: 0, z: 8.6, yaw: 0.3 },
  { zone: "oilBar", name: "plantSmall2", x: 16.4, y: 0, z: 11.4, yaw: 0 },
  { zone: "oilBar", name: "sideTable", x: 20.3, y: 0, z: 9.0, yaw: -0.4 },
  // Terrace: planters at the signer vault corners (slab top y 3.2).
  {
    zone: "terrace",
    name: "pottedPlant",
    x: 5.2,
    y: 3.2,
    z: -10.6,
    yaw: 0.2,
    primary: Z.greenhouse,
  },
  {
    zone: "terrace",
    name: "pottedPlant",
    x: 8.8,
    y: 3.2,
    z: -10.6,
    yaw: -0.3,
    primary: Z.greenhouse,
  },
  // Satellite: slot hologram (cool) and a small plant on the pad surface.
  {
    zone: "satellite",
    name: "table-display-small",
    x: SAT.x - 1.5,
    y: SAT.y + 0.09,
    z: SAT.z + 1.2,
    yaw: 2.4,
    primary: PALETTE.coolFill,
  },
  {
    zone: "satellite",
    name: "plantSmall1",
    x: SAT.x + 1.4,
    y: SAT.y + 0.09,
    z: SAT.z + 1.8,
    yaw: 0.5,
    primary: Z.greenhouse,
  },
  // Street scatter: loose boxes along the workspace strip.
  {
    zone: "street",
    name: "cardboardBoxClosed",
    x: -8.5,
    y: 0,
    z: 10.0,
    yaw: 0.35,
    primary: PALETTE_V2.boneDeck,
  },
  {
    zone: "street",
    name: "cardboardBoxClosed",
    x: 2.5,
    y: 0,
    z: 10.2,
    yaw: -0.2,
    primary: PALETTE_V2.boneDeck,
  },
  {
    zone: "street",
    name: "cardboardBoxClosed",
    x: 10.8,
    y: 0,
    z: 10.4,
    yaw: 0.5,
    primary: PALETTE_V2.boneDeck,
  },
];

/** Default primary for a placement with no override: the zone color. */
function zonePrimary(zone: string): string {
  const zones = PALETTE_V2.zones as Readonly<Record<string, string>>;
  return zones[zone] ?? PALETTE_V2.boneDeck;
}

/**
 * Bake every sign text plane into ONE mesh on the shared atlas material.
 * buildSignMesh builds each plane; this merge (position/normal/uv only —
 * mergeParts would strip UVs) holds the sign budget to a single draw call.
 */
function addSignTexts(root: THREE.Object3D, registry: ResourceRegistry, signs: SignAtlas): void {
  const kit = new THREE.Group();
  for (const p of SIGN_PLACEMENTS) {
    const mesh = buildSignMesh(signs.material, signs.uvFor(p.id), p.w, p.h);
    mesh.position.set(p.x, p.y, p.z);
    mesh.rotation.y = p.yaw;
    kit.add(mesh);
  }
  kit.updateMatrixWorld(true);

  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  kit.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const geo = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
    geo.applyMatrix4(o.matrixWorld);
    const pa = geo.attributes.position;
    const na = geo.attributes.normal;
    const ua = geo.attributes.uv;
    if (!pa || !na || !ua) return;
    for (let i = 0; i < pa.count; i++) {
      positions.push(pa.getX(i), pa.getY(i), pa.getZ(i));
      normals.push(na.getX(i), na.getY(i), na.getZ(i));
      uvs.push(ua.getX(i), ua.getY(i));
    }
  });
  const merged = new THREE.BufferGeometry();
  merged.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  merged.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  merged.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  registry.track(merged);
  const mesh = new THREE.Mesh(merged, signs.material);
  mesh.name = "signTexts";
  mesh.castShadow = false;
  root.add(mesh);
}

/** The oil bar pocket has no sign mount of its own: small pole + board. */
function addOilBarSignMount(
  root: THREE.Object3D,
  mats: MaterialLibrary,
  registry: ResourceRegistry,
): void {
  const yaw = Math.PI / 4;
  const board = bevelSlab(1.8, 0.1, 0.55, 0.03);
  board.rotateY(yaw);
  board.translate(16.4, 2.6, 8.8);
  const bar = bevelSlab(1.6, 0.08, 0.1, 0.02);
  bar.rotateY(yaw);
  bar.translate(16.4, 2.24, 8.8);
  const merged = registry.track(
    mergeParts([
      paint(capsule(0.06, 2.4).translate(16.4, 1.2, 8.8), PALETTE_V2.slateFrame),
      paint(board, PALETTE_V2.slateFrame),
      paint(bar, PALETTE_V2.zoneEmissive.oilBar),
    ]),
  );
  const mesh = new THREE.Mesh(merged, mats.matteVertex);
  mesh.name = "oilBarSignMount";
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  root.add(mesh);
}

/**
 * Place library props and merge them per PRIMARY MATERIAL (never one call
 * per prop). All placements are static: castShadow stays true so they bake
 * into the frozen shadow map.
 */
function addLibraryProps(
  root: THREE.Object3D,
  registry: ResourceRegistry,
  lib: PropLibrary,
): { placed: number; meshes: number } {
  const byMaterial = new Map<THREE.Material, THREE.BufferGeometry[]>();
  let placed = 0;
  for (const p of PROP_PLACEMENTS) {
    if (!lib.has(p.name)) continue;
    const mesh = lib.makeProp(p.name, p.primary ?? zonePrimary(p.zone));
    if (!mesh) continue;
    mesh.position.set(p.x, p.y, p.z);
    mesh.rotation.y = p.yaw;
    mesh.updateMatrixWorld(true);
    const list = byMaterial.get(mesh.material as THREE.Material) ?? [];
    list.push(mesh.geometry.clone().applyMatrix4(mesh.matrixWorld));
    byMaterial.set(mesh.material as THREE.Material, list);
    placed += 1;
  }
  let meshes = 0;
  for (const [material, geos] of byMaterial) {
    const merged = registry.track(mergeParts(geos));
    const mesh = new THREE.Mesh(merged, material);
    mesh.name = "propsStatic";
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    root.add(mesh);
    meshes += 1;
  }
  return { placed, meshes };
}

/**
 * Composition-review fix (round 2): the boat sits on a raised dock pad and
 * reads ~2.2 long, its lantern is a bigger emissive dot, bright wake lines
 * flank the hull, and the water tint is bluer / higher contrast.
 */
function fixFerryVignette(
  root: THREE.Object3D,
  backOffice: THREE.Object3D,
  mats: MaterialLibrary,
  registry: ResourceRegistry,
): void {
  // Raised dock pad under the boat (world geometry, merges into statics).
  const pad = new THREE.Mesh(
    registry.track(
      mergeParts([
        paint(bevelSlab(3.4, 2.4, 0.35, 0.06).translate(17.6, 0.175, 4.9), PALETTE_V2.slateFrame),
        paint(bevelSlab(3.0, 2.0, 0.08, 0.03).translate(17.6, 0.37, 4.9), PALETTE_V2.boneDeckLight),
      ]),
    ),
    mats.matteVertex,
  );
  pad.name = "ferryDockPad";
  pad.castShadow = true;
  pad.receiveShadow = true;
  root.add(pad);

  const boat = backOffice.getObjectByName("boat");
  if (boat) {
    boat.scale.setScalar(1.8);
    boat.position.y = 0.42;
    const lantern = boat.getObjectByName("lantern");
    if (lantern) lantern.scale.setScalar(1.5);
  }

  // Strengthened wake lines: bright emissive strips around the hull.
  const wake = new THREE.Mesh(
    registry.track(
      mergeParts([
        paint(bevelSlab(2.6, 0.16, 0.04, 0.01).translate(17.6, 0.1, 3.9), PALETTE_V2.boneDeckLight),
        paint(bevelSlab(2.6, 0.16, 0.04, 0.01).translate(17.6, 0.1, 5.9), PALETTE_V2.boneDeckLight),
        paint(
          bevelSlab(0.5, 0.12, 0.04, 0.01).translate(17.6, 0.1, 6.35),
          PALETTE_V2.boneDeckLight,
        ),
      ]),
    ),
    mats.signGlow,
  );
  wake.name = "ferryWake";
  root.add(wake);

  const water = backOffice.getObjectByName("ferryWater");
  if (water instanceof THREE.Mesh) {
    const color = water.geometry.getAttribute("color");
    if (color) {
      const tint = new THREE.Color("#2F6BD8");
      for (let i = 0; i < color.count; i++) color.setXYZ(i, tint.r, tint.g, tint.b);
      color.needsUpdate = true;
    }
  }
}

/**
 * Call-budget merge (review fix A): after assembly, every remaining static
 * mesh - regardless of zone - bakes into ONE mesh per MATERIAL. Zones lose
 * per-zone mesh identity. Kept separate: dynamic/animated subtrees
 * (DYNAMIC_SUBTREES), the story-prop subtree, and the merged sign plane.
 * Returns the number of merged meshes created.
 */
/** Static meshes that must survive the global merge as their own objects. */
const KEEP_SEPARATE_MESHES = new Set(["slotA", "slotB", "slotC"]);

function mergeWorldStatics(
  root: THREE.Object3D,
  registry: ResourceRegistry,
  propSubtree: Set<THREE.Object3D>,
): number {
  root.updateMatrixWorld(true);
  const byMaterial = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const doomed: THREE.Mesh[] = [];
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || !o.visible) return;
    // The merged sign plane stays its own single mesh, and the named slot
    // marks stay addressable as world anchors (the story lights them).
    if (o.name === "signTexts" || KEEP_SEPARATE_MESHES.has(o.name)) return;
    let cursor: THREE.Object3D | null = o;
    while (cursor) {
      if (propSubtree.has(cursor) || DYNAMIC_SUBTREES.has(cursor.name)) return;
      cursor = cursor.parent;
    }
    const geo = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
    geo.applyMatrix4(o.matrixWorld);
    if (!geo.attributes.color) paint(geo, "#FFFFFF");
    const list = byMaterial.get(o.material as THREE.Material) ?? [];
    list.push(geo);
    byMaterial.set(o.material as THREE.Material, list);
    doomed.push(o);
  });
  for (const mesh of doomed) mesh.parent?.remove(mesh);

  let created = 0;
  for (const [material, geos] of byMaterial) {
    const merged = registry.track(mergeParts(geos));
    const mesh = new THREE.Mesh(merged, material);
    mesh.name = "worldStatic";
    mesh.receiveShadow = true;
    mesh.castShadow = !(material instanceof THREE.MeshBasicMaterial);
    root.add(mesh);
    created += 1;
  }
  return created;
}

export function createWorld(
  mats: MaterialLibrary,
  registry: ResourceRegistry,
  assets?: WorldAssets,
): BuiltWorld {
  const root = new THREE.Group();
  root.name = "world";

  // ---- Bazaar shells --------------------------------------------------------
  const deck: BazaarPart = buildDeck(mats, registry);
  const terrace: BazaarPart = buildTerrace(mats, registry);
  root.add(deck.group, terrace.group);

  // ---- Zone bays ------------------------------------------------------------
  const docks = buildDocks(mats, registry);
  const greenhouse = buildGreenhouse(mats, registry);
  const plan = buildPlan(mats, registry);
  const gauntlet = buildGauntletZone(mats);
  const mint = buildMintZone(mats);
  const launch = buildLaunchZone(mats, registry);
  const backoffice = buildBackOfficeZone(mats, registry);
  const oilbar = buildOilBarZone(mats, registry);
  root.add(
    docks.group,
    greenhouse.group,
    plan.group,
    gauntlet,
    mint,
    launch.group,
    backoffice.group,
    oilbar.group,
  );

  // ---- Exchange satellite ---------------------------------------------------
  const exchange = buildExchange(mats, registry);
  root.add(exchange.group);

  // ---- R3 wiring: ferry fix, oil-bar sign mount, sign texts, GLB props ------
  fixFerryVignette(root, backoffice.group, mats, registry);
  addOilBarSignMount(root, mats, registry);
  if (assets?.signs) addSignTexts(root, registry, assets.signs);
  if (assets?.props) addLibraryProps(root, registry, assets.props);

  // ---- Anchor registry ------------------------------------------------------
  const anchors = new Map<AnchorId, SceneObject>();
  const put = (key: string, object: THREE.Object3D): void => {
    anchors.set(asAnchorId(key), scene(object));
  };

  // Deck + terrace record registries (anchors double as machine pads).
  for (const part of [deck, terrace]) {
    for (const [key, object] of Object.entries(part.anchors)) put(key, object);
  }
  // West-zone shells expose named anchor empties as an array.
  for (const zone of [docks, greenhouse, plan]) {
    for (const object of zone.anchors) put(object.name, object);
  }
  // East-zone shells and the exchange expose record registries.
  for (const zone of [launch, backoffice, oilbar, exchange]) {
    for (const [key, object] of Object.entries(zone.anchors)) put(key, object);
  }
  // Gauntlet + mint return bare groups whose plain Object3D children are the
  // authored anchor empties (machines are Mesh/Group children).
  for (const zone of [gauntlet, mint]) {
    for (const child of zone.children) {
      if (child instanceof THREE.Mesh || child instanceof THREE.Group) continue;
      put(child.name, child);
    }
  }
  // Gauntlet belt channels: slats scroll (old ticker/tape has no v2 source;
  // guarded story channels may skip), belt bed is the static hull.
  const belt = gauntlet.getObjectByName("gauntletBelt");
  const slats = belt?.getObjectByName("slats") ?? null;
  if (slats) {
    put("slats", slats);
    put("conveyorSlats", slats);
  }
  if (belt) put("conveyorBelt", belt);

  // Camera focus point over the street.
  const cameraFocus = new THREE.Object3D();
  cameraFocus.name = "cameraFocus";
  cameraFocus.position.set(0, 2.2, -2);
  root.add(cameraFocus);
  put("cameraFocus", cameraFocus);

  // Crate home anchors at the staging spots.
  const propRoot = new THREE.Group();
  propRoot.name = "worldProps";
  root.add(propRoot);
  for (const spot of CRATE_SPOTS) {
    const anchor = new THREE.Object3D();
    anchor.name = `${spot.id}Home`;
    anchor.position.set(spot.x, 0, spot.z);
    root.add(anchor);
    put(`${spot.id}Home`, anchor);
  }

  // ---- Prop registry ---------------------------------------------------------
  root.updateMatrixWorld(true);
  const props = new Map<PropId, PropHandle>();
  const registerProp = (
    id: string,
    object: THREE.Object3D,
    homeKey: string,
    homePosition: THREE.Vector3,
    visible: boolean,
  ): void => {
    object.name = id;
    object.position.copy(homePosition);
    object.visible = visible;
    propRoot.add(object);
    props.set(asPropId(id), {
      propId: asPropId(id),
      object: scene(object),
      homeAnchorId: asAnchorId(homeKey),
    });
  };

  for (const spot of CRATE_SPOTS) {
    registerProp(
      spot.id,
      buildCrate(mats, 0.85),
      `${spot.id}Home`,
      new THREE.Vector3(spot.x, 0, spot.z),
      true,
    );
    propRoot.children[propRoot.children.length - 1].rotation.y = spot.yaw;
  }

  // Order orb: hidden at the launch cannon breech until the launch beat.
  const breech = launch.group.getObjectByName("breech");
  const breechPos = new THREE.Vector3();
  if (breech) {
    breech.getWorldPosition(breechPos);
    put("breech", breech);
  }
  registerProp("orderOrb", buildOrderOrb(mats), "breech", breechPos, false);

  // Receipt coins: hidden at the satellite mint anchor (mintStationV2).
  const mintAnchor = new THREE.Object3D();
  mintAnchor.name = "mintStation";
  mintAnchor.position.set(
    STATIONS.mintStationV2.x,
    STATIONS.mintStationV2.y + 0.6,
    STATIONS.mintStationV2.z,
  );
  root.add(mintAnchor);
  put("mintStation", mintAnchor);
  const mintPos = mintAnchor.position.clone();
  registerProp("receiptCoin-1", buildReceiptCoin(mats), "mintStation", mintPos, false);
  registerProp(
    "receiptCoin-2",
    buildReceiptCoin(mats),
    "mintStation",
    mintPos.clone().add(new THREE.Vector3(0.4, 0, 0.2)),
    false,
  );

  // ---- REAL static shadow-caster list ----------------------------------------
  // Excluded: the story-prop subtree, animated subtrees (DYNAMIC_SUBTREES),
  // and every unlit/emissive mesh (basic materials are glows and data marks,
  // never shadow geometry). Everything else is static architecture/machines.
  const propSubtree = new Set<THREE.Object3D>();
  propRoot.traverse((o) => propSubtree.add(o));

  // Call-budget merge (review fix A): collapse every static mesh into one
  // mesh per material, world-wide. Must run before the caster inventory so
  // the casters reference the merged meshes.
  mergeWorldStatics(root, registry, propSubtree);

  const casters: SceneObject[] = [];
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    let cursor: THREE.Object3D | null = o;
    let dynamic = false;
    while (cursor) {
      if (propSubtree.has(cursor) || DYNAMIC_SUBTREES.has(cursor.name)) {
        dynamic = true;
        break;
      }
      cursor = cursor.parent;
    }
    const emissive = o.material instanceof THREE.MeshBasicMaterial;
    o.receiveShadow = true;
    o.castShadow = !dynamic && !emissive;
    if (o.castShadow) casters.push(scene(o));
  });

  return {
    root: scene(root),
    anchors,
    props,
    staticShadowCasters: casters,
  };
}

// ---------------------------------------------------------------------------
// Practical light table (consumed by main via lights.addPractical).
//
// NOTE: types.ts BuiltWorld has no `practicals` field, so the table is
// exported here as plain data. Intensities match LIGHT_TUNING.practical (0.9).
// `color` is advisory for cool/magenta practicals; addPractical currently
// emits warm light only.
// ---------------------------------------------------------------------------

export interface WorldPractical {
  readonly id: string;
  readonly position: XYZ;
  readonly intensity: number;
  /** Advisory tint for non-warm practicals (beacon, vault, satellite). */
  readonly color?: string;
}

export function worldPracticals(): readonly WorldPractical[] {
  const sat = DIMENSIONS.composition.satellite;
  return [
    // One warm practical per zone at its sign/machine cluster.
    { id: "docks", position: { x: -18, y: 2.2, z: -4 }, intensity: 0.9 },
    { id: "greenhouse", position: { x: -11.5, y: 2.2, z: -4 }, intensity: 0.9 },
    { id: "plan", position: { x: -5.5, y: 2.2, z: -4 }, intensity: 0.9 },
    { id: "gauntlet", position: { x: 1, y: 2.2, z: -4 }, intensity: 0.9 },
    { id: "mint", position: { x: 7.5, y: 2.2, z: -4 }, intensity: 0.9 },
    { id: "launch", position: { x: 12.5, y: 2.2, z: -4 }, intensity: 0.9 },
    { id: "backOffice", position: { x: 18, y: 2.2, z: -4 }, intensity: 0.9 },
    // Oil bar pocket.
    { id: "oilBar", position: { x: 18.5, y: 2.0, z: 10 }, intensity: 0.9 },
    // Terrace: watch beacon (cool magenta) and signer vault (mint).
    { id: "watchBeacon", position: { x: 0, y: 9, z: -12 }, intensity: 0.9, color: "#D64FA6" },
    { id: "signerVault", position: { x: 7, y: 5.5, z: -11 }, intensity: 0.9, color: "#3DDC97" },
    // Exchange satellite slot wall (cool).
    {
      id: "slotWall",
      position: { x: sat.x + 1.2, y: sat.y + 1.4, z: sat.z - 1 },
      intensity: 0.9,
      color: "#8FA3AD",
    },
  ];
}
