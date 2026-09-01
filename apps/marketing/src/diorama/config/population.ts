/**
 * Agent roster: exactly eight background utility robots, four per side room
 * (freeze cycle-4 §6). The central trading floor carries zero population.
 * Roles color small accessories (backpack, antenna, screen) only, never the
 * whole body. Homes are surviving stations; wander paths are short authored
 * loops hugging the home section so agents visibly travel with purpose
 * between story tasks instead of freezing at desks.
 *
 * Containment contract (asserted by the artifacts containment sweep): every
 * home and wander point passes config/geometry.ts insideRoom and its own
 * district's section polygon, and no point lies inside the center floor
 * polygon. Points may rest on their own station's apron (the "tending the
 * desk" read); per-point clearance against other stations' footprints is
 * documented in artifacts/diorama/dio4/lane-life.md.
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
  // West section: research district (4). Loops stay west of x=1120, so none
  // can reach the center section.
  {
    id: "research-1",
    role: "research",
    home: "researchTools",
    variant: 0.55,
    // South apron of the research bench.
    wander: [p(905, 515), p(955, 530), p(1005, 500), p(960, 470)],
    restingExpression: "curious",
  },
  {
    id: "strategy-1",
    role: "strategy",
    home: "decisionTable",
    variant: 0.78,
    // Kept north/west of the table: it sits close to the south-west taper.
    wander: [p(645, 955), p(700, 968), p(748, 990), p(695, 1000)],
    restingExpression: "focused",
  },
  {
    id: "hub-keeper",
    role: "operations",
    home: "mcpHub",
    variant: 0.19,
    // North and west aprons of the tool hub.
    wander: [p(775, 925), p(855, 915), p(925, 940), p(700, 975)],
    restingExpression: "focused",
  },
  {
    id: "sandbox-1",
    role: "research",
    home: "marketData",
    variant: 0.93,
    // Tight ring on the watchlist's south apron, clear of the desk diamond.
    wander: [p(760, 640), p(800, 610), p(860, 620), p(820, 655)],
    restingExpression: "curious",
  },

  // East section: risk district (4). All points sit east of the authority
  // seam polyline (1750,309)-(1750,950)-(1520,1340).
  {
    id: "risk-scanner",
    role: "risk",
    home: "riskFortress",
    variant: 0.89,
    // North apron of the scanning fortress.
    wander: [p(2130, 735), p(2200, 745), p(2270, 770), p(2205, 715)],
    restingExpression: "focused",
  },
  {
    id: "vault-keeper",
    role: "execution",
    home: "signerVault",
    variant: 0.58,
    // North apron of the sealed vault chamber.
    wander: [p(2345, 700), p(2400, 715), p(2450, 740), p(2398, 690)],
    restingExpression: "focused",
  },
  {
    id: "gateway-op",
    role: "execution",
    home: "executionGateway",
    variant: 0.97,
    // Compact loop around the gateway terminal.
    wander: [p(1895, 640), p(1950, 625), p(1910, 600), p(1875, 630)],
    restingExpression: "focused",
  },
  {
    id: "recon-1",
    role: "reconciliation",
    home: "reconciliationDock",
    variant: 0.41,
    // Hugs the dock's north/east apron; easternmost points keep ≥21 u off the
    // floor/risk seam so no leg of the loop crosses into the center section.
    wander: [p(1712, 1050), p(1735, 1062), p(1775, 1095), p(1730, 1115)],
    restingExpression: "focused",
  },
];

export const AGENT_COUNT = POPULATION.length;
