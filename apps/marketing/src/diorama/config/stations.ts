/**
 * Station registry: the master layout of the diorama campus in 2816 x 1536
 * world units. Every builder, rail, agent path, and interaction target keys
 * off these ids and anchors. Coordinates are ground-level footprint centers.
 *
 * Reading order: upper-left research and planning, center trading floor,
 * right tools and providers, lower-right approval through execution inside
 * the safety perimeter, lower-left state, audit, and operations. The human
 * supervisor sits front-center on an elevated deck. Hyperliquid Testnet is
 * an external platform beyond the east perimeter edge.
 *
 * Copy rules: one sentence, no em/en dashes, sentence case for descriptions,
 * uppercase only for sign text.
 */

export type DistrictId = "research" | "floor" | "mcp" | "risk" | "ops" | "supervisor" | "external";

export interface DistrictDef {
  id: DistrictId;
  /** Banner text (uppercase rendered). */
  title: string;
  /** Approximate district center for the banner and district focus. */
  center: { x: number; y: number };
  /** Bounding box used for platform drawing and focus fit. */
  bounds: { x1: number; y1: number; x2: number; y2: number };
  accent: number;
  /** One-sentence description for the info card / a11y. */
  blurb: string;
}

export const DISTRICTS: Record<DistrictId, DistrictDef> = {
  research: {
    id: "research",
    title: "RESEARCH & STRATEGY",
    center: { x: 660, y: 400 },
    bounds: { x1: 200, y1: 150, x2: 1150, y2: 700 },
    accent: 0x34e5e5,
    blurb:
      "Agents research markets, run simulations, and shape strategies without touching trading authority.",
  },
  floor: {
    id: "floor",
    title: "CENTRAL TRADING FLOOR",
    center: { x: 1430, y: 730 },
    bounds: { x1: 980, y1: 450, x2: 1880, y2: 1050 },
    accent: 0x5a7cff,
    blurb:
      "The coordination heart where agent workstations surround a holographic market display.",
  },
  mcp: {
    id: "mcp",
    title: "MCP & PROVIDERS",
    center: { x: 2190, y: 500 },
    bounds: { x1: 1800, y1: 180, x2: 2580, y2: 820 },
    accent: 0x9a70ff,
    blurb:
      "Capabilities arrive through the MCP tool hub, schema library, and provider-neutral adapter booths.",
  },
  risk: {
    id: "risk",
    title: "RISK & EXECUTION",
    center: { x: 2140, y: 1080 },
    bounds: { x1: 1650, y1: 790, x2: 2600, y2: 1380 },
    accent: 0xffd35a,
    blurb:
      "Inside the safety perimeter, decisions pass approval, permissions, budget, and risk arches before signing and execution.",
  },
  ops: {
    id: "ops",
    title: "STATE, AUDIT & OPERATIONS",
    center: { x: 870, y: 1180 },
    bounds: { x1: 250, y1: 900, x2: 1550, y2: 1420 },
    accent: 0x56f2c2,
    blurb:
      "Every action lands as state, receipts, reconciliation, audit, and recoverable history.",
  },
  supervisor: {
    id: "supervisor",
    title: "HUMAN AUTHORITY",
    center: { x: 1470, y: 1180 },
    bounds: { x1: 1310, y1: 1100, x2: 1650, y2: 1300 },
    accent: 0xff9f45,
    blurb: "The human supervisor holds the controls that outrank every autonomous agent.",
  },
  external: {
    id: "external",
    title: "HYPERLIQUID TESTNET",
    center: { x: 2700, y: 1080 },
    bounds: { x1: 2590, y1: 940, x2: 2806, y2: 1250 },
    accent: 0x56f2c2,
    blurb: "The external exchange, authoritative for positions, orders, and fills.",
  },
};

export type StationId =
  // Research & strategy district
  | "marketLandscape"
  | "missionBoard"
  | "marketData"
  | "researchTools"
  | "strategyLab"
  | "sandbox"
  | "budgetPlanning"
  | "decisionTable"
  // Central trading floor
  | "tradingFloor"
  | "holoCore"
  | "signalTower"
  | "eventClock"
  | "statusMast"
  | "supervisor"
  | "emergencyPanel"
  // MCP & provider district
  | "mcpHub"
  | "marketDataTools"
  | "researchToolsMcp"
  | "portfolioTools"
  | "toolSchemas"
  | "adapterBay"
  | "providers"
  | "mcpHealth"
  | "envSwitchboard"
  // Risk & execution district
  | "approval"
  | "permission"
  | "budgetMeter"
  | "riskFortress"
  | "protection"
  | "signerVault"
  | "executionGateway"
  // State, audit & operations district
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
  // Gates
  | "identityGate"
  | "refusalDisplay"
  | "researchOnlyGate";

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
}

const S = (def: StationDef): StationDef => def;

export const STATIONS: Record<StationId, StationDef> = {
  marketLandscape: S({
    id: "marketLandscape",
    district: "research",
    label: "MARKET LANDSCAPE",
    signSize: "sm",
    anchor: { x: 660, y: 185 },
    size: { w: 860, d: 150 },
    blurb:
      "A living terrain of market regimes: calm, rising, falling, and turbulent, with probes extracting live data packets.",
    status: "Rising regime",
    relation: "Landscape → Market Data → Strategy",
  }),
  missionBoard: S({
    id: "missionBoard",
    district: "research",
    label: "MISSION BOARD",
    signSize: "md",
    anchor: { x: 330, y: 330 },
    size: { w: 220, d: 130 },
    blurb:
      "Active goals, phase, loss allocation, and scheduled wakes; agents visit it whenever a mission changes phase.",
    status: "Phase: monitoring",
    relation: "Mission Board → Signal Tower",
  }),
  marketData: S({
    id: "marketData",
    district: "research",
    label: "MARKET DATA",
    signSize: "md",
    anchor: { x: 590, y: 320 },
    size: { w: 200, d: 120 },
    blurb: "Price, order book, funding, and volatility screens fed by the probes above.",
    status: "Streaming",
    relation: "Landscape → Market Data → Strategy Lab",
  }),
  researchTools: S({
    id: "researchTools",
    district: "research",
    label: "RESEARCH TOOLS",
    signSize: "md",
    anchor: { x: 820, y: 300 },
    size: { w: 200, d: 120 },
    blurb: "News, token research, protocol research, and historical comparison stations.",
    status: "Operational",
  }),
  strategyLab: S({
    id: "strategyLab",
    district: "research",
    label: "STRATEGY LAB",
    signSize: "md",
    anchor: { x: 980, y: 400 },
    size: { w: 240, d: 150 },
    blurb: "Where analysis becomes strategy: candidate plays, backtests, and mission drafts.",
    status: "Operational",
    relation: "Strategy Lab → Decision Table",
  }),
  sandbox: S({
    id: "sandbox",
    district: "research",
    label: "SANDBOX",
    signSize: "md",
    anchor: { x: 330, y: 545 },
    size: { w: 220, d: 140 },
    blurb:
      "Strategies are tested here without ever crossing the exposure perimeter or needing a signer.",
    status: "Simulating",
  }),
  budgetPlanning: S({
    id: "budgetPlanning",
    district: "research",
    label: "BUDGET PLAN",
    signSize: "sm",
    anchor: { x: 760, y: 505 },
    size: { w: 150, d: 90 },
    blurb: "Planned capital and loss allowance for the active mission, before any approval.",
    status: "Planning",
  }),
  decisionTable: S({
    id: "decisionTable",
    district: "research",
    label: "DECISION TABLE",
    signSize: "md",
    anchor: { x: 1010, y: 625 },
    size: { w: 220, d: 140 },
    blurb:
      "Proposals with evidence, confidence, return, and risk are compared; one is chosen and the rest retract.",
    status: "Reviewing",
    relation: "Decision → Approval → Risk → Execution",
  }),

  tradingFloor: S({
    id: "tradingFloor",
    district: "floor",
    label: "TRADING FLOOR",
    signSize: "lg",
    anchor: { x: 1430, y: 740 },
    size: { w: 700, d: 480 },
    blurb:
      "The coordination heart: agent workstations ring a holographic market display with positions, orders, and health.",
    status: "Coordinating",
    focusZoom: 1.15,
    relation: "Floor → MCP Tool Hub / Approval",
  }),
  holoCore: S({
    id: "holoCore",
    district: "floor",
    label: "MARKET HOLO",
    signSize: "sm",
    anchor: { x: 1430, y: 665 },
    size: { w: 260, d: 150 },
    blurb: "Price movement, strategy cards, positions, orders, P&L, and system health in one hologram.",
    status: "Live",
    focusZoom: 1.5,
  }),
  signalTower: S({
    id: "signalTower",
    district: "floor",
    label: "SIGNAL TOWER",
    signSize: "sm",
    anchor: { x: 1855, y: 545 },
    size: { w: 90, d: 90 },
    blurb: "Distinct pulses for market events, alerts, agent wakes, warnings, and execution updates.",
    status: "Standby",
    focusZoom: 1.4,
  }),
  eventClock: S({
    id: "eventClock",
    district: "floor",
    label: "EVENT CLOCK",
    signSize: "sm",
    anchor: { x: 1075, y: 525 },
    size: { w: 130, d: 110 },
    blurb: "Concentric rings track market time, agent activity, order lifecycle, and scheduled wakes.",
    status: "Ticking",
    focusZoom: 1.4,
  }),
  statusMast: S({
    id: "statusMast",
    district: "floor",
    label: "STATUS",
    signSize: "sm",
    anchor: { x: 1255, y: 975 },
    size: { w: 90, d: 70 },
    blurb: "Campus-wide lighting master: green healthy, cyan working, amber degraded, red blocked.",
    status: "All healthy",
  }),
  supervisor: S({
    id: "supervisor",
    district: "supervisor",
    label: "HUMAN SUPERVISOR",
    signSize: "lg",
    anchor: { x: 1465, y: 1175 },
    size: { w: 260, d: 150 },
    blurb:
      "The owner's command desk: risk budget, mission controls, approval queue, pause, cancel, reduce, close, and revoke.",
    status: "Overseeing",
    focusZoom: 1.3,
    relation: "Supervisor → Approval → All agents",
  }),
  emergencyPanel: S({
    id: "emergencyPanel",
    district: "supervisor",
    label: "EMERGENCY CONTROL",
    signSize: "sm",
    anchor: { x: 1600, y: 1215 },
    size: { w: 110, d: 80 },
    blurb: "System-wide pause and emergency stop, physically beside the owner's desk.",
    status: "Armed",
    focusZoom: 1.4,
  }),

  mcpHub: S({
    id: "mcpHub",
    district: "mcp",
    label: "MCP TOOL HUB",
    signSize: "lg",
    anchor: { x: 2190, y: 505 },
    size: { w: 280, d: 200 },
    blurb:
      "A circular interchange of glowing ports: agents request tools here and receive typed results.",
    status: "Operational",
    focusZoom: 1.3,
    relation: "Agents → MCP Hub → Tools → Receipts",
  }),
  marketDataTools: S({
    id: "marketDataTools",
    district: "mcp",
    label: "MARKET DATA TOOLS",
    signSize: "sm",
    anchor: { x: 2030, y: 345 },
    size: { w: 170, d: 100 },
    blurb: "Mini consoles for prices, charts, order books, funding, liquidity, and volatility.",
    status: "Operational",
  }),
  researchToolsMcp: S({
    id: "researchToolsMcp",
    district: "mcp",
    label: "RESEARCH APIS",
    signSize: "sm",
    anchor: { x: 2360, y: 330 },
    size: { w: 170, d: 100 },
    blurb: "News, token, protocol, and historical data tool endpoints around the hub.",
    status: "Operational",
  }),
  portfolioTools: S({
    id: "portfolioTools",
    district: "mcp",
    label: "PORTFOLIO TOOLS",
    signSize: "sm",
    anchor: { x: 2025, y: 655 },
    size: { w: 170, d: 100 },
    blurb: "Balances, positions, orders, fills, exposure, and performance panels.",
    status: "Operational",
  }),
  toolSchemas: S({
    id: "toolSchemas",
    district: "mcp",
    label: "TOOL SCHEMAS",
    signSize: "sm",
    anchor: { x: 2395, y: 665 },
    size: { w: 180, d: 110 },
    blurb:
      "Illuminated drawers of inputs, outputs, capabilities, and failure conditions; agents pull a schema card before calling.",
    status: "Operational",
  }),
  adapterBay: S({
    id: "adapterBay",
    district: "mcp",
    label: "ADAPTER BAY",
    signSize: "sm",
    anchor: { x: 2490, y: 500 },
    size: { w: 130, d: 120 },
    blurb: "Physical translation machines: one standardized packet in, a provider-specific packet out.",
    status: "Translating",
  }),
  providers: S({
    id: "providers",
    district: "mcp",
    label: "PROVIDERS",
    signSize: "md",
    anchor: { x: 2300, y: 205 },
    size: { w: 460, d: 110 },
    blurb:
      "Codex, Claude, Cursor, Grok, OpenCode, and other provider booths share one shape: adapters, never authorities.",
    status: "Neutral",
    focusZoom: 1.2,
  }),
  mcpHealth: S({
    id: "mcpHealth",
    district: "mcp",
    label: "MCP HEALTH",
    signSize: "sm",
    anchor: { x: 2115, y: 775 },
    size: { w: 150, d: 90 },
    blurb: "Availability, latency, authentication, and rate limits per tool port, green to amber to red.",
    status: "All ports green",
  }),
  envSwitchboard: S({
    id: "envSwitchboard",
    district: "mcp",
    label: "ENVIRONMENTS",
    signSize: "sm",
    anchor: { x: 2315, y: 790 },
    size: { w: 160, d: 90 },
    blurb: "Research, Testnet, Connected, and Signer Available states; environments do not share authority.",
    status: "Testnet connected",
  }),

  approval: S({
    id: "approval",
    district: "risk",
    label: "APPROVAL",
    signSize: "md",
    anchor: { x: 1725, y: 945 },
    size: { w: 170, d: 120 },
    blurb:
      "Actions needing human authority or extra budget wait here: approved passes the perimeter, denied returns west.",
    status: "Queue: 1",
    focusZoom: 1.35,
    relation: "Decision → Approval → Permissions",
  }),
  permission: S({
    id: "permission",
    district: "risk",
    label: "PERMISSIONS",
    signSize: "md",
    anchor: { x: 1905, y: 975 },
    size: { w: 180, d: 130 },
    blurb: "A lock of glowing capability tokens answers whether this agent may use this tool now.",
    status: "Verifying",
  }),
  budgetMeter: S({
    id: "budgetMeter",
    district: "risk",
    label: "BUDGET",
    signSize: "sm",
    anchor: { x: 1905, y: 1165 },
    size: { w: 150, d: 110 },
    blurb: "Transparent reservoirs of capital, remaining loss allowance, tool spend, and authority.",
    status: "Loss allowance 82%",
  }),
  riskFortress: S({
    id: "riskFortress",
    district: "risk",
    label: "RISK",
    signSize: "lg",
    anchor: { x: 2150, y: 1075 },
    size: { w: 280, d: 200 },
    blurb:
      "An open fortress of scanning arches for loss budgets, position limits, leverage, and exposure caps; invalid trades stop at the arch they fail.",
    status: "Scanning",
    focusZoom: 1.3,
    relation: "Approval → Risk → Signer",
  }),
  protection: S({
    id: "protection",
    district: "risk",
    label: "PROTECTION",
    signSize: "sm",
    anchor: { x: 2310, y: 1250 },
    size: { w: 150, d: 110 },
    blurb: "Stop protection, liquidation buffer, and hedges wrap every position token before the gateway.",
    status: "Shielding",
  }),
  signerVault: S({
    id: "signerVault",
    district: "risk",
    label: "SIGNER VAULT",
    signSize: "md",
    anchor: { x: 2435, y: 1000 },
    size: { w: 160, d: 140 },
    blurb:
      "An isolated cutaway chamber where orders receive a signing pulse; the key itself never leaves the vault.",
    status: "Sealed",
    focusZoom: 1.4,
    relation: "Risk → Signer → Execution",
  }),
  executionGateway: S({
    id: "executionGateway",
    district: "risk",
    label: "EXECUTION",
    signSize: "md",
    anchor: { x: 2485, y: 1160 },
    size: { w: 170, d: 130 },
    blurb: "A guarded terminal that turns authorized decisions into order capsules on the exchange tunnel.",
    status: "Idle",
    focusZoom: 1.35,
    relation: "Execution → Hyperliquid Testnet",
  }),

  stateStore: S({
    id: "stateStore",
    district: "ops",
    label: "STATE STORE",
    signSize: "sm",
    anchor: { x: 430, y: 1010 },
    size: { w: 170, d: 120 },
    blurb: "Glowing cartridges of missions, durable decisions, account state, and read models.",
    status: "Persisting",
  }),
  railYard: S({
    id: "railYard",
    district: "ops",
    label: "EVENT BUS",
    signSize: "sm",
    anchor: { x: 720, y: 965 },
    size: { w: 200, d: 110 },
    blurb: "The junction where command, event, proposal, order, and receipt packets sort onto rails.",
    status: "Routing",
  }),
  reconciliationDock: S({
    id: "reconciliationDock",
    district: "ops",
    label: "RECONCILIATION",
    signSize: "md",
    anchor: { x: 560, y: 1265 },
    size: { w: 220, d: 140 },
    blurb:
      "Local expected state and the exchange's authoritative state arrive as two streams; agreement flashes green, drift summons recovery.",
    status: "Aligned",
    focusZoom: 1.3,
    relation: "Exchange → Reconciliation → Portfolio",
  }),
  receiptPrinter: S({
    id: "receiptPrinter",
    district: "ops",
    label: "RECEIPTS",
    signSize: "sm",
    anchor: { x: 815, y: 1235 },
    size: { w: 140, d: 100 },
    blurb: "Prints an illuminated receipt for every tool call, decision, order, result, and refusal.",
    status: "Printing",
  }),
  auditArchive: S({
    id: "auditArchive",
    district: "ops",
    label: "AUDIT",
    signSize: "md",
    anchor: { x: 1065, y: 1305 },
    size: { w: 220, d: 130 },
    blurb: "A wall of drawers holding proposals, approvals, transactions, reasoning, and failures.",
    status: "Archiving",
  }),
  replayChamber: S({
    id: "replayChamber",
    district: "ops",
    label: "REPLAY",
    signSize: "sm",
    anchor: { x: 1275, y: 1175 },
    size: { w: 130, d: 110 },
    blurb: "An archived receipt becomes a translucent reconstruction of the original event.",
    status: "Ready",
  }),
  recoveryWorkshop: S({
    id: "recoveryWorkshop",
    district: "ops",
    label: "RECOVERY",
    signSize: "sm",
    anchor: { x: 420, y: 1355 },
    size: { w: 200, d: 120 },
    blurb: "Retries, partial failures, stale orders, and reconnection repairs with spare order capsules.",
    status: "On standby",
  }),
  observability: S({
    id: "observability",
    district: "ops",
    label: "OBSERVABILITY",
    signSize: "sm",
    anchor: { x: 1165, y: 1035 },
    size: { w: 180, d: 110 },
    blurb: "Logs, metrics, traces, latency, worker health, and incidents as moving light traces.",
    status: "Watching",
  }),
  activityGallery: S({
    id: "activityGallery",
    district: "ops",
    label: "USER ACTIVITY",
    signSize: "sm",
    anchor: { x: 1340, y: 1390 },
    size: { w: 180, d: 90 },
    blurb: "A chronological wall of the human's approvals, overrides, pauses, reductions, and closes.",
    status: "3 recent actions",
  }),
  portfolioVault: S({
    id: "portfolioVault",
    district: "ops",
    label: "PORTFOLIO",
    signSize: "md",
    anchor: { x: 940, y: 1125 },
    size: { w: 170, d: 120 },
    blurb: "A transparent vault of account-state capsules: capital, balances, realized and unrealized results.",
    status: "Updating",
  }),
  identityGate: S({
    id: "identityGate",
    district: "ops",
    label: "IDENTITY & ACCESS",
    signSize: "sm",
    anchor: { x: 950, y: 1330 },
    size: { w: 160, d: 100 },
    blurb: "Badges for users, agents, sessions, and roles; requests without permission are physically turned away.",
    status: "Checking",
  }),
  refusalDisplay: S({
    id: "refusalDisplay",
    district: "ops",
    label: "REFUSALS",
    signSize: "sm",
    anchor: { x: 1090, y: 1385 },
    size: { w: 140, d: 80 },
    blurb:
      "Permission denied, budget exceeded, signer unavailable, environment mismatch: refusals are normal system states.",
    status: "Last: budget exceeded",
  }),
  researchOnlyGate: S({
    id: "researchOnlyGate",
    district: "research",
    label: "RESEARCH ONLY",
    signSize: "md",
    anchor: { x: 180, y: 635 },
    size: { w: 140, d: 120 },
    blurb:
      "An entrance to charts, alerts, backtests, and simulations that never requires a signer or grants exposure.",
    status: "Open",
  }),
};

/** Ordered list for a11y listing and keyboard exploration. */
export const STATION_ORDER: StationId[] = Object.keys(STATIONS) as StationId[];

/** External Hyperliquid platform is interactive like a station. */
export const HYPERLIQUID_ANCHOR = { x: 2700, y: 1080 };
