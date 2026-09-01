/**
 * The 24 micro-stories: small scripted sequences of agent walks, rail
 * packets, station api calls, and simulation mutations that continuously
 * explain T3 Trade. Owner: director worker.
 *
 * Contract notes relied on here (see artifacts/diorama/workers/director.md):
 * - DecisionTableApi.showProposals(count, -1) means "reject beat": all cards
 *   retract and one dims red. The research district worker must honor -1
 *   instead of clamping it to 0.
 * - Stations without a frozen animation api (marketData, portfolioVault,
 *   auditArchive, approval waiting shimmer, supervisor deck glow) get a
 *   station-agnostic glow pulse on their registered root via GSAP alpha.
 * - Perimeter / Hyperliquid / MarketLandscape apis are reached through the
 *   ground worker's exported holder objects (`perimeter`, `hyperliquid`,
 *   `marketLandscape`), each `{ api: X | null }`, and are null-guarded.
 */
import gsap from "gsap";
import type { DioramaContext } from "../core/context.js";
import type { StationId } from "../config/stations.js";
import { STATIONS } from "../config/stations.js";
import type { PacketKind, RouteId } from "../config/rails.js";
import { ROLE_COLORS } from "../config/palette.js";
import type { Agent, Expression } from "../agents/agent.js";
import type { AgentSystem } from "../agents/system.js";
import type { RailSystem } from "./rails.js";
import type { Simulation } from "./simulation.js";
import { stationApi as registryApi } from "../core/registry.js";
import { getStation } from "../core/registry.js";
import type { PerimeterApi } from "../world/perimeter.js";
import type { HyperliquidApi } from "../world/hyperliquid.js";
import * as perimeterModule from "../world/perimeter.js";
import * as hyperliquidModule from "../world/hyperliquid.js";
import type { DecisionTableApi, MissionBoardApi } from "../stations/research.js";
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
  ReplayChamberApi,
} from "../stations/ops.js";
import type { SignalTowerApi, SupervisorApi } from "../stations/central.js";

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
  const holder = (mod as unknown as Record<string, unknown>)[name] as
    | { api: T | null }
    | undefined;
  if (!holder || !holder.api) {
    warnOnce(`world holder missing or empty: ${name}`);
    return null;
  }
  return holder.api;
}

function perimeter(): PerimeterApi | null {
  return holderApi<PerimeterApi>(perimeterModule, "perimeter");
}

function hyperliquid(): HyperliquidApi | null {
  return holderApi<HyperliquidApi>(hyperliquidModule, "hyperliquid");
}

/**
 * Station-agnostic glow pulse for stations without a frozen animation api.
 * Tweens the registered root's alpha; cleanup is registered with the world.
 */
function glowPulse(ctx: DioramaContext, id: StationId, dip = 0.5, seconds = 0.9): void {
  const station = getStation(id);
  if (!station) {
    warnOnce(`station not registered: ${id}`);
    return;
  }
  const tween = gsap.to(station.root, {
    alpha: dip,
    duration: seconds / 2,
    yoyo: true,
    repeat: 1,
    ease: "sine.inOut",
  });
  ctx.onCleanup(() => tween.kill());
}

/** Walk, or snap into place under reduced motion. */
async function move(deps: StoryDeps, agentId: string, points: { x: number; y: number }[]): Promise<void> {
  const agent = deps.cast.get(agentId);
  if (!agent) {
    warnOnce(`agent missing from cast: ${agentId}`);
    return;
  }
  if (points.length === 0) return;
  await deps.agents.walk(agent, points, deps.ctx.reducedMotion ? { speed: 100000 } : undefined);
}

/** Dispatch a packet and wait for arrival. */
async function send(
  deps: StoryDeps,
  route: RouteId,
  kind?: PacketKind,
  opts?: { reverse?: boolean; label?: string },
): Promise<void> {
  const handle = deps.rails.dispatch(route, kind, opts);
  await handle.done;
}

function express(deps: StoryDeps, agentId: string, expr: Expression): void {
  deps.cast.get(agentId)?.setExpression(expr);
}

function react(deps: StoryDeps, agentId: string, kind: "hop" | "droop" | "lean" | "tilt"): void {
  deps.cast.get(agentId)?.react(kind);
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
type Supervisor = SupervisorApi;

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

const probeWalk: { x: number; y: number }[] = [
  { x: 430, y: 240 },
  { x: 560, y: 250 },
  { x: 680, y: 235 },
  { x: 850, y: 245 },
];

const corridorWalk: { x: number; y: number }[] = [
  { x: 2110, y: 1105 },
  { x: 2140, y: 1088 },
  { x: 2210, y: 1135 },
];

const gardenWalk: { x: number; y: number }[] = [
  { x: 300, y: 560 },
  { x: 360, y: 575 },
  { x: 330, y: 548 },
];

/**
 * The full trade lifecycle chain: research through reconciliation, played in
 * order with short gaps so a viewer can follow one decision end to end.
 */
export const LIFECYCLE_CHAIN: string[] = [
  "s-research-fetch",
  "s-research-to-strategy",
  "s-mission-update",
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

export const STORIES: Story[] = [
  // 1. Research: a probe extracts live data from the landscape.
  s("s-research-fetch", "Probe extracts market data", 8, ["probe-1", "analysis-1"], ["marketLandscape", "marketData", "strategyLab"],
    async (d) => {
      await move(d, "probe-1", probeWalk);
      react(d, "probe-1", "hop");
      await send(d, "landscapeToMarketData");
      glowPulse(d.ctx, "marketData");
      await d.beat(400);
      await send(d, "marketDataToStrategy");
      express(d, "analysis-1", "curious");
      react(d, "analysis-1", "hop");
    }),

  // 2. Research: analysis is carried to the strategy lab.
  s("s-research-to-strategy", "Analysis carried to strategy", 8, ["research-1", "strategy-1"], ["researchTools", "strategyLab"],
    async (d) => {
      const research = d.cast.get("research-1");
      research?.carry(ROLE_COLORS.research);
      express(d, "research-1", "focused");
      await move(d, "research-1", [near("strategyLab", -60, 30)]);
      research?.carry(null); // card handed over
      express(d, "strategy-1", "focused");
      react(d, "strategy-1", "lean");
      glowPulse(d.ctx, "strategyLab");
    }),

  // 3. Strategy updates the mission; the signal tower hears it.
  s("s-mission-update", "Mission phase update", 8, ["strategy-1"], ["missionBoard", "signalTower"],
    async (d) => {
      await move(d, "strategy-1", [near("missionBoard", 60, 20)]);
      const board = storyApi<MissionBoardApi>("missionBoard");
      board?.setPhase("Scanning");
      d.simulation.setPhase("Scanning");
      await d.beat(300);
      await send(d, "missionToSignalTower");
      storyApi<SignalTower>("signalTower")?.pulse("market");
    }),

  // 4. Proposals appear at the decision table.
  s("s-proposals-appear", "Proposals compared", 7, ["strategy-2"], ["decisionTable"],
    async (d) => {
      await move(d, "strategy-2", [near("decisionTable", -40, 25)]);
      storyApi<DecisionTableApi>("decisionTable")?.showProposals(3, 1);
      express(d, "strategy-2", "focused");
      react(d, "strategy-2", "lean");
    }),

  // 5. A proposal is rejected at the table and returns west.
  // CONTRACT: showProposals(count, -1) = reject beat (all retract, one dimmed red).
  s("s-proposal-rejected", "Proposal rejected", 7, ["strategy-2"], ["decisionTable", "approval"],
    async (d) => {
      storyApi<DecisionTableApi>("decisionTable")?.showProposals(3, -1);
      express(d, "strategy-2", "frustrated");
      react(d, "strategy-2", "droop");
      await d.beat(400);
      await send(d, "deniedReturn");
      glowPulse(d.ctx, "refusalDisplay", 0.35, 1.1);
    }),

  // 6. The surviving proposal needs human approval at the west gate.
  s("s-proposal-needs-human", "Approval requested", 9, ["approval-clerk"], ["decisionTable", "approval"],
    async (d) => {
      await send(d, "decisionToApproval");
      storyApi<Approval>("approval")?.setSeal("waiting");
      express(d, "approval-clerk", "curious");
      react(d, "approval-clerk", "tilt");
      // Perimeter has no "waiting shimmer" in its frozen api; glow the desk.
      glowPulse(d.ctx, "approval", 0.45, 1.4);
    }),

  // 7. The human supervisor approves; the perimeter opens.
  s("s-human-approval", "Human approval granted", 9, ["approval-clerk"], ["approval", "supervisor", "activityGallery"],
    async (d) => {
      glowPulse(d.ctx, "supervisor", 0.4, 1.2);
      await d.beat(300);
      storyApi<Approval>("approval")?.setSeal("approved");
      perimeter()?.grantPulse("west");
      await send(d, "approvalToPermission");
      // Plaque pulse for the user-activity wall (no frozen api).
      glowPulse(d.ctx, "activityGallery", 0.45, 1.0);
      express(d, "approval-clerk", "satisfied");
      react(d, "approval-clerk", "hop");
    }),

  // 8. Permission tokens verify the agent may act.
  s("s-permission-verify", "Permissions verified", 8, ["permission-keeper"], ["permission", "budgetMeter"],
    async (d) => {
      express(d, "permission-keeper", "focused");
      glowPulse(d.ctx, "permission");
      // Command round trip: permission asks budget, budget answers.
      await send(d, "permissionToBudget");
      await send(d, "permissionToBudget", "event", { reverse: true });
      react(d, "permission-keeper", "lean");
    }),

  // 9. Budget reservoirs are consumed transparently.
  s("s-budget-consume", "Budget consumed", 6, [], ["budgetMeter"],
    async (d) => {
      const budget = storyApi<BudgetMeter>("budgetMeter");
      budget?.consume("loss", 0.04);
      d.simulation.consumeLoss(4);
      await d.beat(300);
      budget?.consume("tools", 0.03);
      d.simulation.consumeTools(0.03);
      glowPulse(d.ctx, "budgetMeter", 0.45, 0.8);
    }),

  // 10. The risk fortress scans the proposal.
  s("s-risk-pass", "Risk arches pass", 9, ["risk-scanner"], ["riskFortress"],
    async (d) => {
      await send(d, "permissionToRisk");
      storyApi<RiskFortress>("riskFortress")?.runScan(true);
      express(d, "risk-scanner", "focused");
      await move(d, "risk-scanner", corridorWalk);
    }),

  // 11. Protection wraps the position token before any signing.
  s("s-protection-attach", "Protection attached", 8, [], ["riskFortress", "protection", "signerVault"],
    async (d) => {
      await send(d, "riskToProtection");
      storyApi<Protection>("protection")?.shieldUp();
      await d.beat(400);
      // The shielded token continues toward the signer.
      await send(d, "protectionToSigner");
    }),

  // 12. The signer vault pulses; the key itself never leaves.
  s("s-signer-pulse", "Order signed in vault", 7, ["vault-keeper"], ["signerVault"],
    async (d) => {
      storyApi<SignerVault>("signerVault")?.signPulse();
      express(d, "vault-keeper", "focused");
      react(d, "vault-keeper", "lean");
      await d.beat(400);
      await send(d, "signerToExecution");
    }),

  // 13. The execution gateway ships the order capsule to the exchange.
  s("s-execute-order", "Order sent to exchange", 9, ["gateway-op"], ["executionGateway"],
    async (d) => {
      const gateway = storyApi<ExecutionGateway>("executionGateway");
      gateway?.setState("preparing");
      express(d, "gateway-op", "focused");
      await d.beat(300);
      gateway?.setState("submitted");
      await send(d, "exchangeTunnel");
      hyperliquid()?.exchangeEvent("order");
    }),

  // 14. The exchange acknowledges; the tower signals execution.
  s("s-exchange-ack", "Exchange acknowledgment", 7, [], ["executionGateway", "signalTower"],
    async (d) => {
      await send(d, "exchangeTunnel", "event", { reverse: true });
      storyApi<ExecutionGateway>("executionGateway")?.setState("acknowledged");
      hyperliquid()?.exchangeEvent("ack");
      storyApi<SignalTower>("signalTower")?.pulse("execution");
    }),

  // 15. The fill returns and the portfolio vault updates.
  s("s-fill-vault", "Fill updates portfolio", 8, [], ["portfolioVault"],
    async (d) => {
      hyperliquid()?.exchangeEvent("fill");
      await send(d, "exchangeStateReturn");
      // No frozen PortfolioVault api; station-agnostic pulse.
      glowPulse(d.ctx, "portfolioVault", 0.4, 1.2);
    }),

  // 16. A receipt prints and rolls into the archive.
  s("s-receipt-print", "Receipt printed", 8, ["receipt-clerk"], ["receiptPrinter", "auditArchive"],
    async (d) => {
      await send(d, "executionToReceipts");
      storyApi<ReceiptPrinter>("receiptPrinter")?.print("order");
      express(d, "receipt-clerk", "neutral");
      await d.beat(600);
      await send(d, "receiptsToArchive");
    }),

  // 17. Reconciliation compares local and exchange state.
  s("s-reconcile", "Reconciliation aligned", 8, ["recon-1"], ["reconciliationDock"],
    async (d) => {
      await move(d, "recon-1", [near("reconciliationDock", 30, -20)]);
      await send(d, "localStateStream");
      storyApi<Reconciliation>("reconciliationDock")?.compare(true);
      express(d, "recon-1", "satisfied");
      react(d, "recon-1", "hop");
    }),

  // 18. History is archived; occasionally replayed.
  s("s-audit-store", "Audit and replay", 8, ["archivist"], ["auditArchive", "replayChamber"],
    async (d) => {
      express(d, "archivist", "focused");
      // Drawer cycle has no frozen api; station-agnostic glow.
      glowPulse(d.ctx, "auditArchive", 0.45, 1.2);
      if (d.rng() < 0.5) {
        await d.beat(500);
        storyApi<ReplayChamber>("replayChamber")?.playReceipt();
      }
    }),

  // 19. MCP ports degrade; the health console follows shared state.
  s("s-mcp-degraded", "Tool port degradation", 9, ["health-watcher"], ["mcpHub", "mcpHealth"],
    async (d) => {
      const hub = storyApi<McpHub>("mcpHub");
      hub?.setPortHealth(3, "amber");
      d.simulation.setPortHealth(3, "amber");
      await d.beat(500);
      hub?.setPortHealth(5, "red");
      d.simulation.setPortHealth(5, "red");
      express(d, "health-watcher", "worried");
      react(d, "health-watcher", "tilt");
    }),

  // 20. A call on a dead port is refused, shown, then recovers.
  s("s-tool-refusal", "Tool call refused", 12, ["hub-keeper"], ["mcpHub", "refusalDisplay", "adapterBay"],
    async (d) => {
      await move(d, "hub-keeper", [near("mcpHub", -30, 20)]);
      storyApi<McpHub>("mcpHub")?.portCall(5); // attempted on the red port
      express(d, "hub-keeper", "confused");
      react(d, "hub-keeper", "droop");
      await d.beat(300);
      // Refusal card travels back from the hub toward the adapter bay.
      await send(d, "hubToAdapterBay", "refusal", { reverse: true });
      d.simulation.refuse("UNAVAILABLE TOOL");
      glowPulse(d.ctx, "refusalDisplay", 0.35, 1.2);
      await d.wait(6000); // content timing: the outage lasts a beat
      if (d.cancelled()) return;
      storyApi<McpHub>("mcpHub")?.setPortHealth(5, "green");
      d.simulation.setPortHealth(5, "green");
      express(d, "hub-keeper", "satisfied");
    }),

  // 21. Recovery repairs a drifted flow, then reconciliation aligns.
  s("s-recovery-retry", "Recovery and retry", 10, ["recovery-1"], ["recoveryWorkshop", "reconciliationDock"],
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
    }),

  // 22. An alert wakes the floor.
  s("s-alert-wake", "Alert wake", 7, ["floor-monitor"], ["signalTower", "missionBoard"],
    async (d) => {
      storyApi<SignalTower>("signalTower")?.pulse("alert");
      await send(d, "missionToSignalTower");
      express(d, "floor-monitor", "alarmed");
      react(d, "floor-monitor", "hop");
    }),

  // 23. Sandbox: everything stays inside the research district.
  // NOTE: this story deliberately crosses NO perimeter gate; sandbox traffic
  // loops marketData -> strategy -> missionBoard inside research only.
  s("s-sandbox-test", "Sandbox simulation", 9, ["sandbox-1"], ["sandbox", "marketData", "strategyLab", "missionBoard"],
    async (d) => {
      express(d, "sandbox-1", "excited");
      await move(d, "sandbox-1", gardenWalk);
      react(d, "sandbox-1", "hop");
      await send(d, "marketDataToStrategy");
      await send(d, "strategyToMissionBoard");
      glowPulse(d.ctx, "sandbox", 0.45, 1.0);
    }),

  // 24. Emergency pause demo from the supervisor deck.
  s("s-emergency-demo", "Emergency pause demo", 11, ["floor-monitor", "floor-exec"], ["supervisor", "emergencyPanel", "tradingFloor", "signalTower"],
    async (d) => {
      const floor = getStation("tradingFloor");
      storyApi<Supervisor>("supervisor")?.setCampusPaused(true);
      d.simulation.setPaused(true);
      storyApi<SignalTower>("signalTower")?.pulse("warning");
      if (floor) {
        // Station-agnostic: dim the floor's children, restore on resume.
        for (const child of floor.root.children) {
          gsap.to(child, { alpha: 0.75, duration: 0.5 });
        }
      }
      await d.wait(3000);
      storyApi<Supervisor>("supervisor")?.setCampusPaused(false);
      d.simulation.setPaused(false);
      if (floor) {
        for (const child of floor.root.children) {
          gsap.to(child, { alpha: 1, duration: 0.5 });
        }
      }
      express(d, "floor-monitor", "satisfied");
      express(d, "floor-exec", "satisfied");
      react(d, "floor-exec", "hop");
    }),
];

export const STORY_MAP: Map<string, Story> = new Map(STORIES.map((story) => [story.id, story]));
