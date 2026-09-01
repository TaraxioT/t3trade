/**
 * The 31 micro-stories: small scripted sequences of agent walks, rail
 * packets, station api calls, and simulation mutations that continuously
 * explain T3 Trade. Owner: director worker.
 *
 * Contract notes relied on here (see artifacts/diorama/workers/director.md):
 * - DecisionTableApi.showProposals(count, -1) means "reject beat": all cards
 *   retract and one dims red. The research district worker must honor -1
 *   instead of clamping it to 0.
 * - Stations without a frozen animation api (marketData, portfolioVault,
 *   auditArchive, approval waiting shimmer) get a station-agnostic glow
 *   pulse on their registered root via GSAP alpha.
 * - Hyperliquid / MarketLandscape apis are reached through the exported
 *   holder objects (`hyperliquid`, `marketLandscape`), each `{ api: X | null }`,
 *   and are null-guarded. The authority seam sweep comes from world/seam.ts
 *   (`pulseSeam()`), fired when approval binds.
 * - Every literal walk point and cue anchor must sit inside the room diamond
 *   (config/geometry.ts insideRoom); nothing routes outside the room.
 */
import gsap from "gsap";
import type { DioramaContext } from "../core/context.js";
import type { StationId } from "../config/stations.js";
import { STATIONS } from "../config/stations.js";
import type { PacketKind, RouteId } from "../config/rails.js";
import { ROUTES } from "../config/rails.js";
import { ROLE_COLORS } from "../config/palette.js";
import type { Agent, Expression } from "../agents/agent.js";
import type { AgentSystem } from "../agents/system.js";
import type { RailSystem } from "./rails.js";
import type { Simulation } from "./simulation.js";
import { stationApi as registryApi } from "../core/registry.js";
import { getStation } from "../core/registry.js";
import type { HyperliquidApi } from "../world/hyperliquid.js";
import type { MarketLandscapeApi } from "../world/marketLandscape.js";
import * as marketLandscapeModule from "../world/marketLandscape.js";
import type {
  DecisionTableApi,
  LiquidityResearchApi,
  MissionBoardApi,
} from "../stations/research.js";
import type {
  ApprovalApi,
  BudgetMeterApi,
  ExecutionGatewayApi,
  ProtectionApi,
  RiskFortressApi,
  SignerVaultApi,
} from "../stations/risk.js";
import type { McpHubApi } from "../stations/mcp.js";
import type {
  ReceiptPrinterApi,
  ReconciliationApi,
  RecoveryApi,
  RefusalBoardApi,
  ReplayChamberApi,
} from "../stations/ops.js";
import type {
  HoloCoreApi,
  SignalTowerApi,
  TradingFloorApi,
} from "../stations/central.js";
import { popMarkAt, scatterCards, rollProp } from "../agents/fx.js";
import { cueAt } from "../audio.js";
import { mascot as mascotHolder } from "../agents/mascot.js";

export interface StoryDeps {
  ctx: DioramaContext;
  agents: AgentSystem;
  rails: RailSystem;
  simulation: Simulation;
  /** Seeded rng shared with the director; same seed = same show. */
  rng: () => number;
  /** Actors acquired for this run; guaranteed held until the story finishes. */
  cast: Map<string, Agent>;
  /** Content timing (story beats). Resolves immediately once stopped. */
  wait(ms: number): Promise<void>;
  /** Decorative pause. Skipped entirely under reduced motion. */
  beat(ms: number): Promise<void>;
  /** True once the director has been stopped; finish early when set. */
  cancelled(): boolean;
}

export interface Story {
  id: string;
  title: string;
  /** Rough playing time in seconds; scheduler hint only. */
  durationHint: number;
  /** Actor ids that must be acquirable for the story to start. */
  agents: string[];
  /** Stations that must be free; the director marks them busy. */
  stations: StationId[];
  run(deps: StoryDeps): Promise<void>;
}

// ---------------------------------------------------------------------------
// Robustness helpers
// ---------------------------------------------------------------------------

const warned = new Set<string>();

function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(`[diorama/stories] ${message}`);
}

/** Typed station api lookup that logs once when a station is not built yet. */
function storyApi<T extends object>(id: StationId): T | undefined {
  const api = registryApi<T>(id);
  if (!api) warnOnce(`station api not registered: ${id}`);
  return api;
}

/** Ground-worker holder objects may not exist yet; read them defensively. */
function holderApi<T>(mod: object, name: string): T | null {
  const holder = (mod as unknown as Record<string, unknown>)[name] as { api: T | null } | undefined;
  if (!holder || !holder.api) {
    warnOnce(`world holder missing or empty: ${name}`);
    return null;
  }
  return holder.api;
}

function hyperliquid(): HyperliquidApi | undefined {
  return storyApi<HyperliquidApi>("hyperliquidVenue");
}

function marketLandscape(): MarketLandscapeApi | null {
  return holderApi<MarketLandscapeApi>(marketLandscapeModule, "marketLandscape");
}

/**
 * Station-agnostic glow pulse for stations without a frozen animation api.
 * Tweens the registered root's alpha. Exported: the director's district
 * heartbeats reuse it. The tween is short-lived and self-terminating; route
 * teardown's gsap.globalTimeline.clear() is the cleanup, so NO per-call
 * cleanup is registered (heartbeats fire every few hundred milliseconds and
 * per-call registrations would grow the cleanup list without bound).
 */
export function glowPulse(ctx: DioramaContext, id: StationId, dip = 0.5, seconds = 0.9): void {
  const station = getStation(id);
  if (!station) {
    warnOnce(`station not registered: ${id}`);
    return;
  }
  gsap.to(station.root, {
    alpha: dip,
    duration: seconds / 2,
    yoyo: true,
    repeat: 1,
    ease: "sine.inOut",
  });
}

/** Walk, or snap into place under reduced motion. No-ops once the director
 * is stopped: story continuations can resume after teardown (pending walks
 * resolve during cleanup) and must not touch destroyed objects. */
async function move(
  deps: StoryDeps,
  agentId: string,
  points: { x: number; y: number }[],
): Promise<void> {
  if (deps.cancelled()) return;
  const agent = deps.cast.get(agentId);
  if (!agent) {
    warnOnce(`agent missing from cast: ${agentId}`);
    return;
  }
  if (points.length === 0) return;
  // Locomotion always walks (also under reduced motion): miniature agents
  // walking between stations is scene content, so stories never teleport.
  await deps.agents.walk(agent, points, { ease: "arrive" });
}

/** Dispatch a packet and wait for arrival. The packet chirp is anchored to
 * the route's origin station so sound and the visual source cue come from
 * where the packet leaves (foley cooldown inside the audio layer keeps
 * bursts from machine-gunning). */
async function send(
  deps: StoryDeps,
  route: RouteId,
  kind?: PacketKind,
  opts?: { reverse?: boolean; label?: string },
): Promise<void> {
  if (deps.cancelled()) return;
  const origin = opts?.reverse ? ROUTES[route]?.to : ROUTES[route]?.from;
  if (origin) cue("packet", STATIONS[origin].anchor);
  const handle = deps.rails.dispatch(route, kind, opts);
  await handle.done;
}

function express(deps: StoryDeps, agentId: string, expr: Expression): void {
  if (deps.cancelled()) return;
  deps.cast.get(agentId)?.setExpression(expr);
}

function react(
  deps: StoryDeps,
  agentId: string,
  kind:
    | "hop"
    | "droop"
    | "lean"
    | "tilt"
    | "wobble"
    | "squash"
    | "startle"
    | "headrub"
    | "apologize"
    | "doubleTake",
): void {
  if (deps.cancelled()) return;
  deps.cast.get(agentId)?.react(kind);
}

function popMark(
  deps: StoryDeps,
  agentId: string,
  kind: "!" | "?" | "stars" | "droplet" | "puff",
): void {
  if (deps.cancelled()) return;
  deps.cast.get(agentId)?.popMark(kind);
}

/** Fire a semantic audio cue anchored to its emitting world point; a no-op
 * while the visitor keeps sound muted. The audio layer derives stereo pan
 * and distance attenuation from the point and pulses a matching visual
 * source cue at the same location. */
function cue(name: string, at: { x: number; y: number }): void {
  cueAt(name, at);
}

/** The floor mascot celebrates when a beat lands near its pad; no-op before
 * the mascot module has built (story beats must never depend on it). */
function mascotCelebrate(): void {
  mascotHolder.api?.celebrate();
}

/** Advance the mission phase on the shared simulation AND the board, so the
 * visible mission board tracks the lifecycle instead of drifting stale. */
function setMissionPhase(deps: StoryDeps, phase: string): void {
  if (deps.cancelled()) return;
  deps.simulation.setPhase(phase);
  storyApi<MissionBoardApi>("missionBoard")?.setPhase(phase);
}

/** A named walking point near a station anchor, offset toward the floor. */
function near(id: StationId, dx = 0, dy = 0): { x: number; y: number } {
  const s = STATIONS[id].anchor;
  return { x: s.x + dx, y: s.y + dy };
}

// Short local aliases for the station api interfaces the stories call.
type Approval = ApprovalApi;
type BudgetMeter = BudgetMeterApi;
type ExecutionGateway = ExecutionGatewayApi;
type Protection = ProtectionApi;
type RiskFortress = RiskFortressApi;
type SignerVault = SignerVaultApi;
type McpHub = McpHubApi;
type ReceiptPrinter = ReceiptPrinterApi;
type Reconciliation = ReconciliationApi;
type Recovery = RecoveryApi;
type ReplayChamber = ReplayChamberApi;
type SignalTower = SignalTowerApi;
type TradingFloor = TradingFloorApi;
type MarketStructure = LiquidityResearchApi;

/**
 * The approval desk may expose a grant pulse alongside its frozen seal api;
 * optional so the seam story works at every integration state of the risk
 * lane (the seam sweep itself never depends on it).
 */
interface ApprovalGrantPulse {
  grantPulse?: () => void;
}

// ---------------------------------------------------------------------------
// Story builders
// ---------------------------------------------------------------------------

const s = (
  id: string,
  title: string,
  durationHint: number,
  agents: string[],
  stations: StationId[],
  run: (deps: StoryDeps) => Promise<void>,
): Story => ({ id, title, durationHint, agents, stations, run });

// Probe walk along the floor terrain band (matches the landscape worker's
// probe drift lane and probe-1's authored wander).
const probeWalk: { x: number; y: number }[] = [
  { x: 715, y: 508 },
  { x: 768, y: 481 },
  { x: 845, y: 443 },
  { x: 930, y: 401 },
];

// Scanner patrol across the risk fortress apron (matches risk-scanner's
// authored wander loop).
const corridorWalk: { x: number; y: number }[] = [
  { x: 2130, y: 735 },
  { x: 2200, y: 745 },
  { x: 2270, y: 770 },
];

// Sandbox stroll in the northwest research pocket (matches sandbox-1's
// authored wander loop).
const sandboxWalk: { x: number; y: number }[] = [
  { x: 295, y: 730 },
  { x: 345, y: 712 },
  { x: 315, y: 698 },
];

/**
 * The full trade lifecycle chain: research through reconciliation, played in
 * order with short gaps so a viewer can follow one decision end to end.
 */
export const LIFECYCLE_CHAIN: string[] = [
  "s-research-synthesis",
  "s-proposals-appear",
  "s-proposal-rejected",
  "s-proposal-needs-human",
  "s-human-approval",
  "s-permission-verify",
  "s-budget-consume",
  "s-risk-pass",
  "s-protection-attach",
  "s-signer-pulse",
  "s-execute-order",
  "s-exchange-ack",
  "s-fill-vault",
  "s-receipt-print",
  "s-reconcile",
  "s-audit-store",
];

/** Scattered singles: system texture between lifecycle runs. */
export const SCATTER_POOL: string[] = [
  "s-mcp-degraded",
  "s-tool-refusal",
  "s-recovery-retry",
  "s-alert-wake",
  "s-sandbox-test",
  "s-emergency-demo",
];

/** Weighted ambient texture for the new director: scatter singles plus the
 * floor choreography that keeps the default frame busy. */
export const TEXTURE_POOL: string[] = [
  ...SCATTER_POOL,
  "s-floor-handoff",
  "s-floor-signal",
  "s-venue-greet",
];

/** Harmless slapstick: own concurrency budget and per-gag cooldowns. */
export const COMEDY_POOL: string[] = [
  "s-bump-antennae",
  "s-drop-cards",
  "s-runaway-cart",
  "s-spring-gate",
  "s-cable-trip",
  "s-stack-topple",
];

export const STORIES: Story[] = [
  // 1. Research synthesis: the probe harvests evidence, the researcher
  // gathers a card from Research Tools, the evidence tier converges on
  // market data, competing candidates collide harmlessly at the strategy
  // lab, one is selected, the mission flips to Analysing, and the chosen
  // candidate is tabled at the decision table. One bounded sequence
  // (formerly three disconnected beats) so the district reads as a single
  // research-to-decision process with every station participating.
  s(
    "s-research-synthesis",
    "Research converges on a strategy",
    38,
    ["probe-1", "research-1", "analysis-1", "strategy-1", "strategy-2"],
    [
      "marketLandscape",
      "researchTools",
      "marketData",
      "strategyLab",
      "missionBoard",
      "signalTower",
      "decisionTable",
    ],
    async (d) => {
      await move(d, "probe-1", probeWalk);
      react(d, "probe-1", "hop");
      await send(d, "landscapeToMarketData");
      glowPulse(d.ctx, "marketData");
      // Evidence gathering: the researcher visibly originates at the
      // Research Tools stations before joining the convergence.
      const research = d.cast.get("research-1");
      const analysis = d.cast.get("analysis-1");
      research?.carry(ROLE_COLORS.research);
      express(d, "research-1", "focused");
      await move(d, "research-1", [near("researchTools", 0, 55)]);
      react(d, "research-1", "tilt");
      glowPulse(d.ctx, "researchTools");
      // Evidence tier: both researchers converge on market data, each
      // carrying a distinct evidence card.
      analysis?.carry(ROLE_COLORS.analysis);
      await Promise.all([
        move(d, "research-1", [near("marketData", 20, 55)]),
        move(d, "analysis-1", [near("marketData", -35, 70)]),
      ]);
      express(d, "research-1", "focused");
      express(d, "analysis-1", "focused");
      await d.beat(350);
      // Both carry their evidence to the strategy lab.
      await Promise.all([
        move(d, "research-1", [near("strategyLab", -75, 35)]),
        move(d, "analysis-1", [near("strategyLab", -75, 65)]),
      ]);
      research?.carry(null); // cards handed over
      analysis?.carry(null);
      // Harmless conflict: competing candidates reach for the same console
      // slot and bump. Competing research ideas realistically compete; this
      // must read as expressive accident, never violence.
      cue("bump", near("strategyLab", -70, 45));
      react(d, "research-1", "startle");
      react(d, "analysis-1", "startle");
      popMark(d, "research-1", "!");
      popMark(d, "analysis-1", "?");
      const scatterAt = near("strategyLab", -60, 45);
      await scatterCards(scatterAt.x, scatterAt.y, ROLE_COLORS.strategy, 4);
      await d.beat(500);
      react(d, "research-1", "apologize");
      react(d, "analysis-1", "headrub");
      await d.beat(400);
      // Sorted: the strategist picks one candidate; the losers retract.
      d.cast.get("strategy-1")?.carry(ROLE_COLORS.strategy);
      express(d, "strategy-1", "focused");
      react(d, "research-1", "hop");
      express(d, "analysis-1", "satisfied");
      glowPulse(d.ctx, "strategyLab");
      // Market-structure research informed the pick: the concept exhibit blips.
      storyApi<MarketStructure>("liquidityResearch")?.pulse("quote");
      await d.beat(300);
      // The chosen strategy updates the mission; the signal tower hears it.
      await move(d, "strategy-1", [near("missionBoard", 60, 20)]);
      d.cast.get("strategy-1")?.carry(null);
      setMissionPhase(d, "Analysing");
      cue("lever", near("missionBoard"));
      await d.beat(300);
      await send(d, "missionToSignalTower");
      storyApi<SignalTower>("signalTower")?.pulse("market");
      // The chosen candidate is tabled: the strategist carries it to the
      // decision table, where the analyst witness acknowledges it. The table
      // sits near the room's southwest taper, so the approach stays north of
      // the anchor to remain inside the room.
      d.cast.get("strategy-1")?.carry(ROLE_COLORS.strategy);
      await move(d, "strategy-1", [near("decisionTable", -25, -25)]);
      d.cast.get("strategy-1")?.carry(null);
      express(d, "strategy-2", "focused");
      react(d, "strategy-2", "lean");
      glowPulse(d.ctx, "decisionTable", 0.45, 1.0);
    },
  ),

  // 4. Proposals appear at the decision table.
  s("s-proposals-appear", "Proposals compared", 7, ["strategy-2"], ["decisionTable"], async (d) => {
    await move(d, "strategy-2", [near("decisionTable", -25, -25)]);
    storyApi<DecisionTableApi>("decisionTable")?.showProposals(3, 1);
    express(d, "strategy-2", "focused");
    react(d, "strategy-2", "lean");
  }),

  // 5. A proposal is rejected at the table and returns west.
  // CONTRACT: showProposals(count, -1) = reject beat (all retract, one dimmed red).
  s(
    "s-proposal-rejected",
    "Proposal rejected",
    7,
    ["strategy-2"],
    ["decisionTable", "approval", "refusalDisplay"],
    async (d) => {
      storyApi<DecisionTableApi>("decisionTable")?.showProposals(3, -1);
      express(d, "strategy-2", "frustrated");
      react(d, "strategy-2", "droop");
      await d.beat(400);
      await send(d, "deniedReturn");
      glowPulse(d.ctx, "refusalDisplay", 0.35, 1.1);
    },
  ),

  // 6. The surviving proposal needs human approval at the west gate.
  s(
    "s-proposal-needs-human",
    "Approval requested",
    9,
    ["approval-clerk"],
    ["decisionTable", "approval"],
    async (d) => {
      await send(d, "decisionToApproval");
      storyApi<Approval>("approval")?.setSeal("waiting");
      express(d, "approval-clerk", "curious");
      react(d, "approval-clerk", "tilt");
      // Approval has no "waiting shimmer" in its frozen api; glow the desk.
      glowPulse(d.ctx, "approval", 0.45, 1.4);
    },
  ),

  // 7. Human authority binds at the approval desk; the authority seam
  // between the floor and the guarded east section pulses.
  s(
    "s-human-approval",
    "Human approval granted",
    9,
    ["approval-clerk"],
    ["approval", "permission", "activityGallery"],
    async (d) => {
      glowPulse(d.ctx, "approval", 0.4, 1.2);
      cue("approve", near("approval"));
      await d.beat(300);
      storyApi<Approval>("approval")?.setSeal("approved");
      // The seam sweep plus the desk's own grant pulse (optional api).
      storyApi<ApprovalGrantPulse>("approval")?.grantPulse?.();
      await send(d, "approvalToPermission");
      // Plaque pulse for the user-activity wall (no frozen api).
      glowPulse(d.ctx, "activityGallery", 0.45, 1.0);
      express(d, "approval-clerk", "satisfied");
      react(d, "approval-clerk", "hop");
    },
  ),

  // 8. Permission tokens verify the agent may act.
  s(
    "s-permission-verify",
    "Permissions verified",
    8,
    ["permission-keeper"],
    ["permission", "budgetMeter"],
    async (d) => {
      express(d, "permission-keeper", "focused");
      glowPulse(d.ctx, "permission");
      // Command round trip: permission asks budget, budget answers.
      await send(d, "permissionToBudget");
      await send(d, "permissionToBudget", "event", { reverse: true });
      react(d, "permission-keeper", "lean");
    },
  ),

  // 9. Budget reservoirs are consumed transparently.
  s("s-budget-consume", "Budget consumed", 6, [], ["budgetMeter"], async (d) => {
    const budget = storyApi<BudgetMeter>("budgetMeter");
    budget?.consume("loss", 0.04);
    d.simulation.consumeLoss(4);
    await d.beat(300);
    budget?.consume("tools", 0.03);
    d.simulation.consumeTools(0.03);
    glowPulse(d.ctx, "budgetMeter", 0.45, 0.8);
  }),

  // 10. The risk fortress scans the proposal.
  s("s-risk-pass", "Risk arches pass", 9, ["risk-scanner"], ["riskFortress"], async (d) => {
    await send(d, "permissionToRisk");
    storyApi<RiskFortress>("riskFortress")?.runScan(true);
    express(d, "risk-scanner", "focused");
    await move(d, "risk-scanner", corridorWalk);
  }),

  // 11. Protection wraps the position token before any signing.
  s(
    "s-protection-attach",
    "Protection attached",
    8,
    [],
    ["riskFortress", "protection", "signerVault"],
    async (d) => {
      await send(d, "riskToProtection");
      storyApi<Protection>("protection")?.shieldUp();
      await d.beat(400);
      // The shielded token continues toward the signer.
      await send(d, "protectionToSigner");
    },
  ),

  // 12. The signer vault pulses; the key itself never leaves.
  s(
    "s-signer-pulse",
    "Order signed in vault",
    7,
    ["vault-keeper"],
    ["signerVault", "executionGateway"],
    async (d) => {
      storyApi<SignerVault>("signerVault")?.signPulse();
      cue("vault", near("signerVault"));
      express(d, "vault-keeper", "focused");
      react(d, "vault-keeper", "lean");
      await d.beat(400);
      await send(d, "signerToExecution");
    },
  ),

  // 13. The execution gateway ships the order capsule to the exchange.
  s(
    "s-execute-order",
    "Order sent to exchange",
    9,
    ["gateway-op"],
    ["executionGateway", "hyperliquidVenue"],
    async (d) => {
      const gateway = storyApi<ExecutionGateway>("executionGateway");
      gateway?.setState("preparing");
      express(d, "gateway-op", "focused");
      await d.beat(300);
      gateway?.setState("submitted");
      setMissionPhase(d, "Executing");
      cue("execute", near("executionGateway"));
      await send(d, "exchangeOrder");
      hyperliquid()?.exchangeEvent("order");
      storyApi<HoloCoreApi>("holoCore")?.orderLaunched();
    },
  ),

  // 14. The exchange acknowledges; the tower signals execution.
  s(
    "s-exchange-ack",
    "Exchange acknowledgment",
    7,
    [],
    ["executionGateway", "signalTower", "hyperliquidVenue"],
    async (d) => {
      await send(d, "exchangeOrder", "event", { reverse: true });
      storyApi<ExecutionGateway>("executionGateway")?.setState("acknowledged");
      hyperliquid()?.exchangeEvent("ack");
      cue("ack", near("hyperliquidVenue"));
      storyApi<SignalTower>("signalTower")?.pulse("execution");
    },
  ),

  // 15. The fill returns and the portfolio vault updates.
  s("s-fill-vault", "Fill updates portfolio", 8, [], ["portfolioVault", "hyperliquidVenue"], async (d) => {
    hyperliquid()?.exchangeEvent("fill");
    storyApi<HoloCoreApi>("holoCore")?.fillLanded();
    mascotCelebrate();
    // State truth flows back from the exchange before reconciliation
    // compares (the canonical return dispatch follows immediately).
    hyperliquid()?.exchangeEvent("state");
    await send(d, "exchangeStateReturn");
    // No frozen PortfolioVault api; station-agnostic pulse.
    glowPulse(d.ctx, "portfolioVault", 0.4, 1.2);
  }),

  // 16. A receipt prints and rolls into the archive.
  s(
    "s-receipt-print",
    "Receipt printed",
    8,
    ["receipt-clerk"],
    ["executionGateway", "receiptPrinter", "auditArchive"],
    async (d) => {
      await send(d, "executionToReceipts");
      storyApi<ReceiptPrinter>("receiptPrinter")?.print("order");
      cue("print", near("receiptPrinter"));
      express(d, "receipt-clerk", "neutral");
      await d.beat(600);
      await send(d, "receiptsToArchive");
    },
  ),

  // 17. Reconciliation compares local and exchange state.
  s(
    "s-reconcile",
    "Reconciliation aligned",
    8,
    ["recon-1"],
    ["reconciliationDock", "portfolioVault"],
    async (d) => {
      await move(d, "recon-1", [near("reconciliationDock", 30, -20)]);
      await send(d, "localStateStream");
      storyApi<Reconciliation>("reconciliationDock")?.compare(true);
      setMissionPhase(d, "Holding");
      express(d, "recon-1", "satisfied");
      react(d, "recon-1", "hop");
    },
  ),

  // 18. History is archived; occasionally replayed.
  s(
    "s-audit-store",
    "Audit and replay",
    8,
    ["archivist"],
    ["auditArchive", "replayChamber"],
    async (d) => {
      express(d, "archivist", "focused");
      // Drawer cycle has no frozen api; station-agnostic glow.
      glowPulse(d.ctx, "auditArchive", 0.45, 1.2);
      setMissionPhase(d, "Waiting");
      if (d.rng() < 0.5) {
        await d.beat(500);
        storyApi<ReplayChamber>("replayChamber")?.playReceipt();
      }
    },
  ),

  // 19. MCP ports degrade; the health console follows shared state.
  s(
    "s-mcp-degraded",
    "Tool port degradation",
    9,
    ["health-watcher"],
    ["mcpHub", "mcpHealth"],
    async (d) => {
      const hub = storyApi<McpHub>("mcpHub");
      hub?.setPortHealth(3, "amber");
      d.simulation.setPortHealth(3, "amber");
      await d.beat(500);
      hub?.setPortHealth(5, "red");
      d.simulation.setPortHealth(5, "red");
      express(d, "health-watcher", "worried");
      react(d, "health-watcher", "tilt");
    },
  ),

  // 20. A call on a dead port is refused with a comic knock-back, then recovers.
  s(
    "s-tool-refusal",
    "Tool call refused",
    12,
    ["hub-keeper", "adapter-op"],
    ["mcpHub", "refusalDisplay", "adapterBay"],
    async (d) => {
      const hub = storyApi<McpHub>("mcpHub");
      const adapterOp = d.cast.get("adapter-op");
      try {
        await move(d, "hub-keeper", [near("mcpHub", -30, 20)]);
        hub?.portCall(5); // attempted on the red port
        express(d, "hub-keeper", "confused");
        react(d, "hub-keeper", "startle"); // ejected packet knocks the caller back
        popMark(d, "hub-keeper", "?");
        cue("skid", near("mcpHub"));
        await d.beat(300);
        // Refusal card travels back from the hub toward the adapter bay.
        await send(d, "hubToAdapterBay", "refusal", { reverse: true });
        d.simulation.refuse("UNAVAILABLE TOOL");
        storyApi<RefusalBoardApi>("refusalDisplay")?.push("UNAVAILABLE TOOL");
        cue("reject", near("refusalDisplay"));
        glowPulse(d.ctx, "refusalDisplay", 0.35, 1.2);
        // The outage beat: the caller droops, then the adapter operator comes
        // over, apologizes for the port, and they wait it out together.
        react(d, "hub-keeper", "droop");
        if (adapterOp) {
          await move(d, "adapter-op", [near("mcpHub", 10, 55)]);
          react(d, "adapter-op", "apologize");
          popMark(d, "adapter-op", "droplet");
        }
        await d.wait(3500);
        if (d.cancelled()) return;
        hub?.setPortHealth(5, "green");
        d.simulation.setPortHealth(5, "green");
        express(d, "hub-keeper", "satisfied");
        react(d, "hub-keeper", "hop");
        cue("recover", near("mcpHub"));
      } finally {
        // Interrupt-safe: a destroyed or cancelled run still restores the port
        // and shared state so the hub never sits red forever.
        hub?.setPortHealth(5, "green");
        d.simulation.setPortHealth(5, "green");
      }
    },
  ),

  // 21. Recovery repairs a drifted flow, then reconciliation aligns.
  s(
    "s-recovery-retry",
    "Recovery and retry",
    10,
    ["recovery-1"],
    ["recoveryWorkshop", "reconciliationDock"],
    async (d) => {
      express(d, "recovery-1", "worried");
      storyApi<Recovery>("recoveryWorkshop")?.dispatchRepair();
      await send(d, "recoveryDispatch");
      express(d, "recovery-1", "focused");
      await d.beat(400);
      storyApi<Reconciliation>("reconciliationDock")?.compare(false);
      await d.beat(700);
      storyApi<Reconciliation>("reconciliationDock")?.compare(true);
      express(d, "recovery-1", "satisfied");
      react(d, "recovery-1", "hop");
    },
  ),

  // 22. An alert wakes the floor.
  s(
    "s-alert-wake",
    "Alert wake",
    7,
    ["floor-monitor"],
    ["signalTower", "missionBoard"],
    async (d) => {
      storyApi<SignalTower>("signalTower")?.pulse("alert");
      await send(d, "missionToSignalTower");
      express(d, "floor-monitor", "alarmed");
      react(d, "floor-monitor", "hop");
    },
  ),

  // 23. Sandbox: everything stays inside the research section.
  // NOTE: this story deliberately crosses NO section seam; sandbox traffic
  // loops marketData -> strategy -> missionBoard inside research only.
  s(
    "s-sandbox-test",
    "Sandbox simulation",
    9,
    ["sandbox-1"],
    ["sandbox", "marketData", "strategyLab", "missionBoard"],
    async (d) => {
      express(d, "sandbox-1", "excited");
      await move(d, "sandbox-1", sandboxWalk);
      react(d, "sandbox-1", "hop");
      await send(d, "marketDataToStrategy");
      await send(d, "strategyToMissionBoard");
      glowPulse(d.ctx, "sandbox", 0.45, 1.0);
    },
  ),

  // 24. Emergency pause demo from the emergency panel beside Approval.
  s(
    "s-emergency-demo",
    "Emergency pause demo",
    11,
    ["floor-monitor", "floor-exec"],
    ["emergencyPanel", "tradingFloor", "signalTower"],
    async (d) => {
      const floor = getStation("tradingFloor");
      const restore = (): void => {
        if (floor) {
          for (const child of floor.root.children) {
            gsap.to(child, { alpha: 1, duration: 0.5, overwrite: true });
          }
        }
      };
      try {
        glowPulse(d.ctx, "emergencyPanel", 0.4, 1.0);
        storyApi<TradingFloor>("tradingFloor")?.setCampusPaused(true);
        d.simulation.setPaused(true);
        storyApi<SignalTower>("signalTower")?.pulse("warning");
        cue("warn", near("emergencyPanel"));
        if (floor) {
          // Station-agnostic: dim the floor's children, restore on resume.
          for (const child of floor.root.children) {
            const tween = gsap.to(child, { alpha: 0.75, duration: 0.5, overwrite: true });
            d.ctx.onCleanup(() => tween.kill());
          }
        }
        await d.wait(3000);
        storyApi<TradingFloor>("tradingFloor")?.setCampusPaused(false);
        d.simulation.setPaused(false);
        restore();
        express(d, "floor-monitor", "satisfied");
        express(d, "floor-exec", "satisfied");
        react(d, "floor-exec", "hop");
        popMark(d, "floor-monitor", "puff");
      } finally {
        // Interrupt-safe: the floor never stays dimmed.
        storyApi<TradingFloor>("tradingFloor")?.setCampusPaused(false);
        d.simulation.setPaused(false);
        restore();
      }
    },
  ),

  // 25. Rotating duty handoff across the floor consoles.
  s(
    "s-floor-handoff",
    "Duty handoff on the floor",
    11,
    ["floor-strategy", "floor-exec", "floor-monitor"],
    ["tradingFloor", "holoCore"],
    async (d) => {
      const holo = storyApi<HoloCoreApi>("holoCore");
      const strategy = d.cast.get("floor-strategy");
      const exec = d.cast.get("floor-exec");
      strategy?.carry(ROLE_COLORS.strategy);
      express(d, "floor-strategy", "focused");
      // Ring arcs west -> south -> east, outside the holo footprint.
      await move(d, "floor-strategy", [
        { x: 1292, y: 798 },
        { x: 1342, y: 848 },
        { x: 1420, y: 880 },
        { x: 1502, y: 905 },
      ]);
      react(d, "floor-exec", "doubleTake");
      strategy?.carry(null); // card handed over
      exec?.carry(ROLE_COLORS.execution);
      express(d, "floor-exec", "focused");
      await move(d, "floor-exec", [
        { x: 1502, y: 905 },
        { x: 1440, y: 940 },
      ]);
      exec?.carry(null); // second handoff
      d.cast.get("floor-monitor")?.tap();
      react(d, "floor-monitor", "lean");
      holo?.rotateStrategies();
      holo?.orderLaunched();
      cue("lever", near("tradingFloor"));
      await d.beat(400);
      react(d, "floor-strategy", "hop");
      express(d, "floor-monitor", "satisfied");
    },
  ),

  // 26. A market signal startles the floor and shifts the regime.
  s(
    "s-floor-signal",
    "Market signal reaches the floor",
    9,
    ["floor-research", "floor-analysis"],
    ["tradingFloor", "holoCore", "signalTower"],
    async (d) => {
      const holo = storyApi<HoloCoreApi>("holoCore");
      const tower = storyApi<SignalTower>("signalTower");
      const priorRegime = marketLandscape()?.regime() ?? "rising";
      try {
        tower?.pulse("market");
        // A market signal is routine data, not a warning: a short packet
        // chirp at the tower keeps the warn bell reserved for real alerts.
        cue("packet", near("signalTower"));
        express(d, "floor-research", "alarmed");
        react(d, "floor-research", "startle");
        popMark(d, "floor-research", "!");
        // Landscape flips regime; the holo mirrors it.
        marketLandscape()?.setRegime("turbulent");
        await move(d, "floor-research", [
          { x: 1288, y: 612 },
          { x: 1282, y: 660 },
        ]);
        express(d, "floor-research", "focused");
        express(d, "floor-analysis", "curious");
        react(d, "floor-analysis", "tilt");
        holo?.marketEvent("state");
        holo?.rotateStrategies();
        await d.beat(600);
        // Calm returns.
        marketLandscape()?.setRegime("rising");
        holo?.marketEvent("state");
        express(d, "floor-research", "satisfied");
        react(d, "floor-analysis", "hop");
      } finally {
        // Interrupt-safe: the landscape never stays turbulent.
        if (priorRegime !== "turbulent") marketLandscape()?.setRegime(priorRegime);
      }
    },
  ),

  // 26b. The market-structure desk welcome: a plain research-role host meets
  // a floor analyst at the concept-model exhibit, a quote card changes hands
  // where structure research meets the strategy loop, and the mascot waves
  // from its pad on the floor.
  s(
    "s-venue-greet",
    "Market-structure desk welcome",
    11,
    ["structure-host", "floor-research"],
    ["liquidityResearch", "tradingFloor"],
    async (d) => {
      const host = d.cast.get("structure-host");
      const analyst = d.cast.get("floor-research");
      host?.carry(ROLE_COLORS.research);
      await Promise.all([
        move(d, "structure-host", [near("liquidityResearch", 45, -15)]),
        move(d, "floor-research", [
          { x: 1080, y: 700 },
          { x: 960, y: 740 },
          near("liquidityResearch", 130, 10),
        ]),
      ]);
      react(d, "structure-host", "doubleTake");
      express(d, "floor-research", "curious");
      await d.beat(300);
      host?.carry(null); // quote card handed over
      analyst?.carry(ROLE_COLORS.research);
      storyApi<MarketStructure>("liquidityResearch")?.pulse("quote");
      react(d, "structure-host", "hop");
      mascotHolder.api?.wave();
      cue("door", near("liquidityResearch"));
      await d.beat(700);
      await Promise.all([
        move(d, "structure-host", [near("liquidityResearch", 10, 55)]),
        move(d, "floor-research", [
          { x: 1000, y: 785 },
          { x: 1150, y: 745 },
        ]),
      ]);
    },
  ),

  // 27. COMEDY. Two bots round a console from opposite sides and bump antennae.
  s(
    "s-bump-antennae",
    "Antennae bump on the north ring",
    8,
    ["floor-research", "floor-analysis"],
    ["tradingFloor"],
    async (d) => {
      // Both approaches run together so the collision reads as an accident.
      await Promise.all([
        move(d, "floor-research", [
          { x: 1330, y: 572 },
          { x: 1378, y: 570 },
        ]),
        move(d, "floor-analysis", [
          { x: 1545, y: 610 },
          { x: 1455, y: 572 },
          { x: 1420, y: 570 },
        ]),
      ]);
      // Bump.
      cue("bump", { x: 1400, y: 571 });
      react(d, "floor-research", "startle");
      react(d, "floor-analysis", "startle");
      popMark(d, "floor-research", "!");
      popMark(d, "floor-analysis", "!");
      await d.beat(350);
      react(d, "floor-research", "wobble");
      react(d, "floor-analysis", "wobble");
      await d.beat(450);
      react(d, "floor-research", "apologize");
      react(d, "floor-analysis", "headrub");
      await d.beat(500);
      await move(d, "floor-research", [
        { x: 1300, y: 620 },
        { x: 1268, y: 640 },
      ]);
      await move(d, "floor-analysis", [
        { x: 1500, y: 630 },
        { x: 1590, y: 640 },
      ]);
      d.cast.get("floor-analysis")?.laugh();
      express(d, "floor-research", "satisfied");
    },
  ),

  // 29. COMEDY. Dropped schema cards, a skid, and a helpful gather. Plays on
  // the tool-row corridor between the schema drawers and the adapter bay.
  s(
    "s-drop-cards",
    "Schema cards dropped and gathered",
    10,
    ["schema-librarian", "adapter-op"],
    ["toolSchemas", "adapterBay"],
    async (d) => {
      const librarian = d.cast.get("schema-librarian");
      librarian?.carry(ROLE_COLORS.operations);
      await move(d, "schema-librarian", [
        { x: 960, y: 975 },
        { x: 1020, y: 958 },
      ]);
      // Cards slip.
      librarian?.carry(null);
      cue("skid", { x: 1030, y: 955 });
      react(d, "schema-librarian", "squash");
      popMark(d, "schema-librarian", "?");
      await scatterCards(1030, 953, ROLE_COLORS.operations, 5);
      // The adapter operator skids past, narrowly misses, then helps.
      react(d, "adapter-op", "squash");
      await move(d, "adapter-op", [
        { x: 1080, y: 958 },
        { x: 1035, y: 962 },
      ]);
      react(d, "adapter-op", "apologize");
      await d.beat(300);
      await move(d, "schema-librarian", [{ x: 1032, y: 968 }]);
      react(d, "schema-librarian", "headrub");
      await d.beat(400);
      // Gathered together.
      cue("recover", { x: 1030, y: 958 });
      express(d, "adapter-op", "satisfied");
      express(d, "schema-librarian", "satisfied");
      d.cast.get("schema-librarian")?.laugh();
      await move(d, "schema-librarian", [
        { x: 975, y: 1000 },
        { x: 935, y: 1030 },
      ]);
      await move(d, "adapter-op", [
        { x: 1100, y: 985 },
        { x: 1092, y: 1035 },
      ]);
    },
  ),

  // 30. COMEDY. A maintenance cart rolls away west along the MCP tool row;
  // three bots chase it down before it reaches the hub.
  s(
    "s-runaway-cart",
    "Runaway cart chased down",
    12,
    ["hub-keeper", "schema-librarian", "adapter-op"],
    ["toolSchemas", "mcpHub", "adapterBay"],
    async (d) => {
      cue("cart", { x: 1105, y: 1035 });
      const cartDone = rollProp(
        1105,
        1035,
        ROLE_COLORS.execution,
        [
          { x: 1005, y: 990 },
          { x: 925, y: 935 },
          { x: 855, y: 905 },
          { x: 915, y: 880 },
        ],
        150,
      );
      // All three chases run concurrently with the cart; the story holds its
      // locks until every branch settles so no agent is released mid-gag.
      const chases = Promise.all([
        move(d, "schema-librarian", [
          { x: 1060, y: 1000 },
          { x: 990, y: 950 },
          { x: 930, y: 905 },
        ]).then(() => {
          react(d, "schema-librarian", "wobble");
        }),
        move(d, "adapter-op", [
          { x: 1100, y: 990 },
          { x: 1020, y: 950 },
          { x: 950, y: 915 },
        ]).then(() => {
          react(d, "adapter-op", "startle");
        }),
        move(d, "hub-keeper", [
          { x: 870, y: 895 },
          { x: 830, y: 905 },
          { x: 880, y: 940 },
        ]),
      ]);
      await Promise.all([cartDone, chases]);
      react(d, "hub-keeper", "squash"); // the catch
      popMark(d, "hub-keeper", "stars");
      cue("bump", { x: 915, y: 880 });
      await d.beat(300);
      react(d, "hub-keeper", "hop");
      d.cast.get("hub-keeper")?.laugh();
      express(d, "schema-librarian", "satisfied");
      express(d, "adapter-op", "satisfied");
    },
  ),

  // 31. COMEDY. The research-only spring gate closes early and bonks a
  // backpack. The gate is the wall door in the west wall's southeast reach.
  s(
    "s-spring-gate",
    "Spring gate bonk at research only",
    9,
    ["sandbox-1"],
    ["researchOnlyGate", "sandbox"],
    async (d) => {
      await move(d, "sandbox-1", [
        { x: 455, y: 700 },
        { x: 505, y: 672 },
      ]);
      // The gate springs shut a beat early.
      cue("door", near("researchOnlyGate"));
      react(d, "sandbox-1", "squash");
      popMark(d, "sandbox-1", "stars");
      glowPulse(d.ctx, "researchOnlyGate", 0.4, 1.0);
      await d.beat(400);
      react(d, "sandbox-1", "headrub");
      react(d, "sandbox-1", "apologize");
      await d.beat(450);
      // Retry politely; the gate behaves.
      await move(d, "sandbox-1", [
        { x: 475, y: 715 },
        { x: 530, y: 690 },
      ]);
      cue("door", near("researchOnlyGate"));
      react(d, "sandbox-1", "hop");
      express(d, "sandbox-1", "excited");
      await d.beat(300);
      await move(d, "sandbox-1", [
        { x: 420, y: 730 },
        { x: 370, y: 750 },
      ]);
      d.cast.get("sandbox-1")?.laugh();
    },
  ),

  // 32. COMEDY. A loose cable trips the recovery bot beside the workshop; a
  // colleague rushes over from observability and helps it upright.
  s(
    "s-cable-trip",
    "Cable trip and a helping hand",
    10,
    ["recovery-1", "observer-1"],
    ["recoveryWorkshop", "observability"],
    async (d) => {
      await move(d, "recovery-1", [
        { x: 1640, y: 1170 },
        { x: 1690, y: 1160 },
      ]);
      // Trip over the loose cable.
      cue("bump", { x: 1705, y: 1155 });
      react(d, "recovery-1", "squash");
      popMark(d, "recovery-1", "stars");
      popMarkAt(1705, 1155, "puff");
      await d.beat(500);
      react(d, "recovery-1", "wobble");
      // The observer rushes over and helps upright.
      await move(d, "observer-1", [
        { x: 2050, y: 990 },
        { x: 1900, y: 1030 },
        { x: 1760, y: 1090 },
      ]);
      react(d, "observer-1", "apologize");
      await d.beat(400);
      react(d, "recovery-1", "hop");
      express(d, "recovery-1", "satisfied");
      express(d, "observer-1", "satisfied");
      d.cast.get("observer-1")?.laugh();
      await move(d, "observer-1", [
        { x: 1880, y: 1040 },
        { x: 2040, y: 995 },
      ]);
    },
  ),

  // 34. COMEDY. A celebratory hop topples a stack of glowing capsules beside
  // the portfolio vault; the archivist helps gather them.
  s(
    "s-stack-topple",
    "Capsule stack toppled at the vault",
    9,
    ["receipt-clerk", "archivist"],
    ["receiptPrinter", "portfolioVault"],
    async (d) => {
      storyApi<ReceiptPrinter>("receiptPrinter")?.print("order");
      cue("stamp", near("receiptPrinter"));
      await d.beat(400);
      react(d, "receipt-clerk", "hop");
      // The hop knocks the neighbor's capsule stack.
      cue("bump", near("portfolioVault"));
      popMark(d, "receipt-clerk", "!");
      express(d, "receipt-clerk", "alarmed");
      await scatterCards(1880, 905, ROLE_COLORS.reconciliation, 4);
      await d.beat(300);
      react(d, "receipt-clerk", "apologize");
      // The archivist helps gather.
      await move(d, "archivist", [
        { x: 1900, y: 1075 },
        { x: 1890, y: 975 },
      ]);
      react(d, "archivist", "headrub");
      await d.beat(500);
      cue("recover", near("portfolioVault"));
      express(d, "archivist", "satisfied");
      express(d, "receipt-clerk", "satisfied");
      d.cast.get("receipt-clerk")?.laugh();
      await move(d, "archivist", [{ x: 1905, y: 1075 }]);
    },
  ),
];

export const STORY_MAP: Map<string, Story> = new Map(STORIES.map((story) => [story.id, story]));
