/**
 * Station registry: the master layout of the T3 Trade diorama room in
 * 2816 x 1536 world units. Every builder, rail, agent path, and interaction
 * target keys off these ids and anchors. Coordinates are ground-level
 * footprint centers.
 *
 * Reading order: one square cutaway room in three sections. The west
 * RESEARCH & AGENTS section holds the watchlist, ideas and validation,
 * mission, and trade row along the west wall with the TOOLS compound in the
 * south-west wedge. The CENTRAL TRADING FLOOR is a structural compound of
 * five console banks around the mission chart and alert tower, with the
 * Hyperliquid testnet exchange booth docked at its east seam. The east
 * GUARDED EXECUTION & RECONCILIATION section runs controls, risk guards,
 * protection, local signing, and execution along the back wall, then
 * reconciliation, positions, and history across the south band.
 *
 * Registry is the cycle-4 freeze set: exactly 18 stations. A per-station
 * `lod` class drives the sign policy (core/signs.ts, ui/labels.ts):
 * "overview" boards are visible at tier 0 (fit), "zoom" boards appear at
 * tier >=1.15 and on focus, and the focused station's board is forced
 * visible at any tier. Registered in-station screen detail text is owned by
 * the signs policy, not by this registry.
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
      "Research mode where the watchlist, ideas and validation, mission, trade ticket, and tools work without a signer.",
  },
  floor: {
    id: "floor",
    title: "CENTRAL TRADING FLOOR",
    center: { x: 1435, y: 768 },
    bounds: { x1: 1120, y1: 138, x2: 1750, y2: 1398 },
    accent: 0x5a7cff,
    accent2: 0xffd35a,
    blurb:
      "The trading floor where the mission chart, alerts, and the authoritative Hyperliquid testnet venue anchor the order path.",
  },
  risk: {
    id: "risk",
    title: "GUARDED EXECUTION & RECONCILIATION",
    center: { x: 2209, y: 768 },
    bounds: { x1: 1750, y1: 138, x2: 2668, y2: 1398 },
    accent: 0xffd35a,
    accent2: 0x56f2c2,
    blurb:
      "Guarded execution where controls, risk guards, protection, local signing, reconciliation, positions, and history surround every order.",
  },
};

/**
 * The frozen cycle-4 station set (freeze §1). Internal ids survive cycle-3
 * names; display labels follow the product naming. Do not add ids without a
 * freeze change.
 */
export type StationId =
  // West section: research row (research district)
  | "marketData"
  | "researchTools"
  | "missionBoard"
  | "decisionTable"
  // West section: tools compound (research district)
  | "mcpHub"
  // Central trading floor
  | "tradingFloor"
  | "holoCore"
  | "signalTower"
  | "hyperliquidVenue"
  // East section: guarded execution flow (risk district)
  | "emergencyPanel"
  | "budgetMeter"
  | "riskFortress"
  | "protection"
  | "signerVault"
  | "executionGateway"
  // East section: state and reconciliation cluster (risk district)
  | "reconciliationDock"
  | "portfolioVault"
  | "auditArchive";

/**
 * Sign policy class for the station board (freeze §1): "overview" boards are
 * the only boards visible at tier 0 (fit), "zoom" boards appear at tier
 * >=1.15 and whenever their station is focused. tradingFloor is zoom and has
 * no fit board: its label is internal a11y/card text and its board never
 * renders at tier 0.
 */
export type StationLod = "overview" | "zoom";

export interface StationDef {
  id: StationId;
  district: DistrictId;
  /** Uppercase sign text; doubles as the a11y / card name. */
  label: string;
  /** Board sign policy class; decides visibility per camera tier. */
  lod: StationLod;
  /** Visual plate size class for the board sign (core/signs.ts). */
  signSize: "sm" | "md" | "lg";
  /** Ground-level footprint center. */
  anchor: { x: number; y: number };
  /** Approximate footprint for hit areas and camera fit. */
  size: { w: number; d: number };
  /** One-sentence explanation for the info card. */
  blurb: string;
  /** Initial simulated status shown on the info card. */
  status: string;
  /** One key relationship, e.g. "Trade → Risk → Protection". */
  relation?: string;
  /** Camera zoom multiplier when focused (default 1). */
  focusZoom?: number;
  /** Micro-story the info-card action button runs (freeze §11 id). */
  story?: string;
  /** Info-card action label; omit on stations without a safe demo story. */
  action?: string;
}

const S = (def: StationDef): StationDef => def;

export const STATIONS: Record<StationId, StationDef> = {
  marketData: S({
    id: "marketData",
    district: "research",
    label: "WATCHLIST",
    lod: "overview",
    signSize: "md",
    anchor: { x: 790, y: 570 },
    size: { w: 185, d: 115 },
    blurb:
      "Asset rows with mark and 24 hour change for the selected market; chart data arrives as a refresh fetch, never a tick stream.",
    status: "ETH selected",
    relation: "Watchlist → Chart → Mission",
    focusZoom: 1.4,
    story: "s-watch-market",
    action: "Arm a watch",
  }),
  researchTools: S({
    id: "researchTools",
    district: "research",
    label: "IDEAS & VALIDATION",
    lod: "zoom",
    signSize: "md",
    anchor: { x: 950, y: 490 },
    size: { w: 180, d: 110 },
    blurb:
      "Forward validation of candidate ideas on paper, in research mode with no signer required.",
    status: "Validating on paper",
    relation: "Ideas → Mission",
    story: "s-run-validation",
    action: "Run validation",
  }),
  missionBoard: S({
    id: "missionBoard",
    district: "research",
    label: "MISSION",
    lod: "zoom",
    signSize: "md",
    anchor: { x: 540, y: 870 },
    size: { w: 195, d: 120 },
    blurb:
      'Exact mission status with the "Analyse › Wait › Execute › Position" breadcrumb, the "Maximum cumulative loss" strip, and the armed watch count.',
    status: "Waiting",
    relation: "Mission → Trade",
    story: "s-lifecycle",
    action: "Run the lifecycle",
  }),
  decisionTable: S({
    id: "decisionTable",
    district: "research",
    label: "TRADE",
    lod: "overview",
    signSize: "md",
    anchor: { x: 675, y: 950 },
    size: { w: 195, d: 130 },
    blurb:
      "Order ticket for the selected market with a live preview, or the verbatim refusal sentence when a guard blocks the order.",
    status: "Preview ready",
    relation: "Trade → Risk guards → Protection → Signer",
    focusZoom: 1.4,
    story: "s-place-order",
    action: "Place an order",
  }),

  mcpHub: S({
    id: "mcpHub",
    district: "research",
    label: "TOOLS",
    lod: "zoom",
    signSize: "lg",
    anchor: { x: 850, y: 1000 },
    size: { w: 250, d: 185 },
    blurb:
      'One quiet infrastructure compound of typed tool call and result ports, provider adapters, and health state under "Research mode · signer not required".',
    status: "Available",
    focusZoom: 1.35,
    relation: "Floor ↔ Tools",
    story: "s-tool-call",
    action: "Demo a tool call",
  }),

  tradingFloor: S({
    id: "tradingFloor",
    district: "floor",
    label: "TRADING FLOOR",
    // No fit board: this label is a11y/card text only and the board must
    // never render at tier 0 (freeze §1).
    lod: "zoom",
    signSize: "lg",
    anchor: { x: 1435, y: 845 },
    size: { w: 540, d: 390 },
    blurb:
      "Structural platform coordinating the five console banks: watchlist, chart, trade, positions, and alerts.",
    status: "Consoles ready",
    focusZoom: 1.25,
    relation: "Floor ↔ Tools",
  }),
  holoCore: S({
    id: "holoCore",
    district: "floor",
    label: "CHART",
    lod: "overview",
    signSize: "sm",
    anchor: { x: 1435, y: 705 },
    size: { w: 230, d: 140 },
    blurb:
      "Mission chart with entry, stop, and liquidation lines over a simulated feed, plus quiet regime shading for market context.",
    status: "Simulated feed",
    focusZoom: 1.5,
    relation: "Watchlist → Chart → Mission",
    story: "s-market-shift",
    action: "Shift the regime",
  }),
  signalTower: S({
    id: "signalTower",
    district: "floor",
    label: "ALERTS",
    lod: "overview",
    signSize: "sm",
    anchor: { x: 1620, y: 390 },
    size: { w: 90, d: 90 },
    blurb: "Watch feed of armed, fired, and cancelled alerts with a distinct pulse for each state.",
    status: "Armed",
    focusZoom: 1.4,
    relation: "Mission → Alerts",
    story: "s-alert-fire",
    action: "Fire an alert",
  }),
  hyperliquidVenue: S({
    id: "hyperliquidVenue",
    district: "floor",
    label: "HYPERLIQUID TESTNET",
    lod: "overview",
    signSize: "md",
    anchor: { x: 1810, y: 500 },
    size: { w: 240, d: 170 },
    blurb:
      'The "AUTHORITATIVE EXCHANGE" booth with a simulated feed: testnet only, and the sole current execution venue, authoritative for positions, orders, and fills.',
    status: "Simulated feed",
    focusZoom: 1.45,
    relation: "Execution → Hyperliquid → Reconciliation",
    story: "s-exchange-roundtrip",
    action: "Run the round trip",
  }),

  emergencyPanel: S({
    id: "emergencyPanel",
    district: "risk",
    label: "CONTROLS",
    lod: "overview",
    signSize: "sm",
    anchor: { x: 1775, y: 850 },
    size: { w: 95, d: 70 },
    blurb:
      "Operator controls that outrank every agent: pause, cancel entries, reduce, close, revoke, and close and revoke, without the provider running.",
    status: "Armed",
    focusZoom: 1.4,
    relation: "Controls → History",
    story: "s-pause-control",
    action: "Test pause",
  }),
  budgetMeter: S({
    id: "budgetMeter",
    district: "risk",
    label: "LOSS BUDGET",
    lod: "zoom",
    signSize: "sm",
    anchor: { x: 2220, y: 620 },
    size: { w: 145, d: 105 },
    blurb:
      "Maximum cumulative loss with the used and remaining allowance and the pending entry reservation; positive P&L is never extra budget.",
    status: "Remaining 82%",
    relation: "Risk guards → Loss budget",
    story: "s-budget-consume",
    action: "Draw down budget",
  }),
  riskFortress: S({
    id: "riskFortress",
    district: "risk",
    label: "RISK GUARDS",
    lod: "zoom",
    signSize: "lg",
    anchor: { x: 2190, y: 800 },
    size: { w: 250, d: 180 },
    blurb:
      "Deterministic guards for stop required, loss budget, direction, and exposure; refusals are explicit states with a stated reason.",
    status: "All guards pass",
    focusZoom: 1.3,
    relation: "Trade → Risk guards → Protection",
    story: "s-risk-scan",
    action: "Run a risk scan",
  }),
  protection: S({
    id: "protection",
    district: "risk",
    label: "PROTECTION",
    lod: "zoom",
    signSize: "sm",
    anchor: { x: 1980, y: 780 },
    size: { w: 140, d: 100 },
    blurb:
      "Exchange-native protection wraps every confirmed exposure increase; the default is a stop resting on the exchange and unprotected is never a success.",
    status: "Stop on exchange",
    relation: "Risk guards → Protection → Signer",
    story: "s-protection-attach",
    action: "Attach protection",
  }),
  signerVault: S({
    id: "signerVault",
    district: "risk",
    label: "LOCAL SIGNING",
    lod: "zoom",
    signSize: "md",
    anchor: { x: 2395, y: 765 },
    size: { w: 145, d: 125 },
    blurb:
      "A sealed boundary where orders receive a local signing pulse; signing material never leaves the vault.",
    status: "Signer armed",
    focusZoom: 1.4,
    relation: "Protection → Signer → Execution",
    story: "s-sign-pulse",
    action: "Show local signing",
  }),
  executionGateway: S({
    id: "executionGateway",
    district: "risk",
    label: "EXECUTION",
    lod: "zoom",
    signSize: "md",
    anchor: { x: 1930, y: 660 },
    size: { w: 145, d: 110 },
    blurb:
      "Execution state strip from previewed through filled, with rejected, cancelled, and failed as terminal alternatives, before the order reaches the venue.",
    status: "Idle",
    focusZoom: 1.35,
    relation: "Signer → Execution → Hyperliquid",
    story: "s-submit-order",
    action: "Submit an order",
  }),

  reconciliationDock: S({
    id: "reconciliationDock",
    district: "risk",
    label: "RECONCILE",
    lod: "overview",
    signSize: "md",
    anchor: { x: 1700, y: 1120 },
    size: { w: 210, d: 135 },
    blurb:
      "Exchange invalidation rings the doorbell, the account view is refetched, and aligned or drift is reported honestly.",
    status: "Aligned",
    focusZoom: 1.3,
    relation: "Hyperliquid → Reconcile → Positions",
    story: "s-reconcile",
    action: "Reconcile state",
  }),
  portfolioVault: S({
    id: "portfolioVault",
    district: "risk",
    label: "POSITIONS",
    lod: "overview",
    signSize: "md",
    anchor: { x: 1975, y: 910 },
    size: { w: 145, d: 105 },
    blurb:
      "Positions and open orders with side, size, and P&L, the protection label, and reduce or close controls.",
    status: "No open position",
    focusZoom: 1.4,
    relation: "Reconcile → Positions → History",
    story: "s-position-update",
    action: "Apply a refetch",
  }),
  auditArchive: S({
    id: "auditArchive",
    district: "risk",
    label: "HISTORY",
    lod: "zoom",
    signSize: "md",
    anchor: { x: 1865, y: 1085 },
    size: { w: 190, d: 115 },
    blurb:
      "Mission event rows for controls, fills, and refusals with net P&L, replay capability, and one quiet archiver health line.",
    status: "Archiving",
    relation: "Positions → History",
    story: "s-history-row",
    action: "Add a history row",
  }),
};

/**
 * Ordered list for a11y listing and keyboard exploration. Key order is the
 * room reading order and the freeze §1 order: west research row, tools
 * compound, central trading floor, east guarded-execution flow, then the
 * east state cluster.
 */
export const STATION_ORDER: StationId[] = Object.keys(STATIONS) as StationId[];
