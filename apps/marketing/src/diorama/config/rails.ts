/**
 * Rail network: named polyline routes in world units. Rails are the visible
 * nervous system of the one-room diorama; every packet corresponds to a real
 * system event (command, proposal, approval, order, receipt, reconciliation)
 * and travels a named route between stations. Builders must not invent
 * ambient particle traffic that means nothing.
 *
 * The only venue crossing is the exchange port threshold at the floor's east
 * seam: orders hop executionGateway -> exchangeOrder -> the docked exchange
 * booth, and the booth's authoritative state flows back down
 * exchangeStateReturn into the reconciliation dock. 20 routes total; every
 * waypoint sits inside the room diamond (config/geometry.ts insideRoom) and
 * derives from the current config/stations.ts anchors.
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
  | "exchangeOrder"
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
  /** Endpoints for stories and station-focus masking (station ids). */
  from?: StationId;
  to?: StationId;
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
  "exchangeOrder",
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
    // Probe tripods stand at the wall-relief base; the southern foot feeds
    // market data packets down into the screens' NW face.
    points: [p(741.6, 494.7), p(760, 520), p(771, 537)],
    kind: "event",
    from: "marketLandscape",
    to: "marketData",
  },
  marketDataToStrategy: {
    id: "marketDataToStrategy",
    // Detours south of researchTools (the direct NE diagonal runs through
    // its anchor), then climbs into the strategy lab's SW lobe past the
    // tools' SE tip.
    points: [p(858, 596), p(925, 618), p(1000, 562), p(1055, 528), p(1047, 473)],
    kind: "toolResult",
    from: "marketData",
    to: "strategyLab",
    twoWay: true,
  },
  strategyToMissionBoard: {
    id: "strategyToMissionBoard",
    // Westward run down the research wedge: south of the strategy lab and
    // research tools, around liquidityResearch's SE corner, then into the
    // mission board's NE face through the notch north of portfolioTools.
    points: [
      p(1073, 492),
      p(1000, 545),
      p(940, 590),
      p(872, 655),
      p(852, 740),
      p(790, 828),
      p(665, 838),
      p(642, 858),
      p(595, 845),
    ],
    kind: "event",
    from: "strategyLab",
    to: "missionBoard",
    twoWay: true,
  },
  decisionToApproval: {
    id: "decisionToApproval",
    // Corridor north of the MCP row and the trading floor dais: the proposal
    // leaves the decision table's east lobe, passes between portfolioTools
    // and the hub's NE flank, climbs past the dais NW tip, runs the north
    // apron above the holo, and drops to the approval north face at the
    // seam. South of the dais is walled off by the SW tool cluster.
    points: [
      p(740, 952),
      p(795, 922),
      p(852, 890),
      p(1010, 866),
      p(1130, 836),
      p(1300, 700),
      p(1400, 640),
      p(1500, 655),
      p(1600, 700),
      p(1700, 742),
      p(1795, 710),
    ],
    kind: "proposal",
    from: "decisionTable",
    to: "approval",
  },
  deniedReturn: {
    id: "deniedReturn",
    // Refusal return runs the same corridor as decisionToApproval but offset
    // ~20u south through the funnel, then dips through the decision
    // table/hub pinch into the table's north lobe, away from the outbound
    // east-lobe departure. Both endpoints differ from the outbound leg.
    points: [
      p(1718, 762),
      p(1618, 660),
      p(1518, 612),
      p(1420, 600),
      p(1320, 672),
      p(1200, 760),
      p(1005, 830),
      p(905, 848),
      p(868, 905),
      p(805, 935),
      p(740, 980),
      p(708, 937),
    ],
    kind: "refusal",
    from: "approval",
    to: "decisionTable",
  },
  approvalToPermission: {
    id: "approvalToPermission",
    // Threads east of the execution gateway (the direct NE line runs
    // through its anchor) and arrives at the permission south tip.
    points: [p(1882, 758), p(1935, 738), p(1992, 682), p(2000, 624)],
    kind: "approval",
    from: "approval",
    to: "permission",
  },
  permissionToBudget: {
    id: "permissionToBudget",
    points: [p(2088, 560), p(2148, 618)],
    kind: "command",
    from: "permission",
    to: "budgetMeter",
    twoWay: true,
  },
  permissionToRisk: {
    id: "permissionToRisk",
    // Drops SE below budgetMeter's west flank onto the fortress north face.
    points: [p(2050, 592), p(2112, 666), p(2188, 714)],
    kind: "approval",
    from: "permission",
    to: "riskFortress",
  },
  riskToProtection: {
    id: "riskToProtection",
    points: [p(2066, 798), p(2048, 782)],
    kind: "order",
    from: "riskFortress",
    to: "protection",
  },
  protectionToSigner: {
    id: "protectionToSigner",
    // Arcs south of the risk fortress and the identity gate; the north way
    // is pinched shut between budgetMeter and the NE wall face.
    points: [p(2010, 815), p(2085, 888), p(2250, 873), p(2320, 860), p(2362, 802)],
    kind: "order",
    from: "protection",
    to: "signerVault",
  },
  signerToExecution: {
    id: "signerToExecution",
    // Westbound through the budgetMeter/fortress gap (protectionToSigner
    // took the south arc) into the gateway's NE face.
    points: [p(2323, 760), p(2252, 686), p(2150, 668), p(2045, 652), p(1988, 646)],
    kind: "order",
    from: "signerVault",
    to: "executionGateway",
  },
  exchangeOrder: {
    id: "exchangeOrder",
    // THE venue crossing: gateway west tip past the booth's south flank to
    // the dock threshold (1747, 522) the port builder draws. Short and
    // direct so signer -> execution -> exchange reads as one move; acks and
    // fills return along the same leg (twoWay).
    points: [p(1857, 660), p(1820, 612), p(1797, 585), p(1747, 522)],
    kind: "order",
    from: "executionGateway",
    to: "hyperliquidVenue",
    twoWay: true,
  },
  exchangeStateReturn: {
    id: "exchangeStateReturn",
    // Authoritative state leaves the booth's south tip, runs down the
    // seam-side corridor between the dais east tip and the approval west
    // tip, jogs west of the activity gallery, and lands in the dock's west
    // lobe. Stays ~40u west of (parallel to) the authority seam inlay.
    points: [
      p(1810, 585),
      p(1782, 672),
      p(1711, 700),
      p(1690, 790),
      p(1720, 860),
      p(1715, 950),
      p(1660, 985),
      p(1637, 1030),
      p(1655, 1075),
      p(1680, 1102),
    ],
    kind: "recon",
    from: "hyperliquidVenue",
    to: "reconciliationDock",
  },
  executionToReceipts: {
    id: "executionToReceipts",
    // Receipt leg keeps ~100u east of the state return through the pocket:
    // down the gateway's south face, through the replay/vault channel, east
    // of the rail yard, then west into the printer's north lobe.
    points: [
      p(1930, 715),
      p(1935, 800),
      p(1920, 890),
      p(1928, 968),
      p(1928, 1008),
      p(1890, 1045),
      p(1840, 1046),
      p(1815, 1044),
    ],
    kind: "receipt",
    from: "executionGateway",
    to: "receiptPrinter",
  },
  receiptsToArchive: {
    id: "receiptsToArchive",
    points: [p(1856, 1068), p(1902, 1085)],
    kind: "receipt",
    from: "receiptPrinter",
    to: "auditArchive",
  },
  localStateStream: {
    id: "localStateStream",
    // Local expected state: vault SW corner, under the rail yard's south
    // flank, through the printer/archive funnel into the dock's east lobe.
    points: [
      p(1943, 946),
      p(1908, 1000),
      p(1866, 1032),
      p(1848, 1075),
      p(1815, 1102),
      p(1788, 1112),
    ],
    kind: "recon",
    from: "portfolioVault",
    to: "reconciliationDock",
  },
  floorToMcp: {
    id: "floorToMcp",
    // Dais SW rim, west along the band between the decisionToApproval
    // corridor and budgetPlanning's north tip, into the hub's NW lobe.
    points: [p(1210, 882), p(1120, 905), p(1060, 895), p(990, 889), p(940, 900), p(872, 928)],
    kind: "command",
    from: "tradingFloor",
    to: "mcpHub",
    twoWay: true,
  },
  hubToAdapterBay: {
    id: "hubToAdapterBay",
    // The MCP row has no straight lane: hub south tip, along the health
    // monitor's NW edge, through the schemas/health slot, into the adapter
    // west face. The schemas row and the environments box seal every other
    // approach.
    points: [
      p(850, 1092),
      p(920, 1070),
      p(945, 1058),
      p(972, 1064),
      p(1005, 1086),
      p(1030, 1100),
      p(1055, 1092),
    ],
    kind: "command",
    from: "mcpHub",
    to: "adapterBay",
    twoWay: true,
  },
  missionToSignalTower: {
    id: "missionToSignalTower",
    // Mission status propagates north out of the west wedge, east under the
    // wall relief (between the research row and the wall face, clearing the
    // probe tripoids and the strategy lab's north tip), past the event
    // clock's north side, then along the floor's north apron into the
    // tower's west face.
    points: [
      p(540, 812),
      p(548, 688),
      p(655, 608),
      p(700, 535),
      p(790, 492),
      p(862, 462),
      p(940, 430),
      p(1000, 395),
      p(1065, 348),
      p(1150, 352),
      p(1190, 372),
      p(1400, 398),
      p(1578, 392),
    ],
    kind: "command",
    from: "missionBoard",
    to: "signalTower",
  },
  recoveryDispatch: {
    id: "recoveryDispatch",
    // Recovery sits in the SE pocket directly south of the dock; the hop
    // threads the ~10u gap between their footprints.
    points: [p(1636, 1152), p(1690, 1180)],
    kind: "command",
    from: "recoveryWorkshop",
    to: "reconciliationDock",
    twoWay: true,
  },
};

export const ROUTE_ORDER: RouteId[] = Object.keys(ROUTES) as RouteId[];
