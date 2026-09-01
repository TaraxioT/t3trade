/**
 * Agent roster: about two dozen expressive miniature utility robots. Roles
 * color small accessories (backpack, antenna, screen) only, never the whole
 * body. Homes are stations; wander paths are authored loops around the home
 * district so agents visibly travel instead of freezing at desks.
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
}

const p = (x: number, y: number) => ({ x, y });

export const POPULATION: AgentDef[] = [
  // Research & strategy district (6)
  { id: "probe-1", role: "research", home: "marketLandscape", wander: [p(430, 240), p(560, 250), p(680, 235), p(850, 245), p(930, 250)], restingExpression: "curious" },
  { id: "research-1", role: "research", home: "researchTools", wander: [p(790, 330), p(850, 350), p(810, 320)], restingExpression: "curious" },
  { id: "analysis-1", role: "analysis", home: "strategyLab", wander: [p(940, 430), p(990, 450), p(955, 425)], restingExpression: "focused" },
  { id: "strategy-1", role: "strategy", home: "strategyLab", wander: [p(1000, 430), p(1040, 455), p(1010, 432)], restingExpression: "focused" },
  { id: "sandbox-1", role: "research", home: "sandbox", wander: [p(300, 560), p(360, 575), p(330, 548)], restingExpression: "excited" },
  { id: "strategy-2", role: "strategy", home: "decisionTable", wander: [p(980, 640), p(1040, 660), p(1008, 638)], restingExpression: "focused" },

  // Central trading floor desks (6)
  { id: "floor-research", role: "research", home: "tradingFloor", wander: [p(1268, 640), p(1310, 655)], restingExpression: "focused" },
  { id: "floor-analysis", role: "analysis", home: "tradingFloor", wander: [p(1590, 640), p(1550, 655)], restingExpression: "focused" },
  { id: "floor-strategy", role: "strategy", home: "tradingFloor", wander: [p(1225, 830), p(1265, 845)], restingExpression: "focused" },
  { id: "floor-exec", role: "execution", home: "tradingFloor", wander: [p(1635, 830), p(1595, 845)], restingExpression: "focused" },
  { id: "floor-monitor", role: "operations", home: "tradingFloor", wander: [p(1370, 935), p(1410, 950)], restingExpression: "neutral" },
  { id: "floor-recon", role: "reconciliation", home: "tradingFloor", wander: [p(1490, 935), p(1450, 950)], restingExpression: "neutral" },

  // MCP & provider district (4)
  { id: "hub-keeper", role: "operations", home: "mcpHub", wander: [p(2160, 530), p(2220, 530), p(2190, 555)], restingExpression: "focused" },
  { id: "schema-librarian", role: "operations", home: "toolSchemas", wander: [p(2370, 690), p(2420, 700), p(2392, 678)], restingExpression: "neutral" },
  { id: "adapter-op", role: "operations", home: "adapterBay", wander: [p(2470, 520), p(2510, 515), p(2488, 532)], restingExpression: "focused" },
  { id: "health-watcher", role: "analysis", home: "mcpHealth", wander: [p(2090, 795), p(2140, 800), p(2112, 782)], restingExpression: "neutral" },

  // Risk & execution district (5)
  { id: "approval-clerk", role: "operations", home: "approval", wander: [p(1700, 965), p(1750, 975)], restingExpression: "neutral" },
  { id: "permission-keeper", role: "risk", home: "permission", wander: [p(1880, 995), p(1930, 1000)], restingExpression: "focused" },
  { id: "risk-scanner", role: "risk", home: "riskFortress", wander: [p(2110, 1105), p(2170, 1115), p(2140, 1088), p(2210, 1135)], restingExpression: "focused" },
  { id: "vault-keeper", role: "execution", home: "signerVault", wander: [p(2415, 1025), p(2455, 1030)], restingExpression: "focused" },
  { id: "gateway-op", role: "execution", home: "executionGateway", wander: [p(2462, 1180), p(2505, 1185)], restingExpression: "focused" },

  // State, audit & operations district (6)
  { id: "recon-1", role: "reconciliation", home: "reconciliationDock", wander: [p(530, 1285), p(590, 1295), p(558, 1272), p(625, 1278)], restingExpression: "focused" },
  { id: "receipt-clerk", role: "operations", home: "receiptPrinter", wander: [p(795, 1252), p(838, 1258)], restingExpression: "neutral" },
  { id: "archivist", role: "operations", home: "auditArchive", wander: [p(1030, 1320), p(1100, 1325), p(1062, 1305)], restingExpression: "neutral" },
  { id: "recovery-1", role: "reconciliation", home: "recoveryWorkshop", wander: [p(395, 1372), p(450, 1378), p(420, 1358)], restingExpression: "worried" },
  { id: "observer-1", role: "operations", home: "observability", wander: [p(1140, 1052), p(1190, 1058), p(1162, 1040)], restingExpression: "focused" },
  { id: "replay-op", role: "analysis", home: "replayChamber", wander: [p(1258, 1190), p(1295, 1195)], restingExpression: "curious" },
];

export const AGENT_COUNT = POPULATION.length;
