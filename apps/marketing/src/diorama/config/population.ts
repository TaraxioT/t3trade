/**
 * Agent roster: about two dozen expressive miniature utility robots. Roles
 * color small accessories (backpack, antenna, screen) only, never the whole
 * body. Homes are stations; wander paths are authored loops around the home
 * section so agents visibly travel instead of freezing at desks. Every home
 * and wander point stays inside the one-room diamond (see config/geometry.ts
 * insideRoom; the containment sweep in artifacts/diorama asserts it).
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
}

const p = (x: number, y: number) => ({ x, y });

export const POPULATION: AgentDef[] = [
  // West section: research row (7). Wanders hug the N-W wall band and the
  // research wedge; the taper keeps the far southwest thin on purpose.
  {
    id: "probe-1",
    role: "research",
    home: "marketLandscape",
    variant: 0.12,
    // Walks the floor terrain band beside the landscape probes (feet from
    // the lane-i band contract).
    wander: [p(715, 508), p(768, 481), p(844, 443), p(930, 401), p(845, 459)],
    restingExpression: "curious",
  },
  {
    id: "research-1",
    role: "research",
    home: "researchTools",
    variant: 0.55,
    wander: [p(905, 515), p(955, 530), p(1005, 500), p(960, 470)],
    restingExpression: "curious",
  },
  {
    id: "analysis-1",
    role: "analysis",
    home: "strategyLab",
    variant: 0.31,
    // Southwest apron of the lab (strategy-1 takes the northeast side).
    wander: [p(975, 470), p(1015, 485), p(985, 500), p(955, 460)],
    restingExpression: "focused",
  },
  {
    id: "strategy-1",
    role: "strategy",
    home: "strategyLab",
    variant: 0.78,
    wander: [p(1045, 415), p(1085, 440), p(1060, 465), p(1090, 490)],
    restingExpression: "focused",
  },
  {
    id: "structure-host",
    role: "research",
    home: "liquidityResearch",
    variant: 0.5,
    // Plain desk-matched host for the concept-model exhibit; no costume.
    wander: [p(665, 720), p(730, 695), p(800, 715), p(860, 755)],
    restingExpression: "curious",
  },
  {
    id: "sandbox-1",
    role: "research",
    home: "sandbox",
    variant: 0.93,
    // Northwest pocket beside the sandbox, clear of the west wall taper.
    wander: [p(295, 730), p(340, 712), p(372, 690), p(330, 702)],
    restingExpression: "excited",
  },
  {
    id: "strategy-2",
    role: "strategy",
    home: "decisionTable",
    variant: 0.44,
    // Kept north/west of the anchor: the table sits close to the taper edge.
    wander: [p(645, 955), p(700, 968), p(748, 990), p(695, 1000)],
    restingExpression: "focused",
  },

  // West section: MCP tool row (4) around the southwest interchange.
  {
    id: "hub-keeper",
    role: "operations",
    home: "mcpHub",
    variant: 0.19,
    wander: [p(775, 925), p(855, 915), p(925, 940), p(700, 975)],
    restingExpression: "focused",
  },
  {
    id: "schema-librarian",
    role: "operations",
    home: "toolSchemas",
    variant: 0.66,
    wander: [p(955, 975), p(1015, 985), p(1065, 1000), p(1000, 962)],
    restingExpression: "neutral",
  },
  {
    id: "adapter-op",
    role: "operations",
    home: "adapterBay",
    variant: 0.51,
    wander: [p(1045, 1015), p(1095, 1030), p(1105, 1065), p(1055, 1050)],
    restingExpression: "focused",
  },
  {
    id: "health-watcher",
    role: "analysis",
    home: "mcpHealth",
    variant: 0.03,
    wander: [p(900, 1050), p(950, 1060), p(1000, 1075), p(945, 1035)],
    restingExpression: "neutral",
  },

  // Central trading floor (7). Wanders are ring arcs around the holo so the
  // floor reads as circulation between consoles, not vibration at desks.
  // The holo footprint is x 1320..1550, y 635..775; arcs stay outside it and
  // clear of the mascot pad at (1435, 965).
  {
    id: "floor-research",
    role: "research",
    home: "tradingFloor",
    variant: 0.08,
    // First point is its desk; the arc stays north of the holo.
    wander: [p(1205, 610), p(1300, 580), p(1400, 565), p(1490, 575), p(1570, 610)],
    restingExpression: "focused",
  },
  {
    id: "floor-analysis",
    role: "analysis",
    home: "tradingFloor",
    variant: 0.62,
    // East ring, south of the exchange port booth and outside the holo.
    wander: [p(1590, 640), p(1665, 690), p(1670, 760), p(1615, 815)],
    restingExpression: "focused",
  },
  {
    id: "port-analyst",
    role: "analysis",
    home: "hyperliquidVenue",
    variant: 0.9,
    // Plain floor-side analyst stationed at the docked exchange booth; the
    // loop stays west of the port footprint on the floor apron.
    wander: [p(1690, 555), p(1735, 520), p(1700, 470), p(1660, 505)],
    restingExpression: "focused",
  },
  {
    id: "floor-strategy",
    role: "strategy",
    home: "tradingFloor",
    variant: 0.27,
    wander: [p(1230, 835), p(1295, 800), p(1350, 850), p(1295, 890)],
    restingExpression: "focused",
  },
  {
    id: "floor-exec",
    role: "execution",
    home: "tradingFloor",
    variant: 0.71,
    wander: [p(1640, 830), p(1585, 880), p(1505, 905), p(1560, 850)],
    restingExpression: "focused",
  },
  {
    id: "floor-monitor",
    role: "operations",
    home: "tradingFloor",
    variant: 0.36,
    // Southwest ring, kept west of the mascot pad.
    wander: [p(1330, 900), p(1375, 930), p(1330, 955), p(1295, 925)],
    restingExpression: "neutral",
  },
  {
    id: "floor-recon",
    role: "reconciliation",
    home: "tradingFloor",
    variant: 0.84,
    wander: [p(1560, 950), p(1600, 915), p(1540, 890), p(1500, 930)],
    restingExpression: "neutral",
  },

  // East section: guarded execution band (5) along the N-E wall.
  {
    id: "approval-clerk",
    role: "operations",
    home: "approval",
    variant: 0.47,
    wander: [p(1825, 700), p(1875, 725), p(1840, 675), p(1800, 700)],
    restingExpression: "neutral",
  },
  {
    id: "permission-keeper",
    role: "risk",
    home: "permission",
    variant: 0.24,
    // North apron of the permission lock, inside the wall curve.
    wander: [p(1958, 478), p(2008, 492), p(2058, 516), p(2005, 470)],
    restingExpression: "focused",
  },
  {
    id: "risk-scanner",
    role: "risk",
    home: "riskFortress",
    variant: 0.89,
    wander: [p(2130, 735), p(2200, 745), p(2270, 770), p(2205, 715)],
    restingExpression: "focused",
  },
  {
    id: "vault-keeper",
    role: "execution",
    home: "signerVault",
    variant: 0.58,
    wander: [p(2345, 700), p(2400, 715), p(2450, 740), p(2398, 690)],
    restingExpression: "focused",
  },
  {
    id: "gateway-op",
    role: "execution",
    home: "executionGateway",
    variant: 0.97,
    wander: [p(1895, 640), p(1950, 625), p(1910, 600), p(1875, 630)],
    restingExpression: "focused",
  },

  // East section: state & reconciliation cluster (6) across the south band.
  {
    id: "recon-1",
    role: "reconciliation",
    home: "reconciliationDock",
    variant: 0.41,
    wander: [p(1700, 1055), p(1715, 1060), p(1760, 1090), p(1700, 1035)],
    restingExpression: "focused",
  },
  {
    id: "receipt-clerk",
    role: "operations",
    home: "receiptPrinter",
    variant: 0.14,
    wander: [p(1760, 1115), p(1810, 1128), p(1780, 1090), p(1740, 1105)],
    restingExpression: "neutral",
  },
  {
    id: "archivist",
    role: "operations",
    home: "auditArchive",
    variant: 0.73,
    wander: [p(1870, 1050), p(1925, 1060), p(1960, 1090), p(1910, 1035)],
    restingExpression: "neutral",
  },
  {
    id: "recovery-1",
    role: "reconciliation",
    home: "recoveryWorkshop",
    variant: 0.06,
    // Southwest of the workshop, inside the narrowing pocket edge.
    wander: [p(1622, 1185), p(1655, 1195), p(1690, 1220), p(1618, 1235)],
    restingExpression: "worried",
  },
  {
    id: "observer-1",
    role: "operations",
    home: "observability",
    variant: 0.69,
    wander: [p(2090, 960), p(2140, 970), p(2168, 975), p(2135, 945)],
    restingExpression: "focused",
  },
  {
    id: "replay-op",
    role: "analysis",
    home: "replayChamber",
    variant: 0.33,
    wander: [p(1838, 828), p(1888, 840), p(1908, 865), p(1858, 818)],
    restingExpression: "curious",
  },
];

export const AGENT_COUNT = POPULATION.length;
