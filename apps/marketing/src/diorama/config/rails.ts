/**
 * Rail network: named polyline routes in world units. Rails are the visible
 * nervous system of the campus; every packet corresponds to a real system
 * event (command, proposal, approval, order, receipt, reconciliation) and
 * travels a named route between stations. Builders must not invent ambient
 * particle traffic that means nothing.
 *
 * The safety perimeter has exactly three controlled crossings:
 * - west gate at Approval (authorized proposals enter)
 * - east tunnel to Hyperliquid Testnet (orders out, acks and fills back)
 * - south exit port (receipts and state updates leave the exposure zone)
 */

import type { StationId } from "./stations.js";

export type PacketKind =
  | "command"
  | "event"
  | "proposal"
  | "toolResult"
  | "approval"
  | "order"
  | "receipt"
  | "recon"
  | "refusal";

/** Packet visual identity: shape family + tint (semantics from palette). */
export const PACKET_STYLE: Record<
  PacketKind,
  { shape: "chevron" | "dot" | "card" | "capsule" | "slip"; color: number; size: number }
> = {
  command: { shape: "chevron", color: 0x34e5e5, size: 12 },
  event: { shape: "dot", color: 0x5a7cff, size: 8 },
  proposal: { shape: "card", color: 0x9a70ff, size: 13 },
  toolResult: { shape: "dot", color: 0x56f2c2, size: 9 },
  approval: { shape: "card", color: 0x63f58b, size: 13 },
  order: { shape: "capsule", color: 0xff9f45, size: 14 },
  receipt: { shape: "slip", color: 0xddefe3, size: 11 },
  recon: { shape: "dot", color: 0x56f2c2, size: 10 },
  refusal: { shape: "card", color: 0xff6b75, size: 12 },
};

export type RouteId =
  | "landscapeToMarketData"
  | "marketDataToStrategy"
  | "strategyToMissionBoard"
  | "decisionToApproval"
  | "deniedReturn"
  | "approvalToPermission"
  | "permissionToBudget"
  | "permissionToRisk"
  | "riskToProtection"
  | "protectionToSigner"
  | "signerToExecution"
  | "exchangeTunnel"
  | "exchangeStateReturn"
  | "executionToReceipts"
  | "receiptsToArchive"
  | "localStateStream"
  | "floorToMcp"
  | "hubToAdapterBay"
  | "missionToSignalTower"
  | "recoveryDispatch";

export interface RouteDef {
  id: RouteId;
  /** Ordered polyline in world units. */
  points: { x: number; y: number }[];
  /** Default packet kind stories send along this route. */
  kind: PacketKind;
  /** Endpoints for stories (station ids where meaningful). */
  from?: StationId;
  to?: StationId;
  /** External (non-station) endpoint for focus reveal: the Hyperliquid
   * platform is a synthetic pickable, not a StationId. */
  externalTo?: "hyperliquid";
  externalFrom?: "hyperliquid";
  /** Two-way routes allow reverse travel (packets flip direction). */
  twoWay?: boolean;
}

/**
 * PRIMARY lifecycle corridor: research -> strategy -> mission -> decision ->
 * approval -> permission <-> loss budget -> risk -> protection -> signer ->
 * execution -> exchange, plus the exchange -> reconciliation -> receipts ->
 * archive return leg. Primary rails are the structural trunks: faintly
 * present at idle with direction chevrons, while local branches stay hidden
 * until a story dispatches them (see systems/rails.ts tri-state).
 */
export const PRIMARY_ROUTES: ReadonlySet<RouteId> = new Set<RouteId>([
  "marketDataToStrategy",
  "strategyToMissionBoard",
  "decisionToApproval",
  "approvalToPermission",
  "permissionToBudget",
  "permissionToRisk",
  "riskToProtection",
  "protectionToSigner",
  "signerToExecution",
  "exchangeTunnel",
  "exchangeStateReturn",
  "executionToReceipts",
  "receiptsToArchive",
]);

/**
 * Return flow: state, receipts, and archive legs coming back from the
 * exchange/execution side. Rendered warm-gold with a dashed tail so returns
 * read as a distinct flow from outgoing orange order capsules (dash rhythm
 * and direction carry the distinction, not color alone).
 */
export const RETURN_ROUTES: ReadonlySet<RouteId> = new Set<RouteId>([
  "exchangeStateReturn",
  "executionToReceipts",
  "receiptsToArchive",
]);

const p = (x: number, y: number) => ({ x, y });

export const ROUTES: Record<RouteId, RouteDef> = {
  landscapeToMarketData: {
    id: "landscapeToMarketData",
    points: [p(545, 235), p(575, 275), p(592, 300)],
    kind: "event",
    to: "marketData",
  },
  marketDataToStrategy: {
    id: "marketDataToStrategy",
    points: [p(640, 345), p(760, 400), p(930, 418)],
    kind: "toolResult",
    from: "marketData",
    to: "strategyLab",
    twoWay: true,
  },
  strategyToMissionBoard: {
    id: "strategyToMissionBoard",
    points: [p(905, 452), p(640, 480), p(410, 388)],
    kind: "event",
    from: "strategyLab",
    to: "missionBoard",
    twoWay: true,
  },
  decisionToApproval: {
    id: "decisionToApproval",
    // Corridor south of the market holo (bottom edge y 740): the segment
    // stays >= ~40u below it so packets never cross the hologram.
    points: [p(1085, 645), p(1250, 708), p(1420, 782), p(1600, 865), p(1695, 910)],
    kind: "proposal",
    from: "decisionTable",
    to: "approval",
  },
  deniedReturn: {
    id: "deniedReturn",
    // Refusal return runs parallel to decisionToApproval, offset ~40-50u to
    // the south so the outgoing and refused reads never merge.
    points: [p(1690, 938), p(1585, 868), p(1430, 800), p(1275, 730), p(1045, 625)],
    kind: "refusal",
    from: "approval",
    to: "decisionTable",
  },
  approvalToPermission: {
    id: "approvalToPermission",
    points: [p(1790, 952), p(1850, 962)],
    kind: "approval",
    from: "approval",
    to: "permission",
  },
  permissionToBudget: {
    id: "permissionToBudget",
    points: [p(1905, 1020), p(1905, 1120)],
    kind: "command",
    from: "permission",
    to: "budgetMeter",
    twoWay: true,
  },
  permissionToRisk: {
    id: "permissionToRisk",
    points: [p(1965, 1000), p(2025, 1035)],
    kind: "approval",
    from: "permission",
    to: "riskFortress",
  },
  riskToProtection: {
    id: "riskToProtection",
    points: [p(2235, 1135), p(2295, 1205)],
    kind: "order",
    from: "riskFortress",
    to: "protection",
  },
  protectionToSigner: {
    id: "protectionToSigner",
    points: [p(2345, 1205), p(2415, 1075)],
    kind: "order",
    from: "protection",
    to: "signerVault",
  },
  signerToExecution: {
    id: "signerToExecution",
    points: [p(2455, 1055), p(2480, 1115)],
    kind: "order",
    from: "signerVault",
    to: "executionGateway",
  },
  exchangeTunnel: {
    id: "exchangeTunnel",
    // Lands at the receiving terminal socket on the platform's west face
    // (world/hyperliquid.ts builds the socket around PAD 2660,1112).
    points: [p(2530, 1160), p(2610, 1144), p(2660, 1114)],
    kind: "order",
    from: "executionGateway",
    externalTo: "hyperliquid",
    twoWay: true,
  },
  exchangeStateReturn: {
    id: "exchangeStateReturn",
    // Departs from the same terminal heading south along the platform face.
    points: [
      p(2662, 1132),
      p(2610, 1315),
      p(2200, 1412),
      p(1500, 1432),
      p(1000, 1398),
      p(700, 1330),
      p(618, 1292),
    ],
    kind: "recon",
    externalFrom: "hyperliquid",
    to: "reconciliationDock",
  },
  executionToReceipts: {
    id: "executionToReceipts",
    // Receipt leg runs above (north of) exchangeStateReturn with ~80-120u
    // of separation, and elbows north of the audit archive footprint
    // (955-1175 x, 1240-1370 y) instead of weaving through it.
    points: [
      p(2465, 1210),
      p(2320, 1270),
      p(1900, 1320),
      p(1350, 1300),
      p(1150, 1240),
      p(980, 1225),
      p(852, 1252),
    ],
    kind: "receipt",
    from: "executionGateway",
    to: "receiptPrinter",
  },
  receiptsToArchive: {
    id: "receiptsToArchive",
    points: [p(868, 1252), p(960, 1288), p(1028, 1300)],
    kind: "receipt",
    from: "receiptPrinter",
    to: "auditArchive",
  },
  localStateStream: {
    id: "localStateStream",
    points: [p(948, 1160), p(800, 1225), p(648, 1268)],
    kind: "recon",
    from: "portfolioVault",
    to: "reconciliationDock",
  },
  floorToMcp: {
    id: "floorToMcp",
    points: [p(1705, 645), p(1905, 560), p(2058, 515)],
    kind: "command",
    from: "tradingFloor",
    to: "mcpHub",
    twoWay: true,
  },
  hubToAdapterBay: {
    id: "hubToAdapterBay",
    points: [p(2320, 505), p(2405, 502)],
    kind: "command",
    from: "mcpHub",
    to: "adapterBay",
    twoWay: true,
  },
  missionToSignalTower: {
    id: "missionToSignalTower",
    // Mission status changes propagate east to the signal tower. The old path
    // was one long diagonal that stopped at the event clock; this one walks
    // readable elbows: below the mission board, along the corridor north of
    // budget planning, down the budget/strategy gap, under the decision
    // table, up the research/floor seam past the event clock, then east along
    // the floor's north apron into the tower's west face.
    points: [
      p(448, 332),
      p(455, 448),
      p(848, 448),
      p(848, 708),
      p(1170, 708),
      p(1170, 545),
      p(1808, 545),
    ],
    kind: "command",
    from: "missionBoard",
    to: "signalTower",
  },
  recoveryDispatch: {
    id: "recoveryDispatch",
    points: [p(470, 1330), p(560, 1300), p(590, 1290)],
    kind: "command",
    from: "recoveryWorkshop",
    to: "reconciliationDock",
    twoWay: true,
  },
};

export const ROUTE_ORDER: RouteId[] = Object.keys(ROUTES) as RouteId[];
