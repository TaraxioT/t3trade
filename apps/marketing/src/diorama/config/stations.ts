/**
 * Station registry: the master layout of the T3 Trade diorama room in
 * 2816 x 1536 world units. Every builder, rail, agent path, and interaction
 * target keys off these ids and anchors. Coordinates are ground-level
 * footprint centers.
 *
 * Reading order: one square cutaway room in three sections. The west
 * RESEARCH & AGENTS section holds the research row along the west wall and
 * the MCP tool row in the south-west wedge. The CENTRAL TRADING FLOOR holds
 * the tiered dais, the market holo, and the Hyperliquid testnet exchange
 * booth docked at its east seam. The east GUARDED EXECUTION &
 * RECONCILIATION section runs the approval-to-signer flow along the
 * back-right wall, then the state and reconciliation cluster across the
 * south band. Emergency control sits beside Approval at the center seam.
 *
 * Copy rules: one sentence, no em/en dashes, sentence case for descriptions,
 * uppercase only for sign text.
 */

export type DistrictId = "research" | "floor" | "risk";

export interface DistrictDef {
  id: DistrictId;
  /** Banner text (uppercase rendered). */
  title: string;
  /** Approximate district center for the banner and district focus. */
  center: { x: number; y: number };
  /** Bounding box used for platform drawing and focus fit. */
  bounds: { x1: number; y1: number; x2: number; y2: number };
  accent: number;
  /** Subordinate warm or cool counter-accent that keeps the district off
   * the shared cyan so districts separate by material and value, not hue alone. */
  accent2: number;
  /** One-sentence description for the info card / a11y. */
  blurb: string;
}

export const DISTRICTS: Record<DistrictId, DistrictDef> = {
  research: {
    id: "research",
    title: "RESEARCH & AGENTS",
    center: { x: 634, y: 768 },
    bounds: { x1: 148, y1: 138, x2: 1120, y2: 1398 },
    accent: 0x34e5e5,
    accent2: 0x9a70ff,
    blurb:
      "Research mode pairs native agents with the t3-trade MCP endpoint to study markets, run backtests, and validate ideas without a signer.",
  },
  floor: {
    id: "floor",
    title: "CENTRAL TRADING FLOOR",
    center: { x: 1435, y: 768 },
    bounds: { x1: 1120, y1: 138, x2: 1750, y2: 1398 },
    accent: 0x5a7cff,
    accent2: 0xffd35a,
    blurb:
      "The coordination heart where watchlist, positions, alerts, and charts meet around the holographic market display.",
  },
  risk: {
    id: "risk",
    title: "GUARDED EXECUTION & RECONCILIATION",
    center: { x: 2209, y: 768 },
    bounds: { x1: 1750, y1: 138, x2: 2668, y2: 1398 },
    accent: 0xffd35a,
    accent2: 0x56f2c2,
    blurb:
      "Guarded manual execution moves through approval, loss budget, protection, and the signer, while event-sourced state converges through reconciliation.",
  },
};

export type StationId =
  // West section: research row (research district)
  | "marketLandscape"
  | "researchOnlyGate"
  | "marketData"
  | "researchTools"
  | "strategyLab"
  | "liquidityResearch"
  | "missionBoard"
  | "sandbox"
  | "budgetPlanning"
  | "decisionTable"
  // West section: MCP tool row (research district)
  | "mcpHub"
  | "toolSchemas"
  | "adapterBay"
  | "mcpHealth"
  | "envSwitchboard"
  | "portfolioTools"
  // Central trading floor
  | "tradingFloor"
  | "holoCore"
  | "eventClock"
  | "signalTower"
  | "statusMast"
  | "hyperliquidVenue"
  // East section: guarded execution flow (risk district)
  | "approval"
  | "emergencyPanel"
  | "permission"
  | "budgetMeter"
  | "riskFortress"
  | "protection"
  | "signerVault"
  | "executionGateway"
  // East section: state and reconciliation cluster (risk district)
  | "stateStore"
  | "railYard"
  | "reconciliationDock"
  | "receiptPrinter"
  | "auditArchive"
  | "replayChamber"
  | "recoveryWorkshop"
  | "observability"
  | "activityGallery"
  | "portfolioVault"
  | "identityGate"
  | "refusalDisplay";

export interface StationDef {
  id: StationId;
  district: DistrictId;
  /** Uppercase sign text; empty for sub-fixtures that carry no sign. */
  label: string;
  /** Sign size class for core/signs.ts. */
  signSize: "sm" | "md" | "lg";
  /** Ground-level footprint center. */
  anchor: { x: number; y: number };
  /** Approximate footprint for hit areas and camera fit. */
  size: { w: number; d: number };
  /** One-sentence explanation for the info card. */
  blurb: string;
  /** Initial simulated status shown on the info card. */
  status: string;
  /** One key relationship, e.g. "Strategy → Risk → Execution". */
  relation?: string;
  /** Camera zoom multiplier when focused (default 1). */
  focusZoom?: number;
  /** Micro-story the info-card action button runs (STORIES id). */
  story?: string;
  /** Info-card action label; omit on stations without a safe demo story. */
  action?: string;
}

const S = (def: StationDef): StationDef => def;

export const STATIONS: Record<StationId, StationDef> = {
  marketLandscape: S({
    id: "marketLandscape",
    district: "research",
    label: "MARKET LANDSCAPE",
    signSize: "sm",
    anchor: { x: 872, y: 464 },
    size: { w: 540, d: 260 },
    blurb:
      "A living terrain of market regimes: calm, rising, falling, and turbulent, with probes extracting simulated data packets.",
    status: "Rising regime",
    relation: "Landscape → Market Data → Strategy",
    story: "s-research-synthesis",
    action: "Run a probe",
  }),
  researchOnlyGate: S({
    id: "researchOnlyGate",
    district: "research",
    label: "RESEARCH ONLY",
    signSize: "md",
    anchor: { x: 540, y: 635 },
    size: { w: 130, d: 110 },
    blurb:
      "An entrance to charts, alerts, backtests, and simulations that never requires a signer or grants exposure.",
    status: "Open",
    story: "s-sandbox-test",
    action: "Run a research sim",
  }),
  marketData: S({
    id: "marketData",
    district: "research",
    label: "MARKET DATA",
    signSize: "md",
    anchor: { x: 790, y: 570 },
    size: { w: 185, d: 115 },
    blurb: "Price, order book, funding, and volatility screens fed by the probes above.",
    status: "Streaming",
    relation: "Landscape → Market Data → Strategy Lab",
    story: "s-research-synthesis",
    action: "Pull data",
  }),
  researchTools: S({
    id: "researchTools",
    district: "research",
    label: "RESEARCH TOOLS",
    signSize: "md",
    anchor: { x: 950, y: 490 },
    size: { w: 180, d: 110 },
    blurb: "News, token research, protocol research, and historical comparison stations.",
    status: "Operational",
    story: "s-research-synthesis",
    action: "Fetch research",
  }),
  strategyLab: S({
    id: "strategyLab",
    district: "research",
    label: "STRATEGY LAB",
    signSize: "md",
    anchor: { x: 1075, y: 425 },
    size: { w: 190, d: 140 },
    blurb: "Where analysis becomes strategy: candidate plays, backtests, and mission drafts.",
    status: "Operational",
    relation: "Strategy Lab → Decision Table",
    story: "s-research-synthesis",
    action: "Run synthesis",
  }),
  liquidityResearch: S({
    id: "liquidityResearch",
    district: "research",
    label: "LIQUIDITY RESEARCH",
    signSize: "md",
    anchor: { x: 730, y: 760 },
    size: { w: 225, d: 150 },
    blurb:
      "A liquidity research concept: pool depth and quote paths compared on a constant-product curve model, unconnected and not an execution venue.",
    status: "Concept model",
    relation: "Research concept → Strategy",
    story: "s-venue-greet",
    action: "Compare quotes",
  }),
  missionBoard: S({
    id: "missionBoard",
    district: "research",
    label: "MISSION BOARD",
    signSize: "md",
    anchor: { x: 540, y: 870 },
    size: { w: 195, d: 120 },
    blurb:
      "Active goals, phase, loss budget, and scheduled wakes; agents visit it whenever a mission changes phase.",
    status: "Phase: waiting",
    relation: "Mission Board → Signal Tower",
    story: "s-research-synthesis",
    action: "Advance phase",
  }),
  sandbox: S({
    id: "sandbox",
    district: "research",
    label: "SANDBOX",
    signSize: "md",
    anchor: { x: 370, y: 780 },
    size: { w: 195, d: 130 },
    blurb: "Strategies are tested here without ever needing a signer or increasing exposure.",
    status: "Simulating",
    story: "s-sandbox-test",
    action: "Run simulation",
  }),
  budgetPlanning: S({
    id: "budgetPlanning",
    district: "research",
    label: "BUDGET PLAN",
    signSize: "sm",
    anchor: { x: 990, y: 945 },
    size: { w: 150, d: 95 },
    blurb: "Planned capital and loss allowance for the active mission, before any approval.",
    status: "Planning",
  }),
  decisionTable: S({
    id: "decisionTable",
    district: "research",
    label: "DECISION TABLE",
    signSize: "md",
    anchor: { x: 675, y: 950 },
    size: { w: 195, d: 130 },
    blurb:
      "Candidate hypotheses and backtests are compared with evidence and risk; a validated one becomes the mission plan.",
    status: "Reviewing",
    relation: "Decision → Approval → Risk → Execution",
    story: "s-proposals-appear",
    action: "Compare proposals",
  }),

  mcpHub: S({
    id: "mcpHub",
    district: "research",
    label: "MCP TOOL HUB",
    signSize: "lg",
    anchor: { x: 850, y: 1000 },
    size: { w: 250, d: 185 },
    blurb:
      "A circular interchange of glowing ports: agents request tools here and receive typed results.",
    status: "Operational",
    focusZoom: 1.35,
    relation: "Agents → MCP Hub → Tools",
    story: "s-tool-refusal",
    action: "Demo a tool call",
  }),
  toolSchemas: S({
    id: "toolSchemas",
    district: "research",
    label: "TOOL SCHEMAS",
    signSize: "sm",
    anchor: { x: 1010, y: 1035 },
    size: { w: 155, d: 95 },
    blurb:
      "Illuminated drawers of inputs, outputs, capabilities, and failure conditions; agents pull a schema card before calling.",
    status: "Operational",
    story: "s-drop-cards",
    action: "Fetch schema cards",
  }),
  adapterBay: S({
    id: "adapterBay",
    district: "research",
    label: "ADAPTER BAY",
    signSize: "sm",
    anchor: { x: 1092, y: 1075 },
    size: { w: 115, d: 105 },
    blurb:
      "Provider adapters translate Codex, Claude, Cursor, Grok, OpenCode, and custom instances into one shared shape: adapters, never authorities.",
    status: "Translating",
    story: "s-tool-refusal",
    action: "Translate a packet",
  }),
  mcpHealth: S({
    id: "mcpHealth",
    district: "research",
    label: "MCP HEALTH",
    signSize: "sm",
    anchor: { x: 950, y: 1100 },
    size: { w: 130, d: 80 },
    blurb:
      "Availability, latency, authentication, and rate limits per tool port, green to amber to red.",
    status: "All ports green",
    story: "s-mcp-degraded",
    action: "Degrade a port",
  }),
  envSwitchboard: S({
    id: "envSwitchboard",
    district: "research",
    label: "ENVIRONMENTS",
    signSize: "sm",
    anchor: { x: 1075, y: 1160 },
    size: { w: 140, d: 80 },
    blurb:
      "Research mode, testnet-only exchange, and signer availability; environments never share authority.",
    status: "Testnet connected",
  }),
  portfolioTools: S({
    id: "portfolioTools",
    district: "research",
    label: "PORTFOLIO TOOLS",
    signSize: "sm",
    anchor: { x: 735, y: 900 },
    size: { w: 145, d: 85 },
    blurb: "Balances, positions, orders, fills, exposure, and performance panels.",
    status: "Operational",
  }),

  tradingFloor: S({
    id: "tradingFloor",
    district: "floor",
    label: "TRADING FLOOR",
    signSize: "lg",
    anchor: { x: 1435, y: 845 },
    size: { w: 540, d: 390 },
    blurb:
      "The coordination heart: agent workstations ring a holographic market display with positions, orders, and health.",
    status: "Coordinating",
    focusZoom: 1.25,
    relation: "Floor → MCP Tool Hub / Approval",
    story: "s-floor-handoff",
    action: "Run duty handoff",
  }),
  holoCore: S({
    id: "holoCore",
    district: "floor",
    label: "MARKET HOLO",
    signSize: "sm",
    anchor: { x: 1435, y: 705 },
    size: { w: 230, d: 140 },
    blurb:
      "Price movement, strategy cards, positions, orders, P&L, and system health in one hologram.",
    status: "Simulated",
    focusZoom: 1.5,
    story: "s-floor-signal",
    action: "Signal market event",
  }),
  eventClock: S({
    id: "eventClock",
    district: "floor",
    label: "EVENT CLOCK",
    signSize: "sm",
    anchor: { x: 1190, y: 480 },
    size: { w: 130, d: 110 },
    blurb:
      "Concentric rings track market time, agent activity, order lifecycle, and scheduled wakes.",
    status: "Ticking",
    focusZoom: 1.4,
  }),
  signalTower: S({
    id: "signalTower",
    district: "floor",
    label: "SIGNAL TOWER",
    signSize: "sm",
    anchor: { x: 1620, y: 390 },
    size: { w: 90, d: 90 },
    blurb:
      "Distinct pulses for market events, alerts, agent wakes, warnings, and execution updates.",
    status: "Standby",
    focusZoom: 1.4,
    story: "s-alert-wake",
    action: "Pulse an alert",
  }),
  statusMast: S({
    id: "statusMast",
    district: "floor",
    label: "STATUS",
    signSize: "sm",
    anchor: { x: 1170, y: 1000 },
    size: { w: 90, d: 70 },
    blurb: "Room-wide lighting master: green healthy, cyan working, amber degraded, red blocked.",
    status: "All healthy",
  }),
  hyperliquidVenue: S({
    id: "hyperliquidVenue",
    district: "floor",
    label: "HYPERLIQUID TESTNET",
    signSize: "md",
    anchor: { x: 1810, y: 500 },
    size: { w: 240, d: 170 },
    blurb:
      "The Hyperliquid testnet booth docked into the Central Trading Floor, authoritative for positions, orders, and fills, and T3 Trade's sole current execution venue.",
    status: "Simulated feed",
    focusZoom: 1.45,
    relation: "Execution → Hyperliquid → Reconciliation",
  }),

  approval: S({
    id: "approval",
    district: "risk",
    label: "APPROVAL",
    signSize: "md",
    anchor: { x: 1800, y: 760 },
    size: { w: 165, d: 115 },
    blurb:
      "Where the human's authority binds: permission modes decide what runs alone and what stops here to ask.",
    status: "Queue: 1",
    focusZoom: 1.35,
    relation: "Decision → Approval → Permissions",
    story: "s-proposal-needs-human",
    action: "Request approval",
  }),
  emergencyPanel: S({
    id: "emergencyPanel",
    district: "risk",
    label: "EMERGENCY CONTROL",
    signSize: "sm",
    anchor: { x: 1775, y: 850 },
    size: { w: 95, d: 70 },
    blurb: "Emergency stop and pause drill beside Approval, working even with the agent provider down.",
    status: "Armed",
    focusZoom: 1.4,
    relation: "Human controls outrank every agent",
    story: "s-emergency-demo",
    action: "Test pause",
  }),
  permission: S({
    id: "permission",
    district: "risk",
    label: "PERMISSIONS",
    signSize: "md",
    anchor: { x: 2000, y: 560 },
    size: { w: 175, d: 125 },
    blurb: "A lock of glowing capability tokens answers whether this agent may use this tool now.",
    status: "Verifying",
    story: "s-permission-verify",
    action: "Verify capability",
  }),
  budgetMeter: S({
    id: "budgetMeter",
    district: "risk",
    label: "LOSS BUDGET",
    signSize: "sm",
    anchor: { x: 2220, y: 620 },
    size: { w: 145, d: 105 },
    blurb:
      "Maximum-loss budget, risk reservations, and the remaining allowance every trade draws down.",
    status: "Loss allowance 82%",
    story: "s-budget-consume",
    action: "Draw down budget",
  }),
  riskFortress: S({
    id: "riskFortress",
    district: "risk",
    label: "RISK",
    signSize: "lg",
    anchor: { x: 2190, y: 800 },
    size: { w: 250, d: 180 },
    blurb:
      "An open fortress of scanning arches for loss budgets, position limits, leverage, and exposure caps; invalid trades stop at the arch they fail.",
    status: "Scanning",
    focusZoom: 1.3,
    relation: "Approval → Risk → Signer",
    story: "s-risk-pass",
    action: "Run a risk scan",
  }),
  protection: S({
    id: "protection",
    district: "risk",
    label: "PROTECTION",
    signSize: "sm",
    anchor: { x: 1980, y: 780 },
    size: { w: 140, d: 100 },
    blurb: "Exchange-native reduce-only stop protection wraps every confirmed position increase.",
    status: "Shielding",
    story: "s-protection-attach",
    action: "Attach protection",
  }),
  signerVault: S({
    id: "signerVault",
    district: "risk",
    label: "SIGNER VAULT",
    signSize: "md",
    anchor: { x: 2395, y: 765 },
    size: { w: 145, d: 125 },
    blurb:
      "An isolated cutaway chamber where orders receive a signing pulse; the key itself never leaves the vault.",
    status: "Sealed",
    focusZoom: 1.4,
    relation: "Risk → Signer → Execution",
    story: "s-signer-pulse",
    action: "Show local signing",
  }),
  executionGateway: S({
    id: "executionGateway",
    district: "risk",
    label: "EXECUTION",
    signSize: "md",
    anchor: { x: 1930, y: 660 },
    size: { w: 145, d: 110 },
    blurb:
      "A guarded terminal that turns authorized decisions into order capsules bound for the docked exchange.",
    status: "Idle",
    focusZoom: 1.35,
    relation: "Execution → Hyperliquid Testnet",
    story: "s-execute-order",
    action: "Demo the order path",
  }),

  stateStore: S({
    id: "stateStore",
    district: "risk",
    label: "STATE STORE",
    signSize: "sm",
    anchor: { x: 1945, y: 485 },
    size: { w: 165, d: 115 },
    blurb: "Glowing cartridges of missions, durable decisions, account state, and read models.",
    status: "Persisting",
  }),
  railYard: S({
    id: "railYard",
    district: "risk",
    label: "EVENT BUS",
    signSize: "sm",
    anchor: { x: 1850, y: 980 },
    size: { w: 170, d: 95 },
    blurb:
      "The junction where command, event, proposal, order, and receipt packets sort onto rails.",
    status: "Routing",
  }),
  reconciliationDock: S({
    id: "reconciliationDock",
    district: "risk",
    label: "RECONCILIATION",
    signSize: "md",
    anchor: { x: 1700, y: 1120 },
    size: { w: 210, d: 135 },
    blurb:
      "Local expected state and the exchange's authoritative state arrive as two streams; agreement flashes green, drift summons recovery.",
    status: "Aligned",
    focusZoom: 1.3,
    relation: "Exchange → Reconciliation → Portfolio",
    story: "s-reconcile",
    action: "Reconcile state",
  }),
  receiptPrinter: S({
    id: "receiptPrinter",
    district: "risk",
    label: "RECEIPTS",
    signSize: "sm",
    anchor: { x: 1795, y: 1065 },
    size: { w: 120, d: 85 },
    blurb:
      "Prints an illuminated receipt for every tool call, decision, order, result, and refusal.",
    status: "Printing",
    story: "s-receipt-print",
    action: "Print a receipt",
  }),
  auditArchive: S({
    id: "auditArchive",
    district: "risk",
    label: "AUDIT",
    signSize: "md",
    anchor: { x: 1865, y: 1085 },
    size: { w: 190, d: 115 },
    blurb: "A wall of drawers holding proposals, approvals, transactions, reasoning, and failures.",
    status: "Archiving",
    story: "s-audit-store",
    action: "Archive a receipt",
  }),
  replayChamber: S({
    id: "replayChamber",
    district: "risk",
    label: "REPLAY",
    signSize: "sm",
    anchor: { x: 1865, y: 880 },
    size: { w: 115, d: 95 },
    blurb: "An archived receipt becomes a translucent reconstruction of the original event.",
    status: "Ready",
    story: "s-audit-store",
    action: "Replay a receipt",
  }),
  recoveryWorkshop: S({
    id: "recoveryWorkshop",
    district: "risk",
    label: "RECOVERY",
    signSize: "sm",
    anchor: { x: 1598, y: 1182 },
    size: { w: 170, d: 105 },
    blurb:
      "Retries, partial failures, stale orders, and reconnection repairs with spare order capsules.",
    status: "On standby",
    story: "s-recovery-retry",
    action: "Dispatch recovery",
  }),
  observability: S({
    id: "observability",
    district: "risk",
    label: "OBSERVABILITY",
    signSize: "sm",
    anchor: { x: 2090, y: 980 },
    size: { w: 155, d: 95 },
    blurb: "Logs, metrics, traces, latency, worker health, and incidents as moving light traces.",
    status: "Watching",
  }),
  activityGallery: S({
    id: "activityGallery",
    district: "risk",
    label: "USER ACTIVITY",
    signSize: "sm",
    anchor: { x: 1725, y: 1015 },
    size: { w: 155, d: 80 },
    blurb:
      "A chronological wall of the human's approvals, overrides, pauses, reductions, and closes.",
    status: "3 recent actions",
  }),
  portfolioVault: S({
    id: "portfolioVault",
    district: "risk",
    label: "PORTFOLIO",
    signSize: "md",
    anchor: { x: 1975, y: 910 },
    size: { w: 145, d: 105 },
    blurb:
      "A transparent vault of account-state capsules: capital, balances, realized and unrealized results.",
    status: "Updating",
    story: "s-fill-vault",
    action: "Update on a fill",
  }),
  identityGate: S({
    id: "identityGate",
    district: "risk",
    label: "IDENTITY & ACCESS",
    signSize: "sm",
    anchor: { x: 2220, y: 910 },
    size: { w: 140, d: 90 },
    blurb:
      "Badges for users, agents, sessions, and roles; requests without permission are physically turned away.",
    status: "Checking",
  }),
  refusalDisplay: S({
    id: "refusalDisplay",
    district: "risk",
    label: "REFUSALS",
    signSize: "sm",
    anchor: { x: 1985, y: 1040 },
    size: { w: 120, d: 70 },
    blurb:
      "Loss budget spent, protection failure, wake budget exhausted: refusals are normal system states, shown and archived.",
    status: "Last: loss budget spent",
    story: "s-tool-refusal",
    action: "Show a refusal",
  }),
};

/**
 * Ordered list for a11y listing and keyboard exploration. Key order is the
 * room reading order: west research row, west MCP tool row, central trading
 * floor, east guarded-execution flow, then the east state cluster.
 */
export const STATION_ORDER: StationId[] = Object.keys(STATIONS) as StationId[];
