/**
 * Waypoint graph: canonical station positions and authored curve paths.
 *
 * Pure data plus tiny helpers. No THREE, no DOM, so story tests can validate
 * the graph in bare node. Station positions derive from config.DIMENSIONS
 * (floor heights, building footprint, satellite pad); everything else is an
 * authored constant inside the footprint.
 *
 * Coordinate frame (config.ts): plinth top y = 0, vault floor y = -2.2,
 * trading y = 0, research loft y = 4.6, roof y = 9.2. Building footprint
 * x in [-11, 7], z in [-5.5, 7.5]. The circulation core (pole + stacked
 * stair flights) sits near the +x/+z corner; the brass pole is the fast
 * DOWN lane, the spiral stairs are the UP lane.
 */

import { DIMENSIONS } from "../config";
import type { CurvePath, CurveSegment } from "../math";
import {
  asPathId,
  asWaypointId,
  type PathId as BrandedPathId,
  type WaypointId,
  type XYZ,
} from "../types";

// ---------------------------------------------------------------------------
// Floors
// ---------------------------------------------------------------------------

export type FloorName = "loft" | "trading" | "vault" | "roof" | "satellite" | "deck" | "terrace";

export interface Station {
  readonly floor: FloorName;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Optional canonical facing yaw in radians (0 = +z). */
  readonly facing?: number;
}

// Derived footprint anchors so a dimension tweak re-flows the graph.
const B = DIMENSIONS.building;
const X0 = B.centerX - B.footprintWidth / 2; // -11
const X1 = B.centerX + B.footprintWidth / 2; // 7
const Z0 = B.centerZ - B.footprintDepth / 2; // -5.5
const Z1 = B.centerZ + B.footprintDepth / 2; // 7.5
const CUT = DIMENSIONS.floors.cutHalfWidth; // floor-cut half extent

/** Circulation core: brass pole x/z (the vertical fast lane at the floor-cut). */
const POLE_X = X1 - CUT - 0.4; // 3.0
const POLE_Z = Z1 - CUT - 0.4; // 5.5
/** Stair flight column: stacked straight flights share the +x/+z corner. */
const STAIR_X = X1 - 1.5; // 5.5
const STAIR_Z_TOP = Z1 - 1.0; // 6.5
const STAIR_Z_BOTTOM = Z1 - 4.0; // 3.5
const STAIR_LANDING_Z = Z1 - 2.5; // 5.0 mid-flight landing

const F = DIMENSIONS.floors;
const S = DIMENSIONS.satellite;

const st = (floor: FloorName, x: number, y: number, z: number, facing?: number): Station =>
  facing === undefined ? { floor, x, y, z } : { floor, x, y, z, facing };

// ---------------------------------------------------------------------------
// STATIONS — every named station used by 04-story-script.md cast + machines.
// ---------------------------------------------------------------------------

export const STATIONS = Object.freeze({
  // Research loft (y = researchY).
  coffee: st("loft", X0 + 2.5, F.researchY, -2.5),
  chartWall: st("loft", -3, F.researchY, Z0 + 1.0, 0),
  telescope: st("loft", 1.5, F.researchY, Z0 + 2.0, 0),
  deskRow: st("loft", X0 + 4.5, F.researchY, 1.5, 0),
  stairTopLoft: st("loft", STAIR_X, F.researchY, STAIR_Z_TOP),
  stairBottomRoof: st("loft", STAIR_X, F.researchY, STAIR_Z_BOTTOM),
  poleTopLoft: st("loft", POLE_X, F.researchY, POLE_Z),
  hatchLoft: st("loft", X0 + 1.5, F.researchY, Z1 - 1.0),

  // Trading floor (y = tradingY).
  briefing: st("trading", -1, F.tradingY, 0.5),
  deskRowTrading: st("trading", X0 + 4.5, F.tradingY, 1.5, 0),
  conveyorIn: st("trading", -2.5, F.tradingY, Z1 - 2.7),
  conveyorOut: st("trading", 4.5, F.tradingY, Z1 - 2.7),
  timeClock: st("trading", X1 - 0.7, F.tradingY, Z0 - 0.2, Math.PI),
  tickerBoard: st("trading", -1, F.tradingY, Z0 + 0.9, 0),
  stairBottomLoft: st("trading", STAIR_X, F.tradingY, STAIR_Z_BOTTOM),
  stairTopTrading: st("trading", STAIR_X, F.tradingY, STAIR_Z_TOP),
  poleTopTrading: st("trading", POLE_X, F.tradingY, POLE_Z),
  hatchTrading: st("trading", X0 + 1.5, F.tradingY, Z1 - 1.0),

  // Risk vault (y = basementY).
  queueTail: st("vault", 4.5, F.basementY, 2.2, Math.PI),
  queueHead: st("vault", 2.5, F.basementY, 1.2, Math.PI),
  stampDesk: st("vault", 0.5, F.basementY, 0, 0),
  vaultDoor: st("vault", -5.5, F.basementY, 0, Math.PI / 2),
  cannon: st("vault", -6, F.basementY, Z0 + 2.5, 0),
  receiptTray: st("vault", 1.5, F.basementY, Z0 + 2.3, 0),
  chuteTop: st("vault", X0 + 0.7, F.basementY, 1.5),
  chuteExit: st("vault", -12.8, F.basementY + 0.8, 1.5),
  stairBottomVault: st("vault", STAIR_X, F.basementY, STAIR_Z_BOTTOM),
  poleBaseVault: st("vault", POLE_X, F.basementY, POLE_Z),
  hatchVault: st("vault", X0 + 1.5, F.basementY, Z1 - 1.0),

  // Roof (y = roofY).
  roofStair: st("roof", STAIR_X, F.roofY, STAIR_Z_TOP),
  antenna: st("roof", -4, F.roofY, -2),
  coffeeCorner: st("roof", -1.5, F.roofY, 2.0),
  bridgeAnchor: st("roof", X1 - 0.6, F.roofY, Z0 - 0.3),

  // Exchange satellite pad (from DIMENSIONS.satellite).
  pipeArrival: st("satellite", S.x, S.y, S.z),
  slotWall: st("satellite", S.x + 1.6, S.y, S.z - 1.4, -Math.PI / 4),
  mintStation: st("satellite", S.x - 1.6, S.y, S.z + 1.6, Math.PI / 4),

  // -------------------------------------------------------------------------
  // R2 layout (09-layout-spec.md) — ADDITIVE ONLY. The v1 story keeps using
  // the stations above until the atomic world cutover swaps producers and
  // redefines paths. Deck stations sit at y = 0, terrace at y = 3.2; the
  // satellite V2 coordinates sit alongside the originals until the cutover
  // moves the pad. No bot homes are assigned to these yet (R5).
  // -------------------------------------------------------------------------
  // Harness docks: five pads along x -20.4..-15.6 at z -6.2, facing +z.
  docksA: st("deck", -20.4, 0, -6.2, 0),
  docksB: st("deck", -19.2, 0, -6.2, 0),
  docksC: st("deck", -18, 0, -6.2, 0),
  docksD: st("deck", -16.8, 0, -6.2, 0),
  docksE: st("deck", -15.6, 0, -6.2, 0),
  // Research greenhouse bay.
  greenhouse: st("deck", -11.5, 0, -4, 0),
  greenhouseTelescope: st("deck", -9, 0, -5, 0),
  whiteboard: st("deck", -13.5, 0, -5, 0),
  // Activation desk and its slot chute feeding the street conveyor.
  planDesk: st("deck", -5.5, 0, -2, 0),
  activationSlot: st("deck", -5.5, 0, 1.6, 0),
  // The gauntlet conveyor run on the street.
  gauntletIn: st("deck", -4, 0, 7, 0),
  gauntletOut: st("deck", 5, 0, 7, 0),
  gauntletReject: st("deck", 4.5, 0, 9.5, 0),
  // Cloid mint press, launch bay, back office, oil bar pocket.
  mintPress: st("deck", 7.5, 0, -2, 0),
  launchBay: st("deck", 12.5, 0, 1, 0),
  ferryDock: st("deck", 17.5, 0, 4, 0),
  truthMonolith: st("deck", 17.5, 0, 8.5, 0),
  backOfficeDeskA: st("deck", 16.5, 0, -2, 0),
  backOfficeDeskB: st("deck", 19.5, 0, -2, 0),
  oilBar: st("deck", 18.5, 0, 10, 0),
  // Street run anchors and street-front stations.
  streetRunWest: st("deck", -12, 0, 9, 0),
  streetRunEast: st("deck", 12, 0, 9, 0),
  stampStation: st("deck", 1, 0, 7, 0),
  queueFront: st("deck", -3, 0, 8.5, 0),
  queueBack: st("deck", -3, 0, 10.5, 0),
  rejectBin: st("deck", 5.5, 0, 10.5, 0),
  // Terrace (y = 3.2, z in [-15, -9]).
  watchTower: st("terrace", 0, 3.2, -12, 0),
  controlPanel: st("terrace", -5, 3.2, -10, 0),
  overseerPerch: st("terrace", 14, 3.2, -11, 0),
  vaultCube: st("terrace", 7, 3.2, -12, 0),
  // Brass pole: single pole at the gauntlet front, deck base to terrace top.
  poleBase: st("deck", 1, 0, 5, 0),
  poleTop: st("terrace", 1, 3.2, 5, 0),
  // Launch bay pipe mouth (elevated between terrace height and the arc).
  pipeMouth: st("terrace", 13.5, 4, 2, 0),
  // Exchange satellite V2 coordinates (used after the cutover).
  pipeArrivalV2: st("satellite", 19, 6.5, -6),
  slotWallV2: st("satellite", 20.2, 6.5, -7),
  mintStationV2: st("satellite", 17.8, 6.5, -5),
});

// ---------------------------------------------------------------------------
// STATION_ALIASES — v1 station id -> R2 replacement (09-layout-spec.md,
// final section mapping). Consumed by the cutover; until then the v1 story
// keeps its own ids and behavior unchanged. pipeArrival/slotWall/mintStation
// stay as-is and are deliberately absent from the table.
// ---------------------------------------------------------------------------

export const STATION_ALIASES: Readonly<Partial<Record<StationId, StationId>>> = Object.freeze({
  coffee: "oilBar",
  chartWall: "greenhouse",
  telescope: "greenhouseTelescope",
  briefing: "planDesk",
  deskRow: "greenhouse",
  deskRowTrading: "backOfficeDeskA",
  conveyorIn: "gauntletIn",
  conveyorOut: "gauntletOut",
  stampDesk: "stampStation",
  queueHead: "queueFront",
  queueTail: "queueBack",
  vaultDoor: "vaultCube",
  cannon: "launchBay",
  receiptTray: "ferryDock",
  chuteTop: "gauntletReject",
  chuteExit: "rejectBin",
  timeClock: "planDesk",
  tickerBoard: "greenhouse",
  stairTopLoft: "poleTop",
  stairTopTrading: "poleTop",
  stairBottomLoft: "poleBase",
  stairBottomVault: "poleBase",
  stairBottomRoof: "poleBase",
  hatchLoft: "docksA",
  hatchTrading: "docksA",
  hatchVault: "docksA",
  roofStair: "watchTower",
  antenna: "watchTower",
  coffeeCorner: "oilBar",
  bridgeAnchor: "pipeMouth",
  poleTopLoft: "poleTop",
  poleTopTrading: "poleTop",
  poleBaseVault: "poleBase",
} as const);

export type StationId = keyof typeof STATIONS;

export const STATION_IDS: readonly StationId[] = Object.freeze(
  Object.keys(STATIONS) as StationId[],
);

export const stationWaypointId = (id: StationId): WaypointId => asWaypointId(id);

// ---------------------------------------------------------------------------
// Path authoring helpers
// ---------------------------------------------------------------------------

const P = (x: number, y: number, z: number): XYZ => ({ x, y, z });
const at = (id: StationId): XYZ => {
  const s = STATIONS[id];
  return P(s.x, s.y, s.z);
};
const line = (from: XYZ, to: XYZ): CurveSegment => ({ kind: "line", from, to });
const cubic = (from: XYZ, controlA: XYZ, controlB: XYZ, to: XYZ): CurveSegment => ({
  kind: "cubic",
  from,
  controlA,
  controlB,
  to,
});

interface PathDef {
  readonly from: StationId;
  readonly to: StationId;
  readonly segments: readonly CurveSegment[];
}

/**
 * R2 path topology (09-layout-spec.md). Every PathId the v1 story references
 * still exists, but its geometry now connects the aliased R2 stations: deck
 * walking (y 0), one brass pole (poleTop -> poleBase vertical), terrace at
 * y 3.2, satellite V2 at y 6.5. No stairs, no ramps. Distances are shorter
 * than the old three-floor world, so beat durations authored against these
 * paths read faster; the compiler validates endpoints at module init.
 */
const PATH_DEFS: Readonly<Record<string, PathDef>> = {
  // Former stair flights -> pole drops / terrace-to-pole deck routes.
  stairsLoftTrading: {
    from: "poleTop",
    to: "poleBase",
    segments: [line(at("poleTop"), at("poleBase"))],
  },
  stairsTradingVault: {
    from: "poleTop",
    to: "poleBase",
    segments: [line(at("poleTop"), at("poleBase"))],
  },
  stairsRoofLoft: {
    from: "watchTower",
    to: "poleBase",
    segments: [line(at("watchTower"), at("poleTop")), line(at("poleTop"), at("poleBase"))],
  },

  // Brass pole: vertical fast lane DOWN (terrace -> deck).
  poleDropLoft: {
    from: "poleTop",
    to: "poleBase",
    segments: [line(at("poleTop"), at("poleBase"))],
  },
  poleDropTrading: {
    from: "poleTop",
    to: "poleBase",
    segments: [line(at("poleTop"), at("poleBase"))],
  },

  // Conveyor flow: the gauntlet run along the street at z = 7.
  conveyorFlow: {
    from: "gauntletIn",
    to: "gauntletOut",
    segments: [line(at("gauntletIn"), at("gauntletOut"))],
  },

  // Gate queue: back -> front -> primary stamper.
  gateQueue: {
    from: "queueBack",
    to: "stampStation",
    segments: [line(at("queueBack"), at("queueFront")), line(at("queueFront"), at("stampStation"))],
  },

  // Crate brigade: greenhouse side -> street west anchor -> gauntlet entry.
  crateBrigade: {
    from: "greenhouse",
    to: "gauntletIn",
    segments: [
      line(at("greenhouse"), at("streetRunWest")),
      line(at("streetRunWest"), at("gauntletIn")),
    ],
  },

  // Order launch: launch bay -> pipe mouth -> shallow arc -> exchange V2.
  // Bots never travel this path; the orb does.
  launchPath: {
    from: "launchBay",
    to: "pipeArrivalV2",
    segments: [
      line(at("launchBay"), at("pipeMouth")),
      cubic(at("pipeMouth"), P(15.5, 5.8, 0), P(18, 6.8, -3.5), at("pipeArrivalV2")),
    ],
  },

  // Receipt return: mint on the pad -> falling arc -> reconciler ferry dock.
  receiptReturn: {
    from: "mintStationV2",
    to: "ferryDock",
    segments: [cubic(at("mintStationV2"), P(17.5, 7.5, -0.5), P(17.5, 2.5, 3.5), at("ferryDock"))],
  },

  // Celebration conga: a fun loop around the deck perimeter — street z = 9
  // west -> east, then the back line z ~ -6 east -> west, respecting zones.
  congaLoop: {
    from: "planDesk",
    to: "planDesk",
    segments: [
      line(at("planDesk"), at("streetRunWest")),
      line(at("streetRunWest"), at("streetRunEast")),
      line(at("streetRunEast"), at("mintPress")),
      line(at("mintPress"), at("docksE")),
      line(at("docksE"), at("whiteboard")),
      line(at("whiteboard"), at("planDesk")),
    ],
  },

  // Hatch approach (shift start / wind down): short deck lines to docksA.
  hatchApproachLoft: {
    from: "greenhouse",
    to: "docksA",
    segments: [line(at("greenhouse"), at("docksA"))],
  },
  hatchApproachTrading: {
    from: "planDesk",
    to: "docksA",
    segments: [line(at("planDesk"), at("docksA"))],
  },
  hatchApproachVault: {
    from: "stampStation",
    to: "docksA",
    segments: [line(at("stampStation"), at("docksA"))],
  },

  // Reject diverter: gauntlet reject mouth -> bin, short slide.
  chuteDrop: {
    from: "gauntletReject",
    to: "rejectBin",
    segments: [line(at("gauntletReject"), at("rejectBin"))],
  },

  // --- New R2 authoring paths (not yet referenced by the v1 story). ---

  // Beam traversal placeholder: beams are authored, not walked, but a
  // trivial two-point path keeps authoring uniform.
  beamTest: {
    from: "whiteboard",
    to: "planDesk",
    segments: [line(at("whiteboard"), at("planDesk"))],
  },

  // Street run along z = 9.
  streetRun: {
    from: "streetRunWest",
    to: "streetRunEast",
    segments: [line(at("streetRunWest"), at("streetRunEast"))],
  },

  // Terrace tour at y = 3.2.
  terraceTour: {
    from: "controlPanel",
    to: "controlPanel",
    segments: [
      line(at("controlPanel"), at("watchTower")),
      line(at("watchTower"), at("overseerPerch")),
      line(at("overseerPerch"), at("vaultCube")),
      line(at("vaultCube"), at("controlPanel")),
    ],
  },
};

export type PathId =
  | "stairsLoftTrading"
  | "stairsTradingVault"
  | "stairsRoofLoft"
  | "poleDropLoft"
  | "poleDropTrading"
  | "conveyorFlow"
  | "gateQueue"
  | "crateBrigade"
  | "launchPath"
  | "receiptReturn"
  | "congaLoop"
  | "hatchApproachLoft"
  | "hatchApproachTrading"
  | "hatchApproachVault"
  | "chuteDrop"
  | "beamTest"
  | "streetRun"
  | "terraceTour";

export const PATH_IDS: readonly PathId[] = Object.freeze(Object.keys(PATH_DEFS) as PathId[]);

// ---------------------------------------------------------------------------
// Endpoint validation (runs once at module init; throws on authoring error)
// ---------------------------------------------------------------------------

const EPS = 1e-9;
const samePoint = (a: XYZ, b: XYZ): boolean =>
  Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS && Math.abs(a.z - b.z) < EPS;

function validatePaths(): void {
  for (const id of Object.keys(PATH_DEFS)) {
    const def = PATH_DEFS[id] as PathDef;
    if (def.segments.length === 0) throw new Error(`waypoints: path "${id}" has no segments`);
    const first = def.segments[0] as CurveSegment;
    const last = def.segments[def.segments.length - 1] as CurveSegment;
    if (!samePoint(first.from, at(def.from))) {
      throw new Error(`waypoints: path "${id}" does not start at station "${def.from}"`);
    }
    if (!samePoint(last.to, at(def.to))) {
      throw new Error(`waypoints: path "${id}" does not end at station "${def.to}"`);
    }
    for (let i = 1; i < def.segments.length; i += 1) {
      const prev = def.segments[i - 1] as CurveSegment;
      const cur = def.segments[i] as CurveSegment;
      if (!samePoint(prev.to, cur.from)) {
        throw new Error(`waypoints: path "${id}" is discontinuous at segment ${i}`);
      }
    }
  }
}

validatePaths();

export const PATHS: Readonly<Record<PathId, CurvePath>> = Object.freeze(
  Object.fromEntries(
    (Object.keys(PATH_DEFS) as string[]).map((id) => [
      id,
      Object.freeze((PATH_DEFS[id] as PathDef).segments.slice()) as CurvePath,
    ]),
  ),
) as Readonly<Record<PathId, CurvePath>>;

/** Brand an authored path id for story command authoring. */
export const pathId = (id: PathId): BrandedPathId => asPathId(id);

// ---------------------------------------------------------------------------
// Graph assembly
// ---------------------------------------------------------------------------

export interface WaypointGraph {
  readonly stations: typeof STATIONS;
  readonly paths: Readonly<Record<PathId, CurvePath>>;
  readonly stationPosition: (id: StationId) => XYZ;
}

export function createWaypointGraph(): WaypointGraph {
  return {
    stations: STATIONS,
    paths: PATHS,
    stationPosition: (id) => {
      const s = STATIONS[id];
      return { x: s.x, y: s.y, z: s.z };
    },
  };
}
