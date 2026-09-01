/**
 * Rail network: named polyline routes in world units. Rails are the visible
 * nervous system of the one-room diorama; every packet corresponds to a real
 * system event (command, order, state return, watch alert) and travels a
 * named route between stations. Builders must not invent ambient particle
 * traffic that means nothing.
 *
 * Exactly 13 routes (freeze §4): an 11-route fit-visible trunk that follows
 * the product order path WATCHLIST -> IDEAS -> MISSION -> TRADE -> RISK ->
 * PROTECTION -> SIGNING -> EXECUTION -> exchange -> RECONCILE -> POSITIONS ->
 * HISTORY, plus two hidden-unless-active branches (watchToAlerts, floorToMcp).
 * The only venue crossing is the exchange port threshold at the floor's east
 * seam: orders hop executionGateway -> exchangeOrder -> the docked exchange
 * booth, and the booth's authoritative state flows back down
 * exchangeStateReturn into the reconciliation dock. Every waypoint sits
 * inside the room diamond (config/geometry.ts insideRoom) and derives from
 * the current config/stations.ts anchors.
 */

import type { StationId } from "./stations.js";

export type PacketKind = "order" | "event" | "command" | "recon" | "refusal" | "watch";

/** Packet visual identity: shape family + tint (semantics from palette). */
export const PACKET_STYLE: Record<
  PacketKind,
  { shape: "chevron" | "dot" | "card" | "capsule"; color: number; size: number }
> = {
  order: { shape: "capsule", color: 0xff9f45, size: 14 },
  event: { shape: "dot", color: 0x5a7cff, size: 8 },
  command: { shape: "chevron", color: 0x34e5e5, size: 12 },
  recon: { shape: "dot", color: 0x56f2c2, size: 10 },
  refusal: { shape: "card", color: 0xff6b75, size: 12 },
  watch: { shape: "dot", color: 0xffd35a, size: 9 },
};

export type RouteId =
  | "marketToResearch"
  | "researchToMission"
  | "missionToTicket"
  | "ticketToRisk"
  | "riskToProtection"
  | "protectionToSigner"
  | "signerToExecution"
  | "exchangeOrder"
  | "exchangeStateReturn"
  | "reconciliationToPortfolio"
  | "portfolioToArchive"
  | "watchToAlerts"
  | "floorToMcp";

export interface RouteDef {
  id: RouteId;
  /** Ordered polyline in world units. */
  points: { x: number; y: number }[];
  /** Default packet kind sent along this route. */
  kind: PacketKind;
  /** Endpoints for stories and station-focus masking (station ids). */
  from?: StationId;
  to?: StationId;
  /** Two-way routes allow reverse travel (packets flip direction). */
  twoWay?: boolean;
}

/**
 * Fit-visible trunk (freeze §4): faintly present at idle with direction
 * chevrons while the two local branches stay hidden until dispatched (see
 * systems/rails.ts tri-state). The trunk IS the product order path plus its
 * canonical state return.
 */
export const PRIMARY_ROUTES: ReadonlySet<RouteId> = new Set<RouteId>([
  "marketToResearch",
  "researchToMission",
  "missionToTicket",
  "ticketToRisk",
  "riskToProtection",
  "protectionToSigner",
  "signerToExecution",
  "exchangeOrder",
  "exchangeStateReturn",
  "reconciliationToPortfolio",
  "portfolioToArchive",
]);

/**
 * Return flow: authoritative state coming back from the exchange into
 * reconciliation. Rendered warm-gold with a dashed tail so the return reads
 * as a distinct flow from the solid outgoing order capsules (dash rhythm and
 * direction carry the distinction, not color alone).
 */
export const RETURN_ROUTES: ReadonlySet<RouteId> = new Set<RouteId>(["exchangeStateReturn"]);

const p = (x: number, y: number) => ({ x, y });

export const ROUTES: Record<RouteId, RouteDef> = {
  marketToResearch: {
    id: "marketToResearch",
    // WATCHLIST feeds observations up the research row into IDEAS.
    points: [p(825, 552), p(915, 508)],
    kind: "event",
    from: "marketData",
    to: "researchTools",
  },
  researchToMission: {
    id: "researchToMission",
    // Validated research exits IDEAS' SW face, passes south of WATCHLIST
    // through the open west floor, and lands on MISSION's NE corner.
    points: [p(925, 535), p(875, 650), p(700, 780), p(588, 840)],
    kind: "event",
    from: "researchTools",
    to: "missionBoard",
  },
  missionToTicket: {
    id: "missionToTicket",
    // The mission hands its plan to the order ticket next door.
    points: [p(575, 888), p(640, 932)],
    kind: "command",
    from: "missionBoard",
    to: "decisionTable",
  },
  ticketToRisk: {
    id: "ticketToRisk",
    // The one cross-room leg: climbs the open west floor NE, runs the north
    // apron above the dais and holo, drops through the seam notch between
    // the dais NE corner and the venue's SW corner, threads between the
    // execution gateway and protection, and descends into RISK GUARDS'
    // north face. Monotone diagonal; no corridor detours.
    points: [
      p(720, 903),
      p(880, 745),
      p(1230, 565),
      p(1700, 618),
      p(1768, 720),
      p(1905, 724),
      p(2078, 714),
      p(2158, 762),
    ],
    kind: "order",
    from: "decisionTable",
    to: "riskFortress",
  },
  riskToProtection: {
    id: "riskToProtection",
    // Guards pass the order to the protection step across their shared gap.
    points: [p(2064, 798), p(2046, 781)],
    kind: "order",
    from: "riskFortress",
    to: "protection",
  },
  protectionToSigner: {
    id: "protectionToSigner",
    // Arcs south of the risk fortress (the north lane carries the westbound
    // signed orders), clearing portfolioVault's NW corner and the fortress
    // SW corner, then rises into the signer's south face.
    points: [
      p(2008, 840),
      p(2052, 850),
      p(2064, 900),
      p(2090, 920),
      p(2245, 922),
      p(2352, 870),
      p(2400, 832),
    ],
    kind: "order",
    from: "protection",
    to: "signerVault",
  },
  signerToExecution: {
    id: "signerToExecution",
    // Signed orders run the north lane back west between the fortress and
    // the loss budget, then drop onto the gateway's NE face.
    points: [p(2338, 742), p(2272, 694), p(2105, 688), p(1992, 652)],
    kind: "order",
    from: "signerVault",
    to: "executionGateway",
  },
  exchangeOrder: {
    id: "exchangeOrder",
    // THE venue crossing: gateway west tip past the booth's south flank to
    // the dock threshold the port builder draws. Short and direct so
    // signer -> execution -> exchange reads as one move; acks and fills
    // return along the same leg (twoWay).
    points: [p(1857, 660), p(1820, 612), p(1797, 585), p(1747, 522)],
    kind: "order",
    from: "executionGateway",
    to: "hyperliquidVenue",
    twoWay: true,
  },
  exchangeStateReturn: {
    id: "exchangeStateReturn",
    // Authoritative state leaves the booth's south tip and runs the east
    // seam corridor between the dais east edge and emergency control, then
    // lands in the dock's north face. Dashed gold return styling.
    points: [p(1800, 592), p(1762, 700), p(1716, 810), p(1714, 930), p(1714, 1032), p(1700, 1068)],
    kind: "recon",
    from: "hyperliquidVenue",
    to: "reconciliationDock",
  },
  reconciliationToPortfolio: {
    id: "reconciliationToPortfolio",
    // Aligned canonical state flows from the dock's NE lobe north of the
    // archive into the vault's SW face.
    points: [p(1808, 1058), p(1845, 1005), p(1905, 958), p(1950, 930)],
    kind: "recon",
    from: "reconciliationDock",
    to: "portfolioVault",
  },
  portfolioToArchive: {
    id: "portfolioToArchive",
    // Position updates drop one history row south into the archive.
    points: [p(1948, 965), p(1902, 1032), p(1876, 1060)],
    kind: "event",
    from: "portfolioVault",
    to: "auditArchive",
  },
  watchToAlerts: {
    id: "watchToAlerts",
    // Hidden branch: a watch firing propagates MISSION -> ALERTS across the
    // north of the room. Only ever dispatched via send() from sceneBindings.
    points: [p(556, 815), p(720, 700), p(890, 635), p(1160, 478), p(1400, 428), p(1578, 398)],
    kind: "watch",
    from: "missionBoard",
    to: "signalTower",
  },
  floorToMcp: {
    id: "floorToMcp",
    // Hidden branch: the floor's quiet tool pulls to the TOOLS compound.
    // Also the ONLY ambient route (see systems/rails.ts).
    points: [p(1180, 878), p(1060, 902), p(948, 928)],
    kind: "command",
    from: "tradingFloor",
    to: "mcpHub",
    twoWay: true,
  },
};

export const ROUTE_ORDER: RouteId[] = Object.keys(ROUTES) as RouteId[];
