/**
 * Agent roster: about two dozen expressive miniature utility robots. Roles
 * color small accessories (backpack, antenna, screen) only, never the whole
 * body. Homes are stations; wander paths are authored loops around the home
 * district so agents visibly travel instead of freezing at desks.
 *
 * `variant` (0..1) is the single deterministic seed every per-agent
 * difference derives from: height, head width, antenna, backpack, walk
 * cadence, idle posture, reaction intensity. One field keeps the cast one
 * coherent species while making individuals recognizable.
 */
import type { AgentRole } from "./palette.js";
import type { StationId } from "./stations.js";

export interface AgentDef {
  id: string;
  role: AgentRole;
  /** Station the agent belongs to. */
  home: StationId;
  /** Authored idle loop of world points near home; the agent walks it between tasks. */
  wander: { x: number; y: number }[];
  /** Resting expression when idle. */
  restingExpression?: string;
  /** Deterministic individuality seed in [0, 1). */
  variant: number;
  /** Branded accent kit for the floor venue hosts (see agents/agent.ts). */
  theme?: "uniswap" | "hyperliquid";
}

const p = (x: number, y: number) => ({ x, y });

export const POPULATION: AgentDef[] = [
  // Research & strategy district (6)
  {
    id: "probe-1",
    role: "research",
    home: "marketLandscape",
    variant: 0.12,
    wander: [p(430, 240), p(560, 250), p(680, 235), p(850, 245), p(930, 250)],
    restingExpression: "curious",
  },
  {
    id: "research-1",
    role: "research",
    home: "researchTools",
    variant: 0.55,
    wander: [p(760, 345), p(820, 360), p(870, 340), p(810, 322)],
    restingExpression: "curious",
  },
  {
    id: "analysis-1",
    role: "analysis",
    home: "strategyLab",
    variant: 0.31,
    wander: [p(920, 445), p(965, 462), p(1005, 440), p(958, 424)],
    restingExpression: "focused",
  },
  {
    id: "strategy-1",
    role: "strategy",
    home: "strategyLab",
    variant: 0.78,
    wander: [p(1000, 430), p(1042, 456), p(1012, 434), p(1055, 470)],
    restingExpression: "focused",
  },
  {
    id: "sandbox-1",
    role: "research",
    home: "sandbox",
    variant: 0.93,
    wander: [p(330, 600), p(330, 570), p(295, 555), p(360, 545), p(330, 538)],
    restingExpression: "excited",
  },
  {
    id: "strategy-2",
    role: "strategy",
    home: "decisionTable",
    variant: 0.44,
    wander: [p(955, 655), p(1010, 672), p(1060, 650), p(1008, 636)],
    restingExpression: "focused",
  },

  // Central trading floor desks (6). Wanders are ring arcs around the holo so
  // the floor reads as circulation between consoles, not vibration at desks.
  // The holo footprint is x 1300..1560, y 590..740; arcs stay outside it.
  {
    id: "floor-research",
    role: "research",
    home: "tradingFloor",
    variant: 0.08,
    // First point is its desk, moved west with the desk when the Uniswap
    // pavilion took the old inner-ring spot; the arc stays north of the holo.
    wander: [p(1198, 652), p(1315, 570), p(1420, 560), p(1505, 572), p(1585, 608)],
    restingExpression: "focused",
  },
  {
    id: "floor-analysis",
    role: "analysis",
    home: "tradingFloor",
    variant: 0.62,
    // First point is its desk on the east ring, back at its original spot
    // now that the floor's Hyperliquid pavilion is gone.
    wander: [p(1590, 640), p(1662, 690), p(1668, 762), p(1618, 812)],
    restingExpression: "focused",
  },
  {
    id: "floor-strategy",
    role: "strategy",
    home: "tradingFloor",
    variant: 0.27,
    wander: [p(1225, 830), p(1292, 798), p(1342, 848), p(1290, 884)],
    restingExpression: "focused",
  },
  {
    id: "floor-exec",
    role: "execution",
    home: "tradingFloor",
    variant: 0.71,
    wander: [p(1635, 830), p(1580, 882), p(1502, 905), p(1556, 852)],
    restingExpression: "focused",
  },
  {
    id: "floor-monitor",
    role: "operations",
    home: "tradingFloor",
    variant: 0.36,
    wander: [p(1370, 935), p(1412, 962), p(1462, 935), p(1424, 900)],
    restingExpression: "neutral",
  },
  {
    id: "floor-recon",
    role: "reconciliation",
    home: "tradingFloor",
    variant: 0.84,
    wander: [p(1520, 950), p(1556, 920), p(1502, 895), p(1470, 940)],
    restingExpression: "neutral",
  },
  // Floor venue host: the branded Uniswap bot lives at its pavilion west of
  // the holo. Its loop hugs the inner apron south of the venue, clear of the
  // ring arcs above and the mascot pad to the east.
  {
    id: "uniswap-bot",
    role: "research",
    home: "uniswapVenue",
    variant: 0.42,
    theme: "uniswap",
    wander: [p(1300, 715), p(1330, 745), p(1355, 710)],
    restingExpression: "curious",
  },
  // The Hyperliquid-themed bot lives where the venue actually is: at the
  // execution gateway feeding the east tunnel, not on the trading floor.
  {
    id: "hyperliquid-bot",
    role: "execution",
    home: "executionGateway",
    variant: 0.61,
    theme: "hyperliquid",
    wander: [p(2402, 1122), p(2440, 1102), p(2470, 1132)],
    restingExpression: "focused",
  },

  // MCP & provider district (4)
  {
    id: "hub-keeper",
    role: "operations",
    home: "mcpHub",
    variant: 0.19,
    wander: [p(2140, 540), p(2200, 548), p(2262, 536), p(2196, 562)],
    restingExpression: "focused",
  },
  {
    id: "schema-librarian",
    role: "operations",
    home: "toolSchemas",
    variant: 0.66,
    wander: [p(2340, 700), p(2392, 712), p(2442, 692), p(2394, 676)],
    restingExpression: "neutral",
  },
  {
    id: "adapter-op",
    role: "operations",
    home: "adapterBay",
    variant: 0.51,
    wander: [p(2442, 530), p(2496, 522), p(2530, 552), p(2488, 545)],
    restingExpression: "focused",
  },
  {
    id: "health-watcher",
    role: "analysis",
    home: "mcpHealth",
    variant: 0.03,
    wander: [p(2062, 868), p(2112, 874), p(2160, 858), p(2112, 844)],
    restingExpression: "neutral",
  },

  // Risk & execution district (5)
  {
    id: "approval-clerk",
    role: "operations",
    home: "approval",
    variant: 0.47,
    wander: [p(1688, 975), p(1740, 986), p(1782, 966), p(1736, 952)],
    restingExpression: "neutral",
  },
  {
    id: "permission-keeper",
    role: "risk",
    home: "permission",
    variant: 0.24,
    wander: [p(1866, 1005), p(1918, 1012), p(1962, 992), p(1916, 978)],
    restingExpression: "focused",
  },
  {
    id: "risk-scanner",
    role: "risk",
    home: "riskFortress",
    variant: 0.89,
    wander: [p(2085, 1115), p(2142, 1098), p(2212, 1140), p(2160, 1122), p(2240, 1165)],
    restingExpression: "focused",
  },
  {
    id: "vault-keeper",
    role: "execution",
    home: "signerVault",
    variant: 0.58,
    wander: [p(2400, 1038), p(2450, 1046), p(2470, 1032), p(2444, 1018)],
    restingExpression: "focused",
  },
  {
    id: "gateway-op",
    role: "execution",
    home: "executionGateway",
    variant: 0.97,
    wander: [p(2450, 1192), p(2500, 1214), p(2536, 1206), p(2498, 1174)],
    restingExpression: "focused",
  },

  // State, audit & operations district (6)
  {
    id: "recon-1",
    role: "reconciliation",
    home: "reconciliationDock",
    variant: 0.41,
    wander: [p(500, 1292), p(560, 1302), p(622, 1286), p(566, 1272)],
    restingExpression: "focused",
  },
  {
    id: "receipt-clerk",
    role: "operations",
    home: "receiptPrinter",
    variant: 0.14,
    wander: [p(775, 1262), p(822, 1272), p(862, 1254), p(818, 1244)],
    restingExpression: "neutral",
  },
  {
    id: "archivist",
    role: "operations",
    home: "auditArchive",
    variant: 0.73,
    wander: [p(1002, 1332), p(1062, 1340), p(1122, 1326), p(1064, 1310)],
    restingExpression: "neutral",
  },
  {
    id: "recovery-1",
    role: "reconciliation",
    home: "recoveryWorkshop",
    variant: 0.06,
    wander: [p(370, 1382), p(430, 1390), p(478, 1370), p(424, 1358)],
    restingExpression: "worried",
  },
  {
    id: "observer-1",
    role: "operations",
    home: "observability",
    variant: 0.69,
    wander: [p(1118, 1064), p(1168, 1072), p(1212, 1054), p(1166, 1040)],
    restingExpression: "focused",
  },
  {
    id: "replay-op",
    role: "analysis",
    home: "replayChamber",
    variant: 0.33,
    wander: [p(1238, 1202), p(1282, 1212), p(1322, 1194), p(1278, 1184)],
    restingExpression: "curious",
  },
];

export const AGENT_COUNT = POPULATION.length;
