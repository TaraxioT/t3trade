/**
 * World composition (M04b): createWorld assembles the plinth, the three
 * cutaway bureau floors, the roof, and the exchange satellite into one
 * BuiltWorld with named anchor and prop registries plus the static
 * shadow-caster list.
 *
 * Machines sit exactly at the STATIONS coordinates from story/waypoints;
 * free composition is limited to shells, clutter, and decor. Story props
 * (crates, order orb, receipt coins) start parked and hidden at their home
 * anchors for the fleet/director to pick up.
 */

import * as THREE from "three";
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
import type { MaterialLibrary } from "../render/materials";
import type { ResourceRegistry } from "../render/resources";
import { buildExchange } from "./exchange";
import { buildPlinth, type WorldPart } from "./plinth";
import { buildResearchLoft } from "./research-loft";
import { buildRiskVault } from "./risk-vault";
import { buildRoof } from "./roof";
import { buildTradingFloor } from "./trading-floor";

export const WORLD_VERSION = 1;

const scene = (o: THREE.Object3D): SceneObject => o as unknown as SceneObject;

/** Staging spots for the plan crates around conveyorIn (trading floor). */
const CRATE_SPOTS: readonly { id: string; x: number; z: number; yaw: number }[] = [
  { id: "crate-a", x: -3.4, z: 6.0, yaw: 0.2 },
  { id: "crate-b", x: -2.2, z: 6.25, yaw: -0.35 },
  { id: "crate-c", x: -1.0, z: 6.0, yaw: 0.5 },
  { id: "crate-d", x: -3.0, z: 6.95, yaw: -0.15 },
];

export function createWorld(mats: MaterialLibrary, registry: ResourceRegistry): BuiltWorld {
  const root = new THREE.Group();
  root.name = "world";

  const parts: WorldPart[] = [
    buildPlinth(mats, registry),
    buildRiskVault(mats, registry),
    buildTradingFloor(mats, registry),
    buildResearchLoft(mats, registry),
    buildRoof(mats, registry),
    buildExchange(mats, registry),
  ];
  for (const part of parts) root.add(part.group);

  // ---- Anchor registry ------------------------------------------------------
  const anchors = new Map<AnchorId, SceneObject>();
  // Anchors stay wherever their builder parented them (machine children keep
  // their local offsets); the registry only records the references.
  for (const part of parts) {
    for (const [key, object] of Object.entries(part.anchors)) {
      anchors.set(asAnchorId(key), scene(object));
    }
  }

  // Camera focus point over the bureau core.
  const cameraFocus = new THREE.Object3D();
  cameraFocus.name = "cameraFocus";
  cameraFocus.position.set(-1, 3.2, 1);
  root.add(cameraFocus);
  anchors.set(asAnchorId("cameraFocus"), scene(cameraFocus));

  // Crate home anchors at the staging spots.
  const propRoot = new THREE.Group();
  propRoot.name = "worldProps";
  root.add(propRoot);
  for (const spot of CRATE_SPOTS) {
    const anchor = new THREE.Object3D();
    anchor.name = `${spot.id}Home`;
    anchor.position.set(spot.x, STATIONS.conveyorIn.y, spot.z);
    root.add(anchor);
    anchors.set(asAnchorId(`${spot.id}Home`), scene(anchor));
  }
  // Mint station anchor for the receipt coins.
  const mintAnchor = new THREE.Object3D();
  mintAnchor.name = "mintStation";
  mintAnchor.position.set(
    STATIONS.mintStation.x,
    STATIONS.mintStation.y + 1.3,
    STATIONS.mintStation.z,
  );
  root.add(mintAnchor);
  anchors.set(asAnchorId("mintStation"), scene(mintAnchor));

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
      new THREE.Vector3(spot.x, STATIONS.conveyorIn.y, spot.z),
      true,
    );
    const crate = propRoot.children[propRoot.children.length - 1];
    crate.rotation.y = spot.yaw;
  }

  // Order orb: hidden at the cannon breech until the launch beat.
  const breech = anchors.get(asAnchorId("breech"));
  const breechPos = new THREE.Vector3();
  if (breech) (breech as unknown as THREE.Object3D).getWorldPosition(breechPos);
  registerProp("orderOrb", buildOrderOrb(mats), "breech", breechPos, false);

  // Receipt coins: hidden at the mint station until minted.
  const mintPos = new THREE.Vector3(
    STATIONS.mintStation.x,
    STATIONS.mintStation.y + 1.3,
    STATIONS.mintStation.z,
  );
  registerProp("receiptCoin-1", buildReceiptCoin(mats), "mintStation", mintPos, false);
  registerProp(
    "receiptCoin-2",
    buildReceiptCoin(mats),
    "mintStation",
    mintPos.clone().add(new THREE.Vector3(0.4, 0, 0.2)),
    false,
  );

  // ---- Shadows + static caster inventory -------------------------------------
  // Story props (crates, orb, coins) are FLEET-ANIMATED: they never render
  // into the frozen static shadow map (blob shadows cover them at runtime),
  // so nothing under the props root is marked or collected as a caster.
  // Static machines and architecture keep casting.
  const propSubtree = new Set<THREE.Object3D>();
  propRoot.traverse((o) => propSubtree.add(o));

  const casters: SceneObject[] = [];
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    o.castShadow = true;
    o.receiveShadow = true;
    if (o.visible && !propSubtree.has(o)) casters.push(scene(o));
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
// DEVIATION NOTE: types.ts BuiltWorld has no `practicals` field, so the table
// is exported here as plain data instead of living on the BuiltWorld object.
// ---------------------------------------------------------------------------

export interface WorldPractical {
  readonly id: string;
  readonly position: XYZ;
  /** Modest warm point-light intensity, 0.4 - 0.8. */
  readonly intensity: number;
}

export function worldPracticals(): readonly WorldPractical[] {
  const S = STATIONS;
  return [
    {
      id: "coffeeSpout",
      position: { x: S.coffee.x + 0.25, y: S.coffee.y + 1.15, z: S.coffee.z },
      intensity: 0.6,
    },
    {
      id: "briefing",
      position: { x: S.briefing.x, y: S.briefing.y + 1.6, z: S.briefing.z },
      intensity: 0.5,
    },
    {
      id: "stampDesk",
      position: { x: S.stampDesk.x, y: S.stampDesk.y + 1.5, z: S.stampDesk.z },
      intensity: 0.5,
    },
    {
      id: "cannonGauge",
      position: { x: S.cannon.x + 0.5, y: S.cannon.y + 1.8, z: S.cannon.z },
      intensity: 0.4,
    },
    {
      id: "receiptTray",
      position: { x: S.receiptTray.x, y: S.receiptTray.y + 1.2, z: S.receiptTray.z },
      intensity: 0.5,
    },
    {
      id: "antennaBase",
      position: { x: S.antenna.x, y: S.antenna.y + 0.6, z: S.antenna.z },
      intensity: 0.4,
    },
    {
      id: "slotWall",
      position: { x: S.slotWall.x, y: S.slotWall.y + 1.4, z: S.slotWall.z },
      intensity: 0.8,
    },
  ];
}
