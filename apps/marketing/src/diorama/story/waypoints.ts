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

export type FloorName = "loft" | "trading" | "vault" | "roof" | "satellite";

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
});

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

const PATH_DEFS: Readonly<Record<string, PathDef>> = {
  // Stacked stair flights (UP lane), each with a mid landing.
  stairsLoftTrading: {
    from: "stairTopLoft",
    to: "stairBottomLoft",
    segments: [
      line(at("stairTopLoft"), P(STAIR_X, (F.researchY + F.tradingY) / 2, STAIR_LANDING_Z)),
      line(P(STAIR_X, (F.researchY + F.tradingY) / 2, STAIR_LANDING_Z), at("stairBottomLoft")),
    ],
  },
  stairsTradingVault: {
    from: "stairTopTrading",
    to: "stairBottomVault",
    segments: [
      line(at("stairTopTrading"), P(STAIR_X, (F.tradingY + F.basementY) / 2, STAIR_LANDING_Z)),
      line(P(STAIR_X, (F.tradingY + F.basementY) / 2, STAIR_LANDING_Z), at("stairBottomVault")),
    ],
  },
  stairsRoofLoft: {
    from: "roofStair",
    to: "stairBottomRoof",
    segments: [
      line(at("roofStair"), P(STAIR_X, (F.roofY + F.researchY) / 2, STAIR_LANDING_Z)),
      line(P(STAIR_X, (F.roofY + F.researchY) / 2, STAIR_LANDING_Z), at("stairBottomRoof")),
    ],
  },

  // Brass pole: vertical fast lane DOWN.
  poleDropLoft: {
    from: "poleTopLoft",
    to: "poleTopTrading",
    segments: [line(at("poleTopLoft"), at("poleTopTrading"))],
  },
  poleDropTrading: {
    from: "poleTopTrading",
    to: "poleBaseVault",
    segments: [line(at("poleTopTrading"), at("poleBaseVault"))],
  },

  // Conveyor flow on the trading floor.
  conveyorFlow: {
    from: "conveyorIn",
    to: "conveyorOut",
    segments: [line(at("conveyorIn"), at("conveyorOut"))],
  },

  // Risk-gate queue: tail -> head -> stamp desk.
  gateQueue: {
    from: "queueTail",
    to: "stampDesk",
    segments: [line(at("queueTail"), at("queueHead")), line(at("queueHead"), at("stampDesk"))],
  },

  // Crate brigade: loft desk/coffee area -> pole top -> drop -> conveyor in.
  crateBrigade: {
    from: "deskRow",
    to: "conveyorIn",
    segments: [
      line(at("deskRow"), at("poleTopLoft")),
      line(at("poleTopLoft"), at("poleTopTrading")),
      line(at("poleTopTrading"), at("conveyorIn")),
    ],
  },

  // Order launch: cannon breech (vault) -> riser -> roof muzzle -> bridge arc
  // -> satellite pad arrival. Bots never travel this path; the orb does.
  launchPath: {
    from: "cannon",
    to: "pipeArrival",
    segments: [
      line(at("cannon"), at("bridgeAnchor")),
      cubic(
        at("bridgeAnchor"),
        P((X1 + S.x) / 2, S.y + DIMENSIONS.bridge.midRise, S.z - 0.5),
        P(S.x - 2.5, S.y + 0.4, S.z),
        at("pipeArrival"),
      ),
    ],
  },

  // Receipt return: mint on the pad -> high return arc -> vault tray.
  receiptReturn: {
    from: "mintStation",
    to: "receiptTray",
    segments: [
      cubic(
        at("mintStation"),
        P(S.x - 4, S.y + 1.8, S.z + 1.5),
        P(4, F.roofY + 1.2, -1.5),
        at("receiptTray"),
      ),
    ],
  },

  // Celebration conga: trading -> pole down -> vault -> stairs up -> trading.
  congaLoop: {
    from: "briefing",
    to: "briefing",
    segments: [
      line(at("briefing"), at("poleTopTrading")),
      line(at("poleTopTrading"), at("poleBaseVault")),
      line(at("poleBaseVault"), at("stampDesk")),
      line(at("stampDesk"), at("stairBottomVault")),
      line(at("stairBottomVault"), P(STAIR_X, (F.tradingY + F.basementY) / 2, STAIR_LANDING_Z)),
      line(P(STAIR_X, (F.tradingY + F.basementY) / 2, STAIR_LANDING_Z), at("stairTopTrading")),
      line(at("stairTopTrading"), at("briefing")),
    ],
  },

  // Hatch approach (shift start / wind down) per floor.
  hatchApproachLoft: {
    from: "deskRow",
    to: "hatchLoft",
    segments: [line(at("deskRow"), at("hatchLoft"))],
  },
  hatchApproachTrading: {
    from: "briefing",
    to: "hatchTrading",
    segments: [line(at("briefing"), at("hatchTrading"))],
  },
  hatchApproachVault: {
    from: "stampDesk",
    to: "hatchVault",
    segments: [line(at("stampDesk"), at("hatchVault"))],
  },

  // Reject chute: vault interior -> plinth-side exit above the bin.
  chuteDrop: {
    from: "chuteTop",
    to: "chuteExit",
    segments: [line(at("chuteTop"), at("chuteExit"))],
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
  | "chuteDrop";

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
