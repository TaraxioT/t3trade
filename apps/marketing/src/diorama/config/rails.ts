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
export const PACKET_STYLE: Record<PacketKind, { shape: "chevron" | "dot" | "card" | "capsule" | "slip"; color: number; size: number }> = {
  command: { shape: "chevron", color: 0x34e5e5, size: 12 },
  event: { shape: "dot", color: 0x5a7cff, size: 8 },
  proposal: { shape: "card", color: 0x9a70ff, size: 13 },
  toolResult: { shape: "dot", color: 0x56f2c2, size: 9 },
  approval: { shape: "card", color: 0x63f58b, size: 13 },
  order: { shape: "capsule", color: 0xff9f45, size: 14 },
  receipt: { shape: "slip", color: 0xddef3, size: 11 },
  recon: { shape: "dot", color: 0x56f2c2, size: 10 },
  refusal: { shape: "card", color: 0xff6b75, size: 12 },
};

export type RouteId =
  | "landscapeToMarketData"
  | "landscapeToResearchTools"
  | "marketDataToStrategy"
  | "strategyToMissionBoard"
  | "strategyToDecision"
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
  | "receiptsToStateStore"
  | "localStateStream"
  | "floorToMcp"
  | "floorToApproval"
  | "hubToMarketDataTools"
  | "hubToResearchTools"
  | "hubToPortfolioTools"
  | "hubToSchemas"
  | "hubToAdapterBay"
  | "adapterToProviders"
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
  /** Two-way routes allow reverse travel (packets flip direction). */
  twoWay?: boolean;
}

/**
 * PRIMARY lifecycle corridor: research -> strategy -> mission -> decision ->
 * approval -> permission -> risk -> protection -> signer -> execution ->
 * exchange, plus the exchange -> reconciliation -> receipts -> archive
 * return leg. Primary rails render at full contrast with direction chevrons;
 * everything else (research/tool traffic, provider links) is subordinate.
 */
export const PRIMARY_ROUTES: ReadonlySet<RouteId> = new Set<RouteId>([
  "marketDataToStrategy",
  "strategyToMissionBoard",
  "strategyToDecision",
  "decisionToApproval",
  "approvalToPermission",
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
 * read as a distinct flow from outgoing orange order capsules.
 */
export const RETURN_ROUTES: ReadonlySet<RouteId> = new Set<RouteId>([
  "exchangeStateReturn",
  "executionToReceipts",
  "receiptsToArchive",
  "receiptsToStateStore",
]);

const p = (x: number, y: number) => ({ x, y });

export const ROUTES: Record<RouteId, RouteDef> = {
  landscapeToMarketData: {
    id: "landscapeToMarketData",
    points: [p(545, 235), p(575, 275), p(592, 300)],
    kind: "event",
    to: "marketData",
  },
  landscapeToResearchTools: {
    id: "landscapeToResearchTools",
    points: [p(790, 235), p(805, 265), p(818, 282)],
    kind: "event",
    to: "researchTools",
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
  strategyToDecision: {
    id: "strategyToDecision",
    points: [p(1005, 448), p(1012, 540)],
    kind: "proposal",
    from: "strategyLab",
    to: "decisionTable",
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
    points: [p(2530, 1160), p(2630, 1130), p(2695, 1105)],
    kind: "order",
    from: "executionGateway",
    twoWay: true,
  },
  exchangeStateReturn: {
    id: "exchangeStateReturn",
    points: [
      p(2705, 1170),
      p(2610, 1315),
      p(2200, 1412),
      p(1500, 1432),
      p(1000, 1398),
      p(700, 1330),
      p(618, 1292),
    ],
    kind: "recon",
  },
  executionToReceipts: {
    id: "executionToReceipts",
    // Receipt leg runs above (north of) exchangeStateReturn with ~80-120u
    // of separation, and elbows north of the audit archive footprint
    // (955-1175 x, 1240-1370 y) instead of weaving through it.
    points: [p(2465, 1210), p(2320, 1270), p(1900, 1320), p(1350, 1300), p(1150, 1240), p(980, 1225), p(852, 1252)],
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
  receiptsToStateStore: {
    id: "receiptsToStateStore",
    points: [p(790, 1215), p(650, 1150), p(520, 1062)],
    kind: "event",
    from: "receiptPrinter",
    to: "stateStore",
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
  floorToApproval: {
    id: "floorToApproval",
    points: [p(1560, 865), p(1662, 912)],
    kind: "proposal",
    from: "tradingFloor",
    to: "approval",
  },
  hubToMarketDataTools: {
    id: "hubToMarketDataTools",
    points: [p(2120, 438), p(2072, 392), p(2038, 362)],
    kind: "command",
    from: "mcpHub",
    to: "marketDataTools",
    twoWay: true,
  },
  hubToResearchTools: {
    id: "hubToResearchTools",
    points: [p(2258, 438), p(2312, 382), p(2348, 350)],
    kind: "command",
    from: "mcpHub",
    to: "researchToolsMcp",
    twoWay: true,
  },
  hubToPortfolioTools: {
    id: "hubToPortfolioTools",
    points: [p(2120, 570), p(2072, 612), p(2040, 640)],
    kind: "command",
    from: "mcpHub",
    to: "portfolioTools",
    twoWay: true,
  },
  hubToSchemas: {
    id: "hubToSchemas",
    points: [p(2258, 570), p(2322, 618), p(2368, 648)],
    kind: "command",
    from: "mcpHub",
    to: "toolSchemas",
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
  adapterToProviders: {
    id: "adapterToProviders",
    points: [p(2502, 455), p(2488, 330), p(2440, 245)],
    kind: "event",
    from: "adapterBay",
    to: "providers",
    twoWay: true,
  },
  missionToSignalTower: {
    id: "missionToSignalTower",
    // Rerouted off the old long diagonal across the research floor: gentle
    // elbows along the district edges (below the mission board, through the
    // budget-planning/strategy gap, then east to the terminal point).
    points: [p(425, 348), p(430, 420), p(650, 458), p(850, 495), p(1000, 545), p(1080, 528)],
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
