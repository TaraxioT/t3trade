/**
 * The named principal cast from 04-story-script.md plus ambient extras:
 * 27 actors total. Each actor gets a stable branded ActorId, a role (hat
 * tint), a home station from story/waypoints.ts, and a deterministic
 * cosmetic seed derived from SEEDS.bots ^ hash(actorId) (see
 * math.seededId) so adding or renaming a bot can never shift another bot's
 * phase stream.
 *
 * The fleet also owns the idempotent prop attachment table required by the
 * BuiltFleet contract: exactly zero or one owner per prop, throws on double
 * ownership or detach-without-owner. Actual Object3D reparenting happens
 * only when world bindings (prop and anchor objects) are supplied; without
 * them the table still validates the story's attachment discipline.
 */

import * as THREE from "three";
import { DIMENSIONS, PALETTE_V2, SEEDS, type ZoneId } from "../config";
import { seededId } from "../math";
import type { MaterialLibrary } from "../render/materials";
import {
  asActorId,
  type ActorId,
  type AnchorId,
  type BuiltFleet,
  type PropId,
  type Role,
  type SceneObject,
  type SocketId,
  type WaypointId,
} from "../types";
import { buildBotRig, createBotGeometryCache, type AccessoryId, type BotRig } from "./rig";
import { STATIONS, stationWaypointId, type StationId } from "../story/waypoints";

export interface FleetActor {
  readonly actorId: ActorId;
  readonly role: Role;
  /** Home zone id (R2 layout); drives the hull body color. */
  readonly zone: ZoneId;
  /** Deterministic cosmetic seed: seededId(SEEDS.bots, actorId). */
  readonly seed: number;
  readonly homeWaypointId: WaypointId;
  readonly rig: BotRig;
}

interface RosterEntry {
  readonly id: string;
  readonly role: Role;
  readonly home: StationId;
  readonly zone: ZoneId;
  readonly scale?: number;
  readonly accessory?: AccessoryId;
}

/**
 * Principal cast (19) + ambient extras (6) from 04-story-script.md.
 * IDs are story-stable: beats.ts authors commands against these strings.
 * Zones are the R2 home zones (09-layout-spec.md); ambient extras spread
 * one per zone. Homes stay on the aliased v1 stations until the cutover.
 */
const ROSTER: readonly RosterEntry[] = [
  { id: "foreman", role: "foreman", home: "planDesk", zone: "plan", accessory: "clipboard" },
  {
    id: "researcher-1",
    role: "researcher",
    home: "greenhouse",
    zone: "greenhouse",
    accessory: "tablet",
  },
  {
    id: "researcher-2",
    role: "researcher",
    home: "greenhouse",
    zone: "greenhouse",
    accessory: "tablet",
  },
  {
    id: "researcher-3",
    role: "researcher",
    home: "greenhouse",
    zone: "greenhouse",
    accessory: "tablet",
  },
  {
    id: "researcher-4",
    role: "researcher",
    home: "whiteboard",
    zone: "greenhouse",
    accessory: "tablet",
  },
  {
    id: "researcher-5",
    role: "researcher",
    home: "whiteboard",
    zone: "greenhouse",
    accessory: "tablet",
  },
  {
    id: "researcher-6",
    role: "researcher",
    home: "greenhouseTelescope",
    zone: "greenhouse",
    accessory: "tablet",
  },
  { id: "analyst", role: "analyst", home: "greenhouse", zone: "greenhouse", accessory: "tablet" },
  { id: "runner-a", role: "runner", home: "gauntletIn", zone: "gauntlet" },
  { id: "runner-b", role: "runner", home: "gauntletOut", zone: "gauntlet" },
  { id: "runner-c", role: "runner", home: "watchTower", zone: "watch" },
  { id: "runner-d", role: "runner", home: "queueFront", zone: "gauntlet" },
  { id: "guard-1", role: "guard", home: "gauntletOut", zone: "risk", accessory: "tagClip" },
  { id: "guard-2", role: "guard", home: "queueBack", zone: "risk", accessory: "tagClip" },
  { id: "gunner", role: "gunner", home: "launchBay", zone: "launch", accessory: "wrench" },
  {
    id: "accountant-1",
    role: "accountant",
    home: "backOfficeDeskA",
    zone: "backOffice",
    accessory: "ledgerPlate",
  },
  {
    id: "accountant-2",
    role: "accountant",
    home: "ferryDock",
    zone: "backOffice",
    accessory: "ledgerPlate",
  },
  {
    id: "intern",
    role: "intern",
    home: "backOfficeDeskB",
    zone: "backOffice",
    scale: DIMENSIONS.bot.internScale,
    accessory: "pencil",
  },
  { id: "janitor", role: "janitor", home: "rejectBin", zone: "gauntlet" },
  { id: "coffee", role: "coffee", home: "oilBar", zone: "oilBar" },
  // Ambient extras: spread one per zone across the bazaar.
  { id: "ambient-1", role: "ambient", home: "controlPanel", zone: "watch" },
  { id: "ambient-2", role: "ambient", home: "stampStation", zone: "gauntlet" },
  { id: "ambient-3", role: "ambient", home: "greenhouse", zone: "greenhouse" },
  { id: "ambient-4", role: "ambient", home: "backOfficeDeskA", zone: "backOffice" },
  { id: "ambient-5", role: "ambient", home: "launchBay", zone: "launch" },
  { id: "ambient-6", role: "ambient", home: "docksA", zone: "docks" },
];

/** Optional THREE-level bindings used to actually reparent prop objects. */
export interface WorldBindings {
  readonly propObjects: ReadonlyMap<PropId, THREE.Object3D>;
  readonly anchorObjects: ReadonlyMap<AnchorId, THREE.Object3D>;
}

export interface BuiltFleetWithActors extends BuiltFleet {
  readonly actorMap: ReadonlyMap<ActorId, FleetActor>;
  readonly actorList: readonly FleetActor[];
}

interface Attachment {
  ownerActorId: ActorId;
  socket: SocketId;
}

const asSceneObject = (obj: THREE.Object3D): SceneObject => obj as unknown as SceneObject;

export function createFleet(mats: MaterialLibrary, world?: WorldBindings): BuiltFleetWithActors {
  const root = new THREE.Group();
  root.name = "fleet";

  const cache = createBotGeometryCache();
  const actorMap = new Map<ActorId, FleetActor>();
  const actorList: FleetActor[] = [];

  for (const entry of ROSTER) {
    const actorId = asActorId(entry.id);
    if (actorMap.has(actorId)) throw new Error(`fleet: duplicate actor id "${entry.id}"`);
    const home = STATIONS[entry.home];
    if (!home) throw new Error(`fleet: unknown home station "${entry.home}"`);
    const rig = buildBotRig(mats, entry.role, entry.scale ?? 1, cache, {
      // Zone-blended hull color from PALETTE_V2 (precomputed mixes).
      bodyColor: PALETTE_V2.botBody[entry.zone],
      accessory: entry.accessory,
    });
    // Park each bot at its home station until the director takes over.
    rig.root.position.set(home.x, home.y, home.z);
    if (home.facing !== undefined) rig.root.rotation.y = home.facing;
    root.add(rig.root);
    const actor: FleetActor = {
      actorId,
      role: entry.role,
      zone: entry.zone,
      seed: seededId(SEEDS.bots, entry.id),
      homeWaypointId: stationWaypointId(entry.home),
      rig,
    };
    actorMap.set(actorId, actor);
    actorList.push(actor);
  }

  // propId -> current attachment; absent means parked/unowned.
  const attachments = new Map<PropId, Attachment>();
  // Original parent of each prop before its first attach, for resets.
  const homeParents = new Map<PropId, THREE.Object3D>();

  const propObject = (propId: PropId): THREE.Object3D | undefined => world?.propObjects.get(propId);

  const parkAtHome = (propId: PropId): void => {
    const obj = propObject(propId);
    if (!obj) return;
    const home = homeParents.get(propId);
    if (home) {
      home.add(obj);
      obj.position.set(0, 0, 0);
      obj.rotation.set(0, 0, 0);
    } else {
      root.add(obj);
    }
  };

  const fleet: BuiltFleetWithActors = {
    root: asSceneObject(root),
    actorMap,
    actorList,
    actors: new Map(
      [...actorMap.entries()].map(([id, actor]) => [
        id,
        {
          actorId: id,
          role: actor.role,
          object: asSceneObject(actor.rig.root),
          seed: actor.seed,
          sockets: {
            leftHand: asSceneObject(actor.rig.sockets.leftHand),
            rightHand: asSceneObject(actor.rig.sockets.rightHand),
            carry: asSceneObject(actor.rig.sockets.carry),
          },
        },
      ]),
    ),
    attach(propId, ownerActorId, socket) {
      const existing = attachments.get(propId);
      // Same-owner re-attach is a legal no-op (director cache vs table drift
      // across seeks); only a different owner is a genuine double ownership.
      if (existing && existing.ownerActorId === ownerActorId && existing.socket === socket) return;
      if (existing) {
        throw new Error(
          `fleet: prop "${propId}" already owned by "${existing.ownerActorId}" (double ownership)`,
        );
      }
      const owner = actorMap.get(ownerActorId);
      if (!owner) throw new Error(`fleet: attach to unknown actor "${ownerActorId}"`);
      attachments.set(propId, { ownerActorId, socket });
      const obj = propObject(propId);
      if (obj) {
        if (!homeParents.has(propId)) homeParents.set(propId, obj.parent ?? root);
        const socketObject =
          socket === "carry"
            ? owner.rig.sockets.carry
            : socket === "leftHand"
              ? owner.rig.sockets.leftHand
              : owner.rig.sockets.rightHand;
        socketObject.add(obj);
        // Fixed socket-local offset; prop geometry defines its own extent.
        obj.position.set(0, 0, 0);
        obj.rotation.set(0, 0, 0);
      }
    },
    detach(propId, anchorId) {
      const existing = attachments.get(propId);
      if (!existing) {
        throw new Error(`fleet: detach of unowned prop "${propId}"`);
      }
      attachments.delete(propId);
      const obj = propObject(propId);
      if (!obj) return;
      const anchor = world?.anchorObjects.get(anchorId);
      if (anchor) {
        anchor.add(obj);
        obj.position.set(0, 0, 0);
        obj.rotation.set(0, 0, 0);
      } else {
        parkAtHome(propId);
      }
    },
    clearAttachments() {
      for (const propId of [...attachments.keys()]) {
        attachments.delete(propId);
        parkAtHome(propId);
      }
    },
    assertConsistent() {
      // The map structure already guarantees at most one owner per prop;
      // verify every live attachment still resolves to actor + socket.
      for (const [propId, att] of attachments) {
        const owner = actorMap.get(att.ownerActorId);
        if (!owner) {
          throw new Error(`fleet: prop "${propId}" owned by unknown actor "${att.ownerActorId}"`);
        }
        const obj = propObject(propId);
        if (!obj) continue;
        const expectedSocket =
          att.socket === "carry"
            ? owner.rig.sockets.carry
            : att.socket === "leftHand"
              ? owner.rig.sockets.leftHand
              : owner.rig.sockets.rightHand;
        if (!expectedSocket.getObjectById(obj.id)) {
          throw new Error(
            `fleet: prop "${propId}" owned by "${att.ownerActorId}" is not parented under its ${att.socket} socket`,
          );
        }
      }
    },
  };

  return fleet;
}
